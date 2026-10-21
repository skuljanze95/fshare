import { spawn } from 'node:child_process';
import dns from 'node:dns';
import https from 'node:https';
import readline from 'node:readline';
import { CancelledError, FshareError, errnoCode } from './errors.js';
import { sleep } from './util.js';

/** Matches the quick tunnel URL cloudflared prints. Excludes api.trycloudflare.com (the API). */
export const QUICK_TUNNEL_URL = /https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/;

export const URL_TIMEOUT_MS = 20_000;
export const REGISTER_TIMEOUT_MS = 20_000;

const TIMEOUT_HINT =
  'Check your internet connection. If your network blocks QUIC (UDP port 7844), retry with --protocol http2. Run "fshare doctor" to diagnose.';

export function extractTunnelUrl(line: string): string | null {
  return QUICK_TUNNEL_URL.exec(line)?.[0] ?? null;
}

export function isRegisteredLine(line: string): boolean {
  return /Registered tunnel connection/i.test(line);
}

/** Recognizes fatal cloudflared messages and turns them into a friendly explanation. */
export function tunnelFailureReason(line: string): string | null {
  if (/429|too many requests/i.test(line)) {
    return 'Cloudflare is rate-limiting new quick tunnels from your network (HTTP 429). Wait a few minutes and try again.';
  }
  if (/failed to (request|unmarshal) quick tunnel/i.test(line)) {
    return 'cloudflared could not get a quick tunnel from trycloudflare.com.';
  }
  return null;
}

/** Removes cloudflared's "2026-10-21T06:42:57Z INF " prefix. */
export function stripLogPrefix(line: string): string {
  return line.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s+/, '');
}

export interface StartTunnelOptions {
  bin: string;
  port: number;
  protocol: 'quic' | 'http2' | null;
  urlTimeoutMs?: number;
  registerTimeoutMs?: number;
  signal?: AbortSignal;
  /** Receives every line cloudflared logs (useful for debug logs). */
  onLine?: (line: string) => void;
}

export interface Tunnel {
  /** Base URL, e.g. https://random-words.trycloudflare.com */
  url: string;
  pid: number | null;
  /** Resolves when cloudflared exits for any reason. */
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  recentOutput(): string[];
  stop(): Promise<void>;
  /** Last-resort synchronous kill, safe to call from a process 'exit' handler. */
  killSync(): void;
}

/**
 * Starts `cloudflared tunnel --url http://127.0.0.1:<port>` and resolves once the public URL is
 * known and the first tunnel connection is registered.
 */
export function startTunnel(options: StartTunnelOptions): Promise<Tunnel> {
  const args = ['tunnel', '--no-autoupdate', '--grace-period', '1s'];
  if (options.protocol) args.push('--protocol', options.protocol);
  args.push('--url', `http://127.0.0.1:${options.port}`);

  // On POSIX, give cloudflared its own process group so a Ctrl+C in the terminal reaches only
  // fshare, which then shuts cloudflared down in order (instead of racing its own shutdown).
  const child = spawn(options.bin, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    detached: process.platform !== 'win32',
  });
  const recent: string[] = [];
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
    child.once('error', () => resolve({ code: null, signal: null }));
  });
  const isRunning = (): boolean => child.exitCode === null && child.signalCode === null;

  const tunnel = (url: string): Tunnel => ({
    url,
    pid: child.pid ?? null,
    exited,
    recentOutput: () => [...recent],
    async stop() {
      if (!isRunning()) return;
      child.kill('SIGTERM');
      const outcome = await Promise.race([exited.then(() => 'exited'), sleep(3_000)]);
      if (outcome !== 'exited' && isRunning()) {
        child.kill('SIGKILL');
        await exited;
      }
    },
    killSync() {
      if (isRunning()) {
        try {
          child.kill('SIGKILL');
        } catch {
          // already gone
        }
      }
    },
  });

  return new Promise<Tunnel>((resolve, reject) => {
    let url: string | null = null;
    let registered = false;
    let knownFailure: string | null = null;
    let settled = false;
    let registerTimer: NodeJS.Timeout | undefined;

    const errorLines = (): string => {
      const lines = recent
        .map(stripLogPrefix)
        .filter((l) => /^(ERR|WRN|FTL)\b|error/i.test(l))
        .slice(-3);
      return lines.length > 0 ? `\ncloudflared said:\n  ${lines.join('\n  ')}` : '';
    };

    const finish = (err: Error | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(urlTimer);
      clearTimeout(registerTimer);
      options.signal?.removeEventListener('abort', onAbort);
      if (err) {
        if (isRunning()) child.kill('SIGKILL');
        reject(err);
      } else if (url) {
        resolve(tunnel(url));
      }
    };

    const urlTimer = setTimeout(() => {
      finish(
        new FshareError(
          'TUNNEL_FAILED',
          `Timed out after ${Math.round((options.urlTimeoutMs ?? URL_TIMEOUT_MS) / 1000)}s waiting for cloudflared to create a tunnel.${errorLines()}`,
          { hint: knownFailure ?? TIMEOUT_HINT },
        ),
      );
    }, options.urlTimeoutMs ?? URL_TIMEOUT_MS);

    const onAbort = (): void => finish(new CancelledError());
    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    options.signal?.addEventListener('abort', onAbort, { once: true });

    const onLine = (line: string): void => {
      recent.push(line);
      if (recent.length > 50) recent.shift();
      options.onLine?.(line);
      knownFailure ??= tunnelFailureReason(line);
      if (!url) {
        const found = extractTunnelUrl(line);
        if (found) {
          url = found;
          clearTimeout(urlTimer);
          registerTimer = setTimeout(() => {
            finish(
              new FshareError(
                'TUNNEL_FAILED',
                `cloudflared created ${found} but could not connect to Cloudflare within ${Math.round((options.registerTimeoutMs ?? REGISTER_TIMEOUT_MS) / 1000)}s.${errorLines()}`,
                { hint: TIMEOUT_HINT },
              ),
            );
          }, options.registerTimeoutMs ?? REGISTER_TIMEOUT_MS);
        }
      }
      if (isRegisteredLine(line)) registered = true;
      if (url && registered) finish(null);
    };

    readline.createInterface({ input: child.stderr }).on('line', onLine);
    readline.createInterface({ input: child.stdout }).on('line', onLine);

    child.once('error', (err) => {
      finish(
        errnoCode(err) === 'ENOENT'
          ? new FshareError('CLOUDFLARED_MISSING', `cloudflared not found at ${options.bin}.`)
          : new FshareError('TUNNEL_FAILED', `Could not start cloudflared: ${err.message}`),
      );
    });
    child.once('exit', (code, signal) => {
      // Let readline flush the final lines before reporting.
      setImmediate(() => {
        const how = signal ? `was killed (${signal})` : `exited with code ${String(code)}`;
        finish(
          new FshareError(
            'TUNNEL_FAILED',
            `${knownFailure ?? `cloudflared ${how} before the tunnel was ready.`}${errorLines()}`,
            { hint: TIMEOUT_HINT },
          ),
        );
      });
    });
  });
}

// ---------------------------------------------------------------------------------------------
// Reachability
// ---------------------------------------------------------------------------------------------

/**
 * Polls the trycloudflare.com authoritative nameservers until the new hostname exists.
 * Asking the system resolver too early would get an NXDOMAIN that it caches (60s TTL), which
 * would make the link look broken for a minute, so we ask the authoritative servers directly.
 */
async function waitForAuthoritativeDns(
  hostname: string,
  deadline: number,
  signal?: AbortSignal,
): Promise<'found' | 'unavailable' | 'timeout'> {
  let servers: string[];
  try {
    const names = await dns.promises.resolveNs('trycloudflare.com');
    const addresses = await Promise.all(
      names.slice(0, 3).map((name) => dns.promises.resolve4(name).catch(() => [] as string[])),
    );
    servers = addresses.flat().slice(0, 4);
  } catch {
    return 'unavailable';
  }
  if (servers.length === 0) return 'unavailable';

  const resolver = new dns.promises.Resolver({ timeout: 1_500, tries: 1 });
  resolver.setServers(servers);
  let networkErrors = 0;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    try {
      if ((await resolver.resolve4(hostname)).length > 0) return 'found';
    } catch (err) {
      const code = errnoCode(err);
      if (code !== 'ENOTFOUND' && code !== 'ENODATA') {
        networkErrors += 1;
        // Outbound DNS to external servers is blocked on some networks.
        if (networkErrors >= 3) return 'unavailable';
      }
    }
    await sleep(400);
  }
  return 'timeout';
}

function probe(url: string, authorization: string | undefined): Promise<number | string> {
  return new Promise((resolve) => {
    const req = https.request(
      url,
      {
        method: 'HEAD',
        agent: false,
        timeout: 5_000,
        headers: {
          'user-agent': 'fshare-readiness-probe',
          ...(authorization ? { authorization } : {}),
        },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (err) => resolve(errnoCode(err) ?? err.message));
    req.end();
  });
}

/**
 * Waits until the share URL answers through Cloudflare, so the link works the moment we print
 * it. Returns false if it could not be verified in time (the link may still work shortly).
 */
export async function waitUntilReachable(options: {
  url: string;
  authorization?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<boolean> {
  const deadline = Date.now() + (options.timeoutMs ?? 30_000);
  const hostname = new URL(options.url).hostname;
  const dnsState = await waitForAuthoritativeDns(hostname, deadline, options.signal);
  if (dnsState === 'unavailable') await sleep(2_000);
  while (Date.now() < deadline) {
    options.signal?.throwIfAborted();
    if ((await probe(options.url, options.authorization)) === 200) return true;
    await sleep(750);
  }
  return false;
}
