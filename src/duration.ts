import { usageError } from './errors.js';

const UNIT_MS = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
} as const;

type Unit = keyof typeof UNIT_MS;

export const MIN_DURATION_MS = 1_000;
export const MAX_DURATION_MS = 30 * UNIT_MS.d;
export const DEFAULT_EXPIRES = '1h';

const EXAMPLES = 'Use a number followed by s, m, h or d, for example 30m, 2h, 1d or 1h30m.';

/**
 * Parses durations like "30m", "2h", "1d", "90s", "1.5h" or "1h30m" into milliseconds.
 * Throws a usage error (exit code 2) for anything else.
 */
export function parseDuration(input: string): number {
  const text = input.trim().toLowerCase();
  if (text === '') throw usageError('Duration must not be empty.', EXAMPLES);
  if (/^\d+(\.\d+)?$/.test(text)) {
    throw usageError(
      `Invalid duration "${input}": a unit is required.`,
      `Did you mean "${text}m" (minutes) or "${text}h" (hours)?`,
    );
  }

  const part = /(\d+(?:\.\d+)?)([smhd])/y;
  let total = 0;
  let index = 0;
  while (index < text.length) {
    part.lastIndex = index;
    const match = part.exec(text);
    if (!match) throw usageError(`Invalid duration "${input}".`, EXAMPLES);
    total += Number(match[1]) * UNIT_MS[match[2] as Unit];
    index = part.lastIndex;
  }

  total = Math.round(total);
  if (total < MIN_DURATION_MS) {
    throw usageError(`Duration "${input}" is too short; the minimum is 1s.`);
  }
  if (total > MAX_DURATION_MS) {
    throw usageError(`Duration "${input}" is too long; the maximum is 30d.`);
  }
  return total;
}

/**
 * Formats milliseconds for humans with sensible precision: seconds only below 10 minutes,
 * e.g. "45s", "2m 30s", "25m", "1h 30m", "1d 2h".
 */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 600) {
    const rest = seconds % 60;
    return rest === 0 ? `${Math.floor(seconds / 60)}m` : `${Math.floor(seconds / 60)}m ${rest}s`;
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 24 * 60) {
    const rest = minutes % 60;
    return rest === 0 ? `${Math.floor(minutes / 60)}h` : `${Math.floor(minutes / 60)}h ${rest}m`;
  }
  const hours = Math.round(minutes / 60);
  const rest = hours % 24;
  return rest === 0 ? `${Math.floor(hours / 24)}d` : `${Math.floor(hours / 24)}d ${rest}h`;
}

/** "in 59m" for future times, "5m ago" for past times. */
export function formatRelative(targetMs: number, nowMs: number = Date.now()): string {
  const delta = targetMs - nowMs;
  return delta >= 0 ? `in ${formatDuration(delta)}` : `${formatDuration(-delta)} ago`;
}

/**
 * Calls `onExpire` once the wall clock passes `expiresAt`. Re-checks at least every minute so
 * the expiry is honoured even if the computer slept (timers pause during sleep) and so long
 * durations never overflow setTimeout's 24.8-day limit.
 */
export function watchExpiry(
  expiresAt: number,
  onExpire: () => void,
  now: () => number = Date.now,
): () => void {
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  const check = (): void => {
    if (stopped) return;
    const remaining = expiresAt - now();
    if (remaining <= 0) {
      stopped = true;
      onExpire();
      return;
    }
    timer = setTimeout(check, Math.min(remaining, 60_000));
  };
  check();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
