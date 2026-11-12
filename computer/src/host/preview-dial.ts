// How the preview proxy and the listen probe reach a previewed port (work
// 103, seam S3). Both take a Dialer, so where the port lives is decided in one
// place: today it is this machine's loopback. Invariants: a Dialer returns its
// connection at once and never throws; the connection emits `connect`, or
// `error` with code ECONNREFUSED when nothing listens on the port. The proxy
// keeps connections alive through an http.Agent, which calls a socket's
// setKeepAlive, setTimeout, ref and unref on them: a Dialer whose connection
// is not a net.Socket has to provide those.

import net from 'node:net';
import type { Duplex } from 'node:stream';

/** A connection to this port for http.request's `createConnection`: returned at once, emits `connect` or `error` (code ECONNREFUSED when nothing listens). */
export type Dialer = (port: number) => Duplex;

/** The port on this machine, over IPv4 loopback, as http.request itself would connect. */
export const loopbackDialer: Dialer = (port) => net.connect({ host: '127.0.0.1', port, noDelay: true });
