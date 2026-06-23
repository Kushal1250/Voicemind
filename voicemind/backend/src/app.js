const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');
const eventBus = require('./services/eventBus');
const {
  AUDIO_STORAGE_FOLDERS,
  getProjectRootDirectory,
  getLegacyUploadsRootDirectory,
  ensureDirectoryExists,
} = require('./utils/languageSupport');

const app = express();
const projectRoot = getProjectRootDirectory();
const legacyUploadsRoot = getLegacyUploadsRootDirectory();

app.use(
  helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' }
  })
);

app.use(
  cors({
    origin: process.env.CORS_ORIGIN || 'http://localhost:3000',
    credentials: true
  })
);

app.use(
  '/api/',
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 1000
  })
);

const jsonParser = express.json({
  limit: '10mb',
  strict: false,
});

const urlEncodedParser = express.urlencoded({ extended: true, limit: '10mb' });

app.use((req, res, next) => {
  const contentType = req.headers['content-type'] || '';
  const isRawChunkUpload =
    req.method === 'POST' &&
    /^\/api\/meetings\/[^/]+\/chunks/.test(req.path) &&
    (contentType.includes('audio/wav') || contentType.includes('application/octet-stream'));

  if (isRawChunkUpload) {
    return next();
  }

  jsonParser(req, res, (jsonErr) => {
    if (jsonErr) return next(jsonErr);
    urlEncodedParser(req, res, next);
  });
});

for (const folderName of AUDIO_STORAGE_FOLDERS) {
  const folderPath = path.join(projectRoot, folderName);
  ensureDirectoryExists(folderPath);
  app.use(`/${folderName}`, express.static(folderPath));
  app.use(`/uploads/${folderName}`, express.static(folderPath));
}

ensureDirectoryExists(legacyUploadsRoot);
app.use('/uploads', express.static(legacyUploadsRoot));

app.get('/health', (req, res) => {
  res.json({
    success: true,
    status: 'ok',
    timestamp: new Date().toISOString()
  });
});

app.get('/api/health', async (req, res) => {
  res.status(200).json({
    success: true,
    server: 'ok',
    database: 'connected'
  });
});

app.get('/api/test', (req, res) => {
  res.json({
    success: true,
    message: 'VoiceMind backend connectivity test successful!',
    timestamp: new Date().toISOString(),
    yourIP: req.ip
  });
});

app.use('/api/auth', require('./routes/auth.routes'));
app.use('/api/meetings', require('./routes/meetings.routes'));
app.use('/api/devices', require('./routes/devices.routes'));
app.use('/api/transcripts', require('./routes/transcripts.routes'));
app.use('/api/analytics', require('./routes/analytics.routes'));
app.use('/api/notifications', require('./routes/notifications.routes'));
app.use('/api/system', require('./routes/system.routes'));
app.use('/api/events', require('./routes/events.routes'));
app.use('/api', require('./routes/qa.routes'));

app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: {
      code: 'NOT_FOUND',
      message: 'Route not found'
    }
  });
});

app.use((err, req, res, next) => {
  console.error('❌ Error:', err);

  const status = err.status || 500;
  const code = err.code || `server-error-${status}`;
  const message = err.message || 'Internal server error';

  if (status >= 400) {
    eventBus.emit('server_error', {
      code,
      status,
      title: status >= 500 ? 'Backend request failed' : 'Request error',
      message,
      path: req.originalUrl || req.path,
      source: 'backend',
      meetingId: req.params?.id || req.body?.meetingId || null,
      deviceId: req.headers['x-device-id'] || req.body?.deviceId || null,
      dedupeKey: `${code}:${req.originalUrl || req.path}`,
    });
  }

  res.status(status).json({
    success: false,
    error: {
      code,
      message
    }
  });
});

module.exports = app;
