/**
 * Exit codes are part of the public interface (scripts and AI agents rely on them).
 * Keep them in sync with README.md, AGENTS.md and SKILL.md.
 */
export const ExitCode = {
  OK: 0,
  ERROR: 1,
  USAGE: 2,
  NOT_FOUND: 3,
  CLOUDFLARED_MISSING: 4,
  TUNNEL_FAILED: 5,
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];

export type ErrorCode =
  'ERROR' | 'USAGE' | 'SENSITIVE_PATH' | 'NOT_FOUND' | 'CLOUDFLARED_MISSING' | 'TUNNEL_FAILED';

const EXIT_CODE_FOR: Record<ErrorCode, ExitCodeValue> = {
  ERROR: ExitCode.ERROR,
  USAGE: ExitCode.USAGE,
  SENSITIVE_PATH: ExitCode.USAGE,
  NOT_FOUND: ExitCode.NOT_FOUND,
  CLOUDFLARED_MISSING: ExitCode.CLOUDFLARED_MISSING,
  TUNNEL_FAILED: ExitCode.TUNNEL_FAILED,
};

export class FshareError extends Error {
  readonly code: ErrorCode;
  readonly exitCode: ExitCodeValue;
  readonly hint: string | undefined;

  constructor(code: ErrorCode, message: string, options: { hint?: string; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'FshareError';
    this.code = code;
    this.exitCode = EXIT_CODE_FOR[code];
    this.hint = options.hint;
  }
}

export function usageError(message: string, hint?: string): FshareError {
  return new FshareError('USAGE', message, hint === undefined ? {} : { hint });
}

/** Thrown when an operation is cancelled (Ctrl+C while preparing a share). */
export class CancelledError extends Error {
  constructor() {
    super('Cancelled');
    this.name = 'CancelledError';
  }
}

export function toFshareError(err: unknown): FshareError {
  if (err instanceof FshareError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new FshareError('ERROR', message, { cause: err });
}

export function errnoCode(err: unknown): string | undefined {
  if (err && typeof err === 'object' && 'code' in err && typeof err.code === 'string') {
    return err.code;
  }
  return undefined;
}
