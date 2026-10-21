import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

interface PackageJson {
  name: string;
  version: string;
}

function readPackageJson(): PackageJson {
  try {
    const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
    const parsed = JSON.parse(raw) as Partial<PackageJson>;
    return { name: parsed.name ?? 'fshare', version: parsed.version ?? '0.0.0' };
  } catch {
    return { name: 'fshare', version: '0.0.0' };
  }
}

const pkg = readPackageJson();

export const VERSION = pkg.version;
/** npm package name, e.g. "@skuljanze95/fshare". The command itself is always "fshare". */
export const PACKAGE_NAME = pkg.name;
export const REPO_URL = 'https://github.com/skuljanze95/fshare';
/** Absolute path of the CLI entry point; --detach re-spawns it as a background process. */
export const CLI_PATH = fileURLToPath(new URL('./cli.js', import.meta.url));
