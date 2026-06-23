import { FileText, Loader2, MessageSquare, Mic, Square } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { useNavigate, useParams } from 'react-router-dom';
import { toast } from 'react-toastify';
import AppShell from '../components/AppShell';
import api, { meetingsApi } from '../services/api';
import { endMeeting, fetchMeetingById } from '../store/slices/meetingsSlice';
import { fetchTranscriptByMeetingId } from '../store/slices/transcriptsSlice';

const ACTIVE_WEB_MEETING_KEY = 'voicemind_active_web_meeting_id';
const ACTIVE_LIVE_MEETING_KEY = 'voicemind_active_live_meeting_id';
const ACTIVE_LIVE_MEETING_UPDATED_AT_KEY = 'voicemind_active_live_meeting_updated_at';

// ── Chunk duration: 60 seconds per LIVE_CHUNK_SECONDS=60 config ──────────────
// IMPORTANT: Hard floor MUST be 60000ms (60s) to match server-side expectations.
// The server marks chunks with durationMs < 58000 as isFinalPartialChunk=true.
// If chunks are shorter than 58s, ALL are treated as partial → transcript broken.
// Env var REACT_APP_LIVE_CHUNK_MS can override (minimum hard floor is 60000ms).
const WEB_CHUNK_MS = Math.max(
  60000,
  Number(process.env.REACT_APP_LIVE_CHUNK_MS || 60000)
);
// First chunk uses same 60s duration as regular chunks.
const FIRST_CHUNK_MS = WEB_CHUNK_MS;
// No client-side overlap — server-side dedupe handles boundary words.
const CHUNK_OVERLAP_MS = 0;
const POLL_INTERVAL_MS = 2000;
const DEFAULT_SAMPLE_RATE = 48000;
// FIX: 64kbps for opus — sufficient for speech, reduces WebM instability.
const DEFAULT_AUDIO_BITS_PER_SECOND = 64000;
const RECORDER_STOP_FLUSH_WAIT_MS = 700;
// 1000ms timeslice: collect data every 1s so partial chunks always have buffered
// audio on stop. Does NOT upload every second — the rotate timer fires at 60s.
const RECORDER_TIMESLICE_MS = 1000;

const pickSupportedMimeType = () => {
  // FIX: Force opus codec — most stable for Gujarati streaming.
  // opus gives consistent timestamps and lowest hallucination rate.
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/ogg;codecs=opus',
    'audio/webm',
    'audio/ogg',
    'audio/mp4',
  ];

  for (const candidate of candidates) {
    if (window.MediaRecorder?.isTypeSupported?.(candidate)) {
      return candidate;
    }
  }

  return '';
};

const mimeToExtension = (mimeType) => {
  if (!mimeType) return 'webm';
  if (mimeType.includes('ogg')) return 'ogg';
  if (mimeType.includes('mp4')) return 'mp4';
  return 'webm';
};

const formatClock = (ms) => {
  const totalSeconds = Math.max(0, Math.floor(Number(ms || 0) / 1000));
  const hours = String(Math.floor(totalSeconds / 3600)).padStart(2, '0');
  const minutes = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, '0');
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  return `${hours}:${minutes}:${seconds}`;
};

const stopStream = (stream) => {
  if (!stream || typeof stream.getTracks !== 'function') return;
  stream.getTracks().forEach((track) => {
    try {
      track.stop();
    } catch (_error) {
      // ignore
    }
  });
};

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const isValidMediaStream = (stream) =>
  typeof window !== 'undefined' &&
  typeof window.MediaStream !== 'undefined' &&
  stream instanceof window.MediaStream &&
  typeof stream.getTracks === 'function';

// FIX (Bug 2): measureBlobDurationSec — browser MediaRecorder WebM chunks return
// audio.duration = Infinity (non-seekable stream). Number.isFinite(Infinity) = false
// → old code always resolved 0. AudioContext.decodeAudioData is reliable for WebM
// fragments and returns actual decoded duration. HTMLAudioElement is kept as fallback.
const measureBlobDurationSec = (blob) =>
  new Promise((resolve) => {
    try {
      if (!blob || blob.size <= 0) { resolve(0); return; }

      // Primary: AudioContext.decodeAudioData — works correctly for fragmented WebM
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (AudioContextClass) {
        blob.arrayBuffer().then((buf) => {
          const ctx = new AudioContextClass();
          ctx.decodeAudioData(
            buf,
            (decoded) => {
              ctx.close();
              const dur = decoded.duration;
              resolve(Number.isFinite(dur) && dur > 0 ? dur : 0);
            },
            () => {
              ctx.close();
              resolve(0);
            }
          );
        }).catch(() => resolve(0));
        return;
      }

      // Fallback: HTMLAudioElement — explicitly handle Infinity (non-seekable WebM)
      const url = URL.createObjectURL(blob);
      const audio = new Audio();
      let finished = false;

      const cleanup = (value) => {
        if (finished) return;
        finished = true;
        try { audio.src = ''; } catch (_error) { /* ignore */ }
        URL.revokeObjectURL(url);
        const val = Number(value);
        resolve(Number.isFinite(val) && val > 0 ? val : 0);
      };

      audio.preload = 'metadata';
      // audio.duration = Infinity for non-seekable WebM — treat as 0, use wall-clock fallback
      audio.onloadedmetadata = () => cleanup(audio.duration === Infinity ? 0 : (audio.duration || 0));
      audio.onerror = () => cleanup(0);
      setTimeout(() => cleanup(0), 3000); // safety timeout
      audio.src = url;
    } catch (_error) {
      resolve(0);
    }
  });

const computeChunkStartSec = (meeting) => {
  const startMs = new Date(meeting?.startTime || meeting?.createdAt || Date.now()).getTime();
  const nowMs = Date.now();
  const elapsedSec = Math.max(0, (nowMs - startMs) / 1000);
  return Number(elapsedSec.toFixed(3));
};

// ── parseTextIntoSpeakerBlocks ────────────────────────────────────────────────
// Parses any text containing "Speaker N:" labels (on their own line OR inline)
// into {speaker, text} blocks. Handles both new format (label on own line)
// and old fallback format ("speaker 1: entire text here").
const parseTextIntoSpeakerBlocks = (text) => {
  const normalized = String(text || '').trim();
  if (!normalized) return [];

  // Pattern: "Speaker N:" at start of a line (own-line label format from Gemini parser)
  const ownLinePattern = /^(speaker\s+\d+)\s*:$/im;

  if (ownLinePattern.test(normalized)) {
    // Split on lines that are ONLY "Speaker N:"
    const blocks = [];
    const lines = normalized.split(/\n/);
    let currentSpeaker = null;
    let currentLines = [];

    for (const line of lines) {
      const stripped = line.trim();
      const labelMatch = stripped.match(/^(speaker\s+\d+)\s*:$/i);
      if (labelMatch) {
        if (currentSpeaker !== null) {
          const txt = currentLines.join(' ').replace(/\s+/g, ' ').trim();
          if (txt) blocks.push({ speaker: currentSpeaker, text: txt });
        }
        const n = labelMatch[1].match(/\d+$/)[0];
        currentSpeaker = `Speaker ${n}`;
        currentLines = [];
      } else if (stripped) {
        if (currentSpeaker === null) {
          currentSpeaker = 'Speaker 1';
        }
        currentLines.push(stripped);
      }
    }
    if (currentSpeaker !== null) {
      const txt = currentLines.join(' ').replace(/\s+/g, ' ').trim();
      if (txt) blocks.push({ speaker: currentSpeaker, text: txt });
    }
    if (blocks.length > 0) return blocks;
  }

  // Inline format: "speaker 1: text speaker 2: text" or "speaker 1: text\nspeaker 2: text"
  const inlineSplit = normalized.split(/(?=\bspeaker\s+\d+\s*:)/i);
  if (inlineSplit.length > 1) {
    const blocks = [];
    for (const chunk of inlineSplit) {
      const m = chunk.match(/^(speaker\s+\d+)\s*:\s*([\s\S]+)$/i);
      if (m) {
        const n = m[1].match(/\d+$/)[0];
        const txt = m[2].replace(/\s+/g, ' ').trim();
        if (txt) blocks.push({ speaker: `Speaker ${n}`, text: txt });
      } else if (chunk.trim()) {
        blocks.push({ speaker: 'Speaker 1', text: chunk.replace(/\s+/g, ' ').trim() });
      }
    }
    if (blocks.length > 0) return blocks;
  }

  // No speaker labels found
  return [{ speaker: 'Speaker 1', text: normalized }];
};

const buildFallbackSegments = (text) => {
  const blocks = parseTextIntoSpeakerBlocks(text);
  if (!blocks.length) return [];

  if (blocks.length === 1 && !String(text || '').match(/\bspeaker\s+\d+\s*:/i)) {
    // Plain text with no speaker markers — one block
    return [{
      id: 'line-0',
      speaker: 'Speaker 1',
      startMs: 0,
      endMs: 12000,
      time: `${formatClock(0)} - ${formatClock(12000)}`,
      text: blocks[0].text,
    }];
  }

  return blocks.map((item, i) => {
    const startMs = i * 12000;
    const endMs = startMs + 11999;
    const n = String(item.speaker).match(/\d+$/)?.[0] || '1';
    return {
      id: `line-${i}`,
      speaker: `Speaker ${n}`,
      startMs,
      endMs,
      time: `${formatClock(startMs)} - ${formatClock(endMs)}`,
      text: item.text,
    };
  }).filter((item) => item.text);
};


// Filter Whisper hallucinations at the render layer (defence-in-depth)
// Includes YouTube-style hallucinations AND initial_prompt echoes
const PROMPT_HALLUCINATION_PATTERNS = [
  // YouTube/video hallucinations — Whisper produces these on silence/wrong-lang audio
  /thanks?\s+for\s+watching/iu,
  /thank\s+you\s+(very\s+much\s+)?for\s+watching/iu,
  /please\s+(like\s+and\s+)?(subscribe|share)/iu,
  /don'?t\s+forget\s+to\s+subscribe/iu,
  /like\s+and\s+subscribe/iu,
  /hit\s+the\s+bell\s+(icon|button)/iu,
  /i\s+want\s+to\s+be\s+a\s+i\s+want\s+to\s+be\s+a/iu,
  /(no,?\s+){4,}/iu,
  // Initial prompt echoes
  /multi[\s-]+speaker\s+meeting/iu,
  /preserve\s+speaker\s+changes/iu,
  /avoid\s+collapsing\s+different\s+voices/iu,
  /gujarati[\s-]+first\s+multilingual/iu,
  /hindi[\s-]+first\s+multilingual/iu,
  /automatic\s+multilingual\s+meeting\s+decoding/iu,
  /prefer\s+exact\s+meeting\s+terms/iu,
  /production\.grade\s+(multilingual|transcription)/iu,
  /speech\s+pipeline/iu,
  /you\s+are\s+a\s+.*transcript.*engine/iu,
  /\bdo\s+not\s+summarize\b/iu,
];

const isPromptHallucination = (text = '') => {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return false;
  return PROMPT_HALLUCINATION_PATTERNS.some((p) => p.test(normalized));
};

// ── expandTurnIfEmbeddedLabels ────────────────────────────────────────────────
// When the old main.py stored an entire Gemini response as one segment/turn,
// the text looks like "Speaker 1:\ntext\nSpeaker 2:\ntext".
// This function detects that and expands it into multiple display cards.
const expandTurnIfEmbeddedLabels = (turn, baseStartMs, baseEndMs, idPrefix) => {
  const text = String(turn?.text || turn?.sourceText || '').trim();
  if (!text) return [];

  // Check if text contains embedded speaker labels
  const hasEmbeddedLabels = /\bspeaker\s+\d+\s*:/im.test(text);
  if (!hasEmbeddedLabels) {
    // Normal single turn — just normalize speaker label
    const rawSpeaker = String(turn?.speaker || 'Speaker 1');
    const n = rawSpeaker.match(/\d+/)?.[0] || '1';
    const startMs = Number(turn?.startMs ?? baseStartMs ?? 0);
    const endMs = Number(turn?.endMs ?? baseEndMs ?? startMs + 12000);
    return [{
      id: `${idPrefix}-0`,
      speaker: `Speaker ${n}`,
      startMs,
      endMs,
      time: `${formatClock(startMs)} - ${formatClock(endMs)}`,
      text,
    }];
  }

  // Expand: parse embedded speaker labels into separate cards
  const blocks = parseTextIntoSpeakerBlocks(text);
  const durationMs = Math.max(0, Number(turn?.endMs ?? baseEndMs ?? 0) - Number(turn?.startMs ?? baseStartMs ?? 0)) || (blocks.length * 12000);
  const totalWords = blocks.reduce((sum, b) => sum + b.text.split(/\s+/).length, 0) || 1;
  let currentMs = Number(turn?.startMs ?? baseStartMs ?? 0);

  return blocks.map((block, i) => {
    const words = block.text.split(/\s+/).length;
    const blockDuration = Math.round((words / totalWords) * durationMs);
    const startMs = currentMs;
    const endMs = currentMs + blockDuration;
    currentMs = endMs;
    const n = String(block.speaker).match(/\d+$/)?.[0] || '1';
    return {
      id: `${idPrefix}-${i}`,
      speaker: `Speaker ${n}`,
      startMs,
      endMs,
      time: `${formatClock(startMs)} - ${formatClock(endMs)}`,
      text: block.text,
    };
  }).filter((item) => item.text);
};

const normalizeDisplayedSegments = (groupedTurns, segments, transcriptText) => {
  if (Array.isArray(groupedTurns) && groupedTurns.length > 0) {
    const expanded = [...groupedTurns]
      .sort((a, b) => Number(a?.startMs || 0) - Number(b?.startMs || 0))
      .flatMap((turn, index) =>
        expandTurnIfEmbeddedLabels(
          turn,
          Number(turn?.startMs ?? 0),
          Number(turn?.endMs ?? 0),
          `turn-${turn?.chunkIndex ?? index}-${turn?.id ?? index}`,
        ),
      )
      .filter((item) => item.text)
      .filter((item) => !isPromptHallucination(item.text));

    const groupedTextLength = expanded.map((item) => item.text).join(' ').trim().length;
    const fullTextLength = String(transcriptText || '').trim().length;

    if (groupedTextLength > 0 && (fullTextLength === 0 || groupedTextLength >= fullTextLength * 0.5)) {
      return expanded;
    }
  }

  if (Array.isArray(segments) && segments.length > 0) {
    const expanded = [...segments]
      .sort((a, b) => Number(a?.startMs || 0) - Number(b?.startMs || 0))
      .flatMap((segment, index) =>
        expandTurnIfEmbeddedLabels(
          segment,
          Number(segment?.startMs ?? 0),
          Number(segment?.endMs ?? 0),
          `seg-${segment?.chunkIndex ?? 0}-${segment?.id ?? index}`,
        ),
      )
      .filter((item) => item.text)
      .filter((item) => !isPromptHallucination(item.text));

    const segmentTextLength = expanded.map((item) => item.text).join(' ').trim().length;
    const fullTextLength = String(transcriptText || '').trim().length;

    if (segmentTextLength > 0 && (fullTextLength === 0 || segmentTextLength >= fullTextLength * 0.5)) {
      return expanded;
    }
  }

  return buildFallbackSegments(transcriptText);
};

const MeetingDetail = () => {
  const { id } = useParams();
  const dispatch = useDispatch();
  const navigate = useNavigate();

  const { currentMeeting, loading } = useSelector((state) => state.meetings);
  const { currentTranscript } = useSelector((state) => state.transcripts);
  const { liveTranscript } = useSelector((state) => state.liveStatus);

  const [isRecording, setIsRecording] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [uploadedChunks, setUploadedChunks] = useState(0);
  const [uploadError, setUploadError] = useState('');

  const audioContextRef = useRef(null);
  const micStreamRef = useRef(null);
  const systemStreamRef = useRef(null);
  const recordingStreamRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const rotateTimerRef = useRef(null);
  const uploadQueueRef = useRef(Promise.resolve());

  const startAtRef = useRef(null);
  const nextChunkIndexRef = useRef(0);
  const startedForMeetingRef = useRef(null);
  const hasShownStartToastRef = useRef(false);
  const stoppingRef = useRef(false);
  const manualStopInProgressRef = useRef(false);
  const isUnmountedRef = useRef(false);
  const isStartingRef = useRef(false);
  const startAttemptIdRef = useRef(0);
  const activeRecorderIdRef = useRef(0);

  const meetingStatusRef = useRef(null);
  const transcriptStatusRef = useRef(null);
  const durationSecRef = useRef(0);
  const isRecordingRef = useRef(false);
  const meetingStartRef = useRef(null);

  useEffect(() => {
    dispatch(fetchMeetingById(id));
  }, [dispatch, id]);

  const resolvedMeetingId = currentMeeting?.meetingId || currentMeeting?._id || id;

  useEffect(() => {
    if (!resolvedMeetingId) return;
    dispatch(fetchTranscriptByMeetingId(resolvedMeetingId));
  }, [dispatch, resolvedMeetingId]);

  useEffect(() => {
    meetingStatusRef.current = currentMeeting?.status;
  }, [currentMeeting?.status]);

  useEffect(() => {
    transcriptStatusRef.current = currentTranscript?.processingStatus;
  }, [currentTranscript?.processingStatus]);

  useEffect(() => {
    durationSecRef.current = Number(currentMeeting?.stats?.durationSec || 0);
  }, [currentMeeting?.stats?.durationSec]);

  useEffect(() => {
    const recording = currentMeeting?.status === 'recording';
    isRecordingRef.current = recording;

    if (recording && currentMeeting?.startTime && !meetingStartRef.current) {
      const seedStart = currentMeeting.startTime || currentMeeting.createdAt || new Date().toISOString();
      meetingStartRef.current = new Date(seedStart).getTime();
      if (!startAtRef.current) startAtRef.current = meetingStartRef.current;
    }

    if (!recording) {
      meetingStartRef.current = null;
      manualStopInProgressRef.current = false;
    }
  }, [currentMeeting?.status, currentMeeting?.startTime, currentMeeting?.createdAt]);

  useEffect(() => {
    const activePoll =
      ['recording', 'processing'].includes(currentMeeting?.status) ||
      ['pending', 'processing', 'partial'].includes(currentTranscript?.processingStatus);

    if (!id || !activePoll) return undefined;

    const timer = setInterval(() => {
      const meetingStatus = meetingStatusRef.current;
      const transcriptStatus = transcriptStatusRef.current;

      if (
        ['recording', 'processing'].includes(meetingStatus) ||
        ['pending', 'processing', 'partial'].includes(transcriptStatus)
      ) {
        dispatch(fetchMeetingById(id));
        if (resolvedMeetingId) {
          dispatch(fetchTranscriptByMeetingId(resolvedMeetingId));
        }
      }
    }, POLL_INTERVAL_MS);

    return () => clearInterval(timer);
  }, [currentMeeting?.status, currentTranscript?.processingStatus, dispatch, id, resolvedMeetingId]);

  useEffect(() => {
    const timer = setInterval(() => {
      if (!isRecordingRef.current) return;
      const liveElapsed = Date.now() - (startAtRef.current || Date.now());
      const serverElapsed = durationSecRef.current * 1000;
      setElapsedMs(Math.max(liveElapsed, serverElapsed));
    }, 500);

    return () => clearInterval(timer);
  }, []);

  const cleanupRecorder = useCallback(async () => {
    try {
      if (rotateTimerRef.current) {
        clearTimeout(rotateTimerRef.current);
        rotateTimerRef.current = null;
      }

      if (mediaRecorderRef.current) {
        mediaRecorderRef.current.ondataavailable = null;
        mediaRecorderRef.current.onerror = null;
        mediaRecorderRef.current.onstop = null;
      }

      stopStream(recordingStreamRef.current);
      stopStream(micStreamRef.current);
      stopStream(systemStreamRef.current);

      if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
        await audioContextRef.current.close();
      }
    } catch (error) {
      console.error('Recorder cleanup failed:', error);
    }

    mediaRecorderRef.current = null;
    recordingStreamRef.current = null;
    micStreamRef.current = null;
    systemStreamRef.current = null;
    audioContextRef.current = null;
    activeRecorderIdRef.current = 0;
  }, []);

  const enqueueChunkUpload = useCallback(
    // FIX (Bug 2): Accept pre-computed measuredDurationSec from onstop (wall-clock + Audio fallback).
    // Previously this param was ignored and measureBlobDurationSec() was called again here,
    // always returning 0 for fragmented WebM. Now we use the passed value directly.
    async ({ meetingRouteId, transcriptMeetingId, chunkIndex, durationSec,
             measuredDurationSec: passedMeasuredDurationSec,
             chunkStartSec, chunkEndSec, isFinalPartialChunk, blob }) => {
      if (!blob || blob.size === 0) return;

      const mimeType = blob.type || 'audio/webm;codecs=opus';
      const extension = mimeToExtension(mimeType);
      const uploadToken = `${transcriptMeetingId || meetingRouteId}-${chunkIndex}-${Date.now()}`;

      // Use the pre-computed measured duration — never re-call measureBlobDurationSec here.
      // For partial chunks send the actual duration; for full chunks use the passed wall-clock value.
      const effectiveMeasured = passedMeasuredDurationSec ?? durationSec ?? 0;

      // FIX (Improvement 2): Send actual chunk duration in ms, not the constant WEB_CHUNK_MS=60000.
      // Partial chunks can be much shorter; using the constant was misleading for VAD and server logs.
      const actualChunkDurationMs = Math.round(Number(effectiveMeasured || durationSec || 0) * 1000);

      const formData = new FormData();

      formData.append('chunk', new File([blob], `chunk_${chunkIndex}.${extension}`, { type: mimeType }));
      formData.append('chunkIndex', String(chunkIndex));
      formData.append('durationSec', String(durationSec));
      formData.append('measuredDurationSec', String(Number(effectiveMeasured || 0).toFixed(3)));
      formData.append('mimeType', mimeType);
      formData.append('source', 'web');
      formData.append('selectedLanguage', String(currentMeeting?.selectedLanguage || currentMeeting?.language || 'auto'));
      formData.append('uploadToken', uploadToken);
      formData.append('chunkStartSec', String(Number(chunkStartSec || 0).toFixed(3)));
      formData.append('chunkEndSec', String(Number(chunkEndSec || chunkStartSec || 0).toFixed(3)));
      formData.append('isFinalPartialChunk', String(Boolean(isFinalPartialChunk)));
      formData.append('clientCapturedAt', new Date().toISOString());
      formData.append('blobSizeBytes', String(blob.size || 0));
      formData.append('sequence', String(chunkIndex));
      // FIX (Improvement 2): Send actual measured duration, not constant WEB_CHUNK_MS
      formData.append('chunkDurationMs', String(actualChunkDurationMs));
      formData.append('clientTimestamp', String(Date.now()));

      const effectiveDurationSec = Number(effectiveMeasured || durationSec || 0);
      if (isFinalPartialChunk && effectiveDurationSec < 0.5) {
        console.debug('[recorder:chunk-skipped-invalid-duration-v14]', {
          meetingRouteId, transcriptMeetingId, chunkIndex, durationSec, measuredDurationSec: effectiveMeasured, blobSize: blob.size,
        });
        return;
      }

      console.info('[web-recorder] upload started', {
        meetingRouteId,
        transcriptMeetingId,
        chunkIndex,
        durationSec,
        measuredDurationSec: effectiveMeasured,
        chunkStartSec,
        chunkEndSec,
        isFinalPartialChunk,
        blobSize: blob.size,
        mimeType,
        uploadToken,
      });

      const response = process.env.REACT_APP_AUDIO_UPLOAD_DRIVER === 'r2'
        ? await meetingsApi.uploadChunk(meetingRouteId, chunkIndex, blob, {
            durationSec,
            measuredDurationSec: effectiveMeasured,
            chunkStartSec,
            chunkEndSec,
            isFinalPartialChunk,
            clientCapturedAt: new Date().toISOString(),
            uploadToken,
            sizeBytes: blob.size,
          })
        : await api.post(`/meetings/${meetingRouteId}/chunks`, formData, {
            headers: { 'Content-Type': 'multipart/form-data' },
            timeout: 180000,
          });

      console.info('[web-recorder] upload completed', { meetingRouteId, transcriptMeetingId, chunkIndex, blobSize: blob.size });
      setUploadedChunks((prev) => Math.max(prev, Number(response?.data?.data?.chunksUploaded || chunkIndex + 1)));
      if (transcriptMeetingId) {
        dispatch(fetchTranscriptByMeetingId(transcriptMeetingId));
      }
      dispatch(fetchMeetingById(meetingRouteId));
    },
    [dispatch, currentMeeting?.selectedLanguage, currentMeeting?.language],
  );

  const buildRecordingStream = useCallback(async (meeting) => {
    const webConfig = meeting?.webConfig || meeting?.sourceConfig || {};
    const sampleRate = Number(webConfig.sampleRate || DEFAULT_SAMPLE_RATE);
    const wantsSystemAudio = webConfig.audioMode === 'mic_system';
    const noiseReduction = webConfig.noiseReduction !== false;

    const micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        sampleRate: { ideal: sampleRate },
        sampleSize: 16,
        echoCancellation: false,
        noiseSuppression: noiseReduction,
        autoGainControl: true,
        latency: { ideal: 0.01 },
      },
      video: false,
    });

    micStreamRef.current = micStream;

    if (!wantsSystemAudio) {
      recordingStreamRef.current = micStream;
      return micStream;
    }

    let displayStream = null;
    try {
      displayStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    } catch (_error) {
      toast.warning('System audio was not shared. Continuing with microphone only.');
      recordingStreamRef.current = micStream;
      return micStream;
    }

    const systemAudioTracks = displayStream.getAudioTracks();
    if (systemAudioTracks.length === 0) {
      stopStream(displayStream);
      toast.warning('No system audio track was detected. Continuing with microphone only.');
      recordingStreamRef.current = micStream;
      return micStream;
    }

    systemStreamRef.current = displayStream;

    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    const audioContext = new AudioContextClass({ sampleRate });
    const destination = audioContext.createMediaStreamDestination();

    const micSource = audioContext.createMediaStreamSource(micStream);
    const systemSource = audioContext.createMediaStreamSource(new MediaStream(systemAudioTracks));

    micSource.connect(destination);
    systemSource.connect(destination);

    if (audioContext.state === 'suspended') {
      await audioContext.resume();
    }

    audioContextRef.current = audioContext;

    const mixedStream = new MediaStream(destination.stream.getAudioTracks());
    if (!isValidMediaStream(mixedStream) || mixedStream.getAudioTracks().length === 0) {
      stopStream(displayStream);
      recordingStreamRef.current = micStream;
      toast.warning('Mixed stream could not be created. Continuing with microphone only.');
      return micStream;
    }

    recordingStreamRef.current = mixedStream;
    return mixedStream;
  }, []);

  const requestRecorderStop = useCallback(async ({ reason = 'manual_stop', restartAfterStop = false }) => {
    const recorder = mediaRecorderRef.current;
    const session = recorder?.__voicemindSession;

    if (!recorder || !session) return;

    if (session.finalizePromise) {
      await session.finalizePromise;
      return;
    }

    if (rotateTimerRef.current) {
      clearTimeout(rotateTimerRef.current);
      rotateTimerRef.current = null;
    }

    session.stopReason = reason;
    session.shouldRestart = restartAfterStop;
    session.stopRequestedAt = Date.now();
    session.finalizePromise = new Promise((resolve, reject) => {
      session.finalizeResolve = resolve;
      session.finalizeReject = reject;
    });

    console.info('[web-recorder] chunk stop requested', {
      recorderId: session.id,
      chunkIndex: session.chunkIndex,
      stopReason: reason,
      restartAfterStop,
    });

    if (typeof recorder.requestData === 'function' && recorder.state === 'recording') {
      try {
        recorder.requestData();
      } catch (_error) {
        // ignore
      }
    }

    await wait(RECORDER_STOP_FLUSH_WAIT_MS);

    if (recorder.state !== 'inactive') {
      recorder.stop();
    }

    await session.finalizePromise;
  }, []);

  const startChunkRecorder = useCallback(
    async (meeting, stream) => {
      if (!isValidMediaStream(stream)) {
        throw new Error('Invalid recording stream. Expected MediaStream but received null or invalid value.');
      }

      const audioTracks = stream.getAudioTracks();
      if (!audioTracks || audioTracks.length === 0) {
        throw new Error('No audio track available for browser recording.');
      }

      const mimeType = pickSupportedMimeType();
      const recorder = mimeType
        ? new MediaRecorder(stream, {
            mimeType,
            audioBitsPerSecond: DEFAULT_AUDIO_BITS_PER_SECOND,
          })
        : new MediaRecorder(stream, {
            audioBitsPerSecond: DEFAULT_AUDIO_BITS_PER_SECOND,
          });

      const session = {
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        chunkIndex: nextChunkIndexRef.current,
        startedAt: Date.now(),
        chunkStartSec: computeChunkStartSec(meeting),
        stopRequestedAt: 0,
        stopReason: 'unknown',
        shouldRestart: false,
        finalized: false,
        finalizePromise: null,
        finalizeResolve: null,
        finalizeReject: null,
        parts: [],
      };

      nextChunkIndexRef.current += 1;
      recorder.__voicemindSession = session;
      mediaRecorderRef.current = recorder;
      activeRecorderIdRef.current = session.id;

      recorder.ondataavailable = (event) => {
        if (!event.data || event.data.size === 0) return;
        session.parts.push(event.data);
        console.info('[web-recorder] ondataavailable', {
          recorderId: session.id,
          chunkIndex: session.chunkIndex,
          blobSize: event.data.size,
        });
      };

      recorder.onerror = (event) => {
        const errorMessage = event?.error?.message || 'Browser recording failed';
        console.error('MediaRecorder error:', event?.error || event);
        if (session.finalizeReject) {
          session.finalizeReject(new Error(errorMessage));
        }
      };

      recorder.onstop = async () => {
        try {
          const parts = Array.isArray(session.parts) ? session.parts.filter(Boolean) : [];
          session.parts = [];

          const stopAt = session.stopRequestedAt || Date.now();
          const actualDurationMs = Math.max(0, stopAt - session.startedAt);

          const recorderMime = recorder.mimeType || mimeType || 'audio/webm';

          const measuredBlobDurationSec = await measureBlobDurationSec(
            new Blob(parts, { type: recorderMime })
          );

          const durationSec = Math.max(
            0.35,
            measuredBlobDurationSec || Number((actualDurationMs / 1000).toFixed(3))
          );

          const chunkStartSec = Number(session.chunkStartSec || 0);
          const chunkEndSec = Number((chunkStartSec + durationSec).toFixed(3));

          // A chunk is "partial" if the user stopped early (manual_stop) OR if the
          // rotation was interrupted mid-overlap. In both cases we want the backend
          // to transcribe it so nothing is lost. The first 15s preview chunk is
          // NOT partial — it's a deliberate early upload for fast UX.
          const isFinalPartialChunk =
            (session.stopReason === 'manual_stop' || session.stopReason === 'rotation_overlap') &&
            durationSec > 0 &&
            durationSec < WEB_CHUNK_MS / 1000;

          const meetingRouteId = meeting._id || meeting.meetingId;
          const transcriptMeetingId = meeting.meetingId || meeting._id;

          console.info('[web-recorder] onstop fired', {
            recorderId: session.id,
            chunkIndex: session.chunkIndex,
            stopReason: session.stopReason,
            shouldRestart: session.shouldRestart,
            partsCount: parts.length,
          });

          if (
            session.shouldRestart &&
            !stoppingRef.current &&
            !manualStopInProgressRef.current &&
            !isUnmountedRef.current &&
            startedForMeetingRef.current === meeting.meetingId &&
            recordingStreamRef.current
          ) {
            try {
              await startChunkRecorder(meeting, recordingStreamRef.current);
            } catch (restartError) {
              console.error('Failed to restart recorder after rotation:', restartError);
              toast.error(restartError?.message || 'Failed to continue recording next chunk');
            }
          }

          if (parts.length > 0) {
            const blob = new Blob(parts, { type: recorderMime });

            if (blob.size > 2048) {
              console.info('[web-recorder] chunk finalized', {
                recorderId: session.id,
                chunkIndex: session.chunkIndex,
                stopReason: session.stopReason,
                blobSize: blob.size,
                durationSec,
                measuredBlobDurationSec,
                chunkStartSec,
                chunkEndSec,
                isFinalPartialChunk,
              });

              setUploading(true);
              setUploadError('');

              const uploadPromise = uploadQueueRef.current
                .then(() =>
                  enqueueChunkUpload({
                    meetingRouteId,
                    transcriptMeetingId,
                    chunkIndex: session.chunkIndex,
                    durationSec,
                    measuredDurationSec: measuredBlobDurationSec,
                    chunkStartSec,
                    chunkEndSec,
                    isFinalPartialChunk,
                    blob,
                  })
                )
                .catch((error) => {
                  console.error('[web-recorder] upload failed', {
                    chunkIndex: session.chunkIndex,
                    error,
                  });

                  const message =
                    error?.response?.data?.error?.message ||
                    error?.message ||
                    'Failed to upload recording chunk';

                  setUploadError(message);
                  toast.error(message);
                })
                .finally(() => {
                  if (!stoppingRef.current && !manualStopInProgressRef.current) {
                    setUploading(false);
                  }
                });

              uploadQueueRef.current = uploadPromise;
            }
          }

          session.finalized = true;
          if (session.finalizeResolve) session.finalizeResolve();
        } catch (error) {
          if (session.finalizeReject) session.finalizeReject(error);
        } finally {
          if (mediaRecorderRef.current === recorder) {
            mediaRecorderRef.current = null;
          }
        }
      };

      console.debug('[web-recorder] chunk recorder started', {
        meetingId: meeting.meetingId,
        recorderId: session.id,
        chunkIndex: session.chunkIndex,
        chunkStartTime: new Date(session.startedAt).toISOString(),
        nextChunkIndexAfterReserve: nextChunkIndexRef.current,
      });

      // Use a 1s timeslice so Stop at 1–59s always has buffered audio data.
      // This does NOT upload every second; it only makes final partial chunks reliable.
      recorder.start(RECORDER_TIMESLICE_MS);

      if (rotateTimerRef.current) clearTimeout(rotateTimerRef.current);

      // CHUNK ROTATION STRATEGY:
      // All chunks (including chunk 0) fire after WEB_CHUNK_MS (60s).
      // This matches LIVE_CHUNK_SECONDS=60 on the server.
      // isFinalPartialChunk is only set when the user stops early (< 58s chunk).
      const isFirstChunk = session.chunkIndex === 0;
      const chunkDuration = isFirstChunk ? FIRST_CHUNK_MS : WEB_CHUNK_MS;
      const rotateAt = Math.max(1000, chunkDuration - CHUNK_OVERLAP_MS);

      rotateTimerRef.current = setTimeout(async () => {
        if (stoppingRef.current || manualStopInProgressRef.current) return;
        if (!recordingStreamRef.current) return;
        try {
          // Start the OVERLAPPING successor recorder BEFORE stopping current.
          await startChunkRecorder(meeting, recordingStreamRef.current);
          // Mark old session so its onstop does NOT spawn another recorder.
          session.shouldRestart = false;
          // Stop the old recorder after the overlap window finishes.
          setTimeout(() => {
            if (recorder.state !== 'inactive') {
              session.stopRequestedAt = Date.now();
              session.stopReason = 'rotation_overlap';
              try { recorder.stop(); } catch (_) { /* recorder already stopped */ }
            }
          }, CHUNK_OVERLAP_MS);
        } catch (error) {
          console.error('Overlapped chunk rotation failed:', error);
          setUploadError(error?.message || 'Failed to rotate recorder chunk');
          toast.error(error?.message || 'Failed to rotate recorder chunk');
        }
      }, rotateAt);
    },
    [enqueueChunkUpload, requestRecorderStop],
  );

  const startBrowserRecording = useCallback(
    async (meeting) => {
      if (!meeting || meeting.source !== 'web' || meeting.status !== 'recording') return;
      if (startedForMeetingRef.current === meeting.meetingId) return;
      if (isStartingRef.current) return;
      if (stoppingRef.current || manualStopInProgressRef.current) return;

      if (!window.MediaRecorder) {
        toast.error('Your browser does not support MediaRecorder.');
        return;
      }

      isStartingRef.current = true;
      const startAttemptId = Date.now();
      startAttemptIdRef.current = startAttemptId;

      try {
        const stream = await buildRecordingStream(meeting);
        if (
          isUnmountedRef.current ||
          startAttemptIdRef.current !== startAttemptId ||
          stoppingRef.current ||
          manualStopInProgressRef.current
        ) {
          stopStream(stream);
          return;
        }

        if (!isValidMediaStream(stream)) {
          throw new Error('Invalid recording stream. Expected MediaStream but received null.');
        }

        if (stream.getAudioTracks().length === 0) {
          throw new Error('No audio track available for browser recording.');
        }

        recordingStreamRef.current = stream;
        startAtRef.current = new Date(meeting.startTime || meeting.createdAt || Date.now()).getTime();

        const serverChunks = Number(currentMeeting?.stats?.chunksUploaded || meeting?.stats?.chunksUploaded || 0);
        nextChunkIndexRef.current = Number(meeting?.stats?.lastChunkIndex >= 0 ? meeting.stats.lastChunkIndex + 1 : serverChunks);
        setUploadedChunks(serverChunks);

        startedForMeetingRef.current = meeting.meetingId;
        stoppingRef.current = false;
        sessionStorage.setItem(ACTIVE_WEB_MEETING_KEY, meeting.meetingId);
        localStorage.setItem(ACTIVE_LIVE_MEETING_KEY, meeting.meetingId);
        localStorage.setItem(ACTIVE_LIVE_MEETING_UPDATED_AT_KEY, String(Date.now()));

        await startChunkRecorder(meeting, stream);

        if (!isUnmountedRef.current && !manualStopInProgressRef.current) {
          setIsRecording(true);
          setElapsedMs(Number(meeting?.stats?.durationSec || 0) * 1000);
          if (!hasShownStartToastRef.current) {
            toast.success('Browser recording started');
            hasShownStartToastRef.current = true;
          }
        }
      } catch (error) {
        console.error(error);
        await cleanupRecorder();
        startedForMeetingRef.current = null;
        sessionStorage.removeItem(ACTIVE_WEB_MEETING_KEY);
        localStorage.removeItem(ACTIVE_LIVE_MEETING_KEY);
        localStorage.removeItem(ACTIVE_LIVE_MEETING_UPDATED_AT_KEY);
        toast.error(error?.message || 'Microphone permission denied or recording setup failed');
      } finally {
        isStartingRef.current = false;
      }
    },
    [buildRecordingStream, cleanupRecorder, currentMeeting?.stats?.chunksUploaded, startChunkRecorder],
  );

  const stopBrowserRecording = useCallback(async () => {
    if (!currentMeeting || currentMeeting.source !== 'web') return;
    if (isStopping) return;

    setIsStopping(true);
    setUploading(true);
    stoppingRef.current = true;
    manualStopInProgressRef.current = true;

    try {
      console.info('[web-recorder] end meeting requested', { meetingId: currentMeeting.meetingId });

      await requestRecorderStop({
        reason: 'manual_stop',
        restartAfterStop: false,
      });

      await uploadQueueRef.current;
      await cleanupRecorder();

      setIsRecording(false);
      startedForMeetingRef.current = null;
      sessionStorage.removeItem(ACTIVE_WEB_MEETING_KEY);
      localStorage.removeItem(ACTIVE_LIVE_MEETING_KEY);
      localStorage.removeItem(ACTIVE_LIVE_MEETING_UPDATED_AT_KEY);

      const meetingKey = currentMeeting._id || currentMeeting.meetingId;
      const endResult = await dispatch(endMeeting(meetingKey)).unwrap();
      const endData = endResult?.data || endResult || {};
      if (endData?.status === 'cancelled_short') {
        toast.info(endData.message || 'Meeting is not created because recording time is less than 20 seconds.');
        navigate('/meetings');
        return;
      }
      await dispatch(fetchMeetingById(meetingKey));
      await dispatch(fetchTranscriptByMeetingId(currentMeeting.meetingId));

      toast.success('Recording stopped. Transcript is processing.');
    } catch (error) {
      console.error(error);
      toast.error(
        error?.response?.data?.error?.message ||
          error?.message ||
          'Failed to stop and upload recording',
      );
    } finally {
      setUploading(false);
      setIsStopping(false);
      stoppingRef.current = false;
      isStartingRef.current = false;
    }
  }, [cleanupRecorder, currentMeeting, dispatch, isStopping, requestRecorderStop]);

  useEffect(() => {
    if (!currentMeeting || currentMeeting.source !== 'web') return;
    if (currentMeeting.status !== 'recording') {
      setIsRecording(false);
      return;
    }

    if (isStopping || stoppingRef.current || manualStopInProgressRef.current) {
      return;
    }

    // Guard against React StrictMode double-invocation and SSE re-renders
    // triggering multiple recorder starts for the same meeting
    if (startedForMeetingRef.current === currentMeeting.meetingId) {
      console.debug('[recorder:ignored-duplicate-start]', { meetingId: currentMeeting.meetingId, reason: 'already_started_for_this_meeting' });
      return;
    }
    if (isStartingRef.current) {
      console.debug('[recorder:ignored-duplicate-start]', { meetingId: currentMeeting.meetingId, reason: 'start_already_in_progress' });
      return;
    }

    const activeMeetingId = sessionStorage.getItem(ACTIVE_WEB_MEETING_KEY);
    if (!activeMeetingId || activeMeetingId === currentMeeting.meetingId) {
      void startBrowserRecording(currentMeeting);
    }
  }, [currentMeeting, isStopping, startBrowserRecording]);

  useEffect(() => {
    isUnmountedRef.current = false;
    return () => {
      isUnmountedRef.current = true;
      isStartingRef.current = false;
      void cleanupRecorder();
    };
  }, [cleanupRecorder]);

  const displayElapsedMs = useMemo(() => {
    const serverMs = Number(currentMeeting?.stats?.durationSec || 0) * 1000;
    return Math.max(elapsedMs, serverMs);
  }, [currentMeeting?.stats?.durationSec, elapsedMs]);

  const transcriptText = useMemo(() => {
    return String(
      currentTranscript?.conversation_text ||
        currentTranscript?.fullText ||
        currentTranscript?.displayText ||
        currentTranscript?.cleanEnglish ||
        currentTranscript?.rawFullText ||
        currentTranscript?.rawTranscriptNormalized ||
        liveTranscript ||
        '',
    ).trim();
  }, [
    currentTranscript?.conversation_text,
    currentTranscript?.fullText,
    currentTranscript?.displayText,
    currentTranscript?.cleanEnglish,
    currentTranscript?.rawFullText,
    currentTranscript?.rawTranscriptNormalized,
    liveTranscript,
  ]);

  const transcriptSegments = useMemo(() => {
    return normalizeDisplayedSegments(
      currentTranscript?.groupedSpeakerTurns,
      currentTranscript?.segments,
      currentTranscript?.conversation_text || transcriptText,
    );
  }, [currentTranscript?.groupedSpeakerTurns, currentTranscript?.segments, transcriptText]);

  if (loading) {
    return (
      <AppShell>
        <div className="p-8">Loading...</div>
      </AppShell>
    );
  }

  if (!currentMeeting) {
    return (
      <AppShell>
        <div className="p-8">Meeting not found</div>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <div className="space-y-6">
        <div className="flex items-center justify-between gap-4">
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
            {currentMeeting.title}
          </h1>

          <div className="flex items-center gap-3">
            {currentMeeting.source === 'web' && currentMeeting.status === 'recording' && (
              <button
                onClick={stopBrowserRecording}
                disabled={isStopping}
                className="btn-primary bg-red-600 hover:bg-red-700 flex items-center gap-2 px-4 py-2"
              >
                {isStopping ? <Loader2 className="w-4 h-4 animate-spin" /> : <Square className="w-4 h-4" />}
                {isStopping ? 'Stopping...' : 'Stop Recording'}
              </button>
            )}
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-4">
          <div className="surface-card p-4">
            <div className="text-sm text-gray-500 mb-1">Source</div>
            <div className="font-semibold text-gray-900 dark:text-white capitalize">
              {currentMeeting.source}
            </div>
          </div>

          <div className="surface-card p-4">
            <div className="text-sm text-gray-500 mb-1">Status</div>
            <div className="font-semibold text-gray-900 dark:text-white capitalize">
              {currentMeeting.status}
            </div>
          </div>

          <div className="surface-card p-4">
            <div className="text-sm text-gray-500 mb-1">Recording Time</div>
            <div className="font-mono text-xl font-bold text-gray-900 dark:text-white">
              {formatClock(displayElapsedMs)}
            </div>
          </div>

          <div className="surface-card p-4">
            <div className="text-sm text-gray-500 mb-1">Uploads / 60s Chunks</div>
            <div className="font-semibold text-gray-900 dark:text-white">
              {Number(currentMeeting?.stats?.chunksUploaded ?? uploadedChunks ?? 0)} total / {Number(currentMeeting?.stats?.chunksCompleted60s ?? currentMeeting?.stats?.chunksCompleted30s ?? 0)} full
              {currentMeeting?.stats?.hasFinalPartialChunk ? ' + final partial' : ''}
            </div>
          </div>
        </div>

        <div className="surface-card p-5">
          <div className="flex items-center gap-2 mb-3">
            <Mic className="w-4 h-4" />
            <h2 className="font-semibold text-gray-900 dark:text-white">Live Transcript</h2>
          </div>

          {uploading && (
            <div className="mb-3 flex items-center gap-2 text-sm text-primary-600">
              <Loader2 className="w-4 h-4 animate-spin" />
              Uploading / transcribing latest chunk...
            </div>
          )}

          {uploadError && (
            <div className="mb-3 rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-200">
              {uploadError}
            </div>
          )}

          {currentTranscript?.lastError?.message && (
            <div className="mb-3 rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-200">
              {currentTranscript.lastError.message}
            </div>
          )}

          {transcriptSegments.length > 0 ? (
            <div className="space-y-3 min-h-[240px]">
              {transcriptSegments.map((segment) => (
                <div
                  key={segment.id}
                  className="rounded-2xl border border-primary-500/20 bg-slate-950/40 p-4"
                >
                  <div className="mb-2 flex flex-wrap items-center gap-3">
                    <span className="rounded-full border border-white/10 bg-slate-900 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-white">
                      {segment.speaker}
                    </span>
                    <span className="text-xs font-medium text-slate-400">{segment.time}</span>
                  </div>
                  <div className="whitespace-pre-wrap text-sm leading-7 text-gray-200">
                    {segment.text}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="whitespace-pre-wrap text-gray-700 dark:text-gray-300 min-h-[240px]">
              {['pending', 'processing', 'partial'].includes(
                currentTranscript?.processingStatus || currentMeeting?.status,
              )
                ? 'Transcript is processing. If no text appears, the audio chunks may have been rejected because no valid speech was detected or the selected language did not match the speech.'
                : 'No transcript available yet.'}
            </div>
          )}
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <button
            onClick={() => navigate(`/transcripts/${currentMeeting.meetingId}`)}
            className="surface-card p-4 flex items-center gap-3 hover:border-primary-400 transition-colors"
          >
            <FileText className="w-5 h-5" />
            <div className="text-left">
              <div className="font-semibold text-gray-900 dark:text-white">Open Transcript</div>
              <div className="text-sm text-gray-500">See full transcript view</div>
            </div>
          </button>

          <button
            onClick={() => navigate(`/qa/${currentMeeting.meetingId}`)}
            className="surface-card p-4 flex items-center gap-3 hover:border-primary-400 transition-colors"
          >
            <MessageSquare className="w-5 h-5" />
            <div className="text-left">
              <div className="font-semibold text-gray-900 dark:text-white">Ask Q&amp;A</div>
              <div className="text-sm text-gray-500">Ask questions on this meeting</div>
            </div>
          </button>
        </div>
      </div>
    </AppShell>
  );
};

export default MeetingDetail;