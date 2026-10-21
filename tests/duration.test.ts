import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  formatDuration,
  formatRelative,
  MAX_DURATION_MS,
  parseDuration,
  watchExpiry,
} from '../src/duration.js';
import { FshareError } from '../src/errors.js';

describe('parseDuration', () => {
  it.each([
    ['30m', 30 * 60_000],
    ['2h', 2 * 3_600_000],
    ['1d', 86_400_000],
    ['90s', 90_000],
    ['1h30m', 90 * 60_000],
    ['1.5h', 90 * 60_000],
    [' 10M ', 10 * 60_000],
    ['30d', MAX_DURATION_MS],
  ])('parses %j', (input, expected) => {
    expect(parseDuration(input)).toBe(expected);
  });

  it.each(['', '5', '5x', '-1h', 'h', '1h 30m', 'soon', '0m', '0.5s', '31d', '1w'])(
    'rejects %j with a usage error (exit code 2)',
    (input) => {
      let error: unknown;
      try {
        parseDuration(input);
      } catch (err) {
        error = err;
      }
      expect(error).toBeInstanceOf(FshareError);
      expect((error as FshareError).exitCode).toBe(2);
    },
  );

  it('suggests a unit for bare numbers', () => {
    expect(() => parseDuration('15')).toThrow(/unit is required/);
  });
});

describe('formatDuration', () => {
  it.each([
    [0, '0s'],
    [45_000, '45s'],
    [150_000, '2m 30s'],
    [180_000, '3m'],
    [25 * 60_000 + 20_000, '25m'],
    [3_599_000, '1h'],
    [3_601_000, '1h'],
    [90 * 60_000, '1h 30m'],
    [2 * 86_400_000, '2d'],
    [26 * 3_600_000 + 5 * 60_000, '1d 2h'],
  ])('formats %d ms as %j', (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected);
  });

  it('formats relative times', () => {
    expect(formatRelative(1_000_000 + 300_000, 1_000_000)).toBe('in 5m');
    expect(formatRelative(1_000_000 - 300_000, 1_000_000)).toBe('5m ago');
  });
});

describe('watchExpiry', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires exactly at the expiry time, not before', () => {
    vi.useFakeTimers();
    const onExpire = vi.fn();
    watchExpiry(Date.now() + 150_000, onExpire);
    vi.advanceTimersByTime(149_999);
    expect(onExpire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onExpire).toHaveBeenCalledOnce();
  });

  it('notices expiry after the computer slept (wall clock jumped)', () => {
    vi.useFakeTimers();
    const start = Date.now();
    const onExpire = vi.fn();
    watchExpiry(start + 2 * 3_600_000, onExpire);
    // Timers do not advance during sleep, but the wall clock does.
    vi.setSystemTime(start + 3 * 3_600_000);
    vi.advanceTimersByTime(60_000);
    expect(onExpire).toHaveBeenCalledOnce();
  });

  it('can be cancelled', () => {
    vi.useFakeTimers();
    const onExpire = vi.fn();
    const cancel = watchExpiry(Date.now() + 1_000, onExpire);
    cancel();
    vi.advanceTimersByTime(5_000);
    expect(onExpire).not.toHaveBeenCalled();
  });

  it('fires immediately when already expired', () => {
    const onExpire = vi.fn();
    watchExpiry(Date.now() - 1, onExpire);
    expect(onExpire).toHaveBeenCalledOnce();
  });
});
