import { parseCommandArgs } from '../args.js';
import { formatRelative } from '../duration.js';
import { ExitCode } from '../errors.js';
import { listHelp } from '../help.js';
import { Logger, printJson, type Io } from '../output.js';
import { cleanupStaleShares, shareJson, type ShareState } from '../state.js';

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function downloadsText(state: ShareState): string {
  return state.maxDownloads === null
    ? String(state.downloadCount)
    : `${state.downloadCount}/${state.maxDownloads}`;
}

export function expiresText(state: ShareState, now: number = Date.now()): string {
  const expires = Date.parse(state.expires);
  return expires <= now ? 'expired' : formatRelative(expires, now);
}

export async function listCommand(args: string[], io: Io): Promise<number> {
  const { values } = parseCommandArgs(args, { json: { type: 'boolean' } }, 'list');
  if (values.help) {
    io.stdout.write(listHelp());
    return ExitCode.OK;
  }
  const { live } = await cleanupStaleShares(io.env);

  if (values.json) {
    printJson(
      io,
      live.map((state) => shareJson(state)),
    );
    return ExitCode.OK;
  }
  if (live.length === 0) {
    new Logger(io).info('No active shares.');
    return ExitCode.OK;
  }

  const rows = [
    ['ID', 'FILE', 'DOWNLOADS', 'EXPIRES', 'URL'],
    ...live.map((s) => [s.id, truncate(s.name, 32), downloadsText(s), expiresText(s), s.url]),
  ];
  const widths = rows[0]!.map((_, col) => Math.max(...rows.map((row) => row[col]!.length)));
  for (const row of rows) {
    const line = row
      .map((cell, col) => (col === row.length - 1 ? cell : cell.padEnd(widths[col]!)))
      .join('  ');
    io.stdout.write(`${line}\n`);
  }
  return ExitCode.OK;
}
