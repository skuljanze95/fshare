# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.1] - 2026-10-21

### Changed

- Releases are published from GitHub Actions through npm trusted publishing, with [provenance](https://docs.npmjs.com/generating-provenance-statements). The CLI itself is unchanged.
- GitHub releases take their notes from this changelog.

## [0.1.0] - 2026-10-21

### Added

- `fshare share <path>`: share a file or folder (zipped automatically) through a Cloudflare quick tunnel. Options:
  - `--expires`, `--max-downloads`, `--password`, `--name`
  - `--json`, `--detach`, `--keep-awake`, `--force`, `--protocol`
- `fshare list`, `fshare status <id>` and `fshare stop <id>|--all`, all with `--json` output.
- `fshare doctor`: checks Node.js, cloudflared, zip, network access and writable directories, and explains fixes.
- HTTP server with:
  - a single tokenized route
  - HTTP Basic Auth with throttling
  - single-range, suffix-range and HEAD support, plus `If-Range`
  - download counting on completion
  - link-preview bot blocking
- Readiness check, so links work the moment they are printed.
- Sensitive-path protection (`~/.ssh`, `.env`, keys, keychains, …) with `--force` override.
- Agent support: `AGENTS.md` snippet and a Claude Code `SKILL.md`.

[Unreleased]: https://github.com/skuljanze95/fshare/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/skuljanze95/fshare/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/skuljanze95/fshare/releases/tag/v0.1.0
