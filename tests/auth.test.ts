import { describe, expect, it } from 'vitest';
import { createBasicAuthChecker, generateToken, parseBasicAuth, safeEqual } from '../src/auth.js';

const basic = (credentials: string): string =>
  `Basic ${Buffer.from(credentials, 'utf8').toString('base64')}`;

describe('safeEqual', () => {
  it('compares strings of any length without throwing', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(safeEqual('', '')).toBe(true);
    expect(safeEqual('a'.repeat(10_000), 'a')).toBe(false);
  });
});

describe('generateToken', () => {
  it('produces 32 URL-safe characters (24 random bytes)', () => {
    const token = generateToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(generateToken()).not.toBe(token);
  });
});

describe('Basic Auth', () => {
  const check = createBasicAuthChecker('s3cret:with:colons');

  it('accepts the right user and password', () => {
    expect(check(basic('fshare:s3cret:with:colons'))).toBe(true);
  });

  it('rejects a wrong password, wrong user or missing header', () => {
    expect(check(basic('fshare:wrong'))).toBe(false);
    expect(check(basic('admin:s3cret:with:colons'))).toBe(false);
    expect(check(undefined)).toBe(false);
    expect(check('')).toBe(false);
  });

  it('rejects malformed headers', () => {
    expect(check('Bearer abc')).toBe(false);
    expect(check('Basic')).toBe(false);
    expect(check('Basic !!!')).toBe(false);
    expect(check(basic('no-colon'))).toBe(false);
  });

  it('handles unicode passwords', () => {
    const unicode = createBasicAuthChecker('pässwörd 🔑');
    expect(unicode(basic('fshare:pässwörd 🔑'))).toBe(true);
    expect(unicode(basic('fshare:passwort'))).toBe(false);
  });

  it('accepts a case-insensitive scheme', () => {
    expect(check(`basic ${Buffer.from('fshare:s3cret:with:colons').toString('base64')}`)).toBe(
      true,
    );
  });

  it('parses credentials', () => {
    expect(parseBasicAuth(basic('fshare:a:b'))).toEqual({ user: 'fshare', password: 'a:b' });
  });
});
