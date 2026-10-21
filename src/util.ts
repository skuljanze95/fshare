import { constants as fsConstants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = unit === 0 ? String(value) : value.toFixed(value < 10 ? 1 : 0);
  return `${rounded} ${units[unit]}`;
}

/** ISO 8601 without milliseconds, e.g. 2026-10-21T12:00:00Z. */
export function isoSeconds(date: Date | number): string {
  return new Date(date).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Human-friendly local timestamp, e.g. "2026-10-21 14:00". */
export function localTime(date: Date | number): string {
  const d = new Date(date);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function homeDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.HOME && process.platform !== 'win32' ? env.HOME : os.homedir();
}

/** Replaces the home directory prefix with "~" for display. */
export function tildify(p: string, home: string = homeDir()): string {
  if (p === home) return '~';
  if (p.startsWith(home + path.sep)) return `~${p.slice(home.length)}`;
  return p;
}

/** Expands a leading "~" (agents sometimes pass quoted paths the shell never expanded). */
export function expandHome(p: string, home: string = homeDir()): string {
  if (p === '~') return home;
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(home, p.slice(2));
  return p;
}

export async function isExecutableFile(file: string): Promise<boolean> {
  try {
    const info = await stat(file);
    if (!info.isFile()) return false;
    if (process.platform === 'win32') return true;
    await access(file, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Minimal cross-platform `which`. Returns an absolute path or null. */
export async function which(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<string | null> {
  const dirs = (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean);
  const extensions =
    platform === 'win32'
      ? ['', ...(env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').map((e) => e.toLowerCase())]
      : [''];
  for (const dir of dirs) {
    for (const ext of extensions) {
      const candidate = path.join(dir, command + ext);
      if (await isExecutableFile(candidate)) return candidate;
    }
  }
  return null;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The command users should type to run fshare again, based on how it was launched. */
export function invocationPrefix(
  packageName: string,
  env: NodeJS.ProcessEnv = process.env,
  argv1: string = process.argv[1] ?? '',
): string {
  const script = argv1.replace(/\\/g, '/');
  if (env.npm_command === 'exec' || script.includes('/_npx/')) return `npx ${packageName}`;
  if (script.includes('/dlx/') || script.includes('/dlx-')) return `pnpm dlx ${packageName}`;
  if (script.includes('/bunx-')) return `bunx ${packageName}`;
  return 'fshare';
}
