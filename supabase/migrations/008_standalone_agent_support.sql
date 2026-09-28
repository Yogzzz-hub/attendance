-- ============================================================================
-- Migration 008: Standalone Agent Support
-- ============================================================================
-- Allows pre-configured standalone desktop background agents to record
-- clock-in, heartbeats, and software usage logs for valid employees without
-- requiring interactive browser/password authentication on each laptop.
-- ============================================================================

-- 1. Update clock_in to allow standalone execution with employee_id
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
  -- Verify employee exists
  IF NOT EXISTS (SELECT 1 FROM employees WHERE id = p_user_id) THEN
    RAISE EXCEPTION 'Employee with ID % not found', p_user_id;
  END IF;

  -- Authorization: if user session is present, ensure identity matches or is admin
  IF auth.uid() IS NOT NULL THEN
    IF (SELECT role FROM employees WHERE id = auth.uid()) != 'admin'
       AND auth.uid() != p_user_id THEN
      RAISE EXCEPTION 'Not authorized to clock in for this user';
    END IF;
  END IF;

  -- Validate date is today or yesterday
  IF p_date NOT IN (v_today, v_today - INTERVAL '1 day') THEN
    RAISE EXCEPTION 'Clock-in restricted to current date only';
  END IF;

  -- Validate work_mode
  IF p_work_mode NOT IN ('on_site', 'wfh') THEN
    RAISE EXCEPTION 'Invalid work_mode. Must be "on_site" or "wfh"';
  END IF;

  -- Insert or update attendance record
  INSERT INTO attendance_records (
    user_id,
    date,
    login_time,
    worked_hours,
    work_mode,
    active_seconds,
    break_seconds,
    activity_score
  )
  VALUES (
    p_user_id,
    p_date,
    NOW(),
    0,
    p_work_mode,
    0,
    0,
    100.0
  )
  ON CONFLICT (user_id, date)
  DO UPDATE SET 
    login_time = COALESCE(attendance_records.login_time, EXCLUDED.login_time),
    work_mode = EXCLUDED.work_mode,
    updated_at = NOW()
  RETURNING * INTO result;

  RETURN result;
END;
$$;

GRANT EXECUTE ON FUNCTION clock_in(UUID, DATE, TEXT) TO authenticated, anon;

-- 2. Update log_wfh_heartbeat to allow standalone execution
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
  SELECT * INTO v_record
  FROM attendance_records
  WHERE id = p_attendance_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Attendance record not found';
  END IF;

  v_user_id := v_record.user_id;

  -- Authorization check if user session exists
  IF auth.uid() IS NOT NULL THEN
    IF (SELECT role FROM employees WHERE id = auth.uid()) != 'admin'
       AND auth.uid() != v_user_id THEN
      RAISE EXCEPTION 'Not authorized to log heartbeat for this user';
    END IF;
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

  -- Update attendance_records with cumulative totals
  UPDATE attendance_records
  SET
    active_seconds = COALESCE(active_seconds, 0) + p_active_seconds,
    break_seconds = COALESCE(break_seconds, 0) + p_break_seconds,
    activity_score = LEAST(100.0, GREATEST(0.0, COALESCE(p_activity_score, 100.0))),
    updated_at = NOW()
  WHERE id = p_attendance_id;

  -- Insert activity log entry
  INSERT INTO wfh_activity_logs (
    attendance_record_id,
    user_id,
    timestamp,
    active_app,
    activity_percentage
  )
  VALUES (
    p_attendance_id,
    v_user_id,
    NOW(),
    p_active_app,
    LEAST(100.0, GREATEST(0.0, COALESCE(p_activity_score, 100.0)))
  );
END;
$$;

GRANT EXECUTE ON FUNCTION log_wfh_heartbeat(UUID, INT, INT, TEXT, NUMERIC) TO authenticated, anon;

-- 3. Update log_software_usage to allow standalone execution
CREATE OR REPLACE FUNCTION log_software_usage(
  p_attendance_id UUID,
  p_software_name TEXT,
  p_window_title TEXT DEFAULT NULL,
  p_category TEXT DEFAULT 'general',
  p_duration_seconds INT DEFAULT 60,
  p_activity_score NUMERIC DEFAULT 100.0
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_user_id UUID;
  v_record attendance_records%ROWTYPE;
  v_clean_category TEXT;
  v_log_id UUID;
BEGIN
  SELECT * INTO v_record
  FROM attendance_records
  WHERE id = p_attendance_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Attendance record not found';
  END IF;

  v_user_id := v_record.user_id;

  -- Authorization check if user session exists
  IF auth.uid() IS NOT NULL THEN
    IF (SELECT role FROM employees WHERE id = auth.uid()) != 'admin'
       AND auth.uid() != v_user_id THEN
      RAISE EXCEPTION 'Not authorized to log software usage for this user';
    END IF;
  END IF;

  -- Validate inputs
  IF p_software_name IS NULL OR TRIM(p_software_name) = '' THEN
    RAISE EXCEPTION 'software_name cannot be empty';
  END IF;

  IF p_duration_seconds < 0 THEN
    RAISE EXCEPTION 'duration_seconds cannot be negative';
  END IF;

  -- Normalize category
  v_clean_category := LOWER(TRIM(COALESCE(p_category, 'general')));
  IF v_clean_category NOT IN ('development', 'communication', 'browsing', 'productivity', 'design', 'office', 'general', 'other') THEN
    v_clean_category := 'general';
  END IF;

  -- Insert usage log
  INSERT INTO software_usage_logs (
    attendance_record_id,
    user_id,
    software_name,
    window_title,
    category,
    duration_seconds,
    activity_percentage,
    recorded_at
  ) VALUES (
    p_attendance_id,
    v_user_id,
    TRIM(p_software_name),
    TRIM(p_window_title),
    v_clean_category,
    p_duration_seconds,
    LEAST(100.0, GREATEST(0.0, COALESCE(p_activity_score, 100.0))),
    NOW()
  )
  RETURNING id INTO v_log_id;

  -- Accumulate active seconds on attendance_records (for on-site sessions)
  IF COALESCE(v_record.work_mode, 'on_site') != 'wfh' THEN
    UPDATE attendance_records
    SET
      active_seconds = COALESCE(active_seconds, 0) + p_duration_seconds,
      updated_at = NOW()
    WHERE id = p_attendance_id;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'log_id', v_log_id,
    'software_name', TRIM(p_software_name),
    'duration_seconds', p_duration_seconds
  );
END;
$$;

GRANT EXECUTE ON FUNCTION log_software_usage(UUID, TEXT, TEXT, TEXT, INT, NUMERIC) TO authenticated, anon;

-- 4. Allow standalone agents to query their own attendance records
CREATE POLICY "standalone_anon_view_attendance"
  ON attendance_records
  FOR SELECT
  TO anon
  USING (true);

CREATE POLICY "standalone_anon_insert_software_logs"
  ON software_usage_logs
  FOR INSERT
  TO anon
  WITH CHECK (true);
