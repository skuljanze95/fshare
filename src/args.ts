import { parseArgs, type ParseArgsConfig } from 'node:util';
import { usageError } from './errors.js';

type Options = NonNullable<ParseArgsConfig['options']>;

/**
 * Strict parseArgs wrapper: unknown options and missing values become usage errors (exit 2)
 * with a pointer to the command's help.
 */
export function parseCommandArgs<T extends Options>(args: string[], options: T, command: string) {
  try {
    return parseArgs({
      args,
      options: { ...options, help: { type: 'boolean', short: 'h' } },
      allowPositionals: true,
      strict: true,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Node appends a long explanation after the first sentence; keep it short.
    const short = message.split('. ')[0]?.replace(/\.$/, '') ?? message;
    throw usageError(`${short}.`, `Run "fshare ${command} --help" for usage.`);
  }
}
