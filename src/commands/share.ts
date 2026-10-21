import { spawn } from 'node:child_process';
import { closeSync, openSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseCommandArgs } from '../args.js';
import { requireCloudflared } from '../cloudflared.js';
import { DEFAULT_EXPIRES, formatRelative, parseDuration } from '../duration.js';
import { ExitCode, FshareError, usageError } from '../errors.js';
import { shareHelp } from '../help.js';
import { CLI_PATH, PACKAGE_NAME } from '../meta.js';
import { Logger, printJson, reportError, type Io } from '../output.js';
import {
  resolveTarget,
  runShare,
  type ShareRequest,
  type ShareResult,
  type ShareTarget,
} from '../share-runner.js';
import { ensureStateDirs, logsDir, newShareId } from '../state.js';
import { formatBytes, invocationPrefix, localTime } from '../util.js';
import type { ChildMessage, StartMessage } from './serve.js';

const OPTIONS = {
  expires: { type: 'string' },
  'max-downloads': { type: 'string' },
  password: { type: 'string' },
  name: { type: 'string' },
  json: { type: 'boolean' },
  detach: { type: 'boolean' },
  'keep-awake': { type: 'boolean' },
  force: { type: 'boolean' },
  protocol: { type: 'string' },
} as const;

export function validateDownloadName(name: string): string {
  if (name.trim() === '') throw usageError('--name must not be empty.');
  if (/[/\\]/.test(name)) {
    throw usageError('--name must be a file name, not a path (no "/" or "\\").');
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) {
    throw usageError('--name must not contain control characters.');
  }
  if (name === '.' || name === '..') throw usageError('--name must be a real file name.');
  if (Buffer.byteLength(name, 'utf8') > 200)
    throw usageError('--name is too long (max 200 bytes).');
  return name;
}

export function parseShareArgs(
  args: string[],
  env: NodeJS.ProcessEnv,
): { help: true } | { help: false; request: ShareRequest } {
  const { values, positionals } = parseCommandArgs(args, OPTIONS, 'share');
  if (values.help) return { help: true };

  if (positionals.length === 0) {
    throw usageError('Missing <path> to share.', 'Example: fshare share ./report.pdf');
  }
  if (positionals.length > 1) {
    throw usageError(
      `Only one path can be shared at a time (got ${positionals.length}).`,
      'Put the files in a folder and share the folder; it is sent as a single .zip.',
    );
  }

  let maxDownloads: number | null = null;
  if (values['max-downloads'] !== undefined) {
    const raw = values['max-downloads'].trim();
    if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > 1_000_000) {
      throw usageError(`--max-downloads must be a whole number from 1 upward (got "${raw}").`);
    }
    maxDownloads = Number(raw);
  }

  const password =
    values.password ??
    (env.FSHARE_PASSWORD !== undefined && env.FSHARE_PASSWORD !== '' ? env.FSHARE_PASSWORD : null);
  if (password === '') throw usageError('--password must not be empty.');
  if (password !== null && password.length > 1024) {
    throw usageError('--password is too long (max 1024 characters).');
  }

  const protocol = values.protocol;
  if (protocol !== undefined && protocol !== 'quic' && protocol !== 'http2') {
    throw usageError(`--protocol must be "quic" or "http2" (got "${protocol}").`);
  }

  return {
    help: false,
    request: {
      inputPath: positionals[0] ?? '',
      expiresMs: parseDuration(values.expires ?? DEFAULT_EXPIRES),
      maxDownloads,
      password,
      name: values.name === undefined ? null : validateDownloadName(values.name),
      json: values.json ?? false,
      detach: values.detach ?? false,
      keepAwake: values['keep-awake'] ?? false,
      force: values.force ?? false,
      protocol: protocol ?? null,
    },
  };
}

export async function shareCommand(args: string[], io: Io): Promise<number> {
  const parsed = parseShareArgs(args, io.env);
  if (parsed.help) {
    io.stdout.write(shareHelp());
    return ExitCode.OK;
  }
  const { request } = parsed;
  const logger = new Logger(io, { json: request.json });

  // Validate everything cheap up front so errors get the right exit code immediately.
  const target = await resolveTarget(request, logger, io.env);
  const cloudflaredBin = await requireCloudflared(io.env);

  if (request.detach) return runDetached(request, target, io, logger);

  return runShare(request, target, {
    io,
    logger,
    cloudflaredBin,
    detached: false,
    logFile: null,
    onReady: (result) => printShareResult(io, logger, request, result, false),
  });
}

export function printShareResult(
  io: Io,
  logger: Logger,
  request: ShareRequest,
  result: ShareResult,
  detached: boolean,
): void {
  if (request.json) {
    printJson(io, result);
    return;
  }
  const s = logger.style;
  const prefix = invocationPrefix(PACKAGE_NAME, io.env);
  const expires = Date.parse(result.expires_at);
  logger.info(
    `${s.green('✔')} Sharing ${s.bold(result.file)} (${formatBytes(result.size_bytes)}). Anyone with this link can download it:`,
  );
  io.stdout.write(`${result.url}\n`);
  logger.info(`  Expires    ${formatRelative(expires)} (${localTime(expires)})`);
  logger.info(
    `  Downloads  ${result.max_downloads === null ? 'unlimited' : `up to ${result.max_downloads}`}`,
  );
  if (result.password_protected) logger.info('  Password   required (username: fshare)');
  logger.info(
    detached
      ? `  Stop       ${prefix} stop ${result.id}`
      : `  Stop       press Ctrl+C, or run: ${prefix} stop ${result.id}`,
  );
}

function readLogTail(file: string, lines = 8): string {
  try {
    const text = readFileSync(file, 'utf8');
    return text.trimEnd().split('\n').slice(-lines).join('\n');
  } catch {
    return '';
  }
}

/**
 * --detach: re-spawn this CLI as a detached background process running the hidden `__serve`
 * command. Options (including the password) travel over the IPC channel, never via argv where
 * other users could see them in `ps`. The child reports "ready" or "error" and we exit.
 */
async function runDetached(
  request: ShareRequest,
  target: ShareTarget,
  io: Io,
  logger: Logger,
): Promise<number> {
  await ensureStateDirs(io.env);
  const id = newShareId(io.env);
  const logFile = path.join(logsDir(io.env), `${id}.log`);
  const env = { ...io.env };
  delete env.FSHARE_PASSWORD;
  delete env.FORCE_COLOR;

  const fd = openSync(logFile, 'a', 0o600);
  let child;
  try {
    // spawn (not fork) because only spawn supports windowsHide; the 'ipc' slot gives the
    // child process.send() exactly like fork would.
    child = spawn(process.execPath, [CLI_PATH, '__serve'], {
      detached: true,
      stdio: ['ignore', fd, fd, 'ipc'],
      windowsHide: true,
      env,
    });
  } finally {
    closeSync(fd);
  }

  const start: StartMessage = {
    type: 'start',
    id,
    logFile,
    request: { ...request, inputPath: target.absPath },
  };
  child.send(start);

  return new Promise<number>((resolve) => {
    let settled = false;
    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      process.off('SIGINT', onInterrupt);
      process.off('SIGTERM', onInterrupt);
      child.removeAllListeners();
      if (child.connected) child.disconnect();
      child.unref();
      resolve(code);
    };
    const onInterrupt = (): void => {
      child.kill('SIGTERM');
      logger.error('Cancelled.');
      finish(130);
    };
    process.on('SIGINT', onInterrupt);
    process.on('SIGTERM', onInterrupt);

    child.on('message', (message: ChildMessage) => {
      if (message.type === 'ready') {
        printShareResult(io, logger, request, message.result, true);
        finish(ExitCode.OK);
      } else if (message.type === 'error') {
        const { code, message: text, hint } = message.error;
        finish(reportError(io, new FshareError(code, text, hint ? { hint } : {}), request.json));
      }
    });
    child.on('exit', (code, signal) => {
      const tail = readLogTail(logFile);
      const how = signal ? `was killed (${signal})` : `exited with code ${String(code)}`;
      finish(
        reportError(
          io,
          new FshareError(
            'ERROR',
            `The background share process ${how} before the link was ready.${tail ? `\nLast log lines:\n${tail}` : ''}`,
            { hint: `Full log: ${logFile}` },
          ),
          request.json,
        ),
      );
    });
    child.on('error', (err) => finish(reportError(io, err, request.json)));
  });
}
