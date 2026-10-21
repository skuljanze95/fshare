import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseShareArgs } from '../src/commands/share.js';
import { main } from '../src/main.js';
import { ROOT, captureIo, cleanupTempDirs, makeTempDir } from './helpers.js';

const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
  version: string;
};

let dir: string;
let file: string;
let home: string;

beforeAll(async () => {
  dir = await makeTempDir();
  home = await makeTempDir('fshare-home-');
  file = path.join(dir, 'report.txt');
  await writeFile(file, 'hello\n');
  await writeFile(path.join(dir, '.env'), 'SECRET=1\n');
});
afterAll(cleanupTempDirs);

async function run(argv: string[], env: NodeJS.ProcessEnv = {}) {
  const io = captureIo({ FSHARE_HOME: home, ...env });
  const code = await main(argv, io);
  return { code, out: io.out(), err: io.err() };
}

describe('general', () => {
  it('prints the version', async () => {
    const result = await run(['--version']);
    expect(result).toMatchObject({ code: 0, out: `${pkg.version}\n` });
    expect((await run(['-v'])).out).toBe(`${pkg.version}\n`);
  });

  it('prints help with examples', async () => {
    const result = await run(['--help']);
    expect(result.code).toBe(0);
    expect(result.out).toContain('fshare share <path> [options]');
    expect(result.out).toContain('Examples');
    expect(result.out).not.toContain('__serve');
  });

  it('prints per-command help', async () => {
    for (const command of ['share', 'list', 'status', 'stop', 'doctor']) {
      const viaFlag = await run([command, '--help']);
      expect(viaFlag.code, command).toBe(0);
      expect(viaFlag.out).toContain(`Usage: fshare ${command}`);
      expect(viaFlag.out).toContain('Examples');
      expect((await run(['help', command])).out).toBe(viaFlag.out);
    }
  });

  it('exits 2 without a command', async () => {
    const result = await run([]);
    expect(result.code).toBe(2);
    expect(result.err).toContain('Usage');
  });

  it('exits 2 for unknown commands and suggests "share" for paths', async () => {
    expect((await run(['bogus'])).code).toBe(2);
    const result = await run(['./report.pdf']);
    expect(result.code).toBe(2);
    expect(result.err).toContain('fshare share ./report.pdf');
  });
});

describe('share argument validation', () => {
  it.each([
    [['share']],
    [['share', 'a', 'b']],
    [['share', 'FILE', '--expires', 'soon']],
    [['share', 'FILE', '--expires', '45d']],
    [['share', 'FILE', '--max-downloads', '0']],
    [['share', 'FILE', '--max-downloads', 'two']],
    [['share', 'FILE', '--protocol', 'tcp']],
    [['share', 'FILE', '--name', 'a/b.txt']],
    [['share', 'FILE', '--name', '']],
    [['share', 'FILE', '--password', '']],
    [['share', 'FILE', '--bogus']],
    [['share', 'FILE', '--expires']],
  ])('%j exits 2', async (argv) => {
    const result = await run(argv.map((a) => (a === 'FILE' ? file : a)));
    expect(result.code).toBe(2);
    expect(result.err).toMatch(/error:/);
  });

  it('exits 3 for a missing file, with a JSON error in --json mode', async () => {
    const result = await run(['share', path.join(dir, 'missing.pdf'), '--json']);
    expect(result.code).toBe(3);
    const json = JSON.parse(result.out) as { error: { code: string; exit_code: number } };
    expect(json.error).toMatchObject({ code: 'NOT_FOUND', exit_code: 3 });
  });

  it('refuses sensitive files without --force (exit 2)', async () => {
    const result = await run(['share', path.join(dir, '.env')]);
    expect(result.code).toBe(2);
    expect(result.err).toMatch(/Refusing to share/);
    expect(result.err).toMatch(/--force/);
  });

  it('exits 4 when cloudflared is missing', async () => {
    const result = await run(['share', file], { FSHARE_CLOUDFLARED: '/nonexistent/cloudflared' });
    expect(result.code).toBe(4);
    expect(result.err).toMatch(/FSHARE_CLOUDFLARED/);
  });

  it('applies defaults and reads FSHARE_PASSWORD', () => {
    const parsed = parseShareArgs(['./x'], { FSHARE_PASSWORD: 'from-env' });
    expect(parsed).toEqual({
      help: false,
      request: {
        inputPath: './x',
        expiresMs: 3_600_000,
        maxDownloads: null,
        password: 'from-env',
        name: null,
        json: false,
        detach: false,
        keepAwake: false,
        force: false,
        protocol: null,
      },
    });
    const explicit = parseShareArgs(
      ['./x', '--password=pw', '--max-downloads', '3', '--expires=2h', '--json', '--detach'],
      { FSHARE_PASSWORD: 'ignored' },
    );
    expect(explicit.help ? null : explicit.request).toMatchObject({
      password: 'pw',
      maxDownloads: 3,
      expiresMs: 7_200_000,
      json: true,
      detach: true,
    });
  });
});

describe('list / status / stop', () => {
  it('list --json prints an empty array when nothing is shared', async () => {
    expect(await run(['list', '--json'])).toMatchObject({ code: 0, out: '[]\n' });
    const human = await run(['list']);
    expect(human.code).toBe(0);
    expect(human.err).toContain('No active shares.');
  });

  it('status and stop report unknown ids with exit 3', async () => {
    expect((await run(['status', 'abcdef'])).code).toBe(3);
    expect((await run(['stop', 'abcdef'])).code).toBe(3);
    expect((await run(['stop', '../../etc'])).code).toBe(3);
  });

  it('status and stop validate their arguments', async () => {
    expect((await run(['status'])).code).toBe(2);
    expect((await run(['stop'])).code).toBe(2);
    expect((await run(['stop', '--all', 'abcdef'])).code).toBe(2);
  });

  it('stop --all succeeds with nothing to stop', async () => {
    expect(await run(['stop', '--all', '--json'])).toMatchObject({
      code: 0,
      out: '{"stopped":[]}\n',
    });
  });
});
