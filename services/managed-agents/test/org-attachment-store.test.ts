// The presigned URLs of the attachments' store (work 126, attachments/s3-presign.ts), against the example
// AWS documents for Signature Version 4 query-string signing.

import { describe, expect, it } from "vitest";

import { objectUrl, presign, presignUrl } from "../src/attachments/s3-presign.js";
import { s3Attachments } from "../src/attachments/store.js";

const AWS = { accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", region: "us-east-1" };
const NOW = Date.UTC(2013, 4, 24);

describe("presignUrl", () => {
  it("signs AWS's documented GET as AWS does", async () => {
    const url = await presignUrl("https://examplebucket.s3.amazonaws.com/test.txt", AWS, { method: "GET", expiresS: 86400, now: NOW });
    expect(url).toBe(
      "https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request" +
        "&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404",
    );
  });

  it("signs the headers and the query it is given: another size, type or disposition is another signature", async () => {
    const c = { endpoint: "https://acct.r2.cloudflarestorage.com/", bucket: "files", accessKeyId: "id", secretAccessKey: "secret" };
    const sig = (url: string) => new URL(url).searchParams.get("X-Amz-Signature");
    const put = (bytes: number) => presign(c, { method: "PUT", key: "org_1/cs_1/at_1", expiresS: 60, now: NOW, headers: { "content-type": "text/plain", "content-length": String(bytes) } });
    const five = await put(5);
    expect(new URL(five).searchParams.get("X-Amz-SignedHeaders")).toBe("content-length;content-type;host");
    expect(new URL(five).searchParams.get("X-Amz-Credential")).toBe("id/20130524/auto/s3/aws4_request");
    expect(sig(five)).toBe(sig(await put(5)));
    expect(sig(five)).not.toBe(sig(await put(6)));
    const get = (disposition: string) => presign(c, { method: "GET", key: "org_1/cs_1/at_1", expiresS: 60, now: NOW, query: { "response-content-disposition": disposition } });
    expect(sig(await get("inline"))).not.toBe(sig(await get("attachment")));
    // A value's reserved characters are percent-encoded once, as the store reads them back.
    expect(await get("attachment; filename*=UTF-8''a%20b.txt")).toContain("response-content-disposition=attachment%3B%20filename%2A%3DUTF-8%27%27a%2520b.txt");
  });

  it("addresses the bucket by path, each segment of the key encoded", () => {
    expect(objectUrl({ endpoint: "https://store.test/", bucket: "files" }, "org_1/cs 1/at+1")).toBe("https://store.test/files/org_1/cs%201/at%2B1");
  });
});

describe("s3Attachments", () => {
  it("an upload URL names its content-type for the uploader and holds it to the declared size", async () => {
    const s = s3Attachments({ endpoint: "https://store.test", bucket: "files", accessKeyId: "id", secretAccessKey: "secret" });
    const { url, headers } = await s.uploadUrl("org_1/cs_1/at_1", { bytes: 5, contentType: "image/png" }, 3600);
    expect(headers).toEqual({ "content-type": "image/png" });
    expect(url.split("?")[0]).toBe("https://store.test/files/org_1/cs_1/at_1");
    expect(new URL(url).searchParams.get("X-Amz-Expires")).toBe("3600");
  });
});
