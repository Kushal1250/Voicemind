// frontend/src/pages/TranscriptViewer.jsx
import React, { useEffect, useMemo, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useDispatch, useSelector } from 'react-redux';
import {
  Search,
  Copy,
  Download,
  Clock3,
  Sparkles,
  CheckCircle2,
  MessageSquare,
  MessageSquareText,
  FileText,
  ArrowLeft,
  ListChecks,
  AlertTriangle,
  RefreshCw,
  Activity,
  X,
} from 'lucide-react';
import { toast } from 'react-toastify';
import AppShell from '../components/AppShell';
import { buildRenderableTranscriptTurns, selectDisplayTranscript } from '../utils/transcriptTurns';
import {
  fetchTranscriptByMeetingId,
  generateTranscriptSummary,
  generateTranscriptSymptoms,
} from '../store/slices/transcriptsSlice';

const API_BASE = process.env.REACT_APP_API_BASE_URL || 'http://localhost:5001/api';

const KEYWORDS = [
  'decision', 'decisions', 'task', 'tasks', 'important', 'question',
  'action', 'owner', 'blocker',
  'મહત્વપૂર્ણ', 'નિર્ણય', 'કાર્ય', 'પ્રશ્ન', 'અવરોધ', 'ડેડલાઇન',
  'महत्वपूर्ण', 'निर्णय', 'कार्य', 'प्रश्न',
];

const SPEAKER_COLORS = [
  'border-sky-500/30 bg-sky-500/10 text-sky-200',
  'border-emerald-500/30 bg-emerald-500/10 text-emerald-200',
  'border-violet-500/30 bg-violet-500/10 text-violet-200',
  'border-amber-500/30 bg-amber-500/10 text-amber-200',
  'border-fuchsia-500/30 bg-fuchsia-500/10 text-fuchsia-200',
  'border-cyan-500/30 bg-cyan-500/10 text-cyan-200',
];

const escapeRegExp = (value = '') => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const formatTime = (valueMs, valueSeconds) => {
  const ms = Number.isFinite(Number(valueMs))
    ? Number(valueMs)
    : Math.round(Number(valueSeconds || 0) * 1000);

  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = String(Math.floor(totalSeconds / 3600)).padStart(2, '0');
  const minutes = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, '0');
  const seconds = String(totalSeconds % 60).padStart(2, '0');

  return `${hours}:${minutes}:${seconds}`;
};

const textIncludes = (haystack, needle) => {
  if (!haystack || !needle) return false;
  try {
    return String(haystack).toLocaleLowerCase().includes(String(needle).toLocaleLowerCase());
  } catch {
    return String(haystack).includes(String(needle));
  }
};

const hasKeyword = (text) => KEYWORDS.some((kw) => textIncludes(text, kw));

const getSpeakerStyle = (speaker = '') => {
  const value = String(speaker || '').trim().toLowerCase();
  if (!value) return SPEAKER_COLORS[0];
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) hash = ((hash * 31) + value.charCodeAt(i)) >>> 0;
  return SPEAKER_COLORS[hash % SPEAKER_COLORS.length];
};

const normalizeConfidenceLabel = (label) => String(label || '').trim() || 'unknown';

const normalizeTurn = (turn = {}, index = 0) => {
  const startMs = Number.isFinite(Number(turn.startMs))
    ? Number(turn.startMs)
    : Math.round(Number(turn.start || 0) * 1000);

  const endMsCandidate = Number.isFinite(Number(turn.endMs))
    ? Number(turn.endMs)
    : Math.round(Number(turn.end ?? turn.start ?? 0) * 1000);

  const endMs = Math.max(startMs, endMsCandidate);

  return {
    id: turn.id ?? `${turn.chunkIndex ?? 'turn'}-${index}`,
speaker: (() => { const s = String(turn.speaker || 'Speaker 1').trim(); const m = s.match(/(?:speaker[_\s]?)(\d+)/i); return m ? `Speaker ${m[1]}` : 'Speaker 1'; })(),
    startMs,
    endMs,
    startTime: formatTime(startMs),
    endTime: formatTime(endMs),
    time: formatTime(startMs),
    text: String(turn.text || '').trim(),
    rawText: String(turn.text || '').trim(),
    language: turn.language || '',
    confidence: typeof turn.confidence === 'number' ? turn.confidence : null,
    confidenceLabel: normalizeConfidenceLabel(turn.confidenceLabel),
    needsReview: Boolean(turn.needsReview),
    segmentCount: Number(
      turn.segmentCount || (Array.isArray(turn.segments) ? turn.segments.length : 0) || 1,
    ),
    get className() { return getSpeakerStyle(this.speaker); },
  };
};


const ScoreBar = ({ label, value }) => (
  <div>
    <div className="mb-1 flex items-center justify-between text-xs text-slate-400">
      <span>{label}</span>
      <span className="font-semibold text-slate-200">{value}/10</span>
    </div>
    <div className="h-2 rounded-full bg-white/10">
      <div
        className="h-2 rounded-full bg-primary-500 transition-all"
        style={{ width: `${Math.max(0, Math.min(10, Number(value || 0))) * 10}%` }}
      />
    </div>
  </div>
);

const EvidenceList = ({ items = [], withSeverity = false, emptyText }) => (
  <div className="space-y-3">
    {items.length ? items.map((item, index) => (
      <div key={`${item.title}-${index}`} className="rounded-2xl border border-white/10 bg-white/5 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <h4 className="text-sm font-semibold text-white">{item.title || 'Insight'}</h4>
          {withSeverity && item.severity && (
            <span className="rounded-full border border-primary-500/20 bg-primary-500/10 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.2em] text-primary-200">
              {item.severity}
            </span>
          )}
        </div>
        {!!item.detail && <p className="mt-2 text-sm leading-7 text-slate-300">{item.detail}</p>}
        {!!item.evidence?.length && (
          <div className="mt-3 space-y-2">
            {item.evidence.map((evidence, evidenceIndex) => (
              <div
                key={`${item.title}-evidence-${evidenceIndex}`}
                className="rounded-xl border border-white/10 bg-slate-950/60 px-3 py-2 text-xs leading-6 text-slate-400"
              >
                {evidence}
              </div>
            ))}
          </div>
        )}
      </div>
    )) : <p className="text-sm text-slate-500">{emptyText}</p>}
  </div>
);

const SymptomsPanel = ({ symptoms, loading, error, onRefresh, title }) => {
  if (loading) {
    return (
      <section className="glass-panel p-6">
        <div className="flex items-center gap-3 text-white">
          <Activity className="h-5 w-5 text-primary-300 animate-pulse" />
          <div>
            <h2 className="text-xl font-semibold">Generating symptoms analysis</h2>
            <p className="mt-1 text-sm text-slate-400">Analyzing the full meeting and each detected speaker with LM Studio.</p>
          </div>
        </div>
      </section>
    );
  }

  if (error) {
    return (
      <section className="glass-panel p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="text-xl font-semibold text-white">Symptoms analysis failed</h2>
            <p className="mt-2 text-sm text-slate-400">{error}</p>
          </div>
          <button onClick={onRefresh} className="btn-secondary">
            <RefreshCw className="h-4 w-4" />
            Retry
          </button>
        </div>
      </section>
    );
  }

  if (!symptoms?.success) return null;

  return (
    <section className="space-y-6">
      <div className="glass-panel p-6 sm:p-8">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
          <div>
            <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-primary-500/20 bg-primary-500/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.24em] text-primary-200">
              <Activity className="h-3.5 w-3.5" />
              Communication Symptoms
            </div>
            <h2 className="text-2xl font-semibold text-white">{title || 'Speaker communication analysis'}</h2>
            <p className="mt-3 max-w-3xl text-sm leading-7 text-slate-300">
              {symptoms.meetingOverview?.summary || 'No overall meeting communication summary available.'}
            </p>
          </div>
          <button onClick={onRefresh} className="btn-secondary">
            <RefreshCw className="h-4 w-4" />
            Regenerate
          </button>
        </div>

        <div className="mt-6 grid gap-4 lg:grid-cols-2 xl:grid-cols-4">
          {[
            ['Overall style', symptoms.meetingOverview?.overallCommunicationStyle],
            ['Global symptoms', symptoms.meetingOverview?.globalSymptoms],
            ['Risk flags', symptoms.meetingOverview?.riskFlags],
            ['Highlights', symptoms.meetingOverview?.highlights],
          ].map(([label, values]) => (
            <div key={label} className="rounded-3xl border border-white/10 bg-white/5 p-4">
              <div className="text-xs font-semibold uppercase tracking-[0.24em] text-slate-500">{label}</div>
              <div className="mt-3 space-y-2">
                {(values || []).length ? values.map((value) => (
                  <div key={value} className="rounded-xl border border-white/10 bg-slate-950/60 px-3 py-2 text-sm text-slate-200">{value}</div>
                )) : <p className="text-sm text-slate-500">No data</p>}
              </div>
            </div>
          ))}
        </div>

        {!!symptoms.warnings?.length && (
          <div className="mt-5 flex flex-wrap gap-2">
            {symptoms.warnings.map((warning) => (
              <span key={warning} className="rounded-full border border-amber-500/30 bg-amber-500/10 px-3 py-1 text-xs font-semibold text-amber-200">{warning}</span>
            ))}
          </div>
        )}
      </div>

      <div className="grid gap-6">
        {symptoms.speakers.map((speaker) => (
          <article key={speaker.speaker} className="glass-panel p-6">
            <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
              <div>
                <div className={`inline-flex rounded-full border px-3 py-1 text-xs font-semibold uppercase tracking-[0.24em] ${getSpeakerStyle(speaker.speaker)}`}>
                  {speaker.speaker}
                </div>
                <h3 className="mt-3 text-xl font-semibold text-white">{speaker.overallStyle || 'Speaker communication profile'}</h3>
                <div className="mt-2 flex flex-wrap gap-3 text-xs text-slate-400">
                  <span>{speaker.turnCount} turn{speaker.turnCount === 1 ? '' : 's'}</span>
                  <span>{speaker.talkTimeEstimate}s talk time</span>
                  <span className="capitalize">Evidence {speaker.evidenceQuality || 'medium'}</span>
                </div>
              </div>
            </div>

            <div className="mt-6 grid gap-6 xl:grid-cols-[1.2fr_0.8fr]">
              <div className="space-y-6">
                <div>
                  <h4 className="mb-3 text-sm font-semibold uppercase tracking-[0.24em] text-emerald-300">Strong points</h4>
                  <EvidenceList items={speaker.strongPoints || []} emptyText="No strong points extracted." />
                </div>
                <div>
                  <h4 className="mb-3 text-sm font-semibold uppercase tracking-[0.24em] text-amber-300">Weak points</h4>
                  <EvidenceList items={speaker.weakPoints || []} emptyText="No weak points extracted." />
                </div>
                <div>
                  <h4 className="mb-3 text-sm font-semibold uppercase tracking-[0.24em] text-primary-300">Symptoms</h4>
                  <EvidenceList items={speaker.symptoms || []} withSeverity emptyText="No additional symptoms extracted." />
                </div>
              </div>
              <div className="space-y-6">
                <div className="rounded-3xl border border-white/10 bg-white/5 p-5">
                  <h4 className="text-sm font-semibold uppercase tracking-[0.24em] text-slate-400">Communication scorecard</h4>
                  <div className="mt-4 space-y-4">
                    <ScoreBar label="Clarity" value={speaker.communicationScorecard?.clarity || 0} />
                    <ScoreBar label="Confidence" value={speaker.communicationScorecard?.confidence || 0} />
                    <ScoreBar label="Engagement" value={speaker.communicationScorecard?.engagement || 0} />
                    <ScoreBar label="Structure" value={speaker.communicationScorecard?.structure || 0} />
                    <ScoreBar label="Ownership" value={speaker.communicationScorecard?.ownership || 0} />
                  </div>
                </div>
                <div className="rounded-3xl border border-white/10 bg-white/5 p-5">
                  <h4 className="text-sm font-semibold uppercase tracking-[0.24em] text-slate-400">Recommendations</h4>
                  <div className="mt-4 space-y-2">
                    {(speaker.recommendations || []).length ? speaker.recommendations.map((item) => (
                      <div key={item} className="rounded-xl border border-white/10 bg-slate-950/60 px-3 py-2 text-sm text-slate-200">{item}</div>
                    )) : <p className="text-sm text-slate-500">No recommendations available.</p>}
                  </div>
                </div>
              </div>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
};

const TranscriptViewer = () => {
  const { meetingId } = useParams();
  const navigate = useNavigate();
  const dispatch = useDispatch();

  const {
    currentTranscript,
    currentSymptoms,
    loading,
    error,
    summaryLoading,
    symptomsLoading,
    symptomsError,
  } = useSelector((state) => state.transcripts);

  const token = useSelector((state) => state.auth?.token) || localStorage.getItem('voicemind_token');

  const [search, setSearch] = useState('');
  const [speakerFilter, setSpeakerFilter] = useState('all');
  const [viewMode, setViewMode] = useState('segments');
  const [copied, setCopied] = useState(false);
  const [exporting, setExporting] = useState('');
  const [symptomsOpen, setSymptomsOpen] = useState(false);

  useEffect(() => {
    if (meetingId) {
      dispatch(fetchTranscriptByMeetingId(meetingId));
    }
  }, [dispatch, meetingId]);

  useEffect(() => {
    if (!meetingId) return undefined;
    const status = currentTranscript?.processingStatus;
    if (!['pending', 'processing', 'partial'].includes(status)) return undefined;

    const timer = setInterval(() => {
      dispatch(fetchTranscriptByMeetingId(meetingId));
    }, 4000);

    return () => clearInterval(timer);
  }, [currentTranscript?.processingStatus, dispatch, meetingId]);

  const transcriptText = selectDisplayTranscript(currentTranscript || {}, currentTranscript?.finalValidatedText || '');
  const cleanEnglishText =
    selectDisplayTranscript({
      displayText: currentTranscript?.validatedEnglishText || currentTranscript?.cleanEnglish,
      finalBestTranscript: currentTranscript?.translatedEnglish,
      fullText: currentTranscript?.finalValidatedText || currentTranscript?.fullText,
      rawFullText: currentTranscript?.validatedSourceText || currentTranscript?.sourceFullText,
    }, transcriptText) || transcriptText;

  const rawTranscriptText =
    selectDisplayTranscript({
      displayText: currentTranscript?.validatedSourceText || currentTranscript?.sourceFullText,
      fullText: currentTranscript?.rawFullText,
      rawFullText: currentTranscript?.rawTranscriptNormalized,
    }, transcriptText) || transcriptText;

  const uncertainTerms = Array.isArray(currentTranscript?.uncertainTerms)
    ? currentTranscript.uncertainTerms.filter(Boolean)
    : [];

  const confidenceNotes = Array.isArray(currentTranscript?.confidenceNotes)
    ? currentTranscript.confidenceNotes.filter(Boolean).join(' | ')
    : (currentTranscript?.confidenceNotes || '');

  // Script drift: Gujarati speech transcribed in Hindi Devanagari script
  // This is a known Whisper large-v3 limitation for Gujarati language
  const scriptDriftDetected = Boolean(currentTranscript?.scriptDriftDetected);
  const scriptDriftSegments = Number(currentTranscript?.scriptDriftSegments || 0);

  // All pipeline warnings (translation, script drift, hallucination flags)
  const pipelineWarnings = [
    ...Array.isArray(currentTranscript?.warnings) ? currentTranscript.warnings.filter(Boolean) : [],
    ...Array.isArray(currentTranscript?.translationWarnings) ? currentTranscript.translationWarnings.filter(Boolean) : [],
  ].filter((w, i, arr) => arr.indexOf(w) === i); // dedupe

  const speakerTurns = useMemo(
    () => buildRenderableTranscriptTurns(currentTranscript || {}, transcriptText),
    [currentTranscript, transcriptText],
  );

  const speakerOptions = useMemo(
    () => ['all', ...new Set(speakerTurns.map((turn) => turn.speaker).filter(Boolean))],
    [speakerTurns],
  );

  const filteredTurns = useMemo(() => {
    const query = search.trim();

    return speakerTurns.filter((turn) => {
      const matchesSpeaker = speakerFilter === 'all' || turn.speaker === speakerFilter;
      const matchesSearch =
        !query ||
        textIncludes(turn.text, query) ||
        textIncludes(turn.speaker, query);

      return matchesSpeaker && matchesSearch;
    });
  }, [search, speakerFilter, speakerTurns]);

  const renderHighlightedText = (text) => {
    const query = search.trim();
    if (!query) return text;

    let pattern;
    try {
      pattern = new RegExp(`(${escapeRegExp(query)})`, 'giu');
    } catch {
      return text;
    }

    const parts = String(text || '').split(pattern);

    return parts.map((part, index) => {
      if (!part) return null;

      const matched =
        textIncludes(part, query) &&
        String(part).toLocaleLowerCase() === String(query).toLocaleLowerCase();

      return matched ? (
        <mark
          key={`hl-${index}`}
          className="rounded-md bg-amber-400/25 px-1 py-0.5 text-amber-100"
        >
          {part}
        </mark>
      ) : (
        <React.Fragment key={`txt-${index}`}>{part}</React.Fragment>
      );
    });
  };

  const highlightedTranscript = useMemo(() => {
    const activeText = viewMode === 'raw' ? rawTranscriptText : cleanEnglishText || transcriptText;
    if (!search.trim()) return activeText;

    try {
      const regex = new RegExp(`(${escapeRegExp(search.trim())})`, 'giu');
      return activeText.replace(
        regex,
        '<mark class="rounded-md bg-amber-400/25 px-1 py-0.5 text-amber-100">$1</mark>',
      );
    } catch {
      return activeText;
    }
  }, [search, viewMode, rawTranscriptText, cleanEnglishText, transcriptText]);

  const hasTranscriptContent = Boolean(cleanEnglishText || rawTranscriptText || transcriptText);
  const symptomsPayload = currentSymptoms?.meetingId === meetingId
    ? currentSymptoms?.symptoms
    : currentTranscript?.symptomsData;

  const stats = {
    lines: speakerTurns.length,
    words: (cleanEnglishText || rawTranscriptText || transcriptText)
      ? (cleanEnglishText || rawTranscriptText || transcriptText).trim().split(/\s+/).length
      : 0,
    highlights: speakerTurns.filter((turn) => hasKeyword(turn.text)).length,
  };

  const matchCount = search.trim() ? filteredTurns.length : null;

  const handleCopy = async () => {
    try {
      const textToCopy = filteredTurns.length
        ? filteredTurns
            .map(
              (turn) => `${turn.speaker} : ${turn.startTime} - ${turn.endTime}\n${turn.text}`,
            )
            .join('\n\n')
        : (cleanEnglishText || rawTranscriptText || transcriptText || '');

      await navigator.clipboard.writeText(textToCopy);
      setCopied(true);
      toast.success('Transcript copied');
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      toast.error('Unable to copy transcript');
    }
  };

  const handleExport = async (format) => {
    try {
      setExporting(format);
      const response = await fetch(`${API_BASE}/meetings/${meetingId}/transcript.${format}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      });

      if (!response.ok) {
        throw new Error(`Export failed with status ${response.status}`);
      }

      const blob = await response.blob();
      const blobUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = blobUrl;
      link.download = `${meetingId}.${format}`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(blobUrl);
      toast.success(`Exported ${format.toUpperCase()}`);
    } catch (exportError) {
      toast.error(String(exportError?.message || exportError || 'Export failed'));
    } finally {
      setExporting('');
    }
  };

  const handleSummary = async () => {
    if (!hasTranscriptContent) return;

    try {
      toast.info('Generating summary…');
      await dispatch(generateTranscriptSummary({ meetingId, force: false })).unwrap();
      toast.success('Summary ready');
      navigate(`/transcripts/${meetingId}/summary`);
    } catch (summaryError) {
      toast.error(String(summaryError || 'Failed to generate summary'));
    }
  };

  const handleSymptoms = async (force = false) => {
    if (!hasTranscriptContent) return;

    try {
      setSymptomsOpen(true);
      if (!force && symptomsPayload?.success) {
        return;
      }
      toast.info(force ? 'Regenerating symptoms analysis…' : 'Generating symptoms analysis…');
      await dispatch(generateTranscriptSymptoms({ meetingId, force })).unwrap();
      toast.success('Symptoms analysis ready');
    } catch (symptomsRequestError) {
      toast.error(String(symptomsRequestError || 'Failed to generate symptoms analysis'));
    }
  };

  return (
    <AppShell>
      <div className="space-y-6">
        <section className="glass-panel overflow-hidden p-6 sm:p-8">
          <div className="flex flex-col gap-6 xl:flex-row xl:items-end xl:justify-between">
            <div>
              <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-primary-500/20 bg-primary-500/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.24em] text-primary-200">
                <Sparkles className="h-3.5 w-3.5" />
                Transcript intelligence
              </div>
              <h1 className="section-title text-3xl">Professional transcript viewer</h1>
              <p className="section-subtitle max-w-3xl">
                Review speaker turns, compare clean and raw transcript text, and jump into a structured meeting summary.
              </p>
            </div>

            <div className="flex flex-wrap gap-3">
              <div className="inline-flex rounded-2xl border border-white/10 bg-white/5 p-1">
                {[
                  ['segments', 'Speaker view'],
                  ['clean', 'Clean'],
                  ['raw', 'Raw'],
                ].map(([mode, label]) => (
                  <button
                    key={mode}
                    onClick={() => setViewMode(mode)}
                    className={`rounded-xl px-3 py-2 text-xs font-semibold transition ${
                      viewMode === mode
                        ? 'bg-primary-500 text-white'
                        : 'text-slate-300 hover:bg-white/10 hover:text-white'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>

              <button onClick={handleCopy} className="btn-secondary">
                {copied ? <CheckCircle2 className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                {copied ? 'Copied' : 'Copy transcript'}
              </button>

              <button
                onClick={() => handleExport('txt')}
                disabled={!!exporting || !hasTranscriptContent}
                className="btn-secondary"
              >
                <Download className="h-4 w-4" />
                {exporting === 'txt' ? 'Exporting...' : 'Export TXT'}
              </button>

              <button
                onClick={() => handleExport('pdf')}
                disabled={!!exporting || !hasTranscriptContent}
                className="btn-secondary"
              >
                <FileText className="h-4 w-4" />
                {exporting === 'pdf' ? 'Opening...' : 'Export PDF'}
              </button>

              <button
                onClick={handleSummary}
                disabled={summaryLoading || !hasTranscriptContent}
                className="btn-primary"
              >
                <ListChecks className="h-4 w-4" />
                {summaryLoading ? 'Generating...' : 'Summary'}
              </button>

              <button
                onClick={() => handleSymptoms(false)}
                disabled={symptomsLoading || !hasTranscriptContent}
                className="btn-secondary"
              >
                <Activity className="h-4 w-4" />
                {symptomsLoading ? 'Analyzing...' : 'Symptoms'}
              </button>

              <button onClick={() => navigate(`/qa/${meetingId}`)} className="btn-secondary">
                <MessageSquare className="h-4 w-4" />
                Ask Q&amp;A
              </button>
            </div>
          </div>
        </section>

        {/* ── Needs-review warning banner ──────────────────────────────── */}
        {currentTranscript?.needs_review && (
          <div className="flex items-start gap-3 rounded-2xl border border-amber-500/30 bg-amber-500/8 px-5 py-4">
            <AlertTriangle className="mt-0.5 h-5 w-5 flex-shrink-0 text-amber-400" />
            <div>
              <p className="text-sm font-semibold text-amber-200">Low confidence transcript — review recommended</p>
              <p className="mt-1 text-xs leading-5 text-amber-300/70">
                This transcript was flagged as needing review. The ASR model reported low confidence on one or more segments.
                Diarization may be unavailable, and some words may be inaccurate.
                {currentTranscript?.language && ` Detected language: ${String(currentTranscript.language).toUpperCase()}.`}
              </p>
            </div>
          </div>
        )}

        <section className="grid grid-cols-1 gap-4 md:grid-cols-3 xl:grid-cols-5">
          <div className="kpi-card">
            <div className="text-xs uppercase tracking-[0.24em] text-slate-500">Processing</div>
            <div className="mt-3 text-2xl font-bold capitalize text-white">
              {currentTranscript?.processingStatus || 'pending'}
            </div>
          </div>
          <div className="kpi-card">
            <div className="text-xs uppercase tracking-[0.24em] text-slate-500">Detected language</div>
            <div className="mt-3 text-2xl font-bold uppercase text-white">
              {currentTranscript?.language || currentTranscript?.languageDetected || '—'}
            </div>
          </div>
          <div className="kpi-card">
            <div className="text-xs uppercase tracking-[0.24em] text-slate-500">Speaker turns</div>
            <div className="mt-3 text-2xl font-bold text-white">{stats.lines}</div>
          </div>
          <div className="kpi-card">
            <div className="text-xs uppercase tracking-[0.24em] text-slate-500">Words</div>
            <div className="mt-3 text-2xl font-bold text-white">{stats.words}</div>
          </div>
          <div className="kpi-card">
            <div className="text-xs uppercase tracking-[0.24em] text-slate-500">Confidence</div>
            <div className={`mt-3 text-2xl font-bold capitalize ${
              currentTranscript?.needs_review ? 'text-amber-400' : 'text-emerald-400'
            }`}>
              {currentTranscript?.needs_review ? 'low' : 'ok'}
            </div>
          </div>
        </section>

        

        {symptomsOpen && (
          <SymptomsPanel
            symptoms={symptomsPayload}
            loading={symptomsLoading}
            error={symptomsError}
            onRefresh={() => handleSymptoms(true)}
            title={currentTranscript?.title || `Meeting ${meetingId}`}
          />
        )}

        <section className="grid gap-6 xl:grid-cols-[340px,1fr]">
          <aside className="space-y-6">
            <div className="glass-panel p-5">
              <div className="flex items-center gap-2 text-sm font-semibold text-white">
                <Search className="h-4 w-4" /> Search transcript
              </div>

              <div className="relative mt-4">
                <input
                  type="text"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search text or speaker"
                  className="w-full rounded-2xl border border-white/10 bg-slate-950/70 px-4 py-3 pr-10 text-sm text-white outline-none ring-0 placeholder:text-slate-500"
                />
                {search && (
                  <button
                    onClick={() => setSearch('')}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 transition hover:text-white"
                    aria-label="Clear search"
                  >
                    <X className="h-4 w-4" />
                  </button>
                )}
              </div>

              <select
                value={speakerFilter}
                onChange={(event) => setSpeakerFilter(event.target.value)}
                className="mt-3 w-full rounded-2xl border border-white/10 bg-slate-950/70 px-4 py-3 text-sm text-white outline-none"
              >
                {speakerOptions.map((speaker) => (
                  <option key={speaker} value={speaker}>
                    {speaker === 'all' ? 'All speakers' : speaker}
                  </option>
                ))}
              </select>

              {search.trim() && (
                <div className="mt-3 flex items-center gap-2 text-xs">
                  {matchCount > 0 ? (
                    <span className="rounded-full border border-primary-500/30 bg-primary-500/15 px-2.5 py-1 font-semibold text-primary-200">
                      {matchCount} match{matchCount !== 1 ? 'es' : ''} for &ldquo;{search}&rdquo;
                    </span>
                  ) : (
                    <span className="rounded-full border border-red-500/20 bg-red-500/10 px-2.5 py-1 font-semibold text-red-300">
                      No matches for &ldquo;{search}&rdquo;
                    </span>
                  )}
                </div>
              )}
            </div>

            <div className="glass-panel p-5">
              <div className="flex items-center gap-2 text-sm font-semibold text-white">
                <AlertTriangle className="h-4 w-4" /> Confidence notes
              </div>
              <p className="mt-4 text-sm text-slate-400">
                {confidenceNotes || 'No confidence warnings were reported for this transcript.'}
              </p>
              {!!uncertainTerms.length && (
                <div className="mt-4 flex flex-wrap gap-2">
                  {uncertainTerms.map((term) => (
                    <span
                      key={term}
                      className="rounded-full border border-amber-500/30 bg-amber-500/10 px-3 py-1 text-xs font-medium text-amber-200"
                    >
                      {term}
                    </span>
                  ))}
                </div>
              )}
            </div>

            {/* Script drift warning — shown when Gujarati speech was written in Hindi script */}
            {scriptDriftDetected && (
              <div className="glass-panel border border-orange-500/30 bg-orange-500/5 p-5">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-orange-300" />
                  <div>
                    <div className="text-sm font-semibold text-orange-200">Gujarati script drift</div>
                    <p className="mt-2 text-xs leading-5 text-orange-300/80">
                      {scriptDriftSegments} segment{scriptDriftSegments !== 1 ? 's were' : ' was'} transcribed
                      in Hindi Devanagari script instead of Gujarati script. The spoken content is phonetically
                      preserved but uses the wrong Unicode block (Hindi ऀ–ॿ instead of Gujarati ઀–૿).
                    </p>
                    <p className="mt-2 text-xs text-orange-400/60">
                      This is a known limitation of Whisper large-v3 for Gujarati. A Gujarati fine-tuned
                      model will produce correct Gujarati script output.
                    </p>
                  </div>
                </div>
              </div>
            )}

            {/* Pipeline warnings (hallucination flags, translation issues) */}
            {pipelineWarnings.length > 0 && (
              <div className="glass-panel p-5">
                <div className="flex items-center gap-2 text-sm font-semibold text-white">
                  <AlertTriangle className="h-4 w-4 text-amber-300" /> Pipeline warnings
                </div>
                <div className="mt-3 space-y-2">
                  {pipelineWarnings.map((warning, i) => (
                    <p key={i} className="text-xs leading-5 text-amber-200/70">{warning}</p>
                  ))}
                </div>
              </div>
            )}

            <button onClick={() => navigate('/transcripts')} className="btn-secondary w-full justify-center">
              <ArrowLeft className="h-4 w-4" />
              Back to all transcripts
            </button>
          </aside>

          <div className="space-y-6">
            {(loading && !currentTranscript) ? (
              <div className="glass-panel p-8 text-center text-slate-400">Loading transcript…</div>
            ) : error ? (
              <div className="glass-panel p-8 text-center">
                <AlertTriangle className="mx-auto h-10 w-10 text-amber-300" />
                <h2 className="mt-4 text-xl font-semibold text-white">Unable to load transcript</h2>
                <p className="mt-2 text-sm text-slate-400">{error}</p>
              </div>
            ) : viewMode === 'segments' ? (
              <div className="glass-panel overflow-hidden p-0">
                <div className="border-b border-white/10 px-5 py-5 sm:px-6">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                      <h2 className="text-3xl font-semibold text-white">Grouped speaker turns</h2>
                      <p className="mt-2 max-w-2xl text-sm leading-8 text-slate-400">
                        Same-speaker consecutive fragments are grouped into a single speaker turn with start and end timestamps.
                      </p>
                    </div>

                    <div className="hidden items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-slate-300 sm:inline-flex">
                      <Clock3 className="h-3.5 w-3.5" />
                      Timeline view
                    </div>
                  </div>
                </div>

                <div className="p-5 sm:p-6">
                  {filteredTurns.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-16 text-center">
                      <MessageSquareText className="mb-3 h-10 w-10 text-slate-400 opacity-20" />
                      <p className="mb-3 text-sm text-slate-400">
                        No transcript turns matched your filters.
                      </p>
                      {search && (
                        <button
                          onClick={() => setSearch('')}
                          className="btn-secondary mt-2 px-3 py-1.5 text-xs"
                        >
                          Clear search
                        </button>
                      )}
                    </div>
                  ) : (
                    <div className="space-y-4">
                      {filteredTurns.map((turn) => (
                        <article
                          key={turn.id}
                          className="rounded-[28px] border border-white/10 bg-slate-950/60 p-5 shadow-soft"
                        >
                          <div className="flex flex-wrap items-center gap-3">
                            <span
                              className={`rounded-full border px-4 py-2 text-xs font-semibold uppercase tracking-[0.22em] ${turn.className}`}
                            >
                              {turn.speaker}
                            </span>

                            <span className="rounded-full border border-white/10 bg-slate-950 px-4 py-2 font-mono text-xs text-slate-200">
                              {turn.startTime} - {turn.endTime}
                            </span>

                            <span className="rounded-full border border-teal-500/25 bg-teal-500/10 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-teal-200">
                              {turn.confidenceLabel}
                            </span>

                            <span className="text-sm text-slate-500">
                              {turn.segmentCount} merged segment{turn.segmentCount > 1 ? 's' : ''}
                            </span>
                          </div>

                          <div
                            className="mt-5 whitespace-pre-wrap text-[18px] leading-[2.3] text-slate-100"
                            lang={turn.language || undefined}
                          >
                            {renderHighlightedText(turn.text)}
                          </div>
                        </article>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className="glass-panel p-5 sm:p-6">
                <div className="flex items-center justify-between gap-3 border-b border-white/10 pb-4">
                  <div>
                    <h2 className="text-xl font-semibold text-white">
                      {viewMode === 'raw' ? 'Raw transcript' : 'Clean transcript'}
                    </h2>
                    <p className="mt-1 text-sm text-slate-400">
                      Use clean mode for polished reading and raw mode for direct transcription output.
                    </p>
                  </div>
                </div>
                <div
                  className="prose prose-invert mt-5 max-w-none whitespace-pre-wrap break-words rounded-3xl border border-white/10 bg-slate-950/60 p-5 text-sm leading-7 text-slate-200"
                  dangerouslySetInnerHTML={{ __html: highlightedTranscript || 'No transcript text available.' }}
                />
              </div>
            )}
          </div>
        </section>
      </div>
    </AppShell>
  );
};

export default TranscriptViewer;