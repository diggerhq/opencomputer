// What a person does on a desktop (wire/terminal.ts `desktop`), read from the
// VNC viewer's bytes: the idle timeout counts key, pointer and clipboard
// events, not the update requests a viewer keeps sending while the screen
// changes.
//
// Invariants:
// - The server is desktop-vnc.py's Xvnc: RFB 3.8 with security type None,
//   so the viewer's handshake is 12 bytes of version, 1 of security type and
//   1 of ClientInit.
// - A stream it cannot follow (an unknown message type) makes every later
//   byte count as activity: a parsing slip can keep a desktop open, never
//   close one early.

const HANDSHAKE = 12 + 1 + 1;

/** Returns a scanner that reports whether a chunk of the viewer's bytes held a person's action. */
export function rfbActivity(): (chunk: Uint8Array) => boolean {
  let skip = HANDSHAKE;
  let buf = new Uint8Array(0);
  let lost = false;
  return (chunk) => {
    if (lost) return true;
    let at = Math.min(skip, chunk.length);
    skip -= at;
    if (at === chunk.length) return false;
    const all = new Uint8Array(buf.length + chunk.length - at);
    all.set(buf);
    all.set(chunk.subarray(at), buf.length);
    let active = false;
    at = 0;
    for (;;) {
      const n = all.length - at;
      if (n < 1) break;
      const type = all[at];
      const view = new DataView(all.buffer, all.byteOffset + at);
      let len: number;
      if (type === 0) len = 20; // SetPixelFormat
      else if (type === 2) len = n < 4 ? -1 : 4 + 4 * view.getUint16(2); // SetEncodings
      else if (type === 3) len = 10; // FramebufferUpdateRequest
      else if (type === 4) len = 8; // KeyEvent
      else if (type === 5) len = 6; // PointerEvent
      else if (type === 6) len = n < 8 ? -1 : 8 + Math.abs(view.getInt32(4)); // ClientCutText (< 0: extended clipboard)
      else if (type === 150) len = 10; // EnableContinuousUpdates
      else if (type === 248) len = n < 9 ? -1 : 9 + all[at + 8]; // ClientFence
      else if (type === 250) len = 4; // xvp
      else if (type === 251) len = n < 8 ? -1 : 8 + 16 * all[at + 6]; // SetDesktopSize
      else if (type === 255 && n >= 2 && all[at + 1] === 0) len = 12; // QEMU extended key event
      else if (type === 255 && n >= 2 && all[at + 1] === 1) len = n < 4 ? -1 : view.getUint16(2) === 2 ? 10 : 4; // QEMU audio
      else if (type === 255 && n < 2) len = -1;
      else {
        lost = true;
        return true;
      }
      if (len < 0 || n < len) break;
      if (type === 4 || type === 5 || type === 6 || (type === 255 && all[at + 1] === 0)) active = true;
      at += len;
    }
    buf = all.slice(at);
    return active;
  };
}
