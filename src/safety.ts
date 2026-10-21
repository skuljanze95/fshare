import { open } from 'node:fs/promises';
import path from 'node:path';

/**
 * Sensitive-path detection. fshare refuses to share these unless --force is passed.
 * This is a safety net against accidents (especially by AI agents), not a security boundary.
 */

export interface SafetyContext {
  home: string;
  platform: NodeJS.Platform;
}

export interface SensitiveMatch {
  /** Human-readable explanation, e.g. "it is inside ~/.ssh (SSH keys)". */
  reason: string;
}

/** Locations relative to the home directory. */
const HOME_LOCATIONS: ReadonlyArray<readonly [string, string]> = [
  ['.ssh', 'SSH keys'],
  ['.aws', 'AWS credentials'],
  ['.gnupg', 'GPG keys'],
  ['.azure', 'Azure credentials'],
  ['.kube', 'Kubernetes credentials'],
  ['.docker', 'Docker credentials'],
  ['.config/gcloud', 'Google Cloud credentials'],
  ['.config/gh', 'GitHub CLI tokens'],
  ['.password-store', 'passwords'],
  ['.local/share/keyrings', 'keychains'],
  ['.netrc', 'login credentials'],
  ['.npmrc', 'npm tokens'],
  ['.pypirc', 'PyPI tokens'],
  ['.git-credentials', 'Git credentials'],
  ['.fshare', "fshare's own state, which contains share tokens"],
  ['Library', 'macOS app data and keychains'],
  ['AppData', 'Windows app data and credentials'],
];

/** Ordinary folders inside the locations above: Windows keeps the temp folder in AppData. */
const HOME_EXCEPTIONS: readonly string[] = ['AppData/Local/Temp'];

/** Absolute system locations. */
const SYSTEM_LOCATIONS: ReadonlyArray<readonly [string, string]> = [
  ['/etc/shadow', 'system password hashes'],
  ['/etc/sudoers', 'system configuration'],
  ['/etc/ssh', 'SSH host keys'],
  ['/Library/Keychains', 'keychains'],
  ['/private/etc/ssh', 'SSH host keys'],
];

/** Directory names that are suspicious anywhere (e.g. inside a shared folder). */
const SENSITIVE_DIR_NAMES: ReadonlyMap<string, string> = new Map([
  ['.ssh', 'SSH keys'],
  ['.aws', 'AWS credentials'],
  ['.gnupg', 'GPG keys'],
]);

const SENSITIVE_FILE_NAMES: ReadonlyMap<string, string> = new Map([
  ['id_rsa', 'an SSH private key'],
  ['id_dsa', 'an SSH private key'],
  ['id_ecdsa', 'an SSH private key'],
  ['id_ed25519', 'an SSH private key'],
  ['id_ecdsa_sk', 'an SSH private key'],
  ['id_ed25519_sk', 'an SSH private key'],
  ['.netrc', 'login credentials'],
  ['.npmrc', 'npm tokens'],
  ['.pypirc', 'PyPI tokens'],
  ['.git-credentials', 'Git credentials'],
  ['.htpasswd', 'password hashes'],
]);

const SENSITIVE_EXTENSIONS: ReadonlyMap<string, string> = new Map([
  ['.pem', 'private keys or certificates'],
  ['.p12', 'private keys or certificates'],
  ['.pfx', 'private keys or certificates'],
  ['.ppk', 'private keys'],
  ['.jks', 'private keys'],
  ['.keystore', 'private keys'],
  ['.keychain', 'keychains'],
  ['.keychain-db', 'keychains'],
  ['.kdbx', 'a password database'],
]);

/** Harmless .env variants that are usually committed to repositories. */
const SAFE_ENV_SUFFIXES = new Set(['example', 'sample', 'template', 'dist', 'defaults']);

function caseInsensitive(platform: NodeJS.Platform): boolean {
  return platform === 'darwin' || platform === 'win32';
}

/** Path functions for the platform being checked, so results do not depend on the host. */
function pathFor(ctx: SafetyContext): path.PlatformPath {
  return ctx.platform === 'win32' ? path.win32 : path.posix;
}

function normalize(p: string, ctx: SafetyContext): string {
  const paths = pathFor(ctx);
  const resolved = paths.resolve(p).replace(/[\\/]+$/, '') || paths.sep;
  return caseInsensitive(ctx.platform) ? resolved.toLowerCase() : resolved;
}

function isInside(child: string, parent: string, ctx: SafetyContext): boolean {
  if (child === parent) return true;
  const { sep } = pathFor(ctx);
  const prefix = parent.endsWith(sep) ? parent : parent + sep;
  return child.startsWith(prefix);
}

function display(p: string, ctx: SafetyContext): string {
  if (p === ctx.home) return '~';
  return p.startsWith(ctx.home + pathFor(ctx).sep) ? `~${p.slice(ctx.home.length)}` : p;
}

/** Checks a single file or folder name (no path) against name-based rules. */
export function checkSensitiveName(name: string): SensitiveMatch | null {
  const lower = name.toLowerCase();
  if (lower === '.env' || lower.startsWith('.env.')) {
    const suffix = lower.slice('.env.'.length);
    if (lower === '.env' || !SAFE_ENV_SUFFIXES.has(suffix)) {
      return { reason: `"${name}" files usually contain secrets` };
    }
  }
  const byName = SENSITIVE_FILE_NAMES.get(lower);
  if (byName) return { reason: `"${name}" usually contains ${byName}` };
  const byDir = SENSITIVE_DIR_NAMES.get(lower);
  if (byDir) return { reason: `"${name}" usually contains ${byDir}` };
  for (const [ext, what] of SENSITIVE_EXTENSIONS) {
    if (lower.endsWith(ext) && lower.length > ext.length) {
      return { reason: `"*${ext}" files usually contain ${what}` };
    }
  }
  return null;
}

/**
 * Checks whether sharing `target` would expose a known sensitive location: either because the
 * target is inside one (~/.ssh/id_rsa) or because it contains one (sharing ~ or /).
 */
export function checkSensitivePath(
  target: string,
  ctx: SafetyContext,
  options: { isDirectory: boolean },
): SensitiveMatch | null {
  const paths = pathFor(ctx);
  const normalizedTarget = normalize(target, ctx);
  const isException = HOME_EXCEPTIONS.some((rel) =>
    isInside(normalizedTarget, normalize(paths.join(ctx.home, rel), ctx), ctx),
  );
  const locations = [
    ...HOME_LOCATIONS.map(([rel, what]) => [paths.join(ctx.home, rel), what] as const),
    ...(ctx.platform === 'win32' ? [] : SYSTEM_LOCATIONS),
  ];
  for (const [location, what] of isException ? [] : locations) {
    const normalizedLocation = normalize(location, ctx);
    if (isInside(normalizedTarget, normalizedLocation, ctx)) {
      return { reason: `it is inside ${display(location, ctx)} (${what})` };
    }
    if (options.isDirectory && isInside(normalizedLocation, normalizedTarget, ctx)) {
      return { reason: `it contains ${display(location, ctx)} (${what})` };
    }
  }
  return checkSensitiveName(paths.basename(target));
}

/**
 * ".key" is used both for private keys and for Apple Keynote documents, so instead of
 * blocking every .key file we look for a PEM private key header in the first few kilobytes.
 */
export async function looksLikePrivateKey(file: string): Promise<boolean> {
  let handle;
  try {
    handle = await open(file, 'r');
    const buffer = Buffer.alloc(4096);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(buffer.toString('latin1', 0, bytesRead));
  } catch {
    return false;
  } finally {
    await handle?.close();
  }
}

export interface FolderEntryLike {
  rel: string;
  type: 'file' | 'dir';
}

/** Scans relative paths inside a folder for sensitive names. Returns at most `limit` matches. */
export function findSensitiveEntries(
  entries: Iterable<FolderEntryLike>,
  limit = 5,
): Array<{ rel: string; reason: string }> {
  const found: Array<{ rel: string; reason: string }> = [];
  for (const entry of entries) {
    const match = checkSensitiveName(entry.rel.slice(entry.rel.lastIndexOf('/') + 1));
    if (match) {
      found.push({ rel: entry.type === 'dir' ? `${entry.rel}/` : entry.rel, reason: match.reason });
      if (found.length >= limit) break;
    }
  }
  return found;
}
