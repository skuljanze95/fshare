import { toFshareError, type FshareError } from './errors.js';

export interface Writer {
  write(chunk: string): unknown;
  isTTY?: boolean;
}

/** Everything a command needs to talk to the outside world. Injected so tests can capture it. */
export interface Io {
  stdout: Writer;
  stderr: Writer;
  env: NodeJS.ProcessEnv;
}

export function defaultIo(): Io {
  return { stdout: process.stdout, stderr: process.stderr, env: process.env };
}

/** Colors follow https://no-color.org: any non-empty NO_COLOR disables them. */
export function colorEnabled(stream: Writer, env: NodeJS.ProcessEnv): boolean {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false;
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== '' && env.FORCE_COLOR !== '0') {
    return true;
  }
  if (env.TERM === 'dumb') return false;
  return stream.isTTY === true;
}

export interface Styler {
  bold(text: string): string;
  dim(text: string): string;
  red(text: string): string;
  green(text: string): string;
  yellow(text: string): string;
  cyan(text: string): string;
}

export function createStyler(enabled: boolean): Styler {
  const wrap =
    (open: number, close: number) =>
    (text: string): string =>
      enabled ? `\u001b[${open}m${text}\u001b[${close}m` : text;
  return {
    bold: wrap(1, 22),
    dim: wrap(2, 22),
    red: wrap(31, 39),
    green: wrap(32, 39),
    yellow: wrap(33, 39),
    cyan: wrap(36, 39),
  };
}

export interface LoggerOptions {
  /** In JSON mode informational messages are suppressed; warnings and errors are kept. */
  json?: boolean;
  /** Prefix lines with an ISO timestamp (used for background log files). */
  timestamps?: boolean;
}

/** Human-readable diagnostics. Always written to stderr so stdout stays machine-readable. */
export class Logger {
  readonly style: Styler;
  private readonly io: Io;
  private readonly json: boolean;
  private readonly timestamps: boolean;

  constructor(io: Io, options: LoggerOptions = {}) {
    this.io = io;
    this.json = options.json ?? false;
    this.timestamps = options.timestamps ?? false;
    this.style = createStyler(colorEnabled(io.stderr, io.env));
  }

  info(message: string): void {
    if (!this.json) this.line(message);
  }

  warn(message: string): void {
    this.line(`${this.style.yellow('warning:')} ${message}`);
  }

  error(message: string, hint?: string): void {
    this.line(`${this.style.red('error:')} ${message}`);
    if (hint) this.line(`${this.style.dim('hint:')} ${hint}`);
  }

  private line(message: string): void {
    const prefix = this.timestamps ? `[${new Date().toISOString()}] ` : '';
    this.io.stderr.write(`${prefix}${message}\n`);
  }
}

export function printJson(io: Io, value: unknown): void {
  io.stdout.write(`${JSON.stringify(value)}\n`);
}

/**
 * Reports an error and returns the exit code. In JSON mode an error object is also printed
 * to stdout so agents always get parseable output.
 */
export function reportError(io: Io, err: unknown, json: boolean): number {
  const error: FshareError = toFshareError(err);
  new Logger(io).error(error.message, error.hint);
  if (json) {
    printJson(io, {
      error: {
        code: error.code,
        message: error.message,
        ...(error.hint ? { hint: error.hint } : {}),
        exit_code: error.exitCode,
      },
    });
  }
  return error.exitCode;
}
