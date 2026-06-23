import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { useNavigate } from 'react-router-dom';
import {
  Calendar,
  ChevronLeft,
  ChevronRight,
  FileText,
  MessageSquare,
  Mic,
  Search,
  Sparkles,
  TabletSmartphone,
  X,
} from 'lucide-react';
import AppShell from '../components/AppShell';
import { useDebounce } from '../hooks/useDebounce';
import { fetchMeetings, setFilters, setPage } from '../store/slices/meetingsSlice';

const STATUS_OPTIONS = [
  { value: '', label: 'All status' },
  { value: 'recording', label: 'Recording' },
  { value: 'processing', label: 'Processing' },
  { value: 'done', label: 'Done' },
  { value: 'completed', label: 'Completed' },
  { value: 'failed', label: 'Failed' },
  { value: 'error', label: 'Error' },
];

const SOURCE_OPTIONS = [
  { value: '', label: 'All sources' },
  { value: 'web', label: 'Web' },
  { value: 'esp32', label: 'ESP32' },
];

const statusClassMap = {
  recording: 'border-red-500/30 bg-red-500/10 text-red-200',
  processing: 'border-amber-500/30 bg-amber-500/10 text-amber-200',
  done: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200',
  completed: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200',
  failed: 'border-red-500/30 bg-red-500/10 text-red-200',
  error: 'border-red-500/30 bg-red-500/10 text-red-200',
};

const formatDate = (date) =>
  new Date(date).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

const formatDuration = (seconds = 0) => {
  const total = Math.max(0, Math.floor(Number(seconds || 0)));
  const minutes = Math.floor(total / 60);
  const secs = total % 60;
  return `${minutes}m ${String(secs).padStart(2, '0')}s`;
};

const getStatusClass = (status) => statusClassMap[String(status || '').toLowerCase()] || 'border-white/10 bg-white/5 text-slate-300';

const MeetingRowActions = ({ meeting, navigate }) => (
  <div className="flex items-center justify-end gap-2">
    <button
      onClick={(event) => {
        event.stopPropagation();
        navigate(`/transcripts/${meeting.meetingId || meeting._id}`);
      }}
      className="rounded-xl p-2 text-slate-300 transition hover:bg-white/10 hover:text-white"
      title="View transcript"
    >
      <FileText className="h-4 w-4" />
    </button>
    <button
      onClick={(event) => {
        event.stopPropagation();
        navigate(`/qa/${meeting.meetingId || meeting._id}`);
      }}
      className="rounded-xl p-2 text-slate-300 transition hover:bg-white/10 hover:text-white"
      title="Ask questions"
    >
      <MessageSquare className="h-4 w-4" />
    </button>
  </div>
);

const Meetings = () => {
  const dispatch = useDispatch();
  const navigate = useNavigate();
  const { items, loading, filters, pagination } = useSelector((state) => state.meetings);

  const [localSearch, setLocalSearch] = useState(filters.search || '');
  const debouncedSearch = useDebounce(localSearch, 350);

  useEffect(() => {
    const params = {
      page: pagination.page,
      limit: pagination.limit,
      sort: '-createdAt',
    };
    if (filters.status) params.status = filters.status;
    if (filters.source) params.source = filters.source;
    if (filters.deviceId) params.deviceId = filters.deviceId;
    if (debouncedSearch) params.q = debouncedSearch;

    dispatch(fetchMeetings(params));
  }, [debouncedSearch, dispatch, filters.deviceId, filters.source, filters.status, pagination.limit, pagination.page]);

  const handleFilterChange = useCallback(
    (key, value) => {
      dispatch(setPage(1));
      dispatch(setFilters({ [key]: value }));
    },
    [dispatch]
  );

  const clearAllFilters = useCallback(() => {
    setLocalSearch('');
    dispatch(setPage(1));
    dispatch(setFilters({ status: '', source: '', search: '', deviceId: '' }));
  }, [dispatch]);

  const hasActiveFilters = Boolean(filters.status || filters.source || localSearch);

  const completedCount = useMemo(
    () => items.filter((item) => ['done', 'completed'].includes(String(item.status || '').toLowerCase())).length,
    [items]
  );

  return (
    <AppShell>
      <div className="space-y-6">
        <section className="glass-panel overflow-hidden rounded-3xl p-5 sm:p-7">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-primary-500/20 bg-primary-500/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.22em] text-primary-200">
                <Sparkles className="h-3.5 w-3.5" />
                Meeting history
              </div>
              <h1 className="text-3xl font-semibold text-white sm:text-4xl">Meetings</h1>
              <p className="mt-2 max-w-2xl text-sm leading-7 text-slate-400">
                Dynamic meeting list with live status, compact responsive layout, and quick transcript/Q&amp;A actions.
              </p>
            </div>

            <div className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 sm:grid-cols-3">
              <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                <div className="text-[11px] uppercase tracking-[0.2em] text-slate-500">Total</div>
                <div className="mt-2 text-xl font-semibold text-white">{pagination.total || 0}</div>
              </div>
              <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                <div className="text-[11px] uppercase tracking-[0.2em] text-slate-500">Done</div>
                <div className="mt-2 text-xl font-semibold text-emerald-300">{completedCount}</div>
              </div>
              <button
                onClick={() => navigate('/meetings/new')}
                className="rounded-2xl border border-primary-500/30 bg-primary-500/15 p-4 text-left text-primary-100 transition hover:bg-primary-500/20"
              >
                <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.2em] text-primary-300">
                  <Mic className="h-3.5 w-3.5" /> New
                </div>
                <div className="mt-2 text-base font-semibold">Create meeting</div>
              </button>
            </div>
          </div>
        </section>

        <section className="surface-card rounded-3xl p-4 sm:p-5">
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-[minmax(0,1fr)_auto_auto]">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
              <input
                value={localSearch}
                onChange={(event) => {
                  setLocalSearch(event.target.value);
                  dispatch(setPage(1));
                }}
                placeholder="Search by title or meeting ID"
                className="input-field w-full pl-10 pr-10"
              />
              {localSearch && (
                <button
                  onClick={() => {
                    setLocalSearch('');
                    dispatch(setPage(1));
                  }}
                  className="absolute right-3 top-1/2 -translate-y-1/2 rounded-lg p-1 text-slate-500 transition hover:bg-white/10 hover:text-white"
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>

            <select
              value={filters.status}
              onChange={(event) => handleFilterChange('status', event.target.value)}
              className="input-field w-full md:min-w-0 xl:min-w-[180px]"
            >
              {STATUS_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>

            <select
              value={filters.source}
              onChange={(event) => handleFilterChange('source', event.target.value)}
              className="input-field w-full md:min-w-0 xl:min-w-[180px]"
            >
              {SOURCE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-slate-500">
            <TabletSmartphone className="h-3.5 w-3.5" />
            Responsive table/cards for mobile, tablet, and laptop.
            {hasActiveFilters && (
              <button
                onClick={clearAllFilters}
                className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-slate-300 transition hover:bg-white/10 hover:text-white"
              >
                Clear filters
              </button>
            )}
          </div>
        </section>

        <section className="surface-card overflow-hidden rounded-3xl">
          <div className="hidden overflow-x-auto xl:block">
            <table className="w-full min-w-[980px]">
              <thead>
                <tr className="border-b border-white/10">
                  {['Meeting', 'Status', 'Source', 'Date', 'Duration', 'Actions'].map((label) => (
                    <th
                      key={label}
                      className={`px-6 py-5 text-xs font-semibold uppercase tracking-[0.24em] text-slate-500 ${label === 'Actions' ? 'text-right' : 'text-left'}`}
                    >
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {loading ? (
                  [...Array(5)].map((_, index) => (
                    <tr key={index}>
                      <td colSpan="6" className="px-6 py-4">
                        <div className="skeleton h-16 w-full rounded-2xl" />
                      </td>
                    </tr>
                  ))
                ) : items.length === 0 ? (
                  <tr>
                    <td colSpan="6" className="px-6 py-16 text-center text-slate-400">
                      No meetings found.
                    </td>
                  </tr>
                ) : (
                  items.map((meeting) => (
                    <tr
                      key={meeting._id}
                      onClick={() => navigate(`/meetings/${meeting._id}`)}
                      className="cursor-pointer transition hover:bg-white/5"
                    >
                      <td className="px-6 py-5">
                        <div className="flex items-center gap-4">
                          <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-emerald-500/15 bg-emerald-500/10">
                            <Mic className="h-5 w-5 text-emerald-300" />
                          </div>
                          <div className="min-w-0">
                            <div className="truncate text-[1.65rem] sm:text-base font-semibold text-white">
                              {meeting.title || 'Untitled meeting'}
                            </div>
                            <div className="truncate text-xs text-slate-500">{meeting.meetingId}</div>
                          </div>
                        </div>
                      </td>
                      <td className="px-6 py-5">
                        <span className={`rounded-full border px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.14em] ${getStatusClass(meeting.status)}`}>
                          {meeting.status || 'idle'}
                        </span>
                      </td>
                      <td className="px-6 py-5">
                        <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-medium capitalize text-slate-300">
                          {meeting.source || '—'}
                        </span>
                      </td>
                      <td className="px-6 py-5 text-sm text-slate-400">{formatDate(meeting.createdAt)}</td>
                      <td className="px-6 py-5 text-sm font-medium text-white">{formatDuration(meeting.stats?.durationSec)}</td>
                      <td className="px-6 py-5 text-right">
                        <MeetingRowActions meeting={meeting} navigate={navigate} />
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          <div className="space-y-3 p-3 lg:hidden">
            {loading ? (
              [...Array(4)].map((_, index) => <div key={index} className="skeleton h-36 rounded-3xl" />)
            ) : items.length === 0 ? (
              <div className="rounded-3xl border border-white/10 bg-white/5 p-8 text-center text-slate-400">
                <Calendar className="mx-auto mb-3 h-10 w-10 opacity-30" />
                No meetings found.
              </div>
            ) : (
              items.map((meeting) => (
                <article
                  key={meeting._id}
                  role="button"
                  tabIndex={0}
                  onClick={() => navigate(`/meetings/${meeting._id}`)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      navigate(`/meetings/${meeting._id}`);
                    }
                  }}
                  className="w-full rounded-3xl border border-white/10 bg-white/5 p-4 text-left transition hover:bg-white/10"
                >
                  <div className="flex items-start gap-3">
                    <div className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-2xl border border-emerald-500/15 bg-emerald-500/10">
                      <Mic className="h-5 w-5 text-emerald-300" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-base font-semibold text-white">{meeting.title || 'Untitled meeting'}</div>
                      <div className="truncate text-xs text-slate-500">{meeting.meetingId}</div>
                      <div className="mt-3 flex flex-wrap gap-2">
                        <span className={`rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.14em] ${getStatusClass(meeting.status)}`}>
                          {meeting.status || 'idle'}
                        </span>
                        <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[11px] font-medium capitalize text-slate-300">
                          {meeting.source || '—'}
                        </span>
                      </div>
                      <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
                        <div>
                          <div className="text-[11px] uppercase tracking-[0.18em] text-slate-500">Date</div>
                          <div className="mt-1 text-slate-300">{formatDate(meeting.createdAt)}</div>
                        </div>
                        <div>
                          <div className="text-[11px] uppercase tracking-[0.18em] text-slate-500">Duration</div>
                          <div className="mt-1 text-white">{formatDuration(meeting.stats?.durationSec)}</div>
                        </div>
                      </div>
                      <div className="mt-4 flex items-center justify-end gap-2">
                        <MeetingRowActions meeting={meeting} navigate={navigate} />
                      </div>
                    </div>
                  </div>
                </article>
              ))
            )}
          </div>

          <div className="flex flex-col gap-3 border-t border-white/10 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
            <div className="text-sm text-slate-500">
              Showing <span className="font-semibold text-white">{items.length}</span> of{' '}
              <span className="font-semibold text-white">{pagination.total}</span> meetings
            </div>
            <div className="flex items-center gap-2 self-end sm:self-auto">
              <button
                onClick={() => dispatch(setPage(pagination.page - 1))}
                disabled={pagination.page <= 1}
                className="rounded-xl border border-white/10 bg-white/5 p-2 text-slate-300 transition hover:bg-white/10 disabled:opacity-30"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <div className="min-w-[110px] text-center text-sm text-slate-400">
                Page <span className="font-semibold text-white">{pagination.page}</span> /{' '}
                <span className="font-semibold text-white">{Math.max(1, pagination.totalPages)}</span>
              </div>
              <button
                onClick={() => dispatch(setPage(pagination.page + 1))}
                disabled={pagination.page >= pagination.totalPages}
                className="rounded-xl border border-white/10 bg-white/5 p-2 text-slate-300 transition hover:bg-white/10 disabled:opacity-30"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          </div>
        </section>
      </div>
    </AppShell>
  );
};

export default Meetings;
