// The relay (work 084): its own process and systemd unit
// (slack-presence-wire.service, user sp-wire), so a client flood or a relay
// crash never touches the host or a runner. Clients reach it through the
// computer's tunnel; it reaches the host on <SP_RUN>/wire/wire.sock and each
// session's writer on the socket `where` names.
//
//   [SP_WIRE_LISTEN=127.0.0.1:7071]   where the tunnel's `<tunnelId>.w.opencomputer.dev` ingress points
//   [SP_WIRE_SOCKET=<SP_RUN>/wire/wire.sock]   the host's wire socket
//   [SP_VERSION]                      the release's commit, in `ready.server.version`
//   [SP_REGION]                       `ready.server.region`
//   node dist/wire.js   (bundled by scripts/bundle-runner.mjs; or node --import tsx src/wire/main.ts)
//
// Invariants: env is read here only; SIGTERM closes every connection with 1012
// (clients reconnect at once) before exiting; any uncaught error exits 1 and
// systemd restarts the unit.

import path from 'node:path';
import { HOST_RUN } from '../protocol.js';
import { log } from '../log.js';
import { startRelay } from './relay.js';

const listen = process.env.SP_WIRE_LISTEN ?? '127.0.0.1:7071';
const at = listen.lastIndexOf(':');
const host = at > 0 ? listen.slice(0, at) : '127.0.0.1';
const port = Number(at >= 0 ? listen.slice(at + 1) : listen);
if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`SP_WIRE_LISTEN: bad port in ${listen}`);
if (host !== '127.0.0.1' && host !== '::1' && host !== 'localhost') log.warn(`wire: listening on ${host}, not loopback`);

const relay = await startRelay({
  host,
  port,
  socket: process.env.SP_WIRE_SOCKET ?? path.join(HOST_RUN, 'wire', 'wire.sock'),
  version: process.env.SP_VERSION ?? 'dev',
  region: process.env.SP_REGION ?? null,
});

let stopping = false;
const stop = async (signal: string) => {
  if (stopping) return;
  stopping = true;
  log.info(`wire: ${signal}; closing ${relay.connections()} connections with 1012`);
  await relay.close(1012).catch(() => {});
  process.exit(0);
};
process.on('SIGTERM', () => void stop('SIGTERM'));
process.on('SIGINT', () => void stop('SIGINT'));
