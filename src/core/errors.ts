export type AppErrorCode =
  | 'validation_failed'
  | 'route_not_allowed'
  | 'storage_failed'
  | 'connector_failed'
  | 'research_limit_reached'
  | 'configuration_failed';

export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly cause?: unknown;

  constructor(code: AppErrorCode, message: string, options: { cause?: unknown } = {}) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.cause = options.cause;
  }
}
