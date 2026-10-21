import { spawn, type ChildProcess } from 'node:child_process';
import { which } from './util.js';

export interface KeepAwake {
  method: string;
  stop(): void;
}

/**
 * Prevents idle sleep while a share is active:
 * - macOS: `caffeinate -i -w <pid>` (also exits on its own when fshare exits)
 * - Linux: `systemd-inhibit` running `sleep` for the share duration
 * Returns null (and fshare prints a warning) where neither is available.
 */
export async function startKeepAwake(options: {
  durationMs: number;
  onWarning: (message: string) => void;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}): Promise<KeepAwake | null> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  let child: ChildProcess;
  let method: string;

  if (platform === 'darwin' && (await which('caffeinate', env))) {
    method = 'caffeinate';
    child = spawn('caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' });
  } else if (platform === 'linux' && (await which('systemd-inhibit', env))) {
    method = 'systemd-inhibit';
    const seconds = String(Math.ceil(options.durationMs / 1000) + 60);
    child = spawn(
      'systemd-inhibit',
      [
        '--what=idle:sleep',
        '--who=fshare',
        '--why=Sharing a file',
        '--mode=block',
        'sleep',
        seconds,
      ],
      { stdio: 'ignore' },
    );
  } else {
    options.onWarning(
      platform === 'linux'
        ? '--keep-awake needs systemd-inhibit, which was not found. Keep the computer awake yourself.'
        : `--keep-awake is not supported on ${platform}. Keep the computer awake yourself.`,
    );
    return null;
  }

  let stopped = false;
  child.once('error', (err) => {
    if (!stopped) options.onWarning(`--keep-awake failed (${method}): ${err.message}`);
  });
  child.once('exit', (code) => {
    if (!stopped && code !== 0 && code !== null) {
      options.onWarning(`--keep-awake stopped early (${method} exited with code ${code}).`);
    }
  });
  return {
    method,
    stop() {
      stopped = true;
      if (child.exitCode === null && child.signalCode === null) child.kill();
    },
  };
}
