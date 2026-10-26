import http from "node:http";
import type { AddressInfo } from "node:net";
import { createHash } from "node:crypto";
import { createS3, signRequest } from "./s3";
export const KEY_ID = "test-key-id";
export const SECRET = "test-secret";
export const BUCKET = "ority-test";

/**
 * A pretend bucket that behaves like S3: it keeps objects in memory and checks every request's signature with the
 * same rules a real service uses, so a wrong key or a badly signed request is refused with 403.
 */
export async function fakeBucket(opts: { delayPutMs?: number } = {}) {
  const objects = new Map<string, Buffer>();
  const log: string[] = [];
  let failNext = 0;
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks);
    const url = new URL(req.url!, `http://${req.headers.host}`);
    log.push(`${req.method} ${url.pathname}`);
    // Check the signature, as a real service would.
    const date = String(req.headers["x-amz-date"] ?? "");
    const sent = String(req.headers.authorization ?? "");
    const bodyHash = createHash("sha256").update(body).digest("hex");
    const expected = date
      ? signRequest({ method: req.method!, url: new URL(`http://${req.headers.host}${req.url}`), region: "us-test-001", keyId: KEY_ID, secret: SECRET, payloadHash: bodyHash, date: new Date(date.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, "$1-$2-$3T$4:$5:$6Z")) }).authorization
      : "";
    if (sent !== expected || req.headers["x-amz-content-sha256"] !== bodyHash) return void res.writeHead(403).end("<Error><Code>SignatureDoesNotMatch</Code></Error>");
    if (failNext > 0) { failNext--; return void res.writeHead(500).end("<Error>try again</Error>"); }
    const prefix = `/${BUCKET}/`;
    if (!url.pathname.startsWith(prefix) && url.pathname !== `/${BUCKET}`) return void res.writeHead(404).end();
    const key = decodeURIComponent(url.pathname.slice(prefix.length));
    if (req.method === "PUT") {
      if (opts.delayPutMs) await new Promise((r) => setTimeout(r, opts.delayPutMs));
      objects.set(key, body);
      return void res.writeHead(200).end();
    }
    if (req.method === "DELETE") { objects.delete(key); return void res.writeHead(204).end(); }
    if (req.method === "GET" && !key) {
      const p = url.searchParams.get("prefix") ?? "";
      const keys = [...objects.keys()].filter((k) => k.startsWith(p));
      return void res.writeHead(200, { "content-type": "application/xml" }).end(`<ListBucketResult>${keys.map((k) => `<Contents><Key>${k}</Key></Contents>`).join("")}</ListBucketResult>`);
    }
    if (req.method === "GET") {
      const found = objects.get(key);
      return void (found ? res.writeHead(200).end(found) : res.writeHead(404).end("<Error><Code>NoSuchKey</Code></Error>"));
    }
    res.writeHead(405).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const s3 = createS3({ endpoint, bucket: BUCKET, keyId: KEY_ID, secret: SECRET, region: "us-test-001" });
  return {
    s3, objects, log, endpoint,
    failNext: (n: number) => { failNext = n; },
    close: () => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
  };
}

