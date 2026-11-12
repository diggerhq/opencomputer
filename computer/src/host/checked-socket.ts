// Connecting to a unix socket in a directory a session can write (work 103,
// trust rule 4): `<run>/runners/<id>.sock` and `<id>.api.sock`. The session
// decides what is at such a path, and may change it at any moment.
//
// Invariants:
// - The host connects to exactly the thing it checked. On Linux the path is
//   opened once (`O_PATH | O_NOFOLLOW`: never through a link in its last
//   component, nothing is read or connected by the open), the open file is
//   checked (`fstat`), and the connection goes to that open file through
//   `/proc/self/fd/<n>`. Replacing the path after the check changes nothing.
// - It must be a socket and, when the caller names one, owned by that user.
// - Elsewhere (a laptop: no `O_PATH`, no `/proc`) it is `lstat`, then connect,
//   which a session could race; no sandbox runs there.
//
// What this does not do: tell one session's socket from another's (both are
// the runners' user's). That is the directory's work: a run directory is
// mounted into its own container only.

import net from 'node:net';
import { closeSync, constants, fstatSync, lstatSync, openSync } from 'node:fs';

/** Linux's O_PATH, which node:fs does not name. */
const O_PATH = 0o10000000;

export interface SocketCheck {
  /** The user the socket must belong to. */
  uid?: number;
}

export interface Pinned {
  /** Where to connect: the checked file itself, whatever its path holds by now. */
  path: string;
  /** Release it, once connected or given up. */
  close(): void;
}

const refuse = (path: string, why: string) => Object.assign(new Error(`${path}: ${why}`), { code: 'ECONNREFUSED' });

/** Check the socket at `path` and hold on to it. Throws when nothing is there (`ENOENT`) or it is not that (`ECONNREFUSED`). */
export function pinSocket(path: string, o: SocketCheck = {}, platform = process.platform): Pinned {
  if (platform !== 'linux') {
    const st = lstatSync(path);
    if (!st.isSocket()) throw refuse(path, 'not a socket');
    if (o.uid !== undefined && st.uid !== o.uid) throw refuse(path, `owned by uid ${st.uid}, not ${o.uid}`);
    return { path, close: () => {} };
  }
  const fd = openSync(path, O_PATH | constants.O_NOFOLLOW);
  try {
    const st = fstatSync(fd);
    if (!st.isSocket()) throw refuse(path, 'not a socket');
    if (o.uid !== undefined && st.uid !== o.uid) throw refuse(path, `owned by uid ${st.uid}, not ${o.uid}`);
  } catch (e) {
    closeSync(fd);
    throw e;
  }
  let open = true;
  return { path: `/proc/self/fd/${fd}`, close: () => void (open && ((open = false), closeSync(fd))) };
}

/** `net.connect(path)` to a checked socket. Throws as `pinSocket` does; a refused connection is the socket's `error`. */
export function connectChecked(path: string, o: SocketCheck = {}): net.Socket {
  const pin = pinSocket(path, o);
  let sock: net.Socket;
  try {
    sock = net.connect(pin.path);
  } catch (e) {
    pin.close();
    throw e;
  }
  for (const ev of ['connect', 'error', 'close'] as const) sock.once(ev, pin.close);
  return sock;
}
