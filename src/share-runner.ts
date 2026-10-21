import { constants as fsConstants, rmSync } from 'node:fs';
import { access, mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BASIC_AUTH_USER, generateToken } from './auth.js';
import { watchExpiry } from './duration.js';
import { ExitCode, FshareError, errnoCode } from './errors.js';
import { sha256File } from './hash.js';
import { startKeepAwake, type KeepAwake } from './keepawake.js';
import { VERSION } from './meta.js';
import type { Io, Logger } from './output.js';
import { checkSensitivePath, findSensitiveEntries, looksLikePrivateKey } from './safety.js';
import {
  createShareServer,
  type ServedFile,
  type ServerEvent,
  type ShareServer,
} from './server.js';
import {
  newShareId,
  removeShareState,
  sharesDir,
  writeShareState,
  type ShareState,
} from './state.js';
import { startTunnel, waitUntilReachable, type Tunnel } from './tunnel.js';
import { expandHome, formatBytes, homeDir, isoSeconds, tildify } from './util.js';
import { walkDir, zipFolder } from './zip.js';

export interface ShareRequest {
  inputPath: string;
  expiresMs: number;
  maxDownloads: number | null;
  password: string | null;
  name: string | null;
  json: boolean;
  detach: boolean;
  keepAwake: boolean;
  force: boolean;
  protocol: 'quic' | 'http2' | null;
}

export interface ShareTarget {
  /** Absolute path as given, before resolving symlinks. */
  absPath: string;
  realPath: string;
  isFolder: boolean;
  downloadName: string;
}

/** The JSON printed by `fshare share --json`. Field names are part of the public interface. */
export interface ShareResult {
  id: string;
  url: string;
  file: string;
  size_bytes: number;
  sha256: string;
  expires_at: string;
  max_downloads: number | null;
  password_protected: boolean;
  pid: number;
}

export type StopReason = 'signal' | 'stopped' | 'expired' | 'limit' | 'tunnel-exit';

/** Validates the path and applies the sensitive-path rules. Cheap; safe to run twice. */
export async function resolveTarget(
  request: ShareRequest,
  logger: Logger,
  env: NodeJS.ProcessEnv,
): Promise<ShareTarget> {
  const home = homeDir(env);
  const absPath = path.resolve(expandHome(request.inputPath, home));

  let realPath: string;
  try {
    realPath = await realpath(absPath);
  } catch (err) {
    const code = errnoCode(err);
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw new FshareError('NOT_FOUND', `No such file or folder: ${request.inputPath}`);
    }
    if (code === 'EACCES' || code === 'EPERM') {
      throw new FshareError('ERROR', `Permission denied: ${request.inputPath}`);
    }
    throw err;
  }

  const info = await stat(realPath);
  if (!info.isFile() && !info.isDirectory()) {
    throw new FshareError('USAGE', `${request.inputPath} is not a regular file or folder.`);
  }
  try {
    await access(realPath, fsConstants.R_OK);
  } catch {
    throw new FshareError('ERROR', `Permission denied: ${request.inputPath} is not readable.`);
  }
  const isFolder = info.isDirectory();

  const ctx = { home, platform: process.platform };
  let match =
    checkSensitivePath(absPath, ctx, { isDirectory: isFolder }) ??
    (realPath !== absPath ? checkSensitivePath(realPath, ctx, { isDirectory: isFolder }) : null);
  if (
    !match &&
    !isFolder &&
    path.extname(realPath).toLowerCase() === '.key' &&
    (await looksLikePrivateKey(realPath))
  ) {
    match = { reason: 'it contains a private key' };
  }
  if (match) {
    if (!request.force) {
      throw new FshareError(
        'SENSITIVE_PATH',
        `Refusing to share ${request.inputPath} because ${match.reason}.`,
        { hint: 'If you are sure you want to publish it, re-run with --force.' },
      );
    }
    logger.warn(`Sharing ${request.inputPath} even though ${match.reason} (--force).`);
  }

  const base = path.basename(absPath) || 'download';
  let downloadName = request.name ?? (isFolder ? `${base}.zip` : base);
  if (isFolder && !downloadName.toLowerCase().endsWith('.zip')) downloadName += '.zip';
  return { absPath, realPath, isFolder, downloadName };
}

export function basicAuthHeader(password: string): string {
  return `Basic ${Buffer.from(`${BASIC_AUTH_USER}:${password}`, 'utf8').toString('base64')}`;
}

export interface RunShareHooks {
  io: Io;
  logger: Logger;
  cloudflaredBin: string;
  /** Pre-allocated share id (--detach allocates it in the parent). */
  id?: string;
  detached: boolean;
  logFile: string | null;
  /** Called once the link works. Print the URL here. */
  onReady: (result: ShareResult, state: ShareState) => void | Promise<void>;
  /** Stops the share when aborted (used by tests). */
  stopSignal?: AbortSignal;
  /** Install SIGINT/SIGTERM/SIGHUP handlers (default: true). */
  handleSignals?: boolean;
}

/**
 * Runs one share from start to finish: zip (folders), hash, local server, tunnel, state file,
 * then waits until it is stopped, expires or reaches its download limit, and cleans up.
 * Returns the process exit code.
 */
export async function runShare(
  request: ShareRequest,
  target: ShareTarget,
  hooks: RunShareHooks,
): Promise<number> {
  const { logger } = hooks;
  const env = hooks.io.env;
  const debug = env.FSHARE_DEBUG === '1';
  const abort = new AbortController();
  let stopReason: StopReason | null = null;
  let resolveStopped: (reason: StopReason) => void = () => {};
  const stopped = new Promise<StopReason>((resolve) => {
    resolveStopped = resolve;
  });
  const requestStop = (reason: StopReason): void => {
    if (stopReason) return;
    stopReason = reason;
    abort.abort();
    resolveStopped(reason);
  };

  let tempDir: string | null = null;
  let share: ShareServer | null = null;
  let tunnel: Tunnel | null = null;
  let keepAwake: KeepAwake | null = null;
  let stopExpiry: (() => void) | null = null;
  let stateId: string | null = null;
  let state: ShareState | null = null;
  // State writes are queued so they never overlap; cleanup drains the queue before deleting.
  let saving: Promise<void> = Promise.resolve();
  const saveState = (): void => {
    if (!state || !stateId) return;
    const snapshot = { ...state };
    saving = saving
      .then(() => writeShareState(snapshot, env))
      .catch((err: unknown) => logger.warn(`Could not update share state: ${String(err)}`));
  };

  const signals: NodeJS.Signals[] =
    process.platform === 'win32' ? ['SIGINT', 'SIGTERM'] : ['SIGINT', 'SIGTERM', 'SIGHUP'];
  const onSignal = (): void => requestStop('signal');
  const handleSignals = hooks.handleSignals !== false;
  if (handleSignals) for (const signal of signals) process.on(signal, onSignal);
  const onExternalStop = (): void => requestStop('stopped');
  hooks.stopSignal?.addEventListener('abort', onExternalStop, { once: true });
  // Last resort if the process exits without reaching the async cleanup below.
  const onExit = (): void => {
    tunnel?.killSync();
    keepAwake?.stop();
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    if (stateId) rmSync(path.join(sharesDir(env), `${stateId}.json`), { force: true });
  };
  process.on('exit', onExit);

  try {
    // 1. Prepare the file to serve.
    let servedPath = target.realPath;
    if (target.isFolder) {
      logger.info(`Zipping ${tildify(target.realPath, homeDir(env))} ...`);
      const walk = await walkDir(target.realPath, abort.signal);
      if (walk.skippedLinks.length > 0) {
        logger.warn(
          `Left out ${walk.skippedLinks.length} symbolic link(s); links inside shared folders are not followed.`,
        );
      }
      if (walk.skippedOther.length > 0) {
        logger.warn(
          `Left out ${walk.skippedOther.length} item(s) that are not regular files or could not be read: ${walk.skippedOther.slice(0, 3).join(', ')}`,
        );
      }
      const sensitive = findSensitiveEntries(walk.entries);
      if (sensitive.length > 0) {
        const list = sensitive.map((s) => `  ${s.rel} (${s.reason})`).join('\n');
        if (!request.force) {
          throw new FshareError(
            'SENSITIVE_PATH',
            `Refusing to share ${request.inputPath} because it contains files that look sensitive:\n${list}`,
            { hint: 'Remove them from the folder, or re-run with --force if you are sure.' },
          );
        }
        logger.warn(`Including sensitive-looking files because of --force:\n${list}`);
      }
      tempDir = await mkdtemp(path.join(os.tmpdir(), 'fshare-'));
      servedPath = path.join(tempDir, target.downloadName);
      const zipped = await zipFolder({
        root: target.realPath,
        entries: walk.entries,
        outPath: servedPath,
        signal: abort.signal,
        env,
      });
      for (const warning of zipped.warnings) logger.warn(warning);
      const zipSize = (await stat(servedPath)).size;
      logger.info(
        `Zipped ${walk.fileCount} file(s): ${formatBytes(walk.totalBytes)} -> ${formatBytes(zipSize)}${zipped.method === 'builtin' ? ' (built-in zip)' : ''}.`,
      );
    }

    const before = await stat(servedPath);
    if (before.size > 512 * 1024 * 1024) {
      logger.info(`Computing SHA-256 of ${formatBytes(before.size)} ...`);
    }
    const sha256 = await sha256File(servedPath, abort.signal);
    const after = await stat(servedPath);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      throw new FshareError(
        'ERROR',
        `${request.inputPath} changed while it was being prepared. Try again once nothing is writing to it.`,
      );
    }
    const file: ServedFile = {
      path: servedPath,
      name: target.downloadName,
      size: after.size,
      mtimeMs: after.mtimeMs,
      sha256,
    };

    // 2. Local HTTP server (loopback only).
    const id = hooks.id ?? newShareId(env);
    const token = generateToken();
    const onServerEvent = (event: ServerEvent): void => {
      switch (event.type) {
        case 'download-completed':
          if (event.counted) {
            const limit = request.maxDownloads === null ? '' : ` of ${request.maxDownloads}`;
            logger.info(
              `Download ${event.count}${limit} completed (${formatBytes(event.bytes)} to ${event.ip}).`,
            );
            if (state) {
              state.downloadCount = event.count;
              saveState();
            }
          }
          break;
        case 'download-aborted':
          logger.info(`A download was interrupted (${event.ip}).`);
          break;
        case 'auth-failed':
          if (debug) logger.info(`Password prompt or wrong password (${event.ip}).`);
          break;
        case 'preview-bot-blocked':
          logger.info(`Refused a link-preview bot (${event.userAgent.slice(0, 60)}).`);
          break;
        case 'file-changed':
          logger.warn(
            'The shared file changed or was removed; downloads will fail until you share it again.',
          );
          break;
        case 'download-started':
          break;
      }
    };
    share = createShareServer({
      file,
      token,
      password: request.password,
      maxDownloads: request.maxDownloads,
      onEvent: onServerEvent,
      onLimitReached: () => requestStop('limit'),
      onExpired: () => requestStop('expired'),
    });
    const port = await share.listen();

    // 3. Cloudflare quick tunnel.
    logger.info('Starting Cloudflare tunnel ...');
    tunnel = await startTunnel({
      bin: hooks.cloudflaredBin,
      port,
      protocol: request.protocol,
      signal: abort.signal,
      ...(debug ? { onLine: (line: string) => logger.info(`[cloudflared] ${line}`) } : {}),
    });
    const url = `${tunnel.url}/${token}/${encodeURIComponent(file.name)}`;
    if (env.FSHARE_SKIP_PROBE !== '1') {
      const reachable = await waitUntilReachable({
        url,
        signal: abort.signal,
        ...(request.password ? { authorization: basicAuthHeader(request.password) } : {}),
      });
      if (!reachable) {
        logger.warn(
          'The link was created, but this computer could not confirm it works yet. It usually starts working within a few seconds.',
        );
      }
    }

    // 4. Live: start the expiry clock, record state, hand out the URL.
    const createdAt = Date.now();
    const expiresAt = Math.ceil((createdAt + request.expiresMs) / 1000) * 1000;
    share.setExpiresAt(expiresAt);
    if (request.keepAwake) {
      keepAwake = await startKeepAwake({
        durationMs: request.expiresMs,
        onWarning: (message) => logger.warn(message),
        env,
      });
    }
    state = {
      version: 1,
      id,
      path: target.realPath,
      name: file.name,
      isFolder: target.isFolder,
      servedPath,
      tempDir,
      token,
      url,
      sizeBytes: file.size,
      sha256,
      pid: process.pid,
      cloudflaredPid: tunnel.pid,
      localPort: port,
      created: isoSeconds(createdAt),
      expires: isoSeconds(expiresAt),
      maxDownloads: request.maxDownloads,
      downloadCount: 0,
      passwordProtected: request.password !== null,
      detached: hooks.detached,
      logFile: hooks.logFile,
      protocol: request.protocol,
      fshareVersion: VERSION,
    };
    await writeShareState(state, env);
    stateId = id;
    stopExpiry = watchExpiry(expiresAt, () => requestStop('expired'));
    void tunnel.exited.then(() => requestStop('tunnel-exit'));

    await hooks.onReady(
      {
        id,
        url,
        file: file.name,
        size_bytes: file.size,
        sha256,
        expires_at: state.expires,
        max_downloads: request.maxDownloads,
        password_protected: request.password !== null,
        pid: process.pid,
      },
      state,
    );

    // 5. Wait for the end.
    const reason = await stopped;
    switch (reason) {
      case 'expired':
        logger.info('The link expired. Stopped sharing.');
        break;
      case 'limit':
        logger.info(`Download limit reached (${share.downloadCount}). Stopped sharing.`);
        break;
      case 'tunnel-exit':
        logger.error(
          'cloudflared exited unexpectedly, so the link no longer works.',
          'Share the file again to get a new link.',
        );
        break;
      default:
        logger.info('Stopped sharing.');
    }
    return reason === 'tunnel-exit' ? ExitCode.TUNNEL_FAILED : ExitCode.OK;
  } catch (err) {
    if (stopReason === 'signal' || stopReason === 'stopped') {
      logger.info('Cancelled.');
      return 130;
    }
    throw err;
  } finally {
    if (handleSignals) for (const signal of signals) process.off(signal, onSignal);
    hooks.stopSignal?.removeEventListener('abort', onExternalStop);
    stopExpiry?.();
    keepAwake?.stop();
    await share?.close();
    await tunnel?.stop();
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
    if (stateId) {
      const id = stateId;
      stateId = null; // no more state writes
      await saving;
      await removeShareState(id, env);
    }
    process.off('exit', onExit);
  }
}
