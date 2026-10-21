import { doctorCommand } from './commands/doctor.js';
import { listCommand } from './commands/list.js';
import { serveCommand } from './commands/serve.js';
import { shareCommand } from './commands/share.js';
import { statusCommand } from './commands/status.js';
import { stopCommand } from './commands/stop.js';
import { ExitCode, usageError } from './errors.js';
import { COMMAND_HELP, mainHelp } from './help.js';
import { VERSION } from './meta.js';
import { defaultIo, reportError, type Io } from './output.js';

const COMMANDS = new Map<string, (args: string[], io: Io) => Promise<number>>([
  ['share', shareCommand],
  ['list', listCommand],
  ['ls', listCommand],
  ['status', statusCommand],
  ['stop', stopCommand],
  ['doctor', doctorCommand],
  ['__serve', (_args, io) => serveCommand(io)],
]);

function unknownCommandHint(command: string): string {
  if (/[./\\~]/.test(command)) return `To share a file, run: fshare share ${command}`;
  return 'Run "fshare --help" to see the available commands.';
}

/** Runs the CLI and returns the exit code. Never calls process.exit (testable). */
export async function main(argv: string[], io: Io = defaultIo()): Promise<number> {
  const json = argv.includes('--json');
  try {
    const [command, ...rest] = argv;
    if (command === undefined) {
      io.stderr.write(mainHelp());
      return ExitCode.USAGE;
    }
    if (command === '-h' || command === '--help') {
      io.stdout.write(mainHelp());
      return ExitCode.OK;
    }
    if (command === '-v' || command === '--version') {
      io.stdout.write(`${VERSION}\n`);
      return ExitCode.OK;
    }
    if (command === 'help') {
      const topic = rest[0];
      if (topic === undefined) {
        io.stdout.write(mainHelp());
        return ExitCode.OK;
      }
      const help = COMMAND_HELP.get(topic);
      if (!help) throw usageError(`Unknown command "${topic}".`, unknownCommandHint(topic));
      io.stdout.write(help());
      return ExitCode.OK;
    }
    const run = COMMANDS.get(command);
    if (!run) throw usageError(`Unknown command "${command}".`, unknownCommandHint(command));
    return await run(rest, io);
  } catch (err) {
    return reportError(io, err, json);
  }
}
