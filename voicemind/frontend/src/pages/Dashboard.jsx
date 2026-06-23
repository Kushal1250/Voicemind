// frontend/src/pages/Dashboard.jsx
import React, { useEffect, useMemo } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import { useNavigate } from 'react-router-dom';
import {
  Calendar,
  Clock,
  Mic,
  MessageSquare,
  Plus,
  ArrowRight,
  Activity,
  Wifi,
  Cpu,
  HardDrive,
  Sparkles,
  CheckCircle2,
} from 'lucide-react';
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  CartesianGrid,
  Tooltip,
  XAxis,
  YAxis,
  BarChart,
  Bar,
} from 'recharts';
import AppShell from '../components/AppShell';
import { fetchMeetings } from '../store/slices/meetingsSlice';
import { fetchDevices } from '../store/slices/devicesSlice';
import { fetchOverview, fetchMeetingsTimeseries, fetchQATrend } from '../store/slices/analyticsSlice';

const formatDuration = (seconds) => {
  if (!seconds) return '0m';
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
};

const Dashboard = () => {
  const dispatch = useDispatch();
  const navigate = useNavigate();
  const { items: meetings } = useSelector((state) => state.meetings);
  const { items: devices } = useSelector((state) => state.devices);
  const { overview, timeseries, qaTrend } = useSelector((state) => state.analytics);
  const { activeDeviceStatus, activeMeetingStatus, lastUpdatedAt, chunksProgress } = useSelector((state) => state.liveStatus);

  useEffect(() => {
    dispatch(fetchMeetings({ limit: 8, sort: '-createdAt' }));
    dispatch(fetchDevices());
    dispatch(fetchOverview({}));
    dispatch(fetchMeetingsTimeseries({}));
    dispatch(fetchQATrend({}));
  }, [dispatch]);

  const safeMeetings = Array.isArray(meetings) ? meetings : [];
  const safeDevices = Array.isArray(devices) ? devices : [];
  const recentMeetings = safeMeetings.slice(0, 5);
  const onlineDevices = safeDevices.filter((d) => d.status === 'online').length;
  const activeDevices = activeDeviceStatus ? 1 : onlineDevices;

  const completedTranscriptSessions =
    overview?.completedTranscriptSessions ??
    overview?.transcriptsCount ??
    safeMeetings.filter((m) => ['completed', 'done'].includes(String(m.status || '').toLowerCase())).length;

  const trendData = useMemo(() => {
    if (Array.isArray(timeseries) && timeseries.length > 0) {
      return timeseries.map((item, index) => ({
        name: item.label || item.date || item.day || `Day ${index + 1}`,
        meetings: Number(item.count || item.meetings || 0),
        transcripts: Number(item.transcripts || item.completed || item.count || 0),
      }));
    }

    return recentMeetings
      .slice()
      .reverse()
      .map((meeting, index) => ({
        name: new Date(meeting.createdAt || Date.now()).toLocaleDateString([], { month: 'short', day: 'numeric' }),
        meetings: index + 1,
        transcripts: meeting.status === 'done' ? 1 : 0,
      }));
  }, [timeseries, recentMeetings]);

  const qaChartData = useMemo(() => {
    if (Array.isArray(qaTrend) && qaTrend.length > 0) {
      return qaTrend.map((item, index) => ({
        // API returns { date, interactions } - map correctly
        name: item.date || item.label || item.day || `Slot ${index + 1}`,
        qa: Number(item.interactions || item.count || item.qa || 0),
      }));
    }

    return recentMeetings.map((meeting, index) => ({
      name: `M${index + 1}`,
      qa: Number(meeting.stats?.qaCount || 0),
    }));
  }, [qaTrend, recentMeetings]);

  const kpis = [
    {
      label: 'Total Meetings',
      value: overview?.totalMeetings || safeMeetings.length || 0,
      sub: `${recentMeetings.length} recent loaded`,
      icon: Calendar,
      accent: 'from-primary-500/20 to-primary-500/5',
    },
    {
      label: 'Total Duration',
      value: formatDuration(overview?.totalDurationSec || overview?.avgDuration || 0),
      sub: 'Across all recordings',
      icon: Clock,
      accent: 'from-sky-500/20 to-sky-500/5',
    },
    {
      label: 'Total Transcripts',
      value: completedTranscriptSessions,
      sub: 'Completed transcript sessions',
      icon: MessageSquare,
      accent: 'from-violet-500/20 to-violet-500/5',
    },
    {
      label: 'Active Devices',
      value: activeDevices || 0,
      sub: (activeDevices > 0) ? `${activeDevices} active now` : 'Waiting for device heartbeat',
      icon: Cpu,
      accent: 'from-emerald-500/20 to-emerald-500/5',
    },
  ];

  return (
    <AppShell>
      <div className="space-y-6">
        <section className="glass-panel overflow-hidden p-6 sm:p-8">
          <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-2xl">
              <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-primary-500/20 bg-primary-500/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.24em] text-primary-200">
                <Sparkles className="h-3.5 w-3.5" />
                AI meeting intelligence platform
              </div>
              <h1 className="section-title text-3xl sm:text-4xl">Modern dashboard for recordings, transcripts, and live insights.</h1>
              <p className="mt-3 max-w-2xl text-sm leading-7 text-slate-300 sm:text-base">
                Monitor device health, live recording progress, transcript activity, and Q&amp;A usage from one polished workspace without changing your existing backend, ESP32 flow, or transcription pipeline.
              </p>
            </div>
            <div className="flex flex-wrap gap-3">
              <button onClick={() => navigate('/meetings/new')} className="btn-primary">
                <Plus className="h-4 w-4" />
                Start New Meeting
              </button>
              <button onClick={() => navigate('/live')} className="btn-secondary">
                <Activity className="h-4 w-4" />
                Open Live Monitor
              </button>
            </div>
          </div>
        </section>

        <section className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
          {kpis.map((item) => {
            const Icon = item.icon;
            return (
              <div key={item.label} className="kpi-card">
                <div className={`absolute inset-x-0 top-0 h-24 bg-gradient-to-br ${item.accent} opacity-80`} />
                <div className="relative flex items-start justify-between gap-4">
                  <div>
                    <div className="text-xs uppercase tracking-[0.28em] text-slate-500">{item.label}</div>
                    <div className="mt-3 text-3xl font-bold tracking-tight text-white">{item.value}</div>
                    <div className="mt-2 text-sm text-slate-400">{item.sub}</div>
                  </div>
                  <div className="rounded-2xl border border-white/10 bg-white/10 p-3">
                    <Icon className="h-5 w-5 text-white" />
                  </div>
                </div>
              </div>
            );
          })}
        </section>

        <section className="grid grid-cols-1 gap-6 xl:grid-cols-[1.45fr_0.95fr]">
          <div className="surface-card p-5 sm:p-6">
            <div className="mb-5 flex items-center justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold text-white">Meeting activity</h2>
                <p className="text-sm text-slate-400">Meetings and transcript activity across recent sessions.</p>
              </div>
              <button onClick={() => navigate('/statistics')} className="btn-secondary text-xs">
                View analytics
              </button>
            </div>
            <div className="h-80">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={trendData}>
                  <defs>
                    <linearGradient id="meetingsFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#6366F1" stopOpacity={0.5} />
                      <stop offset="95%" stopColor="#6366F1" stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="transcriptsFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#22C55E" stopOpacity={0.4} />
                      <stop offset="95%" stopColor="#22C55E" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke="rgba(148,163,184,0.12)" vertical={false} />
                  <XAxis dataKey="name" stroke="#64748B" tickLine={false} axisLine={false} />
                  <YAxis stroke="#64748B" tickLine={false} axisLine={false} allowDecimals={false} />
                  <Tooltip contentStyle={{ background: '#0F172A', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 16, color: '#fff' }} />
                  <Area type="monotone" dataKey="meetings" stroke="#6366F1" fill="url(#meetingsFill)" strokeWidth={2.5} />
                  <Area type="monotone" dataKey="transcripts" stroke="#22C55E" fill="url(#transcriptsFill)" strokeWidth={2.5} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="surface-card p-5 sm:p-6">
            <div className="mb-5 flex items-center justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold text-white">Q&amp;A activity</h2>
                <p className="text-sm text-slate-400">How often AI questions are being asked.</p>
              </div>
              <button onClick={() => navigate('/qa')} className="btn-secondary text-xs">
                Open Q&amp;A
              </button>
            </div>
            <div className="h-80">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={qaChartData}>
                  <CartesianGrid stroke="rgba(148,163,184,0.12)" vertical={false} />
                  <XAxis dataKey="name" stroke="#64748B" tickLine={false} axisLine={false} />
                  <YAxis stroke="#64748B" tickLine={false} axisLine={false} allowDecimals={false} />
                  <Tooltip contentStyle={{ background: '#0F172A', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 16, color: '#fff' }} />
                  <Bar dataKey="qa" fill="#8B5CF6" radius={[10, 10, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        </section>

        <section className="grid grid-cols-1 gap-6 xl:grid-cols-[1.1fr_0.9fr]">
          <div className="surface-card p-5 sm:p-6">
            <div className="mb-5 flex items-center justify-between">
              <div>
                <h2 className="text-lg font-semibold text-white">Live meeting monitor</h2>
                <p className="text-sm text-slate-400">Real-time visibility into your active recording pipeline.</p>
              </div>
              {lastUpdatedAt && (
                <div className="text-xs text-slate-500">
                  Updated {Math.floor((Date.now() - new Date(lastUpdatedAt)) / 1000)}s ago
                </div>
              )}
            </div>

            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div className="surface-card-soft p-4">
                <div className="mb-2 flex items-center gap-2 text-sm text-slate-400">
                  <Wifi className="h-4 w-4" /> Device status
                </div>
                <div className="flex items-center gap-2">
                  <span className={`h-2.5 w-2.5 rounded-full ${onlineDevices > 0 ? 'bg-green-400 animate-pulse' : 'bg-red-400'}`} />
                  <span className="text-lg font-semibold text-white">{onlineDevices > 0 ? 'Online' : 'Offline'}</span>
                </div>
                <div className="mt-2 text-sm text-slate-400">{activeDeviceStatus?.name || 'No active device selected'}</div>
              </div>

              <div className="surface-card-soft p-4">
                <div className="mb-2 flex items-center gap-2 text-sm text-slate-400">
                  <Mic className="h-4 w-4" /> Recording state
                </div>
                <div className={`text-lg font-semibold ${activeMeetingStatus?.status === 'recording' ? 'text-red-300' : 'text-white'}`}>
                  {activeMeetingStatus?.status?.toUpperCase() || 'IDLE'}
                </div>
                <div className="mt-2 text-sm text-slate-400">{activeMeetingStatus?.source || 'Waiting for a meeting to start'}</div>
              </div>

              <div className="surface-card-soft p-4">
                <div className="mb-2 flex items-center gap-2 text-sm text-slate-400">
                  <HardDrive className="h-4 w-4" /> Chunk progress
                </div>
                <div className="text-lg font-semibold text-white">{chunksProgress.displayCurrent} / {chunksProgress.displayTotal}</div>
                <div className="mt-2 text-xs text-slate-400">
                  {chunksProgress.isTotalExplicit ? 'Backend total expected chunks' : chunksProgress.hasAnyStats ? 'Live total derived from backend stats' : 'No active chunk stats'}
                </div>
                <div className="mt-3 h-2 overflow-hidden rounded-full bg-white/10">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-primary-500 to-indigo-400 transition-all"
                    style={{ width: `${chunksProgress.progressPercent || 0}%` }}
                  />
                </div>
              </div>

              <div className="surface-card-soft p-4">
                <div className="mb-2 flex items-center gap-2 text-sm text-slate-400">
                  <MessageSquare className="h-4 w-4" /> Transcript health
                </div>
                <div className="text-lg font-semibold text-white">
                  {activeMeetingStatus?.status === 'recording' ? 'Streaming live' : 'Ready'}
                </div>
                <div className="mt-2 text-sm text-slate-400">Partial transcript updates flow here during recording.</div>
              </div>
            </div>
          </div>

          <div className="surface-card p-5 sm:p-6">
            <div className="mb-5 flex items-center justify-between">
              <div>
                <h2 className="text-lg font-semibold text-white">Recent meetings</h2>
                <p className="text-sm text-slate-400">Latest sessions with quick status visibility.</p>
              </div>
              <button onClick={() => navigate('/meetings')} className="btn-secondary text-xs">
                View all
              </button>
            </div>
            <div className="space-y-3">
              {recentMeetings.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-white/10 px-4 py-12 text-center text-slate-500">
                  No meetings found yet.
                </div>
              ) : (
                recentMeetings.map((meeting) => (
                  <button
                    key={meeting._id || meeting.meetingId}
                    onClick={() => navigate(`/meetings/${meeting._id || meeting.meetingId}`)}
                    className="surface-card-soft flex w-full items-center justify-between gap-4 p-4 text-left transition hover:bg-white/10"
                  >
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold text-white">{meeting.title || 'Untitled meeting'}</div>
                      <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-400">
                        <span>{new Date(meeting.createdAt || Date.now()).toLocaleString()}</span>
                        <span>•</span>
                        <span>{formatDuration(meeting.stats?.durationSec || 0)}</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className={`status-pill ${meeting.status === 'recording' ? 'recording' : meeting.status === 'processing' ? 'processing' : meeting.status === 'done' ? 'online' : 'idle'}`}>
                        {meeting.status || 'idle'}
                      </span>
                      <ArrowRight className="h-4 w-4 text-slate-500" />
                    </div>
                  </button>
                ))
              )}
            </div>
          </div>
        </section>

        <section className="grid grid-cols-1 gap-6 xl:grid-cols-[1fr_1fr]">
          <div className="surface-card p-5 sm:p-6">
            <div className="mb-4 flex items-center gap-2 text-white">
              <CheckCircle2 className="h-5 w-5 text-emerald-300" />
              AI summary card
            </div>
            <div className="space-y-3 text-sm leading-7 text-slate-300">
              <p><span className="font-semibold text-white">Key topics:</span> Recording quality, meeting intelligence, device visibility, and transcript-driven Q&amp;A.</p>
              <p><span className="font-semibold text-white">Action items:</span> Review live monitor, check recent meetings, and ask AI questions from transcript pages.</p>
              <p><span className="font-semibold text-white">System note:</span> UI was upgraded to a polished SaaS-style layout while keeping your existing APIs and recording flow unchanged.</p>
            </div>
          </div>

          <div className="surface-card p-5 sm:p-6">
            <div className="mb-4 flex items-center gap-2 text-white">
              <Cpu className="h-5 w-5 text-primary-300" />
              Device health panel
            </div>
            <div className="space-y-3">
              {devices.slice(0, 4).map((device) => (
                <div key={device.deviceId || device._id} className="surface-card-soft flex items-center justify-between gap-4 p-4">
                  <div>
                    <div className="text-sm font-semibold text-white">{device.name || device.deviceId || 'ESP32 Device'}</div>
                    <div className="mt-1 text-xs text-slate-400">Last seen: {device.lastSeenAt ? new Date(device.lastSeenAt).toLocaleString() : 'Unknown'}</div>
                  </div>
                  <span className={`status-pill ${device.status === 'online' ? 'online' : 'idle'}`}>{device.status || 'offline'}</span>
                </div>
              ))}
              {devices.length === 0 && <div className="text-sm text-slate-500">No devices loaded yet.</div>}
            </div>
          </div>
        </section>
      </div>
    </AppShell>
  );
};

export default Dashboard;