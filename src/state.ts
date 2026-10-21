import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { errnoCode } from './errors.js';
import { homeDir, sleep } from './util.js';

/**
 * One JSON file per active share in ~/.fshare/shares/<id>.json. The serving process owns its
 * file; other commands (list, status, stop) only read it or clean it up when the owner is dead.
 */
export interface ShareState {
  version: 1;
  id: string;
  /** Shared file or folder (absolute, symlinks resolved). */
  path: string;
  /** Download filename. */
  name: string;
  isFolder: boolean;
  /** File actually served (the temporary zip for folders). */
  servedPath: string;
  tempDir: string | null;
  token: string;
  url: string;
  sizeBytes: number;
  sha256: string;
  pid: number;
  cloudflaredPid: number | null;
  localPort: number;
  created: string;
  expires: string;
  maxDownloads: number | null;
  downloadCount: number;
  passwordProtected: boolean;
  detached: boolean;
  logFile: string | null;
  protocol: 'quic' | 'http2' | null;
  fshareVersion: string;
}

const SHARE_ID = /^[a-f0-9]{6}$/;
const STATE_FILE = /^([a-f0-9]{6})\.json$/;
const TEMP_DIR_NAME = /^fshare-[A-Za-z0-9]{6}$/;

export function isValidShareId(id: string): boolean {
  return SHARE_ID.test(id);
}

export function fshareHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.FSHARE_HOME ? path.resolve(env.FSHARE_HOME) : path.join(homeDir(env), '.fshare');
}

export function sharesDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(fshareHome(env), 'shares');
}

export function logsDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(fshareHome(env), 'logs');
}

function statePath(id: string, env: NodeJS.ProcessEnv): string {
  return path.join(sharesDir(env), `${id}.json`);
}

export async function ensureStateDirs(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  for (const dir of [fshareHome(env), sharesDir(env), logsDir(env)]) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  }
}

export function newShareId(env: NodeJS.ProcessEnv = process.env): string {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const id = randomBytes(3).toString('hex');
    if (!existsSync(statePath(id, env)) && !existsSync(path.join(logsDir(env), `${id}.log`))) {
      return id;
    }
  }
  throw new Error('Could not allocate a share id.');
}

async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (err) {
      // Windows refuses to replace a file another process has open; retry briefly.
      const code = errnoCode(err);
      if (attempt >= 10 || (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY')) throw err;
      await sleep(50);
    }
  }
}

/** Atomic write: write a temp file in the same directory, then rename over the target. */
export async function writeShareState(
  state: ShareState,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (!isValidShareId(state.id)) throw new Error(`Invalid share id: ${state.id}`);
  await ensureStateDirs(env);
  const target = statePath(state.id, env);
  const temp = `${target}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  try {
    await renameWithRetry(temp, target);
  } catch (err) {
    await rm(temp, { force: true });
    throw err;
  }
}

function isShareState(value: unknown): value is ShareState {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<ShareState>;
  return (
    v.version === 1 &&
    typeof v.id === 'string' &&
    isValidShareId(v.id) &&
    typeof v.pid === 'number' &&
    typeof v.url === 'string' &&
    typeof v.name === 'string' &&
    typeof v.expires === 'string'
  );
}

export async function readShareState(
  id: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ShareState | null> {
  if (!isValidShareId(id)) return null;
  try {
    const parsed: unknown = JSON.parse(await readFile(statePath(id, env), 'utf8'));
    return isShareState(parsed) && parsed.id === id ? parsed : null;
  } catch {
    return null;
  }
}

export async function removeShareState(
  id: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (!isValidShareId(id)) return;
  await rm(statePath(id, env), { force: true });
}

/** Reads every state file. Unparseable files are reported separately so they can be removed. */
export async function readAllShareStates(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ states: ShareState[]; corrupt: string[] }> {
  let files: string[];
  try {
    files = await readdir(sharesDir(env));
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return { states: [], corrupt: [] };
    throw err;
  }
  const states: ShareState[] = [];
  const corrupt: string[] = [];
  for (const file of files.sort()) {
    const id = STATE_FILE.exec(file)?.[1];
    if (!id) continue;
    const state = await readShareState(id, env);
    if (state) states.push(state);
    else if (existsSync(statePath(id, env))) corrupt.push(statePath(id, env));
  }
  states.sort((a, b) => a.created.localeCompare(b.created));
  return { states, corrupt };
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to someone else.
    return errnoCode(err) === 'EPERM';
  }
}

/** Command line of a process (macOS/Linux), or null if it cannot be determined. */
export function processCommand(pid: number): Promise<string | null> {
  if (process.platform === 'win32') return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile('ps', ['-p', String(pid), '-o', 'command='], { timeout: 5_000 }, (err, stdout) => {
      resolve(err ? null : stdout.trim());
    });
  });
}

/**
 * PIDs get reused after a process exits, so "a process with this PID exists" is not enough
 * before we send it a signal. Where possible we also check the command line.
 */
async function isAliveMatching(pid: number, pattern: RegExp): Promise<boolean> {
  if (!isProcessAlive(pid)) return false;
  if (pid === process.pid) return true;
  const command = await processCommand(pid);
  if (command === null) return true; // cannot verify (e.g. Windows); trust the PID
  return pattern.test(command);
}

export function isShareProcessAlive(state: Pick<ShareState, 'pid'>): Promise<boolean> {
  return isAliveMatching(state.pid, /fshare|cli\.js|__serve/i);
}

export function isCloudflaredAlive(pid: number): Promise<boolean> {
  return isAliveMatching(pid, /cloudflared/i);
}

/** Kills a leftover cloudflared, deletes the temporary zip and removes the state file. */
export async function cleanupShareArtifacts(
  state: ShareState,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (state.cloudflaredPid !== null && (await isCloudflaredAlive(state.cloudflaredPid))) {
    try {
      process.kill(state.cloudflaredPid, 'SIGTERM');
    } catch {
      // already gone
    }
  }
  // Only ever delete directories fshare created itself (guards against a damaged state file).
  if (
    state.tempDir &&
    path.isAbsolute(state.tempDir) &&
    TEMP_DIR_NAME.test(path.basename(state.tempDir))
  ) {
    await rm(state.tempDir, { recursive: true, force: true });
  }
  await removeShareState(state.id, env);
}

const LOG_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

async function pruneOldLogs(env: NodeJS.ProcessEnv): Promise<void> {
  let files: string[];
  try {
    files = await readdir(logsDir(env));
  } catch {
    return;
  }
  const cutoff = Date.now() - LOG_RETENTION_MS;
  for (const file of files) {
    if (!/^[a-f0-9]{6}\.log$/.test(file)) continue;
    const full = path.join(logsDir(env), file);
    try {
      if ((await stat(full)).mtimeMs < cutoff) await rm(full, { force: true });
    } catch {
      // ignore
    }
  }
}

/**
 * Removes shares whose serving process is gone (crash, kill -9, reboot) and returns the live
 * ones. Called by list, status and stop so stale entries never linger.
 */
export async function cleanupStaleShares(
  env: NodeJS.ProcessEnv = process.env,
  isAlive: (state: ShareState) => Promise<boolean> = isShareProcessAlive,
): Promise<{ live: ShareState[]; removed: ShareState[] }> {
  const { states, corrupt } = await readAllShareStates(env);
  for (const file of corrupt) await rm(file, { force: true });
  const live: ShareState[] = [];
  const removed: ShareState[] = [];
  for (const state of states) {
    if (await isAlive(state)) {
      live.push(state);
    } else {
      await cleanupShareArtifacts(state, env);
      removed.push(state);
    }
  }
  await pruneOldLogs(env);
  return { live, removed };
}

/**
 * Stops a share: SIGTERM lets the serving process clean up after itself; if it does not exit
 * in time (or on Windows, where SIGTERM is a hard kill) leftovers are cleaned up here.
 */
export async function stopShareProcess(
  state: ShareState,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (await isShareProcessAlive(state)) {
    try {
      process.kill(state.pid, 'SIGTERM');
    } catch {
      // already gone
    }
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline && isProcessAlive(state.pid)) await sleep(100);
    if (isProcessAlive(state.pid)) {
      try {
        process.kill(state.pid, 'SIGKILL');
      } catch {
        // already gone
      }
      await sleep(200);
    }
  }
  await cleanupShareArtifacts(state, env);
}

/** Public, snake_case view of a share used by `list --json` and `status --json`. */
export function shareJson(state: ShareState, now: number = Date.now()) {
  return {
    id: state.id,
    url: state.url,
    file: state.name,
    path: state.path,
    is_folder: state.isFolder,
    size_bytes: state.sizeBytes,
    sha256: state.sha256,
    created_at: state.created,
    expires_at: state.expires,
    expired: Date.parse(state.expires) <= now,
    max_downloads: state.maxDownloads,
    download_count: state.downloadCount,
    password_protected: state.passwordProtected,
    pid: state.pid,
    detached: state.detached,
    log_file: state.logFile,
    local_port: state.localPort,
  };
}
