export class AppError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status = 500,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
    Error.captureStackTrace?.(this, new.target);
  }
}

export class QueryError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, "QUERY_ERROR", 400, details);
  }
}

export class RoutingError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, "ROUTING_ERROR", 503, details);
  }
}

export class AIError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, "AI_ERROR", 502, details);
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, "VALIDATION_ERROR", 422, details);
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Not found") {
    super(message, "NOT_FOUND", 404);
  }
}

export const isAppError = (error: unknown): error is AppError => error instanceof AppError;
