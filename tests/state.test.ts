import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  cleanupStaleShares,
  isCloudflaredAlive,
  isProcessAlive,
  newShareId,
  readAllShareStates,
  readShareState,
  shareJson,
  sharesDir,
  writeShareState,
  type ShareState,
} from '../src/state.js';
import {
  CAN_RUN_FAKE_CLOUDFLARED,
  FAKE_CLOUDFLARED,
  cleanupTempDirs,
  makeTempDir,
  waitFor,
} from './helpers.js';

afterAll(cleanupTempDirs);

async function testEnv(): Promise<NodeJS.ProcessEnv> {
  return { ...process.env, FSHARE_HOME: await makeTempDir('fshare-home-') };
}

function sampleState(overrides: Partial<ShareState> = {}): ShareState {
  return {
    version: 1,
    id: 'a1b2c3',
    path: '/tmp/report.pdf',
    name: 'report.pdf',
    isFolder: false,
    servedPath: '/tmp/report.pdf',
    tempDir: null,
    token: 'token',
    url: 'https://example.trycloudflare.com/token/report.pdf',
    sizeBytes: 12,
    sha256: 'abc',
    pid: process.pid,
    cloudflaredPid: null,
    localPort: 12345,
    created: '2026-10-21T10:00:00Z',
    expires: '2026-10-21T11:00:00Z',
    maxDownloads: null,
    downloadCount: 0,
    passwordProtected: false,
    detached: false,
    logFile: null,
    protocol: null,
    fshareVersion: '0.0.0',
    ...overrides,
  };
}

/** PID of a process that has already exited. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', '']);
  await new Promise((resolve) => child.once('exit', resolve));
  return child.pid ?? 999_999;
}

describe('state files', () => {
  it('round-trips atomically with private permissions', async () => {
    const env = await testEnv();
    await writeShareState(sampleState(), env);
    expect(await readShareState('a1b2c3', env)).toEqual(sampleState());
    const files = await readdir(sharesDir(env));
    expect(files).toEqual(['a1b2c3.json']);
    if (process.platform !== 'win32') {
      expect((await stat(path.join(sharesDir(env), 'a1b2c3.json'))).mode & 0o777).toBe(0o600);
      expect((await stat(sharesDir(env))).mode & 0o777).toBe(0o700);
    }
  });

  it('never leaves a half-written file behind under concurrent writes', async () => {
    const env = await testEnv();
    await Promise.all(
      Array.from({ length: 25 }, (_, i) => writeShareState(sampleState({ downloadCount: i }), env)),
    );
    const state = await readShareState('a1b2c3', env);
    expect(state?.downloadCount).toBeGreaterThanOrEqual(0);
    expect(await readdir(sharesDir(env))).toEqual(['a1b2c3.json']);
  });

  it('rejects ids that could escape the state directory', async () => {
    const env = await testEnv();
    expect(await readShareState('../../etc/passwd', env)).toBeNull();
    expect(await readShareState('A1B2C3', env)).toBeNull();
  });

  it('reports corrupt files and ignores unrelated ones', async () => {
    const env = await testEnv();
    await writeShareState(sampleState(), env);
    await writeFile(path.join(sharesDir(env), 'ffffff.json'), '{not json');
    await writeFile(path.join(sharesDir(env), 'notes.txt'), 'hello');
    const { states, corrupt } = await readAllShareStates(env);
    expect(states.map((s) => s.id)).toEqual(['a1b2c3']);
    expect(corrupt).toEqual([path.join(sharesDir(env), 'ffffff.json')]);
  });

  it('allocates 6-character hex ids', async () => {
    expect(newShareId(await testEnv())).toMatch(/^[a-f0-9]{6}$/);
  });

  it('produces the public JSON view', () => {
    const json = shareJson(sampleState(), Date.parse('2026-10-21T10:30:00Z'));
    expect(json).toMatchObject({
      id: 'a1b2c3',
      file: 'report.pdf',
      size_bytes: 12,
      expires_at: '2026-10-21T11:00:00Z',
      expired: false,
      download_count: 0,
      max_downloads: null,
    });
    expect(json).not.toHaveProperty('token');
  });
});

describe('process liveness', () => {
  it('detects live and dead processes', async () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(await deadPid())).toBe(false);
    expect(isProcessAlive(0)).toBe(false);
    expect(isProcessAlive(-5)).toBe(false);
  });
});

describe('cleanupStaleShares', () => {
  it.skipIf(!CAN_RUN_FAKE_CLOUDFLARED)(
    'removes shares whose process died, including temp files and cloudflared',
    async () => {
      const env = await testEnv();
      const tempParent = await makeTempDir();
      const tempDir = path.join(tempParent, 'fshare-AbC123');
      await mkdir(tempDir);
      await writeFile(path.join(tempDir, 'photos.zip'), 'zip');

      const orphan = spawn(FAKE_CLOUDFLARED, ['tunnel', '--url', 'http://127.0.0.1:1'], {
        stdio: 'ignore',
      });
      const orphanPid = orphan.pid ?? 0;
      await waitFor(() => isCloudflaredAlive(orphanPid));

      await writeShareState(
        sampleState({ id: 'dead01', pid: await deadPid(), tempDir, cloudflaredPid: orphanPid }),
        env,
      );
      await writeShareState(sampleState({ id: 'cafe01' }), env);
      await writeFile(path.join(sharesDir(env), 'bad000.json'), 'garbage');

      const { live, removed } = await cleanupStaleShares(env, (s) =>
        Promise.resolve(s.id === 'cafe01'),
      );
      expect(live.map((s) => s.id)).toEqual(['cafe01']);
      expect(removed.map((s) => s.id)).toEqual(['dead01']);
      expect(existsSync(tempDir)).toBe(false);
      expect(await readdir(sharesDir(env))).toEqual(['cafe01.json']);
      await waitFor(() => !isProcessAlive(orphanPid));
    },
  );

  it('never deletes directories fshare did not create', async () => {
    const env = await testEnv();
    const precious = await makeTempDir('important-');
    await writeShareState(sampleState({ pid: await deadPid(), tempDir: precious }), env);
    await cleanupStaleShares(env);
    expect(existsSync(precious)).toBe(true);
  });

  it('uses the real liveness check by default', async () => {
    const env = await testEnv();
    await writeShareState(sampleState({ id: 'dead02', pid: await deadPid() }), env);
    const { live } = await cleanupStaleShares(env);
    expect(live).toEqual([]);
  });
});
