import { requireCloudflared } from '../cloudflared.js';
import { toFshareError, usageError, type ErrorCode } from '../errors.js';
import { Logger, type Io } from '../output.js';
import { resolveTarget, runShare, type ShareRequest, type ShareResult } from '../share-runner.js';
import { formatBytes } from '../util.js';

/** Parent -> child: what to share. */
export interface StartMessage {
  type: 'start';
  id: string;
  logFile: string;
  request: ShareRequest;
}

/** Child -> parent: the outcome of starting the share. */
export type ChildMessage =
  | { type: 'ready'; result: ShareResult }
  | { type: 'error'; error: { code: ErrorCode; message: string; hint?: string } };

function isStartMessage(value: unknown): value is StartMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { type?: unknown }).type === 'start' &&
    typeof (value as { id?: unknown }).id === 'string'
  );
}

function waitForStart(timeoutMs = 15_000): Promise<StartMessage> {
  return new Promise((resolve, reject) => {
    const onMessage = (message: unknown): void => {
      if (!isStartMessage(message)) return;
      clearTimeout(timer);
      process.off('message', onMessage);
      resolve(message);
    };
    const timer = setTimeout(() => {
      process.off('message', onMessage);
      reject(new Error('Timed out waiting for instructions from the parent process.'));
    }, timeoutMs);
    process.on('message', onMessage);
  });
}

function send(message: ChildMessage): Promise<void> {
  return new Promise((resolve) => {
    if (!process.send || !process.connected) {
      resolve();
      return;
    }
    process.send(message, undefined, {}, () => resolve());
  });
}

function disconnect(): void {
  if (process.connected) process.disconnect();
}

/**
 * Hidden `fshare __serve` command: the background half of `fshare share --detach`.
 * stdout/stderr are redirected to ~/.fshare/logs/<id>.log by the parent.
 */
export async function serveCommand(io: Io): Promise<number> {
  if (!process.send) {
    throw usageError('"__serve" is an internal command used by "fshare share --detach".');
  }
  const start = await waitForStart();
  const logger = new Logger(io, { timestamps: true });
  const { request } = start;
  try {
    const target = await resolveTarget(request, logger, io.env);
    const cloudflaredBin = await requireCloudflared(io.env);
    return await runShare(request, target, {
      io,
      logger,
      cloudflaredBin,
      id: start.id,
      detached: true,
      logFile: start.logFile,
      onReady: async (result) => {
        // The log file never contains the tokenized URL.
        logger.info(
          `Share ${result.id} is live: ${result.file} (${formatBytes(result.size_bytes)}), expires ${result.expires_at}.`,
        );
        await send({ type: 'ready', result });
        disconnect();
      },
    });
  } catch (err) {
    const error = toFshareError(err);
    logger.error(error.message, error.hint);
    await send({
      type: 'error',
      error: {
        code: error.code,
        message: error.message,
        ...(error.hint ? { hint: error.hint } : {}),
      },
    });
    disconnect();
    return error.exitCode;
  }
}
