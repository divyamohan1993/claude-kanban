// Structured JSON logging via pino — replaces all console.log/error usage.
// Correlation IDs propagated via req.id (set by requestId middleware).
// Error/fatal messages auto-persisted to DB error_log table.

const pino = require('pino');

const log = pino({
  level: process.env.LOG_LEVEL || 'info',
  formatters: {
    level(label) { return { level: label }; },
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  hooks: {
    // Intercept log entries — persist error/fatal to DB
    logMethod(inputArgs, method) {
      if (method === 'error' || method === 'fatal') {
        try {
          // Lazy require to avoid circular dependency at module load
          const errors = require('../db').errors;
          const obj = typeof inputArgs[0] === 'object' ? inputArgs[0] : {};
          const msg = typeof inputArgs[0] === 'string' ? inputArgs[0]
            : (typeof inputArgs[1] === 'string' ? inputArgs[1] : 'unknown');
          const source = obj.reqId ? 'request' : (obj.cardId ? 'pipeline' : 'system');
          errors.log(method, source, obj.cardId || null, msg, obj);
        } catch (_) {
          // DB not ready or circular dep — silently skip DB persistence
        }
      }
      return method.apply(this, inputArgs);
    },
  },
});

// Child logger with request correlation ID
function reqLogger(req) {
  return log.child({ reqId: req.id || '-', method: req.method, path: req.path });
}

module.exports = { log: log, reqLogger: reqLogger };
