# AGENTS.md

This file has two parts:

1. **A snippet for your own projects.** Copy everything between `<!-- fshare:start -->` and `<!-- fshare:end -->` into your project's `AGENTS.md` (read by Codex, Cursor and other coding agents) or into `~/.codex/AGENTS.md` to enable it everywhere. It teaches agents to share files with you through fshare. Claude Code users can install [SKILL.md](SKILL.md) instead; see the [README](README.md#using-with-ai-agents).
2. **Notes for agents working on the fshare codebase itself.**

---

## 1. Snippet: sharing files with the user

<!-- fshare:start -->

### Sharing files with the user (fshare)

When the user asks you to share, send, or give them a download link to a local file or folder, use **fshare**. It serves the file from this computer through a temporary public HTTPS link (a Cloudflare quick tunnel). Nothing is uploaded anywhere else.

**Share.** The command returns immediately; the link keeps working in the background:

```bash
npx -y @skuljanze95/fshare share <path> --json --detach --expires 1h
```

stdout is one JSON object, printed on a single line (formatted here for readability):

```json
{
  "id": "a1b2c3",
  "url": "https://…trycloudflare.com/…/report.pdf",
  "file": "report.pdf",
  "size_bytes": 12345,
  "sha256": "…",
  "expires_at": "2026-10-21T12:00:00Z",
  "max_downloads": null,
  "password_protected": false,
  "pid": 4242
}
```

**Give the user** the `url` (exactly as printed, never shortened or altered), the file name and size, when it expires, and the `id`, which is needed to stop the share. For example:

> Here is the download link for report.pdf (12 KB), valid until 12:00 UTC: <url>
> Share id `a1b2c3`; ask me to stop it at any time.

**Options:**

- `--expires 30m|2h|1d`: default 1h, max 30d.
- `--max-downloads N`
- `--password <pw>`: the username is `fshare`. You can set `FSHARE_PASSWORD` instead.
- `--name <filename>`
- `--protocol http2`: use when QUIC is blocked.

Folders are zipped automatically and shared as `<name>.zip`.

**Manage:**

```bash
npx -y @skuljanze95/fshare list --json          # active shares
npx -y @skuljanze95/fshare status <id> --json   # details, including download_count
npx -y @skuljanze95/fshare stop <id>            # or: stop --all
```

**Exit codes:**

| Code | Meaning                                        |
| ---- | ---------------------------------------------- |
| 0    | ok                                             |
| 1    | error                                          |
| 2    | bad arguments, or a sensitive path was refused |
| 3    | file or share not found                        |
| 4    | cloudflared is missing                         |
| 5    | the tunnel failed                              |

On failure with `--json`, stdout is `{"error":{"code":"…","message":"…","hint":"…","exit_code":N}}`.

**Rules:**

- Only share what the user explicitly asked for. Never share secrets or private data on your own initiative: `~/.ssh`, `~/.aws`, `.env` files, private keys (`*.pem`, `id_rsa`), keychains, credentials, browser profiles, or whole home folders.
- fshare refuses sensitive paths (exit code 2). Never add `--force` unless the user explicitly confirms after you explain what would be exposed.
- Anyone with the link can download the file until it expires. Prefer short expiry times, and use `--max-downloads 1` for a single recipient.
- Always use `--detach` (otherwise the command blocks until the link expires) and `npx -y` (you cannot answer npx's install prompt).
- Exit code 4: tell the user to install cloudflared (macOS: `brew install cloudflared`; Windows: `winget install --id Cloudflare.cloudflared`; Linux: https://github.com/skuljanze95/fshare#installation). Do not install software without asking.
- Exit code 5: retry once with `--protocol http2`. If it still fails, run `npx -y @skuljanze95/fshare doctor` and show the user the result.
- The link only works while this computer is on and online. Stop shares the user no longer needs.

<!-- fshare:end -->

---

## 2. Working on the fshare codebase

- **Runtime:** Node.js 18+, TypeScript (strict), ESM. **No runtime dependencies.** Use only Node built-ins and do not add packages to `dependencies`.
- **Commands:**
  - `npm ci`: install
  - `npm run build`: compile to `dist/`
  - `npm test`: builds, then runs the unit and process tests
  - `npm run lint`: eslint plus prettier
  - `npm run typecheck`
  - `npm run format`
  - `npm run e2e`: real Cloudflare tunnel; needs cloudflared and network
- **Layout:**
  - `src/cli.ts` is the entry point; `src/main.ts` dispatches commands; each command lives in `src/commands/*`.
  - Share lifecycle: `src/share-runner.ts`
  - HTTP server: `src/server.ts`
  - cloudflared: `src/tunnel.ts` and `src/cloudflared.ts`
  - State files: `src/state.ts`
  - Zipping: `src/zip.ts`
  - Safety rules: `src/safety.ts`
- **Public interface:** exit codes (`src/errors.ts`), the JSON field names and the stdout/stderr split. Changing any of them is a breaking change. Keep `README.md`, this file, `SKILL.md` and `src/help.ts` in sync with CLI behaviour.
- **Output:** stdout is only for results (URL, JSON, tables). Everything else goes through `Logger` to stderr. Never log the tokenized URL except as the command's result.
- **Tests** use `tests/fixtures/fake-cloudflared.mjs` and must not touch the network; only `tests/e2e` may. Set `FSHARE_HOME` to a temp directory in tests so they never touch `~/.fshare`.
- **Type safety:** `@types/node` is pinned to v18 so the compiler rejects APIs newer than Node 18.
