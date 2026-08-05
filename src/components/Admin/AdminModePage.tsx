import { useState, useEffect } from 'react';
import { useAuth } from '../../hooks/useAuth';
import {
  Calendar,
  Clock,
  Search,
  Edit,
  Trash2,
  User,
  CalendarPlus,
  CheckCircle,
  XCircle,
  AlertCircle,
  FileText,
  Settings,
  Monitor
} from 'lucide-react';
import { userService } from '../../services/userService';
import { meetingService } from '../../services/meetingService';
import { Employee, Meeting } from '../../types';
import { format, parseISO, isToday } from 'date-fns';
import toast from 'react-hot-toast';
import LeaveManagement from './LeaveManagement';
import WorkingHoursSettingsForm from './WorkingHoursSettingsForm';
import WFHMonitoring from './WFHMonitoring';

interface MeetingFormData {
  title: string;
  description: string;
  date: string;
  time: string;
  assignedEmployees: string[];
}

const AdminModePage: React.FC = () => {
  const { user } = useAuth();
  const [activeTab, setActiveTab] = useState<'meetings' | 'leaves' | 'working-hours' | 'wfh'>('meetings');
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'scheduled' | 'completed' | 'cancelled'>('all');
  const [loading, setLoading] = useState(true);
  const [showAddMeeting, setShowAddMeeting] = useState(false);
  const [editingMeeting, setEditingMeeting] = useState<Meeting | null>(null);
  const [formData, setFormData] = useState<MeetingFormData>({
    title: '',
    description: '',
    date: '',
    time: '',
    assignedEmployees: []
  });

  const loadData = async () => {
    try {
      setLoading(true);
      const [meetingsData, employeesData] = await Promise.all([
        meetingService.getAllMeetings(),
        userService.getAllEmployees()
      ]);
      setMeetings(meetingsData);
      setEmployees(employeesData);
    } catch (error) {
      console.error('Failed to load data:', error);
      toast.error('Failed to load data');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const filteredMeetings = meetings.filter(meeting => {
    const matchesSearch = meeting.title.toLowerCase().includes(searchTerm.toLowerCase()) ||
      meeting.description?.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesStatus = statusFilter === 'all' || meeting.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  const resetForm = () => {
    setFormData({
      title: '',
      description: '',
      date: '',
      time: '',
      assignedEmployees: []
    });
    setEditingMeeting(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!formData.title.trim() || !formData.date || !formData.time) {
      toast.error('Please fill in all required fields');
      return;
    }

    try {
      if (editingMeeting) {
        // Update existing meeting
        await meetingService.updateMeeting(editingMeeting.id, {
          title: formData.title,
          description: formData.description,
          date: formData.date,
          time: formData.time,
          assignedEmployees: formData.assignedEmployees
        });
        toast.success('Meeting updated successfully');
      } else {
        // Create new meeting
        await meetingService.createMeeting({
          title: formData.title,
          description: formData.description,
          date: formData.date,
          time: formData.time,
          assignedEmployees: formData.assignedEmployees,
          createdBy: user?.id || ''
        });
        toast.success('Meeting created successfully');
      }

      resetForm();
      setShowAddMeeting(false);
      await loadData(); // Reload data
    } catch (error) {
      console.error('Error saving meeting:', error);
      toast.error('Failed to save meeting');
    }
  };

  const handleEdit = (meeting: Meeting) => {
    setEditingMeeting(meeting);
    setFormData({
      title: meeting.title,
      description: meeting.description || '',
      date: meeting.date,
      time: meeting.time,
      assignedEmployees: meeting.assignedEmployees
    });
    setShowAddMeeting(true);
  };

  const handleDelete = async (meetingId: string) => {
    if (!confirm('Are you sure you want to delete this meeting?')) return;

    try {
      await meetingService.deleteMeeting(meetingId);
      toast.success('Meeting deleted successfully');
      await loadData();
    } catch (error) {
      console.error('Error deleting meeting:', error);
      toast.error('Failed to delete meeting');
    }
  };

  const handleStatusChange = async (meetingId: string, status: Meeting['status']) => {
    try {
      await meetingService.updateMeetingStatus(meetingId, status);
      toast.success('Meeting status updated');
      await loadData();
    } catch (error) {
      console.error('Error updating status:', error);
      toast.error('Failed to update status');
    }
  };

  const toggleEmployeeSelection = (employeeId: string) => {
    setFormData(prev => ({
      ...prev,
      assignedEmployees: prev.assignedEmployees.includes(employeeId)
        ? prev.assignedEmployees.filter(id => id !== employeeId)
        : [...prev.assignedEmployees, employeeId]
    }));
  };

  const getEmployeeName = (employeeId: string): string => {
    const employee = employees.find(emp => emp.id === employeeId);
    return employee?.name || employee?.Name || 'Unknown Employee';
  };

  const getMeetingStats = () => {
    const scheduled = meetings.filter(m => m.status === 'scheduled').length;
    const completed = meetings.filter(m => m.status === 'completed').length;
    const cancelled = meetings.filter(m => m.status === 'cancelled').length;
    const today = meetings.filter(m => isToday(parseISO(m.date))).length;

    return { scheduled, completed, cancelled, today, total: meetings.length };
  };

  const getStatusIcon = (status: Meeting['status']) => {
    switch (status) {
      case 'scheduled':
        return <Clock className="w-4 h-4 text-brand" />;
      case 'completed':
        return <CheckCircle className="w-4 h-4 text-brand" />;
      case 'cancelled':
        return <XCircle className="w-4 h-4 text-red-600" />;
      default:
        return <AlertCircle className="w-4 h-4 text-gray-600 dark:text-neutral-400" />;
    }
  };

  const getStatusColor = (status: Meeting['status']) => {
    switch (status) {
      case 'scheduled':
        return 'bg-brand/10 text-gray-700 dark:text-white border border-brand/30 rounded-full';
      case 'completed':
        return 'bg-emerald-50 text-emerald-700 dark:text-emerald-400 border border-emerald-100 rounded-full';
      case 'cancelled':
        return 'bg-rose-50 text-rose-700 dark:text-rose-400 border border-rose-100 rounded-full';
      default:
        return 'bg-gray-100 text-gray-800';
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-96">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gray-900"></div>
      </div>
    );
  }

  const stats = getMeetingStats();

  return (
    <div className="space-y-6">
      {/* Tab Navigation */}
      <div className="border-b border-gray-200 dark:border-neutral-800/50">
        <nav className="-mb-px flex space-x-8">
          <button
            onClick={() => setActiveTab('meetings')}
            className={`py-2 px-1 border-b-2 font-medium text-sm ${activeTab === 'meetings'
              ? 'border-slate-900 dark:border-neutral-200 text-slate-900 dark:text-white font-semibold'
              : 'border-transparent text-gray-500 dark:text-neutral-400 hover:text-gray-700 dark:hover:text-neutral-300 hover:border-gray-300 dark:hover:border-neutral-700'
              }`}
          >
            <div className="flex items-center space-x-2">
              <Calendar className="h-4 w-4" />
              <span>Meetings</span>
            </div>
          </button>
          <button
            onClick={() => setActiveTab('leaves')}
            className={`py-2 px-1 border-b-2 font-medium text-sm ${activeTab === 'leaves'
              ? 'border-slate-900 dark:border-neutral-200 text-slate-900 dark:text-white font-semibold'
              : 'border-transparent text-gray-500 dark:text-neutral-400 hover:text-gray-700 dark:hover:text-neutral-300 hover:border-gray-300 dark:hover:border-neutral-700'
              }`}
          >
            <div className="flex items-center space-x-2">
              <FileText className="h-4 w-4" />
              <span>Leave Requests</span>
            </div>
          </button>
          <button
            onClick={() => setActiveTab('working-hours')}
            className={`py-2 px-1 border-b-2 font-medium text-sm ${activeTab === 'working-hours'
              ? 'border-slate-900 dark:border-neutral-200 text-slate-900 dark:text-white font-semibold'
              : 'border-transparent text-gray-500 dark:text-neutral-400 hover:text-gray-700 dark:hover:text-neutral-300 hover:border-gray-300 dark:hover:border-neutral-700'
              }`}
          >
            <div className="flex items-center space-x-2">
              <Settings className="h-4 w-4" />
              <span>Working Hours</span>
            </div>
          </button>
          <button
            onClick={() => setActiveTab('wfh')}
            className={`py-2 px-1 border-b-2 font-medium text-sm ${activeTab === 'wfh'
              ? 'border-slate-900 dark:border-neutral-200 text-slate-900 dark:text-white font-semibold'
              : 'border-transparent text-gray-500 dark:text-neutral-400 hover:text-gray-700 dark:hover:text-neutral-300 hover:border-gray-300 dark:hover:border-neutral-700'
              }`}
          >
            <div className="flex items-center space-x-2">
              <Monitor className="h-4 w-4" />
              <span>WFH Monitoring</span>
            </div>
          </button>
        </nav>
      </div>

      {/* Tab Content */}
      {activeTab === 'meetings' && (
        <div className="space-y-6">
          {/* Header */}
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Meetings Management</h1>
              <p className="text-gray-600 dark:text-neutral-400">Schedule meetings, assign employees, and track meeting history</p>
            </div>
            <div className="mt-4 sm:mt-0">
              <button
                onClick={() => {
                  resetForm();
                  setShowAddMeeting(true);
                }}
                className="inline-flex items-center px-4 py-2 bg-black text-white rounded-lg hover:bg-gray-800 transition-colors"
              >
                <CalendarPlus className="w-4 h-4 mr-2" />
                Schedule Meeting
              </button>
            </div>
          </div>

          {/* Stats Cards */}
          <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
            <div className="bg-white dark:bg-neutral-900 rounded-xl border border-gray-200 dark:border-neutral-800 p-6">
              <div className="flex items-center">
                <div className="p-2 bg-canvas dark:bg-neutral-800/50 rounded-lg">
                  <Calendar className="w-6 h-6 text-brand" />
                </div>
                <div className="ml-4">
                  <p className="text-sm font-medium text-gray-600 dark:text-neutral-400 dark:text-neutral-400">Total Meetings</p>
                  <p className="text-2xl font-bold text-gray-900 dark:text-white">{stats.total}</p>
                </div>
              </div>
            </div>
            <div className="bg-white dark:bg-neutral-900 rounded-xl border border-gray-200 dark:border-neutral-800 p-6">
              <div className="flex items-center">
                <div className="p-2 bg-canvas dark:bg-neutral-800/50 rounded-lg">
                  <Clock className="w-6 h-6 text-brand" />
                </div>
                <div className="ml-4">
                  <p className="text-sm font-medium text-gray-600 dark:text-neutral-400 dark:text-neutral-400">Scheduled</p>
                  <p className="text-2xl font-bold text-gray-900 dark:text-white">{stats.scheduled}</p>
                </div>
              </div>
            </div>
            <div className="bg-white dark:bg-neutral-900 rounded-xl border border-gray-200 dark:border-neutral-800 p-6">
              <div className="flex items-center">
                <div className="p-2 bg-canvas dark:bg-neutral-800/50 rounded-lg">
                  <CheckCircle className="w-6 h-6 text-brand" />
                </div>
                <div className="ml-4">
                  <p className="text-sm font-medium text-gray-600 dark:text-neutral-400 dark:text-neutral-400">Completed</p>
                  <p className="text-2xl font-bold text-gray-900 dark:text-white">{stats.completed}</p>
                </div>
              </div>
            </div>
            <div className="bg-white dark:bg-neutral-900 rounded-xl border border-gray-200 dark:border-neutral-800 p-6">
              <div className="flex items-center">
                <div className="p-2 bg-canvas dark:bg-neutral-800/50 rounded-lg">
                  <Calendar className="w-6 h-6 text-brand" />
                </div>
                <div className="ml-4">
                  <p className="text-sm font-medium text-gray-600 dark:text-neutral-400 dark:text-neutral-400">Today</p>
                  <p className="text-2xl font-bold text-gray-900 dark:text-white">{stats.today}</p>
                </div>
              </div>
            </div>
          </div>

          {/* Meetings List */}
          <div className="bg-white dark:bg-neutral-900 rounded-xl border border-gray-200 dark:border-neutral-800">
            <div className="p-6 border-b border-gray-200 dark:border-neutral-800/50">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between space-y-4 sm:space-y-0">
                <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Meeting History & Schedule</h2>
                <div className="flex flex-col sm:flex-row space-y-2 sm:space-y-0 sm:space-x-4">
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 w-4 h-4" />
                    <input
                      type="text"
                      placeholder="Search meetings..."
                      value={searchTerm}
                      onChange={(e) => setSearchTerm(e.target.value)}
                      className="pl-10 pr-4 py-2 border border-gray-200 dark:border-neutral-800 rounded-xl bg-white dark:bg-black text-gray-900 dark:text-white dark:text-white focus:ring-2 focus:ring-brand focus:border-brand focus:border-transparent"
                    />
                  </div>
                  <select
                    value={statusFilter}
                    onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}
                    className="pl-4 pr-10 py-2 border border-gray-200 dark:border-neutral-800 rounded-xl bg-white dark:bg-black text-gray-900 dark:text-white focus:ring-2 focus:ring-brand focus:border-brand dark:[color-scheme:dark] cursor-pointer"
                  >
                    <option value="all" className="bg-white dark:bg-black text-gray-900 dark:text-white dark:text-white">All Status</option>
                    <option value="scheduled" className="bg-white dark:bg-black text-gray-900 dark:text-white dark:text-white">Scheduled</option>
                    <option value="completed" className="bg-white dark:bg-black text-gray-900 dark:text-white dark:text-white">Completed</option>
                    <option value="cancelled" className="bg-white dark:bg-black text-gray-900 dark:text-white dark:text-white">Cancelled</option>
                  </select>
                </div>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-gray-50 dark:bg-neutral-900/50">
                  <tr>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-neutral-400 dark:bg-neutral-900/50 uppercase tracking-wider border-b border-gray-100 dark:border-neutral-800">
                      Meeting Details
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-neutral-400 dark:bg-neutral-900/50 uppercase tracking-wider border-b border-gray-100 dark:border-neutral-800">
                      Date & Time
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-neutral-400 dark:bg-neutral-900/50 uppercase tracking-wider border-b border-gray-100 dark:border-neutral-800">
                      Assigned Employees
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-neutral-400 dark:bg-neutral-900/50 uppercase tracking-wider border-b border-gray-100 dark:border-neutral-800">
                      Status
                    </th>
                    <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 dark:text-neutral-400 uppercase tracking-wider">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200 dark:divide-neutral-800/50 dark:divide-neutral-800/50">
                  {filteredMeetings.map((meeting) => (
                    <tr key={meeting.id} className="hover:bg-gray-50 dark:hover:bg-neutral-800/50">
                      <td className="px-6 py-4">
                        <div>
                          <div className="text-sm font-medium text-gray-900 dark:text-white">{meeting.title}</div>
                          {meeting.description && (
                            <div className="text-sm text-gray-500 dark:text-neutral-400 mt-1">{meeting.description}</div>
                          )}
                        </div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="text-sm font-medium text-gray-900 dark:text-white">
                          {format(parseISO(meeting.date), 'MMM dd, yyyy')}
                        </div>
                        <div className="text-sm text-gray-500 dark:text-neutral-400">{meeting.time}</div>
                      </td>
                      <td className="px-6 py-4">
                        <div className="flex flex-wrap gap-1">
                          {meeting.assignedEmployees.map((employeeId) => (
                            <span
                              key={employeeId}
                              className="inline-flex items-center px-2 py-1 text-xs font-medium bg-brand/10 text-gray-700 dark:text-white border border-brand/30 rounded-full"
                            >
                              <User className="w-3 h-3 mr-1" />
                              {getEmployeeName(employeeId)}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="flex items-center space-x-2">
                          {getStatusIcon(meeting.status)}
                          <select
                            value={meeting.status}
                            onChange={(e) => handleStatusChange(meeting.id, e.target.value as Meeting['status'])}
                            className={`text-xs font-semibold rounded-full pl-3 pr-8 py-1 border-0 appearance-none bg-no-repeat ${getStatusColor(meeting.status)}`}
                            style={{
                              backgroundPosition: 'right 0.5rem center',
                              backgroundSize: '1em 1em',
                              backgroundImage: 'url("data:image/svg+xml,%3csvg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 16 16%27%3e%3cpath fill=%27none%27 stroke=%27currentColor%27 stroke-linecap=%27round%27 stroke-linejoin=%27round%27 stroke-width=%272%27 d=%27m2 5 6 6 6-6%27/%3e%3c/svg%3e")'
                            }}
                          >
                            <option value="scheduled" className="bg-white dark:bg-neutral-900 text-gray-900 dark:text-white">Scheduled</option>
                            <option value="completed" className="bg-white dark:bg-neutral-900 text-gray-900 dark:text-white">Completed</option>
                            <option value="cancelled" className="bg-white dark:bg-neutral-900 text-gray-900 dark:text-white">Cancelled</option>
                          </select>
                        </div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                        <div className="flex items-center justify-end space-x-2">
                          <button
                            onClick={() => handleEdit(meeting)}
                            className="text-indigo-600 dark:text-indigo-400 hover:text-indigo-900 dark:hover:text-indigo-300"
                          >
                            <Edit className="w-4 h-4" />
                          </button>
                          <button
                            onClick={() => handleDelete(meeting.id)}
                            className="text-red-600 dark:text-red-400 hover:text-red-900 dark:hover:text-red-300"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {filteredMeetings.length === 0 && (
              <div className="text-center py-12">
                <Calendar className="w-12 h-12 text-gray-300 mx-auto mb-4" />
                <p className="text-gray-500 dark:text-neutral-400">
                  {searchTerm || statusFilter !== 'all' ? 'No meetings match your criteria' : 'No meetings scheduled yet'}
                </p>
              </div>
            )}
          </div>

          {/* Meeting Form Modal */}
          {showAddMeeting && (
            <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
              <div className="bg-white dark:bg-neutral-900 border border-transparent dark:border-neutral-800 rounded-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
                <div className="p-6">
                  <div className="flex items-center justify-between mb-6">
                    <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
                      {editingMeeting ? 'Edit Meeting' : 'Schedule New Meeting'}
                    </h3>
                    <button
                      onClick={() => {
                        setShowAddMeeting(false);
                        resetForm();
                      }}
                      className="text-gray-400 hover:text-gray-600 dark:text-neutral-400"
                    >
                      ×
                    </button>
                  </div>

                  <form onSubmit={handleSubmit} className="space-y-6">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 dark:text-neutral-300 mb-2">
                        Meeting Title *
                      </label>
                      <input
                        type="text"
                        value={formData.title}
                        onChange={(e) => setFormData(prev => ({ ...prev, title: e.target.value }))}
                        className="w-full px-3 py-2 border border-gray-200 dark:border-neutral-800 rounded-xl bg-white dark:bg-black text-gray-900 dark:text-white focus:ring-2 focus:ring-brand focus:border-brand focus:border-transparent dark:[color-scheme:dark]"
                        placeholder="Enter meeting title"
                        required
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700 dark:text-neutral-300 mb-2">
                        Description
                      </label>
                      <textarea
                        value={formData.description}
                        onChange={(e) => setFormData(prev => ({ ...prev, description: e.target.value }))}
                        rows={3}
                        className="w-full px-3 py-2 border border-gray-200 dark:border-neutral-800 rounded-xl bg-white dark:bg-black text-gray-900 dark:text-white focus:ring-2 focus:ring-brand focus:border-brand focus:border-transparent dark:[color-scheme:dark]"
                        placeholder="Enter meeting description (optional)"
                      />
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label className="block text-sm font-medium text-gray-700 dark:text-neutral-300 mb-2">
                          Date *
                        </label>
                        <input
                          type="date"
                          value={formData.date}
                          onChange={(e) => setFormData(prev => ({ ...prev, date: e.target.value }))}
                          min={format(new Date(), 'yyyy-MM-dd')}
                          className="w-full px-3 py-2 border border-gray-200 dark:border-neutral-800 rounded-xl bg-white dark:bg-black text-gray-900 dark:text-white focus:ring-2 focus:ring-brand focus:border-brand focus:border-transparent dark:[color-scheme:dark]"
                          required
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700 dark:text-neutral-300 mb-2">
                          Time *
                        </label>
                        <input
                          type="time"
                          value={formData.time}
                          onChange={(e) => setFormData(prev => ({ ...prev, time: e.target.value }))}
                          className="w-full px-3 py-2 border border-gray-200 dark:border-neutral-800 rounded-xl bg-white dark:bg-black text-gray-900 dark:text-white focus:ring-2 focus:ring-brand focus:border-brand focus:border-transparent dark:[color-scheme:dark]"
                          required
                        />
                      </div>
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700 dark:text-neutral-300 mb-2">
                        Assign Employees ({formData.assignedEmployees.length} selected)
                      </label>
                      <div className="border border-gray-200 dark:border-neutral-800 rounded-xl bg-white dark:bg-neutral-900 max-h-48 overflow-y-auto">
                        {employees.length === 0 ? (
                          <div className="p-4 text-center text-gray-500 dark:text-neutral-400">
                            No employees available
                          </div>
                        ) : (
                          <div className="p-2 space-y-2">
                            {employees.map((employee) => (
                              <label
                                key={employee.id}
                                className="flex items-center p-2 hover:bg-gray-50 rounded cursor-pointer"
                              >
                                <input
                                  type="checkbox"
                                  checked={formData.assignedEmployees.includes(employee.id)}
                                  onChange={() => toggleEmployeeSelection(employee.id)}
                                  className="h-4 w-4 text-brand focus:ring-brand focus:border-brand border-gray-300 rounded"
                                />
                                <div className="ml-3 flex items-center">
                                  <div className="w-8 h-8 bg-gray-200 rounded-full flex items-center justify-center mr-3">
                                    <User className="w-4 h-4 text-gray-600 dark:text-neutral-400" />
                                  </div>
                                  <div>
                                    <div className="text-sm font-medium text-gray-900 dark:text-white">
                                      {employee.name || employee.Name}
                                    </div>
                                    <div className="text-sm text-gray-500 dark:text-neutral-400">
                                      {employee.department} • {employee.designation || employee.Designation || 'Employee'}
                                    </div>
                                  </div>
                                </div>
                              </label>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>

                    <div className="flex space-x-3 pt-4">
                      <button
                        type="button"
                        onClick={() => {
                          setShowAddMeeting(false);
                          resetForm();
                        }}
                        className="flex-1 px-4 py-2 text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors"
                      >
                        Cancel
                      </button>
                      <button
                        type="submit"
                        disabled={loading}
                        className="flex-1 px-4 py-2 bg-black dark:bg-brand text-white dark:text-gray-900 dark:text-white rounded-lg hover:bg-gray-800 dark:hover:bg-brand-dark transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {editingMeeting ? 'Update Meeting' : 'Schedule Meeting'}
                      </button>
                    </div>
                  </form>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
      {activeTab === 'leaves' && <LeaveManagement />}
      {activeTab === 'working-hours' && <WorkingHoursSettingsForm />}
      {activeTab === 'wfh' && <WFHMonitoring />}
    </div>
  );
};

export default AdminModePage;
