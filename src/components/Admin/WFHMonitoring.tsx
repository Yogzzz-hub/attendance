import { useState, useEffect, useCallback } from 'react';
import {
  Monitor,
  Clock,
  Coffee,
  Activity,
  Search,
  X
} from 'lucide-react';
import { format } from 'date-fns';
import { globalAttendanceService } from '../../services/globalAttendanceService';
import { formatToDDMMYYYY, parseDDMMYYYY } from '../../utils/dateUtils';
import { formatDuration } from '../../utils/formatDuration';
import toast from 'react-hot-toast';

interface WFHDailySummary {
  employeeId: string;
  employeeName: string;
  department: string;
  role: string;
  activeSeconds: number;
  breakSeconds: number;
  activityScore: number;
  lastActiveApp: string | null;
  attendanceRecordId: string;
}

interface WFHActivityLog {
  id: string;
  timestamp: string;
  activeApp: string | null;
  activityPercentage: number;
}

const WFHMonitoring: React.FC = () => {
  const [selectedDate, setSelectedDate] = useState(formatToDDMMYYYY(new Date()));
  const [loading, setLoading] = useState(true);
  const [wfhData, setWfhData] = useState<WFHDailySummary[]>([]);
  const [searchTerm, setSearchTerm] = useState('');

  // Detail drawer state
  const [selectedRecord, setSelectedRecord] = useState<WFHDailySummary | null>(null);
  const [activityLogs, setActivityLogs] = useState<WFHActivityLog[]>([]);
  const [loadingLogs, setLoadingLogs] = useState(false);

  const loadWFHData = useCallback(async () => {
    try {
      setLoading(true);
      const data = await globalAttendanceService.getWFHDailySummary(selectedDate);
      setWfhData(data);
    } catch (error) {
      console.error('Failed to load WFH data:', error);
      toast.error('Failed to load WFH monitoring data');
    } finally {
      setLoading(false);
    }
  }, [selectedDate]);

  useEffect(() => {
    loadWFHData();
  }, [loadWFHData]);

  const openDetailDrawer = async (record: WFHDailySummary) => {
    setSelectedRecord(record);
    setLoadingLogs(true);
    try {
      const logs = await globalAttendanceService.getWFHActivityLogs(record.attendanceRecordId);
      setActivityLogs(logs);
    } catch (error) {
      console.error('Failed to load activity logs:', error);
      toast.error('Failed to load activity timeline');
    } finally {
      setLoadingLogs(false);
    }
  };

  const closeDrawer = () => {
    setSelectedRecord(null);
    setActivityLogs([]);
  };

  const formatSeconds = (seconds: number): string => {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  const filteredData = wfhData.filter(item =>
    item.employeeName.toLowerCase().includes(searchTerm.toLowerCase()) ||
    item.department.toLowerCase().includes(searchTerm.toLowerCase())
  );

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">WFH Monitoring</h1>
          <p className="text-gray-600 dark:text-neutral-400">Track work-from-home activity and productivity</p>
        </div>
        <div className="mt-4 sm:mt-0 flex items-center space-x-3">
          <input
            type="date"
            value={selectedDate.split('-').reverse().join('-')}
            onChange={(e) => {
              const parts = e.target.value.split('-');
              if (parts.length === 3) {
                setSelectedDate(`${parts[2]}-${parts[1]}-${parts[0]}`);
              }
            }}
            className="px-3 py-2 border border-gray-200 dark:border-neutral-800 rounded-xl bg-white dark:bg-black text-gray-900 dark:text-white focus:ring-2 focus:ring-brand focus:border-brand dark:[color-scheme:dark]"
          />
          <button
            onClick={loadWFHData}
            className="inline-flex items-center px-4 py-2 bg-black text-white rounded-lg hover:bg-gray-800 transition-colors"
          >
            <Search className="w-4 h-4 mr-2" />
            Refresh
          </button>
        </div>
      </div>

      {/* Stats Summary */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
        <div className="bg-white dark:bg-neutral-900 rounded-xl border border-gray-200 dark:border-neutral-800 p-6">
          <div className="flex items-center">
            <div className="p-2 bg-blue-50 dark:bg-blue-500/10 rounded-lg">
              <Monitor className="w-6 h-6 text-blue-600 dark:text-blue-400" />
            </div>
            <div className="ml-4">
              <p className="text-sm font-medium text-gray-600 dark:text-neutral-400">WFH Today</p>
              <p className="text-2xl font-bold text-gray-900 dark:text-white">{wfhData.length}</p>
            </div>
          </div>
        </div>
        <div className="bg-white dark:bg-neutral-900 rounded-xl border border-gray-200 dark:border-neutral-800 p-6">
          <div className="flex items-center">
            <div className="p-2 bg-emerald-50 dark:bg-emerald-500/10 rounded-lg">
              <Activity className="w-6 h-6 text-emerald-600 dark:text-emerald-400" />
            </div>
            <div className="ml-4">
              <p className="text-sm font-medium text-gray-600 dark:text-neutral-400">Avg Activity</p>
              <p className="text-2xl font-bold text-gray-900 dark:text-white">
                {wfhData.length > 0
                  ? Math.round(wfhData.reduce((sum, item) => sum + item.activityScore, 0) / wfhData.length)
                  : 0}%
              </p>
            </div>
          </div>
        </div>
        <div className="bg-white dark:bg-neutral-900 rounded-xl border border-gray-200 dark:border-neutral-800 p-6">
          <div className="flex items-center">
            <div className="p-2 bg-brand/10 rounded-lg">
              <Clock className="w-6 h-6 text-brand" />
            </div>
            <div className="ml-4">
              <p className="text-sm font-medium text-gray-600 dark:text-neutral-400">Avg Active Time</p>
              <p className="text-2xl font-bold text-gray-900 dark:text-white">
                {wfhData.length > 0
                  ? formatDuration(Math.round(wfhData.reduce((sum, item) => sum + item.activeSeconds, 0) / wfhData.length) / 3600)
                  : '0h 0m'}
              </p>
            </div>
          </div>
        </div>
        <div className="bg-white dark:bg-neutral-900 rounded-xl border border-gray-200 dark:border-neutral-800 p-6">
          <div className="flex items-center">
            <div className="p-2 bg-orange-50 dark:bg-orange-500/10 rounded-lg">
              <Coffee className="w-6 h-6 text-orange-600 dark:text-orange-400" />
            </div>
            <div className="ml-4">
              <p className="text-sm font-medium text-gray-600 dark:text-neutral-400">Avg Break Time</p>
              <p className="text-2xl font-bold text-gray-900 dark:text-white">
                {wfhData.length > 0
                  ? formatDuration(Math.round(wfhData.reduce((sum, item) => sum + item.breakSeconds, 0) / wfhData.length) / 3600)
                  : '0h 0m'}
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Search */}
      <div className="bg-white dark:bg-neutral-900 rounded-xl border border-gray-200 dark:border-neutral-800 p-4">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 w-4 h-4" />
          <input
            type="text"
            placeholder="Search by employee name or department..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="pl-10 pr-4 py-2 border border-gray-200 dark:border-neutral-800 rounded-xl bg-white dark:bg-black text-gray-900 dark:text-white focus:ring-2 focus:ring-brand focus:border-brand focus:border-transparent w-full"
          />
        </div>
      </div>

      {/* WFH Table */}
      <div className="bg-white dark:bg-neutral-900 rounded-xl border border-gray-200 dark:border-neutral-800 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-gray-50 dark:bg-neutral-900/50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-neutral-400 uppercase tracking-wider border-b border-gray-100 dark:border-neutral-800">
                  Employee
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-neutral-400 uppercase tracking-wider border-b border-gray-100 dark:border-neutral-800">
                  Department
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-neutral-400 uppercase tracking-wider border-b border-gray-100 dark:border-neutral-800">
                  Active Hours
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-neutral-400 uppercase tracking-wider border-b border-gray-100 dark:border-neutral-800">
                  Break Duration
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-neutral-400 uppercase tracking-wider border-b border-gray-100 dark:border-neutral-800">
                  Activity Score
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-neutral-400 uppercase tracking-wider border-b border-gray-100 dark:border-neutral-800">
                  Last Active App
                </th>
                <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 dark:text-neutral-400 uppercase tracking-wider border-b border-gray-100 dark:border-neutral-800">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 dark:divide-neutral-800/50">
              {loading ? (
                <tr>
                  <td colSpan={7} className="px-6 py-12 text-center">
                    <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gray-900 mx-auto"></div>
                  </td>
                </tr>
              ) : filteredData.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-6 py-12 text-center text-gray-500 dark:text-neutral-400">
                    {searchTerm ? 'No WFH records match your search' : 'No WFH attendance records for this date'}
                  </td>
                </tr>
              ) : (
                filteredData.map((item) => (
                  <tr key={item.attendanceRecordId} className="hover:bg-gray-50 dark:hover:bg-neutral-800/50">
                    <td className="px-6 py-4">
                      <div className="flex items-center">
                        <div className="w-8 h-8 bg-blue-100 dark:bg-blue-500/10 rounded-full flex items-center justify-center mr-3">
                          <Monitor className="w-4 h-4 text-blue-600 dark:text-blue-400" />
                        </div>
                        <div>
                          <div className="text-sm font-medium text-gray-900 dark:text-white">{item.employeeName}</div>
                          <div className="text-xs text-gray-500 dark:text-neutral-400 capitalize">{item.role}</div>
                        </div>
                      </div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <span className="text-sm text-gray-700 dark:text-neutral-300">{item.department}</span>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="flex flex-col">
                        <span className="text-sm font-medium text-gray-900 dark:text-white">
                          {formatSeconds(item.activeSeconds)}
                        </span>
                        <span className="text-xs text-gray-500 dark:text-neutral-400">
                          of 07:00:00
                        </span>
                      </div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <span className="text-sm text-gray-700 dark:text-neutral-300">
                        {formatSeconds(item.breakSeconds)}
                      </span>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="flex items-center">
                        <div className="flex-1">
                          <div className="flex items-center justify-between mb-1">
                            <span className="text-sm font-medium text-gray-900 dark:text-white">
                              {Math.round(item.activityScore)}%
                            </span>
                          </div>
                          <div className="w-full bg-gray-200 dark:bg-neutral-700 rounded-full h-1.5">
                            <div
                              className={`h-1.5 rounded-full ${
                                item.activityScore >= 80
                                  ? 'bg-emerald-500'
                                  : item.activityScore >= 50
                                    ? 'bg-amber-500'
                                    : 'bg-red-500'
                              }`}
                              style={{ width: `${Math.min(100, item.activityScore)}%` }}
                            ></div>
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <span className="text-sm text-gray-700 dark:text-neutral-300 truncate block max-w-[200px]" title={item.lastActiveApp || ''}>
                        {item.lastActiveApp || '--'}
                      </span>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                      <button
                        onClick={() => openDetailDrawer(item)}
                        className="text-brand hover:text-brand-dark flex items-center ml-auto"
                      >
                        <Activity className="w-4 h-4 mr-1" />
                        Timeline
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Detail Drawer */}
      {selectedRecord && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-white dark:bg-neutral-900 border border-gray-200 dark:border-neutral-800 rounded-xl w-full max-w-2xl max-h-[90vh] overflow-hidden flex flex-col">
            <div className="p-6 border-b border-gray-200 dark:border-neutral-800 flex items-center justify-between">
              <div>
                <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
                  WFH Activity Timeline
                </h3>
                <p className="text-sm text-gray-500 dark:text-neutral-400 mt-1">
                  {selectedRecord.employeeName} • {format(parseDDMMYYYY(selectedDate), 'MMMM dd, yyyy')}
                </p>
              </div>
              <button
                onClick={closeDrawer}
                className="text-gray-400 hover:text-gray-600 dark:text-neutral-400"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-6 overflow-y-auto flex-1">
              {loadingLogs ? (
                <div className="flex items-center justify-center py-12">
                  <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gray-900"></div>
                </div>
              ) : activityLogs.length === 0 ? (
                <div className="text-center py-12">
                  <Activity className="w-12 h-12 text-gray-300 mx-auto mb-4" />
                  <p className="text-gray-500 dark:text-neutral-400">No activity logs recorded for this shift</p>
                </div>
              ) : (
                <div className="space-y-4">
                  {/* Timeline */}
                  <div className="relative">
                    <div className="absolute left-4 top-0 bottom-0 w-px bg-gray-200 dark:bg-neutral-800"></div>
                    <div className="space-y-4">
                      {activityLogs.map((log, index) => {
                        const logTime = new Date(log.timestamp);
                        const timeStr = format(logTime, 'hh:mm:ss a');
                        const prevLog = index > 0 ? activityLogs[index - 1] : null;
                        const duration = prevLog
                          ? Math.round((logTime.getTime() - new Date(prevLog.timestamp).getTime()) / 1000)
                          : 0;

                        return (
                          <div key={log.id} className="relative flex items-start space-x-4">
                            <div className="flex-shrink-0 w-8 h-8 bg-blue-100 dark:bg-blue-500/10 rounded-full flex items-center justify-center z-10">
                              <Monitor className="w-4 h-4 text-blue-600 dark:text-blue-400" />
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center justify-between">
                                <p className="text-sm font-medium text-gray-900 dark:text-white truncate" title={log.activeApp || 'Unknown'}>
                                  {log.activeApp || 'Unknown Application'}
                                </p>
                                <span className="text-xs text-gray-500 dark:text-neutral-400 ml-2">
                                  {timeStr}
                                </span>
                              </div>
                              <div className="flex items-center mt-1 space-x-4">
                                <span className="text-xs text-gray-500 dark:text-neutral-400">
                                  Duration: {formatSeconds(duration)}
                                </span>
                                <span className="text-xs text-gray-500 dark:text-neutral-400">
                                  Activity: {Math.round(log.activityPercentage)}%
                                </span>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default WFHMonitoring;
