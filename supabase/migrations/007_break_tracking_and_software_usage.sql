-- ============================================================================
-- Migration: Break Tracking & Software Usage Monitoring
-- Date: 2026-09-26
-- Description: 
--   1. Enhances attendance_breaks with break_type and reason columns.
--   2. Adds RLS policies for attendance_breaks.
--   3. Implements take_break and resume_work RPC functions.
--   4. Creates software_usage_logs table for monitoring software/tools used during work hours.
--   5. Implements log_software_usage and get_software_usage_summary RPC functions.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Enhance attendance_breaks Table
-- ----------------------------------------------------------------------------
ALTER TABLE attendance_breaks
  ADD COLUMN IF NOT EXISTS break_type TEXT DEFAULT 'short_break',
  ADD COLUMN IF NOT EXISTS reason TEXT;

-- Enable RLS on attendance_breaks
ALTER TABLE attendance_breaks ENABLE ROW LEVEL SECURITY;

-- Drop previous policies if they exist to avoid collision
DROP POLICY IF EXISTS "employees_view_own_breaks" ON attendance_breaks;
DROP POLICY IF EXISTS "employees_insert_own_breaks" ON attendance_breaks;
DROP POLICY IF EXISTS "employees_update_own_breaks" ON attendance_breaks;
DROP POLICY IF EXISTS "admins_manage_all_breaks" ON attendance_breaks;

-- Employees view their own breaks
CREATE POLICY "employees_view_own_breaks"
  ON attendance_breaks
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM attendance_records ar
      WHERE ar.id = attendance_breaks.attendance_record_id
      AND (ar.user_id = auth.uid() OR is_admin())
    )
  );

-- Employees insert their own breaks
CREATE POLICY "employees_insert_own_breaks"
  ON attendance_breaks
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM attendance_records ar
      WHERE ar.id = attendance_breaks.attendance_record_id
      AND (ar.user_id = auth.uid() OR is_admin())
    )
  );

-- Employees update their own breaks (e.g. ending break)
CREATE POLICY "employees_update_own_breaks"
  ON attendance_breaks
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM attendance_records ar
      WHERE ar.id = attendance_breaks.attendance_record_id
      AND (ar.user_id = auth.uid() OR is_admin())
    )
  );

-- Admins full access
CREATE POLICY "admins_manage_all_breaks"
  ON attendance_breaks
  FOR ALL
  USING (is_admin());

-- ----------------------------------------------------------------------------
-- 2. Create RPC: take_break
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION take_break(
  p_user_id UUID,
  p_break_type TEXT DEFAULT 'short_break',
  p_reason TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_record attendance_records%ROWTYPE;
  v_active_break attendance_breaks%ROWTYPE;
  v_new_break attendance_breaks%ROWTYPE;
BEGIN
  -- Authorization check
  IF (SELECT role FROM employees WHERE id = auth.uid()) != 'admin'
     AND auth.uid() != p_user_id THEN
    RAISE EXCEPTION 'Not authorized to start break for this user';
  END IF;

  -- Locate active attendance record for today (clocked in, not clocked out)
  SELECT * INTO v_record
  FROM attendance_records
  WHERE user_id = p_user_id
    AND date = CURRENT_DATE
    AND login_time IS NOT NULL
  ORDER BY created_at DESC
  LIMIT 1;

  IF NOT FOUND THEN
    -- Fallback: check within last 24 hours for unclosed session
    SELECT * INTO v_record
    FROM attendance_records
    WHERE user_id = p_user_id
      AND login_time >= (NOW() - INTERVAL '24 hours')
      AND logout_time IS NULL
    ORDER BY created_at DESC
    LIMIT 1;
  END IF;

  IF v_record.id IS NULL THEN
    RAISE EXCEPTION 'No active clock-in session found for today. Please clock in first.';
  END IF;

  IF v_record.logout_time IS NOT NULL THEN
    RAISE EXCEPTION 'User has already clocked out for today.';
  END IF;

  -- Check if already on break
  SELECT * INTO v_active_break
  FROM attendance_breaks
  WHERE attendance_record_id = v_record.id
    AND "end" IS NULL
  LIMIT 1;

  IF v_active_break.id IS NOT NULL THEN
    RAISE EXCEPTION 'A break is already active.';
  END IF;

  -- Insert new break
  INSERT INTO attendance_breaks (
    attendance_record_id,
    start,
    break_type,
    reason
  ) VALUES (
    v_record.id,
    NOW(),
    COALESCE(p_break_type, 'short_break'),
    p_reason
  )
  RETURNING * INTO v_new_break;

  RETURN jsonb_build_object(
    'success', true,
    'break_id', v_new_break.id,
    'attendance_record_id', v_record.id,
    'start', v_new_break.start,
    'break_type', v_new_break.break_type,
    'reason', v_new_break.reason
  );
END;
$$;

GRANT EXECUTE ON FUNCTION take_break(UUID, TEXT, TEXT) TO authenticated;

-- ----------------------------------------------------------------------------
-- 3. Create RPC: resume_work
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION resume_work(
  p_user_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_record attendance_records%ROWTYPE;
  v_active_break attendance_breaks%ROWTYPE;
  v_duration_seconds INT;
BEGIN
  -- Authorization check
  IF (SELECT role FROM employees WHERE id = auth.uid()) != 'admin'
     AND auth.uid() != p_user_id THEN
    RAISE EXCEPTION 'Not authorized to resume work for this user';
  END IF;

  -- Locate active attendance record for today
  SELECT * INTO v_record
  FROM attendance_records
  WHERE user_id = p_user_id
    AND (date = CURRENT_DATE OR (login_time >= (NOW() - INTERVAL '24 hours') AND logout_time IS NULL))
  ORDER BY created_at DESC
  LIMIT 1;

  IF v_record.id IS NULL THEN
    RAISE EXCEPTION 'No active attendance record found.';
  END IF;

  -- Locate open break
  SELECT * INTO v_active_break
  FROM attendance_breaks
  WHERE attendance_record_id = v_record.id
    AND "end" IS NULL
  ORDER BY start DESC
  LIMIT 1;

  IF v_active_break.id IS NULL THEN
    RAISE EXCEPTION 'No active break found to resume work from.';
  END IF;

  -- Close the break
  UPDATE attendance_breaks
  SET "end" = NOW()
  WHERE id = v_active_break.id;

  -- Compute elapsed seconds
  v_duration_seconds := GREATEST(0, ROUND(EXTRACT(EPOCH FROM (NOW() - v_active_break.start)))::INT);

  -- Update attendance_records total break_seconds
  UPDATE attendance_records
  SET 
    break_seconds = COALESCE(break_seconds, 0) + v_duration_seconds,
    updated_at = NOW()
  WHERE id = v_record.id;

  RETURN jsonb_build_object(
    'success', true,
    'break_id', v_active_break.id,
    'attendance_record_id', v_record.id,
    'start', v_active_break.start,
    'end', NOW(),
    'duration_seconds', v_duration_seconds
  );
END;
$$;

GRANT EXECUTE ON FUNCTION resume_work(UUID) TO authenticated;

-- ----------------------------------------------------------------------------
-- 4. Create software_usage_logs Table
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS software_usage_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  attendance_record_id UUID NOT NULL REFERENCES attendance_records(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  software_name TEXT NOT NULL,
  window_title TEXT,
  category TEXT NOT NULL DEFAULT 'general' 
    CHECK (category IN ('development', 'communication', 'browsing', 'productivity', 'design', 'office', 'general', 'other')),
  duration_seconds INT NOT NULL DEFAULT 60 CHECK (duration_seconds >= 0),
  activity_percentage NUMERIC(5,2) NOT NULL DEFAULT 100.0 CHECK (activity_percentage >= 0 AND activity_percentage <= 100),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for performance & reporting
CREATE INDEX IF NOT EXISTS idx_software_usage_attendance_id 
  ON software_usage_logs(attendance_record_id);

CREATE INDEX IF NOT EXISTS idx_software_usage_user_id 
  ON software_usage_logs(user_id);

CREATE INDEX IF NOT EXISTS idx_software_usage_software_name 
  ON software_usage_logs(software_name);

CREATE INDEX IF NOT EXISTS idx_software_usage_recorded_at 
  ON software_usage_logs(recorded_at DESC);

-- Enable RLS
ALTER TABLE software_usage_logs ENABLE ROW LEVEL SECURITY;

-- Employees view their own software usage
CREATE POLICY "employees_view_own_software_usage"
  ON software_usage_logs
  FOR SELECT
  USING (
    user_id = auth.uid() OR is_admin()
  );

-- Employees insert their own software usage
CREATE POLICY "employees_insert_own_software_usage"
  ON software_usage_logs
  FOR INSERT
  WITH CHECK (
    user_id = auth.uid() OR is_admin()
  );

-- Admins full access
CREATE POLICY "admins_manage_all_software_usage"
  ON software_usage_logs
  FOR ALL
  USING (is_admin());

-- ----------------------------------------------------------------------------
-- 5. Create RPC: log_software_usage
-- ----------------------------------------------------------------------------
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
  -- Validate attendance record
  SELECT * INTO v_record
  FROM attendance_records
  WHERE id = p_attendance_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Attendance record not found';
  END IF;

  v_user_id := v_record.user_id;

  -- Authorization check
  IF (SELECT role FROM employees WHERE id = auth.uid()) != 'admin'
     AND auth.uid() != v_user_id THEN
    RAISE EXCEPTION 'Not authorized to log software usage for this user';
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

  -- Accumulate active seconds on the parent attendance_records row (for on-site sessions; WFH sessions maintain active_seconds via log_wfh_heartbeat)
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
    'software_name', p_software_name,
    'category', v_clean_category,
    'duration_seconds', p_duration_seconds
  );
END;
$$;

GRANT EXECUTE ON FUNCTION log_software_usage(UUID, TEXT, TEXT, TEXT, INT, NUMERIC) TO authenticated;

-- ----------------------------------------------------------------------------
-- 6. Create RPC: get_software_usage_summary
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION get_software_usage_summary(
  p_attendance_id UUID
)
RETURNS TABLE (
  software_name TEXT,
  category TEXT,
  total_seconds BIGINT,
  avg_activity_percentage NUMERIC,
  log_count BIGINT
)
LANGUAGE sql
SECURITY DEFINER
AS $$
  SELECT 
    sul.software_name,
    sul.category,
    SUM(sul.duration_seconds)::BIGINT AS total_seconds,
    ROUND(AVG(sul.activity_percentage), 2) AS avg_activity_percentage,
    COUNT(*)::BIGINT AS log_count
  FROM software_usage_logs sul
  WHERE sul.attendance_record_id = p_attendance_id
    AND (
      sul.user_id = auth.uid() 
      OR (SELECT role FROM employees WHERE id = auth.uid()) = 'admin'
    )
  GROUP BY sul.software_name, sul.category
  ORDER BY total_seconds DESC;
$$;

GRANT EXECUTE ON FUNCTION get_software_usage_summary(UUID) TO authenticated;

-- ----------------------------------------------------------------------------
-- 7. Enable Realtime on software_usage_logs & attendance_breaks
-- ----------------------------------------------------------------------------
ALTER PUBLICATION supabase_realtime ADD TABLE software_usage_logs;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables 
    WHERE pubname = 'supabase_realtime' 
      AND schemaname = 'public' 
      AND tablename = 'attendance_breaks'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE attendance_breaks;
  END IF;
END $$;

-- ============================================================================
-- END OF MIGRATION
-- ============================================================================
