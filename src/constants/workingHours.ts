import { createOfficeTime, formatOffice } from '../utils/timezoneUtils';
import { configService } from '../services/configService';
import type { RoleSchedule } from '../types';
import { supabase } from '../services/supabaseClient';

// ----------------------------------------------------------------------------
// LEGACY BRIDGE — DO NOT USE IN NEW CODE
// ----------------------------------------------------------------------------
// The WORKING_HOURS singleton has been removed. All consumers must pass an
// explicit RoleSchedule object to helper functions. This file now provides
// only stateless utility functions that operate on provided schedule data.
// ----------------------------------------------------------------------------

// ----------------------------------------------------------------------------
// Type Definitions
// ----------------------------------------------------------------------------
export type {
  RoleSchedule
};

// ----------------------------------------------------------------------------
// PUBLIC API — Async schedule fetchers
// ----------------------------------------------------------------------------

/**
 * Fetch the schedule for a given role from role_schedules.
 * Primary entry point for all role-based schedule lookups.
 */
export async function getScheduleForRole(role: string): Promise<RoleSchedule | null> {
  return await configService.getScheduleByRole(role);
}

/**
 * Convenience wrapper: fetch schedule for a specific employee (by ID).
 * Looks up employee's role first, then fetches role_schedule.
 */
export async function getScheduleForEmployee(employeeId: string): Promise<RoleSchedule | null> {
  try {
    const { data: employee, error } = await supabase
      .from('employees')
      .select('role')
      .eq('id', employeeId)
      .single();

    if (error || !employee) {
      console.error('Failed to fetch employee for schedule lookup:', error);
      return null;
    }

    return await getScheduleForRole(employee.role);
  } catch (e) {
    console.error('Error fetching schedule for employee:', e);
    return null;
  }
}

export function getWorkStartTime(schedule: RoleSchedule, date: Date): Date {
  return createOfficeTime(date, schedule.start_hour, schedule.start_minute);
}

export function getWorkEndTime(schedule: RoleSchedule, date: Date): Date {
  return createOfficeTime(date, schedule.end_hour, schedule.end_minute);
}

export function getLunchStartTime(schedule: RoleSchedule, date: Date): Date {
  return createOfficeTime(date, schedule.lunch_start_hour, schedule.lunch_start_minute);
}

export function getLunchEndTime(schedule: RoleSchedule, date: Date): Date {
  return createOfficeTime(date, schedule.lunch_end_hour, schedule.lunch_end_minute);
}

export function isLateArrival(schedule: RoleSchedule, clockInTime: Date): boolean {
  // Compare wall-clock times in the OFFICE TIMEZONE — no epoch arithmetic.
  // formatOffice accounts for timezone and DST correctly.
  const [ciH, ciM] = formatOffice(clockInTime, 'HH:mm').split(':').map(Number);
  const [wsH, wsM] = [schedule.start_hour, schedule.start_minute];
  return ciH > wsH || (ciH === wsH && ciM > wsM);
}

export function isEarlyDeparture(schedule: RoleSchedule, clockOutTime: Date): boolean {
  const workEnd = getWorkEndTime(schedule, clockOutTime);
  return clockOutTime.getTime() < workEnd.getTime();
}

export function calculateOvertime(schedule: RoleSchedule, workedHours: number): number {
  return Math.max(0, workedHours - schedule.standard_work_hours);
}

export function calculateLateMinutes(schedule: RoleSchedule, clockInTime: Date): number {
  const workStart = getWorkStartTime(schedule, clockInTime);
  if (clockInTime.getTime() <= workStart.getTime()) return 0;
  return Math.floor((clockInTime.getTime() - workStart.getTime()) / (1000 * 60));
}

export function formatWorkingHours(schedule: RoleSchedule): string {
  const format = (h: number, m: number) => {
    const period = h >= 12 ? 'PM' : 'AM';
    const displayHour = h % 12 === 0 ? 12 : h % 12;
    return `${displayHour}:${m.toString().padStart(2, '0')} ${period}`;
  };
  return `${format(schedule.start_hour, schedule.start_minute)} - ${format(schedule.end_hour, schedule.end_minute)}`;
}

// ----------------------------------------------------------------------------
// DEFAULT FALLBACK SCHEDULE
// ----------------------------------------------------------------------------
/**
 * Centralized default RoleSchedule used when no role_schedules row exists.
 * Matches the legacy 10:00–20:00 shift with 14:00–15:00 lunch and 10h target.
 */
export const DEFAULT_ROLE_SCHEDULE: RoleSchedule = {
  role: 'employee',
  start_hour: 14,         
  start_minute: 0,
  end_hour: 21,           
  end_minute: 0,
  standard_work_hours: 7, 
  lunch_start_hour: 17,   
  lunch_start_minute: 0,
  lunch_end_hour: 18,     
  lunch_end_minute: 0,
  overtime_threshold: 7   
};