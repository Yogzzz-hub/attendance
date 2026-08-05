import React, { useState, useEffect, useCallback, useRef, memo } from 'react';
import { useQueryClient, useMutation } from '@tanstack/react-query';
import { Clock, AlertCircle, Coffee, Play, Pause } from 'lucide-react';
import { globalAttendanceService } from '../../services/globalAttendanceService';
import { AttendanceRecord } from '../../types';
import type { RoleSchedule } from '../../types';
import { useAuth } from '../../hooks/useAuth';
import { formatOfficeTimeLong, getOfficeNow } from '../../utils/timezoneUtils';
import { format } from 'date-fns';
import toast from 'react-hot-toast';
import { getLunchEndTime, isLateArrival, DEFAULT_ROLE_SCHEDULE } from '../../constants/workingHours';
import { configService } from '../../services/configService';
import { formatDuration } from '../../utils/formatDuration';
import { getClientIP, verifyIPAddress, verifyGeofence } from '../../utils/security';
import { envConfig } from '../../config/env';

// ─── Isolated micro-components: tick every second without triggering parent re-renders ───

const LiveClockDisplay = memo(() => {
  const [now, setNow] = useState(getOfficeNow());

  useEffect(() => {
    const timer = setInterval(() => setNow(getOfficeNow()), 1000);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className="text-right">
      <div className="text-2xl font-mono font-bold text-gray-900 dark:text-white">
        {format(now, 'HH:mm:ss')}
      </div>
      <div className="text-sm text-gray-500 dark:text-neutral-400">
        {format(now, 'EEEE, MMMM d, yyyy')}
      </div>
    </div>
  );
});
LiveClockDisplay.displayName = 'LiveClockDisplay';

interface LiveWorkingHoursProps {
  clockIn: Date;
  clockOut?: Date | null;
  breaks: { startTime?: Date | null; endTime?: Date | null }[];
  isOnBreak: boolean;
}

const LiveWorkingHours = memo(({ clockIn, clockOut, breaks, isOnBreak }: LiveWorkingHoursProps) => {
  const [, setTick] = useState(0);

  useEffect(() => {
    // If already clocked out, no need to tick
    if (clockOut) return;
    const timer = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(timer);
  }, [clockOut]);

  const endTime = clockOut || new Date();
  const workingMs = endTime.getTime() - clockIn.getTime();

  const breakMs = breaks.reduce((total, breakSession) => {
    if (breakSession.endTime && breakSession.startTime) {
      return total + (breakSession.endTime.getTime() - breakSession.startTime.getTime());
    } else if (isOnBreak && breakSession.startTime) {
      return total + (new Date().getTime() - breakSession.startTime.getTime());
    }
    return total;
  }, 0);

  const actualWorkingMs = Math.max(0, workingMs - breakMs);
  const hours = actualWorkingMs / (1000 * 60 * 60);

  return <>{formatDuration(hours)}</>;
});
LiveWorkingHours.displayName = 'LiveWorkingHours';

interface LiveBreakDurationProps {
  breakStartTime: Date;
}

const LiveBreakDuration = memo(({ breakStartTime }: LiveBreakDurationProps) => {
  const [, setTick] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  const duration = (new Date().getTime() - breakStartTime.getTime()) / (1000 * 60);
  return <>{Math.floor(duration)}m</>;
});
LiveBreakDuration.displayName = 'LiveBreakDuration';

interface ClockInOutNewProps {
  onAttendanceChange?: () => void;
}

const ClockInOutNew: React.FC<ClockInOutNewProps> = ({ onAttendanceChange }) => {
  const { employee } = useAuth();
  const [todayRecord, setTodayRecord] = useState<AttendanceRecord | null>(null);
  const [loading, setLoading] = useState(false);
  // currentTime removed — clock display is now handled by <LiveClockDisplay />
  const [isOnBreak, setIsOnBreak] = useState(false);
  const [showLateReasonModal, setShowLateReasonModal] = useState(false);
  const [lateReason, setLateReason] = useState('');
  const [pendingClockIn, setPendingClockIn] = useState(false);
  const [currentLocation, setCurrentLocation] = useState<{ latitude: number; longitude: number; accuracy?: number } | null>(null);
  const [locationError, setLocationError] = useState<string | null>(null);
  const [isValidating, setIsValidating] = useState(false);
  const [showClockOutModal, setShowClockOutModal] = useState(false);
  const [isInitializing, setIsInitializing] = useState(true);
  // Active employee schedule (fetched from DB); falls back to DEFAULT_ROLE_SCHEDULE while loading or on error
  const [activeSchedule, setActiveSchedule] = useState<RoleSchedule | null>(null);
  const [lunchEndTime, setLunchEndTime] = useState<Date>(getLunchEndTime(DEFAULT_ROLE_SCHEDULE, new Date()));
  const [workMode, setWorkMode] = useState<'on_site' | 'wfh'>('on_site');

  // WFH timer state
  const [wfhActiveSeconds, setWfhActiveSeconds] = useState(0);
  const [wfhBreakStart, setWfhBreakStart] = useState<Date | null>(null);
  const wfhTimerRef = useRef<number | null>(null);
  const WFH_TARGET_SECONDS = 25200; // 7 hours

  // Synchronous lock to prevent concurrent clock-in submissions
  const clockInLock = useRef(false);
  // Stores the location that passed geofence validation, protecting against stale state updates before modal submission
  const validatedLocationRef = useRef<{ latitude: number; longitude: number; accuracy: number } | null>(null);

  const queryClient = useQueryClient();

  const clockOutMutation = useMutation({
    mutationFn: () => {
      if (!employee?.id) throw new Error('Employee not authenticated');
      return globalAttendanceService.clockOut(employee.id);
    },
    onMutate: () => {
      setLoading(true);
    },
    onSuccess: (record: AttendanceRecord) => {
      setTodayRecord(record);
      toast.success(`Clocked out successfully! Worked ${(record.hoursWorked || 0).toFixed(2)} hours`);
      handleAttendanceChange();
      queryClient.invalidateQueries({ queryKey: ['employeeAttendanceToday', employee?.id] });
      queryClient.invalidateQueries({ queryKey: ['employeeWeeklyStats', employee?.id] });
      queryClient.invalidateQueries({ queryKey: ['attendanceRecords'] });
    },
    onError: (error: Error) => {
      toast.error(error.message);
    },
    onSettled: () => {
      setLoading(false);
    }
  });

  const handleAttendanceChange = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['employeeAttendanceToday', employee?.id] });
    queryClient.invalidateQueries({ queryKey: ['employeeWeeklyStats', employee?.id] });
    queryClient.invalidateQueries({ queryKey: ['attendanceRecords'] });
    if (onAttendanceChange) {
      onAttendanceChange();
    }
  }, [queryClient, employee?.id, onAttendanceChange]);

  // Helper: Fetch a fresh GPS reading with high accuracy
  const getFreshLocation = (): Promise<{ latitude: number; longitude: number; accuracy: number } | null> => {
    return new Promise((resolve) => {
      if (!navigator.geolocation) {
        resolve(null);
        return;
      }
      navigator.geolocation.getCurrentPosition(
        (position) => {
          const { latitude, longitude, accuracy } = position.coords;
          resolve({ latitude, longitude, accuracy });
        },
        () => resolve(null),
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
      );
    });
  };

  /**
   * Validate IP and Geolocation constraints before allowing clock-in
   * Fetches current settings from database (Admin-configurable)
   */
  const validateLocationConstraints = async (): Promise<void> => {
    // Fetch current validation settings from database
    // Default to true (strict) if fetch fails - security-first approach
    let requireIpMatch = true;
    let requireGeoMatch = true;

    try {
      const config = await configService.getWorkingHoursConfig();
      if (config) {
        requireIpMatch = config.require_ip_match ?? true;
        requireGeoMatch = config.require_geo_match ?? true;
      }
    } catch (error) {
      console.warn('Failed to fetch validation config, using strict defaults:', error);
    }

    // IP Address Validation
    if (requireIpMatch) {
      const clientIP = await getClientIP();
      const ipCheck = await verifyIPAddress(envConfig.officeIpAddress);

      if (!ipCheck.valid) {
        throw new Error(
          'You must be on the office network to clock in. '
          + (clientIP ? `` : 'Unable to determine your IP address.')
        );
      }
    }

    // Geolocation Validation
    if (requireGeoMatch) {
      const freshLocation = await getFreshLocation();
      if (!freshLocation) {
        throw new Error('Unable to acquire a fresh GPS lock. Please check your location permissions and try again.');
      }

      const geoCheck = verifyGeofence(
        freshLocation.latitude,
        freshLocation.longitude,
        envConfig.officeLatitude,
        envConfig.officeLongitude,
        envConfig.geofenceRadiusMeters
      );

      if (!geoCheck.valid) {
        throw new Error(
          `You must be within the office premises to clock in. `
          + `You are ${geoCheck.distance} meters away from the office.`
        );
      }

      // Update UI with the verified location (including accuracy)
      setCurrentLocation({ latitude: freshLocation.latitude, longitude: freshLocation.longitude, accuracy: freshLocation.accuracy });
      setLocationError(null);

      // Store the validated location for the actual clock-in call (protects against stale state)
      validatedLocationRef.current = freshLocation;
    }
  };

  const handleClockIn = async () => {
    if (!employee?.id || clockInLock.current) return;

    clockInLock.current = true;
    let goingToModal = false;

    try {
      setIsValidating(true);
      // Skip location/network validation for WFH mode
      if (workMode !== 'wfh') {
        await validateLocationConstraints();
      }

      // Check if it would be a late arrival based on configured work start time
      const now = new Date();
      const effectiveSchedule = activeSchedule || DEFAULT_ROLE_SCHEDULE;
      const isActuallyLate = isLateArrival(effectiveSchedule, now);

      if (isActuallyLate && !pendingClockIn) {
        // Show modal to ask for late reason
        setPendingClockIn(true);
        setShowLateReasonModal(true);
        goingToModal = true;
        return;
      }

      await performClockIn();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Location validation failed');
      setLocationError(error instanceof Error ? error.message : 'Location validation failed');
    } finally {
      setIsValidating(false);
      if (!goingToModal) {
        clockInLock.current = false;
      }
    }
  };

  const performClockIn = async () => {
    if (!employee?.id) return;

    setLoading(true);
    try {
      // Use the validated location if available; otherwise fall back to current state
      const validatedLoc = validatedLocationRef.current;
      const locationPayload = validatedLoc
        ? {
          latitude: validatedLoc.latitude,
          longitude: validatedLoc.longitude,
          accuracy: validatedLoc.accuracy,
          timestamp: new Date()
        }
        : currentLocation
          ? {
            latitude: currentLocation.latitude,
            longitude: currentLocation.longitude,
            accuracy: currentLocation.accuracy || 0,
            timestamp: new Date()
          }
          : undefined;

      const record = await globalAttendanceService.clockIn(
        employee.id,
        lateReason.trim() || undefined,
        locationPayload,
        undefined,
        workMode
      );
      setTodayRecord(record);
      toast.success('Clocked in successfully!');

      if (record.isLate) {
        toast.error(`Late arrival: ${record.lateReason}`);
      }

      // Reset modal state
      setShowLateReasonModal(false);
      setLateReason('');
      setPendingClockIn(false);

      // Clear the validated location reference
      validatedLocationRef.current = null;

      // Notify parent component of change
      handleAttendanceChange();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Clock in failed');
      // Note: keep validatedLocationRef intact so a retry (e.g., after network error) can reuse same location
    } finally {
      setLoading(false);
    }
  };

  const handleLateReasonSubmit = async () => {
    if (!lateReason.trim()) {
      toast.error('Please provide a reason for late arrival');
      return;
    }

    try {
      await performClockIn();
    } catch {
      // performClockIn already displays error toast; keep modal open for retry
    } finally {
      clockInLock.current = false;
    }
  };

  const handleCancelLateReason = () => {
    setShowLateReasonModal(false);
    setLateReason('');
    setPendingClockIn(false);
    clockInLock.current = false;
    validatedLocationRef.current = null;
  };

  const handleClockOut = () => {
    setShowClockOutModal(true);
  };

  const confirmClockOut = () => {
    setShowClockOutModal(false);
    clockOutMutation.mutate();
  };

  const handleStartBreak = async () => {
    if (!employee?.id) return;

    setLoading(true);
    try {
      const record = await globalAttendanceService.startBreak(employee.id);
      setTodayRecord(record);
      setIsOnBreak(true);
      toast.success('Break started');

      // Notify parent component of change
      handleAttendanceChange();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Start break failed');
    } finally {
      setLoading(false);
    }
  };

  const handleEndBreak = async () => {
    if (!employee?.id) return;

    setLoading(true);
    try {
      const record = await globalAttendanceService.endBreak(employee.id);
      setTodayRecord(record);
      setIsOnBreak(false);
      toast.success('Break ended');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'End break failed');
    } finally {
      setLoading(false);
    }
  };

  const formatTime = (date: Date | null) => {
    if (!date) return '--:--';
    return formatOfficeTimeLong(date);
  };

  // Format a schedule start time (start_hour/minute) into 12-hour AM/PM string
  const formatScheduleStartTime = (schedule: RoleSchedule | null | undefined) => {
    const sched = schedule || DEFAULT_ROLE_SCHEDULE;
    const period = sched.start_hour >= 12 ? 'PM' : 'AM';
    const displayHour = sched.start_hour % 12 === 0 ? 12 : sched.start_hour % 12;
    return `${displayHour}:${sched.start_minute.toString().padStart(2, '0')} ${period}`;
  };

  // getWorkingHours and getCurrentBreakDuration removed — now handled by
  // <LiveWorkingHours /> and <LiveBreakDuration /> micro-components

  // Get user location (background refresh – actual clock-in uses fresh GPS)
  useEffect(() => {
    const requestLocation = () => {
      if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
          (position) => {
            const { latitude, longitude, accuracy } = position.coords;
            setCurrentLocation({ latitude, longitude, accuracy });
            setLocationError(null);
            console.log('📍 Location obtained:', latitude, longitude, `accuracy: ${accuracy}m`);
          },
          (error) => {
            console.error('📍 Location error:', error);
            setLocationError(`Location access denied: ${error.message}`);
          },
          { enableHighAccuracy: true, timeout: 10000, maximumAge: 300000 }
        );
      } else {
        setLocationError('Geolocation is not supported by this browser');
      }
    };

    requestLocation();

    // Update location every 5 minutes
    const locationInterval = setInterval(requestLocation, 5 * 60 * 1000);

    return () => clearInterval(locationInterval);
  }, []);

  // Fetch today's attendance record on mount (or when employee changes)
  // fetchTodayRecord is defined OUTSIDE useEffect so it gets a stable reference
  const fetchTodayRecord = useCallback(async () => {
    if (!employee?.id) return;

    const record = await globalAttendanceService.getTodayAttendance(employee.id);
    if (record) {
      setTodayRecord(record);
      const onBreak = record.breaks.some(breakSession => !breakSession.endTime);
      setIsOnBreak(onBreak);
    }
    setIsInitializing(false);
  }, [employee?.id]);

  useEffect(() => {
    if (!employee?.id) {
      setIsInitializing(false);
      return;
    }
    fetchTodayRecord();
    return () => {
      // No cancellation needed; fetchTodayRecord is in-flight only once per employee.id change
    };
  }, [employee?.id, fetchTodayRecord]);

  // Break Reminder engine — triggers a notification after 2 hours of continuous work
  useEffect(() => {
    // Determine "actively working": clocked in, not clocked out, not on break, not on lunch
    const isActivelyWorking = !!(
      todayRecord?.clockIn &&
      !todayRecord?.clockOut &&
      !isOnBreak &&
      (!todayRecord?.lunchStart || todayRecord?.lunchEnd)
    );

    // Request notification permission if needed (only once)
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      Notification.requestPermission();
    }

    // Only set the interval when reminders are enabled and user is actively working
    if (isActivelyWorking && employee?.break_reminder_enabled && typeof Notification !== 'undefined') {
      const TWO_HOURS = 1000 * 60 * 60 * 2;
      const breakMinutes = employee?.default_break_duration || 15;

      const intervalId = setInterval(() => {
        if (Notification.permission === 'granted') {
          new Notification('Break Reminder', {
            body: `You have been working for a while. Time to take your ${breakMinutes} minute break!`,
          });
        } else if (Notification.permission !== 'denied') {
          Notification.requestPermission().then((permission) => {
            if (permission === 'granted') {
              new Notification('Break Reminder', {
                body: `You have been working for a while. Time to take your ${breakMinutes} minute break!`,
              });
            }
          });
        }
      }, TWO_HOURS);

      return () => clearInterval(intervalId);
    }
  }, [todayRecord, isOnBreak, employee?.break_reminder_enabled, employee?.default_break_duration]);

  // WFH active work timer (7-hour target = 25,200 seconds)
  useEffect(() => {
    // Sync with DB value when record changes
    if (todayRecord?.workMode === 'wfh' && todayRecord.activeSeconds !== undefined) {
      setWfhActiveSeconds(todayRecord.activeSeconds);
    }

    // Clear any existing timer
    if (wfhTimerRef.current) {
      clearInterval(wfhTimerRef.current);
      wfhTimerRef.current = null;
    }

    const isWFHActive = todayRecord?.workMode === 'wfh'
      && todayRecord?.clockIn
      && !todayRecord?.clockOut
      && !isOnBreak
      && (!todayRecord?.lunchStart || todayRecord?.lunchEnd);

    if (isWFHActive) {
      wfhTimerRef.current = window.setInterval(() => {
        setWfhActiveSeconds(prev => prev + 1);
      }, 1000);
    }

    return () => {
      if (wfhTimerRef.current) {
        clearInterval(wfhTimerRef.current);
        wfhTimerRef.current = null;
      }
    };
  }, [todayRecord?.workMode, todayRecord?.clockIn, todayRecord?.clockOut, todayRecord?.activeSeconds, isOnBreak, todayRecord?.lunchStart, todayRecord?.lunchEnd]);

  // Track break start time for WFH break duration display
  useEffect(() => {
    if (isOnBreak) {
      setWfhBreakStart(new Date());
    } else {
      setWfhBreakStart(null);
    }
  }, [isOnBreak]);

  // Load working hours configuration to keep UI in sync with admin updates
  useEffect(() => {
    const fetchConfig = async () => {
      try {
        const dbConfig = await configService.getWorkingHoursConfig();
        if (dbConfig) {
          const now = new Date();
          const lunchEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), dbConfig.lunch_end_hour, dbConfig.lunch_end_minute, 0);
          setLunchEndTime(lunchEnd);
        } else {
          setLunchEndTime(getLunchEndTime(DEFAULT_ROLE_SCHEDULE, new Date()));
        }
      } catch (error) {
        console.error('Error loading work start time:', error);
        setLunchEndTime(getLunchEndTime(DEFAULT_ROLE_SCHEDULE, new Date()));
      }
    };

    fetchConfig();
  }, []);

  // Fetch the employee's actual role schedule from the DB
  useEffect(() => {
    if (!employee?.role) return;
    (async () => {
      try {
        const fetched = await configService.getScheduleByRole(employee.role);
        if (fetched) {
          setActiveSchedule(fetched);
        }
      } catch (error) {
        console.error('Failed to load employee schedule:', error);
      }
    })();
  }, [employee?.role]);

  const handleLunchReturn = async () => {
    if (!employee?.id) return;

    const now = new Date();
    const lunchEndTime = getLunchEndTime(DEFAULT_ROLE_SCHEDULE, now);

    const isLate = now > lunchEndTime;

    setLoading(true);
    try {
      const record = await globalAttendanceService.endLunchBreak(employee.id, isLate);
      setTodayRecord(record);

      if (isLate) {
        toast.error('⏰ Late return from lunch break!');
      } else {
        toast.success('🍽️ Lunch break ended');
      }

      handleAttendanceChange();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to end lunch break');
    } finally {
      setLoading(false);
    }
  };

  // Start a manual lunch break — user-initiated, no auto-trigger
  const handleStartLunch = async () => {
    if (!employee?.id) return;

    setLoading(true);
    try {
      const record = await globalAttendanceService.startLunchBreak(employee.id);
      setTodayRecord(record);
      handleAttendanceChange();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to start lunch break');
    } finally {
      setLoading(false);
    }
  };

  if (isInitializing) {
    return (
      <div className="min-h-screen bg-canvas dark:bg-black flex items-center justify-center">
        <div className="text-center">
          <div className="w-12 h-12 bg-gray-900 rounded-lg flex items-center justify-center animate-pulse mx-auto mb-4">
            <div className="w-6 h-6 bg-white dark:bg-neutral-800 rounded opacity-80"></div>
          </div>
          <h3 className="font-semibold text-gray-900 dark:text-white mb-1">Loading Attendance</h3>
          <p className="text-sm text-gray-500 dark:text-neutral-400">Please wait...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white dark:bg-neutral-900 rounded-2xl shadow-sm border border-gray-100 dark:border-neutral-800 border-gray-200 p-6">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-semibold text-gray-900 dark:text-white flex items-center">
          <Clock className="mr-2 h-5 w-5" />
          Time Tracking
        </h2>
      </div>

      {/* Late Status */}
      {todayRecord?.isLate && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-4">
          <div className="flex items-center">
            <AlertCircle className="h-5 w-5 text-red-600 mr-2" />
            <div>
              <p className="text-sm font-medium text-red-900">Late Arrival</p>
              <p className="text-sm text-red-700">{todayRecord.lateReason}</p>
            </div>
          </div>
        </div>
      )}

      {/* Lunch Break Status */}
      {todayRecord?.lunchStart && !todayRecord?.lunchEnd && (
        <div className="bg-orange-50 border border-orange-200 rounded-lg p-4 mb-4">
          <div className="flex items-center">
            <Coffee className="h-5 w-5 text-brand mr-2" />
            <div>
              <p className="text-sm font-medium text-orange-900">Lunch Break Active</p>
              <p className="text-sm text-orange-700">
                Started at {formatTime(todayRecord.lunchStart)} • Return before {lunchEndTime ? format(lunchEndTime, 'h:mm a') : '...'}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Location / Work Mode Status */}
      <div className="bg-white dark:bg-neutral-900 border border-gray-100 dark:border-neutral-800 rounded-2xl p-4 mb-4">
        <div className="flex items-center">
          <div className={`h-2 w-2 rounded-full mr-2 ${workMode === 'wfh' ? 'bg-blue-500' : currentLocation ? 'bg-green-500' : 'bg-red-500'}`}></div>
          <div>
            <p className="text-sm font-medium text-gray-900 dark:text-white dark:text-white">
              {workMode === 'wfh' ? 'Work From Home Mode' : 'Location Status'}
            </p>
            <p className="text-sm text-gray-600 dark:text-neutral-400">
              {workMode === 'wfh'
                ? '🏠 Location verification skipped for WFH'
                : currentLocation
                  ? `📍 Location detected (${currentLocation.latitude.toFixed(6)}, ${currentLocation.longitude.toFixed(6)})`
                  : locationError || 'Location access required for attendance'}
            </p>
          </div>
        </div>
      </div>

      {/* Work Mode Selector */}
      {!todayRecord?.clockIn && (
        <div className="bg-white dark:bg-neutral-900 border border-gray-100 dark:border-neutral-800 rounded-2xl p-4 mb-4">
          <p className="text-sm font-medium text-gray-900 dark:text-white mb-3">Work Mode</p>
          <div className="flex rounded-xl bg-gray-100 dark:bg-neutral-800 p-1">
            <button
              type="button"
              onClick={() => setWorkMode('on_site')}
              className={`flex-1 py-2.5 px-4 text-sm font-medium rounded-lg transition-all duration-200 ${
                workMode === 'on_site'
                  ? 'bg-white dark:bg-neutral-700 text-gray-900 dark:text-white shadow-sm'
                  : 'text-gray-500 dark:text-neutral-400 hover:text-gray-700 dark:hover:text-neutral-200'
              }`}
            >
              🏢 On-Site
            </button>
            <button
              type="button"
              onClick={() => setWorkMode('wfh')}
              className={`flex-1 py-2.5 px-4 text-sm font-medium rounded-lg transition-all duration-200 ${
                workMode === 'wfh'
                  ? 'bg-white dark:bg-neutral-700 text-gray-900 dark:text-white shadow-sm'
                  : 'text-gray-500 dark:text-neutral-400 hover:text-gray-700 dark:hover:text-neutral-200'
              }`}
            >
              🏠 Work From Home
            </button>
          </div>
          {workMode === 'wfh' && (
            <p className="text-xs text-gray-500 dark:text-neutral-400 mt-2">
              Location verification will be skipped for WFH mode.
            </p>
          )}
        </div>
      )}

      {/* WFH Active Work Timer */}
      {todayRecord?.workMode === 'wfh' && todayRecord?.clockIn && !todayRecord?.clockOut && (
        <div className="bg-white dark:bg-neutral-900 border border-gray-100 dark:border-neutral-800 rounded-2xl p-4 mb-4">
          <div className="flex items-center justify-between mb-2">
            <p className="text-sm font-medium text-gray-900 dark:text-white">Active Work Time</p>
            <span className="text-xs text-gray-500 dark:text-neutral-400">
              Target: {formatDuration(WFH_TARGET_SECONDS / 3600)}
            </span>
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-3xl font-mono font-bold text-gray-900 dark:text-white">
              {formatDuration(wfhActiveSeconds / 3600)}
            </span>
            <span className="text-sm text-gray-500 dark:text-neutral-400">
              / {formatDuration(WFH_TARGET_SECONDS / 3600)}
            </span>
          </div>
          <div className="mt-3 w-full bg-gray-200 dark:bg-neutral-700 rounded-full h-2">
            <div
              className="bg-brand h-2 rounded-full transition-all duration-1000"
              style={{ width: `${Math.min(100, (wfhActiveSeconds / WFH_TARGET_SECONDS) * 100)}%` }}
            ></div>
          </div>
          <p className="text-xs text-gray-500 dark:text-neutral-400 mt-2">
            {Math.round((wfhActiveSeconds / WFH_TARGET_SECONDS) * 100)}% of daily target
          </p>

          {/* Break Duration Timer */}
          {isOnBreak && (
            <div className="mt-4 pt-4 border-t border-gray-100 dark:border-neutral-800">
              <p className="text-sm font-medium text-orange-600 dark:text-orange-400 mb-1">Break Duration</p>
              <span className="text-2xl font-mono font-bold text-orange-600 dark:text-orange-400">
                {wfhBreakStart ? formatDuration((new Date().getTime() - wfhBreakStart.getTime()) / (1000 * 60 * 60)) : '0:00:00'}
              </span>
            </div>
          )}
        </div>
      )}

      {/* Action Buttons */}
      <div className="space-y-4">
        {!todayRecord?.clockIn ? (
          <button
            onClick={handleClockIn}
            disabled={loading || isValidating}
            className="relative group overflow-hidden w-full rounded-2xl bg-brand hover:bg-brand/90 text-white shadow-md dark:bg-white/[0.05] dark:hover:bg-white/[0.1] px-6 py-4 text-sm font-medium transition-all duration-500 ease-out border border-transparent dark:border-white/[0.1] dark:backdrop-blur-xl dark:shadow-[0_8px_32px_rgba(0,0,0,0.5),inset_0_4px_16px_rgba(255,255,255,0.15),inset_0_-4px_16px_rgba(0,0,0,0.4)] dark:hover:shadow-[0_8px_32px_rgba(0,0,0,0.6),inset_0_6px_20px_rgba(255,255,255,0.25),inset_0_-4px_16px_rgba(0,0,0,0.5)] disabled:opacity-50 disabled:cursor-not-allowed active:scale-[0.97]"
          >
            <span className="absolute inset-x-0 top-0 h-px hidden dark:block bg-gradient-to-r from-transparent via-white/50 to-transparent opacity-50 group-hover:opacity-100 transition-opacity duration-500"></span>
            <span className="absolute inset-0 z-0 hidden dark:block bg-[radial-gradient(ellipse_at_top,rgba(255,255,255,0.15)_0%,transparent_70%)] opacity-0 group-hover:opacity-100 transition-opacity duration-700"></span>
            <span className="relative z-10 flex items-center justify-center tracking-wide dark:drop-shadow-[0_2px_4px_rgba(0,0,0,0.5)]">
              <Play className="mr-2 h-5 w-5" />
              <span>{isValidating ? 'Verifying Location & Network...' : loading ? 'Clocking In...' : workMode === 'wfh' ? 'Clock In (WFH)' : 'Clock In'}</span>
            </span>
          </button>
        ) : !todayRecord?.clockOut ? (
          <div className="space-y-3">
            {/* Lunch Break Return Button - Show if lunch started but not ended */}
            {todayRecord?.lunchStart && !todayRecord?.lunchEnd && (
              <button
                onClick={handleLunchReturn}
                disabled={loading}
                className="relative group overflow-hidden w-full rounded-2xl bg-gray-900 hover:bg-black text-white shadow-md dark:bg-white/[0.1] dark:hover:bg-white/[0.15] px-6 py-4 text-sm font-medium transition-all duration-500 ease-out border border-transparent dark:border-white/[0.15] dark:backdrop-blur-xl dark:shadow-[0_8px_32px_rgba(0,0,0,0.5),inset_0_4px_16px_rgba(255,255,255,0.2),inset_0_-4px_16px_rgba(0,0,0,0.4)] dark:hover:shadow-[0_8px_32px_rgba(0,0,0,0.6),inset_0_6px_20px_rgba(255,255,255,0.3),inset_0_-4px_16px_rgba(0,0,0,0.5)] disabled:opacity-50 disabled:cursor-not-allowed active:scale-[0.97]"
              >
                <span className="absolute inset-x-0 top-0 h-px hidden dark:block bg-gradient-to-r from-transparent via-white/60 to-transparent opacity-60 group-hover:opacity-100 transition-opacity duration-500"></span>
                <span className="absolute inset-0 z-0 hidden dark:block bg-[radial-gradient(ellipse_at_top,rgba(255,255,255,0.2)_0%,transparent_70%)] opacity-0 group-hover:opacity-100 transition-opacity duration-700"></span>
                <span className="relative z-10 flex items-center justify-center tracking-wide dark:drop-shadow-[0_2px_4px_rgba(0,0,0,0.5)]">
                  <Coffee className="mr-2 h-5 w-5" />
                  <span>{loading ? 'Returning...' : 'Return from Lunch'}</span>
                </span>
              </button>
            )}

            {/* Start Lunch Break Button - Show if clocked in and NOT already on lunch */}
            {!todayRecord?.lunchStart && (
              <button
                onClick={handleStartLunch}
                disabled={loading}
                className="relative group overflow-hidden w-full rounded-2xl bg-white hover:bg-gray-50 text-gray-700 border border-gray-200 shadow-sm dark:bg-white/[0.05] dark:hover:bg-white/[0.1] px-6 py-4 text-sm font-medium dark:text-slate-200 transition-all duration-500 ease-out dark:border-white/[0.1] dark:backdrop-blur-xl dark:shadow-[0_8px_32px_rgba(0,0,0,0.5),inset_0_4px_16px_rgba(255,255,255,0.15),inset_0_-4px_16px_rgba(0,0,0,0.4)] dark:hover:shadow-[0_8px_32px_rgba(0,0,0,0.6),inset_0_6px_20px_rgba(255,255,255,0.25),inset_0_-4px_16px_rgba(0,0,0,0.5)] disabled:opacity-50 disabled:cursor-not-allowed active:scale-[0.97]"
              >
                <span className="absolute inset-x-0 top-0 h-px hidden dark:block bg-gradient-to-r from-transparent via-white/50 to-transparent opacity-50 group-hover:opacity-100 transition-opacity duration-500"></span>
                <span className="absolute inset-0 z-0 hidden dark:block bg-[radial-gradient(ellipse_at_top,rgba(255,255,255,0.15)_0%,transparent_70%)] opacity-0 group-hover:opacity-100 transition-opacity duration-700"></span>
                <span className="relative z-10 flex items-center justify-center tracking-wide dark:drop-shadow-[0_2px_4px_rgba(0,0,0,0.5)]">
                  <Coffee className="mr-2 h-5 w-5 text-gray-400 group-hover:text-gray-700 dark:text-slate-300 dark:group-hover:text-white transition-colors duration-300" />
                  <span>{loading ? 'Starting...' : 'Start Lunch Break'}</span>
                </span>
              </button>
            )}

            {/* Break Controls - Only show if not on lunch break */}
            {(!todayRecord?.lunchStart || todayRecord?.lunchEnd) && (
              <div className="flex space-x-3">
                {!isOnBreak ? (
                  <button
                    onClick={handleStartBreak}
                    disabled={loading}
                    className="relative group overflow-hidden flex-1 rounded-2xl bg-white hover:bg-gray-50 text-gray-700 border border-gray-200 shadow-sm dark:bg-white/[0.05] dark:hover:bg-white/[0.1] px-6 py-4 text-sm font-medium dark:text-slate-200 transition-all duration-500 ease-out dark:border-white/[0.1] dark:backdrop-blur-xl dark:shadow-[0_8px_32px_rgba(0,0,0,0.5),inset_0_4px_16px_rgba(255,255,255,0.15),inset_0_-4px_16px_rgba(0,0,0,0.4)] dark:hover:shadow-[0_8px_32px_rgba(0,0,0,0.6),inset_0_6px_20px_rgba(255,255,255,0.25),inset_0_-4px_16px_rgba(0,0,0,0.5)] disabled:opacity-50 disabled:cursor-not-allowed active:scale-[0.97]"
                  >
                    <span className="absolute inset-x-0 top-0 h-px hidden dark:block bg-gradient-to-r from-transparent via-white/50 to-transparent opacity-50 group-hover:opacity-100 transition-opacity duration-500"></span>
                    <span className="absolute inset-0 z-0 hidden dark:block bg-[radial-gradient(ellipse_at_top,rgba(255,255,255,0.15)_0%,transparent_70%)] opacity-0 group-hover:opacity-100 transition-opacity duration-700"></span>
                    <span className="relative z-10 flex items-center justify-center tracking-wide dark:drop-shadow-[0_2px_4px_rgba(0,0,0,0.5)]">
                      <Coffee className="mr-2 h-4 w-4 text-gray-400 group-hover:text-gray-700 dark:text-slate-300 dark:group-hover:text-white transition-colors duration-300" />
                      <span>{loading ? 'Starting...' : 'Start Break'}</span>
                    </span>
                  </button>
                ) : (
                  <button
                    onClick={handleEndBreak}
                    disabled={loading}
                    className="relative group overflow-hidden flex-1 rounded-2xl bg-gray-900 hover:bg-black text-white shadow-md dark:bg-white/[0.1] dark:hover:bg-white/[0.15] px-6 py-4 text-sm font-medium transition-all duration-500 ease-out border border-transparent dark:border-white/[0.15] dark:backdrop-blur-xl dark:shadow-[0_8px_32px_rgba(0,0,0,0.5),inset_0_4px_16px_rgba(255,255,255,0.2),inset_0_-4px_16px_rgba(0,0,0,0.4)] dark:hover:shadow-[0_8px_32px_rgba(0,0,0,0.6),inset_0_6px_20px_rgba(255,255,255,0.3),inset_0_-4px_16px_rgba(0,0,0,0.5)] disabled:opacity-50 disabled:cursor-not-allowed active:scale-[0.97]"
                  >
                    <span className="absolute inset-x-0 top-0 h-px hidden dark:block bg-gradient-to-r from-transparent via-white/60 to-transparent opacity-60 group-hover:opacity-100 transition-opacity duration-500"></span>
                    <span className="absolute inset-0 z-0 hidden dark:block bg-[radial-gradient(ellipse_at_top,rgba(255,255,255,0.2)_0%,transparent_70%)] opacity-0 group-hover:opacity-100 transition-opacity duration-700"></span>
                    <span className="relative z-10 flex items-center justify-center tracking-wide dark:drop-shadow-[0_2px_4px_rgba(0,0,0,0.5)]">
                      <Pause className="mr-2 h-4 w-4" />
                      <span>{loading ? 'Ending...' : <>End Break ({todayRecord?.breaks.find(b => !b.endTime)?.startTime ? <LiveBreakDuration breakStartTime={todayRecord!.breaks.find(b => !b.endTime)!.startTime!} /> : '0m'})</>}</span>
                    </span>
                  </button>
                )}
              </div>
            )}

            {/* Clock Out - Disable if on lunch break or regular break */}
            <button
              onClick={handleClockOut}
              disabled={loading || isOnBreak || (todayRecord?.lunchStart && !todayRecord?.lunchEnd)}
              className="relative group overflow-hidden w-full rounded-2xl bg-white hover:bg-red-50 text-gray-700 hover:text-red-600 border border-gray-200 shadow-sm dark:bg-white/[0.02] dark:hover:bg-red-500/[0.15] px-6 py-4 text-sm font-medium dark:text-slate-300 dark:hover:text-red-200 transition-all duration-500 ease-out dark:border-white/[0.05] dark:hover:border-red-500/[0.3] dark:backdrop-blur-xl dark:shadow-[0_8px_32px_rgba(0,0,0,0.4),inset_0_4px_16px_rgba(255,255,255,0.05),inset_0_-4px_16px_rgba(0,0,0,0.4)] dark:hover:shadow-[0_8px_32px_rgba(239,68,68,0.2),inset_0_6px_20px_rgba(239,68,68,0.15),inset_0_-4px_16px_rgba(239,68,68,0.3)] disabled:opacity-50 disabled:cursor-not-allowed active:scale-[0.97]"
            >
              <span className="absolute inset-x-0 top-0 h-px hidden dark:block bg-gradient-to-r from-transparent via-red-500/30 to-transparent opacity-50 group-hover:opacity-100 transition-opacity duration-500"></span>
              <span className="absolute inset-0 z-0 hidden dark:block bg-[radial-gradient(ellipse_at_top,rgba(239,68,68,0.15)_0%,transparent_70%)] opacity-0 group-hover:opacity-100 transition-opacity duration-700"></span>
              <span className="relative z-10 flex items-center justify-center tracking-wide dark:drop-shadow-[0_2px_4px_rgba(0,0,0,0.5)]">
                <Pause className="mr-2 h-5 w-5" />
                <span>{loading ? 'Clocking Out...' :
                  isOnBreak ? 'End Break First' :
                    (todayRecord?.lunchStart && !todayRecord?.lunchEnd) ? 'Return from Lunch First' : 'Clock Out'}</span>
              </span>
            </button>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-3 py-4">
            <div 
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-full bg-canvas dark:bg-neutral-800 text-slate-900 dark:text-green-400 shadow-[inset_0_1px_2px_rgba(255,255,255,0.6),0_4px_6px_-1px_rgba(150,194,219,0.2)] border border-white/40 text-sm font-medium tracking-wide transition-all duration-300 hover:scale-105 hover:shadow-[0_8px_15px_-3px_rgba(150,194,219,0.3)]"
            >
              ✅ Work completed for today!
            </div>
            <p className="text-sm text-gray-500 dark:text-neutral-400">
              Total worked: {formatDuration(todayRecord.hoursWorked || 0)}
            </p>
          </div>
        )}
      </div>
      {/* Today's Break Summary */}
      {todayRecord && todayRecord.breaks.length > 0 && (
        <div className="mt-6 border-t pt-4">
          <h3 className="text-sm font-medium text-gray-900 dark:text-white dark:text-white mb-3">Today's Breaks</h3>
          <div className="space-y-2">
            {todayRecord.breaks.map((breakSession, index) => (
              <div key={index} className="flex justify-between items-center text-sm bg-gray-50 dark:bg-neutral-800/50 dark:text-white rounded p-2">
                <span>Break {index + 1}</span>
                <span className="font-mono">
                  {formatTime(breakSession.startTime || null)} - {formatTime(breakSession.endTime || null)}
                  {breakSession.endTime && breakSession.startTime && (
                    <span className="ml-2 text-gray-500 dark:text-neutral-400">
                      ({Math.floor((breakSession.endTime.getTime() - breakSession.startTime.getTime()) / (1000 * 60))}m)
                    </span>
                  )}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Daily Stats */}
      {todayRecord && (
        <div className="mt-6 border-t pt-4">
          <h3 className="text-sm font-medium text-gray-900 dark:text-white mb-3">Today's Stats</h3>
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <span className="text-gray-600 dark:text-neutral-400">Breaks:</span>
              <span className="ml-2 font-medium">{todayRecord.breaks.length}</span>
            </div>
            <div>
              <span className="text-gray-600 dark:text-neutral-400">Lunch Break:</span>
              <span className="ml-2 font-medium">
                {todayRecord.lunchStart ?
                  (todayRecord.lunchEnd ? 'Completed' : 'Active') :
                  'Not taken'}
              </span>
            </div>
            {todayRecord.lunchStart && (
              <>
                <div>
                  <span className="text-gray-600 dark:text-neutral-400">Lunch Start:</span>
                  <span className="ml-2 font-medium">{formatTime(todayRecord.lunchStart)}</span>
                </div>
                {todayRecord.lunchEnd && (
                  <div>
                    <span className="text-gray-600 dark:text-neutral-400">Lunch End:</span>
                    <span className="ml-2 font-medium">{formatTime(todayRecord.lunchEnd)}</span>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {/* Late Reason Modal */}
      {showLateReasonModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white dark:bg-neutral-900 rounded-xl p-6 w-full max-w-md mx-4">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">Late Arrival</h3>
            <p className="text-gray-600 dark:text-neutral-400 mb-4">
              You're arriving after {formatScheduleStartTime(activeSchedule || DEFAULT_ROLE_SCHEDULE)}. Please provide a reason for your late arrival:
            </p>
            <textarea
              value={lateReason}
              onChange={(e) => setLateReason(e.target.value)}
              placeholder="Enter reason for late arrival..."
              className="w-full p-3 border border-gray-200 dark:border-neutral-800 rounded-xl bg-white dark:bg-black text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-neutral-600 focus:ring-2 focus:ring-brand focus:border-brand focus:border-transparent resize-none"
              rows={3}
              autoFocus
            />
            <div className="flex justify-end space-x-3 mt-4">
              <button
                onClick={handleCancelLateReason}
                className="px-4 py-2 text-sm font-medium text-gray-700 dark:text-neutral-300 bg-gray-100 dark:bg-neutral-800 hover:bg-gray-200 dark:hover:bg-neutral-700 rounded-xl transition-colors"
                disabled={loading}
              >
                Cancel
              </button>
              <button
                onClick={handleLateReasonSubmit}
                className="px-4 py-2 text-sm font-medium text-white dark:text-black bg-black dark:bg-zinc-100 hover:bg-gray-800 dark:hover:bg-white shadow-sm rounded-xl transition-all duration-200"
                disabled={loading || !lateReason.trim()}
              >
                {loading ? 'Clocking In...' : 'Clock In'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Clock-Out Confirmation Modal */}
      {showClockOutModal && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center">
          <div className="bg-white dark:bg-neutral-900 rounded-xl w-full max-w-sm mx-4 p-6 shadow-medium">
            <div className="flex items-start">
              <div className="flex-shrink-0">
                <div className="h-10 w-10 rounded-full bg-canvas flex items-center justify-center">
                  <AlertCircle className="h-5 w-5 text-slate-900" />
                </div>
              </div>
              <div className="ml-4 flex-1">
                <h3 className="text-base font-semibold text-gray-900 dark:text-white">
                  Confirm Clock Out
                </h3>
                <p className="mt-2 text-sm text-gray-600 dark:text-neutral-400">
                  Are you sure you want to clock out for the day? This action will end your shift and cannot be undone.
                </p>
              </div>
            </div>

            <div className="mt-6 flex justify-end space-x-3">
              <button
                type="button"
                onClick={() => setShowClockOutModal(false)}
                className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-200 rounded-xl hover:bg-canvas transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmClockOut}
                className="px-4 py-2 text-sm font-medium text-white bg-slate-900 rounded-xl hover:bg-slate-800 transition-colors"

              >
                Yes, Clock Out
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ClockInOutNew;
