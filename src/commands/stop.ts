import { parseCommandArgs } from '../args.js';
import { ExitCode, FshareError, usageError } from '../errors.js';
import { stopHelp } from '../help.js';
import { Logger, printJson, type Io } from '../output.js';
import { cleanupStaleShares, stopShareProcess, type ShareState } from '../state.js';

export async function stopCommand(args: string[], io: Io): Promise<number> {
  const { values, positionals } = parseCommandArgs(
    args,
    { all: { type: 'boolean' }, json: { type: 'boolean' } },
    'stop',
  );
  if (values.help) {
    io.stdout.write(stopHelp());
    return ExitCode.OK;
  }
  if (!values.all && positionals.length === 0) {
    throw usageError(
      'Missing share id.',
      'Use "fshare stop <id>" or "fshare stop --all". Run "fshare list" to see ids.',
    );
  }
  if (values.all && positionals.length > 0) {
    throw usageError('Pass share ids or --all, not both.');
  }

  const { live } = await cleanupStaleShares(io.env);
  let targets: ShareState[];
  if (values.all) {
    targets = live;
  } else {
    targets = [];
    for (const id of positionals) {
      const state = live.find((s) => s.id === id);
      if (!state) {
        throw new FshareError('NOT_FOUND', `No active share with id "${id}".`, {
          hint: 'Run "fshare list" to see active shares.',
        });
      }
      if (!targets.includes(state)) targets.push(state);
    }
  }

  const logger = new Logger(io, { json: values.json ?? false });
  for (const state of targets) {
    await stopShareProcess(state, io.env);
    logger.info(`Stopped ${state.id} (${state.name}).`);
  }
  if (values.json) {
    printJson(io, { stopped: targets.map((s) => ({ id: s.id, file: s.name })) });
  } else if (targets.length === 0) {
    logger.info('No active shares.');
  }
  return ExitCode.OK;
}
