import { createHash, randomBytes } from 'node:crypto';
import { stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import {
  contentDisposition,
  createShareServer,
  parseTarget,
  type ServerEvent,
  type ShareServer,
  type ShareServerOptions,
} from '../src/server.js';
import { cleanupTempDirs, httpRequest, makeTempDir, waitFor } from './helpers.js';

const TOKEN = 'tok_0123456789abcdefghijklmnopqrstu';
const servers: ShareServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});
afterAll(cleanupTempDirs);

async function setup(
  content: Buffer | string,
  options: Partial<ShareServerOptions> & { name?: string } = {},
) {
  const dir = await makeTempDir();
  const name = options.name ?? 'report.pdf';
  const filePath = path.join(dir, name);
  await writeFile(filePath, content);
  const info = await stat(filePath);
  const events: ServerEvent[] = [];
  const onLimitReached = vi.fn();
  const onExpired = vi.fn();
  const sha256 = createHash('sha256').update(content).digest('hex');
  const share = createShareServer({
    file: { path: filePath, name, size: info.size, mtimeMs: info.mtimeMs, sha256 },
    token: TOKEN,
    password: null,
    maxDownloads: null,
    onEvent: (e) => events.push(e),
    onLimitReached,
    onExpired,
    ...options,
  });
  servers.push(share);
  const port = await share.listen();
  const url = `/${TOKEN}/${encodeURIComponent(name)}`;
  return { share, port, url, filePath, events, onLimitReached, onExpired, sha256 };
}

describe('parseTarget', () => {
  it('splits token and decoded name', () => {
    expect(parseTarget('/abc/my%20file.txt?x=1')).toEqual({ token: 'abc', name: 'my file.txt' });
  });
  it.each(['/', '/abc', '/abc/', '//x', '/a/b/c', 'http://evil/a/b', '/a/%E0%A4%A'])(
    'rejects %j',
    (input) => {
      expect(parseTarget(input)).toBeNull();
    },
  );
});

describe('contentDisposition', () => {
  it('uses a plain filename for ASCII names', () => {
    expect(contentDisposition('report.pdf')).toBe('attachment; filename="report.pdf"');
  });
  it('adds an RFC 5987 filename for non-ASCII or quote characters', () => {
    expect(contentDisposition('résumé "v2".pdf')).toBe(
      `attachment; filename="r_sum_ _v2_.pdf"; filename*=UTF-8''r%C3%A9sum%C3%A9%20%22v2%22.pdf`,
    );
  });
});

describe('share server', () => {
  it('serves the file with safe headers', async () => {
    const { port, url, sha256 } = await setup('hello world');
    const res = await httpRequest(port, url);
    expect(res.status).toBe(200);
    expect(res.body.toString()).toBe('hello world');
    expect(res.headers['content-length']).toBe('11');
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toBe('attachment; filename="report.pdf"');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['accept-ranges']).toBe('bytes');
    expect(res.headers.etag).toBe(`"${sha256}"`);
  });

  it('returns 404 for every other path, without hinting why', async () => {
    const { port } = await setup('secret');
    for (const p of [
      '/',
      `/${TOKEN}`,
      `/${TOKEN}/`,
      `/${TOKEN}/other.pdf`,
      `/${TOKEN}/report.pdf/extra`,
      `/${TOKEN}/../${TOKEN}/report.pdf`,
      `/${TOKEN.slice(0, -1)}/report.pdf`,
      '/robots.txt',
    ]) {
      const res = await httpRequest(port, p);
      expect(res.status, p).toBe(404);
      expect(res.body.toString()).toBe('Not found.\n');
    }
  });

  it('ignores query strings and decodes percent-encoded names', async () => {
    const { port, url } = await setup('ü', { name: 'my résumé.txt' });
    expect((await httpRequest(port, `${url}?download=1`)).status).toBe(200);
    const res = await httpRequest(port, url);
    expect(res.headers['content-disposition']).toContain(
      "filename*=UTF-8''my%20r%C3%A9sum%C3%A9.txt",
    );
  });

  it('answers HEAD without a body and without counting a download', async () => {
    const { share, port, url } = await setup('0123456789');
    const res = await httpRequest(port, url, { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(res.headers['content-length']).toBe('10');
    expect(res.body.length).toBe(0);
    expect(share.downloadCount).toBe(0);
  });

  it('rejects other methods with 405', async () => {
    const { port, url } = await setup('x');
    const res = await httpRequest(port, url, { method: 'POST' });
    expect(res.status).toBe(405);
    expect(res.headers.allow).toBe('GET, HEAD');
  });

  describe('Range requests', () => {
    const content = '0123456789abcdefghij'; // 20 bytes

    it('serves a single range with 206', async () => {
      const { port, url } = await setup(content);
      const res = await httpRequest(port, url, { headers: { Range: 'bytes=2-5' } });
      expect(res.status).toBe(206);
      expect(res.body.toString()).toBe('2345');
      expect(res.headers['content-range']).toBe('bytes 2-5/20');
      expect(res.headers['content-length']).toBe('4');
    });

    it('serves suffix and open-ended ranges', async () => {
      const { port, url } = await setup(content);
      expect(
        (await httpRequest(port, url, { headers: { Range: 'bytes=-3' } })).body.toString(),
      ).toBe('hij');
      expect(
        (await httpRequest(port, url, { headers: { Range: 'bytes=15-' } })).body.toString(),
      ).toBe('fghij');
    });

    it('answers HEAD with Range like GET would', async () => {
      const { port, url } = await setup(content);
      const res = await httpRequest(port, url, { method: 'HEAD', headers: { Range: 'bytes=0-0' } });
      expect(res.status).toBe(206);
      expect(res.headers['content-range']).toBe('bytes 0-0/20');
    });

    it('returns 416 for unsatisfiable or invalid ranges', async () => {
      const { port, url } = await setup(content);
      for (const range of ['bytes=20-', 'bytes=50-60', 'bytes=9-3', 'bytes=x-y']) {
        const res = await httpRequest(port, url, { headers: { Range: range } });
        expect(res.status, range).toBe(416);
        expect(res.headers['content-range']).toBe('bytes */20');
      }
    });

    it('serves the full file for multiple ranges', async () => {
      const { port, url } = await setup(content);
      const res = await httpRequest(port, url, { headers: { Range: 'bytes=0-1,4-5' } });
      expect(res.status).toBe(200);
      expect(res.body.toString()).toBe(content);
    });

    it('honours If-Range', async () => {
      const { port, url, sha256 } = await setup(content);
      const match = await httpRequest(port, url, {
        headers: { Range: 'bytes=0-1', 'If-Range': `"${sha256}"` },
      });
      expect(match.status).toBe(206);
      const mismatch = await httpRequest(port, url, {
        headers: { Range: 'bytes=0-1', 'If-Range': '"something-else"' },
      });
      expect(mismatch.status).toBe(200);
      expect(mismatch.body.toString()).toBe(content);
    });

    it('counts a download only when the final byte is sent', async () => {
      const { share, port, url } = await setup(content);
      // The count is updated when the server finishes sending, which can be a tick after the
      // client has read the body, hence waitFor.
      await httpRequest(port, url, { headers: { Range: 'bytes=0-9' } });
      await waitFor(() => share.activeDownloads === 0);
      expect(share.downloadCount).toBe(0);
      await httpRequest(port, url, { headers: { Range: 'bytes=10-' } });
      await waitFor(() => share.downloadCount === 1);
      await httpRequest(port, url);
      await waitFor(() => share.downloadCount === 2);
    });
  });

  it('does not count an aborted download', async () => {
    const big = randomBytes(8 * 1024 * 1024);
    const { share, port, url, events } = await setup(big);
    await new Promise<void>((resolve) => {
      const req = http.get({ host: '127.0.0.1', port, path: url, agent: false }, (res) => {
        res.once('data', () => {
          req.destroy();
          resolve();
        });
      });
      req.on('error', () => resolve());
    });
    await waitFor(() => events.some((e) => e.type === 'download-aborted'));
    expect(share.downloadCount).toBe(0);
    expect(share.activeDownloads).toBe(0);
  });

  it('streams large files intact', async () => {
    const big = randomBytes(12 * 1024 * 1024 + 7);
    const { port, url } = await setup(big);
    const res = await httpRequest(port, url);
    expect(res.status).toBe(200);
    expect(createHash('sha256').update(res.body).digest('hex')).toBe(
      createHash('sha256').update(big).digest('hex'),
    );
  });

  it('serves empty files and counts them', async () => {
    const { share, port, url } = await setup('');
    const res = await httpRequest(port, url);
    expect(res.status).toBe(200);
    expect(res.headers['content-length']).toBe('0');
    await waitFor(() => share.downloadCount === 1);
  });

  describe('password protection', () => {
    const auth = (pw: string, user = 'fshare') =>
      `Basic ${Buffer.from(`${user}:${pw}`).toString('base64')}`;

    it('requires the right credentials', async () => {
      const { port, url } = await setup('private', { password: 'hunter2' });
      const none = await httpRequest(port, url);
      expect(none.status).toBe(401);
      expect(none.headers['www-authenticate']).toBe('Basic realm="fshare", charset="UTF-8"');
      expect(
        (await httpRequest(port, url, { headers: { Authorization: auth('nope') } })).status,
      ).toBe(401);
      expect(
        (await httpRequest(port, url, { headers: { Authorization: auth('hunter2', 'admin') } }))
          .status,
      ).toBe(401);
      const ok = await httpRequest(port, url, { headers: { Authorization: auth('hunter2') } });
      expect(ok.status).toBe(200);
      expect(ok.body.toString()).toBe('private');
    });

    it('still returns 404 (not 401) for wrong paths', async () => {
      const { port } = await setup('private', { password: 'hunter2' });
      expect((await httpRequest(port, '/wrong/report.pdf')).status).toBe(404);
    });

    it('throttles repeated wrong passwords', async () => {
      const { port, url } = await setup('private', { password: 'hunter2' });
      for (let i = 0; i < 20; i += 1) {
        await httpRequest(port, url, { headers: { Authorization: auth(`guess${i}`) } });
      }
      const res = await httpRequest(port, url, { headers: { Authorization: auth('hunter2') } });
      expect(res.status).toBe(429);
    });
  });

  it('stops after --max-downloads and returns 410 afterwards', async () => {
    const { port, url, onLimitReached } = await setup('once', { maxDownloads: 1 });
    expect((await httpRequest(port, url)).status).toBe(200);
    await waitFor(() => onLimitReached.mock.calls.length === 1);
    const again = await httpRequest(port, url);
    expect(again.status).toBe(410);
    expect(again.body.toString()).toMatch(/download limit/);
    expect(onLimitReached).toHaveBeenCalledOnce();
  });

  it('returns 410 after expiry and reports it once', async () => {
    const { share, port, url, onExpired } = await setup('late');
    share.setExpiresAt(Date.now() - 1);
    const res = await httpRequest(port, url);
    expect(res.status).toBe(410);
    expect(res.body.toString()).toMatch(/expired/);
    await httpRequest(port, url);
    expect(onExpired).toHaveBeenCalledOnce();
    expect((await httpRequest(port, '/nope/x')).status).toBe(404);
  });

  it('refuses to serve a file that changed after sharing', async () => {
    const { port, url, filePath, events } = await setup('version 1');
    await writeFile(filePath, 'version 2 is longer');
    const res = await httpRequest(port, url);
    expect(res.status).toBe(410);
    expect(events.some((e) => e.type === 'file-changed')).toBe(true);
  });

  it('refuses link-preview bots so they cannot use up downloads', async () => {
    const { share, port, url } = await setup('x', { maxDownloads: 1 });
    const res = await httpRequest(port, url, {
      headers: { 'User-Agent': 'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)' },
    });
    expect(res.status).toBe(403);
    expect(share.downloadCount).toBe(0);
    expect((await httpRequest(port, url, { headers: { 'User-Agent': 'curl/8.7.1' } })).status).toBe(
      200,
    );
  });

  it('listens on loopback only', async () => {
    const { share } = await setup('x');
    const address = share.server.address();
    expect(typeof address === 'object' && address?.address).toBe('127.0.0.1');
  });
});
