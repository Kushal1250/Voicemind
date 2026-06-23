'use strict';
/**
 * test_db.js — verification script for src/config/db.js v2 (Phase 3 fix).
 *
 * Run with:  node scripts/test_db.js
 *
 * No real MongoDB is used. Instead:
 *  - mongoose.connect / mongoose.disconnect are spied (counted, and
 *    optionally made to resolve/reject) so we can verify HOW MANY TIMES
 *    they're called in each scenario.
 *  - mongoose.connection.readyState is set directly, which (per
 *    Connection.prototype.readyState's setter) emits the real
 *    'connected'/'disconnected'/'connecting'/'reconnected' events — this
 *    drives db.js's event handlers exactly as the real driver would.
 *
 * What this proves:
 *   A. Initial connect retries with exponential backoff and gives up cleanly
 *      if MongoDB never comes up (no infinite retry storm).
 *   B. forceReconnect() lets an operator manually recover the connection.
 *   C. THE CORE FIX — when the driver's own SDAM monitor emits
 *      'disconnected' -> 'reconnected' on its own (a normal blip), db.js
 *      does NOT call mongoose.connect()/disconnect() again. This is what
 *      eliminates the "connected -> disconnected -> reconnected -> connected"
 *      loop from the original bug report.
 *   D. A transient 'error' event (e.g. ECONNRESET on one query) does not
 *      tear down a healthy connection.
 *   E. The long-interval "stall safety net" fires at most once per
 *      MONGO_STALL_RECONNECT_MS, not on every heartbeat.
 */

process.env.ALLOW_START_WITHOUT_MONGO = 'true';
process.env.MONGO_MAX_RETRIES         = '2';
process.env.MONGO_INITIAL_RETRY_MS    = '30';
process.env.MONGO_MAX_RETRY_MS        = '60';
process.env.MONGO_HEARTBEAT_MS        = '40';
process.env.MONGO_STALL_RECONNECT_MS  = '150';

const mongoose = require('mongoose');
const db = require('../src/config/db');

let connectCalls    = 0;
let disconnectCalls = 0;
let connectBehavior = 'reject'; // 'reject' | 'resolve'

mongoose.connect = async () => {
  connectCalls += 1;
  if (connectBehavior === 'reject') {
    const err = new Error('connect ECONNREFUSED 127.0.0.1:27017');
    err.code  = 'ECONNREFUSED';
    throw err;
  }
  // Simulate a successful connect: driver sets readyState -> 1 ('connected')
  mongoose.connection.readyState = 1;
  Object.defineProperty(mongoose.connection, 'host', { value: '127.0.0.1', configurable: true });
  Object.defineProperty(mongoose.connection, 'name', { value: 'voicemind', configurable: true });
  // db.admin().ping() is used by the heartbeat — stub it out.
  mongoose.connection.db = { admin: () => ({ ping: async () => ({ ok: 1 }) }) };
  return mongoose.connection;
};

mongoose.disconnect = async () => {
  disconnectCalls += 1;
  mongoose.connection.readyState = 0;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log('='.repeat(70));
  console.log('Phase A — initial connect fails repeatedly (MongoDB not up yet)');
  connectBehavior = 'reject';
  const ok = await db.connectDB();
  console.log('connectDB() returned:', ok, '(expected: false)');
  await sleep(400); // let all scheduled retries fire
  console.log('mongoose.connect call count:', connectCalls, `(expected: ${1 + Number(process.env.MONGO_MAX_RETRIES)} = 1 initial + MAX_RETRIES retries)`);
  console.log('isConnected():', db.isConnected(), '(expected: false)');
  console.log('status:', db.getConnectionStatus());

  console.log('='.repeat(70));
  console.log('Phase B — MongoDB comes up; manual forceReconnect() succeeds');
  connectBehavior = 'resolve';
  const beforeConnect = connectCalls;
  const status = await db.forceReconnect();
  console.log('forceReconnect() status:', status);
  console.log('isConnected():', db.isConnected(), '(expected: true)');
  console.log('mongoose.connect calls during forceReconnect:', connectCalls - beforeConnect, '(expected: 1)');

  console.log('='.repeat(70));
  console.log('Phase C — driver SDAM emits disconnected/reconnected on its own');
  console.log('         (THE BUG: v1 would call mongoose.connect()/disconnect() here)');
  const connectBefore    = connectCalls;
  const disconnectBefore = disconnectCalls;

  // Simulate a brief blip the driver recovers from BY ITSELF, well under
  // the stall-safety-net threshold (150ms).
  mongoose.connection.readyState = 0; // 'disconnected' event fires
  await sleep(50);
  mongoose.connection.readyState = 1; // back to connected -> 'connected' fires
  mongoose.connection.emit('reconnected'); // driver's own recovery signal
  await sleep(50);

  console.log('mongoose.connect calls during blip:', connectCalls - connectBefore, '(expected: 0 — driver handles it, db.js only logs)');
  console.log('mongoose.disconnect calls during blip:', disconnectCalls - disconnectBefore, '(expected: 0)');
  console.log('isConnected():', db.isConnected(), '(expected: true)');

  console.log('='.repeat(70));
  console.log('Phase D — error event fires while still connected (transient op error)');
  const connectBefore2 = connectCalls;
  mongoose.connection.emit('error', Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }));
  await sleep(20);
  console.log('mongoose.connect calls after error event:', connectCalls - connectBefore2, '(expected: 0)');
  console.log('isConnected():', db.isConnected(), '(expected: true — error event did not disconnect us)');
  console.log('lastError in status:', db.getConnectionStatus().lastError);

  console.log('='.repeat(70));
  console.log('Phase E — LONG outage triggers the stall safety net exactly once');
  connectBehavior = 'reject'; // safety-net reconnect attempt itself fails (mongo still down)
  const connectBefore3    = connectCalls;
  const disconnectBefore3 = disconnectCalls;
  mongoose.connection.readyState = 0; // disconnected, starts the clock
  await sleep(250); // > STALL_RECONNECT_MS (150) + one heartbeat (40)
  console.log('mongoose.disconnect calls (safety net):', disconnectCalls - disconnectBefore3, '(expected: 0 — already disconnected, no redundant disconnect() call)');
  console.log('mongoose.connect calls (safety net retry):', connectCalls - connectBefore3, '(expected: 1 — exactly one direct attempt per stall period)');
  console.log('status:', db.getConnectionStatus());

  console.log('='.repeat(70));
  console.log('ALL DB TESTS COMPLETED');
  process.exit(0);
})().catch((err) => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
