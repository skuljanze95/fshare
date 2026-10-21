import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { FshareError } from './errors.js';
import { isExecutableFile, which } from './util.js';

export const CLOUDFLARED_DOWNLOADS_URL =
  'https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/';

function fallbackLocations(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  if (platform === 'darwin') {
    return ['/opt/homebrew/bin/cloudflared', '/usr/local/bin/cloudflared'];
  }
  if (platform === 'win32') {
    const roots = [env['ProgramFiles(x86)'], env.ProgramFiles].filter(Boolean) as string[];
    const candidates = roots.map((root) => path.join(root, 'cloudflared', 'cloudflared.exe'));
    if (env.LOCALAPPDATA) {
      candidates.push(
        path.join(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', 'cloudflared.exe'),
      );
    }
    return candidates;
  }
  return [
    '/usr/local/bin/cloudflared',
    '/usr/bin/cloudflared',
    '/snap/bin/cloudflared',
    path.join(env.HOME ?? os.homedir(), '.local', 'bin', 'cloudflared'),
  ];
}

/**
 * Finds the cloudflared binary: $FSHARE_CLOUDFLARED, then PATH, then common install locations
 * (agents and GUI apps often run with a minimal PATH that misses Homebrew).
 */
export async function findCloudflared(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<string | null> {
  if (env.FSHARE_CLOUDFLARED) {
    return (await isExecutableFile(env.FSHARE_CLOUDFLARED)) ? env.FSHARE_CLOUDFLARED : null;
  }
  const onPath = await which('cloudflared', env, platform);
  if (onPath) return onPath;
  for (const candidate of fallbackLocations(env, platform)) {
    if (await isExecutableFile(candidate)) return candidate;
  }
  return null;
}

export function cloudflaredInstallHint(platform: NodeJS.Platform = process.platform): string {
  switch (platform) {
    case 'darwin':
      return 'Install it with: brew install cloudflared';
    case 'win32':
      return 'Install it with: winget install --id Cloudflare.cloudflared (then open a new terminal)';
    case 'linux':
      return `Install it from your package manager or ${CLOUDFLARED_DOWNLOADS_URL} (see the fshare README for copy-paste commands)`;
    default:
      return `Download it from ${CLOUDFLARED_DOWNLOADS_URL}`;
  }
}

export function cloudflaredMissingError(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): FshareError {
  if (env.FSHARE_CLOUDFLARED) {
    return new FshareError(
      'CLOUDFLARED_MISSING',
      `FSHARE_CLOUDFLARED is set to "${env.FSHARE_CLOUDFLARED}", which is not an executable file.`,
      { hint: 'Fix the path or unset FSHARE_CLOUDFLARED.' },
    );
  }
  return new FshareError('CLOUDFLARED_MISSING', 'cloudflared is not installed (or not on PATH).', {
    hint: cloudflaredInstallHint(platform),
  });
}

export async function requireCloudflared(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const bin = await findCloudflared(env);
  if (!bin) throw cloudflaredMissingError(env);
  return bin;
}

/** Returns e.g. "2026.10.2", or null if the binary could not be run. */
export function getCloudflaredVersion(bin: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(bin, ['--version'], { timeout: 10_000, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        resolve(null);
        return;
      }
      const match = /version\s+(\S+)/i.exec(`${stdout}\n${stderr}`);
      resolve(match?.[1] ?? 'unknown');
    });
  });
}
