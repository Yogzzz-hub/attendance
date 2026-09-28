#!/usr/bin/env python3
"""
Standalone Desktop Attendance & Software Usage Agent for Windows
=================================================================
Supports zero-effort pre-configured standalone deployment on employee laptops:
  1. Pre-Configured Local JSON (agent_config.json):
     - Checks for agent_config.json in the same directory as the executable/script.
     - Reads pre-populated fields: `employee_id` and `hostname`.
     - Skips all login prompts and terminal inputs entirely when configured.
     - Runs silently in the background (default or when compiled with --noconsole).
     - Logs operations and metrics to `agent.log`.
     - If agent_config.json is missing, logs a clear error and exits/falls back gracefully
       without blocking background operations.
  2. Standalone Executable Ready:
     - Automatically resolves base directory whether running via Python or compiled via
       PyInstaller (`pyinstaller --onefile --noconsole wfh_agent.py`).
     - Safe logging when stdout/stderr are detached in GUI/noconsole mode.

Requirements:
  pip install requests pywinctl
"""

import os
import sys
import json
import time
import socket
import datetime
import threading
import argparse
import ctypes
import signal
import requests

try:
    import pywinctl
except ImportError:
    pywinctl = None


# ─── Base Directory & File Paths (PyInstaller Compatible) ────────────────────

def get_base_dir() -> str:
    """
    Returns the directory of the running binary or script.
    Crucial for PyInstaller --onefile: sys.executable points to the .exe directory,
    while __file__ points to a temporary extracted folder (_MEIxxxx).
    """
    if getattr(sys, "frozen", False):
        return os.path.dirname(sys.executable)
    return os.path.dirname(os.path.abspath(__file__))


BASE_DIR = get_base_dir()
CONFIG_FILE = os.path.join(BASE_DIR, "agent_config.json")
ENV_FILE = os.path.join(BASE_DIR, ".env")
LOG_FILE = os.path.join(BASE_DIR, "agent.log")


# ─── Safe Logger (Handles --noconsole Windows detachment) ─────────────────────

def log(message: str, level: str = "INFO"):
    """Thread-safe logging to agent.log and console (if attached)."""
    timestamp = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    formatted = f"[{timestamp}] [{level}] {message}\n"

    # Write to agent.log
    try:
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(formatted)
    except Exception:
        pass

    # Write to stdout if available (will be None in --noconsole mode)
    try:
        if sys.stdout is not None:
            sys.stdout.write(formatted)
            sys.stdout.flush()
    except Exception:
        pass


# ─── Configuration Loader ────────────────────────────────────────────────────

def load_env(path: str = ENV_FILE) -> dict:
    """Loads KEY=VALUE from .env file into a dict."""
    env = {}
    if not os.path.isfile(path):
        return env
    try:
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, value = line.split("=", 1)
                env[key.strip()] = value.strip().strip('"').strip("'")
    except Exception as e:
        log(f"Failed to read .env file: {e}", "WARN")
    return env


def load_agent_config(path: str = CONFIG_FILE) -> dict:
    """Loads pre-configured employee configuration."""
    if not os.path.isfile(path):
        return {}
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:
        log(f"Error reading configuration from {path}: {e}", "ERROR")
        return {}


def save_agent_config(config: dict, path: str = CONFIG_FILE) -> bool:
    """Saves updated employee credentials / tokens."""
    try:
        config["updated_at"] = datetime.datetime.now().isoformat()
        with open(path, "w", encoding="utf-8") as f:
            json.dump(config, f, indent=2)
        return True
    except Exception as e:
        log(f"Error saving {path}: {e}", "ERROR")
        return False


def clear_agent_config(path: str = CONFIG_FILE):
    """Deletes config file."""
    if os.path.isfile(path):
        try:
            os.remove(path)
            log(f"Removed configuration file: {path}", "INFO")
        except Exception as e:
            log(f"Failed to remove {path}: {e}", "WARN")


# ─── Windows Idle Detection ──────────────────────────────────────────────────

class LASTINPUTINFO(ctypes.Structure):
    _fields_ = [("cbSize", ctypes.c_uint), ("dwTime", ctypes.c_uint)]


def get_idle_seconds() -> float:
    """Returns seconds since the last user input event on Windows."""
    try:
        lii = LASTINPUTINFO()
        lii.cbSize = ctypes.sizeof(LASTINPUTINFO)
        if not ctypes.windll.user32.GetLastInputInfo(ctypes.byref(lii)):
            return 0.0
        millis = ctypes.windll.kernel32.GetTickCount() - lii.dwTime
        return max(0.0, millis / 1000.0)
    except Exception:
        return 0.0


# ─── Software & Tool Categorization ──────────────────────────────────────────

def extract_software_info(window_title: str) -> tuple[str, str]:
    """Extract clean software/tool name and category from window title."""
    title_lower = (window_title or "").lower().strip()
    if not title_lower or title_lower in ["desktop", "program manager", "task switching", "start"]:
        return "General Desktop", "general"

    # 1. Development & IDEs
    if any(k in title_lower for k in [
        "visual studio code", "vscode", "cursor", "pycharm", "intellij", "webstorm",
        "sublime text", "vim", "neovim", "eclipse", "android studio", "xcode", "clion"
    ]):
        return "VS Code / IDE", "development"
    elif any(k in title_lower for k in [
        "terminal", "powershell", "cmd.exe", "bash", "zsh", "git bash", "windows terminal",
        "command prompt", "iterm"
    ]):
        return "Terminal", "development"
    elif any(k in title_lower for k in [
        "github", "gitlab", "bitbucket", "postman", "insomnia", "dbeaver", "datagrip", "pgadmin"
    ]):
        return "Developer Tool", "development"

    # 2. Web Browsers
    elif any(k in title_lower for k in [
        "google chrome", "chrome", "firefox", "microsoft edge", "edge", "safari", "brave", "opera", "arc"
    ]):
        return "Web Browser", "browsing"

    # 3. Communication & Collaboration
    elif any(k in title_lower for k in [
        "slack", "microsoft teams", "teams", "discord", "zoom", "skype", "telegram",
        "whatsapp", "outlook", "thunderbird", "gmail"
    ]):
        return "Communication Tool", "communication"

    # 4. Design & Creative Tools
    elif any(k in title_lower for k in [
        "figma", "photoshop", "illustrator", "canva", "adobe xd", "indesign", "premiere", "blender"
    ]):
        return "Design Tool", "design"

    # 5. Productivity & Office
    elif any(k in title_lower for k in [
        "excel", "word", "powerpoint", "notion", "google docs", "google sheets", "google slides",
        "obsidian", "onenote", "trello", "jira", "asana"
    ]):
        return "Productivity Tool", "productivity"

    if " - " in window_title:
        app_name = window_title.split(" - ")[-1].strip()
        if len(app_name) <= 40:
            return app_name, "general"
    return (window_title[:35] or "General Desktop").strip(), "general"


def format_duration_hm(seconds: float) -> str:
    """Format seconds into readable Xh Ym string."""
    total_sec = int(round(seconds))
    if total_sec < 60:
        return f"{total_sec}s"
    minutes = total_sec // 60
    if minutes < 60:
        sec = total_sec % 60
        return f"{minutes}m {sec}s" if sec > 0 else f"{minutes}m"
    hours = minutes // 60
    rem_min = minutes % 60
    return f"{hours}h {rem_min}m"


# ─── Supabase Client ─────────────────────────────────────────────────────────

class SupabaseClient:
    """Wrapper around Supabase Auth + REST/RPC APIs."""

    def __init__(self, url: str, anon_key: str, service_role_key: str = None):
        self.url = url.rstrip("/")
        self.anon_key = anon_key
        self.service_role_key = service_role_key
        self.access_token = service_role_key or None
        self.refresh_token = None
        self.user_id = None
        self.email = None

    def _headers(self) -> dict:
        token = self.access_token or self.service_role_key or self.anon_key
        h = {
            "apikey": self.anon_key,
            "Content-Type": "application/json",
            "Prefer": "return=representation",
        }
        if token:
            h["Authorization"] = f"Bearer {token}"
        return h

    def auth_password(self, email: str, password: str) -> dict:
        """Authenticate using email and password against Supabase Auth."""
        resp = requests.post(
            f"{self.url}/auth/v1/token?grant_type=password",
            headers={"apikey": self.anon_key, "Content-Type": "application/json"},
            json={"email": email, "password": password},
            timeout=15,
        )
        resp.raise_for_status()
        data = resp.json()
        self.access_token = data.get("access_token")
        self.refresh_token = data.get("refresh_token")
        self.user_id = data.get("user", {}).get("id")
        self.email = email
        return data

    def refresh_auth(self, refresh_token: str) -> dict:
        """Refresh an expired access token using refresh_token."""
        resp = requests.post(
            f"{self.url}/auth/v1/token?grant_type=refresh_token",
            headers={"apikey": self.anon_key, "Content-Type": "application/json"},
            json={"refresh_token": refresh_token},
            timeout=15,
        )
        resp.raise_for_status()
        data = resp.json()
        self.access_token = data.get("access_token")
        self.refresh_token = data.get("refresh_token") or refresh_token
        self.user_id = data.get("user", {}).get("id") or self.user_id
        return data

    def verify_token(self) -> bool:
        """Verify if the current token is valid."""
        if not self.access_token:
            return False
        try:
            resp = requests.get(
                f"{self.url}/auth/v1/user",
                headers=self._headers(),
                timeout=10,
            )
            return resp.status_code == 200
        except Exception:
            return False

    def get_employee_profile(self, user_id: str) -> dict:
        """Fetch employee profile details."""
        try:
            records = self.get("employees", f"id=eq.{user_id}&select=*&limit=1")
            if records and isinstance(records, list):
                return records[0]
        except Exception as e:
            log(f"Notice: Failed to fetch employee profile: {e}", "WARN")
        return {}

    def rpc(self, name: str, payload: dict):
        """Call a Postgres RPC SECURITY DEFINER function."""
        resp = requests.post(
            f"{self.url}/rest/v1/rpc/{name}",
            headers=self._headers(),
            json=payload,
            timeout=15,
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
            timeout=15,
        )
        resp.raise_for_status()
        return resp.json() or []

    def post(self, table: str, payload: dict) -> list:
        resp = requests.post(
            f"{self.url}/rest/v1/{table}",
            headers=self._headers(),
            json=payload,
            timeout=15,
        )
        resp.raise_for_status()
        return resp.json() or []

    def patch(self, table: str, params: str, payload: dict) -> list:
        resp = requests.patch(
            f"{self.url}/rest/v1/{table}?{params}",
            headers=self._headers(),
            json=payload,
            timeout=15,
        )
        resp.raise_for_status()
        return resp.json() or []


# ─── Standalone Silent Background Worker ─────────────────────────────────────

class StandaloneWorker:
    """Runs high-precision background attendance tracking without any GUI or prompts."""

    def __init__(self, supabase: SupabaseClient, employee_id: str, hostname: str, work_mode: str = "wfh"):
        self.supabase = supabase
        self.employee_id = employee_id
        self.hostname = hostname
        self.work_mode = work_mode
        self.attendance_record_id = None
        self.running = False
        self._lock = threading.Lock()

        # Software Accumulators
        self.interval_software_accumulator = {}
        self.interval_active_seconds = 0.0
        self.interval_break_seconds = 0.0
        self.session_active_seconds = 0.0
        self.session_break_seconds = 0.0

    def start(self):
        """Initializes today's session and enters the main tracking loop."""
        self.running = True
        log(f"Starting standalone tracking for employee_id={self.employee_id}, hostname={self.hostname}", "INFO")

        # 1. Acquire attendance session for today
        today_iso = datetime.date.today().isoformat()
        try:
            active_records = self.supabase.get(
                "attendance_records",
                f"user_id=eq.{self.employee_id}&date=eq.{today_iso}&logout_time=is.null&order=created_at.desc&limit=1"
            )
            if active_records:
                record = active_records[0]
                self.attendance_record_id = record.get("id")
                self.work_mode = record.get("work_mode", self.work_mode)
                log(f"Attached to existing attendance session: {self.attendance_record_id} ({self.work_mode.upper()})", "INFO")
            else:
                record = self.supabase.rpc("clock_in", {
                    "p_user_id": self.employee_id,
                    "p_date": today_iso,
                    "p_work_mode": self.work_mode,
                })
                if isinstance(record, list) and record:
                    record = record[0]
                self.attendance_record_id = record.get("id") if isinstance(record, dict) else None
                log(f"Clocked in new session: {self.attendance_record_id} ({self.work_mode.upper()})", "INFO")
        except Exception as e:
            log(f"Failed to start/retrieve attendance session: {e}", "ERROR")
            return

        if not self.attendance_record_id:
            log("No valid attendance session could be established. Exiting worker.", "ERROR")
            return

        # 2. Main Tracking Loop
        last_tick = time.monotonic()
        interval_start = time.monotonic()

        log("Standalone background monitoring loop active.", "INFO")

        while self.running:
            try:
                time.sleep(2.0)
                now = time.monotonic()
                dt = max(0.0, now - last_tick)
                last_tick = now

                # Capture active window
                raw_title = ""
                if pywinctl:
                    try:
                        raw_title = (pywinctl.getActiveWindowTitle() or "").strip()
                    except Exception:
                        raw_title = ""

                app_name, category = extract_software_info(raw_title)
                clean_title = raw_title[:100] if raw_title else app_name

                # Check idle
                idle = get_idle_seconds()
                with self._lock:
                    if idle > 30.0:
                        self.interval_break_seconds += dt
                        self.session_break_seconds += dt
                    else:
                        self.interval_active_seconds += dt
                        self.session_active_seconds += dt
                        key = (app_name, clean_title, category)
                        self.interval_software_accumulator[key] = (
                            self.interval_software_accumulator.get(key, 0.0) + dt
                        )

                # Dispatch every 60s
                if (now - interval_start) >= 60.0:
                    self.dispatch_metrics()
                    interval_start = time.monotonic()

            except Exception as loop_err:
                log(f"Unexpected error in tracking loop: {loop_err}", "ERROR")

        # Flush on shutdown
        self.dispatch_metrics(flush_all=True)
        log("Standalone monitoring stopped. Final metrics flushed.", "INFO")

    def dispatch_metrics(self, flush_all: bool = False):
        """Sends batched metrics via log_software_usage and log_wfh_heartbeat."""
        with self._lock:
            if not self.attendance_record_id:
                return

            active_sec = self.interval_active_seconds
            break_sec = self.interval_break_seconds
            batch = dict(self.interval_software_accumulator)

            total = active_sec + break_sec
            if total <= 0 and not flush_all:
                return

            score = (active_sec / total * 100.0) if total > 0 else 100.0
            dominant_app = max(batch.items(), key=lambda x: x[1])[0][0] if batch else "General Desktop"

            self.interval_active_seconds = 0.0
            self.interval_break_seconds = 0.0
            self.interval_software_accumulator.clear()

        # Send RPCs
        try:
            # WFH Heartbeat
            if self.work_mode == "wfh" and (active_sec > 0 or break_sec > 0):
                try:
                    self.supabase.rpc("log_wfh_heartbeat", {
                        "p_attendance_id": self.attendance_record_id,
                        "p_active_seconds": int(round(active_sec)),
                        "p_break_seconds": int(round(break_sec)),
                        "p_active_app": dominant_app,
                        "p_activity_score": round(score, 2),
                    })
                    log(f"Dispatched heartbeat: active={int(round(active_sec))}s, dominant={dominant_app}", "DEBUG")
                except Exception as hb_err:
                    log(f"Heartbeat dispatch notice: {hb_err}", "WARN")

            # Software Usage
            for (app_name, win_title, category), duration in batch.items():
                dur_int = int(round(duration))
                if dur_int > 0:
                    try:
                        self.supabase.rpc("log_software_usage", {
                            "p_attendance_id": self.attendance_record_id,
                            "p_software_name": app_name,
                            "p_window_title": win_title,
                            "p_category": category,
                            "p_duration_seconds": dur_int,
                            "p_activity_score": round(score, 2),
                        })
                        log(f"Logged software: {app_name} ({category}) -> {dur_int}s", "DEBUG")
                    except Exception as sw_err:
                        log(f"Software usage dispatch notice: {sw_err}", "WARN")

        except Exception as e:
            log(f"Dispatch error: {e}", "ERROR")

    def stop(self):
        self.running = False


# ─── Tkinter GUI Application (Optional / Interactive Mode) ───────────────────

class WFHApp:
    """Optional GUI dashboard for interactive viewing / setup."""

    def __init__(self, root, supabase: SupabaseClient, config: dict):
        import tkinter as tk
        from tkinter import ttk, messagebox

        self.root = root
        self.root.title("Attendance & Productivity Agent")
        self.root.geometry("540x680")
        self.root.minsize(500, 620)
        self.supabase = supabase
        self.config = config

        self.worker = None
        self.worker_thread = None

        # Build UI
        self._build_ui()
        self.root.protocol("WM_DELETE_WINDOW", self.on_close)

    def _build_ui(self):
        import tkinter as tk
        from tkinter import ttk

        self.frame = ttk.Frame(self.root, padding="20")
        self.frame.pack(fill=tk.BOTH, expand=True)

        emp_id = self.config.get("employee_id") or self.config.get("user_id", "Unknown")
        host = self.config.get("hostname", socket.gethostname())

        ttk.Label(self.frame, text="Attendance Agent (Pre-Configured)", font=("Segoe UI", 16, "bold")).pack(pady=(0, 10))
        ttk.Label(self.frame, text=f"Employee ID: {emp_id}", font=("Segoe UI", 10)).pack(anchor=tk.W)
        ttk.Label(self.frame, text=f"Hostname: {host}", font=("Segoe UI", 10)).pack(anchor=tk.W)
        ttk.Label(self.frame, text="Status: Running in background", font=("Segoe UI", 10, "italic"), foreground="green").pack(pady=10)

        btn_frame = ttk.Frame(self.frame)
        btn_frame.pack(pady=20)
        ttk.Button(btn_frame, text="Close Window (Keeps Running)", command=self.root.destroy).pack(side=tk.LEFT, padx=5)

    def on_close(self):
        self.root.destroy()


# ─── Main Entry Point ────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Standalone Attendance & Software Usage Agent")
    parser.add_argument("--gui", action="store_true", help="Launch interactive graphical interface")
    parser.add_argument("--silent", action="store_true", help="Force silent background execution")
    args = parser.parse_args()

    log("=" * 60, "INFO")
    log("Attendance & Software Usage Agent launching...", "INFO")
    log(f"Working Directory: {BASE_DIR}", "INFO")

    # 1. Load configuration from agent_config.json in BASE_DIR
    config = load_agent_config(CONFIG_FILE)
    employee_id = config.get("employee_id") or config.get("user_id")
    hostname = config.get("hostname") or socket.gethostname()

    # 2. Check if configuration is missing or invalid
    if not employee_id:
        error_msg = (
            f"Pre-configured file '{CONFIG_FILE}' not found or missing required 'employee_id' field.\n"
            f"Please ensure 'agent_config.json' is present in '{BASE_DIR}' with:\n"
            f'{{\n  "employee_id": "<user_uuid>",\n  "hostname": "<computer_name>"\n}}'
        )
        log(error_msg, "ERROR")

        # If interactive TTY, inform the user; otherwise exit gracefully without blocking background tasks
        if sys.stdout is not None and sys.stdin.isatty():
            print(f"\n[ERROR] {error_msg}\n")
        sys.exit(1)

    log(f"Configuration loaded: employee_id={employee_id}, hostname={hostname}", "INFO")

    # 3. Resolve Supabase credentials (from agent_config.json or .env)
    env = load_env(ENV_FILE)
    supabase_url = config.get("supabase_url") or env.get("VITE_SUPABASE_URL", "")
    supabase_anon_key = config.get("supabase_anon_key") or env.get("VITE_SUPABASE_ANON_KEY", "")
    supabase_service_role = config.get("supabase_service_role_key") or env.get("SUPABASE_SERVICE_ROLE_KEY", "")

    if not supabase_url or not supabase_anon_key:
        log("Missing supabase_url or supabase_anon_key in agent_config.json / .env", "ERROR")
        sys.exit(1)

    supabase = SupabaseClient(supabase_url, supabase_anon_key, supabase_service_role)
    supabase.user_id = employee_id

    # If tokens or credentials cached, apply them
    if config.get("access_token"):
        supabase.access_token = config.get("access_token")
    if config.get("refresh_token"):
        supabase.refresh_token = config.get("refresh_token")

    work_mode = config.get("work_mode", "wfh")
    run_silent = config.get("silent", True) and not args.gui

    # 4. Standalone Execution Mode
    worker = StandaloneWorker(supabase, employee_id, hostname, work_mode)

    # Setup termination signal handlers
    def handle_signal(signum, frame):
        log(f"Received termination signal ({signum}). Shutting down worker...", "INFO")
        worker.stop()

    signal.signal(signal.SIGINT, handle_signal)
    signal.signal(signal.SIGTERM, handle_signal)

    if run_silent or args.silent:
        log("Running in silent standalone background mode. Zero prompts, zero blocking UI.", "INFO")
        worker.start()
    else:
        # Optional GUI mode if explicitly requested
        try:
            import tkinter as tk
            worker_thread = threading.Thread(target=worker.start, daemon=True)
            worker_thread.start()

            root = tk.Tk()
            app = WFHApp(root, supabase, config)
            root.mainloop()
            worker.stop()
        except Exception as gui_err:
            log(f"GUI could not be initialized ({gui_err}). Running in silent background mode.", "WARN")
            worker.start()


if __name__ == "__main__":
    main()
