#!/usr/bin/env python3
"""
WFH Agent for Windows
=====================
Standalone desktop client that:
  1. Authenticates against Supabase Auth using email + password.
  2. Calls the clock_in RPC in WFH mode and stores the attendance_record_id.
  3. Monitors the active window title (pywinctl) and Windows idle time (ctypes).
  4. Every 60 seconds, calls the log_wfh_heartbeat RPC with accumulated
     active/break seconds, active app name, and an activity percentage.
  5. Exposes a minimal Tkinter GUI with a 7-hour progress timer,
     Take Break / Resume, and Clock Out.

Requirements:
  pip install requests pywinctl

Configuration:
  Reads VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY from .env
  in the same directory as this script.
"""

import os
import sys
import json
import time
import datetime
import threading
import tkinter as tk
from tkinter import ttk, messagebox
import ctypes
import requests

try:
    import pywinctl
except ImportError:
    print("ERROR: pywinctl is not installed.")
    print("Install it with: pip install pywinctl")
    sys.exit(1)


# ─── Windows Idle Detection ──────────────────────────────────────────────────

class LASTINPUTINFO(ctypes.Structure):
    _fields_ = [("cbSize", ctypes.c_uint), ("dwTime", ctypes.c_uint)]


def get_idle_seconds() -> float:
    """Returns seconds since the last user input event on Windows."""
    lii = LASTINPUTINFO()
    lii.cbSize = ctypes.sizeof(LASTINPUTINFO)
    if not ctypes.windll.user32.GetLastInputInfo(ctypes.byref(lii)):
        return 0.0
    millis = ctypes.windll.kernel32.GetTickCount() - lii.dwTime
    return millis / 1000.0


# ─── Configuration Loader ────────────────────────────────────────────────────

def load_env(path: str) -> dict:
    """Loads a simple KEY=VALUE .env file into a dict."""
    env = {}
    if not os.path.isfile(path):
        return env
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            env[key.strip()] = value.strip().strip('"').strip("'")
    return env


# ─── Supabase REST Client ────────────────────────────────────────────────────

class SupabaseClient:
    """Thin wrapper around Supabase REST API for Auth + RPCs."""

    def __init__(self, url: str, anon_key: str):
        self.url = url.rstrip("/")
        self.anon_key = anon_key
        self.access_token = None
        self.user_id = None

    def _headers(self) -> dict:
        h = {
            "apikey": self.anon_key,
            "Content-Type": "application/json",
            "Prefer": "return=representation",
        }
        if self.access_token:
            h["Authorization"] = f"Bearer {self.access_token}"
        return h

    def auth(self, email: str, password: str) -> dict:
        """Password grant against /auth/v1/token."""
        resp = requests.post(
            f"{self.url}/auth/v1/token?grant_type=password",
            headers={"apikey": self.anon_key, "Content-Type": "application/json"},
            json={"email": email, "password": password},
        )
        resp.raise_for_status()
        data = resp.json()
        self.access_token = data["access_token"]
        self.user_id = data["user"]["id"]
        return data

    def rpc(self, name: str, payload: dict):
        """Calls a PostgRPC SECURITY DEFINER function."""
        resp = requests.post(
            f"{self.url}/rest/v1/rpc/{name}",
            headers=self._headers(),
            json=payload,
        )
        resp.raise_for_status()
        if not resp.text.strip():
            return {}
        try:
            return resp.json()
        except ValueError:
            return {}

    def get(self, table: str, params: str = "") -> list:
        resp = requests.get(
            f"{self.url}/rest/v1/{table}?{params}",
            headers=self._headers(),
        )
        resp.raise_for_status()
        return resp.json() or []

    def post(self, table: str, payload: dict) -> list:
        resp = requests.post(
            f"{self.url}/rest/v1/{table}",
            headers=self._headers(),
            json=payload,
        )
        resp.raise_for_status()
        return resp.json() or []

    def patch(self, table: str, params: str, payload: dict) -> list:
        resp = requests.patch(
            f"{self.url}/rest/v1/{table}?{params}",
            headers=self._headers(),
            json=payload,
        )
        resp.raise_for_status()
        return resp.json() or []


# ─── GUI Application ─────────────────────────────────────────────────────────

class WFHApp:
    def __init__(self, root: tk.Tk):
        self.root = root
        self.root.title("WFH Agent")
        self.root.geometry("440x520")
        self.root.resizable(False, False)

        # Load Supabase configuration from .env next to this script
        env_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")
        env = load_env(env_path)
        self.supabase = SupabaseClient(
            env.get("VITE_SUPABASE_URL", ""),
            env.get("VITE_SUPABASE_ANON_KEY", ""),
        )

        # Runtime state
        self.attendance_record_id = None
        self.active_break_id = None
        self.is_on_break = False
        self.monitor_running = False

        self.elapsed_seconds = 0
        self.target_seconds = 25200  # 7 hours
        self.wfh_active_seconds = 0
        self.wfh_break_seconds = 0

        self._build_ui()
        self.root.protocol("WM_DELETE_WINDOW", self.on_close)

    # ── UI Construction ──────────────────────────────────────────────────────

    def _build_ui(self):
        # Login Frame
        self.login_frame = ttk.Frame(self.root, padding="20")
        self.login_frame.pack(fill=tk.BOTH, expand=True)

        ttk.Label(
            self.login_frame, text="WFH Agent", font=("Segoe UI", 18, "bold")
        ).pack(pady=(0, 20))

        ttk.Label(self.login_frame, text="Email").pack(anchor=tk.W)
        self.email_var = tk.StringVar()
        ttk.Entry(self.login_frame, textvariable=self.email_var, width=45).pack(
            pady=(0, 10)
        )

        ttk.Label(self.login_frame, text="Password").pack(anchor=tk.W)
        self.password_var = tk.StringVar()
        ttk.Entry(
            self.login_frame, textvariable=self.password_var, width=45, show="•"
        ).pack(pady=(0, 20))

        ttk.Button(
            self.login_frame, text="Login & Start WFH", command=self.on_login
        ).pack(pady=10)

        # Monitor Frame (hidden until login)
        self.monitor_frame = ttk.Frame(self.root, padding="20")

        ttk.Label(
            self.monitor_frame, text="WFH Active Timer", font=("Segoe UI", 14, "bold")
        ).pack(pady=(0, 10))

        self.timer_var = tk.StringVar(value="00:00:00 / 07:00:00")
        ttk.Label(
            self.monitor_frame, textvariable=self.timer_var, font=("Segoe UI", 20, "bold")
        ).pack(pady=(0, 10))

        self.progress = ttk.Progressbar(self.monitor_frame, length=360, mode="determinate")
        self.progress.pack(pady=(0, 10))

        self.status_var = tk.StringVar(value="Ready")
        ttk.Label(self.monitor_frame, textvariable=self.status_var, foreground="gray").pack(
            pady=(0, 10)
        )

        ttk.Label(self.monitor_frame, text="Active Window:").pack(anchor=tk.W)
        self.window_var = tk.StringVar(value="--")
        entry = ttk.Entry(
            self.monitor_frame, textvariable=self.window_var, width=50, state="readonly"
        )
        entry.pack(pady=(0, 20), fill=tk.X)

        btn_frame = ttk.Frame(self.monitor_frame)
        btn_frame.pack(pady=10)

        self.break_btn = ttk.Button(
            btn_frame, text="Take Break", command=self.on_take_break
        )
        self.break_btn.grid(row=0, column=0, padx=5)

        self.resume_btn = ttk.Button(
            btn_frame, text="Resume", command=self.on_resume, state=tk.DISABLED
        )
        self.resume_btn.grid(row=0, column=1, padx=5)

        self.clockout_btn = ttk.Button(
            btn_frame, text="Clock Out", command=self.on_clock_out
        )
        self.clockout_btn.grid(row=0, column=2, padx=5)

    # ── Actions ──────────────────────────────────────────────────────────────

    def on_login(self):
        email = self.email_var.get().strip()
        password = self.password_var.get().strip()
        if not email or not password:
            messagebox.showerror("Error", "Email and password are required")
            return
        if not self.supabase.url or not self.supabase.anon_key:
            messagebox.showerror("Error", "Supabase URL/Anon Key missing in .env")
            return

        try:
            self.supabase.auth(email, password)
            today_iso = datetime.date.today().isoformat()

            # clock_in RPC with WFH mode
            record = self.supabase.rpc("clock_in", {
                "p_user_id": self.supabase.user_id,
                "p_date": today_iso,
                "p_work_mode": "wfh",
            })

            # Normalize RPC response (could be [record] or {record})
            if isinstance(record, list) and record:
                record = record[0]
            self.attendance_record_id = (
                record.get("id") if isinstance(record, dict) else None
            )

            if not self.attendance_record_id:
                messagebox.showerror("Error", "Failed to start WFH session")
                return

            self.login_frame.pack_forget()
            self.monitor_frame.pack(fill=tk.BOTH, expand=True)
            self.status_var.set("Active — WFH")

            self.monitor_running = True
            threading.Thread(target=self.monitor_loop, daemon=True).start()
            self._tick_timer()

        except Exception as e:
            messagebox.showerror("Login Failed", str(e))

    def monitor_loop(self):
        """Background worker: samples idle/active state and sends heartbeats."""
        while self.monitor_running:
            # Sample every 5 seconds for 60 seconds
            for _ in range(12):
                if not self.monitor_running:
                    break
                if self.is_on_break:
                    self.wfh_break_seconds += 5
                else:
                    idle = get_idle_seconds()
                    if idle > 30:
                        self.wfh_break_seconds += 5
                    else:
                        self.wfh_active_seconds += 5
                time.sleep(5)

            if self.monitor_running and self.attendance_record_id:
                self._send_heartbeat()

    def _send_heartbeat(self):
        try:
            title = pywinctl.getActiveWindowTitle() or "Unknown"
            total = self.wfh_active_seconds + self.wfh_break_seconds
            score = (
                (self.wfh_active_seconds / total * 100) if total > 0 else 100.0
            )

            self.supabase.rpc("log_wfh_heartbeat", {
                "p_attendance_id": self.attendance_record_id,
                "p_active_seconds": self.wfh_active_seconds,
                "p_break_seconds": self.wfh_break_seconds,
                "p_active_app": str(title),
                "p_activity_score": round(score, 2),
            })
            self.wfh_active_seconds = 0
            self.wfh_break_seconds = 0
        except Exception as e:
            print(f"[Heartbeat] {e}")

    def _tick_timer(self):
        """Tkinter-safe 1-second timer tick."""
        if self.monitor_running and not self.is_on_break:
            self.elapsed_seconds += 1

        fmt = lambda s: f"{s // 3600:02d}:{(s % 3600) // 60:02d}:{s % 60:02d}"
        self.timer_var.set(f"{fmt(self.elapsed_seconds)} / {fmt(self.target_seconds)}")
        self.progress["value"] = min(100.0, (self.elapsed_seconds / self.target_seconds) * 100)

        if self.monitor_running:
            self.root.after(1000, self._tick_timer)

    def on_take_break(self):
        if not self.attendance_record_id or self.is_on_break:
            return
        try:
            now = datetime.datetime.now().isoformat()
            results = self.supabase.post("attendance_breaks", {
                "attendance_record_id": self.attendance_record_id,
                "start": now,
            })
            self.active_break_id = results[0]["id"] if results else None
            self.is_on_break = True
            self.break_btn.config(state=tk.DISABLED)
            self.resume_btn.config(state=tk.NORMAL)
            self.status_var.set("On Break")
        except Exception as e:
            messagebox.showerror("Break Error", str(e))

    def on_resume(self):
        if not self.active_break_id or not self.is_on_break:
            return
        try:
            now = datetime.datetime.now().isoformat()
            self.supabase.patch(
                "attendance_breaks",
                f"id=eq.{self.active_break_id}",
                {"end": now},
            )
            self.is_on_break = False
            self.active_break_id = None
            self.break_btn.config(state=tk.NORMAL)
            self.resume_btn.config(state=tk.DISABLED)
            self.status_var.set("Active — WFH")
        except Exception as e:
            messagebox.showerror("Resume Error", str(e))

    def on_clock_out(self):
        if not self.attendance_record_id:
            return
        self.monitor_running = False
        try:
            self.supabase.rpc("clock_out", {
                "p_user_id": self.supabase.user_id,
                "p_date": datetime.date.today().isoformat(),
                "p_early_logout_reason": None,
            })
            self.status_var.set("Clocked Out")
            messagebox.showinfo("Success", "Clocked out successfully")
            self.root.quit()
        except Exception as e:
            messagebox.showerror("Clock Out Failed", str(e))

    def on_close(self):
        """Auto clock-out when the window is closed."""
        if self.monitor_running and self.attendance_record_id:
            self.monitor_running = False
            try:
                self.supabase.rpc("clock_out", {
                    "p_user_id": self.supabase.user_id,
                    "p_date": datetime.date.today().isoformat(),
                    "p_early_logout_reason": "Agent closed",
                })
            except Exception:
                pass
        self.root.destroy()


# ─── Entry Point ─────────────────────────────────────────────────────────────

def main():
    root = tk.Tk()
    app = WFHApp(root)
    root.mainloop()


if __name__ == "__main__":
    main()
