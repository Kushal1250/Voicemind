import React, { useMemo } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { useSelector } from 'react-redux';
import {
  AlertTriangle, WifiOff, ServerCrash, Wifi, ShieldAlert,
  CheckCircle2, ArrowLeft, Terminal, Lightbulb, Clock,
  RefreshCw, Info, Cpu, Mic, Radio, Database, Lock,
  AlertCircle, Zap,
} from 'lucide-react';
import AppShell from '../components/AppShell';

/* ═══════════════════════════════════════════════════
   ERROR GUIDE DATABASE
   Key = dedupeKey from backend notifications
   ═══════════════════════════════════════════════════ */
const ERROR_GUIDES = {
  'network-error': {
    icon: WifiOff, severity: 'warning',
    title: 'Network Error — Cannot Reach Server',
    summary: 'Your browser sent a request to the VoiceMind backend but received no response. The connection was refused or timed out before any data was exchanged.',
    whatHappened: [
      'The frontend sent an HTTP request to the backend API.',
      'No response arrived within the 30-second timeout window.',
      'The axios network interceptor caught the failure and raised this notification.',
    ],
    possibleCauses: [
      'The backend server (Node.js / Express) is not running.',
      'The backend is running on a different port than the frontend expects.',
      'A firewall or proxy is blocking the connection.',
      'Your machine lost internet or LAN access.',
      'The .env REACT_APP_API_BASE_URL points to the wrong address.',
    ],
    fixSteps: [
      { step:1, title:'Verify the backend is running', command:'# In the backend directory:\nnpm run dev\n# or\nnode src/server.js', description:'Open a terminal in the backend folder and start the server. Look for "Server running on port 5001".' },
      { step:2, title:'Check the correct port', command:'# Backend .env:\nPORT=5001\n\n# Frontend .env:\nREACT_APP_API_BASE_URL=http://localhost:5001/api', description:'Make sure both .env files agree on the port number. The frontend URL must include /api at the end.' },
      { step:3, title:'Test the API directly', command:'# Visit in browser:\nhttp://localhost:5001/api/health\n# or via curl:\ncurl http://localhost:5001/api/health', description:'A JSON response confirms the backend is running. Connection refused means the server is down.' },
      { step:4, title:'Check for port conflicts', command:'# macOS / Linux:\nlsof -i :5001\n\n# Windows:\nnetstat -ano | findstr :5001', description:'Another process may be using port 5001. Kill it or change PORT in backend .env.' },
      { step:5, title:'Also check Python transcription service', command:'# Python service runs on port 8001:\npython main.py\n# or\nuvicorn main:app --port 8001', description:'The Python Whisper service must also be running for transcription to work.' },
    ],
    quickChecks: [
      'Is the backend terminal still open and showing no crash?',
      'Does http://localhost:5001/api/health respond in your browser?',
      'Are both frontend and backend .env files present and correct?',
      'Is the Python transcription service running on port 8001?',
    ],
  },

  'backend-offline': {
    icon: ServerCrash, severity: 'warning',
    title: 'Backend Offline — SSE Stream Disconnected',
    summary: 'The live Server-Sent Events (SSE) stream between your browser and the backend was interrupted. Real-time updates (device status, meeting events, notification counts) are paused until the connection is restored.',
    whatHappened: [
      'The frontend maintains a persistent SSE connection to /api/notifications/stream.',
      'The EventSource onerror callback fired — the stream closed unexpectedly.',
      'The frontend will attempt to reconnect every 5 seconds automatically.',
    ],
    possibleCauses: [
      'The backend process crashed or was restarted.',
      'A network interruption severed the long-lived HTTP connection.',
      'The JWT token used by the SSE connection expired.',
      'A load balancer or reverse proxy has a short connection timeout configured.',
    ],
    fixSteps: [
      { step:1, title:'Check if the backend is running', command:'# Look at your backend terminal for crash output.\n# Restart if needed:\nnpm run dev', description:'A crashed Node.js process is the most common cause. Restart and the SSE stream reconnects automatically.' },
      { step:2, title:'Verify the SSE endpoint', command:'curl -N -H "Accept: text/event-stream" \\\n  "http://localhost:5001/api/notifications/stream?token=YOUR_JWT"', description:'You should see ": heartbeat" lines every 25 seconds. A 401 means the token expired.' },
      { step:3, title:'Check nginx proxy timeout (production)', command:'# In nginx config:\nproxy_read_timeout 3600s;\nproxy_send_timeout 3600s;\nproxy_buffering off;\nchunked_transfer_encoding on;', description:'Proxies default to 60s timeouts which kills SSE. The settings above allow 1-hour connections.' },
      { step:4, title:'Check JWT expiry', command:'# Backend .env:\nJWT_EXPIRES_IN=7d', description:'If the SSE token expired, logging out and back in refreshes it. The stream auto-reconnects.' },
      { step:5, title:'Wait for auto-reconnect', command:null, description:'The frontend retries every 5 seconds. You will see a "Backend online" notification when the stream is restored.' },
    ],
    quickChecks: [
      'Does the backend terminal show the server running with no errors?',
      'Has a "Backend online" notification appeared yet (check System tab)?',
      'Is the connection indicator in the topbar showing "Disconnected"?',
    ],
  },

  'backend-online': {
    icon: Wifi, severity: 'success',
    title: 'Backend Online — Connection Restored',
    summary: 'The VoiceMind backend is back online and the live SSE stream has been successfully reconnected. All real-time features are active.',
    whatHappened: [
      'After a previous disconnect, the frontend kept attempting to reconnect every 5 seconds.',
      'The backend became reachable and confirmed the SSE stream with a "connected" event.',
      'The wasDisconnectedRef flag detected this was a recovery and generated this notification.',
    ],
    possibleCauses: ['This is a recovery notification — no action is required.'],
    fixSteps: [
      { step:1, title:'No action required', command:null, description:'This notification confirms everything is working correctly. The connection indicator in the topbar should show "Realtime" or "Polling".' },
      { step:2, title:'Review recent system notifications', command:null, description:'Check for any "Backend offline" or "Network error" notifications. They may point to an underlying instability worth investigating.' },
      { step:3, title:'If this appears frequently', command:'# Monitor backend stability:\npm2 logs voicemind-backend\n# or\njournalctl -u voicemind -f', description:'Frequent connect/disconnect cycles suggest the backend is unstable. Review memory usage, uncaught exceptions, or DB connection issues.' },
    ],
    quickChecks: [
      'Does the connection indicator now show "Realtime" or "Polling"?',
      'Are new notifications appearing as expected?',
    ],
  },

  'transcription-service-error': {
    icon: Mic, severity: 'critical',
    title: 'Transcription Service Error',
    summary: 'The backend received an audio chunk, but the Python transcription service rejected it or failed while processing it.',
    whatHappened: [
      'A meeting chunk was uploaded successfully to the backend.',
      'The backend called the Python Whisper transcription service on port 8001.',
      'The service returned an error, so the chunk or transcript step failed.',
    ],
    possibleCauses: [
      'The Python transcription service is not running.',
      'FFmpeg is missing or cannot decode the uploaded audio format.',
      'The browser chunk format is invalid or corrupted.',
      'Gujarati or Hindi language detection/model settings are misconfigured.',
    ],
    fixSteps: [
      { step:1, title:'Start the Python transcription service', command:'cd python_services/transcription_service\npython main.py', description:'Make sure the service is listening on port 8001 before starting a meeting.' },
      { step:2, title:'Verify health endpoint', command:'curl http://localhost:8001/health', description:'The response should show modelLoaded=true and backend=faster_whisper or openai_whisper.' },
      { step:3, title:'Check FFmpeg and chunk format', command:'ffmpeg -version', description:'FFmpeg must be installed and available. WebM or WAV chunks must decode successfully.' },
      { step:4, title:'Review backend and Python logs', command:'npm run dev\n# and in Python terminal watch the traceback', description:'The exact chunk failure message will tell you whether this is a model, decode, or file problem.' },
    ],
    quickChecks: [
      'Is python main.py still running?',
      'Does /health return modelLoaded=true?',
      'Did the backend log show FFmpeg conversion failed or invalid chunk?',
    ],
  },

  'server-error-500': {
    icon: ShieldAlert, severity: 'critical',
    title: 'Server Error 500 — Internal Server Error',
    summary: 'The backend returned HTTP 500, meaning an unhandled exception occurred inside the server while processing a request.',
    whatHappened: [
      'An API request reached the backend successfully.',
      'The backend threw an unhandled exception while processing it.',
      'Express caught it in the global errorHandler and returned status 500.',
      'The errorHandler also emitted a server_error event to create this notification.',
    ],
    possibleCauses: [
      'A MongoDB operation failed (connection dropped, query error, validation failure).',
      'The Python transcription API timed out or returned an error.',
      'A null reference or type error in backend route handler code.',
      'Disk space exhausted while writing audio chunks.',
      'The JWT_SECRET or another required environment variable is missing.',
    ],
    fixSteps: [
      { step:1, title:'Check the backend error logs', command:'# Look for the full stack trace in backend terminal.\n# Or search logs:\ngrep -i "error" backend.log | tail -50', description:'The stack trace identifies exactly which file and line threw the exception.' },
      { step:2, title:'Check MongoDB connection', command:'# Backend .env:\nMONGO_URI=mongodb://localhost:27017/voicemind\n\n# Test:\nmongosh mongodb://localhost:27017/voicemind', description:'Most 500 errors are database failures. Confirm MongoDB is running and the connection string is correct.' },
      { step:3, title:'Check Python transcription service', command:'# The Whisper service must be running:\npython main.py\n# or\nuvicorn main:app --host 0.0.0.0 --port 8001\n\n# Test it:\ncurl http://localhost:8001/health', description:'If the Python Whisper service is down, transcription API calls will fail with 500.' },
      { step:4, title:'Check all required .env variables', command:'# Required backend .env:\nMONGO_URI=\nJWT_SECRET=\nPORT=5001\n\n# Python service .env:\nWHISPER_MODEL_SIZE=large-v3\nWHISPER_DEVICE=cpu\nWHISPER_BEAM_SIZE=10', description:'A missing environment variable causes crashes. Compare your .env against .env.example.' },
      { step:5, title:'Check disk space', command:'# macOS / Linux:\ndf -h\n\n# Check uploads size:\ndu -sh backend/uploads/', description:'Audio chunk uploads can fill disk quickly. ENOSPC errors cause 500s.' },
    ],
    quickChecks: [
      'Does the backend terminal show a stack trace with a file name and line number?',
      'Is MongoDB running? (mongosh or MongoDB Compass)',
      'Is the Python Whisper service running on port 8001?',
      'Are all required .env variables set?',
    ],
  },

  'device-offline': {
    icon: Cpu, severity: 'warning',
    title: 'ESP32 Device Offline',
    summary: 'An ESP32 recording device has gone offline unexpectedly. Any active recording from this device may have been interrupted.',
    whatHappened: [
      'The backend\'s device heartbeat monitor detected the device stopped sending keepalive pings.',
      'After the configured timeout, the device was marked as offline.',
      'A device_offline event was emitted and this notification was generated.',
    ],
    possibleCauses: [
      'The ESP32 lost WiFi connectivity.',
      'The ESP32 battery was depleted or the device was powered off.',
      'The backend server restarted and the device WebSocket connection was lost.',
      'The WiFi network changed or the password was updated.',
    ],
    fixSteps: [
      { step:1, title:'Check the ESP32 physical state', command:null, description:'Ensure the device is powered on and the status LED indicates a WiFi connection. A solid or blinking green LED typically means connected.' },
      { step:2, title:'Verify WiFi credentials in firmware', command:'// In ESP32 firmware (config.h or similar):\nconst char* ssid = "YOUR_WIFI_SSID";\nconst char* password = "YOUR_WIFI_PASSWORD";\nconst char* serverUrl = "ws://YOUR_BACKEND_IP:5001";', description:'If the WiFi password changed or the backend IP changed, reflash the ESP32 with updated credentials.' },
      { step:3, title:'Check the backend WebSocket server', command:'# The backend should log when devices connect/disconnect:\ngrep -i "device" backend.log | tail -20', description:'If the backend restarted, the device needs to reconnect. Power-cycle the ESP32 or trigger a reconnect.' },
      { step:4, title:'Monitor device in Devices page', command:null, description:'Go to the Devices page to see the real-time status. Once the device reconnects, it will show as Online automatically.' },
    ],
    quickChecks: [
      'Is the ESP32 powered on and showing WiFi connectivity?',
      'Did the backend restart recently (which would drop WebSocket connections)?',
      'Is the WiFi network stable and available?',
    ],
  },

  'device-online': {
    icon: Cpu, severity: 'info',
    title: 'ESP32 Device Connected',
    summary: 'An ESP32 recording device has come online and established a WebSocket connection to the backend.',
    whatHappened: [
      'The ESP32 device connected to the backend WebSocket server.',
      'The device sent its initial handshake and device ID.',
      'A device_online event was emitted and this notification was generated.',
    ],
    possibleCauses: ['This is an informational notification — the device is working correctly.'],
    fixSteps: [
      { step:1, title:'No action required', command:null, description:'The device is online and ready to record. Navigate to the Devices page to start a new meeting or view device details.' },
    ],
    quickChecks: ['Is the device visible as Online in the Devices page?'],
  },



  'transcription-service': {
    icon: Mic, severity: 'critical',
    title: 'Transcription Service Error',
    summary: 'The backend received an audio chunk, but the Python transcription service could not process it correctly. Live transcript updates may stop until the service is healthy again.',
    whatHappened: [
      'A meeting chunk upload reached the backend successfully.',
      'The backend called the FastAPI /transcribe-upload endpoint on port 8001.',
      'That request failed, so a live system notification was generated and linked here.',
    ],
    possibleCauses: [
      'The Python transcription service is not running.',
      'The uploaded audio chunk format is invalid or incomplete.',
      'FFmpeg is missing or not available to the Python process.',
      'Whisper is still loading or the machine is under heavy CPU load.',
      'The selected language was forced incorrectly instead of auto-detecting Gujarati/Hindi speech.',
    ],
    fixSteps: [
      { step:1, title:'Confirm Python service is running', command:'python main.py\n# or\nuvicorn main:app --host 0.0.0.0 --port 8001', description:'The service must stay running while chunks are uploaded from the meeting page.' },
      { step:2, title:'Check service health', command:'curl http://127.0.0.1:8001/health', description:'You should see modelLoaded:true and status:ok before starting a live meeting.' },
      { step:3, title:'Verify FFmpeg is installed', command:'ffmpeg -version', description:'The Python service converts uploaded chunks to 16k WAV before transcription. Missing FFmpeg will break every chunk.' },
      { step:4, title:'Use automatic language detection', command:'# Python service .env\nWHISPER_LANGUAGE=auto\nWHISPER_MODEL_SIZE=large-v3', description:'Auto detection gives much better Gujarati/Hindi recognition than forcing English.' },
      { step:5, title:'Retry with the updated 30-second chunk recorder', command:null, description:'The frontend now records standalone 30-second chunks to stop invalid WebM uploads and reduce flicker.' },
    ],
    quickChecks: [
      'Does http://127.0.0.1:8001/health show modelLoaded:true?',
      'Does the backend log show any FFmpeg conversion error?',
      'Do new chunks keep uploading every 30 seconds without screen flicker?',
    ],
  },

  'whisper-model-error': {
    icon: AlertTriangle, severity: 'critical',
    title: 'Whisper Model Load Error',
    summary: 'The Python transcription service failed to load the Whisper model. Transcription is unavailable until this is resolved.',
    whatHappened: [
      'The FastAPI transcription service started but could not load the Whisper model.',
      'Both faster-whisper and openai-whisper backends were tried and both failed.',
      'The /health endpoint returns "degraded" status.',
    ],
    possibleCauses: [
      'The large-v3 model files are not downloaded yet (first run takes several minutes).',
      'Insufficient disk space to store the model (~3GB for large-v3).',
      'Incompatible CUDA version if GPU mode is enabled.',
      'The faster-whisper package is not installed correctly.',
      'Network issues prevented model download from HuggingFace.',
    ],
    fixSteps: [
      { step:1, title:'Check Python service logs', command:'# Start the service and watch for errors:\npython main.py\n# Look for lines like:\n# [VoiceMind] Whisper loaded: backend=faster_whisper\n# or error messages', description:'The service logs show exactly why the model failed to load.' },
      { step:2, title:'Check disk space for model download', command:'df -h ~/.cache/huggingface\n\n# The large-v3 model requires ~3GB:\ndu -sh ~/.cache/huggingface/hub/', description:'The large-v3 model downloads automatically on first run. Ensure you have at least 5GB free.' },
      { step:3, title:'Reinstall faster-whisper', command:'pip install faster-whisper==1.2.0 --break-system-packages --force-reinstall', description:'A corrupted faster-whisper installation can prevent model loading. Reinstall it.' },
      { step:4, title:'Use a smaller model temporarily', command:'# In Python service .env:\nWHISPER_MODEL_SIZE=medium\n\n# Or for fastest startup (lower accuracy):\nWHISPER_MODEL_SIZE=base', description:'If large-v3 is too large for your system, use medium or small. Accuracy will be lower for Indian languages but the service will start.' },
      { step:5, title:'Test model health endpoint', command:'curl http://localhost:8001/health\n# Should return:\n# {"status":"ok","modelLoaded":true,...}', description:'After restarting the service, check the health endpoint to confirm the model loaded successfully.' },
    ],
    quickChecks: [
      'Does http://localhost:8001/health return modelLoaded:true?',
      'Is there enough disk space for the ~3GB model files?',
      'Are all Python packages installed (pip install -r requirements.txt)?',
    ],
  },
};

/* Generate 502/503/504 entries */
['502','503','504'].forEach(code => {
  ERROR_GUIDES[`server-error-${code}`] = {
    icon: ServerCrash, severity: 'critical',
    title: `Gateway Error ${code} — ${code==='502'?'Bad Gateway':code==='503'?'Service Unavailable':'Gateway Timeout'}`,
    summary: code==='502'
      ? 'A gateway or proxy (nginx, Caddy, AWS ALB) received an invalid response from the upstream backend service.'
      : code==='503'
      ? 'The server is temporarily unable to handle requests, usually due to overload or maintenance.'
      : 'The upstream backend did not respond within the gateway timeout period.',
    whatHappened: [
      `HTTP ${code} was returned by a proxy layer between the frontend and backend.`,
      'This typically only happens in production/staging with a reverse proxy configured.',
      'In local development with direct port access, this error should not occur.',
    ],
    possibleCauses: code === '504'
      ? ['The backend is taking too long (AI transcription, large file upload).','The nginx proxy_read_timeout is too short (default 60s).','The backend event loop is blocked by a synchronous operation.']
      : ['The backend Node.js process crashed and the proxy has no backend to forward to.','The backend is being restarted / deployed.','Memory or CPU limits have been hit on the server host.'],
    fixSteps: [
      { step:1, title:'Restart the backend service', command:'# With pm2:\npm2 restart voicemind-backend\n\n# With systemd:\nsudo systemctl restart voicemind', description:'Restart the backend process. The proxy will start forwarding again once it accepts connections.' },
      { step:2, title: code==='504'?'Increase proxy timeout':'Check server resources',
        command: code==='504'?'# nginx config:\nproxy_read_timeout 300s;\nproxy_connect_timeout 300s;':'top\nfree -h',
        description: code==='504'?'Long-running operations like AI transcription need a higher timeout.':'High resource usage can prevent the server from handling requests.',
      },
    ],
    quickChecks: ['Is the backend process running? (pm2 status / systemctl status)', 'Does the proxy log show a "connect() failed" or "upstream timed out" message?'],
  };
});

/* ═══════════════════════════════════════════════════
   Severity styling
   ═══════════════════════════════════════════════════ */
const SEV = {
  warning: { badge:'border-amber-500/30 bg-amber-500/10 text-amber-200', icon:'text-amber-400', bar:'bg-amber-500', label:'Warning' },
  critical:{ badge:'border-red-500/30 bg-red-500/10 text-red-200',       icon:'text-red-400',   bar:'bg-red-500',   label:'Critical' },
  success: { badge:'border-emerald-500/30 bg-emerald-500/10 text-emerald-200', icon:'text-emerald-400', bar:'bg-emerald-500', label:'Resolved' },
  info:    { badge:'border-sky-500/30 bg-sky-500/10 text-sky-200',       icon:'text-sky-400',   bar:'bg-sky-500',   label:'Info' },
};

const CodeBlock = ({ code }) => (
  <pre className="mt-3 overflow-x-auto rounded-xl border border-white/8 bg-slate-950 px-4 py-3 text-xs leading-6 text-emerald-300 font-mono">
    <code>{code}</code>
  </pre>
);

/* ═══════════════════════════════════════════════════
   Main page
   ═══════════════════════════════════════════════════ */
const SystemHealthPage = () => {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  const errorKey   = searchParams.get('error')   || 'network-error';
  const errorTitle = searchParams.get('title')   || '';
  const errorMsg   = searchParams.get('message') || '';

  const notifications = useSelector(s => s.notifications?.items || []);

  /* Match live notification data to show real backend message */
  const matchedNotif = useMemo(() => {
    if (!notifications.length) return null;
    return (
      notifications.find(n => (n.dedupeKey || '') === errorKey) ||
      notifications.find(n => n.type === 'system' && n.severity !== 'info') ||
      null
    );
  }, [notifications, errorKey]);

  const guide = useMemo(() => {
    if (ERROR_GUIDES[errorKey]) return ERROR_GUIDES[errorKey];

    /* Dynamic fallback — build guide from notification data or URL params */
    const title =
      errorTitle ||
      matchedNotif?.title ||
      errorKey.replace(/-/g,' ').replace(/\b\w/g, c => c.toUpperCase());
    const message =
      errorMsg ||
      matchedNotif?.message ||
      'A system error was reported. Check the backend logs for more details.';
    const sev = matchedNotif?.severity === 'critical' ? 'critical' : 'warning';

    return {
      icon: AlertTriangle, severity: sev, title, summary: message,
      whatHappened: [
        'The system reported an error without a specific fix guide entry.',
        'The full error details are shown above.',
        'Check the backend console/logs for the root cause.',
      ],
      possibleCauses: [
        'A service (backend, transcription, database) is offline or misconfigured.',
        'An unexpected runtime error occurred in the server.',
        'A network or connectivity issue is preventing communication.',
      ],
      fixSteps: [
        { step:1, title:'Check backend logs', command:'npm run dev\n# or\npm2 logs voicemind-backend', description:'The backend console shows the exact error with a stack trace.' },
        { step:2, title:'Verify all services are running', command:'# Node.js backend\nnpm run dev\n\n# Python transcription\npython main.py\n\n# MongoDB\nmongod --dbpath ./data/db', description:'Ensure all three services (Node, Python Whisper, MongoDB) are running.' },
        { step:3, title:'Check Python service health', command:'curl http://localhost:8001/health', description:'The Whisper service should return {"status":"ok","modelLoaded":true}.' },
        { step:4, title:'Reload the application', command:null, description:'After fixing the underlying issue, reload the app. The notification stream reconnects automatically.' },
      ],
      quickChecks: [
        'Is the backend terminal showing any crash or error?',
        'Does http://localhost:5001/api/health respond?',
        'Is the Python transcription service running on port 8001?',
      ],
    };
  }, [errorKey, errorTitle, errorMsg, matchedNotif]);

  const sev = SEV[guide.severity] || SEV.warning;
  const Icon = guide.icon;

  return (
    <AppShell>
      <div className="min-h-full px-4 pb-12 pt-6 sm:px-6 sm:pt-8 lg:px-8">
        <div className="mx-auto max-w-4xl space-y-5">

          {/* Back */}
          <button onClick={() => navigate(-1)}
            className="inline-flex items-center gap-2 text-sm text-slate-400 transition hover:text-white"
          >
            <ArrowLeft className="h-4 w-4" /> Back
          </button>

          {/* Live notification banner */}
          {matchedNotif && (
            <div className="rounded-2xl border border-sky-500/20 bg-sky-500/5 px-5 py-4">
              <div className="flex items-start gap-3">
                <Info className="mt-0.5 h-4 w-4 shrink-0 text-sky-400" />
                <div>
                  <p className="text-sm font-semibold text-sky-200">Live error from notification stream</p>
                  <p className="mt-1 text-xs leading-5 text-slate-400">
                    <span className="font-semibold text-slate-300">{matchedNotif.title}</span>
                    {matchedNotif.message ? ` — ${matchedNotif.message}` : ''}
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* Header card */}
          <div className="overflow-hidden rounded-3xl border border-white/8 bg-white/3">
            <div className={`h-1 w-full ${sev.bar}`} />
            <div className="p-6 sm:p-8">
              <div className="mb-4 flex flex-wrap items-center gap-3">
                <span className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-bold uppercase tracking-widest ${sev.badge}`}>
                  {guide.severity === 'success' ? <CheckCircle2 className="h-3.5 w-3.5" /> : <AlertTriangle className="h-3.5 w-3.5" />}
                  {sev.label}
                </span>
                <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-slate-400">System notification</span>
                <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 font-mono text-xs text-slate-500">{errorKey}</span>
              </div>
              <div className="flex items-start gap-4">
                <div className={`mt-1 shrink-0 ${sev.icon}`}><Icon className="h-8 w-8" /></div>
                <div>
                  <h1 className="text-xl font-bold text-white sm:text-2xl">{guide.title}</h1>
                  <p className="mt-2 text-sm leading-7 text-slate-300">{guide.summary}</p>
                </div>
              </div>
            </div>
          </div>

          {/* What happened */}
          <div className="rounded-3xl border border-white/8 bg-white/3 p-6 sm:p-8">
            <h2 className="mb-4 flex items-center gap-2 text-sm font-bold text-white">
              <Clock className="h-4 w-4 text-sky-400" /> What happened
            </h2>
            <ol className="space-y-2">
              {guide.whatHappened.map((step,i) => (
                <li key={i} className="flex items-start gap-3 text-sm text-slate-300">
                  <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-sky-500/30 bg-sky-500/10 text-[11px] font-bold text-sky-300">{i+1}</span>
                  {step}
                </li>
              ))}
            </ol>
          </div>

          {/* Possible causes */}
          <div className="rounded-3xl border border-white/8 bg-white/3 p-6 sm:p-8">
            <h2 className="mb-4 flex items-center gap-2 text-sm font-bold text-white">
              <AlertTriangle className="h-4 w-4 text-amber-400" /> Possible causes
            </h2>
            <ul className="space-y-2">
              {guide.possibleCauses.map((cause,i) => (
                <li key={i} className="flex items-start gap-3 text-sm text-slate-300">
                  <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" />
                  {cause}
                </li>
              ))}
            </ul>
          </div>

          {/* Fix steps */}
          <div className="rounded-3xl border border-white/8 bg-white/3 p-6 sm:p-8">
            <h2 className="mb-6 flex items-center gap-2 text-sm font-bold text-white">
              <Terminal className="h-4 w-4 text-emerald-400" /> How to fix — step by step
            </h2>
            <div className="space-y-4">
              {guide.fixSteps.map(({ step, title, command, description }) => (
                <div key={step} className="rounded-2xl border border-white/8 bg-white/3 p-5">
                  <div className="mb-2 flex items-center gap-3">
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary-500/20 text-xs font-bold text-primary-300">{step}</span>
                    <h3 className="text-sm font-semibold text-white">{title}</h3>
                  </div>
                  <p className="ml-10 text-sm leading-6 text-slate-400">{description}</p>
                  {command && <div className="ml-10"><CodeBlock code={command} /></div>}
                </div>
              ))}
            </div>
          </div>

          {/* Quick checks */}
          <div className="rounded-3xl border border-white/8 bg-white/3 p-6 sm:p-8">
            <h2 className="mb-4 flex items-center gap-2 text-sm font-bold text-white">
              <Lightbulb className="h-4 w-4 text-violet-400" /> Quick checks right now
            </h2>
            <ul className="space-y-3">
              {guide.quickChecks.map((check,i) => (
                <li key={i} className="flex items-start gap-3 text-sm text-slate-300">
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-violet-400" />
                  {check}
                </li>
              ))}
            </ul>
          </div>

          {/* Reload */}
          <div className="rounded-3xl border border-white/8 bg-white/3 p-5 sm:p-6">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-sm font-semibold text-white">Ready to try again?</p>
                <p className="mt-1 text-xs text-slate-400">Once you have applied a fix, reload the app. The notification stream reconnects automatically within 5 seconds.</p>
              </div>
              <button onClick={() => window.location.reload()}
                className="inline-flex shrink-0 items-center gap-2 rounded-2xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-white/10"
              >
                <RefreshCw className="h-4 w-4" /> Reload app
              </button>
            </div>
          </div>

        </div>
      </div>
    </AppShell>
  );
};

export default SystemHealthPage;