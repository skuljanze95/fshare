# Contributing to fshare

Thanks for helping! Bug reports, docs fixes and code are all welcome. This guide gets you from zero to a merged pull request.

By participating you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md). Please report security problems privately as described in [SECURITY.md](SECURITY.md), not in public issues.

## Development setup

You need:

- **Node.js 22** for development. `.nvmrc` pins it, so run `nvm use` if you use nvm. The published CLI supports Node 18+.
- **cloudflared**, only for manual testing and the end-to-end tests. See the [README](README.md#installation).
- **git**, plus **zip** and **unzip**. These come with macOS and most Linux distributions and are used by some tests.

```bash
git clone https://github.com/skuljanze95/fshare.git
cd fshare
npm ci
npm test
```

Run your local build like the published CLI:

```bash
npm run build
node dist/cli.js doctor
node dist/cli.js share ./README.md
```

`npm link` makes `fshare` point at your checkout globally; undo it with `npm unlink -g @skuljanze95/fshare`.

## Scripts

| Script               | What it does                                                                                                                                 |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run build`      | Compiles `src/` to `dist/` with `tsc`.                                                                                                       |
| `npm run dev`        | Rebuilds on every change (`tsc --watch`).                                                                                                    |
| `npm test`           | Builds, then runs all unit and process tests with vitest. No network needed.                                                                 |
| `npm run test:watch` | vitest in watch mode (the process tests use `dist/`, so keep `npm run dev` running alongside).                                               |
| `npm run lint`       | ESLint (type-aware) plus a Prettier check.                                                                                                   |
| `npm run format`     | Formats everything with Prettier.                                                                                                            |
| `npm run typecheck`  | Type-checks sources and tests.                                                                                                               |
| `npm run e2e`        | Builds and runs `tests/e2e`: real cloudflared, real Cloudflare quick tunnel, real download. Skipped automatically if cloudflared is missing. |

## How the code is organized

```
src/
  cli.ts            entry point (#!/usr/bin/env node); flushes output and exits
  main.ts           argument dispatch and error reporting; testable, never calls process.exit
  commands/         share, list, status, stop, doctor, and the hidden __serve (background half of --detach)
  share-runner.ts   the share lifecycle: zip -> hash -> server -> tunnel -> state -> wait -> cleanup
  server.ts         the HTTP server: token route, Basic Auth, Range/HEAD, download counting
  range.ts          Range header parsing
  tunnel.ts         starting cloudflared, parsing its output, readiness checks
  cloudflared.ts    finding cloudflared, install hints, version
  state.ts          ~/.fshare state files, atomic writes, liveness checks, stale cleanup, stop
  zip.ts            folder walking, system zip, built-in ZIP writer (deflate + ZIP64)
  safety.ts         sensitive-path rules
  auth.ts, duration.ts, hash.ts, keepawake.ts, output.ts, errors.ts, help.ts, meta.ts, util.ts
tests/
  *.test.ts         unit tests and process tests (the latter run the built dist/cli.js)
  fixtures/fake-cloudflared.mjs   imitates cloudflared so tests need no network
  e2e/              opt-in tests against real Cloudflare
```

### Principles

- **Zero runtime dependencies.** Use Node built-ins only. Pull requests that add entries to `dependencies` will not be merged.
- **Node 18 compatibility.** `@types/node` is pinned to v18 and `lib` to ES2022, so the compiler rejects newer APIs. Don't work around that.
- **stdout is for results only** (the URL, JSON, tables). Messages go to stderr through `Logger`.
- **Never log the tokenized URL** except as the command's result. The background log files must not contain it.
- **Exit codes, JSON field names and flags are a public interface** used by scripts and AI agents. Changing them is a breaking change.
- **Keep docs in sync.** If you change CLI behaviour, update `src/help.ts`, `README.md`, `AGENTS.md` and `SKILL.md`.

### Writing tests

- Unit tests must not touch the network. Use `tests/fixtures/fake-cloudflared.mjs` via `FSHARE_CLOUDFLARED`; set `FAKE_CLOUDFLARED_MODE` to `ok`, `hang`, `fail`, `ratelimit` or `die-after-ready`.
- Always set `FSHARE_HOME` to a temporary directory so tests never touch your real `~/.fshare`.
- `FSHARE_SKIP_PROBE=1` skips the "is the public URL reachable yet?" check. This is for tests with the fake cloudflared only.
- Tests run on macOS and Ubuntu with Node 18, 20 and 22 in CI.

### Why the dev tools are not the latest majors

The CI matrix still covers Node 18 and 20. The newest vitest, vite, eslint and tsup releases require Node 20.19+ or 22+, so the dev tooling is pinned to the last majors that run on Node 18: vitest 3.2, vite 6, eslint 9 and TypeScript 5.9. `npm audit` reports dev-only advisories in vitest 3's dependencies. They do not affect the published package, which has no dependencies at all. Dropping Node 18/20 from the matrix allows upgrading the tooling.

## Pull request checklist

1. Open an issue first for larger changes, so we can agree on the approach.
2. Create a branch from `main`.
3. Make your change, with tests.
4. Run `npm run lint && npm run typecheck && npm test`. All must pass.
5. If you touched the tunnel or the server, run `npm run e2e` too, if you can.
6. Update the docs if behaviour changed, and add a line under **Unreleased** in [CHANGELOG.md](CHANGELOG.md).
7. Open the pull request and fill in the template.

## Releasing (maintainers)

1. Move the **Unreleased** notes in `CHANGELOG.md` under a new version heading.
2. Bump the version with `npm version <patch|minor|major>`. This commits and creates the tag `vX.Y.Z`.
3. Push the commit and the tag: `git push --follow-tags`.
4. The **Release** workflow checks that the tag matches `package.json`, runs `npm publish --provenance` (which runs typecheck, lint, tests and build), and creates a GitHub release.

The workflow publishes in one of two ways:

- **Trusted publishing (recommended).** On npmjs.com, open the package settings, add a trusted publisher for GitHub Actions with repository `skuljanze95/fshare` and workflow `release.yml`. No secret is needed.
- **Token.** Alternatively, create an npm automation token and store it as the `NPM_TOKEN` repository secret.

Both publish with [provenance](https://docs.npmjs.com/generating-provenance-statements).
