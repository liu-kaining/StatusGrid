import type { FailureReason } from '../shared/contracts.js';

export type TransportErrorKind = Extract<FailureReason, 'timeout' | 'http_error' | 'blocked' | 'invalid_payload'> | 'cancelled';

export class TransportError extends Error {
  constructor(
    public readonly kind: TransportErrorKind,
    message: string,
    public readonly status: number | null = null,
  ) {
    super(message);
    this.name = 'TransportError';
  }
}
