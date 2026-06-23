/**
 * QAAnswerCard.jsx — v9.0
 * ========================
 * Changes from v8.0:
 *  - Evidence section collapsed by default (click to expand accordion)
 *  - Renamed "Supporting transcript evidence" → "Evidence"
 *  - Timestamps hidden by default; per-card "Show time" toggle reveals them
 *  - Proof-card style: speaker label + condensed snippet only (no raw transcript dump)
 *  - Card-level creation time reduced to a quiet tooltip on the time text
 *  - Provider / fallback details never surface in this component
 */

import React, { useState } from 'react';
import {
  AlertCircle,
  Bot,
  ChevronDown,
  ChevronRight,
  Clock3,
  Info,
  Sparkles,
  Zap,
  Cpu,
  Globe,
} from 'lucide-react';
import {
  buildAnswerState,
  formatMs,
  normalizeSources,
  formatChatTime,
  getModeLabel,
  isModeGemini,
  isModeAI,
} from '../utils/qa';

// ─── Tone → CSS class mapping ─────────────────────────────────────────────────
const TONE_CLASSES = {
  normal:  'border-white/10 bg-slate-900/85 text-slate-200',
  limited: 'border-amber-500/20 bg-amber-500/10 text-amber-50',
  empty:   'border-slate-500/20 bg-slate-500/10 text-slate-200',
  error:   'border-red-500/20 bg-red-500/10 text-red-100',
  loading: 'border-primary-500/20 bg-primary-500/10 text-primary-50',
};

const ICON_MAP = {
  normal:  Sparkles,
  limited: Info,
  empty:   Info,
  error:   AlertCircle,
  loading: Sparkles,
};

// ─── Language badge ───────────────────────────────────────────────────────────
function LangBadge({ lang }) {
  if (!lang || lang === 'en') return null;
  const map = {
    gu: { label: 'ગુ GU', cls: 'border-emerald-500/30 bg-emerald-500/15 text-emerald-300' },
    hi: { label: 'हि HI', cls: 'border-orange-500/30 bg-orange-500/15 text-orange-300' },
  };
  const entry = map[lang];
  if (!entry) return null;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.18em] ${entry.cls}`}
      title={`Question language: ${lang.toUpperCase()}`}
    >
      <Globe className="h-2.5 w-2.5" />
      {entry.label}
    </span>
  );
}

// ─── Confidence pill ──────────────────────────────────────────────────────────
function ConfidencePill({ confidence }) {
  if (!confidence) return null;
  const conf = String(confidence).toLowerCase();
  const styles = {
    high:   'border-emerald-500/30 bg-emerald-500/15 text-emerald-300',
    medium: 'border-amber-500/30 bg-amber-500/15 text-amber-300',
    low:    'border-red-500/30 bg-red-500/15 text-red-300',
  };
  const cls = styles[conf] || 'border-white/10 bg-white/5 text-slate-300';
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.18em] ${cls}`}>
      {conf.charAt(0).toUpperCase() + conf.slice(1)} confidence
    </span>
  );
}

// ─── AI mode badge ────────────────────────────────────────────────────────────
function ModeBadge({ mode }) {
  if (!mode) return null;
  const label    = getModeLabel(mode);
  const isGemini = isModeGemini(mode);
  const isAI     = isModeAI(mode);
  const isSemantic = mode === 'semantic';

  const cls = isGemini
    ? 'border-violet-500/30 bg-violet-500/15 text-violet-200'
    : isSemantic
    ? 'border-cyan-500/30 bg-cyan-500/15 text-cyan-200'
    : isAI
    ? 'border-blue-500/30 bg-blue-500/15 text-blue-200'
    : 'border-slate-500/30 bg-slate-500/15 text-slate-300';

  const Icon = isGemini ? Zap : isAI ? Cpu : null;

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.18em] ${cls}`}
      title={`Answered by: ${label}`}
    >
      {Icon && <Icon className="h-2.5 w-2.5" />}
      {label}
    </span>
  );
}

// ─── Answer body — renders plain text, bullet lists, structured blocks ────────
function AnswerBody({ text }) {
  if (!text) return null;
  const lines = text.split('\n');
  return (
    <div className="space-y-1 text-sm leading-7">
      {lines.map((line, i) => {
        const trimmed = line.trim();
        if (/^[•\-\*]\s/.test(trimmed)) {
          return (
            <div key={i} className="flex gap-2">
              <span className="mt-2 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-primary-400" />
              <span>{trimmed.replace(/^[•\-\*]\s/, '')}</span>
            </div>
          );
        }
        if (/^\d+[.)]\s/.test(trimmed)) {
          const num  = trimmed.match(/^(\d+)[.)]/)[1];
          const body = trimmed.replace(/^\d+[.)]\s/, '');
          return (
            <div key={i} className="flex gap-2">
              <span className="flex-shrink-0 rounded bg-white/10 px-1.5 py-0.5 text-[10px] font-bold text-slate-400">{num}</span>
              <span>{body}</span>
            </div>
          );
        }
        if (trimmed && /^[A-Z][\w\s]+:$/.test(trimmed)) {
          return <div key={i} className="mt-3 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">{trimmed}</div>;
        }
        if (!trimmed) return <div key={i} className="h-2" />;
        return <div key={i}>{line}</div>;
      })}
    </div>
  );
}

// ─── Proof card (collapsed evidence item — no raw transcript dump) ────────────
function ProofCard({ source }) {
  const [showTime, setShowTime] = useState(false);
  const hasSpeaker = source.speaker && String(source.speaker).trim().length > 0;
  const hasRange   = source.endMs > source.startMs;

  // Condense snippet to a readable proof excerpt (not a transcript dump)
  const raw     = String(source.textSnippet || '').trim();
  const snippet = raw.length > 180 ? `${raw.slice(0, 178).trim()}…` : raw;

  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 p-3 text-xs text-slate-200">
      {/* Row: speaker badge + optional timestamp + show-time toggle */}
      <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          {hasSpeaker && (
            <span className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[10px] font-medium text-slate-300">
              {source.speaker}
            </span>
          )}
          {showTime && (
            <span className="flex items-center gap-1 text-[10px] text-slate-400">
              <Clock3 className="h-3 w-3 flex-shrink-0" />
              {formatMs(source.startMs)}
              {hasRange ? ` – ${formatMs(source.endMs)}` : ''}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={() => setShowTime((s) => !s)}
          className="text-[10px] text-slate-500 hover:text-slate-300 transition-colors"
        >
          {showTime ? 'Hide time' : 'Show time'}
        </button>
      </div>

      {/* Proof excerpt */}
      <div className="leading-6 text-slate-300">{snippet}</div>
    </div>
  );
}

// ─── Evidence accordion ───────────────────────────────────────────────────────
function EvidenceAccordion({ sources, interactionId }) {
  const [open, setOpen] = useState(false);
  if (!sources.length) return null;

  return (
    <div className="mt-4 border-t border-white/10 pt-4">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-400 hover:text-slate-200 transition-colors"
      >
        {open
          ? <ChevronDown className="h-3.5 w-3.5 flex-shrink-0" />
          : <ChevronRight className="h-3.5 w-3.5 flex-shrink-0" />}
        Evidence
        <span className="rounded-full border border-white/10 bg-white/5 px-1.5 py-0.5 text-[10px] font-bold text-slate-400">
          {sources.length}
        </span>
      </button>

      {open && (
        <div className="mt-2 space-y-2">
          {sources.slice(0, 4).map((source, i) => (
            <ProofCard
              key={`${interactionId || 'src'}-${i}`}
              source={source}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Main card ────────────────────────────────────────────────────────────────
const QAAnswerCard = ({ interaction }) => {
  const answerState   = buildAnswerState(interaction);
  const sources       = normalizeSources(interaction?.sources);
  const Icon          = ICON_MAP[answerState.tone] || Sparkles;
  const mode          = interaction?.mode         || null;
  const confidence    = interaction?.confidence   || null;
  const questionLang  = interaction?.questionLang || 'en';
  const interactionId = interaction?._id || interaction?.createdAt;

  return (
    <div
      className={`rounded-[24px] rounded-bl-md border px-4 py-4 shadow-lg shadow-black/20 ${TONE_CLASSES[answerState.tone]}`}
    >
      {/* ── Header ── */}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-300">
          <Bot className="h-3.5 w-3.5 text-primary-300" />
          VoiceMind AI
          <ConfidencePill confidence={confidence} />
          <ModeBadge mode={mode} />
          <LangBadge lang={questionLang} />
        </div>
        {/* Quiet timestamp — just the time, date on hover */}
        <div
          className="text-right text-[10px] text-slate-500"
          title={interaction?.createdAt ? new Date(interaction.createdAt).toLocaleString() : undefined}
        >
          {formatChatTime(interaction?.createdAt)}
        </div>
      </div>

      {/* ── Evidence status banner ── */}
      <div className="mb-3 flex items-start gap-2 rounded-2xl border border-white/10 bg-black/10 px-3 py-2.5 text-xs leading-5 text-slate-300">
        <Icon className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
        <span>{answerState.message}</span>
      </div>

      {/* ── Answer body ── */}
      <AnswerBody text={interaction?.answer} />

      {/* ── Evidence accordion (collapsed by default) ── */}
      <EvidenceAccordion sources={sources} interactionId={interactionId} />
    </div>
  );
};

export default QAAnswerCard;
