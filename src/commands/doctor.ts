import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { parseCommandArgs } from '../args.js';
import {
  CLOUDFLARED_DOWNLOADS_URL,
  cloudflaredInstallHint,
  findCloudflared,
  getCloudflaredVersion,
} from '../cloudflared.js';
import { ExitCode, errnoCode } from '../errors.js';
import { doctorHelp } from '../help.js';
import { VERSION } from '../meta.js';
import { createStyler, colorEnabled, printJson, type Io } from '../output.js';
import { ensureStateDirs, fshareHome } from '../state.js';
import { homeDir, tildify, which } from '../util.js';

export interface Check {
  id: string;
  status: 'pass' | 'warn' | 'fail';
  message: string;
  fix?: string;
}

const MIN_NODE_MAJOR = 18;

function checkNode(): Check {
  const major = Number(process.versions.node.split('.')[0]);
  return major >= MIN_NODE_MAJOR
    ? {
        id: 'node',
        status: 'pass',
        message: `Node.js ${process.versions.node} (${MIN_NODE_MAJOR} or newer required)`,
      }
    : {
        id: 'node',
        status: 'fail',
        message: `Node.js ${process.versions.node} is too old (${MIN_NODE_MAJOR} or newer required)`,
        fix: 'Install the current LTS from https://nodejs.org',
      };
}

async function checkCloudflared(env: NodeJS.ProcessEnv): Promise<Check> {
  const bin = await findCloudflared(env);
  if (!bin) {
    return {
      id: 'cloudflared',
      status: 'fail',
      message: env.FSHARE_CLOUDFLARED
        ? `cloudflared not found at FSHARE_CLOUDFLARED=${env.FSHARE_CLOUDFLARED}`
        : 'cloudflared is not installed (or not on PATH)',
      fix: `${cloudflaredInstallHint()}\nAll downloads: ${CLOUDFLARED_DOWNLOADS_URL}`,
    };
  }
  const version = await getCloudflaredVersion(bin);
  const where = tildify(bin, homeDir(env));
  if (version === null) {
    return {
      id: 'cloudflared',
      status: 'fail',
      message: `cloudflared was found at ${where} but could not be run`,
      fix: `Reinstall cloudflared. ${cloudflaredInstallHint()}`,
    };
  }
  const year = Number(/^(\d{4})\./.exec(version)?.[1] ?? '0');
  if (year > 0 && year < 2024) {
    return {
      id: 'cloudflared',
      status: 'warn',
      message: `cloudflared ${version} (${where}) is old; quick tunnels may not work`,
      fix: 'Update cloudflared (macOS: brew upgrade cloudflared).',
    };
  }
  return { id: 'cloudflared', status: 'pass', message: `cloudflared ${version} (${where})` };
}

async function checkZip(env: NodeJS.ProcessEnv): Promise<Check> {
  if (process.platform === 'win32') {
    return {
      id: 'zip',
      status: 'pass',
      message: 'Folders are zipped with the built-in ZIP writer',
    };
  }
  const zip = await which('zip', env);
  return zip
    ? { id: 'zip', status: 'pass', message: `zip (${zip})` }
    : {
        id: 'zip',
        status: 'warn',
        message: 'zip not found; folders will be zipped with the slower built-in ZIP writer',
        fix: 'Optional: install zip (e.g. sudo apt install zip).',
      };
}

function checkHttps(host: string): Promise<Check> {
  return new Promise((resolve) => {
    const req = https.request(
      { host, path: '/', method: 'GET', timeout: 7_000, agent: false },
      (res) => {
        res.resume();
        resolve({ id: 'network', status: 'pass', message: `Network: reached ${host}` });
      },
    );
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', (err) =>
      resolve({
        id: 'network',
        status: 'fail',
        message: `Network: cannot reach ${host} (${errnoCode(err) ?? err.message})`,
        fix: 'Check your internet connection, VPN, proxy or firewall.',
      }),
    );
    req.end();
  });
}

function checkTunnelPort(): Promise<Check> {
  const host = 'region1.v2.argotunnel.com';
  return new Promise((resolve) => {
    const socket = net.connect({ host, port: 7844, timeout: 5_000 });
    const done = (check: Check): void => {
      socket.destroy();
      resolve(check);
    };
    socket.once('connect', () =>
      done({
        id: 'tunnel-port',
        status: 'pass',
        message: 'Network: outbound port 7844 to Cloudflare is open',
      }),
    );
    const blocked = (reason: string): void =>
      done({
        id: 'tunnel-port',
        status: 'warn',
        message: `Network: could not connect to Cloudflare on port 7844 (${reason}); tunnels may fail on this network`,
        fix: 'Try another network, or ask your network admin to allow outbound TCP and UDP port 7844.',
      });
    socket.once('timeout', () => blocked('timed out'));
    socket.once('error', (err) => blocked(errnoCode(err) ?? err.message));
  });
}

async function checkStateDir(env: NodeJS.ProcessEnv): Promise<Check> {
  const dir = fshareHome(env);
  const shown = tildify(dir, homeDir(env));
  try {
    await ensureStateDirs(env);
    const probe = path.join(dir, `.doctor-${process.pid}`);
    await writeFile(probe, 'ok', { mode: 0o600 });
    await rm(probe, { force: true });
    return { id: 'state-dir', status: 'pass', message: `State directory is writable (${shown})` };
  } catch (err) {
    return {
      id: 'state-dir',
      status: 'fail',
      message: `State directory ${shown} is not writable (${errnoCode(err) ?? String(err)})`,
      fix: `Fix the permissions of ${shown}, or set FSHARE_HOME to a writable directory.`,
    };
  }
}

async function checkTempDir(): Promise<Check> {
  try {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'fshare-'));
    await rm(dir, { recursive: true, force: true });
    return { id: 'temp-dir', status: 'pass', message: 'Temporary directory is writable' };
  } catch (err) {
    return {
      id: 'temp-dir',
      status: 'fail',
      message: `Temporary directory ${os.tmpdir()} is not writable (${errnoCode(err) ?? String(err)})`,
      fix: 'Set TMPDIR (TEMP on Windows) to a writable directory. Needed for sharing folders.',
    };
  }
}

export async function runChecks(env: NodeJS.ProcessEnv): Promise<Check[]> {
  return Promise.all([
    Promise.resolve(checkNode()),
    checkCloudflared(env),
    checkZip(env),
    checkHttps('api.trycloudflare.com'),
    checkTunnelPort(),
    checkStateDir(env),
    checkTempDir(),
  ]);
}

export async function doctorCommand(args: string[], io: Io): Promise<number> {
  const { values } = parseCommandArgs(args, { json: { type: 'boolean' } }, 'doctor');
  if (values.help) {
    io.stdout.write(doctorHelp());
    return ExitCode.OK;
  }
  const checks = await runChecks(io.env);
  const failed = checks.filter((c) => c.status === 'fail');
  const exitCode = failed.some((c) => c.id === 'cloudflared')
    ? ExitCode.CLOUDFLARED_MISSING
    : failed.length > 0
      ? ExitCode.ERROR
      : ExitCode.OK;

  if (values.json) {
    printJson(io, { ok: failed.length === 0, version: VERSION, checks });
    return exitCode;
  }

  const s = createStyler(colorEnabled(io.stdout, io.env));
  const label = { pass: s.green('PASS'), warn: s.yellow('WARN'), fail: s.red('FAIL') };
  io.stdout.write(`fshare doctor (v${VERSION})\n\n`);
  for (const check of checks) {
    io.stdout.write(`  ${label[check.status]}  ${check.message}\n`);
    if (check.fix && check.status !== 'pass') {
      for (const line of check.fix.split('\n')) io.stdout.write(`        ${s.dim(line)}\n`);
    }
  }
  io.stdout.write('\n');
  if (failed.length === 0) {
    io.stdout.write(`${s.green('All required checks passed.')} Try: fshare share ./some-file\n`);
  } else {
    io.stdout.write(
      `${s.red(`${failed.length} check(s) failed.`)} Fix the problems above, then run "fshare doctor" again.\n`,
    );
  }
  return exitCode;
}
