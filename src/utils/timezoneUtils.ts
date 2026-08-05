import { parseISO, isValid } from 'date-fns';
import { zonedTimeToUtc, utcToZonedTime, formatInTimeZone } from 'date-fns-tz';

/**
 * CANONICAL TIMEZONE ARCHITECTURE
 * All temporal operations in the application use this single source of truth.
 * Completely eliminates timezone desync vulnerabilities by enforcing
 * that all date math, comparisons, and rendering use the office timezone.
 */

// Office canonical timezone - override with environment variable
export const OFFICE_TIMEZONE = import.meta.env.VITE_OFFICE_TIMEZONE || 'Asia/Kolkata';

// ============================================================================
// CORE PARSING FUNCTIONS - Use these INSTEAD OF new Date() EVERYWHERE
// ============================================================================

/**
 * Converts any UTC timestamp string/Date from database to a Date object
 * that represents the SAME ABSOLUTE TIME, but all local getters (getHours, getDate, etc.)
 * will return values in the OFFICE TIMEZONE, NOT the user's browser timezone.
 * 
 * USE THIS INSTEAD OF new Date(timestamp) FOR ALL DATABASE TIMESTAMPS
 */
export const toOfficeDate = (timestamp: string | Date): Date => {
  if (!timestamp) {
    return new Date();
  }
  
  const utcDate = typeof timestamp === 'string' ? parseISO(timestamp) : timestamp;
  
  if (!isValid(utcDate)) {
    return new Date();
  }
  
  return utcToZonedTime(utcDate, OFFICE_TIMEZONE);
};

/**
 * Safely parse timestamp with null handling for optional fields
 */
export const toOfficeDateSafe = (timestamp: string | Date | null | undefined): Date | undefined => {
  if (!timestamp) return undefined;
  try {
    return toOfficeDate(timestamp);
  } catch {
    return undefined;
  }
};

/**
 * Get current time as an office-normalized Date object
 * USE THIS INSTEAD OF new Date() FOR ALL CURRENT TIME REFERENCES
 */
export const getOfficeNow = (): Date => {
  return utcToZonedTime(new Date(), OFFICE_TIMEZONE);
};

/**
 * Get today's date string in office timezone (ISO format YYYY-MM-DD)
 * USE THIS INSTEAD OF new Date().toISOString().split('T')[0]
 */
export const getOfficeTodayIso = (): string => {
  return formatOffice(getOfficeNow(), 'yyyy-MM-dd');
};

/**
 * Get today's date string in office timezone (DD-MM-YYYY format)
 */
export const getOfficeTodayDDMMYYYY = (): string => {
  return formatOffice(getOfficeNow(), 'dd-MM-yyyy');
};

// ============================================================================
// DATE MATH / COMPARISON HELPERS
// ============================================================================

/**
 * Create a Date object at a specific time IN THE OFFICE TIMEZONE
 * Used for fixed reference points like work start/end times
 */
export const createOfficeTime = (date: Date, hour: number, minute: number = 0, second: number = 0): Date => {
  const officeDate = utcToZonedTime(date, OFFICE_TIMEZONE);
  officeDate.setHours(hour, minute, second, 0);
  return zonedTimeToUtc(officeDate, OFFICE_TIMEZONE);
};

/**
 * Check if a timestamp is before a reference time in office timezone
 */
export const isBeforeOfficeTime = (timestamp: Date, hour: number, minute: number = 0): boolean => {
  const referenceTime = createOfficeTime(timestamp, hour, minute);
  return timestamp.getTime() < referenceTime.getTime();
};

/**
 * Check if a timestamp is after a reference time in office timezone
 */
export const isAfterOfficeTime = (timestamp: Date, hour: number, minute: number = 0): boolean => {
  const referenceTime = createOfficeTime(timestamp, hour, minute);
  return timestamp.getTime() > referenceTime.getTime();
};

/**
 * Check if a timestamp is between two times in office timezone
 */
export const isBetweenOfficeTimes = (
  timestamp: Date,
  startHour: number,
  startMinute: number,
  endHour: number,
  endMinute: number
): boolean => {
  const startTime = createOfficeTime(timestamp, startHour, startMinute);
  const endTime = createOfficeTime(timestamp, endHour, endMinute);
  const ts = timestamp.getTime();
  return ts >= startTime.getTime() && ts <= endTime.getTime();
};

// ============================================================================
// FORMATTING FUNCTIONS - Use these for ALL UI DISPLAY
// ============================================================================

/**
 * Format any UTC timestamp for display in OFFICE TIMEZONE
 * USE THIS INSTEAD OF date-fns format() AND toLocale*String() EVERYWHERE
 */
export const formatOffice = (timestamp: string | Date, formatStr: string): string => {
  if (!timestamp) return '--:--';
  
  try {
    const date = typeof timestamp === 'string' ? parseISO(timestamp) : timestamp;
    return formatInTimeZone(date, OFFICE_TIMEZONE, formatStr);
  } catch {
    return '--:--';
  }
};

/**
 * Standard time format for clocks (HH:mm:ss)
 */
export const formatOfficeTimeLong = (timestamp: string | Date): string => {
  return formatOffice(timestamp, 'HH:mm:ss');
};

/**
 * Standard time format for tables (HH:mm)
 */
export const formatOfficeTimeShort = (timestamp: string | Date): string => {
  return formatOffice(timestamp, 'HH:mm');
};

/**
 * Standard time format with AM/PM (h:mm a)
 */
export const formatOfficeTimeAmPm = (timestamp: string | Date): string => {
  return formatOffice(timestamp, 'h:mm a');
};

/**
 * Standard date format (EEEE, MMMM d, yyyy)
 */
export const formatOfficeDateLong = (timestamp: string | Date): string => {
  return formatOffice(timestamp, 'EEEE, MMMM d, yyyy');
};

/**
 * Standard date format (dd-MM-yyyy)
 */
export const formatOfficeDateShort = (timestamp: string | Date): string => {
  return formatOffice(timestamp, 'dd-MM-yyyy');
};

/**
 * Standard month format (MMMM yyyy)
 */
export const formatOfficeMonth = (timestamp: string | Date): string => {
  return formatOffice(timestamp, 'MMMM yyyy');
};

// ============================================================================
// LEGACY COMPATIBILITY WRAPPERS
// ============================================================================

/**
 * Backwards compatibility wrapper for existing code expecting Date objects
 * @deprecated Use toOfficeDate instead
 */
export const safeParseDate = (timestamp: string | Date): Date => {
  return toOfficeDate(timestamp);
};
