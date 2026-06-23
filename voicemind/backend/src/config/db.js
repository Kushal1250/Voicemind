/**
 * db.js — Production-grade MongoDB Connection Manager
 * =====================================================
 * Root-cause fixes for random ECONNREFUSED / MongoServerSelectionError crashes:
 *
 *  Problem 1 — No auto-reconnect:
 *    Old code threw on first failure with no retry mechanism. Any transient
 *    MongoDB blip (restart, network hiccup) permanently broke the backend.
 *
 *  Problem 2 — No reconnect event handling:
 *    Mongoose fires 'disconnected' / 'error' events but old code never listened.
 *    Once the pool broke, every subsequent Mongoose operation buffered forever
 *    → "Mongoose buffering timeout" errors.
 *
 *  Problem 3 — Single connection attempt with ALLOW_START_WITHOUT_MONGO=true:
 *    The backend started without MongoDB, services initialized against a broken
 *    pool, then every DB call failed silently or with ECONNREFUSED.
 *
 *  Problem 4 — No heartbeat:
 *    Network firewalls silently drop idle TCP connections. Without periodic
 *    pings the driver kept a "connected" state against a dead socket.
 *
 * Solution:
 *  - Exponential-backoff retry (up to MAX_RETRIES) on initial connect
 *  - Mongoose event listeners trigger reconnect on any disconnect/error
 *  - Periodic heartbeat ping detects stale connections proactively
 *  - Single-instance singleton — never more than one Mongoose connection
 *  - Exported helpers: isConnected(), requireConnection(), getConnectionStatus()
 */

'use strict';

const mongoose = require('mongoose');

// ─── Configuration ────────────────────────────────────────────────────────────
const MONGO_URI          = process.env.MONGO_URI          || 'mongodb://127.0.0.1:27017/voicemind';
const ALLOW_WITHOUT_MONGO = String(process.env.ALLOW_START_WITHOUT_MONGO || 'false').toLowerCase() === 'true';
const MAX_RETRIES        = parseInt(process.env.MONGO_MAX_RETRIES      || '10', 10);
const INITIAL_RETRY_MS   = parseInt(process.env.MONGO_INITIAL_RETRY_MS || '1000', 10);
const MAX_RETRY_MS       = parseInt(process.env.MONGO_MAX_RETRY_MS     || '30000', 10);
const HEARTBEAT_MS       = parseInt(process.env.MONGO_HEARTBEAT_MS     || '30000', 10);

// ─── Mongoose connection options ──────────────────────────────────────────────
const CONNECT_OPTIONS = {
  serverSelectionTimeoutMS: 10000,   // Give up selecting a server after 10 s
  socketTimeoutMS:          45000,   // Kill idle sockets after 45 s
  connectTimeoutMS:         10000,   // TCP connect timeout
  heartbeatFrequencyMS:     10000,   // Driver-level heartbeat
  maxPoolSize:              10,      // Max concurrent connections
  minPoolSize:              2,       // Keep 2 warm connections alive
  maxIdleTimeMS:            60000,   // Close idle connections after 60 s
};

// ─── Internal state ───────────────────────────────────────────────────────────
let _retryCount       = 0;
let _isConnecting     = false;
let _retryTimer       = null;
let _heartbeatTimer   = null;
let _lastError        = null;

// ─── Logging ──────────────────────────────────────────────────────────────────
function _log(level, message, extra = '') {
  const ts  = new Date().toISOString();
  const pfx = level === 'error' ? '❌' : level === 'warn' ? '⚠️' : '📦';
  const out = `${ts} ${pfx} [MongoDB] ${message}${extra ? ` — ${extra}` : ''}`;
  // eslint-disable-next-line no-console
  console[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log'](out);
}

// ─── Heartbeat ────────────────────────────────────────────────────────────────
function _startHeartbeat() {
  _stopHeartbeat();
  _heartbeatTimer = setInterval(async () => {
    if (!isConnected()) {
      _log('warn', 'Heartbeat — connection lost, scheduling reconnect');
      _scheduleReconnect(1000);
      return;
    }
    try {
      await mongoose.connection.db.admin().ping();
    } catch (err) {
      _log('warn', 'Heartbeat ping failed', err.message);
      _scheduleReconnect(1000);
    }
  }, HEARTBEAT_MS);

  // Allow Node.js to exit even if heartbeat is pending
  if (_heartbeatTimer.unref) _heartbeatTimer.unref();
}

function _stopHeartbeat() {
  if (_heartbeatTimer) {
    clearInterval(_heartbeatTimer);
    _heartbeatTimer = null;
  }
}

// ─── Retry scheduler ─────────────────────────────────────────────────────────
function _backoffMs(attempt) {
  const jitter = Math.floor(Math.random() * 500);
  return Math.min(INITIAL_RETRY_MS * Math.pow(2, attempt) + jitter, MAX_RETRY_MS);
}

function _scheduleReconnect(delayMs) {
  if (_retryTimer || _isConnecting || isConnected()) return;
  _retryTimer = setTimeout(async () => {
    _retryTimer = null;
    if (isConnected()) return;
    await _attemptConnect(true);
  }, delayMs);
  if (_retryTimer.unref) _retryTimer.unref();
}

// ─── Core connect logic ───────────────────────────────────────────────────────
async function _attemptConnect(isRetry = false) {
  if (_isConnecting || isConnected()) return;
  _isConnecting = true;

  try {
    if (isRetry) {
      _log('info', `Reconnect attempt ${_retryCount + 1} / ${MAX_RETRIES} …`);
    }

    // Ensure clean state before reconnecting
    const state = mongoose.connection.readyState;
    if (state !== 0 /* disconnected */) {
      try { await mongoose.disconnect(); } catch (_) {}
    }

    await mongoose.connect(MONGO_URI, CONNECT_OPTIONS);

    _retryCount   = 0;
    _lastError    = null;
    _isConnecting = false;

    _log('info', `Connected to ${mongoose.connection.host} / ${mongoose.connection.name}`);
    _startHeartbeat();
    return true;

  } catch (error) {
    _isConnecting = false;
    _lastError    = error;
    _retryCount++;

    _log('error', `Connection failed (attempt ${_retryCount})`, error.message);

    if (_retryCount <= MAX_RETRIES) {
      const delay = _backoffMs(_retryCount);
      _log('info', `Retrying in ${(delay / 1000).toFixed(1)} s …`);
      _scheduleReconnect(delay);
    } else {
      _log('error', `Max retries (${MAX_RETRIES}) exhausted — operating in degraded mode`);
      if (!ALLOW_WITHOUT_MONGO) throw error;
    }
    return false;
  }
}

// ─── Mongoose connection events ───────────────────────────────────────────────
mongoose.connection.on('connected', () => {
  _retryCount = 0;
  _log('info', 'Event: connected');
});

mongoose.connection.on('disconnected', () => {
  _stopHeartbeat();
  _log('warn', 'Event: disconnected — scheduling reconnect');
  _scheduleReconnect(_backoffMs(_retryCount));
});

mongoose.connection.on('reconnected', () => {
  _retryCount = 0;
  _log('info', 'Event: reconnected');
  _startHeartbeat();
});

mongoose.connection.on('error', (err) => {
  _log('error', 'Event: error', err.message);
  if (
    err.name === 'MongoNetworkError' ||
    err.code === 'ECONNREFUSED' ||
    err.code === 'ECONNRESET'   ||
    err.code === 'ETIMEDOUT'
  ) {
    _scheduleReconnect(_backoffMs(_retryCount));
  }
});

mongoose.connection.on('close', () => {
  _stopHeartbeat();
  _log('warn', 'Event: connection closed');
});

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * connectDB()
 * Called once at startup. Attempts the first connect; if it fails and
 * ALLOW_START_WITHOUT_MONGO=true the server starts anyway and retries
 * in the background.
 */
async function connectDB() {
  _retryCount = 0;
  try {
    const ok = await _attemptConnect(false);
    if (!ok && ALLOW_WITHOUT_MONGO) {
      _log('warn', 'Starting without MongoDB — background retry is active');
    }
    return ok;
  } catch (error) {
    if (ALLOW_WITHOUT_MONGO) {
      _log('warn', 'Starting without MongoDB (ALLOW_START_WITHOUT_MONGO=true)');
      return false;
    }
    throw error;
  }
}

/**
 * isConnected()
 * Fast synchronous check — readyState 1 = fully connected.
 */
function isConnected() {
  return mongoose.connection.readyState === 1;
}

/**
 * requireConnection()
 * Throws a 503-friendly error if MongoDB is not ready.
 * Use inside route handlers that absolutely need the DB.
 */
function requireConnection() {
  if (!isConnected()) {
    const err = new Error('Database connection is not available');
    err.code   = 'DB_NOT_CONNECTED';
    err.status = 503;
    throw err;
  }
}

/**
 * getConnectionStatus()
 * Returns a plain object safe to embed in /api/health responses.
 */
function getConnectionStatus() {
  const STATES = ['disconnected', 'connected', 'connecting', 'disconnecting'];
  return {
    state:       STATES[mongoose.connection.readyState] || 'unknown',
    readyState:  mongoose.connection.readyState,
    isConnected: isConnected(),
    host:        mongoose.connection.host  || null,
    dbName:      mongoose.connection.name  || null,
    retryCount:  _retryCount,
    lastError:   _lastError ? _lastError.message : null,
  };
}

/**
 * gracefulDisconnect()
 * Called during SIGINT / SIGTERM. Cancels timers then closes Mongoose.
 */
async function gracefulDisconnect() {
  _stopHeartbeat();
  if (_retryTimer) {
    clearTimeout(_retryTimer);
    _retryTimer = null;
  }
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
    _log('info', 'Gracefully disconnected');
  }
}

module.exports = {
  connectDB,
  isConnected,
  requireConnection,
  getConnectionStatus,
  gracefulDisconnect,
};
