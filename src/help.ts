import { PACKAGE_NAME, REPO_URL, VERSION } from './meta.js';

const EXIT_CODES =
  'Exit codes: 0 ok, 1 error, 2 bad arguments, 3 not found, 4 cloudflared missing, 5 tunnel failed';

export function mainHelp(): string {
  return `fshare ${VERSION} - share a file or folder through a public download link, served from this computer

Usage
  fshare share <path> [options]   Share a file or folder and print its download URL
  fshare list                     List active shares
  fshare status <id>              Show details about one share
  fshare stop <id> | --all        Stop a share, or all of them
  fshare doctor                   Check that everything needed is installed and working

Options
  -h, --help                      Show help (also: fshare <command> --help)
  -v, --version                   Print the version

Examples
  fshare share ./report.pdf                     Share a file for 1 hour (the default)
  fshare share ./photos --expires 2d            Share a folder (sent as photos.zip) for 2 days
  fshare share ./build.zip --max-downloads 1    The link stops working after one download
  fshare share ./notes.txt --json --detach      Background share with JSON output (agents, scripts)
  fshare list
  fshare stop --all

Run without installing:  npx -y ${PACKAGE_NAME} share ./report.pdf
${EXIT_CODES}
Docs: ${REPO_URL}#readme
`;
}

export function shareHelp(): string {
  return `Usage: fshare share <path> [options]

Shares one file or folder through a temporary public HTTPS link (a Cloudflare quick tunnel).
Folders are zipped and shared as one .zip file. The file is served from this computer, so it
must stay awake and online while the link is in use.

Options
  --expires <duration>      How long the link works: 30m, 2h, 1d, 1h30m (default 1h, max 30d)
  --max-downloads <n>       Stop sharing after n completed downloads (default: unlimited)
  --password <password>     Require a password (HTTP Basic Auth, username "fshare").
                            Or set FSHARE_PASSWORD to keep it out of your shell history.
  --name <filename>         Download filename (default: the file or folder name)
  --json                    Print one JSON object instead of the URL
  --detach                  Keep sharing in the background and return right away
  --keep-awake              Stop the computer from idle-sleeping while sharing (macOS, Linux)
  --force                   Allow paths that look sensitive (~/.ssh, .env, *.pem, ...)
  --protocol <quic|http2>   Tunnel protocol for cloudflared (use http2 if QUIC/UDP is blocked)
  -h, --help                Show this help

Output
  stdout gets only the URL (or the JSON object); progress and messages go to stderr.
  JSON fields: id, url, file, size_bytes, sha256, expires_at, max_downloads,
  password_protected, pid

Examples
  fshare share ./report.pdf
  fshare share ~/Desktop/photos --expires 2d --name holiday-photos.zip
  fshare share ./invoice.pdf --max-downloads 1 --password 'correct horse'
  fshare share ./build.tar.gz --json --detach --expires 30m
  fshare share ./video.mp4 --keep-awake --protocol http2

Without --detach, fshare keeps running until you press Ctrl+C, the link expires, or the
download limit is reached.
${EXIT_CODES}
`;
}

export function listHelp(): string {
  return `Usage: fshare list [--json]

Lists active shares on this computer. Entries whose process is no longer running are cleaned
up automatically.

Options
  --json       Print a JSON array
  -h, --help   Show this help

Examples
  fshare list
  fshare list --json
`;
}

export function statusHelp(): string {
  return `Usage: fshare status <id> [--json]

Shows details about one active share: URL, file, size, SHA-256, expiry and download count.

Options
  --json       Print a JSON object
  -h, --help   Show this help

Examples
  fshare status a1b2c3
  fshare status a1b2c3 --json

Exit code 3 means there is no active share with that id.
`;
}

export function stopHelp(): string {
  return `Usage: fshare stop <id>... | --all [--json]

Stops one or more shares: the link stops working immediately, the tunnel is closed and any
temporary zip file is deleted.

Options
  --all        Stop every active share
  --json       Print {"stopped":[...]} as JSON
  -h, --help   Show this help

Examples
  fshare stop a1b2c3
  fshare stop --all

Exit code 3 means there is no active share with that id.
`;
}

export function doctorHelp(): string {
  return `Usage: fshare doctor [--json]

Checks everything fshare needs and explains how to fix problems:
Node.js version, cloudflared, zip, network access to Cloudflare, and the state directory.

Options
  --json       Print the results as JSON
  -h, --help   Show this help

Examples
  fshare doctor
  npx -y ${PACKAGE_NAME} doctor

Exit code 0 means all required checks passed; 4 means cloudflared is missing; 1 means another
check failed.
`;
}

export const COMMAND_HELP = new Map<string, () => string>([
  ['share', shareHelp],
  ['list', listHelp],
  ['status', statusHelp],
  ['stop', stopHelp],
  ['doctor', doctorHelp],
]);
