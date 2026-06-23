// errorHandler.js - Updated to handle aborted requests gracefully
const eventBus = require('../services/eventBus');

const errorHandler = (err, req, res, next) => {
  const error = { ...err };
  error.message = err.message;

  // Handle request aborted errors (client disconnected)
  if (err.type === 'request.aborted' || err.code === 'ECONNABORTED' || err.code === 'ECONNRESET') {
    console.warn(`Client disconnected: ${req.method} ${req.originalUrl} - ${err.message}`);
    // Don't send response, client is already gone
    return;
  }

  // Handle incomplete body errors
  if (err.type === 'entity.too.large' || err.statusCode === 413) {
    return res.status(413).json({
      success: false,
      error: {
        code: 'PAYLOAD_TOO_LARGE',
        message: 'Request body too large'
      }
    });
  }

  // Handle timeout errors
  if (err.code === 'ETIMEDOUT' || err.code === 'ECONNREFUSED') {
    return res.status(504).json({
      success: false,
      error: {
        code: 'GATEWAY_TIMEOUT',
        message: 'Upstream service timeout'
      }
    });
  }

  console.error('Error:', err);

  if (err.name === 'CastError') {
    return res.status(404).json({
      success: false,
      error: {
        code: 'NOT_FOUND',
        message: 'Resource not found'
      }
    });
  }

  if (err.code === 11000) {
    return res.status(400).json({
      success: false,
      error: {
        code: 'DUPLICATE_ERROR',
        message: 'Duplicate field value entered',
        field: Object.keys(err.keyValue || {})
      }
    });
  }

  if (err.name === 'ValidationError') {
    const messages = Object.values(err.errors).map((val) => val.message);
    return res.status(400).json({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: messages.join(', '),
        details: err.errors
      }
    });
  }

  if (err.name === 'JsonWebTokenError') {
    return res.status(401).json({
      success: false,
      error: {
        code: 'INVALID_TOKEN',
        message: 'Invalid token'
      }
    });
  }

  if (err.name === 'TokenExpiredError') {
    return res.status(401).json({
      success: false,
      error: {
        code: 'TOKEN_EXPIRED',
        message: 'Token expired'
      }
    });
  }

  const statusCode = err.statusCode || 500;
  // Emit a system notification for unexpected 500 errors
  if (statusCode >= 500) {
    try {
      eventBus.emit('server_error', {
        title: 'Server error',
        message: `An unexpected server error occurred (${statusCode}): ${error.message || 'Unknown error'}`,
        dedupeKey: `server-error-${statusCode}`,
      });
    } catch (_) {}
  }

  res.status(statusCode).json({
    success: false,
    error: {
      code: err.code || 'SERVER_ERROR',
      message: error.message || 'Server Error'
    }
  });
};

module.exports = errorHandler;