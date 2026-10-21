#!/usr/bin/env node
// Imitates `cloudflared tunnel --url ...` for tests, without any network access.
// Behaviour is selected with FAKE_CLOUDFLARED_MODE: ok | hang | fail | ratelimit | die-after-ready
import { writeFileSync } from 'node:fs';

const mode = process.env.FAKE_CLOUDFLARED_MODE ?? 'ok';
const args = process.argv.slice(2);

if (args[0] === '--version') {
  process.stdout.write('cloudflared version 2099.1.0 (built fake)\n');
  process.exit(0);
}
if (process.env.FAKE_CLOUDFLARED_ARGS_FILE) {
  writeFileSync(process.env.FAKE_CLOUDFLARED_ARGS_FILE, JSON.stringify(args));
}

const log = (level, message) =>
  process.stderr.write(`${new Date().toISOString().replace(/\.\d+Z$/, 'Z')} ${level} ${message}\n`);
const host = `fake-${Math.random().toString(36).slice(2, 8)}-tunnel.trycloudflare.com`;

process.on('SIGTERM', () => {
  log('INF', 'Initiating graceful shutdown due to signal terminated ...');
  process.exit(0);
});
log('INF', 'Requesting new quick Tunnel on trycloudflare.com...');

switch (mode) {
  case 'ok':
  case 'die-after-ready':
    setTimeout(() => {
      log('INF', '+--------------------------------------------------------------+');
      log('INF', '|  Your quick Tunnel has been created! Visit it at:            |');
      log('INF', `|  https://${host}                     |`);
      log('INF', '+--------------------------------------------------------------+');
    }, 50);
    setTimeout(() => {
      log(
        'INF',
        'Registered tunnel connection connIndex=0 connection=0000 event=0 ip=198.41.192.27 location=test protocol=quic',
      );
    }, 150);
    if (mode === 'die-after-ready') {
      setTimeout(() => {
        log('ERR', 'Connection terminated connIndex=0');
        process.exit(1);
      }, 1500);
    }
    break;
  case 'hang':
    break;
  case 'fail':
    log(
      'ERR',
      'failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel": dial tcp: lookup api.trycloudflare.com: no such host',
    );
    process.exit(1);
    break;
  case 'ratelimit':
    log(
      'ERR',
      'Error unmarshaling QuickTunnel response: error code: 1015 status_code="429 Too Many Requests"',
    );
    process.exit(1);
    break;
  default:
    log('ERR', `unknown FAKE_CLOUDFLARED_MODE ${mode}`);
    process.exit(2);
}

setInterval(() => {}, 1 << 30);
