import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { crc32, crc32Js, walkDir, writeZip, zipFolder } from '../src/zip.js';
import { cleanupTempDirs, makeTempDir } from './helpers.js';

const hasCommand = (cmd: string): boolean => {
  try {
    execFileSync('which', [cmd], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};
const HAS_UNZIP = process.platform !== 'win32' && hasCommand('unzip');
const HAS_ZIP = process.platform !== 'win32' && hasCommand('zip');

let root: string;
let outside: string;
const big = randomBytes(300_000);

beforeAll(async () => {
  const base = await makeTempDir();
  root = path.join(base, 'My Photos');
  outside = path.join(base, 'outside-secret.txt');
  await writeFile(outside, 'must not be included');
  await mkdir(path.join(root, 'sub', 'deeper'), { recursive: true });
  await mkdir(path.join(root, 'empty-dir'));
  await writeFile(path.join(root, 'a.txt'), 'alpha\n');
  await writeFile(path.join(root, '.hidden'), 'hidden\n');
  await writeFile(path.join(root, 'empty.txt'), '');
  await writeFile(path.join(root, 'résumé ü.txt'), 'unicode\n');
  await writeFile(path.join(root, 'star*.txt'), 'wildcard\n');
  await writeFile(path.join(root, '-dash.txt'), 'dash\n');
  await writeFile(path.join(root, '[brackets].txt'), 'brackets\n');
  await writeFile(path.join(root, 'sub', 'big.bin'), big);
  await writeFile(path.join(root, 'sub', 'deeper', 'z.txt'), 'zed\n');
  await symlink(outside, path.join(root, 'link-to-outside.txt'));
});
afterAll(cleanupTempDirs);

const EXPECTED_FILES = [
  '-dash.txt',
  '.hidden',
  '[brackets].txt',
  'a.txt',
  'empty.txt',
  'résumé ü.txt',
  'star*.txt',
  'sub/big.bin',
  'sub/deeper/z.txt',
];

async function listFiles(dir: string, prefix = ''): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) result.push(...(await listFiles(path.join(dir, entry.name), rel)));
    else result.push(rel);
  }
  return result.sort();
}

async function verifyArchive(zipPath: string): Promise<void> {
  execFileSync('unzip', ['-tq', zipPath]);
  const extractTo = await makeTempDir('fshare-unzip-');
  execFileSync('unzip', ['-q', zipPath, '-d', extractTo]);
  const top = path.join(extractTo, 'My Photos');
  expect((await listFiles(top)).map((f) => f.normalize('NFC'))).toEqual(EXPECTED_FILES);
  expect(existsSync(path.join(top, 'empty-dir'))).toBe(true);
  expect(existsSync(path.join(top, 'link-to-outside.txt'))).toBe(false);
  expect(await readFile(path.join(top, 'a.txt'), 'utf8')).toBe('alpha\n');
  expect(await readFile(path.join(top, 'star*.txt'), 'utf8')).toBe('wildcard\n');
  expect(Buffer.compare(await readFile(path.join(top, 'sub', 'big.bin')), big)).toBe(0);
}

describe('crc32', () => {
  it('matches the standard check value', () => {
    expect(crc32Js(Buffer.from('123456789'))).toBe(0xcbf43926);
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
  });
  it('supports incremental updates', () => {
    const whole = crc32Js(Buffer.from('hello world'));
    expect(crc32Js(Buffer.from(' world'), crc32Js(Buffer.from('hello')))).toBe(whole);
  });
});

describe('walkDir', () => {
  it('lists files and folders, skipping symlinks', async () => {
    const result = await walkDir(root);
    expect(result.skippedLinks).toEqual(['link-to-outside.txt']);
    expect(result.fileCount).toBe(EXPECTED_FILES.length);
    expect(result.entries.filter((e) => e.type === 'dir').map((e) => e.rel)).toEqual([
      'empty-dir',
      'sub',
      'sub/deeper',
    ]);
    // Every directory appears before its contents.
    const index = (rel: string) => result.entries.findIndex((e) => e.rel === rel);
    expect(index('sub')).toBeLessThan(index('sub/big.bin'));
  });
});

describe.skipIf(!HAS_UNZIP)('zipFolder', () => {
  it.skipIf(!HAS_ZIP)('produces a valid archive with the system zip', async () => {
    const { entries } = await walkDir(root);
    const out = path.join(await makeTempDir(), 'out.zip');
    const result = await zipFolder({ root, entries, outPath: out });
    expect(result.method).toBe('zip');
    await verifyArchive(out);
  });

  it('produces a valid archive with the built-in writer', async () => {
    const { entries } = await walkDir(root);
    const out = path.join(await makeTempDir(), 'out.zip');
    const result = await zipFolder({ root, entries, outPath: out, forceBuiltin: true });
    expect(result.method).toBe('builtin');
    await verifyArchive(out);
  });

  it('writes valid ZIP64 structures', async () => {
    const { entries } = await walkDir(root);
    const out = path.join(await makeTempDir(), 'zip64.zip');
    await writeZip(
      [
        { name: 'My Photos/', type: 'dir', size: 0, mtime: new Date(), mode: 0o755 },
        ...entries.map((e) => ({
          name: e.type === 'dir' ? `My Photos/${e.rel}/` : `My Photos/${e.rel}`,
          abs: e.abs,
          type: e.type,
          size: e.size,
          mtime: e.mtime,
          mode: e.mode,
        })),
      ],
      out,
      { forceZip64: true },
    );
    await verifyArchive(out);
  });

  it('can be cancelled', async () => {
    const { entries } = await walkDir(root);
    const controller = new AbortController();
    controller.abort();
    const out = path.join(await makeTempDir(), 'cancelled.zip');
    await expect(
      zipFolder({ root, entries, outPath: out, forceBuiltin: true, signal: controller.signal }),
    ).rejects.toThrow();
  });
});
