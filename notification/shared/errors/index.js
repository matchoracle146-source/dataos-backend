// ─── DataOS Custom Error Classes ─────────────────────────────────────────────

class AppError extends Error {
  constructor(message, statusCode, code, details = null) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }
}

class ValidationError extends AppError {
  constructor(message, details) {
    super(message, 422, 'VALIDATION_ERROR', details);
  }
}

class AuthenticationError extends AppError {
  constructor(message = 'Authentication required') {
    super(message, 401, 'AUTHENTICATION_REQUIRED');
  }
}

class AuthorizationError extends AppError {
  constructor(message = 'Insufficient permissions') {
    super(message, 403, 'AUTHORIZATION_FAILED');
  }
}

class NotFoundError extends AppError {
  constructor(resource = 'Resource') {
    super(`${resource} not found`, 404, 'NOT_FOUND');
  }
}

class ConflictError extends AppError {
  constructor(message) {
    super(message, 409, 'CONFLICT');
  }
}

class RateLimitError extends AppError {
  constructor(retryAfter = 60) {
    super('Rate limit exceeded', 429, 'RATE_LIMIT_EXCEEDED', { retryAfter });
  }
}

class TelecomError extends AppError {
  constructor(network, method, message) {
    super(message, 503, 'TELECOM_UNAVAILABLE', { network, method });
  }
}

class InsufficientBalanceError extends AppError {
  constructor(required, available, currency = 'NGN') {
    super('Insufficient balance', 402, 'INSUFFICIENT_BALANCE', { required, available, currency });
  }
}

class FraudDetectedError extends AppError {
  constructor(reason) {
    super('Transaction blocked by security system', 403, 'FRAUD_DETECTED', { reason });
  }
}

class KYCRequiredError extends AppError {
  constructor(requiredLevel) {
    super(`KYC level ${requiredLevel} required for this action`, 403, 'KYC_REQUIRED', { requiredLevel });
  }
}

// Global error handler for Fastify
const globalErrorHandler = (error, request, reply) => {
  const requestId = request.headers['x-request-id'] || 'unknown';

  // Log error
  if (!error.isOperational) {
    request.log.error({ err: error, requestId }, 'Unhandled error');
  } else {
    request.log.warn({ err: error, requestId }, 'Operational error');
  }

  // Sanitize error for response (never leak internals)
  const statusCode = error.statusCode || 500;
  const response = {
    success: false,
    error: {
      code: error.code || 'INTERNAL_ERROR',
      message: error.isOperational ? error.message : 'An unexpected error occurred',
      ...(error.details && { details: error.details }),
    },
    meta: { requestId, timestamp: new Date().toISOString() },
  };

  reply.status(statusCode).send(response);
};

module.exports = {
  AppError,
  ValidationError,
  AuthenticationError,
  AuthorizationError,
  NotFoundError,
  ConflictError,
  RateLimitError,
  TelecomError,
  InsufficientBalanceError,
  FraudDetectedError,
  KYCRequiredError,
  globalErrorHandler,
};
