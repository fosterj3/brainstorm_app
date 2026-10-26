import { createHash, createHmac } from "node:crypto";

/**
 * A very small client for S3-compatible storage (Backblaze B2, Cloudflare R2, Amazon S3 and others), written with
 * Node's own crypto and fetch so Ority needs no extra package. It does only what saving and restoring a database
 * copy needs: put, get, list and delete one object at a time, with AWS "Signature Version 4" signing.
 */
export interface S3Config {
  /** For example https://s3.us-west-004.backblazeb2.com */
  endpoint: string;
  bucket: string;
  keyId: string;
  secret: string;
  /** Left out, it is read from the endpoint (the "us-west-004" part of a Backblaze address). */
  region?: string;
}

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const hmac = (key: string | Buffer, data: string) => createHmac("sha256", key).update(data).digest();
export const EMPTY_HASH = sha256("");

/** RFC 3986 encoding, as AWS signing requires: letters, digits and - _ . ~ stay; everything else is %XX. */
const encode = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const encodePath = (path: string) => path.split("/").map(encode).join("/");

export interface SignInput {
  method: string;
  url: URL;
  region: string;
  keyId: string;
  secret: string;
  /** Hex SHA-256 of the body ("" for none). */
  payloadHash: string;
  /** When the request is made. */
  date: Date;
  /** Other headers to sign, such as "range". */
  headers?: Record<string, string>;
  service?: string;
}

/** The headers (including Authorization) to send for a signed request. */
export function signRequest(i: SignInput): Record<string, string> {
  const amzDate = i.date.toISOString().replace(/[-:]|\.\d{3}/g, ""); // 20130524T000000Z
  const day = amzDate.slice(0, 8);
  const service = i.service ?? "s3";
  const all: Record<string, string> = { host: i.url.host, "x-amz-content-sha256": i.payloadHash, "x-amz-date": amzDate };
  for (const [k, v] of Object.entries(i.headers ?? {})) all[k.toLowerCase()] = v.trim();
  const names = Object.keys(all).sort();
  const canonicalHeaders = names.map((n) => `${n}:${all[n]}\n`).join("");
  const signedHeaders = names.join(";");
  const query = [...i.url.searchParams.entries()]
    .map(([k, v]) => [encode(k), encode(v)] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const canonical = [i.method, i.url.pathname, query, canonicalHeaders, signedHeaders, i.payloadHash].join("\n");
  const scope = `${day}/${i.region}/${service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonical)].join("\n");
  const key = hmac(hmac(hmac(hmac(`AWS4${i.secret}`, day), i.region), service), "aws4_request");
  const signature = createHmac("sha256", key).update(toSign).digest("hex");
  return {
    ...Object.fromEntries(Object.entries(all).filter(([k]) => k !== "host")),
    authorization: `AWS4-HMAC-SHA256 Credential=${i.keyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

/** "https://s3.us-west-004.backblazeb2.com" gives "us-west-004". */
export function regionFromEndpoint(endpoint: string): string {
  const host = new URL(endpoint).hostname;
  return /^s3[.-]([a-z0-9-]+)\./.exec(host)?.[1] ?? "us-east-1";
}

export class S3Error extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export interface S3 {
  put(key: string, body: Buffer, contentType?: string): Promise<void>;
  /** The object, or null if there is none. */
  get(key: string): Promise<Buffer | null>;
  list(prefix: string): Promise<string[]>;
  delete(key: string): Promise<void>;
}

export function createS3(config: S3Config, now: () => Date = () => new Date()): S3 {
  const region = config.region ?? regionFromEndpoint(config.endpoint);
  const base = config.endpoint.replace(/\/+$/, "");

  async function send(method: string, key: string, query: Record<string, string> = {}, body?: Buffer, contentType?: string) {
    const url = new URL(`${base}/${encode(config.bucket)}${key ? `/${encodePath(key)}` : ""}`);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    const headers = signRequest({ method, url, region, keyId: config.keyId, secret: config.secret, payloadHash: body ? sha256(body) : EMPTY_HASH, date: now() });
    if (contentType) headers["content-type"] = contentType;
    const res = await fetch(url, { method, headers, body: body as unknown as BodyInit | undefined });
    return res;
  }
  const fail = async (what: string, res: Response) => {
    const text = (await res.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 200);
    throw new S3Error(res.status, `${what} failed (${res.status}): ${text}`);
  };

  return {
    async put(key, body, contentType = "application/octet-stream") {
      const res = await send("PUT", key, {}, body, contentType);
      if (!res.ok) await fail(`Saving ${key}`, res);
    },
    async get(key) {
      const res = await send("GET", key);
      if (res.status === 404) return null;
      if (!res.ok) await fail(`Reading ${key}`, res);
      return Buffer.from(await res.arrayBuffer());
    },
    async list(prefix) {
      const res = await send("GET", "", { "list-type": "2", prefix });
      if (!res.ok) await fail("Listing", res);
      const xml = await res.text();
      return [...xml.matchAll(/<Key>([^<]*)<\/Key>/g)].map((m) => m[1].replace(/&amp;/g, "&"));
    },
    async delete(key) {
      const res = await send("DELETE", key);
      if (!res.ok && res.status !== 404) await fail(`Deleting ${key}`, res);
    },
  };
}

/** Read the settings from the environment. Returns null when backup is not configured. */
export function s3FromEnv(env: Record<string, string | undefined> = process.env): S3Config | null {
  const { BACKUP_S3_ENDPOINT: endpoint, BACKUP_S3_BUCKET: bucket, BACKUP_S3_KEY_ID: keyId, BACKUP_S3_SECRET: secret } = env;
  if (!endpoint && !bucket && !keyId && !secret) return null;
  const missing = [["BACKUP_S3_ENDPOINT", endpoint], ["BACKUP_S3_BUCKET", bucket], ["BACKUP_S3_KEY_ID", keyId], ["BACKUP_S3_SECRET", secret]].filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) throw new Error(`Backup is half set up. Also set: ${missing.join(", ")}.`);
  if (!/^https?:\/\//.test(endpoint!)) throw new Error("BACKUP_S3_ENDPOINT must start with https://");
  return { endpoint: endpoint!, bucket: bucket!, keyId: keyId!, secret: secret!, region: env.BACKUP_S3_REGION || undefined };
}
