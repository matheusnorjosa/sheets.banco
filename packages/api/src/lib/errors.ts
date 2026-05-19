export class AppError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    /**
     * Optional structured payload that the global error handler will surface
     * to clients alongside the standard fields. Use this for actionable
     * context like `enable_url` for `accessNotConfigured`.
     */
    public details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Resource not found') {
    super(404, 'NOT_FOUND', message);
    this.name = 'NotFoundError';
  }
}

export class ValidationError extends AppError {
  constructor(message = 'Validation failed') {
    super(400, 'VALIDATION_ERROR', message);
    this.name = 'ValidationError';
  }
}

export class SheetAccessError extends AppError {
  constructor(message = 'Could not access the Google Sheet. Ensure it is shared with the service account.') {
    super(403, 'SHEET_ACCESS_ERROR', message);
    this.name = 'SheetAccessError';
  }
}
