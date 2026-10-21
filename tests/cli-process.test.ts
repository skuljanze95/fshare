import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { isProcessAlive, processCommand } from '../src/state.js';
import {
  DIST_CLI,
  FAKE_CLOUDFLARED,
  cleanupTempDirs,
  httpRequest,
  makeTempDir,
  waitFor,
} from './helpers.js';

/**
 * Runs the built CLI (dist/cli.js) as a real process, with a fake cloudflared, to test process
 * management: --detach, list, status, stop, stale cleanup and exit codes.
 * `npm test` builds first; these tests are skipped if dist/ is missing.
 */

interface Result {
  code: number | null;
  stdout: string;
  stderr: string;
}

let env: NodeJS.ProcessEnv;
let dir: string;
let file: string;

function cli(args: string[], extraEnv: NodeJS.ProcessEnv = {}): Promise<Result> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [DIST_CLI, ...args], {
      env: { ...env, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString()));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

interface ShareJson {
  id: string;
  url: string;
  file: string;
  size_bytes: number;
  sha256: string;
  expires_at: string;
  pid: number;
}

async function detach(args: string[], extraEnv: NodeJS.ProcessEnv = {}): Promise<ShareJson> {
  const result = await cli(['share', ...args, '--json', '--detach'], extraEnv);
  expect(result.code, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as ShareJson;
}

async function statusJson(id: string) {
  const result = await cli(['status', id, '--json']);
  return { code: result.code, json: JSON.parse(result.stdout || '{}') as Record<string, unknown> };
}

beforeAll(async () => {
  dir = await makeTempDir();
  file = path.join(dir, 'hello.txt');
  await writeFile(file, 'hello\n');
  env = {
    ...process.env,
    FSHARE_HOME: await makeTempDir('fshare-home-'),
    FSHARE_CLOUDFLARED: FAKE_CLOUDFLARED,
    FSHARE_SKIP_PROBE: '1',
    NO_COLOR: '1',
  };
  delete env.FORCE_COLOR;
  delete env.FSHARE_PASSWORD;
});

afterEach(async () => {
  await cli(['stop', '--all']);
});

afterAll(cleanupTempDirs);

describe.skipIf(!existsSync(DIST_CLI) || process.platform === 'win32')('built CLI', () => {
  it('runs a detached share through its whole lifecycle', async () => {
    const share = await detach([file, '--expires', '10m']);
    expect(share).toMatchObject({ file: 'hello.txt', size_bytes: 6 });
    expect(Object.keys(share).slice(0, 6)).toEqual([
      'id',
      'url',
      'file',
      'size_bytes',
      'sha256',
      'expires_at',
    ]);
    expect(isProcessAlive(share.pid)).toBe(true);

    const stateFile = path.join(env.FSHARE_HOME ?? '', 'shares', `${share.id}.json`);
    expect((await stat(stateFile)).mode & 0o777).toBe(0o600);

    const status = await statusJson(share.id);
    const port = status.json.local_port as number;
    const res = await httpRequest(port, new URL(share.url).pathname);
    expect(res.body.toString()).toBe('hello\n');
    await waitFor(async () => (await statusJson(share.id)).json.download_count === 1);

    const list = await cli(['list', '--json']);
    expect((JSON.parse(list.stdout) as Array<{ id: string }>).map((s) => s.id)).toEqual([share.id]);
    const table = await cli(['list']);
    expect(table.stdout).toContain(share.id);
    expect(table.stdout).toContain('hello.txt');

    const { cloudflaredPid } = JSON.parse(await readFile(stateFile, 'utf8')) as {
      cloudflaredPid: number;
    };
    const stopped = await cli(['stop', share.id, '--json']);
    expect(stopped.code).toBe(0);
    expect(JSON.parse(stopped.stdout)).toEqual({ stopped: [{ id: share.id, file: 'hello.txt' }] });
    expect(isProcessAlive(share.pid)).toBe(false);
    await waitFor(() => !isProcessAlive(cloudflaredPid));
    expect(existsSync(stateFile)).toBe(false);

    // The background log exists and never contains the token.
    const token = new URL(share.url).pathname.split('/')[1] ?? '';
    const log = await readFile(path.join(env.FSHARE_HOME ?? '', 'logs', `${share.id}.log`), 'utf8');
    expect(log).toContain('is live');
    expect(log).not.toContain(token);
  });

  it('prints only the URL on stdout in human mode', async () => {
    const result = await cli(['share', file, '--detach']);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^https:\/\/\S+\/hello\.txt\n$/);
    expect(result.stderr).toContain('Sharing hello.txt');
    expect(result.stderr).toMatch(/stop [a-f0-9]{6}/);
  });

  it('cleans up after a share process is killed with SIGKILL', async () => {
    const folder = path.join(dir, 'album');
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, 'a.txt'), 'a');
    const share = await detach([folder]);
    const state = JSON.parse(
      await readFile(path.join(env.FSHARE_HOME ?? '', 'shares', `${share.id}.json`), 'utf8'),
    ) as { tempDir: string; cloudflaredPid: number };
    expect(existsSync(state.tempDir)).toBe(true);

    process.kill(share.pid, 'SIGKILL');
    await waitFor(() => !isProcessAlive(share.pid));
    const list = await cli(['list', '--json']);
    expect(JSON.parse(list.stdout)).toEqual([]);
    expect(existsSync(state.tempDir)).toBe(false);
    await waitFor(() => !isProcessAlive(state.cloudflaredPid));
  });

  it('stops by itself after --max-downloads', async () => {
    const share = await detach([file, '--max-downloads', '1']);
    const { json } = await statusJson(share.id);
    await httpRequest(json.local_port as number, new URL(share.url).pathname);
    await waitFor(() => !isProcessAlive(share.pid), 10_000);
    expect((await cli(['status', share.id])).code).toBe(3);
  });

  it('stops by itself when the link expires', async () => {
    const share = await detach([file, '--expires', '2s']);
    await waitFor(() => !isProcessAlive(share.pid), 10_000);
    expect(JSON.parse((await cli(['list', '--json'])).stdout)).toEqual([]);
  });

  it('keeps the password out of the process list', async () => {
    const share = await detach([file, '--password', 'p4ss-w0rd-xyz']);
    expect(await processCommand(share.pid)).not.toContain('p4ss-w0rd-xyz');
    const { json } = await statusJson(share.id);
    expect(json.password_protected).toBe(true);
    const port = json.local_port as number;
    const pathname = new URL(share.url).pathname;
    expect((await httpRequest(port, pathname)).status).toBe(401);
    const auth = `Basic ${Buffer.from('fshare:p4ss-w0rd-xyz').toString('base64')}`;
    expect((await httpRequest(port, pathname, { headers: { Authorization: auth } })).status).toBe(
      200,
    );
  });

  it('stops every share with --all', async () => {
    const a = await detach([file]);
    const b = await detach([file]);
    const result = await cli(['stop', '--all', '--json']);
    const ids = (JSON.parse(result.stdout) as { stopped: Array<{ id: string }> }).stopped.map(
      (s) => s.id,
    );
    expect(ids.sort()).toEqual([a.id, b.id].sort());
    expect(isProcessAlive(a.pid) || isProcessAlive(b.pid)).toBe(false);
  });

  it('reports tunnel failures with exit code 5 (background and foreground)', async () => {
    const detached = await cli(['share', file, '--json', '--detach'], {
      FAKE_CLOUDFLARED_MODE: 'fail',
    });
    expect(detached.code).toBe(5);
    expect(JSON.parse(detached.stdout)).toMatchObject({
      error: { code: 'TUNNEL_FAILED', exit_code: 5 },
    });
    const foreground = await cli(['share', file], { FAKE_CLOUDFLARED_MODE: 'fail' });
    expect(foreground.code).toBe(5);
    expect(foreground.stderr).toMatch(/quick tunnel/);
  });

  it('exits 5 if cloudflared dies while sharing', async () => {
    const result = await cli(['share', file], { FAKE_CLOUDFLARED_MODE: 'die-after-ready' });
    expect(result.code).toBe(5);
    expect(result.stdout).toMatch(/^https:\/\//);
    expect(result.stderr).toMatch(/cloudflared exited unexpectedly/);
  });

  it('stops a foreground share cleanly on Ctrl+C', async () => {
    const child = spawn(process.execPath, [DIST_CLI, 'share', file], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString()));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
    await waitFor(() => stdout.includes('\n'), 10_000);
    expect(JSON.parse((await cli(['list', '--json'])).stdout)).toHaveLength(1);
    const exit = new Promise<number | null>((resolve) => child.on('close', resolve));
    child.kill('SIGINT');
    expect(await exit).toBe(0);
    expect(stderr).toContain('Stopped sharing.');
    expect(JSON.parse((await cli(['list', '--json'])).stdout)).toEqual([]);
  });

  it('prints the version from package.json', async () => {
    const pkg = JSON.parse(
      await readFile(path.join(path.dirname(DIST_CLI), '..', 'package.json'), 'utf8'),
    ) as { version: string };
    expect((await cli(['--version'])).stdout).toBe(`${pkg.version}\n`);
  });
});
