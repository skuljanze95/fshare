import { describe, expect, it } from 'vitest';
import { parseRange } from '../src/range.js';

const SIZE = 1000;

describe('parseRange', () => {
  it('returns full for no header, other units and multiple ranges', () => {
    expect(parseRange(undefined, SIZE)).toEqual({ kind: 'full' });
    expect(parseRange('', SIZE)).toEqual({ kind: 'full' });
    expect(parseRange('items=0-5', SIZE)).toEqual({ kind: 'full' });
    expect(parseRange('bytes=0-1,5-6', SIZE)).toEqual({ kind: 'full' });
  });

  it.each([
    ['bytes=0-99', 0, 99],
    ['bytes=100-', 100, 999],
    ['bytes=0-', 0, 999],
    ['bytes=-50', 950, 999],
    ['bytes=-5000', 0, 999],
    ['bytes=900-99999', 900, 999],
    ['bytes=999-999', 999, 999],
    ['BYTES=1-2', 1, 2],
    ['bytes= 10 - 20 ', 10, 20],
    ['bytes=5-5,', 5, 5],
  ])('%s -> %d-%d', (header, start, end) => {
    expect(parseRange(header, SIZE)).toEqual({ kind: 'partial', start, end });
  });

  it.each([
    'bytes=1000-',
    'bytes=5000-6000',
    'bytes=-0',
    'bytes=5-2',
    'bytes=abc',
    'bytes=-',
    'bytes=',
    'bytes=1.5-2',
    'garbage',
  ])('%s is unsatisfiable (416)', (header) => {
    expect(parseRange(header, SIZE)).toEqual({ kind: 'unsatisfiable' });
  });

  it('never satisfies a range on an empty file', () => {
    expect(parseRange('bytes=0-', 0)).toEqual({ kind: 'unsatisfiable' });
    expect(parseRange('bytes=-10', 0)).toEqual({ kind: 'unsatisfiable' });
    expect(parseRange(undefined, 0)).toEqual({ kind: 'full' });
  });

  it('handles huge numbers without overflowing', () => {
    expect(parseRange('bytes=0-99999999999999999999999', SIZE)).toEqual({
      kind: 'partial',
      start: 0,
      end: 999,
    });
    expect(parseRange('bytes=99999999999999999999999-', SIZE)).toEqual({ kind: 'unsatisfiable' });
  });
});
