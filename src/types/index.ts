export interface UserSettings {
  theme: 'light' | 'dark' | 'system';
  notifications: {
    clockInReminder: boolean;
    clockOutReminder: boolean;
    breakReminder: boolean;
    weeklyReport: boolean;
    sound: boolean;
  };
  workPreferences: {
    defaultBreakDuration: number;
    timezone: string;
    dateFormat: 'DD/MM/YYYY' | 'MM/DD/YYYY' | 'YYYY-MM-DD';
    timeFormat: '12h' | '24h';
  };
  privacy: {
    shareLocation: boolean;
    trackProductivity: boolean;
  };
  language: string;
}

export interface Employee {
  id: string;
  uid?: string; // Firebase Auth UID (same as id, but kept for clarity)
  employeeId?: string;
  name: string;
  Name?: string; // Alternative field name used in Firestore
  email: string;
  // NO password field - handled entirely by Firebase Auth with reset emails
  role: 'admin' | 'core' | 'employee' | 'trainee' | 'intern';
  department: string;
  position: string;
  designation?: string; // Additional field for job title/designation
  Designation?: string; // Alternative field name used in Firestore (capital D)
  isActive: boolean;
  joinDate?: string;
  phone_number?: string; // PHASE 1: New contact fields
  personal_email?: string;
  // PHASE 2: Typed user-settings columns persisted directly on employees
  default_break_duration?: number;
  break_reminder_enabled?: boolean;
  sound_enabled?: boolean;
  createdAt: Date;
  lastLogin?: Date;
  // PHASE 2 (transition): Optional settings JSONB blob – carries theme / language /
  // dateFormat. Matrix values (break_reminder_enabled, sound_enabled,
  // default_break_duration) have dedicated typed columns; they are written
  // separately via update_own_settings RPC and updateUserSettings admin path.
  settings?: Partial<UserSettings>;
}
export interface AttendanceRecord {
  id?: string;
  userId: string;
  userName: string;
  userEmail: string;
  employeeId?: string; // For backward compatibility
  employeeName?: string; // For backward compatibility
  department: string;
  date: string;
  clockIn?: Date;
  clockOut?: Date;
  lunchStart?: Date;
  lunchEnd?: Date;
  breaks: BreakTime[]; // Updated field name for consistency
  breakTimes?: BreakTime[]; // For backward compatibility
  location?: GeolocationData;
  clientIP?: string; // Audit: Client IP address used for clock in
  earlyLogoutReason?: string;
  lateReason?: string; // Added for late arrival reasons
  isLate?: boolean; // Added for late status
  isLateFromLunch?: boolean; // Added for lunch late status
  lunchLateReason?: string; // Added for lunch late reasons
  overtime: number;
  status: 'present' | 'absent' | 'late' | 'partial' | 'half-day';
  totalHours: number;
  hoursWorked?: number; // Alternative field name used in components
  totalBreakHours?: number;
  totalBreakMinutes?: number; // Sum of break durations in minutes
  workMode?: 'on_site' | 'wfh';
  activeSeconds?: number;
  breakSeconds?: number;
  activityScore?: number;
  createdAt: Date;
  updatedAt?: Date;
}

export interface BreakTime {
  id?: string;
  start?: Date;
  startTime?: Date; // Alternative field name for consistency
  end?: Date;
  endTime?: Date; // Alternative field name for consistency
  reason?: string;
  type?: 'break' | 'lunch';
  duration?: number;
}

export interface GeolocationData {
  latitude: number;
  longitude: number;
  accuracy: number;
  timestamp: Date;
}

export interface Notification {
  id: string;
  type: 'early_logout' | 'overtime' | 'system';
  title: string;
  message: string;
  employeeId?: string;
  employeeName?: string;
  isRead: boolean;
  createdAt: Date;
  priority: 'low' | 'medium' | 'high';
}

export interface DailyStats {
  date: string;
  totalEmployees: number;
  present: number;
  absent: number;
  late: number;
  overtime: number;
}

export interface Meeting {
  id: string;
  title: string;
  description?: string;
  date: string;
  time: string;
  assignedEmployees: string[];
  createdBy: string;
  createdAt: Date;
  status: 'scheduled' | 'completed' | 'cancelled';
}

export interface LeaveRequest {
  id?: string;
  employeeId: string;
  employeeName: string;
  employeeEmail?: string;
  leaveType: 'sick' | 'vacation' | 'personal' | 'emergency' | 'other';
  startDate: string;
  endDate: string;
  reason: string;
  status: 'pending' | 'approved' | 'rejected';
  appliedAt?: Date;
  requestedAt?: string; // For backward compatibility
  reviewedAt?: Date;
  reviewedBy?: string;
  adminComments?: string;
}

// PHASE 1: Role-specific schedule configuration
export interface RoleSchedule {
  role: string;
  start_hour: number;
  start_minute: number;
  end_hour: number;
  end_minute: number;
  standard_work_hours: number;
  lunch_start_hour: number;
  lunch_start_minute: number;
  lunch_end_hour: number;
  lunch_end_minute: number;
  overtime_threshold: number;
  restDays?: number[];
}