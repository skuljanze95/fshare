/**
 * HTTP Range parsing (RFC 9110 §14). fshare supports a single byte range per request, which is
 * what browsers, curl and download managers use for resuming and seeking.
 */

export type RangeResult =
  /** No Range header, an unknown unit, or multiple ranges: send the whole file (200). */
  | { kind: 'full' }
  /** Send bytes start..end inclusive (206). */
  | { kind: 'partial'; start: number; end: number }
  /** Invalid or unsatisfiable range (416). */
  | { kind: 'unsatisfiable' };

const FULL: RangeResult = { kind: 'full' };
const UNSATISFIABLE: RangeResult = { kind: 'unsatisfiable' };

export function parseRange(header: string | undefined, size: number): RangeResult {
  if (header === undefined || header.trim() === '') return FULL;

  const equals = header.indexOf('=');
  if (equals === -1) return UNSATISFIABLE;
  const unit = header.slice(0, equals).trim().toLowerCase();
  // Servers must ignore range units they do not understand.
  if (unit !== 'bytes') return FULL;

  const specs = header
    .slice(equals + 1)
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  if (specs.length === 0) return UNSATISFIABLE;
  // Multipart responses are not supported; ignoring the header is allowed by the RFC.
  if (specs.length > 1) return FULL;

  const match = /^(\d*)[ \t]*-[ \t]*(\d*)$/.exec(specs[0] ?? '');
  if (!match) return UNSATISFIABLE;
  const [, first = '', last = ''] = match;

  if (first === '' && last === '') return UNSATISFIABLE;

  if (first === '') {
    // Suffix range: the last N bytes.
    const length = Number(last);
    if (length === 0 || size === 0) return UNSATISFIABLE;
    return { kind: 'partial', start: Math.max(0, size - length), end: size - 1 };
  }

  const start = Number(first);
  if (last !== '' && Number(last) < start) return UNSATISFIABLE;
  if (start >= size) return UNSATISFIABLE;
  const end = last === '' ? size - 1 : Math.min(Number(last), size - 1);
  return { kind: 'partial', start, end };
}
