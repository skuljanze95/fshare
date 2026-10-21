import { chmodSync, existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Io } from '../src/output.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const FAKE_CLOUDFLARED = path.join(ROOT, 'tests', 'fixtures', 'fake-cloudflared.mjs');
export const DIST_CLI = path.join(ROOT, 'dist', 'cli.js');

// Git preserves the executable bit, but be defensive (e.g. after a zip download of the repo).
if (existsSync(FAKE_CLOUDFLARED)) chmodSync(FAKE_CLOUDFLARED, 0o755);

const tempDirs: string[] = [];

export async function makeTempDir(prefix = 'fshare-test-'): Promise<string> {
  // realpath: on macOS os.tmpdir() is a symlink (/var -> /private/var).
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

export async function cleanupTempDirs(): Promise<void> {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
}

export interface CapturedIo extends Io {
  out(): string;
  err(): string;
}

export function captureIo(env: NodeJS.ProcessEnv = {}): CapturedIo {
  let out = '';
  let err = '';
  return {
    stdout: { write: (chunk: string) => (out += chunk) },
    stderr: { write: (chunk: string) => (err += chunk) },
    env: { PATH: process.env.PATH, HOME: process.env.HOME, NO_COLOR: '1', ...env },
    out: () => out,
    err: () => err,
  };
}

export interface HttpResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

export function httpRequest(
  port: number,
  requestPath: string,
  options: { method?: string; headers?: Record<string, string> } = {},
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: requestPath,
        method: options.method ?? 'GET',
        headers: options.headers,
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        );
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end();
  });
}

export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 5_000,
  intervalMs = 50,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Condition not met within ${timeoutMs}ms`);
}
