import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findCloudflared } from '../../src/cloudflared.js';
import { DIST_CLI, cleanupTempDirs, makeTempDir } from '../helpers.js';

/**
 * End-to-end: real cloudflared, real Cloudflare quick tunnel, real HTTPS download.
 * Run with `npm run e2e`. Skipped automatically when cloudflared is not installed.
 */
const cloudflared = await findCloudflared();
let env: NodeJS.ProcessEnv;

function cli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [DIST_CLI, ...args], {
      env,
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

/** Quick tunnels occasionally need a moment longer than fshare's readiness check. */
async function fetchWithRetry(url: string, init: RequestInit = {}): Promise<Response> {
  const deadline = Date.now() + 30_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, init);
      if (res.status < 500) return res;
      lastError = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastError = err;
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw lastError;
}

const sha256 = (data: Buffer): string => createHash('sha256').update(data).digest('hex');

beforeAll(async () => {
  env = { ...process.env, FSHARE_HOME: await makeTempDir('fshare-e2e-home-'), NO_COLOR: '1' };
  delete env.FSHARE_SKIP_PROBE;
  delete env.FSHARE_CLOUDFLARED;
});

afterAll(async () => {
  if (env) await cli(['stop', '--all']);
  await cleanupTempDirs();
});

describe.skipIf(!cloudflared || !existsSync(DIST_CLI))('e2e: real Cloudflare quick tunnel', () => {
  it('shares a file, downloads it through the tunnel, verifies SHA-256 and stops', async () => {
    const dir = await makeTempDir();
    const file = path.join(dir, 'e2e test file.bin');
    const content = randomBytes(256 * 1024);
    await writeFile(file, content);

    const shared = await cli(['share', file, '--json', '--detach', '--expires', '10m']);
    expect(shared.code, shared.stderr).toBe(0);
    const share = JSON.parse(shared.stdout) as { id: string; url: string; sha256: string };
    expect(share.url).toMatch(/^https:\/\/[a-z0-9-]+\.trycloudflare\.com\/[A-Za-z0-9_-]{32}\//);
    expect(share.sha256).toBe(sha256(content));

    const res = await fetchWithRetry(share.url);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toContain('attachment');
    expect(sha256(Buffer.from(await res.arrayBuffer()))).toBe(share.sha256);

    const partial = await fetchWithRetry(share.url, { headers: { Range: 'bytes=0-9' } });
    expect(partial.status).toBe(206);
    expect(Buffer.from(await partial.arrayBuffer())).toEqual(content.subarray(0, 10));

    const wrongPath = await fetchWithRetry(share.url.replace(/\/[^/]+$/, '/other.bin'));
    expect(wrongPath.status).toBe(404);

    const list = JSON.parse((await cli(['list', '--json'])).stdout) as Array<{ id: string }>;
    expect(list.map((s) => s.id)).toContain(share.id);

    const stopped = await cli(['stop', share.id]);
    expect(stopped.code).toBe(0);
    expect((await cli(['status', share.id])).code).toBe(3);
  });

  it('shares a password-protected folder as a zip', async () => {
    const dir = await makeTempDir();
    const folder = path.join(dir, 'e2e-folder');
    await mkdir(path.join(folder, 'nested'), { recursive: true });
    await writeFile(path.join(folder, 'nested', 'a.txt'), 'hello from a folder\n');

    const shared = await cli([
      'share',
      folder,
      '--json',
      '--detach',
      '--password',
      'e2e-secret',
      '--max-downloads',
      '1',
    ]);
    expect(shared.code, shared.stderr).toBe(0);
    const share = JSON.parse(shared.stdout) as { id: string; url: string; file: string };
    expect(share.file).toBe('e2e-folder.zip');

    expect((await fetchWithRetry(share.url)).status).toBe(401);
    const res = await fetchWithRetry(share.url, {
      headers: { Authorization: `Basic ${Buffer.from('fshare:e2e-secret').toString('base64')}` },
    });
    expect(res.status).toBe(200);
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.subarray(0, 2).toString()).toBe('PK');
  });
});
