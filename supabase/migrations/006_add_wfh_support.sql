-- ============================================================================
-- Migration: Add WFH (Work From Home) Support
-- Date: 2026-08-05
-- Description: Adds work_mode and activity tracking columns to attendance_records,
--              creates wfh_activity_logs table, and updates RPC functions.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Alter attendance_records table
-- ----------------------------------------------------------------------------
ALTER TABLE attendance_records
  ADD COLUMN IF NOT EXISTS work_mode TEXT NOT NULL DEFAULT 'on_site' 
    CHECK (work_mode IN ('on_site', 'wfh')),
  ADD COLUMN IF NOT EXISTS active_seconds INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS break_seconds INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS activity_score NUMERIC(5,2) NOT NULL DEFAULT 100.0;

-- ----------------------------------------------------------------------------
-- 2. Create wfh_activity_logs table
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS wfh_activity_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  attendance_record_id UUID NOT NULL REFERENCES attendance_records(id) ON DELETE CASCADE,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  active_app TEXT,
  activity_percentage NUMERIC(5,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ----------------------------------------------------------------------------
-- 3. Indexes for wfh_activity_logs
-- ----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_wfh_activity_logs_attendance_id 
  ON wfh_activity_logs(attendance_record_id);

CREATE INDEX IF NOT EXISTS idx_wfh_activity_logs_timestamp 
  ON wfh_activity_logs(timestamp DESC);

-- ----------------------------------------------------------------------------
-- 4. RLS on wfh_activity_logs
-- ----------------------------------------------------------------------------
ALTER TABLE wfh_activity_logs ENABLE ROW LEVEL SECURITY;

-- Employees can insert their own logs (verified via attendance_record ownership)
CREATE POLICY "employees_insert_own_wfh_logs"
  ON wfh_activity_logs
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM attendance_records ar
      JOIN employees e ON e.id = ar.user_id
      WHERE ar.id = wfh_activity_logs.attendance_record_id
      AND e.id = auth.uid()
    )
  );

-- Employees can view their own logs
CREATE POLICY "employees_view_own_wfh_logs"
  ON wfh_activity_logs
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM attendance_records ar
      JOIN employees e ON e.id = ar.user_id
      WHERE ar.id = wfh_activity_logs.attendance_record_id
      AND e.id = auth.uid()
    )
  );

-- Admins can view all WFH logs
CREATE POLICY "admins_view_all_wfh_logs"
  ON wfh_activity_logs
  FOR SELECT
  USING (is_admin());

-- Managers/admins can insert logs on behalf of employees (if needed)
CREATE POLICY "admins_manage_wfh_logs"
  ON wfh_activity_logs
  FOR ALL
  USING (is_admin());

-- ----------------------------------------------------------------------------
-- 5. Drop and recreate clock_in RPC with work_mode parameter
-- ----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS clock_in(UUID, DATE);

CREATE OR REPLACE FUNCTION clock_in(
  p_user_id UUID,
  p_date DATE,
  p_work_mode TEXT DEFAULT 'on_site'
)
RETURNS attendance_records
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  result attendance_records%ROWTYPE;
  v_today DATE := CURRENT_DATE;
BEGIN
  -- Authorization
  IF (SELECT role FROM employees WHERE id = auth.uid()) != 'admin'
     AND auth.uid() != p_user_id THEN
    RAISE EXCEPTION 'Not authorized to clock in for this user';
  END IF;

  -- Validate date is today or yesterday (for late clock-ins)
  IF p_date NOT IN (v_today, v_today - INTERVAL '1 day') THEN
    RAISE EXCEPTION 'Clock-in restricted to current date only';
  END IF;

  -- Validate work_mode
  IF p_work_mode NOT IN ('on_site', 'wfh') THEN
    RAISE EXCEPTION 'Invalid work_mode. Must be "on_site" or "wfh"';
  END IF;

  -- Insert or update attendance record
  INSERT INTO attendance_records (user_id, date, login_time, worked_hours, work_mode, active_seconds, break_seconds, activity_score)
  VALUES (p_user_id, p_date, NOW(), 0, p_work_mode, 0, 0, 100.0)
  ON CONFLICT (user_id, date)
  DO UPDATE SET 
    login_time = EXCLUDED.login_time,
    work_mode = EXCLUDED.work_mode,
    updated_at = NOW()
  RETURNING * INTO result;

  RETURN result;
END;
$$;

GRANT EXECUTE ON FUNCTION clock_in(UUID, DATE, TEXT) TO authenticated;

-- ----------------------------------------------------------------------------
-- 6. Create log_wfh_heartbeat RPC
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION log_wfh_heartbeat(
  p_attendance_id UUID,
  p_active_seconds INT,
  p_break_seconds INT,
  p_active_app TEXT,
  p_activity_score NUMERIC(5,2)
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_user_id UUID;
  v_record attendance_records%ROWTYPE;
BEGIN
  -- Get the attendance record and verify ownership
  SELECT * INTO v_record
  FROM attendance_records
  WHERE id = p_attendance_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Attendance record not found';
  END IF;

  v_user_id := v_record.user_id;

  -- Authorization: only the employee or admin can log heartbeat
  IF (SELECT role FROM employees WHERE id = auth.uid()) != 'admin'
     AND auth.uid() != v_user_id THEN
    RAISE EXCEPTION 'Not authorized to log heartbeat for this user';
  END IF;

  -- Validate work_mode is WFH
  IF v_record.work_mode != 'wfh' THEN
    RAISE EXCEPTION 'Heartbeat logging is only allowed for WFH attendance records';
  END IF;

  -- Validate inputs
  IF p_active_seconds < 0 THEN
    RAISE EXCEPTION 'active_seconds cannot be negative';
  END IF;

  IF p_break_seconds < 0 THEN
    RAISE EXCEPTION 'break_seconds cannot be negative';
  END IF;

  IF p_activity_score < 0 OR p_activity_score > 100 THEN
    RAISE EXCEPTION 'activity_score must be between 0 and 100';
  END IF;

  -- Update attendance_records with cumulative totals
  UPDATE attendance_records
  SET
    active_seconds = active_seconds + p_active_seconds,
    break_seconds = break_seconds + p_break_seconds,
    activity_score = LEAST(100.0, GREATEST(0.0, p_activity_score)),
    updated_at = NOW()
  WHERE id = p_attendance_id;

  -- Insert activity log entry
  INSERT INTO wfh_activity_logs (
    attendance_record_id,
    timestamp,
    active_app,
    activity_percentage
  ) VALUES (
    p_attendance_id,
    NOW(),
    p_active_app,
    p_activity_score
  );
END;
$$;

GRANT EXECUTE ON FUNCTION log_wfh_heartbeat(UUID, INT, INT, TEXT, NUMERIC) TO authenticated;

-- ----------------------------------------------------------------------------
-- 7. Enable Realtime on wfh_activity_logs (optional, for live WFH monitoring)
-- ----------------------------------------------------------------------------
ALTER PUBLICATION supabase_realtime ADD TABLE wfh_activity_logs;

-- ============================================================================
-- END OF MIGRATION
-- ============================================================================
