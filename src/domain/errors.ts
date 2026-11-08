export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export class ProviderTimeoutError extends Error {
  constructor(message = 'Payment provider response timed out') {
    super(message);
    this.name = 'ProviderTimeoutError';
  }
}

export class ProviderIdempotencyConflictError extends Error {
  constructor() {
    super('Provider idempotency key was reused with different payment data');
    this.name = 'ProviderIdempotencyConflictError';
  }
}
