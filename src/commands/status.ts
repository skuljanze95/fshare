import { parseCommandArgs } from '../args.js';
import { formatRelative } from '../duration.js';
import { ExitCode, FshareError, usageError } from '../errors.js';
import { statusHelp } from '../help.js';
import { printJson, type Io } from '../output.js';
import { cleanupStaleShares, readShareState, shareJson } from '../state.js';
import { formatBytes, homeDir, localTime, tildify } from '../util.js';

export async function statusCommand(args: string[], io: Io): Promise<number> {
  const { values, positionals } = parseCommandArgs(args, { json: { type: 'boolean' } }, 'status');
  if (values.help) {
    io.stdout.write(statusHelp());
    return ExitCode.OK;
  }
  const [id, ...extra] = positionals;
  if (id === undefined) {
    throw usageError(
      'Missing share id.',
      'Usage: fshare status <id>. Run "fshare list" to see ids.',
    );
  }
  if (extra.length > 0) throw usageError('fshare status takes exactly one share id.');

  await cleanupStaleShares(io.env);
  const state = await readShareState(id, io.env);
  if (!state) {
    throw new FshareError('NOT_FOUND', `No active share with id "${id}".`, {
      hint: 'Run "fshare list" to see active shares.',
    });
  }

  if (values.json) {
    printJson(io, shareJson(state));
    return ExitCode.OK;
  }

  const home = homeDir(io.env);
  const created = Date.parse(state.created);
  const expires = Date.parse(state.expires);
  const lines: Array<[string, string]> = [
    ['ID', state.id],
    ['URL', state.url],
    ['File', `${state.name} (${formatBytes(state.sizeBytes)})`],
    ['Source', `${tildify(state.path, home)}${state.isFolder ? ' (folder, sent as .zip)' : ''}`],
    ['SHA-256', state.sha256],
    ['Created', `${localTime(created)} (${formatRelative(created)})`],
    [
      'Expires',
      `${localTime(expires)} (${expires <= Date.now() ? 'expired' : formatRelative(expires)})`,
    ],
    [
      'Downloads',
      state.maxDownloads === null
        ? `${state.downloadCount} (no limit)`
        : `${state.downloadCount} of ${state.maxDownloads}`,
    ],
    ['Password', state.passwordProtected ? 'yes (username: fshare)' : 'no'],
    ['Process', `pid ${state.pid} (${state.detached ? 'background' : 'foreground'})`],
  ];
  if (state.logFile) lines.push(['Log', tildify(state.logFile, home)]);
  for (const [label, value] of lines) io.stdout.write(`${label.padEnd(11)}${value}\n`);
  return ExitCode.OK;
}
