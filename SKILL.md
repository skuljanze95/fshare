---
name: fshare
description: Share a local file or folder with the user through a temporary public download link, served directly from this computer via a Cloudflare quick tunnel (fshare CLI). Use when the user asks to share, send, or give them a link to a file or folder on this machine, or wants to download something you generated (a report, build, export, image, archive).
---

# fshare: share local files through a temporary public link

fshare serves **one file or folder** from this computer over a public HTTPS link. Folders are zipped automatically. Nothing is uploaded to a storage service; the link works while this computer is on and online, until it expires or is stopped.

## Share a file

Run exactly this, replacing `<path>`:

```bash
npx -y @skuljanze/fshare share <path> --json --detach --expires 1h
```

- `npx -y` skips the install prompt, which you cannot answer.
- `--detach` returns immediately while the link keeps working in the background. Without it, the command blocks until the link expires.
- `--json` prints one JSON line on stdout. Progress messages go to stderr.

Example stdout (printed on a single line; formatted here for readability):

```json
{
  "id": "a1b2c3",
  "url": "https://word-word-word.trycloudflare.com/AbC…xyz/report.pdf",
  "file": "report.pdf",
  "size_bytes": 12345,
  "sha256": "9f86d081…",
  "expires_at": "2026-10-21T12:00:00Z",
  "max_downloads": null,
  "password_protected": false,
  "pid": 4242
}
```

Useful options:

| Option                        | Use it when                                                                                                            |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `--expires 30m` / `2h` / `1d` | The default is 1h and the maximum is 30d. Choose the shortest time that works for the user.                            |
| `--max-downloads 1`           | The file is meant for one person or one download.                                                                      |
| `--password <pw>`             | The user wants a password. The username is `fshare`. Prefer passing it via the `FSHARE_PASSWORD` environment variable. |
| `--name <filename>`           | The download should have a different filename.                                                                         |
| `--protocol http2`            | Retrying after a tunnel failure (exit code 5).                                                                         |

## Tell the user

Reply with the `url` exactly as printed (never shorten or alter it), the file name and size, the expiry time, and the share `id`. For example:

> Here is the download link for **report.pdf** (12 KB). It works until 12:00 UTC:
> https://word-word-word.trycloudflare.com/AbC…xyz/report.pdf
> Anyone with the link can download it. Share id `a1b2c3`; ask me to stop sharing at any time.

If the user set a password, remind them that the username is `fshare`. If they want to verify the download, give them the `sha256`.

## Manage shares

```bash
npx -y @skuljanze/fshare list --json           # all active shares (JSON array)
npx -y @skuljanze/fshare status <id> --json    # one share, including download_count
npx -y @skuljanze/fshare stop <id>             # stop one share
npx -y @skuljanze/fshare stop --all            # stop everything
```

Stop shares as soon as the user says they are done, or when they ask you to.

## Exit codes and what to do

| Code | Meaning                                            | What to do                                                                                                                                                                                                                 |
| ---- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | Success                                            | Give the user the link.                                                                                                                                                                                                    |
| 1    | Other error                                        | Show the error message to the user.                                                                                                                                                                                        |
| 2    | Bad arguments, **or a sensitive path was refused** | Fix the arguments. For a refused path, explain the risk; only add `--force` if the user explicitly confirms.                                                                                                               |
| 3    | File or share not found                            | Check the path or id (`list --json`).                                                                                                                                                                                      |
| 4    | cloudflared not installed                          | Tell the user to install it: macOS `brew install cloudflared`, Windows `winget install --id Cloudflare.cloudflared`, Linux see https://github.com/skuljanze95/fshare#installation. Do not install software without asking. |
| 5    | Tunnel failed                                      | Retry once with `--protocol http2`. If it fails again, run `npx -y @skuljanze/fshare doctor` and show the user the output.                                                                                                 |

With `--json`, failures print `{"error":{"code":"…","message":"…","hint":"…","exit_code":N}}` on stdout.

## Safety rules

- **Only share what the user asked for.** Never share files on your own initiative.
- **Never share secrets:**
  - `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.kube`
  - `.env` files, private keys (`*.pem`, `*.p12`, `id_rsa`, `id_ed25519`), keychains, `~/Library`
  - password databases, browser profiles, credential files
  - whole home directories

  fshare refuses most of these by itself (exit code 2). Do not work around that with `--force` unless the user explicitly confirms after you explain what would be exposed.

- **Anyone who has the link can download the file** until it expires. Never post the link anywhere public. Prefer short expiry times and `--max-downloads 1`.
- Before sharing a folder, consider whether it might contain secrets (for example a project folder with `.env` or `node_modules` caches). fshare checks for common secret files, but it cannot catch everything.

## Good to know

- The link only works while this computer is awake and online. For long shares, add `--keep-awake` (macOS/Linux; prevents idle sleep only).
- Download speed is limited by this computer's upload speed.
- Quick tunnels are free and need no account, but come with no uptime guarantee. If a link stops working, share the file again; the URL will change.
- If the file is modified after sharing, the link returns `410 Gone`; share it again.
- Background shares log to `~/.fshare/logs/<id>.log`. `FSHARE_DEBUG=1` shows cloudflared's own logs.
