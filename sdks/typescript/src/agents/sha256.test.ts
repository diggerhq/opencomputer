import { describe, expect, it } from "vitest";
import { Sha256 } from "./sha256.js";

const hex = (bytes: ArrayBuffer) =>
  Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");

const webCrypto = async (bytes: Uint8Array<ArrayBuffer>) => hex(await crypto.subtle.digest("SHA-256", bytes));

describe("Sha256", () => {
  it("matches the FIPS test vectors", () => {
    expect(new Sha256().digestHex()).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(new Sha256().update(new TextEncoder().encode("abc")).digestHex()).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("matches Web Crypto for every chunking of messages around the block size", async () => {
    for (const length of [0, 1, 55, 56, 63, 64, 65, 119, 120, 127, 128, 1000, 4097]) {
      const message = new Uint8Array(length);
      for (let i = 0; i < length; i++) message[i] = (i * 31 + 7) & 0xff;
      const expected = await webCrypto(message);
      for (const chunkSize of [1, 3, 64, 100, 4096]) {
        const hash = new Sha256();
        for (let offset = 0; offset < length; offset += chunkSize) {
          hash.update(message.subarray(offset, Math.min(length, offset + chunkSize)));
        }
        expect(hash.digestHex(), `length ${String(length)} chunk ${String(chunkSize)}`).toBe(expected);
      }
    }
  });

  it("refuses to be reused after the digest is taken", () => {
    const hash = new Sha256();
    hash.digest();
    expect(() => hash.update(new Uint8Array(1))).toThrow();
    expect(() => hash.digest()).toThrow();
  });
});
