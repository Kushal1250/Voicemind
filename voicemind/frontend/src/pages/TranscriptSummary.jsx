import React, { useEffect, useMemo } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useDispatch, useSelector } from 'react-redux';
import {
  ArrowLeft,
  FileText,
  RefreshCw,
  CalendarDays,
  AlertTriangle,
  CheckCircle2,
  ClipboardList,
  HelpCircle,
  Quote,
  Users,
  Layers3,
  ShieldAlert,
  Target,
} from 'lucide-react';
import { toast } from 'react-toastify';
import AppShell from '../components/AppShell';
import api from '../services/api';
import {
  fetchTranscriptSummary,
  generateTranscriptSummary,
  fetchTranscriptByMeetingId,
} from '../store/slices/transcriptsSlice';

const EMPTY_SECTION_TEXT = 'No confirmed items extracted for this section.';

const SectionCard = ({ icon: Icon, title, children, emptyText = EMPTY_SECTION_TEXT, className = '' }) => {
  const hasContent = React.Children.count(children) > 0;

  return (
    <section className={`glass-panel p-6 ${className}`.trim()}>
      <div className="mb-4 flex items-center gap-3">
        <div className="rounded-2xl border border-primary-500/20 bg-primary-500/10 p-2 text-primary-200">
          <Icon className="h-5 w-5" />
        </div>
        <h2 className="text-lg font-semibold text-white">{title}</h2>
      </div>
      {hasContent ? children : <p className="text-sm text-slate-400">{emptyText}</p>}
    </section>
  );
};

const SummarySkeleton = () => (
  <div className="space-y-6 animate-pulse">
    <div className="glass-panel p-6 sm:p-8">
      <div className="h-6 w-40 rounded bg-white/10" />
      <div className="mt-4 h-10 w-72 rounded bg-white/10" />
      <div className="mt-3 h-4 w-96 rounded bg-white/10" />
    </div>
    <div className="grid gap-6 xl:grid-cols-2">
      {[...Array(8)].map((_, index) => (
        <div key={index} className="glass-panel p-6">
          <div className="h-5 w-40 rounded bg-white/10" />
          <div className="mt-4 space-y-3">
            <div className="h-4 w-full rounded bg-white/10" />
            <div className="h-4 w-5/6 rounded bg-white/10" />
            <div className="h-4 w-3/4 rounded bg-white/10" />
          </div>
        </div>
      ))}
    </div>
  </div>
);

const formatDateTime = (value) => {
  if (!value) return 'Not available';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Not available';
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
};

const formatLabel = (value) => String(value || '')
  .replace(/_/g, ' ')
  .replace(/\b\w/g, (match) => match.toUpperCase());

const renderKeyPointLine = (item) => {
  if (!item) return '';
  if (typeof item === 'string') return item;
  if (item.displayText) return item.displayText;

  const speaker = String(item?.speaker || '').trim();
  const label = String(item?.label || '').trim();
  const point = String(item?.point || item?.value || '').trim();

  if (speaker && label && point) {
    return `${speaker} - (${label}) : ${point}`;
  }

  return point;
};

const hasRichSummary = (summary) => Boolean(
  summary && (
    summary.executiveSummary?.length
    || summary.participants?.length
    || summary.keyPoints?.length
    || summary.decisions?.length
    || summary.actionItems?.length
    || summary.risks?.length
    || summary.openQuestions?.length
    || summary.importantNotes?.length
    || summary.topics?.length
    || summary.confidenceNotes?.length
  )
);

const TranscriptSummary = () => {
  const { meetingId } = useParams();
  const navigate = useNavigate();
  const dispatch = useDispatch();
  const {
    currentSummary,
    currentTranscript,
    summaryLoading,
    summaryError,
  } = useSelector((state) => state.transcripts);

  useEffect(() => {
    if (!meetingId) return;
    dispatch(fetchTranscriptByMeetingId(meetingId));
    dispatch(fetchTranscriptSummary(meetingId));
  }, [dispatch, meetingId]);

  const summaryPayload = currentSummary?.meetingId === meetingId ? currentSummary : null;
  const summary = useMemo(
    () => summaryPayload?.summary || currentTranscript?.summaryData || null,
    [summaryPayload, currentTranscript?.summaryData],
  );

  const meetingTitle = summaryPayload?.title || currentTranscript?.title || 'Untitled meeting';
  const meetingDate = summaryPayload?.meeting?.createdAt || currentTranscript?.createdAt || null;
  const hasSummary = hasRichSummary(summary);

  // Filter any server-internal notes from confidenceNotes before display
  const safeConfidenceNotes = React.useMemo(() => {
    if (!Array.isArray(summary?.confidenceNotes)) return [];
    return summary.confidenceNotes.filter((note) => {
      const n = String(note || '').toLowerCase();
      return (
        !n.includes('gemini') &&
        !n.includes('fallback') &&
        !n.includes('unavailable') &&
        !n.includes('local fallback') &&
        n.trim().length > 0
      );
    });
  }, [summary?.confidenceNotes]);

  // Filter provider-internal text from importantNotes
  const safeImportantNotes = React.useMemo(() => {
    if (!Array.isArray(summary?.importantNotes)) return [];
    return summary.importantNotes.filter((note) => {
      const n = String(note || '').toLowerCase();
      return (
        !n.includes('fallback') &&
        !n.includes('gemini') &&
        !n.includes('unavailable') &&
        n.trim().length > 0
      );
    });
  }, [summary?.importantNotes]);

  const handleRegenerate = async () => {
    try {
      toast.info('Regenerating summary…');
      await dispatch(generateTranscriptSummary({ meetingId, force: true })).unwrap();
      toast.success('Summary regenerated');
    } catch (error) {
      toast.error(String(error || 'Failed to regenerate summary'));
    }
  };

  const handleExportPdf = async () => {
    if (!hasSummary) {
      toast.error('No summary available for export');
      return;
    }

    try {
      const response = await api.get(`/transcripts/${meetingId}/export/summary`, {
        responseType: 'blob',
      });

      const blob = new Blob([response.data], { type: 'text/html' });
      const blobUrl = window.URL.createObjectURL(blob);
      const iframe = document.createElement('iframe');
      iframe.style.position = 'fixed';
      iframe.style.right = '0';
      iframe.style.bottom = '0';
      iframe.style.width = '0';
      iframe.style.height = '0';
      iframe.style.border = '0';
      iframe.src = blobUrl;

      iframe.onload = () => {
        try {
          iframe.contentWindow?.focus();
          iframe.contentWindow?.print();
          toast.success('Summary export opened');
        } catch (error) {
          toast.error('Summary export failed');
        } finally {
          setTimeout(() => {
            window.URL.revokeObjectURL(blobUrl);
            iframe.remove();
          }, 2000);
        }
      };

      document.body.appendChild(iframe);
    } catch (error) {
      toast.error(String(error?.response?.data?.error?.message || error?.message || 'Summary export failed'));
    }
  };

  return (
    <AppShell>
      <div className="space-y-6">
        <section className="glass-panel overflow-hidden p-6 sm:p-8">
          <div className="flex flex-col gap-6 xl:flex-row xl:items-start xl:justify-between">
            <div>
              <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-primary-500/20 bg-primary-500/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.24em] text-primary-200">
                <ClipboardList className="h-3.5 w-3.5" />
                Meeting Summary
              </div>
              <h1 className="section-title text-3xl">{meetingTitle}</h1>
              <div className="mt-3 flex flex-wrap items-center gap-4 text-sm text-slate-400">
                <span className="inline-flex items-center gap-2">
                  <CalendarDays className="h-4 w-4" />
                  {formatDateTime(meetingDate)}
                </span>
                {summary?.generatedAt && (
                  <span>Generated {formatDateTime(summary.generatedAt)}</span>
                )}
              </div>
            </div>

            <div className="flex flex-wrap gap-3">
              <button onClick={() => navigate(`/transcripts/${meetingId}`)} className="btn-secondary">
                <ArrowLeft className="h-4 w-4" />
                Back to Transcript
              </button>
              <button onClick={handleExportPdf} disabled={!hasSummary} className="btn-secondary">
                <FileText className="h-4 w-4" />
                Export PDF
              </button>
              <button onClick={handleRegenerate} disabled={summaryLoading} className="btn-primary">
                <RefreshCw className={`h-4 w-4 ${summaryLoading ? 'animate-spin' : ''}`} />
                {summaryLoading ? 'Regenerating...' : 'Regenerate Summary'}
              </button>
            </div>
          </div>
        </section>

        {summaryLoading && !hasSummary ? (
          <SummarySkeleton />
        ) : summaryError && !hasSummary ? (
          <section className="glass-panel p-6 text-center">
            <AlertTriangle className="mx-auto h-10 w-10 text-amber-300" />
            <h2 className="mt-4 text-xl font-semibold text-white">Summary unavailable</h2>
            <p className="mt-2 text-sm text-slate-400">{summaryError}</p>
            <div className="mt-6 flex justify-center gap-3">
              <button onClick={() => navigate(`/transcripts/${meetingId}`)} className="btn-secondary">
                Back to Transcript
              </button>
              <button onClick={handleRegenerate} className="btn-primary">
                Generate Summary
              </button>
            </div>
          </section>
        ) : !hasSummary ? (
          <section className="glass-panel p-6 text-center">
            <HelpCircle className="mx-auto h-10 w-10 text-slate-300" />
            <h2 className="mt-4 text-xl font-semibold text-white">No summary yet</h2>
            <p className="mt-2 text-sm text-slate-400">
              Generate a structured summary to view the key decisions, action items, participants, and follow-ups for this meeting.
            </p>
            <div className="mt-6 flex justify-center gap-3">
              <button onClick={() => navigate(`/transcripts/${meetingId}`)} className="btn-secondary">
                Back to Transcript
              </button>
              <button onClick={handleRegenerate} className="btn-primary">
                Generate Summary
              </button>
            </div>
          </section>
        ) : (
          <div className="grid gap-6 xl:grid-cols-2">
            <SectionCard icon={ClipboardList} title="Executive Summary" emptyText="No executive summary generated.">
              <div className="space-y-3">
                {summary.executiveSummary.map((item, index) => (
                  <div key={`${item}-${index}`} className="rounded-2xl border border-white/10 bg-white/5 p-4 text-sm text-slate-200">
                    {item}
                  </div>
                ))}
              </div>
            </SectionCard>

            <SectionCard icon={Users} title="Participants">
              <div className="grid gap-4 md:grid-cols-2">
                {summary.participants.map((participant, index) => (
                  <div key={`${participant.speaker}-${index}`} className="rounded-2xl border border-white/10 bg-white/5 p-4 text-sm text-slate-200">
                    <div className="font-semibold text-white">
                      {participant.name ? `${participant.name} (${participant.speaker})` : participant.speaker}
                    </div>
                    <div className="mt-3 space-y-2 text-sm text-slate-300">
                      <div><span className="font-medium text-white">Name:</span> {participant.name || 'Not specified'}</div>
                      <div><span className="font-medium text-white">Role:</span> {participant.role || 'Not specified'}</div>
                      <div><span className="font-medium text-white">Organization:</span> {participant.organization || 'Not specified'}</div>
                      <div><span className="font-medium text-white">Education:</span> {participant.education || 'Not specified'}</div>
                      <div><span className="font-medium text-white">Project Association:</span> {participant.projectAssociation.length ? participant.projectAssociation.join(', ') : 'Not specified'}</div>
                    </div>
                    {participant.keyContributions.length > 0 && (
                      <div className="mt-4 rounded-2xl border border-primary-500/20 bg-primary-500/10 p-3 text-xs text-primary-100">
                        <div className="mb-2 font-semibold uppercase tracking-wide">Key Contributions</div>
                        <ul className="space-y-1">
                          {participant.keyContributions.map((item) => (
                            <li key={item}>• {item}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </SectionCard>

            <SectionCard icon={CheckCircle2} title="Key Points">
              <div className="space-y-3 text-sm text-slate-200">
                {summary.keyPoints.map((item, index) => {
                  const key = typeof item === 'string'
                    ? item
                    : item.displayText || item.point || `key-point-${index}`;

                  return (
                    <div key={`${key}-${index}`} className="rounded-2xl border border-white/10 bg-white/5 px-4 py-3 font-medium">
                      {renderKeyPointLine(item)}
                    </div>
                  );
                })}
              </div>
            </SectionCard>

            <SectionCard icon={CheckCircle2} title="Decisions Made">
              <ul className="space-y-3 text-sm text-slate-200">
                {summary.decisions.map((item, index) => (
                  <li key={`${item}-${index}`} className="rounded-2xl border border-emerald-500/20 bg-emerald-500/10 px-4 py-3">
                    {item}
                  </li>
                ))}
              </ul>
            </SectionCard>

            <SectionCard icon={Target} title="Action Items" emptyText="No action items were extracted.">
              <div className="space-y-3">
                {summary.actionItems.map((item, index) => (
                  <div key={`${item.task}-${index}`} className="rounded-2xl border border-white/10 bg-white/5 p-4 text-sm text-slate-200">
                    <div className="font-medium text-white">{item.task}</div>
                    <div className="mt-3 grid gap-3 text-xs text-slate-400 sm:grid-cols-3 xl:grid-cols-6">
                      <div>
                        <span className="font-semibold text-slate-300">Owner:</span> {item.owner || 'Unassigned'}
                      </div>
                      <div>
                        <span className="font-semibold text-slate-300">Deadline:</span> {item.deadline || 'Not specified'}
                      </div>
                      <div>
                        <span className="font-semibold text-slate-300">Priority:</span> {item.priority ? formatLabel(item.priority) : 'Not specified'}
                      </div>
                      <div>
                        <span className="font-semibold text-slate-300">Status:</span> {formatLabel(item.status || 'open')}
                      </div>
                      <div className="sm:col-span-2 xl:col-span-2">
                        <span className="font-semibold text-slate-300">Supporting Speaker:</span> {item.supportingSpeaker || 'Not specified'}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </SectionCard>

            <SectionCard icon={AlertTriangle} title="Risks / Blockers">
              <ul className="space-y-3 text-sm text-slate-200">
                {summary.risks.map((item, index) => (
                  <li key={`${item}-${index}`} className="rounded-2xl border border-amber-500/20 bg-amber-500/10 px-4 py-3">
                    {item}
                  </li>
                ))}
              </ul>
            </SectionCard>

            <SectionCard icon={HelpCircle} title="Open Questions">
              <ul className="space-y-3 text-sm text-slate-200">
                {summary.openQuestions.map((item, index) => (
                  <li key={`${item}-${index}`} className="rounded-2xl border border-white/10 bg-white/5 px-4 py-3">
                    {item}
                  </li>
                ))}
              </ul>
            </SectionCard>

            <SectionCard icon={Layers3} title="Topics Discussed">
              <div className="space-y-3 text-sm text-slate-200">
                {summary.topics.map((topic, index) => (
                  <div key={`${topic.title}-${index}`} className="rounded-2xl border border-white/10 bg-white/5 p-4">
                    <div className="font-semibold text-white">{topic.title || `Topic ${index + 1}`}</div>
                    <div className="mt-2 text-slate-300">{topic.summary}</div>
                  </div>
                ))}
              </div>
            </SectionCard>

            <div className="xl:col-span-2 grid gap-6 xl:grid-cols-2">
              <SectionCard icon={Quote} title="Important Notes" emptyText="No notable supporting notes were included.">
                <ul className="space-y-3 text-sm text-slate-200">
                  {safeImportantNotes.map((item, index) => (
                    <li key={`${item}-${index}`} className="rounded-2xl border border-white/10 bg-white/5 px-4 py-3">
                      {item}
                    </li>
                  ))}
                </ul>
              </SectionCard>

              <SectionCard icon={ShieldAlert} title="Confidence Notes">
                <ul className="space-y-3 text-sm text-slate-200">
                  {safeConfidenceNotes.map((item, index) => (
                    <li key={`${item}-${index}`} className="rounded-2xl border border-amber-500/20 bg-amber-500/10 px-4 py-3">
                      {item}
                    </li>
                  ))}
                </ul>
              </SectionCard>
            </div>
          </div>
        )}
      </div>
    </AppShell>
  );
};

export default TranscriptSummary;
