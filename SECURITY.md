# Security policy

## Reporting a vulnerability

**Please do not report security problems in public issues.**

Report them privately through GitHub: open the repository's [**Security** tab → **Report a vulnerability**](https://github.com/skuljanze95/fshare/security/advisories/new). Only the maintainers can see the report.

Please include:

- what the problem is and what an attacker could do with it
- steps to reproduce: fshare version (`fshare --version`), OS, Node.js and cloudflared versions
- a proof of concept, if you have one

Never include real share URLs that point to someone's files.

You can expect an acknowledgement within **7 days**. We will keep you updated while we work on a fix and credit you in the release notes, unless you prefer to stay anonymous. Please give us a reasonable amount of time to release a fix before you disclose the problem publicly.

## Supported versions

Security fixes go into the latest release. Please upgrade (`npx -y @skuljanze95/fshare@latest`) before reporting.

| Version | Supported |
| ------- | --------- |
| latest  | ✅        |
| older   | ❌        |

## Threat model (in plain language)

fshare makes **one file** on your computer downloadable through a public link for a limited time. Here is what that means for your security.

### Anyone with the link can download the file

The link is the key. Each link contains a random 192-bit token, which is impossible to guess, but anyone you send it to, or anyone it gets forwarded to, can download the file until the link expires or reaches its download limit. Treat the link like the file itself.

To reduce the risk:

- keep `--expires` short (the default is 1 hour)
- use `--max-downloads 1` for a single recipient
- add `--password` for an extra secret that travels separately
- run `fshare stop` when you are done

### Cloudflare can see the traffic

Links use Cloudflare quick tunnels. HTTPS encryption ends at Cloudflare's edge, and from there the file travels through the tunnel to `cloudflared` on your computer. Cloudflare can therefore technically see what is downloaded. If that is unacceptable for a file, encrypt it before sharing it, for example as a password-protected archive.

### Quick tunnels come without guarantees

Quick tunnels are free, need no account, and are intended for testing and development. They have no uptime guarantee or SLA, can be rate-limited, and are subject to Cloudflare's terms.

### Your computer is the server

The file is served from your machine. fshare limits what is exposed:

- The HTTP server listens on `127.0.0.1` only. The internet reaches it only through the tunnel, and cloudflared connects outward, so no ports are opened on your router or firewall.
- The server answers exactly one path, `/<token>/<filename>`. Every other request returns `404`, and there is no directory listing.
- Only `GET` and `HEAD` are accepted. The file is streamed read-only.
- Tokens and passwords are compared in constant time. Repeated wrong passwords are throttled.
- Expired links return `410 Gone`, and the share shuts itself down.
- Known link-preview bots (from chat apps) are refused, so they don't fetch or keep copies of the file.

### Protection against mistakes

fshare refuses, unless you pass `--force`, to share paths that commonly hold secrets:

- `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.kube`, `~/.docker`, `~/.config/gcloud`, `~/.config/gh`
- keychains and `~/Library`
- `.env` files, private keys (`*.pem`, `*.p12`, `*.pfx`, `id_rsa`, …), `.netrc`, `.npmrc`
- fshare's own state directory
- any folder that contains one of these, including your whole home folder

Symbolic links inside shared folders are skipped, so a link cannot pull in a file from elsewhere.

This check is a **safety net, not a guarantee**. It cannot recognize every secret, so look at what you share.

### Local secrets

- State files in `~/.fshare/shares/` contain share URLs. They are created with permissions `0600` (owner only), inside a `0700` directory.
- Background log files never contain the tokenized URL.
- A password given with `--detach` is passed to the background process over a private IPC channel, never on its command line where other users could see it in `ps`. Use the `FSHARE_PASSWORD` environment variable to keep the password out of your shell history as well.

### Out of scope

- People who legitimately received a link sharing it further.
- Attacks that require control of your user account or computer. Such an attacker can read your files directly.
- Availability problems of Cloudflare's quick tunnel service.
