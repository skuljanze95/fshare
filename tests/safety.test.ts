import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  checkSensitiveName,
  checkSensitivePath,
  findSensitiveEntries,
  looksLikePrivateKey,
} from '../src/safety.js';
import { cleanupTempDirs, makeTempDir } from './helpers.js';

const home = '/Users/alice';
const mac = { home, platform: 'darwin' as const };
const linux = { home: '/home/bob', platform: 'linux' as const };
const windows = { home: 'C:\\Users\\carol', platform: 'win32' as const };
const file = { isDirectory: false };
const dir = { isDirectory: true };

afterAll(cleanupTempDirs);

describe('checkSensitivePath', () => {
  it.each([
    ['/Users/alice/.ssh/id_ed25519', file],
    ['/Users/alice/.ssh', dir],
    ['/Users/alice/.aws/credentials', file],
    ['/Users/alice/.gnupg', dir],
    ['/Users/alice/Library/Keychains/login.keychain-db', file],
    ['/Users/alice/Library/Application Support/x.db', file],
    ['/Users/alice/.config/gcloud/credentials.db', file],
    ['/Users/alice/.netrc', file],
    ['/Users/alice/.fshare/shares/abc123.json', file],
    ['/Users/alice/projects/app/.env', file],
    ['/Users/alice/projects/app/.env.production', file],
    ['/Users/alice/certs/server.pem', file],
    ['/Users/alice/certs/client.p12', file],
    ['/Users/alice/Downloads/id_rsa', file],
    ['/etc/shadow', file],
  ])('flags %s', (target, options) => {
    expect(checkSensitivePath(target, mac, options)).not.toBeNull();
  });

  it.each([
    ['/Users/alice', dir],
    ['/Users', dir],
    ['/', dir],
    ['/Users/alice/.config', dir],
  ])('flags folders that contain secrets: %s', (target, options) => {
    expect(checkSensitivePath(target, mac, options)?.reason).toMatch(/contains/);
  });

  it.each([
    ['/Users/alice/Documents/report.pdf', file],
    ['/Users/alice/Desktop/photos', dir],
    ['/Users/alice/projects/app/.env.example', file],
    ['/Users/alice/projects/app/.env.sample', file],
    ['/Users/alice/talk.key', file],
    ['/tmp/test.txt', file],
    ['/Users/alice/LibraryBooks/book.epub', file],
  ])('allows %s', (target, options) => {
    expect(checkSensitivePath(target, mac, options)).toBeNull();
  });

  it('is case-insensitive on macOS but not on Linux', () => {
    expect(checkSensitivePath('/Users/alice/.SSH/id_rsa', mac, file)).not.toBeNull();
    expect(checkSensitivePath('/home/bob/.SSH/notes.txt', linux, file)).toBeNull();
    expect(checkSensitivePath('/home/bob/.ssh/notes.txt', linux, file)).not.toBeNull();
  });

  it('explains why', () => {
    expect(checkSensitivePath('/Users/alice/.ssh/config', mac, file)?.reason).toBe(
      'it is inside ~/.ssh (SSH keys)',
    );
  });

  it('handles Windows paths, allowing the temp folder inside AppData', () => {
    expect(checkSensitivePath('C:\\Users\\carol\\.ssh\\id_ed25519', windows, file)?.reason).toBe(
      'it is inside ~\\.ssh (SSH keys)',
    );
    expect(
      checkSensitivePath('c:\\users\\CAROL\\AppData\\Roaming\\x.db', windows, file),
    ).not.toBeNull();
    expect(checkSensitivePath('C:\\Users\\carol', windows, dir)?.reason).toMatch(/contains/);
    expect(
      checkSensitivePath('C:\\Users\\carol\\AppData\\Local\\Temp\\report.pdf', windows, file),
    ).toBeNull();
    expect(
      checkSensitivePath('C:\\Users\\carol\\AppData\\Local\\Temp\\build', windows, dir),
    ).toBeNull();
    expect(
      checkSensitivePath('C:\\Users\\carol\\AppData\\Local\\Temp\\.env', windows, file),
    ).not.toBeNull();
    expect(checkSensitivePath('C:\\Users\\carol\\Documents\\report.pdf', windows, file)).toBeNull();
  });
});

describe('checkSensitiveName', () => {
  it('flags secrets by name', () => {
    expect(checkSensitiveName('.env')).not.toBeNull();
    expect(checkSensitiveName('.ENV.local')).not.toBeNull();
    expect(checkSensitiveName('key.pem')).not.toBeNull();
    expect(checkSensitiveName('.git-credentials')).not.toBeNull();
    expect(checkSensitiveName('.ssh')).not.toBeNull();
  });

  it('allows ordinary names', () => {
    expect(checkSensitiveName('environment.md')).toBeNull();
    expect(checkSensitiveName('.envrc.example')).toBeNull();
    expect(checkSensitiveName('.env.template')).toBeNull();
    expect(checkSensitiveName('pem')).toBeNull();
    expect(checkSensitiveName('slides.key')).toBeNull();
  });
});

describe('findSensitiveEntries', () => {
  it('finds sensitive files inside a folder', () => {
    const found = findSensitiveEntries([
      { rel: 'README.md', type: 'file' },
      { rel: 'app/.env', type: 'file' },
      { rel: 'app/.ssh', type: 'dir' },
      { rel: 'certs/tls.pem', type: 'file' },
    ]);
    expect(found.map((f) => f.rel)).toEqual(['app/.env', 'app/.ssh/', 'certs/tls.pem']);
  });

  it('respects the limit', () => {
    const entries = Array.from({ length: 20 }, (_, i) => ({
      rel: `k${i}.pem`,
      type: 'file' as const,
    }));
    expect(findSensitiveEntries(entries, 5)).toHaveLength(5);
  });
});

describe('looksLikePrivateKey', () => {
  it('detects PEM private keys but not other .key files', async () => {
    const dir = await makeTempDir();
    const key = path.join(dir, 'server.key');
    const keynote = path.join(dir, 'slides.key');
    await writeFile(
      key,
      '-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----\n',
    );
    await writeFile(keynote, Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]));
    expect(await looksLikePrivateKey(key)).toBe(true);
    expect(await looksLikePrivateKey(keynote)).toBe(false);
    expect(await looksLikePrivateKey(path.join(dir, 'missing.key'))).toBe(false);
  });
});
