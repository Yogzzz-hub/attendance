import React, { useState, useEffect, useCallback, useRef, memo } from 'react';
import { useQueryClient, useMutation } from '@tanstack/react-query';
import { Clock, AlertCircle, Coffee, Play, Pause, Monitor, Plus, MapPin, Building2, Home, Wifi, RotateCcw, ShieldCheck } from 'lucide-react';
import { globalAttendanceService } from '../../services/globalAttendanceService';
import { AttendanceRecord, SoftwareUsageSummary } from '../../types';
import type { RoleSchedule } from '../../types';
import { useAuth } from '../../hooks/useAuth';
import { formatOfficeTimeLong, getOfficeNow } from '../../utils/timezoneUtils';
import { format } from 'date-fns';
import toast from 'react-hot-toast';
import { getLunchEndTime, isLateArrival, DEFAULT_ROLE_SCHEDULE } from '../../constants/workingHours';
import { configService } from '../../services/configService';
import { formatDuration } from '../../utils/formatDuration';
import { verifyGeofence, calculateDistance, isLocalEnvironment, verifyIPAddress } from '../../utils/security';
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
  todayRecord?: AttendanceRecord | null;
}

const ClockInOutNew: React.FC<ClockInOutNewProps> = ({ onAttendanceChange, todayRecord: propTodayRecord }) => {
  const { employee } = useAuth();
  const [todayRecord, setTodayRecord] = useState<AttendanceRecord | null>(propTodayRecord ?? null);
  const [loading, setLoading] = useState(false);
  // currentTime removed — clock display is now handled by <LiveClockDisplay />
  const [isOnBreak, setIsOnBreak] = useState(false);
  const [showLateReasonModal, setShowLateReasonModal] = useState(false);
  const [lateReason, setLateReason] = useState('');
  const [pendingClockIn, setPendingClockIn] = useState(false);
  const [currentLocation, setCurrentLocation] = useState<{ latitude: number; longitude: number; accuracy?: number } | null>(null);
  const [officeDistance, setOfficeDistance] = useState<number | null>(null);
  const [locationError, setLocationError] = useState<string | null>(null);
  const [isValidating, setIsValidating] = useState(false);
  const [showClockOutModal, setShowClockOutModal] = useState(false);
  const [isInitializing, setIsInitializing] = useState(!propTodayRecord);

  // Network & Dev verification state
  const [isOfficeNetworkVerified, setIsOfficeNetworkVerified] = useState(false);
  const [isDevBypassActive, setIsDevBypassActive] = useState(isLocalEnvironment());
  const [isCheckingNetwork, setIsCheckingNetwork] = useState(false);
  const [clientPublicIP, setClientPublicIP] = useState<string | null>(null);

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

  // Software usage monitoring state
  const [softwareSummary, setSoftwareSummary] = useState<SoftwareUsageSummary[]>([]);
  const [loadingSoftware, setLoadingSoftware] = useState(false);
  const [showLogSoftwareModal, setShowLogSoftwareModal] = useState(false);
  const [softwareForm, setSoftwareForm] = useState<{
    name: string;
    category: 'development' | 'communication' | 'browsing' | 'productivity' | 'design' | 'office' | 'general' | 'other';
    minutes: number;
  }>({
    name: '',
    category: 'development',
    minutes: 30
  });

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

  /**
   * Verify whether the user's connection matches the office network/subnet or localhost
   */
  const checkOfficeNetwork = useCallback(async (): Promise<boolean> => {
    setIsCheckingNetwork(true);
    try {
      const isLocal = isLocalEnvironment();
      if (isLocal) {
        setIsOfficeNetworkVerified(true);
        setIsDevBypassActive(true);
        setLocationError(null);
        toast.success('Localhost / Dev network recognized: Geofence bypass active.');
        return true;
      }

      const ipResult = await verifyIPAddress(envConfig.officeIpAddress);
      setClientPublicIP(ipResult.ip);

      if (ipResult.valid) {
        setIsOfficeNetworkVerified(true);
        setLocationError(null);
        toast.success(`Office Network Verified (${ipResult.ip || 'Gateway'})`);
        return true;
      } else {
        toast.error(`Your network IP (${ipResult.ip || 'unknown'}) does not match the office network (${envConfig.officeIpAddress}).`);
        return false;
      }
    } catch (err) {
      console.error('Failed to verify office network:', err);
      toast.error('Network verification failed');
      return false;
    } finally {
      setIsCheckingNetwork(false);
    }
  }, []);

  /**
   * Validate Geolocation strictly for On-Site clock-in, with localhost dev bypass and network verification fallback.
   */
  const validateOnSiteLocation = async (options?: { forceGPS?: boolean }): Promise<{ latitude: number; longitude: number; accuracy: number; distance: number }> => {
    const isLocal = isLocalEnvironment();

    // 1. Localhost / Dev Bypass: automatically allow if running on localhost unless explicitly forced
    if (isLocal && !options?.forceGPS) {
      setIsDevBypassActive(true);
      setLocationError(null);
      const mockCoords = {
        latitude: currentLocation?.latitude || envConfig.officeLatitude,
        longitude: currentLocation?.longitude || envConfig.officeLongitude,
        accuracy: 10,
        distance: 0,
      };
      setOfficeDistance(0);
      return mockCoords;
    }

    // 2. Office Network / Subnet Override
    if (isOfficeNetworkVerified && !options?.forceGPS) {
      setLocationError(null);
      return {
        latitude: currentLocation?.latitude || envConfig.officeLatitude,
        longitude: currentLocation?.longitude || envConfig.officeLongitude,
        accuracy: currentLocation?.accuracy || 15,
        distance: officeDistance ?? 0,
      };
    }

    if (!navigator.geolocation) {
      if (isLocal || isOfficeNetworkVerified) {
        return {
          latitude: envConfig.officeLatitude,
          longitude: envConfig.officeLongitude,
          accuracy: 20,
          distance: 0,
        };
      }
      const err = 'Geolocation is not supported by your browser. Please verify via office network or use a modern browser.';
      setLocationError(err);
      throw new Error(err);
    }

    return new Promise((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          const { latitude, longitude, accuracy } = position.coords;
          const officeLat = envConfig.officeLatitude;
          const officeLon = envConfig.officeLongitude;
          const allowedRadius = envConfig.geofenceRadiusMeters;

          const geoCheck = verifyGeofence(
            latitude,
            longitude,
            officeLat,
            officeLon,
            allowedRadius,
            {
              allowLocalhostBypass: true,
              officeNetworkVerified: isOfficeNetworkVerified
            }
          );

          setOfficeDistance(geoCheck.distance);
          setCurrentLocation({ latitude, longitude, accuracy });

          if (geoCheck.isDevBypass) {
            setIsDevBypassActive(true);
            setLocationError(null);
            resolve({ latitude, longitude, accuracy, distance: geoCheck.distance });
            return;
          }

          if (geoCheck.isNetworkVerified) {
            setLocationError(null);
            resolve({ latitude, longitude, accuracy, distance: geoCheck.distance });
            return;
          }

          if (!geoCheck.valid) {
            const outOfBoundsErr = `Out of bounds: You are ${geoCheck.distance}m away from the office. You must be within ${allowedRadius}m to clock in on-site.`;
            setLocationError(outOfBoundsErr);
            reject(new Error(outOfBoundsErr));
            return;
          }

          setLocationError(null);
          resolve({ latitude, longitude, accuracy, distance: geoCheck.distance });
        },
        (error) => {
          // If GPS fails but user is on localhost / dev, handle gracefully
          if (isLocal) {
            setIsDevBypassActive(true);
            setLocationError(null);
            resolve({
              latitude: envConfig.officeLatitude,
              longitude: envConfig.officeLongitude,
              accuracy: 10,
              distance: 0,
            });
            return;
          }

          let errorMsg = 'Failed to acquire location for on-site verification.';
          switch (error.code) {
            case error.PERMISSION_DENIED:
              errorMsg = 'Location permission denied. Please allow location access in your browser settings or verify via office network.';
              break;
            case error.POSITION_UNAVAILABLE:
              errorMsg = 'Location information is unavailable. Ensure GPS is enabled or verify via office network.';
              break;
            case error.TIMEOUT:
              errorMsg = 'Location request timed out. Please retry with high accuracy GPS or verify via office network.';
              break;
            default:
              errorMsg = error.message || errorMsg;
              break;
          }
          setLocationError(errorMsg);
          reject(new Error(errorMsg));
        },
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
      );
    });
  };

  const handleRetryGPS = async () => {
    setLocationError(null);
    setIsValidating(true);
    try {
      await validateOnSiteLocation({ forceGPS: true });
      toast.success('High-accuracy GPS location acquired!');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'GPS lock failed');
    } finally {
      setIsValidating(false);
    }
  };

  const handleWorkModeChange = (mode: 'on_site' | 'wfh') => {
    setWorkMode(mode);
    if (mode === 'wfh') {
      setLocationError(null);
    } else if (currentLocation) {
      const dist = Math.round(
        calculateDistance(
          currentLocation.latitude,
          currentLocation.longitude,
          envConfig.officeLatitude,
          envConfig.officeLongitude
        )
      );
      setOfficeDistance(dist);
      if (dist <= envConfig.geofenceRadiusMeters) {
        setLocationError(null);
      } else {
        setLocationError(`You are ${dist}m away from the office (allowed: ${envConfig.geofenceRadiusMeters}m).`);
      }
    }
  };

  const handleClockIn = async () => {
    if (!employee?.id || clockInLock.current) return;

    clockInLock.current = true;
    let goingToModal = false;

    try {
      setIsValidating(true);
      setLocationError(null);

      // 1. Conditional Location Validation:
      // If workMode is 'on_site': Strictly require browser geolocation, calculate distance, and block clock-in
      // If workMode is 'wfh': Completely skip geolocation and distance checks
      if (workMode === 'on_site') {
        const validatedLoc = await validateOnSiteLocation();
        validatedLocationRef.current = validatedLoc;
      } else {
        // WFH Mode: completely skip geolocation and distance checks
        setLocationError(null);
        validatedLocationRef.current = null;
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
      const msg = error instanceof Error ? error.message : 'Clock-in failed';
      toast.error(msg);
      setLocationError(msg);
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
      // Use validated coords for on_site mode; skip completely for wfh
      const validatedLoc = workMode === 'on_site' ? validatedLocationRef.current : null;
      const locationPayload = validatedLoc
        ? {
          latitude: validatedLoc.latitude,
          longitude: validatedLoc.longitude,
          accuracy: validatedLoc.accuracy,
          timestamp: new Date()
        }
        : (workMode === 'on_site' && currentLocation)
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
      queryClient.setQueryData(['employeeAttendanceToday', employee.id], record);
      toast.success(workMode === 'wfh' ? 'Clocked in successfully (Work From Home)!' : 'Clocked in successfully (On-Site)!');

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
      const err = error as Error & { code?: string; existingRecord?: AttendanceRecord };
      const errMsg = err?.message || '';
      const isAlreadyClockedIn =
        err?.code === 'ALREADY_CLOCKED_IN' ||
        errMsg.toLowerCase().includes('already clocked in') ||
        errMsg.toLowerCase().includes('duplicate key') ||
        errMsg.toLowerCase().includes('unique constraint') ||
        errMsg.includes('23505');

      if (isAlreadyClockedIn) {
        let activeRecord = err.existingRecord;
        if (!activeRecord && employee?.id) {
          try {
            activeRecord = (await globalAttendanceService.getTodayAttendance(employee.id)) || undefined;
          } catch (fetchErr) {
            console.error('Failed to retrieve existing record after duplicate clock-in:', fetchErr);
          }
        }

        if (activeRecord) {
          setTodayRecord(activeRecord);
          const onBreak = activeRecord.breaks.some(b => !b.endTime && !b.end);
          setIsOnBreak(onBreak);
          if (activeRecord.workMode) {
            setWorkMode(activeRecord.workMode as 'on_site' | 'wfh');
          }

          // Synchronize TanStack Query cache so parent dashboard reflects clocked-in state immediately
          queryClient.setQueryData(['employeeAttendanceToday', employee.id], activeRecord);
          handleAttendanceChange();

          toast.success('Session synchronized: You are already clocked in for today.');

          // Reset modal state
          setShowLateReasonModal(false);
          setLateReason('');
          setPendingClockIn(false);
          validatedLocationRef.current = null;
          return;
        }
      }

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

  const handleTakeBreak = async () => {
    if (!employee?.id) return;

    setLoading(true);
    try {
      const record = await globalAttendanceService.takeBreak(employee.id);
      setTodayRecord(record);
      setIsOnBreak(true);
      toast.success('Break started: Work paused');

      queryClient.setQueryData(['employeeAttendanceToday', employee.id], record);
      handleAttendanceChange();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Take break failed');
    } finally {
      setLoading(false);
    }
  };

  const handleResumeWork = async () => {
    if (!employee?.id) return;

    setLoading(true);
    try {
      const record = await globalAttendanceService.resumeWork(employee.id);
      setTodayRecord(record);
      setIsOnBreak(false);
      toast.success('Work resumed!');

      queryClient.setQueryData(['employeeAttendanceToday', employee.id], record);
      handleAttendanceChange();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Resume work failed');
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

  // Synchronize with parent todayRecord prop whenever it changes
  useEffect(() => {
    if (propTodayRecord !== undefined) {
      setTodayRecord(propTodayRecord);
      setIsInitializing(false);
      if (propTodayRecord) {
        const onBreak = propTodayRecord.breaks?.some(b => !b.endTime && !b.end) || false;
        setIsOnBreak(onBreak);
        if (propTodayRecord.workMode) {
          setWorkMode(propTodayRecord.workMode as 'on_site' | 'wfh');
        }
      }
    }
  }, [propTodayRecord]);

  // Background location acquisition for On-Site mode only
  useEffect(() => {
    if (workMode !== 'on_site' || todayRecord?.clockIn) return;

    const requestLocation = () => {
      if (isLocalEnvironment()) {
        setIsDevBypassActive(true);
      }

      if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
          (position) => {
            const { latitude, longitude, accuracy } = position.coords;
            setCurrentLocation({ latitude, longitude, accuracy });
            const dist = Math.round(
              calculateDistance(
                latitude,
                longitude,
                envConfig.officeLatitude,
                envConfig.officeLongitude
              )
            );
            setOfficeDistance(dist);
            if (isLocalEnvironment() || isOfficeNetworkVerified || dist <= envConfig.geofenceRadiusMeters) {
              setLocationError(null);
            } else {
              setLocationError(`You are ${dist}m away from the office (allowed: ${envConfig.geofenceRadiusMeters}m).`);
            }
          },
          (error) => {
            if (isLocalEnvironment()) {
              setIsDevBypassActive(true);
              setLocationError(null);
            } else if (error.code === error.PERMISSION_DENIED) {
              setLocationError('Location permission denied. Please allow location access or verify via office network.');
            }
          },
          { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
        );
      }
    };

    requestLocation();
    const locationInterval = setInterval(requestLocation, 30000);
    return () => clearInterval(locationInterval);
  }, [workMode, todayRecord?.clockIn, isOfficeNetworkVerified]);

  // Fetch today's attendance record on mount (or when employee changes)
  // fetchTodayRecord is defined OUTSIDE useEffect so it gets a stable reference
  const fetchTodayRecord = useCallback(async () => {
    if (!employee?.id) {
      setIsInitializing(false);
      return;
    }

    try {
      const record = await globalAttendanceService.getTodayAttendance(employee.id);
      if (record) {
        setTodayRecord(record);
        const onBreak = record.breaks?.some(breakSession => !breakSession.endTime && !breakSession.end) || false;
        setIsOnBreak(onBreak);
        if (record.workMode) {
          setWorkMode(record.workMode as 'on_site' | 'wfh');
        }
        // Keep TanStack Query cache in sync
        queryClient.setQueryData(['employeeAttendanceToday', employee.id], record);
      } else {
        setTodayRecord(null);
        setIsOnBreak(false);
      }
    } catch (err) {
      console.error('Failed to fetch today attendance on mount:', err);
    } finally {
      setIsInitializing(false);
    }
  }, [employee?.id, queryClient]);

  // Load software usage summary for today's active session
  const loadSoftwareSummary = useCallback(async (recordId: string) => {
    try {
      setLoadingSoftware(true);
      const summary = await globalAttendanceService.getSoftwareUsageSummary(recordId);
      setSoftwareSummary(summary);
    } catch (err) {
      console.error('Failed to load software usage summary:', err);
    } finally {
      setLoadingSoftware(false);
    }
  }, []);

  useEffect(() => {
    if (todayRecord?.id) {
      loadSoftwareSummary(todayRecord.id);
    } else {
      setSoftwareSummary([]);
    }
  }, [todayRecord?.id, loadSoftwareSummary]);

  const handleLogSoftware = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!todayRecord?.id || !softwareForm.name.trim()) return;

    try {
      await globalAttendanceService.logSoftwareUsage({
        attendanceId: todayRecord.id,
        softwareName: softwareForm.name.trim(),
        category: softwareForm.category,
        durationSeconds: Math.max(1, softwareForm.minutes) * 60,
        activityScore: 100
      });
      toast.success(`Logged ${softwareForm.name.trim()} usage`);
      setShowLogSoftwareModal(false);
      setSoftwareForm({ name: '', category: 'development', minutes: 30 });
      if (todayRecord.id) {
        await loadSoftwareSummary(todayRecord.id);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to log software');
    }
  };

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

      {/* Active Shift Mode Badge (When already clocked in) */}
      {todayRecord?.clockIn && (
        <div className="flex items-center justify-between bg-gray-50 dark:bg-neutral-800/50 border border-gray-100 dark:border-neutral-800 rounded-xl px-4 py-2.5 mb-4">
          <span className="text-xs font-medium text-gray-500 dark:text-neutral-400">Current Work Mode</span>
          <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold ${
            todayRecord.workMode === 'wfh'
              ? 'bg-blue-100 text-blue-800 dark:bg-blue-950/60 dark:text-blue-300'
              : 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300'
          }`}>
            {todayRecord.workMode === 'wfh' ? (
              <>
                <Home className="w-3.5 h-3.5" />
                Work From Home
              </>
            ) : (
              <>
                <Building2 className="w-3.5 h-3.5" />
                On-Site Office
              </>
            )}
          </span>
        </div>
      )}

      {/* 1. Mode Selector (Always visible before clock-in) */}
      {!todayRecord?.clockIn && (
        <div className="bg-gray-50 dark:bg-neutral-800/60 rounded-2xl p-4 mb-4 border border-gray-100 dark:border-neutral-800">
          <div className="flex items-center justify-between mb-2.5">
            <span className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-neutral-400">
              Select Work Mode
            </span>
            <span className="text-xs font-medium text-brand">
              {workMode === 'on_site' ? '🏢 Office Geofenced' : '🏠 Remote Attendance'}
            </span>
          </div>

          <div className="grid grid-cols-2 gap-2 p-1 bg-gray-200/80 dark:bg-neutral-900 rounded-xl">
            <button
              id="mode-on-site-btn"
              type="button"
              onClick={() => handleWorkModeChange('on_site')}
              className={`flex items-center justify-center gap-2 py-3 px-4 rounded-lg font-medium text-sm transition-all duration-200 ${
                workMode === 'on_site'
                  ? 'bg-white dark:bg-neutral-800 text-gray-900 dark:text-white shadow-sm ring-1 ring-black/5 dark:ring-white/10 font-semibold'
                  : 'text-gray-600 dark:text-neutral-400 hover:text-gray-900 dark:hover:text-white'
              }`}
            >
              <Building2 className="w-4 h-4" />
              <span>On-Site</span>
            </button>

            <button
              id="mode-wfh-btn"
              type="button"
              onClick={() => handleWorkModeChange('wfh')}
              className={`flex items-center justify-center gap-2 py-3 px-4 rounded-lg font-medium text-sm transition-all duration-200 ${
                workMode === 'wfh'
                  ? 'bg-white dark:bg-neutral-800 text-blue-600 dark:text-blue-400 shadow-sm ring-1 ring-blue-500/20 font-semibold'
                  : 'text-gray-600 dark:text-neutral-400 hover:text-gray-900 dark:hover:text-white'
              }`}
            >
              <Home className="w-4 h-4" />
              <span>Work From Home</span>
            </button>
          </div>
        </div>
      )}

      {/* 2. Conditional Location / Geofence Banner */}
      {!todayRecord?.clockIn && (
        <div className={`rounded-xl p-4 mb-4 border transition-all ${
          workMode === 'wfh'
            ? 'bg-blue-50/70 border-blue-200 dark:bg-blue-950/30 dark:border-blue-900/50'
            : isDevBypassActive || isOfficeNetworkVerified || (officeDistance !== null && officeDistance <= envConfig.geofenceRadiusMeters)
              ? 'bg-emerald-50/70 border-emerald-200 dark:bg-emerald-950/30 dark:border-emerald-900/50'
              : locationError
                ? 'bg-red-50/80 border-red-200 dark:bg-red-950/30 dark:border-red-900/50'
                : 'bg-gray-50 dark:bg-neutral-800/40 border-gray-200 dark:border-neutral-800'
        }`}>
          {workMode === 'wfh' ? (
            <div className="flex items-start gap-3">
              <div className="p-2 rounded-lg bg-blue-100 dark:bg-blue-900/40 text-blue-600 dark:text-blue-400 mt-0.5">
                <Home className="w-4 h-4" />
              </div>
              <div className="flex-1">
                <p className="text-sm font-semibold text-blue-900 dark:text-blue-200">
                  WFH Mode: Location Check Skipped
                </p>
                <p className="text-xs text-blue-700 dark:text-blue-300 mt-0.5 leading-relaxed">
                  Remote attendance does not require office proximity or GPS verification. You can clock in directly from anywhere.
                </p>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <div className="flex items-start gap-3">
                <div className={`p-2 rounded-lg mt-0.5 ${
                  isDevBypassActive || isOfficeNetworkVerified || (officeDistance !== null && officeDistance <= envConfig.geofenceRadiusMeters)
                    ? 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-600 dark:text-emerald-400'
                    : locationError
                      ? 'bg-red-100 dark:bg-red-900/40 text-red-600 dark:text-red-400'
                      : 'bg-gray-200 dark:bg-neutral-700 text-gray-700 dark:text-gray-300'
                }`}>
                  {isOfficeNetworkVerified ? <Wifi className="w-4 h-4" /> : <MapPin className="w-4 h-4" />}
                </div>

                <div className="flex-1">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-semibold text-gray-900 dark:text-white">
                      On-Site Location & Network Status
                    </p>
                    <span className={`text-xs font-semibold px-2 py-0.5 rounded ${
                      isDevBypassActive
                        ? 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200'
                        : isOfficeNetworkVerified
                          ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200'
                          : officeDistance !== null && officeDistance <= envConfig.geofenceRadiusMeters
                            ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200'
                            : 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200'
                    }`}>
                      {isDevBypassActive
                        ? '⚡ Localhost Dev Bypass'
                        : isOfficeNetworkVerified
                          ? '📡 Office Network Verified'
                          : officeDistance !== null
                            ? `${officeDistance}m away (Max: ${envConfig.geofenceRadiusMeters}m)`
                            : 'GPS Required'}
                    </span>
                  </div>

                  <p className="text-xs text-gray-600 dark:text-neutral-400 mt-1 leading-relaxed">
                    {isDevBypassActive ? (
                      <span className="text-emerald-600 dark:text-emerald-400 font-medium">
                        ✓ Localhost development environment recognized ({window.location.hostname}). Strict geofence requirement bypassed for testing.
                      </span>
                    ) : isOfficeNetworkVerified ? (
                      <span className="text-emerald-600 dark:text-emerald-400 font-medium">
                        ✓ Verified via Office Network ({clientPublicIP || 'Local Subnet'}). Ready to clock in!
                      </span>
                    ) : locationError ? (
                      <span className="text-red-600 dark:text-red-400 font-medium">{locationError}</span>
                    ) : officeDistance !== null && officeDistance <= envConfig.geofenceRadiusMeters ? (
                      <span className="text-emerald-600 dark:text-emerald-400 font-medium">
                        ✓ Within office geofence radius ({officeDistance}m / {envConfig.geofenceRadiusMeters}m). Ready to clock in!
                      </span>
                    ) : (
                      <span>Acquiring GPS coordinates to verify office proximity...</span>
                    )}
                  </p>
                </div>
              </div>

              {/* Action Buttons for Override / Manual GPS Retry / Network Verification */}
              <div className="flex flex-wrap items-center gap-2 pt-1 border-t border-gray-100 dark:border-neutral-800/80">
                <button
                  type="button"
                  onClick={handleRetryGPS}
                  disabled={isValidating}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-white dark:bg-neutral-800 text-gray-700 dark:text-neutral-200 hover:bg-gray-100 dark:hover:bg-neutral-700 border border-gray-200 dark:border-neutral-700 transition-colors shadow-sm disabled:opacity-50"
                >
                  <RotateCcw className={`w-3.5 h-3.5 ${isValidating ? 'animate-spin' : ''}`} />
                  Retry GPS
                </button>

                <button
                  type="button"
                  onClick={checkOfficeNetwork}
                  disabled={isCheckingNetwork}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-white dark:bg-neutral-800 text-gray-700 dark:text-neutral-200 hover:bg-gray-100 dark:hover:bg-neutral-700 border border-gray-200 dark:border-neutral-700 transition-colors shadow-sm disabled:opacity-50"
                >
                  <Wifi className={`w-3.5 h-3.5 ${isCheckingNetwork ? 'animate-pulse text-brand' : ''}`} />
                  {isCheckingNetwork ? 'Checking...' : 'Verify Office Network'}
                </button>

                {isLocalEnvironment() && !isDevBypassActive && (
                  <button
                    type="button"
                    onClick={() => {
                      setIsDevBypassActive(true);
                      setLocationError(null);
                      toast.success('Localhost dev bypass activated');
                    }}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 hover:bg-blue-100 dark:hover:bg-blue-900/60 border border-blue-200 dark:border-blue-800 transition-colors"
                  >
                    <ShieldCheck className="w-3.5 h-3.5" />
                    Dev Bypass
                  </button>
                )}

                {locationError && (
                  <button
                    type="button"
                    onClick={() => handleWorkModeChange('wfh')}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-brand hover:underline transition-colors ml-auto"
                  >
                    <Home className="w-3.5 h-3.5" />
                    Switch to WFH
                  </button>
                )}
              </div>
            </div>
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
            id="clock-in-btn"
            onClick={handleClockIn}
            disabled={loading || isValidating}
            className="relative group overflow-hidden w-full rounded-2xl bg-brand hover:bg-brand/90 text-white shadow-md dark:bg-white/[0.05] dark:hover:bg-white/[0.1] px-6 py-4 text-sm font-medium transition-all duration-500 ease-out border border-transparent dark:border-white/[0.1] dark:backdrop-blur-xl dark:shadow-[0_8px_32px_rgba(0,0,0,0.5),inset_0_4px_16px_rgba(255,255,255,0.15),inset_0_-4px_16px_rgba(0,0,0,0.4)] dark:hover:shadow-[0_8px_32px_rgba(0,0,0,0.6),inset_0_6px_20px_rgba(255,255,255,0.25),inset_0_-4px_16px_rgba(0,0,0,0.5)] disabled:opacity-50 disabled:cursor-not-allowed active:scale-[0.97]"
          >
            <span className="absolute inset-x-0 top-0 h-px hidden dark:block bg-gradient-to-r from-transparent via-white/50 to-transparent opacity-50 group-hover:opacity-100 transition-opacity duration-500"></span>
            <span className="absolute inset-0 z-0 hidden dark:block bg-[radial-gradient(ellipse_at_top,rgba(255,255,255,0.15)_0%,transparent_70%)] opacity-0 group-hover:opacity-100 transition-opacity duration-700"></span>
            <span className="relative z-10 flex items-center justify-center tracking-wide dark:drop-shadow-[0_2px_4px_rgba(0,0,0,0.5)]">
              <Play className="mr-2 h-5 w-5" />
              <span>
                {isValidating
                  ? (workMode === 'on_site' ? 'Verifying Office Geofence...' : 'Validating...')
                  : loading
                    ? 'Clocking In...'
                    : workMode === 'wfh'
                      ? 'Clock In (Work From Home)'
                      : 'Clock In (On-Site)'}
              </span>
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
                    onClick={handleTakeBreak}
                    disabled={loading}
                    className="relative group overflow-hidden flex-1 rounded-2xl bg-white hover:bg-gray-50 text-gray-700 border border-gray-200 shadow-sm dark:bg-white/[0.05] dark:hover:bg-white/[0.1] px-6 py-4 text-sm font-medium dark:text-slate-200 transition-all duration-500 ease-out dark:border-white/[0.1] dark:backdrop-blur-xl dark:shadow-[0_8px_32px_rgba(0,0,0,0.5),inset_0_4px_16px_rgba(255,255,255,0.15),inset_0_-4px_16px_rgba(0,0,0,0.4)] dark:hover:shadow-[0_8px_32px_rgba(0,0,0,0.6),inset_0_6px_20px_rgba(255,255,255,0.25),inset_0_-4px_16px_rgba(0,0,0,0.5)] disabled:opacity-50 disabled:cursor-not-allowed active:scale-[0.97]"
                  >
                    <span className="absolute inset-x-0 top-0 h-px hidden dark:block bg-gradient-to-r from-transparent via-white/50 to-transparent opacity-50 group-hover:opacity-100 transition-opacity duration-500"></span>
                    <span className="absolute inset-0 z-0 hidden dark:block bg-[radial-gradient(ellipse_at_top,rgba(255,255,255,0.15)_0%,transparent_70%)] opacity-0 group-hover:opacity-100 transition-opacity duration-700"></span>
                    <span className="relative z-10 flex items-center justify-center tracking-wide dark:drop-shadow-[0_2px_4px_rgba(0,0,0,0.5)]">
                      <Coffee className="mr-2 h-4 w-4 text-gray-400 group-hover:text-gray-700 dark:text-slate-300 dark:group-hover:text-white transition-colors duration-300" />
                      <span>{loading ? 'Pausing...' : 'Take Break'}</span>
                    </span>
                  </button>
                ) : (
                  <button
                    onClick={handleResumeWork}
                    disabled={loading}
                    className="relative group overflow-hidden flex-1 rounded-2xl bg-emerald-600 hover:bg-emerald-700 text-white shadow-md dark:bg-emerald-600/80 dark:hover:bg-emerald-600 px-6 py-4 text-sm font-medium transition-all duration-500 ease-out border border-transparent dark:border-emerald-500/30 dark:backdrop-blur-xl dark:shadow-[0_8px_32px_rgba(16,185,129,0.3)] disabled:opacity-50 disabled:cursor-not-allowed active:scale-[0.97]"
                  >
                    <span className="absolute inset-x-0 top-0 h-px hidden dark:block bg-gradient-to-r from-transparent via-white/60 to-transparent opacity-60 group-hover:opacity-100 transition-opacity duration-500"></span>
                    <span className="absolute inset-0 z-0 hidden dark:block bg-[radial-gradient(ellipse_at_top,rgba(255,255,255,0.2)_0%,transparent_70%)] opacity-0 group-hover:opacity-100 transition-opacity duration-700"></span>
                    <span className="relative z-10 flex items-center justify-center tracking-wide dark:drop-shadow-[0_2px_4px_rgba(0,0,0,0.5)]">
                      <Play className="mr-2 h-4 w-4" />
                      <span>{loading ? 'Resuming...' : <>Resume Work ({todayRecord?.breaks.find(b => !b.endTime && !b.end)?.startTime ? <LiveBreakDuration breakStartTime={todayRecord!.breaks.find(b => !b.endTime && !b.end)!.startTime!} /> : '0m'})</>}</span>
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
                  isOnBreak ? 'Resume Work First' :
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

      {/* Software & Tools Monitoring */}
      {todayRecord?.clockIn && (
        <div className="mt-6 border-t border-gray-100 dark:border-neutral-800 pt-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-medium text-gray-900 dark:text-white flex items-center gap-1.5">
              <Monitor className="h-4 w-4 text-brand" />
              Software & Tools Used Today
            </h3>
            <button
              type="button"
              onClick={() => setShowLogSoftwareModal(true)}
              className="text-xs font-medium text-brand hover:underline inline-flex items-center gap-1"
            >
              <Plus className="h-3.5 w-3.5" />
              Log Tool
            </button>
          </div>

          {loadingSoftware ? (
            <div className="py-3 text-center text-xs text-gray-500 dark:text-neutral-400">
              Loading software usage...
            </div>
          ) : softwareSummary.length > 0 ? (
            <div className="space-y-2">
              {softwareSummary.map((item, index) => (
                <div
                  key={index}
                  className="flex items-center justify-between p-2.5 rounded-xl bg-gray-50 dark:bg-neutral-800/60 border border-gray-100 dark:border-neutral-800 text-xs"
                >
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-gray-900 dark:text-white">{item.softwareName}</span>
                    <span className="px-2 py-0.5 rounded-full text-[10px] uppercase font-medium tracking-wide bg-brand/10 text-brand">
                      {item.category}
                    </span>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="font-mono text-gray-600 dark:text-neutral-300">
                      {formatDuration(item.totalSeconds / 3600)}
                    </span>
                    <span className="text-[11px] text-gray-400">
                      {item.avgActivityPercentage}% active
                    </span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="p-3 text-center rounded-xl bg-gray-50 dark:bg-neutral-800/40 text-xs text-gray-500 dark:text-neutral-400">
              No software usage logged yet today. Tools tracked by the desktop agent or logged manually will appear here.
            </div>
          )}
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

      {/* Log Software Modal */}
      {showLogSoftwareModal && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-white dark:bg-neutral-900 rounded-2xl p-6 w-full max-w-md shadow-xl border border-gray-100 dark:border-neutral-800">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-2 flex items-center gap-2">
              <Monitor className="h-5 w-5 text-brand" />
              Log Software / Tool Used
            </h3>
            <p className="text-xs text-gray-500 dark:text-neutral-400 mb-4">
              Record tools and software utilized during your work hours for productivity monitoring.
            </p>
            <form onSubmit={handleLogSoftware} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-gray-700 dark:text-neutral-300 mb-1">
                  Software / Tool Name
                </label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Visual Studio Code, Slack, Figma"
                  value={softwareForm.name}
                  onChange={(e) => setSoftwareForm(prev => ({ ...prev, name: e.target.value }))}
                  className="w-full px-3 py-2 text-sm rounded-xl border border-gray-200 dark:border-neutral-700 bg-white dark:bg-black text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-brand"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-700 dark:text-neutral-300 mb-1">
                    Category
                  </label>
                  <select
                    value={softwareForm.category}
                    onChange={(e) => setSoftwareForm(prev => ({ ...prev, category: e.target.value as any }))}
                    className="w-full px-3 py-2 text-sm rounded-xl border border-gray-200 dark:border-neutral-700 bg-white dark:bg-black text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-brand"
                  >
                    <option value="development">Development</option>
                    <option value="communication">Communication</option>
                    <option value="browsing">Browsing</option>
                    <option value="productivity">Productivity</option>
                    <option value="design">Design</option>
                    <option value="office">Office</option>
                    <option value="general">General</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-700 dark:text-neutral-300 mb-1">
                    Duration (Minutes)
                  </label>
                  <input
                    type="number"
                    min="1"
                    max="720"
                    value={softwareForm.minutes}
                    onChange={(e) => setSoftwareForm(prev => ({ ...prev, minutes: parseInt(e.target.value, 10) || 1 }))}
                    className="w-full px-3 py-2 text-sm rounded-xl border border-gray-200 dark:border-neutral-700 bg-white dark:bg-black text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-brand"
                  />
                </div>
              </div>

              <div className="flex justify-end gap-3 pt-3">
                <button
                  type="button"
                  onClick={() => setShowLogSoftwareModal(false)}
                  className="px-4 py-2 text-sm text-gray-600 dark:text-neutral-400 hover:bg-gray-100 dark:hover:bg-neutral-800 rounded-xl"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 text-sm font-medium text-white bg-brand hover:bg-brand/90 rounded-xl shadow-sm"
                >
                  Save Tool Log
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

export default ClockInOutNew;
