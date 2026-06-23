/**
 * QAMeeting.jsx — v8.0
 * =====================
 * Changes from v7:
 *  - Loading indicator now says "Semantic search + Gemini AI"
 *  - Quick-question chips include Symptoms and Meeting Intel categories
 *  - Sidebar shows embedding model status from /health endpoint
 *  - QuickQuestion chips now auto-submit (not just fill the box)
 *  - Added Gujarati/Hindi multilingual example sections
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useDispatch, useSelector } from 'react-redux';
import {
  Bot,
  CalendarDays,
  FileText,
  MessageSquare,
  Search,
  Send,
  Sparkles,
  Download,
  Zap,
  Users,
  Tag,
  Globe,
  Clock3,
  Activity,
  Layers,
} from 'lucide-react';
import { toast } from 'react-toastify';
import AppShell from '../components/AppShell';
import QAAnswerCard from '../components/QAAnswerCard';
import { askQuestion, fetchQAHistory } from '../store/slices/qaSlice';
import { fetchTranscriptByMeetingId } from '../store/slices/transcriptsSlice';
import {
  formatTranscriptStatus,
  isLimitedContext,
  formatChatDay,
  formatChatTime,
  isSameChatDay,
} from '../utils/qa';

// ─── Quick-question chips ─────────────────────────────────────────────────────
const QUICK_QUESTIONS = [
  // Speaker identity
  "What is Speaker 2's name?",
  'Introduce Speaker 2',
  "What university is mentioned?",
  "Which company is Speaker 2 with?",
  // Meeting intelligence
  'What are the action items?',
  'What decisions were made?',
  'What are the risks or blockers?',
  'Summarize this meeting',
  // Symptoms
  'Extract all health information',
  // Entity / fact
  'What entities are mentioned?',
  'What topics were discussed?',
  'Produce JSON summary',
  // Gujarati
  'સ્પીકર 2 નું નામ શું છે?',
  'કઇ યુનિવર્સિટી નો ઉલ્લેખ છે?',
  // Hindi
  'स्पीकर 2 किस कंपनी में काम करता है?',
  'मुख्य विषय क्या था?',
];

// ─── Gemini + Semantic status pill ───────────────────────────────────────────
const SemanticStatus = ({ semanticEnabled }) => (
  <div className="inline-flex items-center gap-1.5 rounded-full border border-violet-500/30 bg-violet-500/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.22em] text-violet-200">
    <Zap className="h-3 w-3" />
    {semanticEnabled ? 'Semantic + Gemini AI' : 'Powered by Gemini AI'}
  </div>
);

// ─── Component ────────────────────────────────────────────────────────────────
const QAMeeting = () => {
  const { meetingId } = useParams();
  const dispatch = useDispatch();
  const { interactions, loading, error } = useSelector((state) => state.qa);
  const { currentTranscript } = useSelector((state) => state.transcripts);

  const [question, setQuestion]           = useState('');
  const [semanticEnabled, setSemanticEnabled] = useState(false);
  const bottomRef = useRef(null);

  // ── Derived transcript data ──────────────────────────────────────────────
  const safeInteractions = useMemo(() => {
    return Array.isArray(interactions)
      ? [...interactions].sort((a, b) => new Date(a?.createdAt || 0) - new Date(b?.createdAt || 0))
      : [];
  }, [interactions]);

  const transcriptText = useMemo(
    () => String(currentTranscript?.fullText || '').trim(),
    [currentTranscript?.fullText],
  );

  const transcriptWordCount = useMemo(
    () => (transcriptText ? transcriptText.split(/\s+/).filter(Boolean).length : 0),
    [transcriptText],
  );

  const transcriptSegments = useMemo(
    () => (Array.isArray(currentTranscript?.segments) ? currentTranscript.segments : []),
    [currentTranscript?.segments],
  );

  const limitedTranscript = useMemo(
    () => isLimitedContext(transcriptText, transcriptSegments.length, transcriptWordCount),
    [transcriptSegments.length, transcriptText, transcriptWordCount],
  );

  const speakerLabels = useMemo(() => {
    const labels = new Set(
      transcriptSegments.map((s) => String(s?.speaker || '').trim()).filter(Boolean),
    );
    return [...labels].sort();
  }, [transcriptSegments]);

  // ── Fetch health to check if semantic model is loaded ────────────────────
  useEffect(() => {
    fetch(`${process.env.REACT_APP_QA_SERVICE_URL || 'http://localhost:8002'}/health`)
      .then((r) => r.json())
      .then((d) => setSemanticEnabled(Boolean(d?.semantic_retrieval)))
      .catch(() => {});
  }, []);

  // ── Data fetch ──────────────────────────────────────────────────────────
  useEffect(() => {
    dispatch(fetchQAHistory(meetingId));
    dispatch(fetchTranscriptByMeetingId(meetingId));
  }, [meetingId, dispatch]);

  // ── Auto-scroll ──────────────────────────────────────────────────────────
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [safeInteractions.length, loading]);

  // ── Submit ───────────────────────────────────────────────────────────────
  const handleSubmit = async (event) => {
    event?.preventDefault();
    if (!question.trim() || loading) return;
    try {
      await dispatch(askQuestion({ meetingId, question })).unwrap();
      setQuestion('');
    } catch (submissionError) {
      toast.error(submissionError || 'Failed to get answer');
    }
  };

  // Auto-submit quick questions
  const handleQuickQuestion = async (q) => {
    if (loading) return;
    setQuestion(q);
    try {
      await dispatch(askQuestion({ meetingId, question: q })).unwrap();
      setQuestion('');
    } catch (err) {
      toast.error(err || 'Failed to get answer');
    }
  };

  // ── Transcript status prose ──────────────────────────────────────────────
  const transcriptStatusMessage = useMemo(() => {
    if (!transcriptText) {
      return currentTranscript?.processingStatus === 'processing'
        ? 'Transcript still streaming — answers improve as more speech is captured.'
        : 'No transcript available yet for this meeting.';
    }
    if (limitedTranscript) return 'Limited transcript available. Answers are based only on the current text.';
    if (currentTranscript?.processingStatus === 'processing') return 'Transcript still streaming — new questions use the newest captured text.';
    return `Transcript ready (${transcriptSegments.length} segments). ${semanticEnabled ? 'Semantic retrieval enabled — Gujarati/Hindi/English all supported.' : 'Gemini will answer only from this evidence.'}`;
  }, [currentTranscript?.processingStatus, limitedTranscript, transcriptText, semanticEnabled, transcriptSegments.length]);

  // ── PDF export ───────────────────────────────────────────────────────────
  const handleExportPDF = () => {
    if (!safeInteractions.length) return;
    const meetingTitle = meetingId || 'Meeting';
    const safeHtml = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const rows = safeInteractions.map((ia, i) => `
      <div class="qa-item">
        <div class="question"><span class="q-label">Q${i + 1}</span>${safeHtml(ia.question)}</div>
        <div class="answer">
          <span class="a-label">${safeHtml(ia.mode === 'gemini' ? '⚡ Gemini' : 'Answer')}</span>
          <div class="answer-text">${safeHtml(ia.answer)}</div>
          ${ia.confidence ? `<span class="badge">${safeHtml(ia.confidence)} confidence</span>` : ''}
        </div>
      </div>`).join('');

    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"/>
<title>Q&amp;A Export — ${safeHtml(meetingTitle)}</title>
<style>
  body{font-family:-apple-system,sans-serif;background:#fff;color:#111;padding:40px 48px;font-size:13px;line-height:1.7}
  h1{font-size:20px;font-weight:800;margin-bottom:6px}
  .subtitle{color:#6B7280;font-size:12px;margin-bottom:28px}
  .brand{font-size:10px;font-weight:700;letter-spacing:.18em;text-transform:uppercase;color:#6B7280;margin-bottom:8px}
  .gemini-badge{display:inline-block;background:#7C3AED;color:#fff;font-size:10px;font-weight:700;padding:2px 10px;border-radius:999px;margin-bottom:8px}
  .qa-item{margin-bottom:24px;page-break-inside:avoid;border:1px solid #E5E7EB;border-radius:8px;overflow:hidden}
  .question{background:#EFF6FF;padding:14px 16px;font-weight:600;color:#1E40AF}
  .q-label{display:inline-block;background:#2563EB;color:#fff;font-size:10px;font-weight:700;padding:2px 8px;border-radius:999px;margin-right:10px}
  .answer{padding:14px 16px;background:#fff}
  .a-label{display:inline-block;background:#7C3AED;color:#fff;font-size:10px;font-weight:700;padding:2px 8px;border-radius:999px;margin-right:10px;margin-bottom:8px}
  .answer-text{color:#1F2937;margin-bottom:8px;white-space:pre-wrap}
  .badge{display:inline-block;border:1px solid #D1D5DB;border-radius:999px;padding:2px 10px;font-size:10px;color:#6B7280}
  .footer{margin-top:36px;padding-top:14px;border-top:1px solid #E5E7EB;font-size:11px;color:#9CA3AF;text-align:center}
</style></head><body>
  <div class="brand">VoiceMind Q&amp;A Export</div>
  <div class="gemini-badge">⚡ Semantic + Gemini AI</div>
  <h1>Q&amp;A Session — ${safeHtml(meetingTitle)}</h1>
  <div class="subtitle">Exported ${new Date().toLocaleString()} &bull; ${safeInteractions.length} interactions</div>
  ${rows}
  <div class="footer">Generated by VoiceMind · Semantic Retrieval + Gemini</div>
</body></html>`;

    const blob = new Blob([html], { type: 'text/html' });
    const url  = URL.createObjectURL(blob);
    const win  = window.open(url, '_blank');
    if (win) win.onload = () => setTimeout(() => win.print(), 400);
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  };

  // ─── Render ───────────────────────────────────────────────────────────────
  return (
    <AppShell>
      <div className="space-y-6">
        {/* ── Page header ── */}
        <section className="glass-panel overflow-hidden p-6 sm:p-8">
          <div className="flex flex-col gap-6 xl:flex-row xl:items-end xl:justify-between">
            <div>
              <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-primary-500/20 bg-primary-500/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.24em] text-primary-200">
                <Sparkles className="h-3.5 w-3.5" />
                Meeting Q&amp;A
              </div>
              <h1 className="section-title text-3xl">Grounded transcript assistant</h1>
              <p className="section-subtitle max-w-3xl">
                Ask anything about this meeting. Semantic embedding retrieval finds answers
                in Gujarati (ગુજરાતી), Hindi (हिंदी), and English — even when the words
                don't match exactly. Gemini then answers in your language.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <SemanticStatus semanticEnabled={semanticEnabled} />
              <div className="rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-slate-300">
                {safeInteractions.length} conversation {safeInteractions.length === 1 ? 'turn' : 'turns'}
              </div>
              <button
                onClick={handleExportPDF}
                disabled={safeInteractions.length === 0}
                className="btn-secondary"
                title="Export Q&A as PDF"
              >
                <Download className="h-4 w-4" />
                Export PDF
              </button>
            </div>
          </div>
        </section>

        {/* ── Main grid ── */}
        <section className="grid grid-cols-1 gap-6 xl:grid-cols-[1.35fr_0.65fr]">
          {/* ── Chat panel ── */}
          <div className="surface-card flex min-h-[760px] min-w-0 flex-col overflow-hidden">
            {/* Top bar */}
            <div className="border-b border-white/10 p-5">
              <div className="flex flex-col gap-4">
                {/* Status row */}
                <div className="rounded-2xl border border-white/10 bg-white/5 px-4 py-4 text-sm text-slate-300">
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <span className="rounded-full border border-white/10 bg-slate-950/60 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.22em] text-white">
                      {formatTranscriptStatus(currentTranscript?.processingStatus)}
                    </span>
                    <span className="text-xs text-slate-400">
                      {transcriptWordCount} words · {transcriptSegments.length} blocks
                    </span>
                    {semanticEnabled && (
                      <span className="rounded-full border border-cyan-500/30 bg-cyan-500/10 px-2.5 py-1 text-[11px] font-semibold text-cyan-300">
                        <Layers className="mr-1 inline h-2.5 w-2.5" />
                        Semantic search active
                      </span>
                    )}
                  </div>
                  <div>{transcriptStatusMessage}</div>
                </div>

                {/* Quick-question chips */}
                <div className="flex flex-wrap gap-2">
                  {QUICK_QUESTIONS.map((item) => (
                    <button
                      key={item}
                      type="button"
                      onClick={() => handleQuickQuestion(item)}
                      disabled={loading}
                      className="rounded-full border border-white/10 bg-white/5 px-3 py-2 text-xs font-semibold text-slate-300 transition hover:border-primary-500/30 hover:bg-primary-500/10 hover:text-white disabled:opacity-50"
                    >
                      {item}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* Chat message list */}
            <div className="flex-1 overflow-auto px-4 py-5 sm:px-5 scrollbar-thin">
              {safeInteractions.length === 0 ? (
                <div className="flex h-full min-h-[420px] flex-col items-center justify-center text-center text-slate-500">
                  <MessageSquare className="mb-4 h-12 w-12 opacity-30" />
                  <p className="max-w-md text-sm leading-7">
                    Ask a question above — or tap one of the chips. Semantic retrieval finds
                    answers even in Gujarati and Hindi transcripts. Gemini answers in your language.
                  </p>
                </div>
              ) : (
                <div className="space-y-6">
                  {safeInteractions.map((interaction, idx) => {
                    const previous    = safeInteractions[idx - 1];
                    const showDivider = !previous || !isSameChatDay(previous?.createdAt, interaction?.createdAt);
                    return (
                      <React.Fragment key={interaction._id || idx}>
                        {showDivider && (
                          <div className="flex items-center gap-3 py-2">
                            <div className="h-px flex-1 bg-white/10" />
                            <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-300">
                              <CalendarDays className="h-3.5 w-3.5" />
                              {formatChatDay(interaction?.createdAt)}
                            </div>
                            <div className="h-px flex-1 bg-white/10" />
                          </div>
                        )}
                        <div className="space-y-3">
                          {/* User bubble */}
                          <div className="flex justify-end">
                            <div className="max-w-[92%] sm:max-w-[85%]">
                              <div className="rounded-[24px] rounded-br-md bg-gradient-to-r from-primary-600 to-indigo-500 px-4 py-3 text-sm text-white shadow-lg shadow-primary-900/30">
                                <div className="mb-1 text-[11px] font-semibold uppercase tracking-[0.22em] text-primary-100">You</div>
                                <div className="whitespace-pre-wrap leading-7">{interaction.question}</div>
                              </div>
                              <div className="mt-1 px-2 text-right text-[11px] text-slate-500">
                                {formatChatTime(interaction?.createdAt)}
                              </div>
                            </div>
                          </div>
                          {/* AI answer card */}
                          <div className="flex justify-start">
                            <div className="max-w-[96%] sm:max-w-[92%]">
                              <QAAnswerCard interaction={interaction} />
                            </div>
                          </div>
                        </div>
                      </React.Fragment>
                    );
                  })}
                </div>
              )}

              {/* Thinking indicator */}
              {loading && (
                <div className="mt-6 flex justify-start">
                  <div className="max-w-[96%] rounded-[24px] rounded-bl-md border border-violet-500/20 bg-violet-500/10 px-4 py-4 text-sm text-violet-50 shadow-lg shadow-violet-900/10 sm:max-w-[92%]">
                    <div className="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.22em] text-violet-200">
                      <Zap className="h-3.5 w-3.5 animate-pulse" />
                      {semanticEnabled ? 'Semantic search → Gemini AI…' : 'Gemini AI — searching transcript…'}
                    </div>
                    <div className="leading-7 text-violet-200">
                      {semanticEnabled
                        ? 'Embedding query · cosine similarity retrieval · building grounded answer…'
                        : 'Building speaker index · extracting entities · selecting evidence…'}
                    </div>
                  </div>
                </div>
              )}
              <div ref={bottomRef} />
            </div>

            {/* Input form */}
            <form onSubmit={handleSubmit} className="border-t border-white/10 p-4 sm:p-5">
              <div className="flex flex-col gap-3 rounded-3xl border border-white/10 bg-white/5 p-3 md:flex-row md:items-end">
                <div className="relative min-w-0 flex-1">
                  <Search className="pointer-events-none absolute left-4 top-4 h-4 w-4 text-slate-500" />
                  <textarea
                    value={question}
                    onChange={(e) => setQuestion(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSubmit(); }
                    }}
                    rows={3}
                    placeholder="Ask in English, Gujarati, or Hindi — e.g. 'What is Speaker 2's name?' or 'સ્પીકર 2 ક્યાં ભણે છે?'"
                    className="input-field min-h-[110px] w-full resize-none pl-11"
                  />
                </div>
                <button
                  type="submit"
                  disabled={loading || !question.trim()}
                  className="btn-primary w-full justify-center md:w-auto md:min-w-[130px]"
                >
                  {loading ? 'Thinking…' : <><Send className="h-4 w-4" />Ask Gemini</>}
                </button>
              </div>
              {error && (
                <div className="mt-3 rounded-2xl border border-red-500/20 bg-red-500/10 px-4 py-2 text-sm text-red-300">
                  {error}
                </div>
              )}
            </form>
          </div>

          {/* ── Sidebar ── */}
          <aside className="space-y-6">
            {/* Transcript stats */}
            <div className="surface-card p-5">
              <div className="mb-4 flex items-center gap-2 text-base font-semibold text-white">
                <FileText className="h-5 w-5 text-primary-300" />
                Transcript stats
              </div>
              <div className="space-y-2 text-sm text-slate-300">
                {[
                  ['Status',   formatTranscriptStatus(currentTranscript?.processingStatus)],
                  ['Words',    transcriptWordCount],
                  ['Blocks',   transcriptSegments.length],
                  ['Speakers', speakerLabels.length || '—'],
                  ['Retrieval', semanticEnabled ? 'Semantic (E5)' : 'Keyword'],
                ].map(([label, value]) => (
                  <div key={label} className="flex items-center justify-between rounded-2xl border border-white/10 bg-white/5 px-4 py-2.5">
                    <span className="text-slate-400">{label}</span>
                    <span className={`font-semibold ${label === 'Retrieval' && semanticEnabled ? 'text-cyan-300' : 'text-white'}`}>{value}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Detected speakers */}
            {speakerLabels.length > 0 && (
              <div className="surface-card p-5">
                <div className="mb-3 flex items-center gap-2 text-base font-semibold text-white">
                  <Users className="h-4 w-4 text-primary-300" />
                  Detected speakers
                </div>
                <div className="space-y-2">
                  {speakerLabels.map((spk) => (
                    <button
                      key={spk}
                      type="button"
                      onClick={() => handleQuickQuestion(`Introduce ${spk}`)}
                      disabled={loading}
                      title={`Ask: Introduce ${spk}`}
                      className="flex w-full items-center gap-2 rounded-2xl border border-white/10 bg-white/5 px-3 py-2.5 text-sm text-slate-300 transition hover:bg-white/10 disabled:opacity-50"
                    >
                      <Bot className="h-3.5 w-3.5 flex-shrink-0 text-primary-300" />
                      {spk}
                      <span className="ml-auto text-[10px] text-slate-500">Profile →</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Multilingual hints */}
            <div className="surface-card p-5">
              <div className="mb-3 flex items-center gap-2 text-base font-semibold text-white">
                <Globe className="h-4 w-4 text-emerald-300" />
                Multilingual questions
              </div>
              <div className="space-y-2 text-sm">
                {[
                  ['ગુ', 'સ્પીકર 2 નું નામ શું છે?'],
                  ['ગુ', 'કઇ યુનિવર્સિટી નો ઉલ્લેખ છે?'],
                  ['ગુ', 'આ મીટિંગ શું હતી?'],
                  ['हि', 'स्पीकर 2 किस कंपनी में काम करता है?'],
                  ['हि', 'मुख्य विषय क्या था?'],
                  ['हि', 'क्या कोई स्वास्थ्य जानकारी है?'],
                ].map(([lang, q]) => (
                  <button
                    key={q}
                    type="button"
                    onClick={() => handleQuickQuestion(q)}
                    disabled={loading}
                    className="flex w-full items-start gap-2 rounded-2xl border border-white/10 bg-white/5 px-3 py-2.5 text-left text-slate-300 transition hover:bg-white/10 disabled:opacity-50"
                  >
                    <span className="mt-0.5 flex-shrink-0 rounded bg-white/10 px-1.5 py-0.5 text-[10px] font-bold text-slate-400">{lang}</span>
                    <span className="leading-5">{q}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* Meeting intelligence chips */}
            <div className="surface-card p-5">
              <div className="mb-3 flex items-center gap-2 text-base font-semibold text-white">
                <Activity className="h-4 w-4 text-amber-300" />
                Meeting intelligence
              </div>
              <div className="space-y-1.5">
                {[
                  'What are the action items?',
                  'What decisions were made?',
                  'Who is responsible for what?',
                  'What are the risks or blockers?',
                  'What deadlines were mentioned?',
                  'Extract all health information',
                  'What are the key entities?',
                  'Produce JSON summary',
                ].map((item) => (
                  <button
                    key={item}
                    type="button"
                    onClick={() => handleQuickQuestion(item)}
                    disabled={loading}
                    className="block w-full rounded-2xl border border-white/10 bg-white/5 px-3 py-2.5 text-left text-sm text-slate-300 transition hover:bg-white/10 disabled:opacity-50"
                  >
                    {item}
                  </button>
                ))}
              </div>
            </div>

            {/* AI capabilities */}
            <div className="surface-card p-5">
              <div className="mb-3 flex items-center gap-2 text-base font-semibold text-white">
                <Zap className="h-4 w-4 text-violet-300" />
                AI capabilities (v8.0)
              </div>
              <div className="space-y-2 text-sm text-slate-400 leading-6">
                <p>• Semantic embedding retrieval (multilingual-e5)</p>
                <p>• Gujarati · Hindi · English — all supported</p>
                <p>• Speaker name / org / university / project</p>
                <p>• Symptom &amp; medical information extraction</p>
                <p>• Meeting intel: actions, decisions, owners, risks</p>
                <p>• Answer in same language as question</p>
                <p>• Zero hallucination — evidence-only answers</p>
              </div>
            </div>
          </aside>
        </section>
      </div>
    </AppShell>
  );
};

export default QAMeeting;
