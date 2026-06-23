// frontend/src/hooks/useMeetingEvents.js — v17.0
// v17 FIXES:
// 1. Listen for 'transcript_delta' event (backend emits this, not just chunk_transcribed)
// 2. Deduplicate incoming transcript text to prevent repeated paragraphs
// 3. Handle conversation_text from delta payload for real-time display
// 4. Smarter merging: replace full transcript on transcript_updated, append on delta
// 5. Auto-reconnect SSE with exponential backoff

import { useEffect, useRef, useState, useCallback } from 'react';
import api from '../services/api';

const API_BASE = process.env.REACT_APP_API_BASE_URL || 'http://localhost:5001/api';
const SSE_BASE = process.env.REACT_APP_SSE_URL || API_BASE.replace(/\/api\/?$/, '/api/events');

// v17: Added transcript_delta to the set of transcript events
const TRANSCRIPT_EVENTS = new Set([
  'chunk_transcribed',
  'transcript_updated',
  'transcript_delta',   // v17: backend emits this after each chunk
  'live_snapshot',
]);

const STATUS_EVENTS = new Set([
  'meeting_started',
  'chunk_uploaded',
  'chunk_processing_started',
  'chunk_rejected',
  'chunk_failed',
  'meeting_finalized',
  'transcript_rejected',
]);

// v17: Extract best text from any event payload shape
function pickText(payload = {}) {
  return (
    payload.conversation_text ||
    payload.conversationText ||
    payload.transcriptDelta ||
    payload.message ||
    payload.text ||
    payload.transcript?.conversation_text ||
    payload.transcript?.displayText ||
    payload.transcript?.fullText ||
    ''
  );
}

// v17: Deduplicate — remove text already present in current transcript
function deduplicateAppend(current, incoming) {
  if (!incoming) return current;
  if (!current) return incoming;
  // If incoming is contained in current — skip
  if (current.includes(incoming.trim())) return current;
  // Check if last N chars of current == first N chars of incoming (boundary overlap)
  const overlapWindow = Math.min(200, incoming.length);
  const tail = current.slice(-overlapWindow);
  const head = incoming.slice(0, overlapWindow);
  // Find longest suffix of tail that is prefix of head
  for (let len = overlapWindow; len >= 20; len--) {
    if (tail.endsWith(head.slice(0, len))) {
      return current + incoming.slice(len);
    }
  }
  return [current, incoming].filter(Boolean).join('\n\n');
}

export default function useMeetingEvents(meetingId, { enabled = true, polling = true } = {}) {
  const [connected, setConnected] = useState(false);
  const [transcriptText, setTranscriptText] = useState('');
  const [events, setEvents] = useState([]);
  const sourceRef = useRef(null);
  const pollRef = useRef(null);
  const retryCountRef = useRef(0);
  const stoppedRef = useRef(false);

  const appendEvent = useCallback((type, payload = {}) => {
    setEvents((prev) => [{ type, ...payload, at: new Date().toISOString() }, ...prev].slice(0, 100));

    if (!TRANSCRIPT_EVENTS.has(type)) return;
    const text = pickText(payload).trim();
    if (!text) return;

    setTranscriptText((current) => {
      // Full replacement on transcript_updated (post-processing complete)
      if (type === 'transcript_updated') return text;
      // For delta events: smart deduplicated append
      return deduplicateAppend(current, text);
    });
  }, []);

  useEffect(() => {
    if (!enabled || !meetingId) return undefined;
    stoppedRef.current = false;

    const connect = () => {
      if (stoppedRef.current) return;
      const url = `${SSE_BASE}?meetingId=${encodeURIComponent(meetingId)}`;
      const es = new EventSource(url, { withCredentials: true });
      sourceRef.current = es;

      es.onopen = () => {
        setConnected(true);
        retryCountRef.current = 0;
      };

      es.onerror = () => {
        setConnected(false);
        es.close();
        if (!stoppedRef.current) {
          // Exponential backoff: 1s, 2s, 4s, max 8s
          const delay = Math.min(1000 * Math.pow(2, retryCountRef.current), 8000);
          retryCountRef.current += 1;
          setTimeout(connect, delay);
        }
      };

      // Listen to all relevant event types
      [...TRANSCRIPT_EVENTS, ...STATUS_EVENTS].forEach((evType) => {
        es.addEventListener(evType, (event) => {
          try {
            appendEvent(evType, JSON.parse(event.data || '{}'));
          } catch (_e) { /* ignore malformed */ }
        });
      });
    };

    const pollTranscript = async () => {
      if (stoppedRef.current || !polling) return;
      try {
        const res = await api.get(`/meetings/${meetingId}/transcript`, {
          suppressGlobalErrorToast: true,
        });
        const text = pickText(res?.data?.data || res?.data || {}).trim();
        if (text) {
          setTranscriptText((current) => {
            // Poll result replaces if substantially longer (fresh full transcript)
            if (text.length > current.length * 1.1) return text;
            return deduplicateAppend(current, text);
          });
        }
      } catch (_e) { /* ignore */ }
    };

    connect();
    // Poll every 3s as fallback when SSE is unreliable
    pollRef.current = setInterval(pollTranscript, 3000);
    pollTranscript();

    return () => {
      stoppedRef.current = true;
      setConnected(false);
      if (sourceRef.current) {
        sourceRef.current.close();
        sourceRef.current = null;
      }
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [meetingId, enabled, polling, appendEvent]);

  return { connected, transcriptText, setTranscriptText, events };
}
