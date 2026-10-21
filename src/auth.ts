import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const BASIC_AUTH_USER = 'fshare';

function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/**
 * Constant-time string comparison. Both sides are hashed first so the buffers always have the
 * same length (timingSafeEqual throws otherwise) and the comparison leaks nothing about length.
 */
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(sha256(a), sha256(b));
}

/** 24 random bytes = 192 bits of entropy, URL-safe. */
export function generateToken(): string {
  return randomBytes(24).toString('base64url');
}

/** Returns a checker for HTTP Basic Auth (user "fshare"). Only a hash of the password is kept. */
export function createBasicAuthChecker(
  password: string,
  user: string = BASIC_AUTH_USER,
): (authorizationHeader: string | undefined) => boolean {
  const expectedUser = sha256(user);
  const expectedPassword = sha256(password);
  return (header) => {
    const credentials = parseBasicAuth(header);
    if (!credentials) return false;
    // Evaluate both comparisons so timing does not reveal which part was wrong.
    const userOk = timingSafeEqual(sha256(credentials.user), expectedUser);
    const passwordOk = timingSafeEqual(sha256(credentials.password), expectedPassword);
    return userOk && passwordOk;
  };
}

export function parseBasicAuth(
  header: string | undefined,
): { user: string; password: string } | null {
  if (!header) return null;
  const match = /^Basic[ \t]+([A-Za-z0-9+/_-]+={0,2})[ \t]*$/i.exec(header);
  if (!match?.[1]) return null;
  const decoded = Buffer.from(match[1], 'base64').toString('utf8');
  const separator = decoded.indexOf(':');
  if (separator === -1) return null;
  return { user: decoded.slice(0, separator), password: decoded.slice(separator + 1) };
}
