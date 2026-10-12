import type { ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';

// Коды совпадают с ключами error_messages в shared/copy.ru.json — клиент берёт текст оттуда.
export type ErrorCode =
  | 'AUTH_REQUIRED'
  | 'AUTH_INVALID'
  | 'AUTH_EXPIRED'
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'LIMIT_EXCEEDED'
  | 'RESUME_REQUIRED'
  | 'UPSTREAM_UNAVAILABLE'
  | 'PAYMENT_FAILED'
  | 'INTERNAL';

export class AppError extends Error {
  constructor(
    public status: number,
    public code: ErrorCode,
    message: string = code,
    public extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof AppError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message, ...err.extra } });
    return;
  }
  if (err instanceof ZodError) {
    res.status(400).json({ error: { code: 'VALIDATION', message: 'Invalid request', issues: err.issues } });
    return;
  }
  console.error(err);
  res.status(500).json({ error: { code: 'INTERNAL', message: 'Internal error' } });
};
