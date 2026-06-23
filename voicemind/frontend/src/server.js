/**
 * server.js — Production-Grade Server Entry Point
 * =================================================
 * Root-cause fixes for random backend crashes:
 *
 *  Problem 1 — No global error handlers:
 *    Unhandled promise rejections and uncaught exceptions silently killed
 *    the Node.js process.  Added process.on('uncaughtException') and
 *    process.on('unhandledRejection') so non-fatal errors are logged and
 *    only truly fatal errors cause a controlled exit.
 *
 *  Problem 2 — No structured logging:
 *    console.log/error calls gave no timestamp, module, or correlation ID,
 *    making crash post-mortems impossible. Replaced with structured JSON logs.
 *
 *  Problem 3 — Broken startup order:
 *    Services (notifications, device jobs) initialized before MongoDB was
 *    confirmed connected. Now startup is sequential and failures are caught.
 *
 *  Problem 4 — No SIGPIPE handler:
 *    SSE/streaming clients that disconnect mid-stream caused EPIPE which
 *    crashed the process on some Node.js versions. Now ignored.
 */

'use strict';

require('dotenv').config();

const path = require('path');
const app  = require('./app');

const { connectDB, gracefulDisconnect, getConnectionStatus } = require('./config/db');
const { startDeviceOfflineJob }    = require('./jobs/deviceOffline.job');
const { initNotificationPublisher } = require('./services/notificationPublisher.service');
const {
  AUDIO_STORAGE_FOLDERS,
  getProjectRootDirectory,
  getLegacyUploadsRootDirectory,
  ensureDirectoryExists,
} = require('./utils/languageSupport');

// ─── Config ───────────────────────────────────────────────────────────────────
const PORT        = parseInt(process.env.PORT || '5001', 10);
const HOST        = process.env.HOST          || '0.0.0.0';
const PROJECT_ROOT    = getProjectRootDirectory();
const LEGACY_UPLOAD_DIR = getLegacyUploadsRootDirectory();

// ─── Runtime state ────────────────────────────────────────────────────────────
let server              = null;
let stopDeviceOfflineJob = null;
let isShuttingDown      = false;

// ─── Structured logger ────────────────────────────────────────────────────────
function slog(level, module, message, extra = null) {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    module,
    message,
    ...(extra
      ? typeof extra === 'object'
        ? extra
        : { detail: extra }
      : {}),
  };
  // eslint-disable-next-line no-console
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  fn(JSON.stringify(entry));
}

// ─── Global error handlers ────────────────────────────────────────────────────

/**
 * Uncaught synchronous exceptions.
 * Non-fatal network errors (ECONNRESET etc.) are logged but NOT crashed.
 * All other unknown exceptions trigger a graceful shutdown.
 */
process.on('uncaughtException', (error, origin) => {
  slog('error', 'process', 'Uncaught Exception', {
    errorType: error.name,
    message:   error.message,
    code:      error.code || null,
    stack:     error.stack,
    origin,
  });

  // Non-fatal network errors — log and continue
  const SAFE_CODES = ['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'EHOSTUNREACH'];
  if (SAFE_CODES.includes(error.code)) {
    slog('warn', 'process', 'Non-fatal network error — continuing', { code: error.code });
    return;
  }

  // Unknown / fatal — initiate controlled exit
  slog('error', 'process', 'Fatal uncaught exception — initiating shutdown');
  gracefulShutdown('UNCAUGHT_EXCEPTION').finally(() => process.exit(1));
});

/**
 * Unhandled promise rejections.
 * Node.js will soon make these fatal by default; we log them and continue
 * rather than crashing so that background tasks can survive transient DB errors.
 */
process.on('unhandledRejection', (reason) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  const stack   = reason instanceof Error ? reason.stack   : undefined;

  slog('error', 'process', 'Unhandled Promise Rejection — logged, not crashing', {
    message,
    stack,
  });
  // Intentionally NOT calling process.exit() here — transient DB / network
  // rejections should not kill the server.
});

/**
 * SIGPIPE — triggered when a client (SSE/streaming) disconnects mid-response.
 * Ignoring this prevents the process from crashing on write-to-closed-socket.
 */
process.on('SIGPIPE', () => {
  // Intentionally ignored — broken pipe is normal for SSE clients
});

/**
 * Node.js internal warnings (deprecations, memory, etc.)
 */
process.on('warning', (w) => {
  slog('warn', 'process', 'Node.js warning', {
    name:    w.name,
    message: w.message,
    code:    w.code || null,
  });
});

// ─── Graceful shutdown ────────────────────────────────────────────────────────
async function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  slog('info', 'server', `${signal} — initiating graceful shutdown`);

  // 1. Stop background jobs first (avoids new DB writes)
  if (typeof stopDeviceOfflineJob === 'function') {
    try {
      stopDeviceOfflineJob();
      slog('info', 'server', 'Device offline job stopped');
    } catch (err) {
      slog('warn', 'server', 'Failed to stop device offline job', { error: err.message });
    }
  }

  // 2. Stop accepting new HTTP connections
  await new Promise((resolve) => {
    if (!server) return resolve();
    server.close((err) => {
      if (err) slog('warn', 'server', 'Error closing HTTP server', { error: err.message });
      else     slog('info', 'server', 'HTTP server closed');
      resolve();
    });
    // Force-close after 15 s in case connections are long-lived (SSE)
    const force = setTimeout(resolve, 15_000);
    if (force.unref) force.unref();
  });

  // 3. Disconnect from MongoDB
  try {
    await gracefulDisconnect();
  } catch (err) {
    slog('warn', 'server', 'MongoDB disconnect error', { error: err.message });
  }

  slog('info', 'server', 'Shutdown complete');
}

// ─── Signal handlers ──────────────────────────────────────────────────────────
process.on('SIGINT',  () => gracefulShutdown('SIGINT').then(() => process.exit(0)));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM').then(() => process.exit(0)));

// ─── Startup sequence ─────────────────────────────────────────────────────────
async function start() {
  try {
    slog('info', 'server', 'Starting VoiceMind backend …');

    // Ensure upload directories exist
    ensureDirectoryExists(LEGACY_UPLOAD_DIR);
    for (const folder of AUDIO_STORAGE_FOLDERS) {
      ensureDirectoryExists(path.join(PROJECT_ROOT, folder));
    }

    // 1. Connect to MongoDB (built-in retry + reconnect)
    await connectDB();
    slog('info', 'server', 'MongoDB ready', getConnectionStatus());

    // 2. Initialize notification publisher (depends on DB)
    initNotificationPublisher();
    slog('info', 'server', 'Notification publisher initialized');

    // 3. Start background cron jobs
    stopDeviceOfflineJob = startDeviceOfflineJob();
    slog('info', 'server', 'Device offline job started');

    // 4. Bind HTTP server
    server = app.listen(PORT, HOST, () => {
      slog('info', 'server', 'VoiceMind backend ready', {
        url:                 `http://${HOST}:${PORT}`,
        projectRoot:         PROJECT_ROOT,
        transcriptionService: process.env.TRANSCRIBE_API_URL || 'http://127.0.0.1:8001',
        qaService:           process.env.QA_API_URL           || 'http://127.0.0.1:8002',
        mongoStatus:         getConnectionStatus(),
        nodeVersion:         process.version,
        env:                 process.env.NODE_ENV || 'development',
      });
    });

    // Handle HTTP server-level errors (e.g., port already in use)
    server.on('error', (err) => {
      slog('error', 'server', 'HTTP server error', { code: err.code, message: err.message });
      if (err.code === 'EADDRINUSE') {
        slog('error', 'server', `Port ${PORT} is already in use — exiting`);
        process.exit(1);
      }
    });

    // Increase default keep-alive timeout to survive load balancers
    server.keepAliveTimeout = 65_000;
    server.headersTimeout   = 66_000;

  } catch (error) {
    slog('error', 'server', 'Failed to start VoiceMind backend', {
      message: error.message,
      stack:   error.stack,
    });
    process.exit(1);
  }
}

start();
