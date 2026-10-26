import { describe, expect, it } from "vitest";
import { EMPTY_HASH, regionFromEndpoint, s3FromEnv, signRequest } from "./s3";

describe("request signing", () => {
  // The worked example from Amazon's own documentation ("GET Object" with a Range header). If our signature matches
  // theirs to the last character, the signing is right, and every S3-compatible service accepts it.
  it("matches Amazon's published example exactly", () => {
    const headers = signRequest({
      method: "GET",
      url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"),
      region: "us-east-1",
      keyId: "AKIAIOSFODNN7EXAMPLE",
      secret: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      payloadHash: EMPTY_HASH,
      date: new Date("2013-05-24T00:00:00Z"),
      headers: { range: "bytes=0-9" },
    });
    expect(headers.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, " +
        "SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, " +
        "Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
    );
    expect(headers["x-amz-date"]).toBe("20130524T000000Z");
  });

  it("matches Amazon's published example with a query string (list objects)", () => {
    const headers = signRequest({
      method: "GET",
      url: new URL("https://examplebucket.s3.amazonaws.com/?max-keys=2&prefix=J"),
      region: "us-east-1",
      keyId: "AKIAIOSFODNN7EXAMPLE",
      secret: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      payloadHash: EMPTY_HASH,
      date: new Date("2013-05-24T00:00:00Z"),
    });
    expect(headers.authorization).toContain("Signature=34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7");
  });

  it("changes when anything signed changes", () => {
    const base = { method: "PUT", url: new URL("https://s3.example.com/b/k"), region: "r", keyId: "id", secret: "s", payloadHash: EMPTY_HASH, date: new Date("2026-01-01T00:00:00Z") };
    const sig = (over: object) => signRequest({ ...base, ...over }).authorization;
    const original = sig({});
    expect(sig({ method: "GET" })).not.toBe(original);
    expect(sig({ url: new URL("https://s3.example.com/b/other") })).not.toBe(original);
    expect(sig({ secret: "other" })).not.toBe(original);
    expect(sig({ payloadHash: "a".repeat(64) })).not.toBe(original);
    expect(sig({ date: new Date("2026-01-02T00:00:00Z") })).not.toBe(original);
    expect(sig({})).toBe(original); // same input, same signature
  });
});

describe("settings", () => {
  it("reads the region from a Backblaze address, and falls back sensibly", () => {
    expect(regionFromEndpoint("https://s3.us-west-004.backblazeb2.com")).toBe("us-west-004");
    expect(regionFromEndpoint("https://s3.eu-central-003.backblazeb2.com/")).toBe("eu-central-003");
    expect(regionFromEndpoint("https://example.com")).toBe("us-east-1");
  });
  it("is off when nothing is set, and complains clearly when only some is", () => {
    expect(s3FromEnv({})).toBeNull();
    expect(() => s3FromEnv({ BACKUP_S3_BUCKET: "b" })).toThrow(/Also set: BACKUP_S3_ENDPOINT, BACKUP_S3_KEY_ID, BACKUP_S3_SECRET/);
    expect(() => s3FromEnv({ BACKUP_S3_ENDPOINT: "s3.example.com", BACKUP_S3_BUCKET: "b", BACKUP_S3_KEY_ID: "i", BACKUP_S3_SECRET: "s" })).toThrow(/https/);
  });
  it("reads a complete set", () => {
    expect(s3FromEnv({ BACKUP_S3_ENDPOINT: "https://s3.us-west-004.backblazeb2.com", BACKUP_S3_BUCKET: "b", BACKUP_S3_KEY_ID: "i", BACKUP_S3_SECRET: "s" })).toEqual({
      endpoint: "https://s3.us-west-004.backblazeb2.com", bucket: "b", keyId: "i", secret: "s", region: undefined,
    });
  });
});
