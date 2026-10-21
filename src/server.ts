import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { Readable, pipeline } from 'node:stream';
import { BASIC_AUTH_USER, createBasicAuthChecker, safeEqual } from './auth.js';
import { parseRange } from './range.js';

export interface ServedFile {
  path: string;
  /** Download filename; also the last URL path segment. */
  name: string;
  size: number;
  mtimeMs: number;
  sha256: string;
}

export type ServerEvent =
  | { type: 'download-started'; ip: string; start: number; end: number; partial: boolean }
  | { type: 'download-completed'; ip: string; bytes: number; counted: boolean; count: number }
  | { type: 'download-aborted'; ip: string }
  | { type: 'auth-failed'; ip: string }
  | { type: 'preview-bot-blocked'; ip: string; userAgent: string }
  | { type: 'file-changed' };

export interface ShareServerOptions {
  file: ServedFile;
  token: string;
  password: string | null;
  maxDownloads: number | null;
  /** Epoch milliseconds. Defaults to never; the share runner sets it once the link is live. */
  expiresAt?: number;
  onEvent?: (event: ServerEvent) => void;
  /** Called once the download limit is reached and no downloads are in progress. */
  onLimitReached?: () => void;
  /** Called once when a request arrives after the expiry time. */
  onExpired?: () => void;
  now?: () => number;
}

export interface ShareServer {
  readonly server: http.Server;
  readonly downloadCount: number;
  readonly activeDownloads: number;
  listen(): Promise<number>;
  close(): Promise<void>;
  setExpiresAt(epochMs: number): void;
}

const CONTENT_TYPES: Record<string, string> = {
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.json': 'application/json',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.tar': 'application/x-tar',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

export function contentTypeFor(name: string): string {
  return CONTENT_TYPES[path.extname(name).toLowerCase()] ?? 'application/octet-stream';
}

/** RFC 6266 Content-Disposition with an ASCII fallback and an RFC 5987 UTF-8 filename. */
export function contentDisposition(name: string): string {
  const fallback = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  if (fallback === name) return `attachment; filename="${name}"`;
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

/** Splits "/<token>/<name>" from a raw request target. Returns null for any other shape. */
export function parseTarget(rawUrl: string): { token: string; name: string } | null {
  const cut = rawUrl.search(/[?#]/);
  const pathname = cut === -1 ? rawUrl : rawUrl.slice(0, cut);
  if (!pathname.startsWith('/')) return null;
  const parts = pathname.split('/');
  if (parts.length !== 3) return null;
  const [, token = '', encodedName = ''] = parts;
  if (token === '' || encodedName === '') return null;
  try {
    return { token, name: decodeURIComponent(encodedName) };
  } catch {
    return null;
  }
}

/**
 * Chat apps fetch links to build previews. Refusing them keeps a --max-downloads link from
 * being used up by a bot, and keeps copies of the file off third-party preview servers.
 */
const PREVIEW_BOT =
  /slackbot|slack-imgproxy|discordbot|facebookexternalhit|facebot|twitterbot|linkedinbot|whatsapp|telegrambot|skypeuripreview|microsoftpreview|teamsbot|embedly|redditbot|pinterestbot|iframely|mastodon|bitlybot|googlebot|bingbot|applebot/i;

export function isPreviewBot(userAgent: string | undefined): boolean {
  return userAgent !== undefined && PREVIEW_BOT.test(userAgent);
}

const BASE_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; sandbox",
};

const AUTH_FAILURE_WINDOW_MS = 10 * 60_000;
const AUTH_FAILURE_LIMIT = 20;

function sendText(
  res: http.ServerResponse,
  status: number,
  body: string,
  headers: Record<string, string> = {},
): void {
  const buffer = Buffer.from(body, 'utf8');
  res.writeHead(status, {
    ...headers,
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': String(buffer.length),
  });
  res.end(buffer);
}

function clientIp(req: http.IncomingMessage): string {
  const forwarded = req.headers['cf-connecting-ip'];
  if (typeof forwarded === 'string' && forwarded !== '') return forwarded;
  return req.socket.remoteAddress ?? 'unknown';
}

export function createShareServer(options: ShareServerOptions): ShareServer {
  const { file, token, maxDownloads } = options;
  const now = options.now ?? Date.now;
  const checkAuth = options.password ? createBasicAuthChecker(options.password) : null;
  const etag = `"${file.sha256}"`;
  const lastModified = new Date(file.mtimeMs).toUTCString();
  const contentType = contentTypeFor(file.name);
  const authFailures = new Map<string, { count: number; since: number }>();

  let expiresAt = options.expiresAt ?? Number.POSITIVE_INFINITY;
  let downloadCount = 0;
  let activeDownloads = 0;
  let limitReached = false;
  let limitAnnounced = false;
  let expiredAnnounced = false;

  const emit = (event: ServerEvent): void => options.onEvent?.(event);

  const announceLimitIfIdle = (): void => {
    if (limitReached && activeDownloads === 0 && !limitAnnounced) {
      limitAnnounced = true;
      options.onLimitReached?.();
    }
  };

  const throttled = (ip: string): boolean => {
    const entry = authFailures.get(ip);
    if (!entry) return false;
    if (now() - entry.since > AUTH_FAILURE_WINDOW_MS) {
      authFailures.delete(ip);
      return false;
    }
    return entry.count >= AUTH_FAILURE_LIMIT;
  };

  const recordAuthFailure = (ip: string): void => {
    const entry = authFailures.get(ip);
    if (entry && now() - entry.since <= AUTH_FAILURE_WINDOW_MS) entry.count += 1;
    else authFailures.set(ip, { count: 1, since: now() });
    if (authFailures.size > 10_000) authFailures.clear();
  };

  async function serveFile(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    head: boolean,
    ip: string,
  ): Promise<void> {
    try {
      const info = await stat(file.path);
      if (info.size !== file.size || info.mtimeMs !== file.mtimeMs) throw new Error('changed');
    } catch {
      emit({ type: 'file-changed' });
      sendText(
        res,
        410,
        'The shared file changed or was removed after the link was created. Ask the sender to share it again.\n',
      );
      return;
    }

    let range = parseRange(req.headers.range, file.size);
    const ifRange = req.headers['if-range'];
    if (range.kind !== 'full' && ifRange !== undefined && ifRange !== etag) {
      if (ifRange !== lastModified) range = { kind: 'full' };
    }

    if (range.kind === 'unsatisfiable') {
      sendText(res, 416, 'Requested range not satisfiable.\n', {
        'Content-Range': `bytes */${file.size}`,
        'Accept-Ranges': 'bytes',
      });
      return;
    }

    const partial = range.kind === 'partial';
    const start = range.kind === 'partial' ? range.start : 0;
    const end = range.kind === 'partial' ? range.end : file.size - 1;
    const length = file.size === 0 ? 0 : end - start + 1;
    const headers: Record<string, string> = {
      'Content-Type': contentType,
      'Content-Length': String(length),
      'Content-Disposition': contentDisposition(file.name),
      'Accept-Ranges': 'bytes',
      ETag: etag,
      'Last-Modified': lastModified,
    };
    if (partial) headers['Content-Range'] = `bytes ${start}-${end}/${file.size}`;
    res.writeHead(partial ? 206 : 200, headers);

    if (head) {
      res.end();
      return;
    }

    // A download counts once the response containing the final byte has been fully sent.
    const reachesEnd = file.size === 0 || end === file.size - 1;
    activeDownloads += 1;
    emit({ type: 'download-started', ip, start, end, partial });
    const body = length === 0 ? Readable.from([]) : createReadStream(file.path, { start, end });
    // pipeline() handles backpressure and destroys the file stream if the client disconnects.
    pipeline(body, res, (err) => {
      activeDownloads -= 1;
      if (err) {
        emit({ type: 'download-aborted', ip });
      } else {
        if (reachesEnd) {
          downloadCount += 1;
          if (maxDownloads !== null && downloadCount >= maxDownloads) limitReached = true;
        }
        emit({
          type: 'download-completed',
          ip,
          bytes: length,
          counted: reachesEnd,
          count: downloadCount,
        });
      }
      announceLimitIfIdle();
    });
  }

  function handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    for (const [name, value] of Object.entries(BASE_HEADERS)) res.setHeader(name, value);

    const target = parseTarget(req.url ?? '');
    // Compare the token in constant time first; every wrong path gets the same 404.
    const tokenOk = target !== null && safeEqual(target.token, token);
    if (!target || !tokenOk || target.name !== file.name) {
      sendText(res, 404, 'Not found.\n');
      return;
    }

    const method = req.method ?? 'GET';
    if (method !== 'GET' && method !== 'HEAD') {
      sendText(res, 405, 'Method not allowed.\n', { Allow: 'GET, HEAD' });
      return;
    }

    if (now() >= expiresAt) {
      sendText(res, 410, 'This link has expired.\n');
      if (!expiredAnnounced) {
        expiredAnnounced = true;
        options.onExpired?.();
      }
      return;
    }

    const ip = clientIp(req);
    const userAgent = req.headers['user-agent'];
    if (isPreviewBot(userAgent)) {
      emit({ type: 'preview-bot-blocked', ip, userAgent: userAgent ?? '' });
      sendText(res, 403, 'Link previews are disabled for this download.\n');
      return;
    }

    if (checkAuth) {
      if (throttled(ip)) {
        sendText(res, 429, 'Too many wrong passwords. Try again later.\n', {
          'Retry-After': '600',
        });
        return;
      }
      if (!checkAuth(req.headers.authorization)) {
        recordAuthFailure(ip);
        emit({ type: 'auth-failed', ip });
        sendText(res, 401, `Password required (username: ${BASIC_AUTH_USER}).\n`, {
          'WWW-Authenticate': 'Basic realm="fshare", charset="UTF-8"',
        });
        return;
      }
    }

    if (limitReached) {
      sendText(res, 410, 'This link has reached its download limit.\n');
      return;
    }

    void serveFile(req, res, method === 'HEAD', ip).catch(() => {
      if (!res.headersSent) sendText(res, 500, 'Internal error.\n');
      else res.destroy();
    });
  }

  const server = http.createServer(handle);
  server.keepAliveTimeout = 5_000;
  server.headersTimeout = 30_000;

  return {
    server,
    get downloadCount() {
      return downloadCount;
    },
    get activeDownloads() {
      return activeDownloads;
    },
    setExpiresAt(epochMs: number) {
      expiresAt = epochMs;
    },
    listen() {
      return new Promise<number>((resolve, reject) => {
        server.once('error', reject);
        // Loopback only: the file is reachable from outside exclusively through the tunnel.
        server.listen(0, '127.0.0.1', () => {
          server.off('error', reject);
          resolve((server.address() as AddressInfo).port);
        });
      });
    },
    close() {
      return new Promise<void>((resolve) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}
