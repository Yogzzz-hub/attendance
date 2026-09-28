import { AttendanceRecord, GeolocationData, SoftwareUsageLog, SoftwareUsageSummary } from '../types';
import type { RoleSchedule } from '../types';
import {
  toOfficeDateSafe,
  getOfficeTodayIso,
  getOfficeNow,
  formatOffice
} from '../utils/timezoneUtils';
import {
  isLateArrival,
  getLunchStartTime,
  getLunchEndTime,
  getWorkEndTime,
  DEFAULT_ROLE_SCHEDULE
} from '../constants/workingHours';
import { supabase } from './supabaseClient';
import { configService } from './configService';

// RPC result types
interface ClockInRPCResult {
  id: string;
  login_time: string;
}
interface ClockOutRPCResult {
  id: string;
}
interface UpdateAttendanceRecordParams {
  p_record_id: string;
  p_is_late?: boolean;
  p_late_reason?: string | null;
  p_lunch_start?: string | null;
  p_lunch_end?: string | null;
  p_is_late_from_lunch?: boolean;
  p_lunch_late_reason?: string | null;
  p_location?: GeolocationData | null;
  p_client_ip?: string | null;
  p_early_logout_reason?: string | null;
}


class GlobalAttendanceService {
  private readonly ATTENDANCE_TABLE = 'attendance_records';
  private readonly BREAKS_TABLE = 'attendance_breaks';
  private readonly USERS_TABLE = 'employees';

  private convertDbToAttendance(dbData: unknown, schedule: RoleSchedule): AttendanceRecord {
    const data = dbData as Record<string, unknown>;
    const rawBreaks = data.attendance_breaks as unknown[] | undefined;
    const breaks: unknown[] = Array.isArray(rawBreaks) ? rawBreaks : [];

    // Calculate total break minutes from completed breaks
    let totalBreakMins = 0;
    if (Array.isArray(breaks)) {
      breaks.forEach((b: unknown) => {
        const breakData = b as Record<string, unknown>;
        if (breakData.start && breakData.end) {
          const startTime = new Date(breakData.start as string);
          const endTime = new Date(breakData.end as string);
          if (!isNaN(startTime.getTime()) && !isNaN(endTime.getTime())) {
            totalBreakMins += (endTime.getTime() - startTime.getTime()) / (1000 * 60);
          }
        }
      });
    }

    // Round break minutes to 2 decimal places
    totalBreakMins = Math.round(totalBreakMins * 100) / 100;

    // Guard: validate critical timestamps before parsing
    if (!data.login_time && !data.logout_time) {
      console.warn(
        `⚠️ convertDbToAttendance: Both login_time and logout_time are missing for record ${(data.id as string) || '(no id)'}. ` +
        `Hours will default to 0 unless worked_hours is present.`
      );
    }

    // Parse worked_hours (Postgres NUMERIC may return string)
    const wh = data.worked_hours;
    let calcHours = (wh !== null && wh !== undefined) ? Number(wh) : 0;

    // Fallback: if worked_hours is missing/0 but we have clock times, recalculate
    if (!calcHours && data.login_time && data.logout_time) {
      const loginTime = new Date(data.login_time as string);
      const logoutTime = new Date(data.logout_time as string);
      if (!isNaN(loginTime.getTime()) && !isNaN(logoutTime.getTime())) {
        const totalMs = logoutTime.getTime() - loginTime.getTime();
        const breakMs = totalBreakMins * 60 * 1000;
        const netMs = totalMs - breakMs;
        calcHours = netMs > 0 ? netMs / (1000 * 60 * 60) : 0;
      }
    }

    // Round hours to 2 decimal places
    calcHours = Math.round(calcHours * 100) / 100;

    // Compute overtime based on schedule's standard work hours
    const overtime = Math.max(0, calcHours - schedule.standard_work_hours);

    const employees = data.employees as Record<string, unknown> | undefined;
    return {
      id: data.id as string,
      userId: (data.user_id as string) || '',
      userName: (employees?.name as string | undefined) || '',
      userEmail: (employees?.email as string | undefined) || '',
      employeeId: employees?.employee_id as string | undefined,
      employeeName: (employees?.name as string | undefined) || '',
      department: (employees?.department as string | undefined) || '',
      date: data.date as string,
      clockIn: toOfficeDateSafe(data.login_time as string | undefined) || null,
      clockOut: toOfficeDateSafe(data.logout_time as string | undefined) || null,
      lunchStart: toOfficeDateSafe(data.lunch_start as string | undefined) || null,
      lunchEnd: toOfficeDateSafe(data.lunch_end as string | undefined) || null,
      createdAt: toOfficeDateSafe(data.created_at as string) || null,
      updatedAt: toOfficeDateSafe(data.updated_at as string) || null,
      // Use calculated hours with fallback
      hoursWorked: calcHours,
      totalHours: calcHours,
      totalBreakMinutes: totalBreakMins,
      totalBreakHours: totalBreakMins / 60,
      breaks: breaks.map((bt) => {
        const btData = bt as Record<string, unknown>;
        return {
          id: btData.id as string,
          startTime: toOfficeDateSafe(btData.start as string) || null,
          endTime: toOfficeDateSafe(btData.end as string) || null,
          type: (btData.type as string) || 'break',
          breakType: (btData.break_type as string) || (btData.type as string) || 'short_break',
          reason: (btData.reason as string) || undefined,
          duration: (btData.duration != null && btData.duration !== '') ? Number(btData.duration) : 0
        };
      }),
      breakTimes: breaks.map((bt) => {
        const btData = bt as Record<string, unknown>;
        return {
          id: btData.id as string,
          start: toOfficeDateSafe(btData.start as string) || null,
          end: toOfficeDateSafe(btData.end as string) || null,
          type: (btData.type as string) || 'break',
          breakType: (btData.break_type as string) || (btData.type as string) || 'short_break',
          reason: (btData.reason as string) || undefined,
          duration: (btData.duration != null && btData.duration !== '') ? Number(btData.duration) : 0
        };
      }),
      isLate: (data.is_late as boolean) || false,
      lateReason: (data.late_reason as string | undefined) || (data.audit_data as string | undefined) || null,
      // Pass-is_late flag to determineStatus; DB is_late is the source of truth.
      // Passes clockOut so `partial` can fire for early departures.
      status: this.determineStatus(
        toOfficeDateSafe(data.login_time as string | undefined) || null,
        toOfficeDateSafe(data.logout_time as string | undefined) || null,
        schedule,
        (data.is_late as boolean) || false
      ),
      location: data.location as GeolocationData || null,
      isLateFromLunch: (data.is_late_from_lunch as boolean) || false,
      lunchLateReason: (data.lunch_late_reason as string | undefined) || null,
      overtime: overtime,
      workMode: (data.work_mode as 'on_site' | 'wfh') || 'on_site',
      activeSeconds: (data.active_seconds as number) || 0,
      breakSeconds: (data.break_seconds as number) || 0,
      activityScore: (data.activity_score as number) || 100.0
    } as AttendanceRecord;
  }

   async clockIn(userId: string, lateReason?: string, location?: GeolocationData, clientIP?: string, workMode: 'on_site' | 'wfh' = 'on_site'): Promise<AttendanceRecord> {
    try {
      console.log('🕐 Starting clock in for user:', userId);

      // Get user details and role in a single query
      const { data: userData, error: userError } = await supabase
        .from(this.USERS_TABLE)
        .select('name, email, employee_id, department, role')
        .eq('id', userId)
        .single();

      if (userError) throw new Error('User not found');

      // PHASE 1: Fetch schedule for user's role
      const role = userData.role as string || 'employee';
      const schedule = await configService.getScheduleByRole(role);
      if (!schedule) {
        throw new Error(`No schedule configured for role: ${role}`);
      }

      const todayIso = getOfficeTodayIso();

      // Check if already clocked in today
      const { data: existingRecord } = await supabase
        .from(this.ATTENDANCE_TABLE)
        .select(`
          *,
          employees:user_id (name, email, employee_id, department, role),
          attendance_breaks (*)
        `)
        .eq('user_id', userId)
        .eq('date', todayIso)
        .maybeSingle();

      if (existingRecord?.login_time) {
        const alreadyError = new Error('Already clocked in today') as Error & {
          code: string;
          existingRecord: AttendanceRecord;
        };
        alreadyError.code = 'ALREADY_CLOCKED_IN';
        alreadyError.existingRecord = this.convertDbToAttendance(existingRecord, schedule);
        throw alreadyError;
      }

      // Create attendance record with SERVER TIMESTAMP
      const { data: attendanceRecordRaw, error: insertError } = await supabase
        .rpc('clock_in', {
          p_user_id: userId,
          p_date: todayIso,
          p_work_mode: workMode
        })
        .single();

      if (insertError) {
        if (
          insertError.message?.includes('duplicate key') ||
          insertError.message?.includes('unique constraint') ||
          insertError.code === '23505' ||
          insertError.message?.toLowerCase().includes('already clocked in')
        ) {
          const fallback = await this.getTodayAttendance(userId);
          const alreadyError = new Error('Already clocked in today') as Error & {
            code: string;
            existingRecord?: AttendanceRecord | null;
          };
          alreadyError.code = 'ALREADY_CLOCKED_IN';
          alreadyError.existingRecord = fallback;
          throw alreadyError;
        }
        throw insertError;
      }

      const attendanceRecord = attendanceRecordRaw as ClockInRPCResult;

      const clockInTime = toOfficeDateSafe(attendanceRecord.login_time) || new Date();
      const isLate = this.isLateArrival(clockInTime, schedule);

      // Apply additional fields via update_attendance_record RPC (server-side validation)
      const { error: updateError } = await supabase.rpc('update_attendance_record', {
        p_record_id: attendanceRecord.id,
        p_is_late: isLate,
        p_late_reason: isLate ? (lateReason || 'Late arrival') : null,
        p_location: location,
        p_client_ip: clientIP
      }).single();
      if (updateError) throw updateError;

      const newAttendanceRecord: AttendanceRecord = {
        id: attendanceRecord.id,
        userId,
        userName: userData.name || 'Unknown User',
        userEmail: userData.email || '',
        employeeId: userData.employee_id,
        employeeName: userData.name || '',
        department: userData.department || 'Unknown',
        date: formatOffice(getOfficeNow(), 'dd-MM-yyyy'),
        clockIn: clockInTime,
        clockOut: undefined,
        lunchStart: undefined,
        lunchEnd: undefined,
        breaks: [],
        breakTimes: [],
        hoursWorked: 0,
        totalHours: 0,
        isLate: isLate,
        lateReason: isLate ? (lateReason || 'Late arrival') : undefined,
        location: location,
        overtime: 0,
        status: this.determineStatus(clockInTime, null, schedule, isLate),
        createdAt: clockInTime,
        updatedAt: clockInTime,
        workMode: workMode,
        activeSeconds: 0,
        breakSeconds: 0,
        activityScore: 100.0
      };

      console.log('✅ Clock in successful:', newAttendanceRecord);
      return newAttendanceRecord;
    } catch (error) {
      console.error('❌ Clock in failed:', error);
      throw error;
    }
  }

  async clockOut(userId: string, reason?: string): Promise<AttendanceRecord> {
    try {
      console.log('🕕 Starting clock out for user:', userId);

      const todayIso = getOfficeTodayIso();

      // Get attendance record ID for today (or active unclosed session)
      let { data: attendanceRecord, error: fetchError } = await supabase
        .from(this.ATTENDANCE_TABLE)
        .select('id, date, login_time, logout_time, worked_hours')
        .eq('user_id', userId)
        .eq('date', todayIso)
        .maybeSingle();

      if (!attendanceRecord) {
        // Fallback: search for any active unclosed session
        const { data: openSession } = await supabase
          .from(this.ATTENDANCE_TABLE)
          .select('id, date, login_time, logout_time, worked_hours')
          .eq('user_id', userId)
          .is('logout_time', null)
          .order('login_time', { ascending: false })
          .limit(1)
          .maybeSingle();

        if (openSession) {
          attendanceRecord = openSession;
          fetchError = null;
        }
      }

      if (fetchError || !attendanceRecord) {
        throw new Error('No attendance record found for today');
      }

      if (attendanceRecord.logout_time) {
        throw new Error('Already clocked out for today');
      }

      console.log('📋 Pre-update record:', {
        id: attendanceRecord.id,
        login_time: attendanceRecord.login_time,
        logout_time: attendanceRecord.logout_time,
        worked_hours: attendanceRecord.worked_hours
      });

      // PHASE 1: Fetch employee's role to get schedule
      const { data: employeeData } = await supabase
        .from(this.USERS_TABLE)
        .select('role')
        .eq('id', userId)
        .single();

      const role = employeeData?.role as string || 'employee';
      const schedule = await configService.getScheduleByRole(role);
      if (!schedule) {
        throw new Error(`No schedule configured for role: ${role}`);
      }

      const targetDate = (attendanceRecord.date as string) || todayIso;

      // Update via SECURITY DEFINER RPC with server-side validation
      console.log('🔄 Invoking clock_out RPC with params:', {
        p_user_id: userId,
        p_date: targetDate,
        p_early_logout_reason: reason || null
      });

      const { data: rpcResultRaw, error: rpcError } = await supabase.rpc('clock_out', {
        p_user_id: userId,
        p_date: targetDate,
        p_early_logout_reason: reason || null
      }).single();

      if (rpcError) throw rpcError;
      if (!rpcResultRaw) throw new Error('Clock out RPC did not return a record');

      const rpcResult = rpcResultRaw as ClockOutRPCResult;

      // Fetch the full updated record with joins to get breaks and employee details
      const { data: fullRecord, error: fetchFullError } = await supabase
        .from(this.ATTENDANCE_TABLE)
        .select(`
           *,
           employees:user_id (name, email, employee_id, department, role),
           attendance_breaks (*)
         `)
        .eq('id', rpcResult.id)
        .single();

      if (fetchFullError) throw fetchFullError;
      if (!fullRecord) throw new Error('Failed to retrieve updated record');

      console.log('📥 Raw updated record (pre-convert):', {
        id: fullRecord.id,
        login_time: fullRecord.login_time,
        logout_time: fullRecord.logout_time,
        worked_hours: fullRecord.worked_hours,
        breaksCount: fullRecord.attendance_breaks?.length || 0
      });

      // Convert using mapper, passing schedule
      const updatedRecord = this.convertDbToAttendance(fullRecord, schedule);

      console.log('✅ Clock out successful:', {
        id: updatedRecord.id,
        date: updatedRecord.date,
        clockIn: updatedRecord.clockIn,
        clockOut: updatedRecord.clockOut,
        hoursWorked: updatedRecord.hoursWorked,
        totalHours: updatedRecord.totalHours,
        totalBreakMinutes: updatedRecord.totalBreakMinutes,
        breaksCount: updatedRecord.breaks.length
      });

      return updatedRecord;
    } catch (error) {
      console.error('❌ Clock out failed:', error);
      throw error;
    }
  }

  async getTodayAttendance(userId: string): Promise<AttendanceRecord | null> {
    try {
      const todayIso = getOfficeTodayIso();

      // Fetch employee role and schedule
      const { data: employeeData, error: empError } = await supabase
        .from(this.USERS_TABLE)
        .select('role')
        .eq('id', userId)
        .single();

      if (empError) throw empError;

      const role = employeeData?.role as string || 'employee';
      let schedule = await configService.getScheduleByRole(role);
      if (!schedule) {
        console.warn(`No schedule found for role "${role}", using defaults`);
        schedule = { ...DEFAULT_ROLE_SCHEDULE, role };
      }

      const { data, error } = await supabase
        .from(this.ATTENDANCE_TABLE)
        .select(`
          *,
          employees:user_id (name, email, employee_id, department, role),
          attendance_breaks (*)
        `)
        .eq('user_id', userId)
        .eq('date', todayIso)
        .maybeSingle();

      if (error && error.code !== 'PGRST116') {
        console.warn('Error fetching today attendance by date:', error);
      }

      let activeRow = data;
      // Resilient Fallback: If no record found for today's ISO date, check for any unclosed session (logout_time IS NULL)
      // or record created in the last 24 hours
      if (!activeRow) {
        const { data: openSession, error: openError } = await supabase
          .from(this.ATTENDANCE_TABLE)
          .select(`
            *,
            employees:user_id (name, email, employee_id, department, role),
            attendance_breaks (*)
          `)
          .eq('user_id', userId)
          .is('logout_time', null)
          .order('login_time', { ascending: false })
          .limit(1)
          .maybeSingle();

        if (!openError && openSession) {
          activeRow = openSession;
        }
      }

      return activeRow ? this.convertDbToAttendance(activeRow, schedule) : null;
    } catch (error) {
      console.error('Error getting today attendance:', error);
      return null;
    }
  }

  async getAttendanceHistory(userId: string, days: number = 30): Promise<AttendanceRecord[]> {
    try {
      const endDate = getOfficeNow();
      const startDate = getOfficeNow();
      startDate.setDate(startDate.getDate() - days);

      // Fetch employee role and schedule once (role assumed stable over period)
      const { data: employeeData, error: empError } = await supabase
        .from(this.USERS_TABLE)
        .select('role')
        .eq('id', userId)
        .single();

      if (empError) throw empError;

      const role = employeeData?.role as string || 'employee';
      let schedule = await configService.getScheduleByRole(role);
      if (!schedule) {
        console.warn(`No schedule found for role "${role}", using defaults`);
        schedule = { ...DEFAULT_ROLE_SCHEDULE, role };
      }

      const { data, error } = await supabase
        .from(this.ATTENDANCE_TABLE)
        .select(`
          *,
          employees:user_id (name, email, employee_id, department, role),
          attendance_breaks (*)
        `)
        .eq('user_id', userId)
        .gte('date', startDate.toISOString().split('T')[0])
        .lte('date', endDate.toISOString().split('T')[0])
        .order('date', { ascending: false })
        .limit(500);

      if (error) throw error;

      if (!data || data.length === 0) {
        return [];
      }

      return data.map(record => this.convertDbToAttendance(record, schedule));
    } catch (error) {
      console.error('Error getting attendance history:', error);
      return [];
    }
  }

  async getAttendanceRange(
    userId: string,
    startDate: Date | string,
    endDate: Date | string
  ): Promise<AttendanceRecord[]> {
    try {
      // Timezone-safe formatter: always uses Asia/Kolkata
      const toOfficeIso = (d: Date | string): string => {
        const dateObj = typeof d === 'string' ? new Date(d) : d;
        if (isNaN(dateObj.getTime())) return new Date().toISOString().split('T')[0];

        const options = { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' } as const;
        const parts = new Intl.DateTimeFormat('en-IN', options).formatToParts(dateObj);
        const year = parts.find(p => p.type === 'year')?.value;
        const month = parts.find(p => p.type === 'month')?.value;
        const day = parts.find(p => p.type === 'day')?.value;
        return `${year}-${month}-${day}`;
      };

      // Day-shift helper: advance/rewind an ISO date string by N days.
      // Returns a stable YYYY-MM-DD string under the office timezone.
      const shiftByDays = (isoDate: string, days: number): string => {
        const [y, m, d] = isoDate.split('-').map(Number);
        return toOfficeIso(new Date(y, m - 1, d + days));
      };

      // ── CRITICAL FIX ──────────────────────────────────────────────────────
      // Postgres TIMESTAMPTZ stores wall-clock timestamps with their offset
      // (e.g. '2026-05-11T00:30:00+05:30' = '2026-05-10T19:00:00Z' in UTC).
      // Phrasing the range guards as TEXT makes Postgres apply UTC midnight
      // anchors:
      //   lte('date', '2026-05-17') → '2026-05-17T00:00:00+00:00' UTC
      //   gte('date', '2026-05-11') → '2026-05-11T00:00:00+00:00' UTC
      // Anything stored AFTER midnight UTC on Monday (00:00 IST = prior day
      // 18:30 UTC) or BEFORE midnight UTC on Sunday (23:59 IST = same day
      // 18:29 UTC) is silently dropped.
      //
      // Fix: push the upper bound by +1 day so ALL Sunday-IST records fall
      // within the ~18:30 UTC to 00:00 UTC window.  Pull the lower bound
      // by -1 day so ALL Monday-IST (00:00-05:29 IST) records also land
      // inside the window.  Net inclusive window: all 7 calendar days in
      // Asia/Kolkata, no records lost at either boundary.
      // ──────────────────────────────────────────────────────────────────────

      const startDateStr = toOfficeIso(startDate);                // Monday 00:00 IST label
      const endDateStr = toOfficeIso(endDate);                  // Sunday 23:59 IST label
      const queryGteDate = shiftByDays(startDateStr, - 1); // go back 1 day → captures Mon 00:00-05:29 IST
      const queryLteDate = shiftByDays(endDateStr, + 1); // go forward 1 day → captures Sun 17:30-23:59 IST

      // Fetch employee role and schedule once
      const { data: employeeData, error: empError } = await supabase
        .from(this.USERS_TABLE)
        .select('role')
        .eq('id', userId)
        .single();

      if (empError) throw empError;

      const role = employeeData?.role as string || 'employee';
      let schedule = await configService.getScheduleByRole(role);
      if (!schedule) {
        console.warn(`No schedule found for role "${role}", using defaults`);
        schedule = { ...DEFAULT_ROLE_SCHEDULE, role };
      }

      const { data, error } = await supabase
        .from(this.ATTENDANCE_TABLE)
        .select(`
            *,
            employees:user_id (name, email, employee_id, department),
            attendance_breaks (*)
          `)
        .eq('user_id', userId)
        .gte('date', queryGteDate)
        .lte('date', queryLteDate)
        .order('date', { ascending: false })
        .limit(500);

      if (error) throw error;

      if (!data || data.length === 0) {
        return [];
      }

      return data.map(record => this.convertDbToAttendance(record, schedule));
    } catch (error) {
      console.error('Error getting attendance range:', error);
      return [];
    }
  }

  async getAllAttendanceRecords(startDate?: string, endDate?: string): Promise<AttendanceRecord[]> {
    try {
      let query = supabase
        .from(this.ATTENDANCE_TABLE)
        .select(`
          *,
          employees:user_id (name, email, employee_id, department, role),
          attendance_breaks (*)
        `)
        .order('date', { ascending: false });

      if (startDate && endDate) {
        const gteDate = new Date(startDate);
        const lteDate = new Date(endDate);

        gteDate.setDate(gteDate.getDate() - 1);
        lteDate.setDate(lteDate.getDate() + 1);

        query = query
          .gte('date', gteDate.toISOString().split('T')[0])
          .lte('date', lteDate.toISOString().split('T')[0]);
      } else {
        const thirtyDaysAgo = getOfficeNow();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
        query = query.gte('date', thirtyDaysAgo.toISOString().split('T')[0]);
      }

      const { data, error } = await query.limit(500);

      if (error) throw error;

      if (!data || data.length === 0) {
        return [];
      }

      const roleSet = new Set<string>();
      data.forEach(record => {
        const emp = record.employees as Record<string, unknown> | undefined;
        if (emp?.role) roleSet.add(emp.role as string);
      });

      const schedulePromises = Array.from(roleSet).map(role =>
        configService.getScheduleByRole(role).then(sched => ({
          role,
          schedule: sched || { ...DEFAULT_ROLE_SCHEDULE, role }
        }))
      );
      const scheduleMapArray = await Promise.all(schedulePromises);
      const scheduleMap = new Map<string, RoleSchedule>(
        scheduleMapArray.map(({ role, schedule }) => [role, schedule])
      );

      return data.map(record => {
        const emp = record.employees as Record<string, unknown> | undefined;
        const userRole = (emp?.role as string) || 'employee';
        const schedule = scheduleMap.get(userRole)!;
        return this.convertDbToAttendance(record, schedule);
      });
    } catch (error) {
      console.error('Error getting all attendance records:', error);
      return [];
    }
  }

  async getWFHDailySummary(date: string): Promise<Array<{
    employeeId: string;
    employeeName: string;
    department: string;
    role: string;
    activeSeconds: number;
    breakSeconds: number;
    activityScore: number;
    lastActiveApp: string | null;
    attendanceRecordId: string;
  }>> {
    try {
      const parts = date.split('-');
      if (parts.length !== 3) return [];
      const [day, month, year] = parts;
      const dateIso = `${year}-${month}-${day}`;

      const { data, error } = await supabase
        .from(this.ATTENDANCE_TABLE)
        .select(`
          id,
          user_id,
          active_seconds,
          break_seconds,
          activity_score,
          employees:user_id (name, department, role)
        `)
        .eq('date', dateIso)
        .eq('work_mode', 'wfh')
        .not('login_time', 'is', null)
        .order('user_id', { ascending: true });

      if (error) throw error;
      if (!data || data.length === 0) return [];

      const summary = data.map((record: Record<string, unknown>) => {
        const emp = (record.employees as Record<string, unknown> | undefined);
        return {
          employeeId: record.user_id as string,
          employeeName: (emp?.name as string) || 'Unknown',
          department: (emp?.department as string) || 'Unknown',
          role: (emp?.role as string) || 'employee',
          activeSeconds: (record.active_seconds as number) || 0,
          breakSeconds: (record.break_seconds as number) || 0,
          activityScore: (record.activity_score as number) || 0,
          lastActiveApp: null,
          attendanceRecordId: record.id as string,
        };
      });

      // Enrich with last known active app from wfh_activity_logs
      for (const item of summary) {
        const { data: logs } = await supabase
          .from('wfh_activity_logs')
          .select('active_app, timestamp')
          .eq('attendance_record_id', item.attendanceRecordId)
          .order('timestamp', { ascending: false })
          .limit(1)
          .maybeSingle();

        if (logs) {
          item.lastActiveApp = logs.active_app || null;
        }
      }

      return summary;
    } catch (error) {
      console.error('Error loading WFH daily summary:', error);
      return [];
    }
  }

  async getWFHActivityLogs(attendanceRecordId: string): Promise<Array<{
    id: string;
    timestamp: string;
    activeApp: string | null;
    activityPercentage: number;
  }>> {
    try {
      const { data, error } = await supabase
        .from('wfh_activity_logs')
        .select('id, timestamp, active_app, activity_percentage')
        .eq('attendance_record_id', attendanceRecordId)
        .order('timestamp', { ascending: true });

      if (error) throw error;
      if (!data || data.length === 0) return [];

      return data.map((log: Record<string, unknown>) => ({
        id: log.id as string,
        timestamp: log.timestamp as string,
        activeApp: (log.active_app as string | null) || null,
        activityPercentage: (log.activity_percentage as number) || 0,
      }));
    } catch (error) {
      console.error('Error loading WFH activity logs:', error);
      return [];
    }
  }

  async getAttendanceForDate(userId: string, date: Date): Promise<AttendanceRecord | null> {
    try {
      const dateIso = date.toISOString().split('T')[0];

      // Fetch employee role and schedule
      const { data: employeeData, error: empError } = await supabase
        .from(this.USERS_TABLE)
        .select('role')
        .eq('id', userId)
        .single();

      if (empError) throw empError;

      const role = employeeData?.role as string || 'employee';
      let schedule = await configService.getScheduleByRole(role);
      if (!schedule) {
        console.warn(`No schedule found for role "${role}", using defaults`);
        schedule = { ...DEFAULT_ROLE_SCHEDULE, role };
      }

      const { data, error } = await supabase
        .from(this.ATTENDANCE_TABLE)
        .select(`
          *,
          employees:user_id (name, email, employee_id, department, role),
          attendance_breaks (*)
        `)
        .eq('user_id', userId)
        .eq('date', dateIso)
        .maybeSingle();

      if (error) {
        if (error.code === 'PGRST116') return null;
        throw error;
      }

      return data ? this.convertDbToAttendance(data, schedule) : null;
    } catch (error) {
      console.error('Error getting attendance for date:', error);
      return null;
    }
  }

  async getAllAttendanceForDate(date: string): Promise<{ [userId: string]: AttendanceRecord }> {
    try {
      console.log(`🔍 Fetching all attendance for date: ${date}`);

      // Directly construct YYYY-MM-DD from DD-MM-YYYY without timezone conversion
      const parts = date.split('-');
      if (parts.length !== 3) return {};
      const [day, month, year] = parts;
      const dateIso = `${year}-${month}-${day}`;

      const { data, error } = await supabase
        .from(this.ATTENDANCE_TABLE)
        .select(`
          *,
          employees:user_id (name, email, employee_id, department, role),
          attendance_breaks (*)
        `)
        .eq('date', dateIso)
        .limit(500);

      if (error) throw error;

      if (!data || data.length === 0) {
        return {};
      }

      // PHASE 1: Multi-role schedule resolution
      // Collect all distinct roles present in this batch
      const roleSet = new Set<string>();
      data.forEach(record => {
        const emp = record.employees as Record<string, unknown> | undefined;
        if (emp?.role) roleSet.add(emp.role as string);
      });

      // Fetch schedules for all roles (in parallel)
      const schedulePromises = Array.from(roleSet).map(role =>
        configService.getScheduleByRole(role).then(sched => ({
          role,
          schedule: sched || { ...DEFAULT_ROLE_SCHEDULE, role }
        }))
      );
      const scheduleMapArray = await Promise.all(schedulePromises);
      const scheduleMap = new Map<string, RoleSchedule>(
        scheduleMapArray.map(({ role, schedule }) => [role, schedule])
      );

      // Convert each record using its employee's schedule
      const attendanceByUser: { [userId: string]: AttendanceRecord } = {};
      data.forEach(record => {
        const emp = record.employees as Record<string, unknown> | undefined;
        const userRole = (emp?.role as string) || 'employee';
        const schedule = scheduleMap.get(userRole)!; // guaranteed to exist

        attendanceByUser[record.user_id] = this.convertDbToAttendance(record, schedule);
      });

      console.log(`📊 Found attendance for ${Object.keys(attendanceByUser).length} users on ${date}`);
      return attendanceByUser;
    } catch (error) {
      console.error(`❌ Error fetching attendance for date ${date}:`, error);
      return {};
    }
  }

  /**
   * Batch-fetch all attendance records for every employee in a date range.
   * Replaces the N+1 pattern of calling getAllAttendanceForDate() once per day.
   *
   * @param startDateStr - Start date in DD-MM-YYYY format
   * @param endDateStr   - End date   in DD-MM-YYYY format
   * @returns Map of userId -> (date-string -> AttendanceRecord)
   */
  async getAllAttendanceForMonth(
    startDateStr: string,
    endDateStr: string
  ): Promise<{ [userId: string]: { [dateStr: string]: AttendanceRecord } }> {
    // Convert DD-MM-YYYY → YYYY-MM-DD for Supabase query
    const toIso = (d: string) => {
      const parts = d.split('-');
      if (parts.length !== 3) return d;
      const [day, month, year] = parts;
      return `${year}-${month}-${day}`;
    };

    const startIso = toIso(startDateStr);
    const endIso = toIso(endDateStr);

    try {
      const { data, error } = await supabase
        .from(this.ATTENDANCE_TABLE)
        .select(`
          id, 
          user_id, 
          date, 
          login_time, 
          logout_time, 
          lunch_start, 
          lunch_end, 
          worked_hours, 
          is_late, 
          late_reason, 
          is_late_from_lunch, 
          lunch_late_reason, 
          created_at, 
          updated_at, 
          employees:user_id(name, employee_id, department, role), 
          attendance_breaks(id, start, end)
        `)
        .gte('date', startIso)
        .lte('date', endIso)
        .order('date', { ascending: true })
        .limit(5000);

      if (error) throw error;

      if (!data || data.length === 0) {
        return {};
      }

      // ── Role → schedule (multi-role in one batch) ──────────────────────
      const roleSet = new Set<string>();
      data.forEach((record: Record<string, unknown>) => {
        const emp = (record.employees as Record<string, unknown> | undefined);
        if (emp?.role) roleSet.add(emp.role as string);
      });

      const schedulePromises = Array.from(roleSet).map(role =>
        configService.getScheduleByRole(role).then(sched => ({ role, sched }))
      );
      const scheduleArray = await Promise.all(schedulePromises);
      const scheduleMap = new Map<string, RoleSchedule>(
        scheduleArray.map(({ role, sched }) => [role, sched || { ...DEFAULT_ROLE_SCHEDULE, role }])
      );

      // ── Build user → { date → record } index ───────────────────────────
      const byUserDate: { [userId: string]: { [dateStr: string]: AttendanceRecord } } = {};

      for (const supaRow of data as Record<string, unknown>[]) {
        const emp = supaRow.employees as Record<string, unknown> | undefined;
        const userId = supaRow.user_id as string;
        const role = (emp?.role as string) || 'employee';
        const schedule = scheduleMap.get(role)!;

        const record = this.convertDbToAttendance(supaRow, schedule) as AttendanceRecord;
        // Supabase returns YYYY-MM-DD — reorder to DD-MM-YYYY so the key matches
        // the format that OverallAttendancePage generates from eachDayOfInterval
        const iso = record.date;            // "2024-05-16"
        const [yyyy, mm, dd] = iso.split('-');
        const dateStr = `${dd}-${mm}-${yyyy}`;

        if (!byUserDate[userId]) byUserDate[userId] = {};
        byUserDate[userId][dateStr] = record;
      }

      console.log(`📊 getAllAttendanceForMonth: fetched ${Object.keys(byUserDate).length} users`);
      return byUserDate;
    } catch (error) {
      console.error(`❌ getAllAttendanceForMonth error (${startDateStr} → ${endDateStr}):`, error);
      return {};
    }
  }

  async getAttendanceRecords(employeeId: string): Promise<AttendanceRecord[]> {
    try {
      console.log(`🔍 Fetching attendance records for employee: ${employeeId}`);

      // Fetch employee role and schedule
      const { data: employeeData, error: empError } = await supabase
        .from(this.USERS_TABLE)
        .select('role')
        .eq('id', employeeId)
        .single();

      if (empError) throw empError;

      const role = employeeData?.role as string || 'employee';
      let schedule = await configService.getScheduleByRole(role);
      if (!schedule) {
        console.warn(`No schedule found for role "${role}", using defaults`);
        schedule = { ...DEFAULT_ROLE_SCHEDULE, role };
      }

      const { data, error } = await supabase
        .from(this.ATTENDANCE_TABLE)
        .select(`
          *,
          employees:user_id (name, email, employee_id, department, role),
          attendance_breaks (*)
        `)
        .eq('user_id', employeeId)
        .order('date', { ascending: false })
        .limit(500);

      if (error) throw error;

      if (!data || data.length === 0) {
        return [];
      }

      const records = data.map(record => this.convertDbToAttendance(record, schedule));

      console.log(`📊 Found ${records.length} records for ${employeeId}`);
      return records;
    } catch (error) {
      console.error(`❌ Error fetching attendance for ${employeeId}:`, error);
      return [];
    }
  }

  private isLateArrival(clockInTime: Date | null, schedule: RoleSchedule): boolean {
    if (!clockInTime) return false;
    return isLateArrival(schedule, clockInTime);
  }

  private determineStatus(
    clockInTime: Date | null,
    clockOutTime: Date | null,
    schedule: RoleSchedule,
    dbIsLate: boolean = false
  ): 'present' | 'absent' | 'late' | 'partial' | 'half-day' {
    if (!clockInTime) return 'absent';

    // Respect the DB's authoritative is_late flag first (the source of truth)
    if (dbIsLate) return 'late';

    // Early departure before scheduled work end → partial day
    if (clockOutTime && this.isEarlyDeparture(clockOutTime, schedule)) {
      return 'partial';
    }

    // Fall back to wall-clock evaluation only when the DB flag is absent/unknown
    return this.isLateArrival(clockInTime, schedule) ? 'late' : 'present';
  }

  /**
   * Start a break ("Take Break")
   */
  async takeBreak(userId: string, breakType: string = 'short_break', reason?: string): Promise<AttendanceRecord> {
    try {
      const todayIso = getOfficeTodayIso();
      const now = new Date();

      // Get employee role and schedule
      const { data: employeeData } = await supabase
        .from(this.USERS_TABLE)
        .select('role')
        .eq('id', userId)
        .single();
      const role = employeeData?.role as string || 'employee';
      let schedule = await configService.getScheduleByRole(role);
      if (!schedule) {
        schedule = { ...DEFAULT_ROLE_SCHEDULE, role };
      }

      // Try RPC take_break first
      try {
        const { data: rpcData, error: rpcError } = await supabase.rpc('take_break', {
          p_user_id: userId,
          p_break_type: breakType,
          p_reason: reason || null
        });

        if (!rpcError && rpcData?.attendance_record_id) {
          const { data: updatedRecord, error: fetchError } = await supabase
            .from(this.ATTENDANCE_TABLE)
            .select(`
              *,
              employees:user_id (name, email, employee_id, department, role),
              attendance_breaks (*)
            `)
            .eq('id', rpcData.attendance_record_id)
            .single();

          if (!fetchError && updatedRecord) {
            return this.convertDbToAttendance(updatedRecord, schedule);
          }
        }
      } catch (e) {
        console.warn('RPC take_break failed or not found, falling back to direct table update:', e);
      }

      // Direct fallback
      const { data: attendanceRecord, error: recordError } = await supabase
        .from(this.ATTENDANCE_TABLE)
        .select('id, login_time, logout_time')
        .eq('user_id', userId)
        .eq('date', todayIso)
        .maybeSingle();

      if (recordError || !attendanceRecord?.login_time) {
        throw new Error('Please clock in first');
      }

      if (attendanceRecord.logout_time) {
        throw new Error('Already clocked out for today');
      }

      // Check for active break
      const { count: activeBreaks } = await supabase
        .from(this.BREAKS_TABLE)
        .select('id', { count: 'exact', head: true })
        .eq('attendance_record_id', attendanceRecord.id)
        .is('end', null);

      if (activeBreaks && activeBreaks > 0) {
        throw new Error('A break is already in progress');
      }

      // Start break with direct insert
      const { error: insertError } = await supabase
        .from(this.BREAKS_TABLE)
        .insert({
          attendance_record_id: attendanceRecord.id,
          start: now.toISOString(),
          break_type: breakType,
          reason: reason || null
        })
        .select()
        .single();

      if (insertError) throw insertError;

      // Get updated record
      const { data: updatedRecord, error: fetchError } = await supabase
        .from(this.ATTENDANCE_TABLE)
        .select(`
          *,
          employees:user_id (name, email, employee_id, department, role),
          attendance_breaks (*)
        `)
        .eq('id', attendanceRecord.id)
        .single();

      if (fetchError || !updatedRecord) {
        throw new Error('Failed to fetch updated attendance record after starting break');
      }

      return this.convertDbToAttendance(updatedRecord, schedule);
    } catch (error) {
      console.error('Error starting break:', error);
      throw error;
    }
  }

  // Alias for backward compatibility
  async startBreak(userId: string): Promise<AttendanceRecord> {
    return this.takeBreak(userId, 'short_break');
  }

  /**
   * Resume work from break ("Resume Work")
   */
  async resumeWork(userId: string): Promise<AttendanceRecord> {
    try {
      const todayIso = getOfficeTodayIso();

      // Get employee role and schedule
      const { data: employeeData } = await supabase
        .from(this.USERS_TABLE)
        .select('role')
        .eq('id', userId)
        .single();
      const role = employeeData?.role as string || 'employee';
      let schedule = await configService.getScheduleByRole(role);
      if (!schedule) {
        schedule = { ...DEFAULT_ROLE_SCHEDULE, role };
      }

      // Try RPC resume_work first
      try {
        const { data: rpcData, error: rpcError } = await supabase.rpc('resume_work', {
          p_user_id: userId
        });

        if (!rpcError && rpcData?.attendance_record_id) {
          const { data: updatedRecord, error: fetchError } = await supabase
            .from(this.ATTENDANCE_TABLE)
            .select(`
              *,
              employees:user_id (name, email, employee_id, department, role),
              attendance_breaks (*)
            `)
            .eq('id', rpcData.attendance_record_id)
            .single();

          if (!fetchError && updatedRecord) {
            return this.convertDbToAttendance(updatedRecord, schedule);
          }
        }
      } catch (e) {
        console.warn('RPC resume_work failed or not found, falling back to direct table update:', e);
      }

      // Direct fallback
      const { data: attendanceRecord } = await supabase
        .from(this.ATTENDANCE_TABLE)
        .select('id, break_seconds')
        .eq('user_id', userId)
        .eq('date', todayIso)
        .maybeSingle();

      if (!attendanceRecord) throw new Error('No attendance record found for today');

      // Find active break
      const { data: activeBreak } = await supabase
        .from(this.BREAKS_TABLE)
        .select('id, start')
        .eq('attendance_record_id', attendanceRecord.id)
        .is('end', null)
        .order('start', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (!activeBreak) {
        throw new Error('No active break found to end.');
      }

      const now = new Date();
      const { error: updateError } = await supabase
        .from(this.BREAKS_TABLE)
        .update({ end: now.toISOString() })
        .eq('id', activeBreak.id);

      if (updateError) throw updateError;

      // Update break_seconds on attendance_records row
      if (activeBreak.start) {
        const breakDurationSecs = Math.max(0, Math.round((now.getTime() - new Date(activeBreak.start).getTime()) / 1000));
        await supabase
          .from(this.ATTENDANCE_TABLE)
          .update({
            break_seconds: (attendanceRecord.break_seconds || 0) + breakDurationSecs,
            updated_at: now.toISOString()
          })
          .eq('id', attendanceRecord.id);
      }

      // Get updated record
      const { data: updatedRecord, error: fetchError } = await supabase
        .from(this.ATTENDANCE_TABLE)
        .select(`
          *,
          employees:user_id (name, email, employee_id, department, role),
          attendance_breaks (*)
        `)
        .eq('id', attendanceRecord.id)
        .maybeSingle();

      if (fetchError || !updatedRecord) throw new Error('Failed to fetch updated attendance record');

      return this.convertDbToAttendance(updatedRecord, schedule);
    } catch (error) {
      console.error('Error resuming work from break:', error);
      throw error;
    }
  }

  // Alias for backward compatibility
  async endBreak(userId: string): Promise<AttendanceRecord> {
    return this.resumeWork(userId);
  }

  /**
   * Log software/tool usage during work hours
   */
  async logSoftwareUsage(params: {
    attendanceId: string;
    softwareName: string;
    windowTitle?: string;
    category?: 'development' | 'communication' | 'browsing' | 'productivity' | 'design' | 'office' | 'general' | 'other';
    durationSeconds?: number;
    activityScore?: number;
  }): Promise<void> {
    try {
      const { error } = await supabase.rpc('log_software_usage', {
        p_attendance_id: params.attendanceId,
        p_software_name: params.softwareName,
        p_window_title: params.windowTitle || null,
        p_category: params.category || 'general',
        p_duration_seconds: params.durationSeconds ?? 60,
        p_activity_score: params.activityScore ?? 100.0
      });

      if (error) {
        // Direct table fallback
        const { data: record } = await supabase
          .from(this.ATTENDANCE_TABLE)
          .select('user_id')
          .eq('id', params.attendanceId)
          .maybeSingle();

        if (record?.user_id) {
          await supabase.from('software_usage_logs').insert({
            attendance_record_id: params.attendanceId,
            user_id: record.user_id,
            software_name: params.softwareName,
            window_title: params.windowTitle || null,
            category: params.category || 'general',
            duration_seconds: params.durationSeconds ?? 60,
            activity_percentage: params.activityScore ?? 100.0,
            recorded_at: new Date().toISOString()
          });
        }
      }
    } catch (err) {
      console.error('Failed to log software usage:', err);
    }
  }

  /**
   * Get raw software usage logs for an attendance session
   */
  async getSoftwareUsageLogs(attendanceRecordId: string): Promise<SoftwareUsageLog[]> {
    try {
      const { data, error } = await supabase
        .from('software_usage_logs')
        .select('*')
        .eq('attendance_record_id', attendanceRecordId)
        .order('recorded_at', { ascending: false });

      if (error || !data) return [];
      return data.map((d: Record<string, unknown>) => ({
        id: d.id as string,
        attendanceRecordId: d.attendance_record_id as string,
        userId: d.user_id as string,
        softwareName: d.software_name as string,
        windowTitle: (d.window_title as string) || undefined,
        category: (d.category as SoftwareUsageLog['category']) || 'general',
        durationSeconds: (d.duration_seconds as number) || 0,
        activityPercentage: Number(d.activity_percentage) || 100,
        recordedAt: new Date(d.recorded_at as string),
        createdAt: d.created_at ? new Date(d.created_at as string) : undefined
      }));
    } catch (err) {
      console.error('Error getting software usage logs:', err);
      return [];
    }
  }

  /**
   * Get software usage summary for an attendance record
   */
  async getSoftwareUsageSummary(attendanceRecordId: string): Promise<SoftwareUsageSummary[]> {
    try {
      const { data, error } = await supabase.rpc('get_software_usage_summary', {
        p_attendance_id: attendanceRecordId
      });

      if (!error && Array.isArray(data)) {
        return data.map((item: Record<string, unknown>) => ({
          softwareName: (item.software_name as string) || 'Unknown',
          category: (item.category as string) || 'general',
          totalSeconds: Number(item.total_seconds ?? item.total_duration_seconds) || 0,
          avgActivityPercentage: Number(item.avg_activity_percentage) || 100,
          logCount: Number(item.log_count) || 1
        }));
      }

      // Fallback: client-side aggregation from software_usage_logs
      const { data: logs, error: logsError } = await supabase
        .from('software_usage_logs')
        .select('*')
        .eq('attendance_record_id', attendanceRecordId);

      if (logsError || !logs) return [];

      const map = new Map<string, { softwareName: string; category: string; totalSeconds: number; scoreSum: number; count: number }>();
      for (const log of logs) {
        const key = `${log.software_name}-${log.category}`;
        const existing = map.get(key) || {
          softwareName: log.software_name,
          category: log.category,
          totalSeconds: 0,
          scoreSum: 0,
          count: 0
        };
        existing.totalSeconds += log.duration_seconds || 0;
        existing.scoreSum += Number(log.activity_percentage) || 0;
        existing.count += 1;
        map.set(key, existing);
      }

      return Array.from(map.values()).map(item => ({
        softwareName: item.softwareName,
        category: item.category,
        totalSeconds: item.totalSeconds,
        avgActivityPercentage: item.count > 0 ? Math.round((item.scoreSum / item.count) * 100) / 100 : 100,
        logCount: item.count
      })).sort((a, b) => b.totalSeconds - a.totalSeconds);
    } catch (err) {
      console.error('Error getting software usage summary:', err);
      return [];
    }
  }

  async startLunchBreak(userId: string): Promise<AttendanceRecord> {
    try {
      const todayIso = getOfficeTodayIso();

      // Get employee role and schedule
      const { data: employeeData } = await supabase
        .from(this.USERS_TABLE)
        .select('role')
        .eq('id', userId)
        .single();
      const role = employeeData?.role as string || 'employee';
      let schedule = await configService.getScheduleByRole(role);
      if (!schedule) {
        schedule = { ...DEFAULT_ROLE_SCHEDULE, role };
      }

      const { data: attendanceRecord, error: recordError } = await supabase
        .from(this.ATTENDANCE_TABLE)
        .select('id, login_time, lunch_start')
        .eq('user_id', userId)
        .eq('date', todayIso)
        .maybeSingle();

      if (recordError || !attendanceRecord?.login_time) {
        throw new Error('Please clock in first');
      }

      if (attendanceRecord.lunch_start) {
        throw new Error('Lunch break already started');
      }

      const now = new Date();
      const { error: updateError } = await supabase.rpc('update_attendance_record', {
        p_record_id: attendanceRecord.id,
        p_lunch_start: now.toISOString()
      }).single();
      if (updateError) throw updateError;

      // Get updated record (include role in join)
      const { data: updatedRecord } = await supabase
        .from(this.ATTENDANCE_TABLE)
        .select(`
          *,
          employees:user_id (name, email, employee_id, department, role),
          attendance_breaks (*)
        `)
        .eq('id', attendanceRecord.id)
        .single();

      return this.convertDbToAttendance(updatedRecord, schedule);
    } catch (error) {
      console.error('Error starting lunch break:', error);
      throw error;
    }
  }

  async endLunchBreak(userId: string, isLate?: boolean): Promise<AttendanceRecord> {
    try {
      const todayIso = getOfficeTodayIso();

      // Get employee role and schedule
      const { data: employeeData } = await supabase
        .from(this.USERS_TABLE)
        .select('role')
        .eq('id', userId)
        .single();
      const role = employeeData?.role as string || 'employee';
      let schedule = await configService.getScheduleByRole(role);
      if (!schedule) {
        schedule = { ...DEFAULT_ROLE_SCHEDULE, role };
      }

      const { data: attendanceRecord, error: recordError } = await supabase
        .from(this.ATTENDANCE_TABLE)
        .select('id, lunch_start, lunch_end')
        .eq('user_id', userId)
        .eq('date', todayIso)
        .maybeSingle();

      if (recordError || !attendanceRecord) throw new Error('No attendance record found for today');
      if (!attendanceRecord.lunch_start) throw new Error('Lunch break not started');
      if (attendanceRecord.lunch_end) throw new Error('Lunch break already ended');

      const now = new Date();
      const updateParams: UpdateAttendanceRecordParams = {
        p_record_id: attendanceRecord.id,
        p_lunch_end: now.toISOString()
      };
      if (isLate) {
        updateParams.p_is_late_from_lunch = true;
        updateParams.p_lunch_late_reason = 'Late return from lunch break';
      }

      const { error: updateError } = await supabase.rpc('update_attendance_record', updateParams).single();
      if (updateError) throw updateError;

      // Get updated record (include role in join)
      const { data: updatedRecord } = await supabase
        .from(this.ATTENDANCE_TABLE)
        .select(`
          *,
          employees:user_id (name, email, employee_id, department, role),
          attendance_breaks (*)
        `)
        .eq('id', attendanceRecord.id)
        .single();

      return this.convertDbToAttendance(updatedRecord, schedule);
    } catch (error) {
      console.error('Error ending lunch break:', error);
      throw error;
    }
  }

  isLunchTime(schedule: RoleSchedule): boolean {
    const now = getOfficeNow();
    const lunchStart = getLunchStartTime(schedule, now);
    const lunchEnd = getLunchEndTime(schedule, now);

    return now.getTime() >= lunchStart.getTime() && now.getTime() <= lunchEnd.getTime();
  }

  isLateFromLunch(schedule: RoleSchedule): boolean {
    const now = getOfficeNow();
    const lunchEnd = getLunchEndTime(schedule, now);

    return now.getTime() > lunchEnd.getTime();
  }

  hasCompletedMinimumHours(clockInTime: Date, clockOutTime: Date, schedule: RoleSchedule): boolean {
    const hoursWorked = (clockOutTime.getTime() - clockInTime.getTime()) / (1000 * 60 * 60);
    return hoursWorked >= schedule.standard_work_hours;
  }

  isEarlyDeparture(clockOutTime: Date, schedule: RoleSchedule): boolean {
    const workEnd = getWorkEndTime(schedule, clockOutTime);
    return clockOutTime.getTime() < workEnd.getTime();
  }
}

export const globalAttendanceService = new GlobalAttendanceService();
