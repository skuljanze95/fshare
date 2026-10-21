import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Logger } from '../src/output.js';
import {
  resolveTarget,
  runShare,
  type ShareRequest,
  type ShareResult,
} from '../src/share-runner.js';
import { readShareState, type ShareState } from '../src/state.js';
import {
  FAKE_CLOUDFLARED,
  captureIo,
  cleanupTempDirs,
  httpRequest,
  makeTempDir,
} from './helpers.js';

afterAll(cleanupTempDirs);

function request(inputPath: string, overrides: Partial<ShareRequest> = {}): ShareRequest {
  return {
    inputPath,
    expiresMs: 3_600_000,
    maxDownloads: null,
    password: null,
    name: null,
    json: false,
    detach: false,
    keepAwake: false,
    force: false,
    protocol: null,
    ...overrides,
  };
}

async function startShare(inputPath: string, overrides: Partial<ShareRequest> = {}) {
  const home = await makeTempDir('fshare-home-');
  const io = captureIo({ FSHARE_HOME: home, FSHARE_SKIP_PROBE: '1' });
  const logger = new Logger(io);
  const req = request(inputPath, overrides);
  const target = await resolveTarget(req, logger, io.env);
  const stop = new AbortController();
  let resolveReady: (value: { result: ShareResult; state: ShareState }) => void = () => {};
  const ready = new Promise<{ result: ShareResult; state: ShareState }>((resolve) => {
    resolveReady = resolve;
  });
  const done = runShare(req, target, {
    io,
    logger,
    cloudflaredBin: FAKE_CLOUDFLARED,
    detached: false,
    logFile: null,
    stopSignal: stop.signal,
    handleSignals: false,
    onReady: (result, state) => resolveReady({ result, state }),
  });
  const { result, state } = await Promise.race([
    ready,
    done.then((code) => {
      throw new Error(`runShare exited early with ${code}: ${io.err()}`);
    }),
  ]);
  return { io, home, result, state, stop, done };
}

describe('runShare', () => {
  it('serves a file and cleans up when stopped', async () => {
    const dir = await makeTempDir();
    const file = path.join(dir, 'notes.txt');
    await writeFile(file, 'hello from fshare\n');
    const { io, result, state, stop, done } = await startShare(file, { maxDownloads: 5 });

    expect(result).toMatchObject({
      file: 'notes.txt',
      size_bytes: 18,
      sha256: createHash('sha256').update('hello from fshare\n').digest('hex'),
      max_downloads: 5,
      password_protected: false,
    });
    expect(result.url).toMatch(
      /^https:\/\/fake-[a-z0-9]+-tunnel\.trycloudflare\.com\/[A-Za-z0-9_-]{32}\/notes\.txt$/,
    );
    expect(result.expires_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(await readShareState(result.id, io.env)).toMatchObject({
      id: result.id,
      pid: process.pid,
    });

    const localPath = new URL(result.url).pathname;
    const res = await httpRequest(state.localPort, localPath);
    expect(res.body.toString()).toBe('hello from fshare\n');

    stop.abort();
    expect(await done).toBe(0);
    expect(await readShareState(result.id, io.env)).toBeNull();
    // The log never contains the secret token.
    expect(io.err()).not.toContain(state.token);
  });

  it('zips folders to a temp file and deletes it afterwards', async () => {
    const dir = await makeTempDir();
    const folder = path.join(dir, 'project');
    await mkdir(path.join(folder, 'src'), { recursive: true });
    await writeFile(path.join(folder, 'src', 'index.js'), 'console.log(1)\n');
    const { result, state, stop, done } = await startShare(folder);

    expect(result.file).toBe('project.zip');
    expect(state.tempDir).not.toBeNull();
    expect(existsSync(state.servedPath)).toBe(true);
    const res = await httpRequest(state.localPort, new URL(result.url).pathname);
    expect(res.status).toBe(200);
    expect(res.body.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    if (process.platform !== 'win32') {
      const listing = execFileSync('unzip', ['-Z1', state.servedPath], { encoding: 'utf8' });
      expect(listing).toContain('project/src/index.js');
    }

    stop.abort();
    expect(await done).toBe(0);
    expect(existsSync(state.tempDir ?? '')).toBe(false);
  });

  it('refuses folders containing secrets unless forced', async () => {
    const dir = await makeTempDir();
    const folder = path.join(dir, 'app');
    await mkdir(folder);
    await writeFile(path.join(folder, '.env'), 'TOKEN=1\n');
    await expect(startShare(folder)).rejects.toThrow(/contains files that look sensitive/);
    const forced = await startShare(folder, { force: true });
    expect(forced.io.err()).toContain('--force');
    forced.stop.abort();
    expect(await forced.done).toBe(0);
  });

  it('uses --name and keeps .zip for folders', async () => {
    const dir = await makeTempDir();
    await mkdir(path.join(dir, 'pics'));
    const logger = new Logger(captureIo());
    const target = await resolveTarget(
      request(path.join(dir, 'pics'), { name: 'holiday' }),
      logger,
      {},
    );
    expect(target.downloadName).toBe('holiday.zip');
    const fileTarget = await resolveTarget(
      request(path.join(dir, 'pics'), { name: 'archive.ZIP' }),
      logger,
      {},
    );
    expect(fileTarget.downloadName).toBe('archive.ZIP');
  });
});
