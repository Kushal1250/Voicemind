// frontend/src/pages/LiveMonitor.jsx
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import { useNavigate } from 'react-router-dom';
import {
  Mic,
  StopCircle,
  Activity,
  Wifi,
  Clock,
  HardDrive,
  AlertCircle,
  Download,
  ChevronLeft,
  Sparkles,
} from 'lucide-react';
import { toast } from 'react-toastify';
import AppShell from '../components/AppShell';
import { endMeeting } from '../store/slices/meetingsSlice';
import { buildRenderableTranscriptTurns } from '../utils/transcriptTurns';

const LiveMonitor = () => {
  const dispatch = useDispatch();
  const navigate = useNavigate();

  const {
    activeDeviceStatus,
    activeMeetingStatus,
    liveTranscript,
    liveTranscriptData,
    liveTimeline,
    recordingStartTime,
    chunksProgress,
    connectionMode,
    isConnected,
  } = useSelector((state) => state.liveStatus);

  const { currentMeeting } = useSelector((state) => state.meetings);

  const [elapsedTime, setElapsedTime] = useState(0);
  const [showEndConfirm, setShowEndConfirm] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [ending, setEnding] = useState(false);

  const transcriptRef = useRef(null);

  const activeMeetingId = useMemo(
    () => activeMeetingStatus?.meetingId || currentMeeting?.meetingId || currentMeeting?._id || null,
    [activeMeetingStatus, currentMeeting],
  );

  const isRecording = activeMeetingStatus?.status === 'recording';

  const connectionLabel = useMemo(() => {
    if (isConnected) {
      return connectionMode === 'realtime' ? 'Live (SSE)' : 'Polling';
    }

    if (
      activeDeviceStatus?.status === 'online' &&
      ['recording', 'processing'].includes(activeMeetingStatus?.status)
    ) {
      return 'Syncing...';
    }

    return 'Disconnected';
  }, [isConnected, connectionMode, activeDeviceStatus, activeMeetingStatus]);

  const effectiveConnected = useMemo(() => {
    if (isConnected) return true;

    return Boolean(
      activeDeviceStatus?.status === 'online' &&
        ['recording', 'processing'].includes(activeMeetingStatus?.status),
    );
  }, [isConnected, activeDeviceStatus, activeMeetingStatus]);

  const transcriptTurns = useMemo(() => {
    return buildRenderableTranscriptTurns(
      liveTranscriptData || {},
      liveTranscript || '',
    );
  }, [liveTranscriptData, liveTranscript]);

  const filteredTranscriptTurns = useMemo(() => {
    if (!searchTerm.trim()) {
      return transcriptTurns;
    }

    const query = searchTerm.toLowerCase();
    return transcriptTurns.filter((turn) =>
      String(turn?.text || '').toLowerCase().includes(query),
    );
  }, [transcriptTurns, searchTerm]);

  useEffect(() => {
    if (!recordingStartTime) {
      setElapsedTime(0);
      return;
    }

    const update = () => {
      const start = new Date(recordingStartTime).getTime();
      if (Number.isNaN(start)) {
        setElapsedTime(0);
        return;
      }

      const end = activeMeetingStatus?.endTime
        ? new Date(activeMeetingStatus.endTime).getTime()
        : Date.now();

      setElapsedTime(Math.max(0, Math.floor((end - start) / 1000)));
    };

    update();

    if (!isRecording && !activeMeetingStatus?.endTime) {
      return undefined;
    }

    const intervalId = setInterval(update, 1000);
    return () => clearInterval(intervalId);
  }, [recordingStartTime, activeMeetingStatus, isRecording]);

  useEffect(() => {
    if (transcriptRef.current) {
      transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight;
    }
  }, [filteredTranscriptTurns.length, liveTranscript, liveTranscriptData]);

  const formatTime = (seconds) => {
    const total = Number(seconds || 0);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const sec = total % 60;

    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  };

  const handleEndMeeting = async () => {
    if (!activeMeetingId) {
      toast.error('Live meeting id not found');
      return;
    }

    try {
      setEnding(true);
      const result = await dispatch(endMeeting(activeMeetingId)).unwrap();

      toast.success(
        result?.status === 'stop_requested'
          ? 'Stop command sent to ESP32 device'
          : 'Meeting ended successfully',
      );

      setShowEndConfirm(false);
    } catch (error) {
      toast.error(error || 'Failed to end meeting');
    } finally {
      setEnding(false);
    }
  };

  const handleExport = () => {
    const exportText =
      transcriptTurns.length > 0
        ? transcriptTurns
            .map(
              (turn) =>
                `${turn.speaker} ${turn.startLabel} - ${turn.endLabel}\n${turn.text}`,
            )
            .join('\n\n')
        : liveTranscript || '';

    const blob = new Blob([exportText], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');

    anchor.href = url;
    anchor.download = `transcript_${new Date().toISOString().slice(0, 10)}.txt`;
    anchor.click();

    URL.revokeObjectURL(url);
    toast.success('Transcript exported');
  };

  return (
    <AppShell>
      <div className="space-y-6">
        <section className="glass-panel overflow-hidden p-6 sm:p-8">
          <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <button
                onClick={() => navigate('/dashboard')}
                className="mb-4 inline-flex items-center gap-2 text-sm text-slate-400 hover:text-white transition"
              >
                <ChevronLeft className="h-4 w-4" /> Dashboard
              </button>

              <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-primary-500/20 bg-primary-500/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.24em] text-primary-200">
                <Sparkles className="h-3.5 w-3.5" />
                Live feed
              </div>

              <h1 className="section-title text-3xl">Live Monitor</h1>
              <p className="section-subtitle">
                Real-time recording progress, chunk uploads, and transcript streaming.
              </p>
            </div>

            <div className="flex flex-wrap gap-3">
              <button
                onClick={handleExport}
                disabled={!liveTranscript && !transcriptTurns.length}
                className="btn-secondary"
              >
                <Download className="h-4 w-4" /> Export
              </button>

              <button
                onClick={() => setShowEndConfirm(true)}
                disabled={!activeMeetingId || ending || !isRecording}
                className="inline-flex items-center gap-2 rounded-xl bg-red-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-red-500 disabled:opacity-50 transition"
              >
                <StopCircle className="h-4 w-4" />
                {ending ? 'Stopping...' : 'End Meeting'}
              </button>
            </div>
          </div>
        </section>

        {isRecording && (
          <div className="rounded-2xl border border-amber-500/20 bg-amber-500/10 p-4">
            <div className="flex items-center gap-3">
              <AlertCircle className="h-5 w-5 text-amber-300 flex-shrink-0" />
              <p className="text-sm text-amber-100">
                <span className="font-semibold">Hardware recording in progress.</span>{' '}
                Tracking ESP32 state, chunks uploaded, and transcript processing in real time.
              </p>
            </div>
          </div>
        )}

        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          {[
            {
              label: 'Connection',
              icon: Activity,
              value: (
                <div className="flex items-center gap-2">
                  <span
                    className={`h-2 w-2 rounded-full ${
                      effectiveConnected ? 'bg-green-400 animate-pulse' : 'bg-red-400'
                    }`}
                  />
                  <span>{connectionLabel}</span>
                </div>
              ),
            },
            {
              label: 'Device',
              icon: Wifi,
              value: (
                <div className="flex items-center gap-2">
                  <span
                    className={`h-2 w-2 rounded-full ${
                      activeDeviceStatus?.status === 'online' ? 'bg-green-400' : 'bg-red-400'
                    }`}
                  />
                  <span className="capitalize">
                    {activeDeviceStatus?.status || 'Unknown'}
                  </span>
                </div>
              ),
              sub:
                activeDeviceStatus?.telemetry?.rssi !== undefined
                  ? `Signal: ${activeDeviceStatus.telemetry.rssi} dBm`
                  : null,
            },
            {
              label: 'Recording time',
              icon: Clock,
              value: <span className="font-mono text-2xl font-bold">{formatTime(elapsedTime)}</span>,
            },
            {
              label: 'Chunks uploaded',
              icon: HardDrive,
              value: (
                <span className="text-lg font-semibold">
                  {chunksProgress.displayCurrent} / {chunksProgress.displayTotal}
                </span>
              ),
              sub: chunksProgress.hasFinalPartialChunk
                ? 'Includes final partial chunk'
                : chunksProgress.isTotalExplicit
                  ? 'Using backend expected total'
                  : chunksProgress.hasAnyStats
                    ? 'Derived from latest backend chunk stats'
                    : null,
              progress: chunksProgress.progressPercent || 0,
            },
          ].map(({ label, icon: Icon, value, sub, progress }) => (
            <div key={label} className="surface-card p-4">
              <div className="mb-2 flex items-center gap-2 text-xs text-slate-400">
                <Icon className="h-4 w-4" /> {label}
              </div>
              <div className="text-white">{value}</div>
              {sub && <p className="mt-1 text-xs text-slate-500">{sub}</p>}
              {progress !== undefined && (
                <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-white/10">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-primary-500 to-indigo-400 transition-all"
                    style={{ width: `${progress}%` }}
                  />
                </div>
              )}
            </div>
          ))}
        </div>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          <div
            className="surface-card flex flex-col lg:col-span-2 overflow-hidden"
            style={{ minHeight: 560 }}
          >
            <div className="border-b border-white/10 p-4 flex items-center justify-between">
              <h3 className="flex items-center gap-2 font-semibold text-white">
                <Mic
                  className={`h-4 w-4 ${
                    isRecording ? 'text-red-400 animate-pulse' : 'text-slate-400'
                  }`}
                />
                Live Transcript
                {isRecording && (
                  <span className="ml-2 flex items-center gap-1 text-xs text-red-400">
                    <span className="h-1.5 w-1.5 rounded-full bg-red-400 animate-pulse" />
                    LIVE
                  </span>
                )}
              </h3>

              <input
                type="text"
                placeholder="Search transcript..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="input-field w-52 text-xs py-1.5 px-3"
              />
            </div>

            <div
              ref={transcriptRef}
              className="flex-1 overflow-auto p-4 font-mono text-sm leading-relaxed text-slate-200 whitespace-pre-wrap scrollbar-thin"
            >
              {filteredTranscriptTurns.length > 0 ? (
                filteredTranscriptTurns.map((turn, index) => (
                  <div
                    key={turn.id || index}
                    className="mb-3 rounded-2xl border border-white/10 bg-white/5 p-3"
                  >
                    <div className="mb-2 flex items-center justify-between gap-3 text-xs text-slate-400">
                      <span className="rounded-full border border-white/10 bg-slate-900 px-2 py-1 font-semibold text-white">
                        {turn.speaker}
                      </span>
                      <span>
                        {turn.startLabel} - {turn.endLabel}
                      </span>
                    </div>

                    <div className="whitespace-pre-wrap text-sm leading-7 text-slate-200">
                      {turn.text}
                    </div>
                  </div>
                ))
              ) : (
                <div className="flex h-full min-h-64 items-center justify-center text-slate-500">
                  <div className="text-center">
                    <Mic className="mx-auto mb-3 h-10 w-10 opacity-20" />
                    <p>Waiting for transcription...</p>
                    <p className="mt-1 text-xs">Audio chunks are being processed</p>
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="surface-card flex flex-col overflow-hidden" style={{ minHeight: 560 }}>
            <div className="border-b border-white/10 p-4">
              <h3 className="font-semibold text-white">Activity Timeline</h3>
            </div>

            <div className="flex-1 overflow-auto p-4 scrollbar-thin">
              {liveTimeline.length === 0 ? (
                <div className="flex h-full min-h-48 items-center justify-center text-center text-slate-500">
                  <div>
                    <Activity className="mx-auto mb-3 h-10 w-10 opacity-20" />
                    <p>No activity yet</p>
                  </div>
                </div>
              ) : (
                <div className="space-y-4">
                  {liveTimeline.map((event) => (
                    <div key={event.id} className="flex gap-3">
                      <div className="flex flex-col items-center">
                        <div
                          className={`h-2 w-2 rounded-full mt-1 flex-shrink-0 ${
                            event.type?.includes('failed')
                              ? 'bg-red-400'
                              : event.type?.includes('started')
                              ? 'bg-green-400'
                              : event.type?.includes('uploaded')
                              ? 'bg-primary-400'
                              : 'bg-slate-500'
                          }`}
                        />
                        <div className="w-px flex-1 bg-white/5 mt-1" />
                      </div>

                      <div className="flex-1 pb-4">
                        <p className="text-sm text-white">{event.message}</p>
                        <p className="mt-1 text-xs text-slate-500">
                          {new Date(event.timestamp).toLocaleTimeString()}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        {showEndConfirm && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
            <div className="surface-card w-full max-w-md p-6">
              <h3 className="mb-2 text-lg font-semibold text-white">End Recording?</h3>
              <p className="mb-6 text-sm text-slate-400">
                This will stop the ESP32 recording and finalize the meeting.
              </p>

              <div className="flex gap-3 justify-end">
                <button
                  onClick={() => setShowEndConfirm(false)}
                  className="btn-secondary"
                  disabled={ending}
                >
                  Cancel
                </button>

                <button
                  onClick={handleEndMeeting}
                  disabled={ending}
                  className="inline-flex items-center gap-2 rounded-xl bg-red-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-red-500 disabled:opacity-50"
                >
                  {ending ? 'Stopping...' : 'End Meeting'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </AppShell>
  );
};

export default LiveMonitor;