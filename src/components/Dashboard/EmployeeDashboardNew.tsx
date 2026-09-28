import { useState, useEffect, useCallback, memo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Clock, Calendar, TrendingUp, CalendarPlus, Monitor, Plus, RefreshCw } from 'lucide-react';
import { useAuth } from '../../hooks/useAuth';
import { globalAttendanceService } from '../../services/globalAttendanceService';
import { meetingService } from '../../services/meetingService';
import { SoftwareUsageSummary } from '../../types';
import toast from 'react-hot-toast';

import { format } from 'date-fns';
import { getOfficeNow, formatOffice } from '../../utils/timezoneUtils';
import { zonedTimeToUtc } from 'date-fns-tz';
import { OFFICE_TIMEZONE } from '../../utils/timezoneUtils';
import ClockInOutNew from '../Employee/ClockInOutNew';
import WorkingHoursInfo from '../common/WorkingHoursInfo';
import { formatDuration } from '../../utils/formatDuration';
import LeaveRequestModal from '../common/LeaveRequestModal';

const LiveClock = memo(() => {
  const [currentTime, setCurrentTime] = useState(new Date());

  useEffect(() => {
    const timer = setInterval(() => setCurrentTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  return <span>{format(currentTime, 'EEEE, MMMM d, yyyy')}</span>;
});
LiveClock.displayName = 'LiveClock';

const EmployeeDashboardNew: React.FC = () => {
  const { employee } = useAuth();
  const queryClient = useQueryClient();
  const [isLeaveModalOpen, setIsLeaveModalOpen] = useState(false);

  // ✅ TanStack Query: Today's attendance record
  const { data: todayRecord, isLoading: todayLoading } = useQuery({
    queryKey: ['employeeAttendanceToday', employee?.id],
    queryFn: async () => {
      if (!employee) return null;
      return globalAttendanceService.getTodayAttendance(employee.id);
    },
    enabled: !!employee,
  });

  // ✅ Software Usage Modal & Tracking State
  const [showLogSoftwareModal, setShowLogSoftwareModal] = useState(false);
  const [softwareForm, setSoftwareForm] = useState<{
    name: string;
    category: 'development' | 'communication' | 'browsing' | 'productivity' | 'design' | 'office' | 'general' | 'other';
    minutes: number;
  }>({
    name: '',
    category: 'development',
    minutes: 30,
  });
  const [submittingSoftware, setSubmittingSoftware] = useState(false);

  // ✅ TanStack Query: Software & Tools Usage Summary for Today
  const { data: softwareSummary = [], isLoading: softwareLoading, refetch: refetchSoftware, isRefetching: isSoftwareRefetching } = useQuery<SoftwareUsageSummary[]>({
    queryKey: ['softwareUsageSummary', todayRecord?.id],
    queryFn: async () => {
      if (!todayRecord?.id) return [];
      return globalAttendanceService.getSoftwareUsageSummary(todayRecord.id);
    },
    enabled: !!todayRecord?.id,
    refetchInterval: 30000, // Background poll every 30s so desktop agent logs appear automatically
  });

  const handleLogSoftware = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!todayRecord?.id || !softwareForm.name.trim()) return;

    setSubmittingSoftware(true);
    try {
      await globalAttendanceService.logSoftwareUsage({
        attendanceId: todayRecord.id,
        softwareName: softwareForm.name.trim(),
        category: softwareForm.category,
        durationSeconds: Math.max(1, softwareForm.minutes) * 60,
        activityScore: 100,
      });
      toast.success(`Logged ${softwareForm.name.trim()} (${softwareForm.minutes}m)`);
      setShowLogSoftwareModal(false);
      setSoftwareForm({ name: '', category: 'development', minutes: 30 });
      queryClient.invalidateQueries({ queryKey: ['softwareUsageSummary', todayRecord.id] });
      queryClient.invalidateQueries({ queryKey: ['employeeAttendanceToday', employee?.id] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to log software');
    } finally {
      setSubmittingSoftware(false);
    }
  };

  const getCategoryBadgeClass = (category: string) => {
    switch (category.toLowerCase()) {
      case 'development':
        return 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800/60';
      case 'browsing':
        return 'bg-blue-50 text-blue-700 dark:bg-blue-950/50 dark:text-blue-300 border border-blue-200 dark:border-blue-800/60';
      case 'communication':
        return 'bg-purple-50 text-purple-700 dark:bg-purple-950/50 dark:text-purple-300 border border-purple-200 dark:border-purple-800/60';
      case 'productivity':
      case 'office':
        return 'bg-amber-50 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300 border border-amber-200 dark:border-amber-800/60';
      case 'design':
        return 'bg-pink-50 text-pink-700 dark:bg-pink-950/50 dark:text-pink-300 border border-pink-200 dark:border-pink-800/60';
      default:
        return 'bg-gray-100 text-gray-700 dark:bg-neutral-800 dark:text-neutral-300 border border-gray-200 dark:border-neutral-700';
    }
  };

  const totalSoftwareSeconds = softwareSummary.reduce((acc, item) => acc + item.totalSeconds, 0);
  const totalActiveSeconds = Math.max(todayRecord?.activeSeconds || 0, totalSoftwareSeconds);
  const avgOverallActivity = softwareSummary.length > 0
    ? Math.round(softwareSummary.reduce((acc, item) => acc + item.avgActivityPercentage, 0) / softwareSummary.length)
    : 100;

  // ✅ TanStack Query: Weekly attendance statistics
  const { data: weeklyStats, isLoading: weeklyLoading } = useQuery({
    queryKey: ['employeeWeeklyStats', employee?.id],
    queryFn: async () => {
      if (!employee) return { totalHours: 0, daysPresent: 0, averageHours: 0, totalBreaks: 0 };

      // Compute week boundaries in office timezone
      const officeNow = getOfficeNow();
      const officeYear = parseInt(formatOffice(officeNow, 'yyyy'), 10);
      const officeMonth = parseInt(formatOffice(officeNow, 'MM'), 10) - 1; // 0-indexed
      const officeDay = parseInt(formatOffice(officeNow, 'dd'), 10);
      const officeDayOfWeek = parseInt(formatOffice(officeNow, 'u'), 10); // 1=Mon, 7=Sun

      const mondayDay = officeDay - (officeDayOfWeek - 1);
      const sundayDay = officeDay + (7 - officeDayOfWeek);

      const weekStartString = `${officeYear}-${String(officeMonth + 1).padStart(2, '0')}-${String(mondayDay).padStart(2, '0')} 00:00:00`;
      const weekStart = zonedTimeToUtc(weekStartString, OFFICE_TIMEZONE);

      const weekEndString = `${officeYear}-${String(officeMonth + 1).padStart(2, '0')}-${String(sundayDay).padStart(2, '0')} 23:59:59.999`;
      const weekEnd = zonedTimeToUtc(weekEndString, OFFICE_TIMEZONE);
      const weeklyRecords = await globalAttendanceService.getAttendanceRange(
        employee.id,
        weekStart,
        weekEnd
      );

      // 🕵️‍♂️ TRACE: Weekly Records Fetched
      console.log('🕵️‍♂️ TRACE: Weekly Records Fetched:', {
        count: weeklyRecords.length,
        records: weeklyRecords.map(r => ({
          date: r.date,
          hoursWorked: r.hoursWorked,
          totalHours: r.totalHours,
          clockIn: r.clockIn,
          clockOut: r.clockOut
        }))
      });

      const rawTotalHours = weeklyRecords.reduce((sum, record) => {
        // Guard against null/string DB values and the upstream worked_hours=0 bug:
        // Prefer the stored value when it looks valid (>0); otherwise fall back
        // to clockOut - clockIn (both already Date objects from convertDbToAttendance)
        const rawVal = record.hoursWorked;
        const stored = (rawVal != null && rawVal !== 0 && typeof rawVal !== 'string') ? Number(rawVal)
          : (typeof rawVal === 'string' && rawVal !== '' && !Number.isNaN(Number(rawVal)))
            ? Number(rawVal) : null;
        let hours: number;
        if (stored !== null && !Number.isNaN(stored)) {
          hours = stored;
        } else if (record.clockIn && record.clockOut) {
          const ms = record.clockOut.getTime() - record.clockIn.getTime();
          hours = ms > 0 ? ms / (1000 * 60 * 60) : 0;
        } else {
          hours = 0;
        }
        return sum + hours;
      }, 0);
      // Round to 2 decimal places to preserve micro-shifts
      const totalHours = Math.round(rawTotalHours * 100) / 100;
      const daysPresent = weeklyRecords.filter(record => record.clockIn).length;
      const totalBreaks = weeklyRecords.reduce((sum, record) => sum + record.breaks.length, 0);

      const calculatedStats = {
        totalHours,
        daysPresent,
        averageHours: daysPresent > 0 ? Math.round((rawTotalHours / daysPresent) * 100) / 100 : 0,
        totalBreaks
      };

      // 🕵️‍♂️ TRACE: Calculated Weekly Stats
      console.log('🕵️‍♂️ TRACE: Calculated Weekly Stats:', calculatedStats);

      return calculatedStats;
    },
    enabled: !!employee,
  });

  // ✅ TanStack Query: Upcoming meetings (use employee-specific endpoint)
  const { data: meetings = [], isLoading: meetingsLoading, refetch: refetchMeetings } = useQuery({
    queryKey: ['employeeMeetings', employee?.id],
    queryFn: async () => {
      if (!employee) return [];

      // Fetch meetings assigned to this employee only (server enforces authorization)
      const allMeetings = await meetingService.getMeetingsForEmployee(employee.id);

      // Filter for today and future meetings
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      const upcomingMeetings = allMeetings.filter(meeting => {
        const meetingDate = new Date(meeting.date);
        return !isNaN(meetingDate.getTime()) && meetingDate >= today;
      });

      // Sort by date and take next 5 meetings
      upcomingMeetings.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
      return upcomingMeetings.slice(0, 5);
    },
    enabled: !!employee,
  });

  // Combined loading state (derived from TanStack Query — no manual useState)
  const loading = todayLoading || weeklyLoading || meetingsLoading;

  // Helper function to get display name from employee data
  const getEmployeeName = useCallback(() => {
    if (!employee) return 'User';

    // Safely get employee name with fallbacks
    return employee.name ||
      employee.Name || // Alternative field name
      employee.email?.split('@')[0] ||
      'User';
  }, [employee]);

  // Define a type for Employee with possible fields
  type EmployeeType = {
    id: string;
    name?: string;
    Name?: string;
    email?: string;
    Designation?: string;
    designation?: string;
    position?: string;
    role?: string;
    department?: string;
  };

  // Helper function to get employee designation/role
  const getEmployeeDesignation = useCallback(() => {
    if (!employee) return 'Employee';

    // Type assertion for employee
    const emp = employee as EmployeeType;

    // Safely get employee designation with fallbacks (check both cases)
    const designation = emp.Designation ||
      emp.designation ||
      emp.position ||
      emp.role ||
      'Employee';

    return designation;
  }, [employee]);

  // ────────────────────────────────────────────────────────
  // GHOST CODE DELETED (Defect 9)
  //
  // A massive useEffect block referencing setLoading, setError,
  // loadTodayRecord, loadWeeklyStats, loadMeetings was here.
  // None of those functions existed in scope — they were
  // remnants of the pre-TanStack migration.  The useEffect
  // would throw ReferenceError at runtime.
  //
  // All data fetching is now handled exclusively by the three
  // useQuery hooks above.  Refresh intervals are managed via
  // TanStack Query's refetchInterval option if needed.
  // ────────────────────────────────────────────────────────

  // Loading state
  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-96">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto"></div>
          <p className="mt-4 text-gray-600 dark:text-neutral-400">Loading dashboard...</p>
        </div>
      </div>
    );
  }

  // No employee data
  if (!employee) {
    return (
      <div className="flex items-center justify-center min-h-96">
        <div className="text-center">
          <div className="text-gray-400 text-6xl mb-4">👤</div>
          <h2 className="text-xl font-semibold text-gray-900 dark:text-white mb-2">No User Data</h2>
          <p className="text-gray-600 dark:text-neutral-400">Please log in to view your dashboard.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Working Hours Information */}
      <WorkingHoursInfo />

      {/* Request Leave Button */}
      <button
        onClick={() => setIsLeaveModalOpen(true)}
        className="w-full flex items-center px-4 py-3 text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-white/[0.04] rounded-xl border border-slate-200 dark:border-white/[0.08] font-medium transition-all duration-200"
      >
        <CalendarPlus className="h-4 w-4 mr-3 text-slate-500 dark:text-slate-400" />
        Request Leave
      </button>

      {/* Welcome Header */}
      <div className="bg-[#1C2B3A] dark:bg-white/[0.02] dark:backdrop-blur-xl text-white rounded-2xl p-6 shadow-sm border border-transparent dark:border-white/[0.05]">
        <div className="flex justify-between items-start">
          <div>
            <h1 className="text-white font-semibold text-xl mb-2 tracking-tight">
              Welcome back, {getEmployeeName()}!
            </h1>
            <div className="flex flex-wrap items-center gap-2 mt-2 text-slate-300 dark:text-slate-400 text-sm">
              <span className="text-white"><LiveClock /></span>
              <span className="opacity-40">•</span>
              <span className="bg-white/10 dark:bg-white/[0.05] text-white rounded-xl px-3 py-1 text-sm border border-transparent dark:border-white/[0.05]">{employee?.role || 'Employee'}</span>
              <span className="opacity-40">•</span>
              <span className="bg-white/10 dark:bg-white/[0.05] text-white rounded-xl px-3 py-1 text-sm border border-transparent dark:border-white/[0.05]">{getEmployeeDesignation()}</span>
              {employee?.department && (
                <>
                  <span className="opacity-40">•</span>
                  <span className="bg-white/10 dark:bg-white/[0.05] text-white rounded-xl px-3 py-1 text-sm border border-transparent dark:border-white/[0.05]">{employee.department}</span>
                </>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Quick Stats — nullish coalescing guards against undefined weeklyStats */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        <div className="bg-white dark:bg-neutral-900 rounded-2xl border border-gray-100 dark:border-neutral-800 shadow-sm p-5">
          <div className="flex items-center">
            <div className="bg-canvas dark:bg-neutral-800 p-2 rounded-xl">
              <Clock className="h-6 w-6 text-gray-700 dark:text-brand" />
            </div>
            <div className="ml-4">
              <p className="text-sm text-gray-500 dark:text-neutral-400 dark:text-neutral-300">This Week</p>
              <p className="text-2xl font-bold text-gray-900 dark:text-white">{formatDuration(weeklyStats?.totalHours ?? 0)}</p>
            </div>
          </div>
        </div>

        <div className="bg-white dark:bg-neutral-900 rounded-2xl border border-gray-100 dark:border-neutral-800 shadow-sm p-5">
          <div className="flex items-center">
            <div className="bg-canvas dark:bg-neutral-800 p-2 rounded-xl">
              <Calendar className="h-6 w-6 text-gray-700 dark:text-brand" />
            </div>
            <div className="ml-4">
              <p className="text-sm text-gray-500 dark:text-neutral-400 dark:text-neutral-300">Days Present</p>
              <p className="text-2xl font-bold text-gray-900 dark:text-white">{weeklyStats?.daysPresent ?? 0}</p>
            </div>
          </div>
        </div>

        <div className="bg-white dark:bg-neutral-900 rounded-2xl border border-gray-100 dark:border-neutral-800 shadow-sm p-5">
          <div className="flex items-center">
            <div className="bg-canvas dark:bg-neutral-800 p-2 rounded-xl">
              <TrendingUp className="h-6 w-6 text-gray-700 dark:text-brand" />
            </div>
            <div className="ml-4">
              <p className="text-sm text-gray-500 dark:text-neutral-400 dark:text-neutral-300">Daily Average</p>
              <p className="text-2xl font-bold text-gray-900 dark:text-white">{formatDuration(weeklyStats?.averageHours ?? 0)}</p>
            </div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Clock In/Out Section */}
        <div className="space-y-6">
          <ClockInOutNew
            todayRecord={todayRecord}
            onAttendanceChange={() => {
              queryClient.invalidateQueries({ queryKey: ['employeeAttendanceToday', employee?.id] });
              queryClient.invalidateQueries({ queryKey: ['employeeWeeklyStats', employee?.id] });
              queryClient.invalidateQueries({ queryKey: ['attendanceRecords'] });
            }}
          />
        </div>

        {/* Today's Status & Upcoming Meetings */}
        <div className="space-y-6">
          {/* Today's Status */}
          <div className="bg-white dark:bg-neutral-900 rounded-2xl shadow-sm border border-gray-100 dark:border-neutral-800 p-6">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">Today's Status</h3>

            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-sm text-gray-600 dark:text-neutral-400">Status</span>
                <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium ${!todayRecord?.clockIn
                  ? 'text-gray-600 dark:text-neutral-400 bg-gray-100 dark:bg-neutral-800'
                  : todayRecord?.clockOut
                    ? 'text-blue-700 bg-blue-50 dark:bg-blue-950/40 dark:text-blue-400'
                    : (todayRecord?.breaks?.some(b => !b.endTime && !b.end))
                      ? 'text-amber-700 bg-amber-50 dark:bg-amber-950/40 dark:text-amber-400'
                      : (todayRecord?.lunchStart && !todayRecord?.lunchEnd)
                        ? 'text-orange-700 bg-orange-50 dark:bg-orange-950/40 dark:text-orange-400'
                        : todayRecord?.isLate
                          ? 'text-yellow-700 bg-yellow-50 dark:bg-yellow-950/40 dark:text-yellow-400'
                          : 'text-emerald-700 bg-emerald-50 dark:bg-emerald-950/40 dark:text-emerald-400'
                  }`}>
                  {!todayRecord?.clockIn
                    ? 'Not clocked in'
                    : todayRecord?.clockOut
                      ? 'Shift completed'
                      : (todayRecord?.breaks?.some(b => !b.endTime && !b.end))
                        ? 'On Break'
                        : (todayRecord?.lunchStart && !todayRecord?.lunchEnd)
                          ? 'Lunch Break'
                          : todayRecord?.isLate
                            ? 'Late arrival'
                            : 'On time'
                  }
                </span>
              </div>

              {todayRecord?.clockIn && (
                <>
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-gray-600 dark:text-neutral-400">Clock in time</span>
                    <span className="text-sm font-medium">
                      {format(todayRecord.clockIn, 'HH:mm')}
                    </span>
                  </div>

                  {todayRecord.clockOut && (
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-gray-600 dark:text-neutral-400">Clock out time</span>
                      <span className="text-sm font-medium">
                        {format(todayRecord.clockOut, 'HH:mm')}
                      </span>
                    </div>
                  )}

                  <div className="flex items-center justify-between">
                    <span className="text-sm text-gray-600 dark:text-neutral-400">Hours worked</span>
                    <span className="text-sm font-medium">
                      {formatDuration(todayRecord.hoursWorked || 0)}
                    </span>
                  </div>

                  <div className="flex items-center justify-between">
                    <span className="text-sm text-gray-600 dark:text-neutral-400">Breaks taken</span>
                    <span className="text-sm font-medium">
                      {todayRecord.breaks.length}
                    </span>
                  </div>
                </>
              )}
            </div>
          </div>

          {/* Software & Tools Used Today */}
          <div className="bg-white dark:bg-neutral-900 rounded-2xl shadow-sm border border-gray-100 dark:border-neutral-800 p-6">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2.5">
                <div className="p-2 bg-brand/10 dark:bg-brand/20 rounded-xl text-brand">
                  <Monitor className="h-5 w-5" />
                </div>
                <div>
                  <h3 className="text-lg font-semibold text-gray-900 dark:text-white">Software & Tools Used Today</h3>
                  <p className="text-xs text-gray-500 dark:text-neutral-400">
                    Screen time & tool activity breakdown
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => refetchSoftware()}
                  disabled={softwareLoading || isSoftwareRefetching}
                  className="p-1.5 rounded-lg text-gray-500 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-neutral-800 transition-colors"
                  title="Refresh software logs"
                >
                  <RefreshCw className={`h-4 w-4 ${softwareLoading || isSoftwareRefetching ? 'animate-spin text-brand' : ''}`} />
                </button>

                {todayRecord?.clockIn && !todayRecord?.clockOut && (
                  <button
                    type="button"
                    onClick={() => setShowLogSoftwareModal(true)}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-xl bg-brand text-white hover:bg-brand/90 dark:bg-white dark:text-black dark:hover:bg-gray-100 transition-all shadow-sm"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    Log Tool
                  </button>
                )}
              </div>
            </div>

            {/* Active Screen Time Banner */}
            {todayRecord?.clockIn && (
              <div className="grid grid-cols-2 gap-3 p-3.5 mb-4 rounded-xl bg-gray-50 dark:bg-neutral-800/50 border border-gray-100 dark:border-neutral-800">
                <div>
                  <span className="text-[11px] uppercase tracking-wider font-semibold text-gray-500 dark:text-neutral-400">
                    Active Screen Time
                  </span>
                  <p className="text-xl font-mono font-bold text-gray-900 dark:text-white mt-0.5">
                    {formatDuration(totalActiveSeconds / 3600)}
                  </p>
                </div>
                <div className="text-right">
                  <span className="text-[11px] uppercase tracking-wider font-semibold text-gray-500 dark:text-neutral-400">
                    Avg Activity Rate
                  </span>
                  <p className="text-xl font-mono font-bold text-emerald-600 dark:text-emerald-400 mt-0.5">
                    {avgOverallActivity}%
                  </p>
                </div>
              </div>
            )}

            {/* Software List */}
            {softwareLoading ? (
              <div className="text-center py-6">
                <div className="animate-spin rounded-full h-6 w-6 border-2 border-gray-300 border-t-brand mx-auto mb-2"></div>
                <p className="text-xs text-gray-500 dark:text-neutral-400">Loading tools & usage data...</p>
              </div>
            ) : softwareSummary.length > 0 ? (
              <div className="space-y-3">
                {softwareSummary.map((tool, idx) => {
                  const sharePercentage = totalSoftwareSeconds > 0
                    ? Math.round((tool.totalSeconds / totalSoftwareSeconds) * 100)
                    : 0;

                  return (
                    <div
                      key={idx}
                      className="p-3 rounded-xl bg-gray-50/70 dark:bg-neutral-800/40 border border-gray-100 dark:border-neutral-800 hover:border-gray-200 dark:hover:border-neutral-700 transition-all"
                    >
                      <div className="flex items-center justify-between mb-1.5">
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-sm text-gray-900 dark:text-white">
                            {tool.softwareName}
                          </span>
                          <span className={`px-2 py-0.5 text-[10px] font-semibold rounded-full uppercase tracking-wider ${getCategoryBadgeClass(tool.category)}`}>
                            {tool.category}
                          </span>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-sm font-bold text-gray-900 dark:text-white">
                            {formatDuration(tool.totalSeconds / 3600)}
                          </span>
                          <span className="text-xs text-emerald-600 dark:text-emerald-400 font-medium">
                            {tool.avgActivityPercentage}% active
                          </span>
                        </div>
                      </div>

                      <div className="w-full bg-gray-200 dark:bg-neutral-700 rounded-full h-1.5 overflow-hidden">
                        <div
                          className="bg-brand h-1.5 rounded-full transition-all duration-700"
                          style={{ width: `${Math.max(4, Math.min(100, sharePercentage))}%` }}
                        ></div>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : todayRecord?.clockIn ? (
              <div className="p-4 rounded-xl bg-gray-50 dark:bg-neutral-800/30 text-center border border-dashed border-gray-200 dark:border-neutral-800">
                <p className="text-xs text-gray-600 dark:text-neutral-400 leading-relaxed">
                  No software usage recorded yet today. Run the desktop agent (<code className="text-brand font-mono text-[11px]">python wfh_agent.py</code>) or click <strong>Log Tool</strong> to track tools manually.
                </p>
              </div>
            ) : (
              <div className="p-4 rounded-xl bg-gray-50 dark:bg-neutral-800/30 text-center border border-dashed border-gray-200 dark:border-neutral-800">
                <p className="text-xs text-gray-500 dark:text-neutral-400">
                  Clock in to start tracking software usage and active screen time.
                </p>
              </div>
            )}
          </div>

          {/* Upcoming Meetings */}
          <div className="bg-white dark:bg-neutral-900 rounded-2xl shadow-sm border border-gray-100 dark:border-neutral-800 p-6">
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-lg font-semibold text-gray-900 dark:text-white">Upcoming Meetings</h3>
              <button
                onClick={() => refetchMeetings()}
                disabled={meetingsLoading}
                className={`text-sm font-medium flex items-center space-x-2 px-3 py-1 rounded-lg transition-colors ${meetingsLoading
                  ? 'text-gray-400 bg-gray-100 cursor-not-allowed'
                  : 'text-brand hover:text-gray-900 dark:text-white dark:hover:text-white hover:bg-gray-50 dark:hover:bg-neutral-800'
                  }`}
              >
                {meetingsLoading ? (
                  <>
                    <div className="animate-spin rounded-full h-4 w-4 border-2 border-gray-300 border-t-blue-600"></div>
                    <span>Refreshing...</span>
                  </>
                ) : (
                  <>
                    <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                    </svg>
                    <span>Refresh</span>
                  </>
                )}
              </button>
            </div>

            {meetingsLoading ? (
              <div className="text-center py-8">
                <div className="animate-spin rounded-full h-8 w-8 border-2 border-gray-300 border-t-blue-600 mx-auto mb-3"></div>
                <p className="text-gray-500 dark:text-neutral-400 text-sm">Loading meetings...</p>
              </div>
            ) : meetings.length > 0 ? (
              <div className="space-y-3">
                {meetings.map((meeting) => {
                  const meetingDate = new Date(meeting.date);

                  if (isNaN(meetingDate.getTime())) {
                    return null;
                  }

                  // Create proper date and time for the meeting
                  const [hours, minutes] = meeting.time.split(':').map(Number);
                  const meetingDateTime = new Date(meetingDate);
                  meetingDateTime.setHours(hours, minutes, 0, 0);

                  // Format date and time properly
                  const isToday = format(meetingDate, 'yyyy-MM-dd') === format(new Date(), 'yyyy-MM-dd');
                  const isTomorrow = format(meetingDate, 'yyyy-MM-dd') === format(new Date(Date.now() + 24 * 60 * 60 * 1000), 'yyyy-MM-dd');

                  let dateDisplay;
                  if (isToday) {
                    dateDisplay = 'Today';
                  } else if (isTomorrow) {
                    dateDisplay = 'Tomorrow';
                  } else {
                    dateDisplay = format(meetingDate, 'MMM d, yyyy');
                  }

                  const timeDisplay = format(meetingDateTime, 'h:mm a');

                  return (
                    <div key={meeting.id} className="border-l-4 border-blue-500 dark:border-blue-400 pl-4 py-3 bg-blue-50 dark:bg-blue-900/20 rounded-r-lg">
                      <h4 className="font-semibold text-gray-900 dark:text-white mb-1">{meeting.title}</h4>
                      <div className="flex items-center justify-between text-sm">
                        <div className="flex items-center text-gray-700 dark:text-gray-300">
                          <Calendar className="h-4 w-4 mr-2 text-brand" />
                          <span className="font-medium">{dateDisplay}</span>
                          <span className="mx-2">•</span>
                          <Clock className="h-4 w-4 mr-1 text-brand" />
                          <span>{timeDisplay}</span>
                        </div>
                        <span className={`px-2 py-1 rounded-full text-xs font-medium ${meeting.status === 'scheduled' ? 'bg-emerald-50 dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border border-emerald-100 dark:border-emerald-500/20' :
                          meeting.status === 'completed' ? 'bg-brand/10 text-gray-700 dark:text-white border border-brand/30' :
                            'bg-gray-100 dark:bg-neutral-800 text-gray-800 dark:text-neutral-300 border border-transparent dark:border-neutral-700'
                          }`}>
                          {meeting.status}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="text-center py-8">
                <Calendar className="h-12 w-12 mx-auto mb-3 text-gray-300" />
                <p className="text-gray-500 dark:text-neutral-400 text-sm">No upcoming meetings scheduled</p>
              </div>
            )}
          </div>
        </div>
      </div>

      <LeaveRequestModal
        isOpen={isLeaveModalOpen}
        onClose={() => setIsLeaveModalOpen(false)}
      />

      {/* Log Software Usage Modal */}
      {showLogSoftwareModal && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white dark:bg-neutral-900 rounded-2xl shadow-xl max-w-md w-full p-6 border border-gray-100 dark:border-neutral-800">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-1">Log Software / Tool Usage</h3>
            <p className="text-xs text-gray-500 dark:text-neutral-400 mb-4">
              Record tools and active time spent during your shift.
            </p>

            <form onSubmit={handleLogSoftware} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-gray-700 dark:text-neutral-300 mb-1">
                  Software / Tool Name
                </label>
                <input
                  type="text"
                  required
                  placeholder="e.g. VS Code, Google Chrome, Figma, Slack"
                  value={softwareForm.name}
                  onChange={(e) => setSoftwareForm({ ...softwareForm, name: e.target.value })}
                  className="w-full px-3.5 py-2.5 rounded-xl border border-gray-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 text-sm text-gray-900 dark:text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-brand"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-gray-700 dark:text-neutral-300 mb-1">
                    Category
                  </label>
                  <select
                    value={softwareForm.category}
                    onChange={(e) => setSoftwareForm({
                      ...softwareForm,
                      category: e.target.value as typeof softwareForm.category
                    })}
                    className="w-full px-3 py-2.5 rounded-xl border border-gray-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 text-sm text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-brand"
                  >
                    <option value="development">Development</option>
                    <option value="browsing">Browsing</option>
                    <option value="communication">Communication</option>
                    <option value="productivity">Productivity</option>
                    <option value="design">Design</option>
                    <option value="office">Office</option>
                    <option value="general">General</option>
                    <option value="other">Other</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-gray-700 dark:text-neutral-300 mb-1">
                    Duration (Minutes)
                  </label>
                  <input
                    type="number"
                    min="1"
                    max="720"
                    required
                    value={softwareForm.minutes}
                    onChange={(e) => setSoftwareForm({ ...softwareForm, minutes: parseInt(e.target.value, 10) || 1 })}
                    className="w-full px-3 py-2.5 rounded-xl border border-gray-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 text-sm text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-brand"
                  />
                </div>
              </div>

              <div className="flex justify-end gap-2.5 pt-3">
                <button
                  type="button"
                  onClick={() => setShowLogSoftwareModal(false)}
                  disabled={submittingSoftware}
                  className="px-4 py-2 rounded-xl text-sm font-medium text-gray-700 dark:text-neutral-300 hover:bg-gray-100 dark:hover:bg-neutral-800 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={submittingSoftware || !softwareForm.name.trim()}
                  className="px-5 py-2 rounded-xl text-sm font-semibold bg-brand text-white hover:bg-brand/90 dark:bg-white dark:text-black dark:hover:bg-gray-100 transition-all disabled:opacity-50"
                >
                  {submittingSoftware ? 'Saving...' : 'Save Usage'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

export default EmployeeDashboardNew;
