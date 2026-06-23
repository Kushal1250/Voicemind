import React, { useEffect, useState, useCallback } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { useNavigate } from 'react-router-dom';
import {
  FileText, Search, ArrowRight, Sparkles, CheckCircle2,
  Clock, Loader2, X, MessageSquare, SlidersHorizontal, ChevronDown,
} from 'lucide-react';
import AppShell from '../components/AppShell';
import { fetchTranscripts } from '../store/slices/transcriptsSlice';
import { useDebounce } from '../hooks/useDebounce';

const STATUS_COLORS = {
  completed: 'online',
  partial: 'processing',
  processing: 'processing',
  pending: 'idle',
  failed: 'idle',
};

const HighlightText = ({ text, query }) => {
  if (!query || !query.trim() || !text) return <span>{text}</span>;
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const parts = String(text).split(new RegExp(`(${escaped})`, 'gi'));
  return (
    <span>
      {parts.map((part, i) =>
        part.toLowerCase() === query.toLowerCase() ? (
          <mark key={i} className="rounded bg-amber-400/25 px-0.5 text-amber-200 not-italic">
            {part}
          </mark>
        ) : (
          <span key={i}>{part}</span>
        )
      )}
    </span>
  );
};

const SOURCE_OPTIONS = [
  { value: '', label: 'All Sources' },
  { value: 'web', label: 'Web' },
  { value: 'esp32', label: 'ESP32' },
];

const STATUS_OPTIONS = [
  { value: '', label: 'All Status' },
  { value: 'completed', label: 'Completed' },
  { value: 'processing', label: 'Processing' },
  { value: 'partial', label: 'Partial' },
  { value: 'pending', label: 'Pending' },
  { value: 'failed', label: 'Failed' },
];

const FilterSelect = ({ value, onChange, options }) => {
  const isActive = value !== '';
  return (
    <div style={{ position: 'relative', display: 'inline-block', width: '100%', minWidth: '0' }}>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{
          background: isActive ? '#1e3a5f' : '#0f172a',
          border: isActive
            ? '1px solid rgba(99,179,237,0.45)'
            : '1px solid rgba(255,255,255,0.12)',
          color: isActive ? '#e2e8f0' : '#94a3b8',
          borderRadius: '12px',
          padding: '8px 36px 8px 14px',
          fontSize: '13px',
          fontWeight: '500',
          cursor: 'pointer',
          appearance: 'none',
          WebkitAppearance: 'none',
          MozAppearance: 'none',
          outline: 'none',
          minWidth: '0',
          width: '100%',
          transition: 'border-color 0.15s, background 0.15s',
        }}
      >
        {options.map(({ value: v, label }) => (
          <option key={v} value={v} style={{ background: '#0f172a', color: '#e2e8f0' }}>
            {label}
          </option>
        ))}
      </select>
      <ChevronDown
        style={{
          position: 'absolute',
          right: '10px',
          top: '50%',
          transform: 'translateY(-50%)',
          pointerEvents: 'none',
          width: '14px',
          height: '14px',
          color: isActive ? '#63b3ed' : '#64748b',
        }}
      />
    </div>
  );
};

const Transcripts = () => {
  const dispatch = useDispatch();
  const navigate = useNavigate();
  const { items = [], loading, pagination = {} } = useSelector((state) => state.transcripts || {});

  const [localSearch, setLocalSearch] = useState('');
  const [sourceFilter, setSourceFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const debouncedSearch = useDebounce(localSearch, 380);

  useEffect(() => {
    const params = { page: 1, limit: 30 };
    if (debouncedSearch.trim()) params.q = debouncedSearch.trim();
    if (sourceFilter) params.source = sourceFilter;
    if (statusFilter) params.processingStatus = statusFilter;
    dispatch(fetchTranscripts(params));
  }, [debouncedSearch, sourceFilter, statusFilter, dispatch]);

  const clearSearch = useCallback(() => setLocalSearch(''), []);
  const clearAll = useCallback(() => {
    setLocalSearch('');
    setSourceFilter('');
    setStatusFilter('');
  }, []);

  const hasFilters = !!(localSearch || sourceFilter || statusFilter);
  const safeItems = Array.isArray(items) ? items : [];

  return (
    <AppShell>
      <div className="space-y-6">
        <section className="glass-panel overflow-hidden p-6 sm:p-8">
          <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-primary-500/20 bg-primary-500/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.24em] text-primary-200">
                <Sparkles className="h-3.5 w-3.5" />
                Transcript library
              </div>
              <h1 className="section-title text-3xl">All transcripts</h1>
              <p className="section-subtitle">Browse and search through every meeting transcript.</p>
            </div>

            <div className="relative w-full max-w-sm">
              <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
              <input
                type="text"
                placeholder="Search by title or transcript text…"
                value={localSearch}
                onChange={(e) => setLocalSearch(e.target.value)}
                className="input-field w-full pl-11 pr-10"
              />
              {localSearch && (
                <button
                  onClick={clearSearch}
                  className="absolute right-3 top-1/2 -translate-y-1/2 rounded p-0.5 text-slate-500 hover:text-white transition"
                  aria-label="Clear search"
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>
          </div>

          <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
            <div className="w-full sm:w-auto sm:min-w-[160px]">
              <FilterSelect value={sourceFilter} onChange={setSourceFilter} options={SOURCE_OPTIONS} />
            </div>
            <div className="w-full sm:w-auto sm:min-w-[160px]">
              <FilterSelect value={statusFilter} onChange={setStatusFilter} options={STATUS_OPTIONS} />
            </div>

            {hasFilters && (
              <button
                onClick={clearAll}
                className="flex items-center gap-1.5 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs font-medium text-slate-300 hover:text-white hover:bg-white/10 transition"
              >
                <X className="h-3.5 w-3.5" /> Clear all filters
              </button>
            )}

            <div className="flex items-center gap-2 text-xs text-slate-500 sm:ml-auto">
              <SlidersHorizontal className="h-3.5 w-3.5" />
              {loading
                ? 'Searching…'
                : pagination?.total != null
                  ? `${pagination.total} transcript${pagination.total !== 1 ? 's' : ''} found`
                  : `${safeItems.length} transcript${safeItems.length !== 1 ? 's' : ''} found`}
              {hasFilters && !loading && ' · filters active'}
            </div>
          </div>

          {hasFilters && !loading && (
            <div className="mt-3 flex flex-wrap gap-2">
              {localSearch && (
                <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/30 bg-amber-500/10 px-3 py-1 text-xs font-semibold text-amber-200">
                  Text: "{localSearch}"
                  <button onClick={clearSearch} aria-label="Remove text filter">
                    <X className="h-3 w-3 hover:text-white" />
                  </button>
                </span>
              )}
              {sourceFilter && (
                <span className="inline-flex items-center gap-1.5 rounded-full border border-sky-500/30 bg-sky-500/10 px-3 py-1 text-xs font-semibold text-sky-200">
                  Source: {sourceFilter}
                  <button onClick={() => setSourceFilter('')} aria-label="Remove source filter">
                    <X className="h-3 w-3 hover:text-white" />
                  </button>
                </span>
              )}
              {statusFilter && (
                <span className="inline-flex items-center gap-1.5 rounded-full border border-primary-500/30 bg-primary-500/10 px-3 py-1 text-xs font-semibold text-primary-200">
                  Status: {statusFilter}
                  <button onClick={() => setStatusFilter('')} aria-label="Remove status filter">
                    <X className="h-3 w-3 hover:text-white" />
                  </button>
                </span>
              )}
            </div>
          )}
        </section>

        <div className="surface-card overflow-hidden">
          {loading ? (
            <div className="flex items-center justify-center gap-3 py-20 text-slate-500">
              <Loader2 className="h-6 w-6 animate-spin" />
              {localSearch ? `Searching for "${localSearch}"…` : 'Loading transcripts…'}
            </div>
          ) : safeItems.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 text-center">
              <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl border border-white/10 bg-white/5">
                <FileText className="h-8 w-8 text-slate-500" />
              </div>
              <p className="text-lg font-semibold text-white">
                {hasFilters ? 'No results found' : 'No transcripts yet'}
              </p>
              {hasFilters ? (
                <>
                  <p className="mt-2 max-w-sm text-sm text-slate-400">
                    No transcripts match your filters. Try different keywords or clear the filters.
                  </p>
                  <button onClick={clearAll} className="mt-4 btn-secondary px-4 py-2 text-xs">
                    Clear all filters
                  </button>
                </>
              ) : (
                <p className="mt-2 max-w-sm text-sm text-slate-400">
                  Complete a meeting recording and transcripts will appear here.
                </p>
              )}
            </div>
          ) : (
            <div className="divide-y divide-white/5">
              {safeItems.map((item) => {
                const transcriptTargetId = item.meetingId || item._id;
                return (
                <div
                  key={transcriptTargetId || item.createdAt || Math.random()}
                  role="button"
                  tabIndex={transcriptTargetId ? 0 : -1}
                  onClick={() => transcriptTargetId && navigate(`/transcripts/${transcriptTargetId}`)}
                  onKeyDown={(e) => {
                    if (!transcriptTargetId) return;
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      navigate(`/transcripts/${transcriptTargetId}`);
                    }
                  }}
                  className={`group flex w-full items-start gap-4 p-5 text-left transition hover:bg-white/5 ${transcriptTargetId ? 'cursor-pointer' : 'cursor-default opacity-70'}`}
                >
                  <div className={`mt-0.5 flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl border ${
                    item.processingStatus === 'completed'
                      ? 'border-emerald-500/20 bg-emerald-500/10'
                      : item.processingStatus === 'processing' || item.processingStatus === 'partial'
                        ? 'border-amber-500/20 bg-amber-500/10'
                        : 'border-white/10 bg-white/5'
                  }`}>
                    {item.processingStatus === 'completed' ? (
                      <CheckCircle2 className="h-5 w-5 text-emerald-300" />
                    ) : item.processingStatus === 'processing' ? (
                      <Loader2 className="h-5 w-5 animate-spin text-amber-300" />
                    ) : (
                      <FileText className="h-5 w-5 text-slate-400" />
                    )}
                  </div>

                  <div className="min-w-0 flex-1">
                    <div className="mb-1.5 flex flex-wrap items-center gap-2">
                      <h3 className="truncate font-semibold text-white">
                        <HighlightText text={item.title || 'Untitled meeting'} query={localSearch} />
                      </h3>
                      <span className={`status-pill ${STATUS_COLORS[item.processingStatus] || 'idle'}`}>
                        {item.processingStatus || 'pending'}
                      </span>
                      {item.source && (
                        <span className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[11px] font-medium capitalize text-slate-400">
                          {item.source}
                        </span>
                      )}
                    </div>

                    {item.preview ? (
                      <p className="line-clamp-2 text-sm leading-6 text-slate-400">
                        <HighlightText text={item.preview} query={localSearch} />
                      </p>
                    ) : item.processingStatus === 'partial' || item.processingStatus === 'processing' ? (
                      <p className="text-sm italic text-amber-500/70">Transcript processing — content arriving…</p>
                    ) : (
                      <p className="text-sm italic text-slate-600">No transcript content yet</p>
                    )}

                    <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-slate-500">
                      <div className="flex items-center gap-1">
                        <Clock className="h-3.5 w-3.5" />
                        {new Date(item.createdAt || item.updatedAt || Date.now()).toLocaleString()}
                      </div>
                      {Number(item.stats?.durationSec || 0) > 0 && (
                        <span>
                          · {Math.floor(Number(item.stats.durationSec) / 60)}m {Number(item.stats.durationSec) % 60}s
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="flex flex-shrink-0 items-center gap-1 opacity-0 transition group-hover:opacity-100">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        if (transcriptTargetId) navigate(`/qa/${transcriptTargetId}`);
                      }}
                      title="Open Q&A"
                      className="rounded-xl p-2 transition hover:bg-white/10"
                    >
                      <MessageSquare className="h-4 w-4 text-slate-400" />
                    </button>
                    <ArrowRight className="h-4 w-4 text-slate-600 transition group-hover:translate-x-1 group-hover:text-primary-300" />
                  </div>
                </div>
              );})}
            </div>
          )}
        </div>
      </div>
    </AppShell>
  );
};

export default Transcripts;