import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { FshareError } from '../src/errors.js';
import { isProcessAlive } from '../src/state.js';
import {
  extractTunnelUrl,
  isRegisteredLine,
  startTunnel,
  stripLogPrefix,
  tunnelFailureReason,
  type Tunnel,
} from '../src/tunnel.js';
import {
  CAN_RUN_FAKE_CLOUDFLARED,
  FAKE_CLOUDFLARED,
  cleanupTempDirs,
  makeTempDir,
} from './helpers.js';

const started: Tunnel[] = [];
afterEach(async () => {
  await Promise.all(started.splice(0).map((t) => t.stop()));
  delete process.env.FAKE_CLOUDFLARED_MODE;
  delete process.env.FAKE_CLOUDFLARED_ARGS_FILE;
});
afterAll(cleanupTempDirs);

describe('cloudflared output parsing', () => {
  it('extracts the quick tunnel URL from the banner', () => {
    const line =
      '2026-10-21T06:43:03Z INF |  https://semiconductor-add-videos-taught.trycloudflare.com                                 |';
    expect(extractTunnelUrl(line)).toBe(
      'https://semiconductor-add-videos-taught.trycloudflare.com',
    );
  });

  it('ignores the trycloudflare API endpoint', () => {
    expect(
      extractTunnelUrl(
        'ERR failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel": EOF',
      ),
    ).toBeNull();
  });

  it('recognizes registration and known failures', () => {
    expect(
      isRegisteredLine(
        '2026-10-21T06:43:03Z INF Registered tunnel connection connIndex=0 location=fra19 protocol=quic',
      ),
    ).toBe(true);
    expect(tunnelFailureReason('status_code="429 Too Many Requests"')).toMatch(/rate-limiting/);
    expect(tunnelFailureReason('INF Starting metrics server')).toBeNull();
    expect(stripLogPrefix('2026-10-21T06:43:03Z ERR boom')).toBe('ERR boom');
  });
});

describe.skipIf(!CAN_RUN_FAKE_CLOUDFLARED)('startTunnel (fake cloudflared)', () => {
  it('resolves with the URL once the connection is registered', async () => {
    const argsFile = path.join(await makeTempDir(), 'args.json');
    process.env.FAKE_CLOUDFLARED_ARGS_FILE = argsFile;
    const tunnel = await startTunnel({ bin: FAKE_CLOUDFLARED, port: 4321, protocol: 'http2' });
    started.push(tunnel);
    expect(tunnel.url).toMatch(/^https:\/\/fake-[a-z0-9]+-tunnel\.trycloudflare\.com$/);
    const args = JSON.parse(await readFile(argsFile, 'utf8')) as string[];
    expect(args).toEqual(
      expect.arrayContaining(['tunnel', '--url', 'http://127.0.0.1:4321', '--protocol', 'http2']),
    );
    const pid = tunnel.pid ?? 0;
    expect(isProcessAlive(pid)).toBe(true);
    await tunnel.stop();
    expect(isProcessAlive(pid)).toBe(false);
  });

  it('times out with exit code 5', async () => {
    process.env.FAKE_CLOUDFLARED_MODE = 'hang';
    const error = await startTunnel({
      bin: FAKE_CLOUDFLARED,
      port: 1,
      protocol: null,
      urlTimeoutMs: 300,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FshareError);
    expect((error as FshareError).exitCode).toBe(5);
    expect((error as FshareError).message).toMatch(/Timed out/);
    expect((error as FshareError).hint).toMatch(/--protocol http2/);
  });

  it('reports cloudflared errors', async () => {
    process.env.FAKE_CLOUDFLARED_MODE = 'fail';
    const error = (await startTunnel({ bin: FAKE_CLOUDFLARED, port: 1, protocol: null }).catch(
      (e: unknown) => e,
    )) as FshareError;
    expect(error.exitCode).toBe(5);
    expect(error.message).toMatch(/could not get a quick tunnel/);
    expect(error.message).toMatch(/no such host/);
  });

  it('explains rate limiting', async () => {
    process.env.FAKE_CLOUDFLARED_MODE = 'ratelimit';
    const error = (await startTunnel({ bin: FAKE_CLOUDFLARED, port: 1, protocol: null }).catch(
      (e: unknown) => e,
    )) as FshareError;
    expect(error.message).toMatch(/429/);
  });

  it('reports a missing binary with exit code 4', async () => {
    const error = (await startTunnel({
      bin: '/nonexistent/cloudflared',
      port: 1,
      protocol: null,
    }).catch((e: unknown) => e)) as FshareError;
    expect(error.exitCode).toBe(4);
  });

  it('can be cancelled', async () => {
    process.env.FAKE_CLOUDFLARED_MODE = 'hang';
    const controller = new AbortController();
    const promise = startTunnel({
      bin: FAKE_CLOUDFLARED,
      port: 1,
      protocol: null,
      signal: controller.signal,
    });
    controller.abort();
    await expect(promise).rejects.toThrow(/Cancelled/);
  });
});
