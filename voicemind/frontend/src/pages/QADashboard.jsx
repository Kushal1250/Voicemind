import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { Bot, MessageSquare, Search, Send, Sparkles, Download, Zap } from 'lucide-react';
import { toast } from 'react-toastify';
import AppShell from '../components/AppShell';
import QAAnswerCard from '../components/QAAnswerCard';
import { askQuestion, fetchGlobalQA, setGlobalMode } from '../store/slices/qaSlice';

// ---------------------------------------------------------------------------
// Quick questions — multilingual
// ---------------------------------------------------------------------------
const QUICK_QUESTIONS = [
  'What are the latest key decisions across meetings?',
  'What action items are pending?',
  'What blockers were discussed recently?',
  'Give me a short summary of recent meetings.',
  // Gujarati
  'તાજેતરની મીટિંગ શું વિશે હતી?',
  // Hindi
  'हाल की मीटिंग में क्या तय हुआ?',
];

// ---------------------------------------------------------------------------
// Gemini status pill
// ---------------------------------------------------------------------------
const GeminiStatus = () => (
  <div className="inline-flex items-center gap-1.5 rounded-full border border-violet-500/30 bg-violet-500/10 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.22em] text-violet-200">
    <Zap className="h-3 w-3" />
    Gemini AI
  </div>
);

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
const QADashboard = () => {
  const dispatch = useDispatch();
  const { interactions, loading, error } = useSelector((state) => state.qa);
  const [question, setQuestion] = useState('');
  const bottomRef = useRef(null);

  const safeInteractions = useMemo(
    () => (Array.isArray(interactions) ? interactions : []),
    [interactions]
  );

  useEffect(() => {
    dispatch(setGlobalMode(true));
    dispatch(fetchGlobalQA());
  }, [dispatch]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [safeInteractions.length, loading]);

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (!question.trim() || loading) return;

    dispatch(setGlobalMode(true));
    try {
      await dispatch(askQuestion({ question })).unwrap();
      setQuestion('');
    } catch (submissionError) {
      toast.error(submissionError || 'Failed to get answer');
    }
  };

  const handleExportPDF = () => {
    if (!safeInteractions.length) return;
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
<title>Global Q&A Export</title>
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;background:#fff;color:#111;padding:40px 48px;font-size:13px;line-height:1.7;}
  h1{font-size:20px;font-weight:800;margin-bottom:6px;}
  .subtitle{color:#6B7280;font-size:12px;margin-bottom:28px;}
  .brand{font-size:10px;font-weight:700;letter-spacing:.18em;text-transform:uppercase;color:#6B7280;margin-bottom:8px;}
  .gemini-badge{display:inline-block;background:#7C3AED;color:#fff;font-size:10px;font-weight:700;padding:2px 10px;border-radius:999px;margin-bottom:8px;}
  .qa-item{margin-bottom:24px;page-break-inside:avoid;border:1px solid #E5E7EB;border-radius:8px;overflow:hidden;}
  .question{background:#EFF6FF;padding:14px 16px;font-weight:600;color:#1E40AF;}
  .q-label{display:inline-block;background:#2563EB;color:#fff;font-size:10px;font-weight:700;padding:2px 8px;border-radius:999px;margin-right:10px;}
  .answer{padding:14px 16px;background:#fff;}
  .a-label{display:inline-block;background:#7C3AED;color:#fff;font-size:10px;font-weight:700;padding:2px 8px;border-radius:999px;margin-right:10px;margin-bottom:8px;}
  .answer-text{color:#1F2937;margin-bottom:8px;}
  .badge{display:inline-block;border:1px solid #D1D5DB;border-radius:999px;padding:2px 10px;font-size:10px;color:#6B7280;}
  .footer{margin-top:36px;padding-top:14px;border-top:1px solid #E5E7EB;font-size:11px;color:#9CA3AF;text-align:center;}
</style></head><body>
  <div class="brand">VoiceMind Q&A Export</div>
  <div class="gemini-badge">⚡ Powered by Gemini AI</div>
  <h1>Workspace Q&A — All Sessions</h1>
  <div class="subtitle">Exported ${new Date().toLocaleString()} &bull; ${safeInteractions.length} interactions</div>
  ${rows}
  <div class="footer">Generated by VoiceMind · Gemini transcript intelligence</div>
</body></html>`;
    const blob = new Blob([html], { type: 'text/html' });
    const url  = URL.createObjectURL(blob);
    const win  = window.open(url, '_blank');
    if (win) win.onload = () => setTimeout(() => { win.print(); }, 400);
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  };

  return (
    <AppShell>
      <div className="mx-auto max-w-6xl space-y-6">
        {/* ── Page header ── */}
        <section className="glass-panel overflow-hidden p-6 sm:p-8">
          <div className="flex flex-col gap-5 xl:flex-row xl:items-end xl:justify-between">
            <div>
              <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-primary-500/20 bg-primary-500/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.24em] text-primary-200">
                <Sparkles className="h-3.5 w-3.5" />
                Workspace Q&A
              </div>
              <h1 className="section-title text-3xl">Fast answers across recent meetings</h1>
              <p className="section-subtitle max-w-3xl">
                Ask across your recent transcripts. Gemini answers only from transcript evidence
                and replies in your language — English, Gujarati, or Hindi.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              {/* Gemini status */}
              <GeminiStatus />

              <div className="rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-slate-300">
                {safeInteractions.length} saved {safeInteractions.length === 1 ? 'answer' : 'answers'}
              </div>
              <button
                onClick={handleExportPDF}
                disabled={safeInteractions.length === 0}
                className="btn-secondary"
                title="Export Q&A as PDF"
              >
                <Download className="h-4 w-4" />
                Export Q&amp;A PDF
              </button>
            </div>
          </div>
        </section>

        {/* Quick-question chips */}
        <div className="flex flex-wrap gap-2">
          {QUICK_QUESTIONS.map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => setQuestion(item)}
              className="rounded-full border border-white/10 bg-white/5 px-3 py-2 text-sm text-slate-300 transition hover:border-primary-500/30 hover:bg-primary-500/10 hover:text-white"
            >
              {item}
            </button>
          ))}
        </div>

        {/* ── Main grid ── */}
        <section className="grid grid-cols-1 gap-6 xl:grid-cols-[1.35fr_0.65fr]">
          {/* Chat panel */}
          <div className="surface-card flex min-h-[760px] min-w-0 flex-col overflow-hidden">
            <div className="border-b border-white/10 p-5">
              <div className="rounded-2xl border border-violet-500/15 bg-violet-500/10 px-4 py-3 text-sm text-violet-50">
                <div className="mb-1 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-violet-300">
                  <Zap className="h-3 w-3" />
                  Gemini transcript intelligence
                </div>
                Recent transcripts are used as the source of truth. Gemini answers only from
                what was spoken — never from outside knowledge. Answers appear in your language.
              </div>
            </div>

            {/* Messages */}
            <div className="flex-1 overflow-auto px-4 py-5 sm:px-5 scrollbar-thin">
              {safeInteractions.length === 0 ? (
                <div className="flex h-full min-h-[420px] flex-col items-center justify-center text-center text-slate-500">
                  <MessageSquare className="mb-4 h-12 w-12 opacity-30" />
                  <p className="max-w-md text-sm leading-7">
                    Ask a question about your recent meetings. Gemini will retrieve the most
                    relevant transcript lines and answer from that evidence only.
                  </p>
                </div>
              ) : (
                <div className="space-y-6">
                  {safeInteractions.map((interaction, idx) => (
                    <div key={interaction._id || idx} className="space-y-3">
                      {/* User bubble */}
                      <div className="flex justify-end">
                        <div className="max-w-[92%] rounded-[24px] rounded-br-md bg-gradient-to-r from-primary-600 to-indigo-500 px-4 py-3 text-sm text-white shadow-lg shadow-primary-900/30 sm:max-w-[85%]">
                          <div className="mb-1 text-[11px] font-semibold uppercase tracking-[0.22em] text-primary-100">
                            You
                          </div>
                          <div className="whitespace-pre-wrap leading-7">{interaction.question}</div>
                        </div>
                      </div>

                      {/* Gemini answer */}
                      <div className="flex justify-start">
                        <div className="max-w-[96%] sm:max-w-[92%]">
                          <QAAnswerCard interaction={interaction} />
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Thinking indicator */}
              {loading && (
                <div className="mt-6 flex justify-start">
                  <div className="max-w-[96%] rounded-[24px] rounded-bl-md border border-violet-500/20 bg-violet-500/10 px-4 py-4 text-sm text-violet-50 shadow-lg shadow-violet-900/10 sm:max-w-[92%]">
                    <div className="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.22em] text-violet-200">
                      <Zap className="h-3.5 w-3.5" />
                      Gemini AI
                    </div>
                    <div className="leading-7">
                      Searching recent transcript context and generating a grounded answer...
                    </div>
                  </div>
                </div>
              )}
              <div ref={bottomRef} />
            </div>

            {/* Input */}
            <form onSubmit={handleSubmit} className="border-t border-white/10 p-4 sm:p-5">
              <div className="flex flex-col gap-3 rounded-3xl border border-white/10 bg-white/5 p-3 md:flex-row md:items-center">
                <div className="relative min-w-0 flex-1">
                  <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
                  <input
                    type="text"
                    value={question}
                    onChange={(event) => setQuestion(event.target.value)}
                    placeholder="Ask in English, Gujarati, or Hindi..."
                    className="input-field w-full pl-11 pr-4"
                  />
                </div>
                <button
                  type="submit"
                  disabled={loading || !question.trim()}
                  className="btn-primary w-full justify-center md:w-auto md:min-w-[128px]"
                >
                  {loading ? 'Thinking...' : <><Zap className="h-4 w-4" /> Ask Gemini</>}
                </button>
              </div>
              {error && <div className="mt-3 text-sm text-red-300">{error}</div>}
            </form>
          </div>

          {/* Sidebar */}
          <aside className="space-y-6">
            <div className="surface-card p-5">
              <div className="mb-4 text-base font-semibold text-white">How Gemini answers</div>
              <div className="space-y-3 text-sm leading-6 text-slate-400">
                <p>Answers are grounded only in your meeting transcripts.</p>
                <p>Gemini never invents facts beyond what was spoken.</p>
                <p>Limited transcript warnings appear automatically.</p>
                <p>Transcript evidence snippets are shown with timestamps.</p>
                <p>Replies in your question language: English, Gujarati, or Hindi.</p>
              </div>
            </div>

            <div className="surface-card p-5">
              <div className="mb-4 text-base font-semibold text-white">Best questions to ask</div>
              <div className="space-y-2">
                {[
                  'What changed?',
                  'What decisions were made?',
                  'What should happen next?',
                  'List all action items.',
                  'Who spoke about the project?',
                  'Summarize Speaker 1.',
                ].map((item) => (
                  <button
                    key={item}
                    type="button"
                    onClick={() => setQuestion(item)}
                    className="block w-full rounded-2xl border border-white/10 bg-white/5 px-3 py-3 text-left text-sm text-slate-300 transition hover:bg-white/10"
                  >
                    {item}
                  </button>
                ))}
              </div>
            </div>
          </aside>
        </section>
      </div>
    </AppShell>
  );
};

export default QADashboard;
