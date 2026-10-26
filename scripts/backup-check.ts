/**
 * Checks your backup bucket settings without touching your polls.
 *
 *   npm run backup:check
 *
 * It reads BACKUP_S3_ENDPOINT, BACKUP_S3_BUCKET, BACKUP_S3_KEY_ID and BACKUP_S3_SECRET from the environment or .env,
 * saves a tiny test file, reads it back, lists it and deletes it, and tells you in plain words what to fix if
 * something fails. It never reads or changes your database.
 */
import { createS3, s3FromEnv, S3Error } from "../server/s3";

let config;
try {
  config = s3FromEnv();
} catch (e) {
  console.error(`Problem with the settings: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
}
if (!config) {
  console.error("Nothing to check yet. Set BACKUP_S3_ENDPOINT, BACKUP_S3_BUCKET, BACKUP_S3_KEY_ID and BACKUP_S3_SECRET (see docs/HOSTING.md).");
  process.exit(1);
}

const s3 = createS3(config);
const key = `check/${new Date().toISOString().replace(/[:.]/g, "-")}.txt`;
const body = `Ority backup check at ${new Date().toISOString()}`;
const step = async (what: string, run: () => Promise<void>) => {
  try {
    await run();
    console.log(`  ok  ${what}`);
  } catch (e) {
    console.error(`  FAILED  ${what}`);
    const status = e instanceof S3Error ? e.status : 0;
    const hint =
      status === 403 ? "The key was refused. Check the key ID and key (the long secret is shown only once when it is made), and that the key is allowed to use this bucket."
      : status === 404 ? "The bucket was not found. Check the bucket name and the endpoint address (the region in the endpoint must match where the bucket is)."
      : status === 0 ? `The address could not be reached (${e instanceof Error ? `${e.message}${(e as { cause?: { code?: string } }).cause?.code ? `: ${(e as { cause: { code: string } }).cause.code}` : ""}` : e}). Check the endpoint starts with https:// and is spelled right.`
      : (e as Error).message;
    console.error(`\n${hint}`);
    process.exit(1);
  }
};

console.log(`Checking the bucket "${config.bucket}" at ${new URL(config.endpoint).host} ...`);
await step("saved a test file", () => s3.put(key, Buffer.from(body), "text/plain"));
await step("read it back", async () => {
  const got = await s3.get(key);
  if (got?.toString() !== body) throw new Error("what came back was not what was saved");
});
await step("listed it", async () => {
  if (!(await s3.list("check/")).includes(key)) throw new Error("the test file was not in the list");
});
await step("deleted it", () => s3.delete(key));
console.log("\nAll good. Ority can save copies of your polls to this bucket.");
