import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { OpenComputerClient } from "./api.js";
import { IMAGE_BYTES, imageMediaType, readTurnImages } from "./images.js";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

test("--image files are read by their bytes and refused when the agent cannot take them", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "oc-images-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const named = join(directory, "screenshot.jpg");
  await writeFile(named, PNG);
  assert.deepEqual(await readTurnImages([named]), [
    {
      type: "image",
      mediaType: "image/png",
      data: PNG.toString("base64"),
      name: "screenshot.jpg",
    },
  ]);

  const text = join(directory, "notes.png");
  await writeFile(text, "not an image");
  await assert.rejects(readTurnImages([text]), /not a PNG, JPEG, GIF or WebP/);
  await assert.rejects(readTurnImages([directory]), /is not a file/);
  await assert.rejects(readTurnImages([join(directory, "missing.png")]), /is not a file/);
  const large = join(directory, "large.png");
  await writeFile(large, Buffer.concat([PNG, Buffer.alloc(IMAGE_BYTES)]));
  await assert.rejects(readTurnImages([large]), /larger than 5 MB/);
  await assert.rejects(readTurnImages(Array(5).fill(named)), /At most 4/);
  assert.deepEqual(await readTurnImages([]), []);
});

test("image types are sniffed from their signatures", () => {
  const padded = (...bytes: number[]) =>
    new Uint8Array([...bytes, ...new Array(12).fill(0)]);
  assert.equal(imageMediaType(padded(0xff, 0xd8, 0xff)), "image/jpeg");
  assert.equal(imageMediaType(padded(0x47, 0x49, 0x46, 0x38)), "image/gif");
  assert.equal(
    imageMediaType(
      padded(0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50),
    ),
    "image/webp",
  );
  assert.equal(imageMediaType(padded(0x25, 0x50, 0x44, 0x46)), undefined);
});

test("a turn carries its images only when it has some", async (context) => {
  const bodies: unknown[] = [];
  context.mock.method(
    globalThis,
    "fetch",
    async (input: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(await new Request(input, init).text()));
      return Response.json({ turnId: "turn-1", duplicate: false });
    },
  );
  const client = new OpenComputerClient({
    apiUrl: "https://app.opencomputer.dev",
    apiKey: "test",
  });
  const image = {
    type: "image" as const,
    mediaType: "image/png",
    data: PNG.toString("base64"),
    name: "dot.png",
  };
  await client.createTurn("ses", "What is this?", "key-1", [image]);
  await client.createTurn("ses", "Hello", "key-2");
  assert.deepEqual(bodies, [
    { input: "What is this?", idempotencyKey: "key-1", attachments: [image] },
    { input: "Hello", idempotencyKey: "key-2" },
  ]);
});
