# Hosting Ority

Prices and limits below were checked on 24 October 2026 from each provider's own pages where they could be read, and from third-party summaries where they could not (marked). Prices change, so confirm on the provider's page before you buy.

## What Ority needs from a host

- **One running copy, always on.** Votes, live connections and closing times are handled by one Node process. Do not run two copies and do not use scale-to-zero.
- **A disk that survives restarts and deploys.** Everything lives in one SQLite file. This matters most for open polls, which can stay open for days.
- **A public address with HTTPS and WebSocket support.** Every host below provides this.
- **About 512 MB of memory.** In the load test, 400 people voting at once pushed the whole test process (server and the 400 simulated people together) to about 280 MB, so 512 MB leaves comfortable room.

## The options

| | Cost per month | Polls survive restarts? | Sleeps when idle? | Effort | Best for |
| --- | --- | --- | --- | --- | --- |
| **A. Free demo** (Render free) | $0 | No | Yes, after 15 minutes | None (it is what you have today) | Trying Ority, one-sitting live sessions |
| **A+. Free demo plus automatic backup** (Backblaze B2) | $0 | **Yes**, restored from a copy saved at most a minute ago | Yes, unless pinged | About 15 minutes to set up, no code to write | Everyone who will not pay, and still needs polls to last |
| **B. Render paid + disk** | about **$7.25** | Yes | No | Low: same site, same address | Open polls with the least change |
| **C. Fly.io + volume** | about **$3.84** | Yes | No | Medium: uses a command-line tool | Cheapest always-on option with a disk |
| **D. Railway Hobby** | about **$5** (my estimate) | Yes | No | Low to medium | A similar price to Render with usage-based billing |
| **E. Free hosted SQLite** (Turso) | $0 for the database, but see below | Yes | The site still sleeps if it stays on Render free | High: needs code changes and a new dependency | Not recommended now |
| **F. A small server you manage** (Hetzner, DigitalOcean) | about 4 to 6 euros or dollars | Yes | No | High: you run the server | People comfortable with server upkeep |

### A. Free demo, with a visible notice

- **Cost:** $0. Render's free web services have 512 MB of memory and 750 free instance hours per month.
- **What goes wrong for open polls:** the service spins down after 15 minutes without visitors and takes about a minute to wake, and its files are erased "every time the service redeploys, restarts, or spins down" (Render's free-tier page). Any poll is lost when that happens.
- **Making that honest:** run the service with `DEMO_NOTICE=1`. Every page then shows a banner: "Demo site. Polls here can be erased when the service restarts or goes to sleep..." with a link to the FAQ. It is off by default.
- Custom domains work on the free plan.

### A+. Free demo with automatic backup (use this if you will not pay)

Ority can save a compressed copy of its whole database to a private storage bucket shortly after anything changes, and again when the host tells it to stop. When it starts on an empty disk (after sleeping, a restart or a deploy), it downloads the latest copy and carries on. Polls then survive sleeping, restarts, deploys and weeks of nobody visiting.

- **Cost: $0.** Backblaze B2 has a permanent free allowance of 10 GB, and several 2026 sources say its sign-up page does not ask for a credit card (confirm that when you sign up). A copy of Ority's database is tens of kilobytes, so the free allowance will never be close. Uploads are free, and Ority saves at most once a minute and only when something changed.
- **What it fixes:** polls erased by sleeping, restarts, my updates, or weeks of quiet. A poll made today is still there next month (up to the 90-day clean-up that Ority does by design).
- **What it does not fix:**
  1. **Up to about a minute of the newest votes can be lost** if the service is stopped without warning. Normal shutdowns (a deploy, or going to sleep) save one last copy first, as long as the host sends a stop signal, which Render does for deploys. I could not test that signal here, because Windows does not deliver it.
  2. **The slow first visit stays** (up to a minute to wake). To avoid it, use a free uptime monitor to open `https://your-site/api/health` every 10 minutes. A single always-on free service fits Render's 750 free hours a month, but that allowance is shared by all your free services.
  3. **Backblaze's own rules.** I could not find what Backblaze does with a free account that sits unused for a long time. Log in now and then, and read their terms.
  4. **It needs one copy of Ority only.** Two copies saving to the same place would overwrite each other.
- **Safety built in:** if the bucket cannot be reached when Ority starts, it stops and says why, rather than starting empty and overwriting the good copy. A damaged copy is set aside under `unusable/` and never overwritten. A problem saving a copy never crashes the site, and `/api/health` shows `backup: { enabled, lastSavedAt, ok }`.

#### Set it up

1. **Create the account.** Sign up for Backblaze B2 Cloud Storage (backblaze.com). Screens change, so the names below are approximate.
2. **Create a private bucket.** Under Buckets, create one with a name nobody else has, such as `ority-backup-yourname`. Set **Files in Bucket** to **Private**. The copy contains everything in your database, including participant names and the scrambled organizer keys, so it must never be public.
3. **Find the endpoint.** In the bucket's details, copy the **Endpoint** (for example `s3.us-west-004.backblazeb2.com`). Put `https://` in front of it.
4. **Make a key just for this bucket.** Under App Keys, add a new key named `ority`, allow access to **only that bucket**, with read and write. Copy the **keyID** and the **applicationKey** straight away, because the long key is shown only once.
5. **Test the details on your own computer.** Put these four lines in `.env` (it is never committed), then run `npm run backup:check`:
   ```
   BACKUP_S3_ENDPOINT=https://s3.us-west-004.backblazeb2.com
   BACKUP_S3_BUCKET=ority-backup-yourname
   BACKUP_S3_KEY_ID=your keyID
   BACKUP_S3_SECRET=your applicationKey
   ```
   It saves a tiny test file, reads it back, lists it and deletes it, and says in plain words what to fix if anything fails. **Do not run the whole app on your computer with these settings:** an empty local copy would download your live polls and then save over them. For local use, also set `BACKUP_PREFIX=ority-local/`, or just remove these lines again.
6. **Add the same four settings in Render.** Open your service, then Environment, and add `BACKUP_S3_ENDPOINT`, `BACKUP_S3_BUCKET`, `BACKUP_S3_KEY_ID` and `BACKUP_S3_SECRET`. Save, which redeploys.
7. **Check it works.** Open `https://your-site/api/health`. After a minute it should show `"backup":{"enabled":true,"lastSavedAt":"...","ok":true}`. If it says `enabled:false`, the settings did not reach the service. If Render's logs say it is not starting because it cannot reach the bucket, re-check the endpoint and key (step 5).
8. **Prove it survives.** Create a test poll, wait a minute, then in Render choose **Manual Deploy**. When the site is back, the poll should still be there.
9. **Remove the demo notice.** Once step 8 works, delete the `DEMO_NOTICE` setting in Render (and the matching lines in `render.yaml`), because polls are no longer erased.

#### Going back to an earlier copy

Ority also keeps one copy a day for the last 14 days under `ority/daily/`. To go back: suspend the service in Render (so it cannot save over your change), in Backblaze upload that day's file again under the name `ority/latest.db.gz`, then resume the service. It starts on an empty disk and restores that copy.
### B. Render paid plan with a persistent disk

- **Cost:** the Starter web service (512 MB, 0.5 CPU) is **$7 per month**. Render's own pricing page is drawn by script and could not be read here, so that figure comes from Render's search listing and several third-party pages. A persistent disk is **$0.25 per GB per month** (Render's own article), so a 1 GB disk is $0.25. Total: about **$7.25 per month**. Render's Hobby workspace itself is $0 plus compute.
- **What changes:** the disk keeps `data/ority.db` across restarts and deploys. The address stays the same.
- **Limits that come with a disk** (Render's disk page): disks are for paid services only; a service with a disk cannot run more than one copy (which is exactly what Ority needs); and every deploy has a short gap where the site is briefly unavailable, because the old copy must stop before the new one starts. A disk can be made bigger but not smaller.
- **Why recommended:** no migration, the same dashboard you already use, and the least that can go wrong.

### C. Fly.io with a volume (cheapest always-on option)

- **Cost** (Fly's own pricing page): a shared-cpu-1x machine with 256 MB is $2.19 per month and with 512 MB is **$3.69 per month**. A volume is **$0.15 per GB per month**. Outbound data is $0.02 per GB in North America and Europe. With 512 MB and a 1 GB volume: about **$3.84 per month**. 256 MB is probably too tight, so the 512 MB size is what `fly.toml` already asks for.
- **There is no free tier** for new accounts, only a short trial (up to 2 hours of machine time or 7 days).
- **Trade-offs:** you use a command-line tool (`flyctl`) rather than a dashboard. A volume lives on one physical host, so keep off-site backups (see below). Volume snapshots cost $0.08 per GB per month, with the first 10 GB free.
- The config is already in `fly.toml` and has never been run on a real account. Expect to fix small things on the first deploy.

### D. Railway Hobby

- **Cost** (Railway's pricing page): $5 per month, which includes $5 of usage. Usage is billed by the second at about $20 per CPU, $10 per GB of memory and $0.15 per GB of volume per month. A Hobby volume can be at most 5 GB. The Free plan has $1 of monthly credit and 500 MB volumes, which is not enough for an always-on app.
- **My estimate, not Railway's:** a small always-on Ority with a 1 GB volume should use roughly $2 to $4 of usage, which the included $5 covers, so about $5 per month.
- Railway's own pages disagree with some third-party summaries about its free plan, so check before relying on it.

### E. Free hosted SQLite (Turso)

- **Cost** (Turso's pricing page): the free plan has 100 databases, 5 GB of storage, 500 million rows read and 10 million rows written per month. The next plan is $4.99 per month. What happens when a free limit is exceeded was not clear from the sources I could read.
- **Why it is not a quick win:** Turso is a database across the network that answers asynchronously. Ority decides each vote and saves it in one step inside a transaction, in synchronous code. Using Turso would mean rewriting every database call (well over a hundred) to wait for the network, adding the `@libsql/client` package, and accepting a network trip for every vote. You would also still need somewhere to run the website, and on Render's free plan that site would still sleep for a minute at a time. The data would be safe, but the experience would not be better.
- `server/storage.ts` is built so a swap is possible later, and its test suite is the checklist for a new backend. A network database would need the async change first.

### F. A small server you manage

- Hetzner's shared servers are about 5 to 6 euros per month (sources disagree after price changes in mid-2026). DigitalOcean's $4 server has only 512 MB, which is tight for building the site on it; the $6 one has 1 GB. Oracle Cloud has a free tier, but its limits have been changing and unused servers can be reclaimed.
- You would install Docker, set up HTTPS (for example with Caddy), apply updates and arrange backups yourself. Only choose this if you already do that kind of work.

### My recommendation

1. **If open polls matter:** go with **B** (Render paid plus a 1 GB disk, about $7.25 per month). It is the same site at the same address with nothing to migrate.
2. **If saving about $3.40 a month matters and you are comfortable with a command line:** **C** (Fly, about $3.84 per month).
3. **Free and lasting:** set up A+ (steps above), then remove the demo notice. This is what was chosen. Until A+ is working, keep `DEMO_NOTICE=1` so nobody is surprised.
4. A domain name is separate: typically about $10 to $15 per year for a `.com` (not researched here).

**Decision (24 October 2026): do not pay for hosting. Stay on the free plan.** Because polls must survive days and weeks of quiet, the plan is option A+ (the free demo plus automatic backup to a free Backblaze bucket) once it is set up. Until then, `render.yaml` sets `DEMO_NOTICE=1`. `render.yaml` sets `DEMO_NOTICE=1` for that reason. Nothing in `render.yaml` or `fly.toml` is set up for a paid plan. If that changes later, the steps below are ready, and the demo notice should be removed once polls are kept on a disk.

## How to switch tiers

### Render: free to paid with a disk

1. In the Render dashboard open the service, then **Settings** and change **Instance Type** to **Starter**.
2. Under **Disks**, add a disk named `ority-data`, mounted at `/app/data`, 1 GB.
3. Under **Environment**, set `DB_PATH` to `/app/data/ority.db`, and remove `DEMO_NOTICE` if you set it. Keep `TRUST_PROXY=1`.
4. Change the **Health Check Path** to `/api/health`. It checks that the database answers.
5. Deploy. There is nothing to move from the free plan, because its files were never kept.

The same in `render.yaml` (not applied):

```yaml
services:
  - type: web
    name: ority            # must match the service's name in the dashboard, see "Renaming" below
    runtime: docker
    plan: starter
    healthCheckPath: /api/health
    disk:
      name: ority-data
      mountPath: /app/data
      sizeGB: 1
    envVars:
      - key: TRUST_PROXY
        value: "1"
      - key: DB_PATH
        value: /app/data/ority.db
```

### Fly.io

```bash
fly launch --no-deploy --copy-config        # choose your own unique app name when asked
fly volumes create ority_data --size 1      # same region as the app
fly deploy
```

`fly.toml` already mounts the volume at `/data` and sets `DB_PATH=/data/ority.db`. To use your own address for canonical links, add `[build.args]` with `SITE_URL = "https://your.domain"` to `fly.toml`.

### What changes at each tier

| | Free demo | Render paid + disk | Fly or Railway |
| --- | --- | --- | --- |
| Polls kept across restarts | No | Yes | Yes |
| Site sleeps when idle | After 15 min | No | No |
| Open polls are safe | No | Yes | Yes |
| Deploys | Fine | Brief downtime | Brief downtime |
| Copies running | 1 | 1 (a disk allows only 1) | Keep it at 1 |
| `DEMO_NOTICE` | Set to 1 | Remove | Remove |
| `DB_PATH` | Not needed | `/app/data/ority.db` | `/data/ority.db` (Fly) |
| Health check | `/` | `/api/health` | `/api/health` |
| Backups | None possible | `npm run backup`, plus disk snapshots | `npm run backup`, plus volume snapshots |
| Address | `*.onrender.com` | Same | `*.fly.dev` or your own |

## Renaming the service

- **Render:** a Render staff member has said a service's `onrender.com` address (its slug) cannot be changed, and that renaming only changes the display name (Render community forum). So renaming will not break links people already have, and it will not give you a new address either. To get a new address, use a custom domain.
- **The `render.yaml` risk:** it is not documented what a Blueprint does when the `name` in `render.yaml` no longer matches a service's name. It may create a second, new service. To stay safe: rename the service in the dashboard (**Settings**, then **Name**) first, then make `render.yaml` use the same name. The repository currently says `name: ority`.
- **Fly:** I could not confirm that an app can be renamed. Choose the final name before you launch.
- **In the app:** the product name appears in `package.json`, `client/index.html`, `shared/site.ts`, the page copy and the README. Browser storage keys and the default database file name keep their old `brainstorm` names on purpose, so nothing saved breaks.

## Attaching your own domain

1. **Choose a subdomain or a root domain.** A subdomain such as `polls.example.org` is simplest.
2. **Render:** open the service, **Settings**, **Custom Domains**, **Add Custom Domain**, enter it and Save. Render then shows the DNS records to create (for a subdomain, a CNAME to your `onrender.com` address). Remove any `AAAA` records for that name first, create the records at your DNS provider, return and press **Verify**. Render makes and renews the HTTPS certificate itself and redirects HTTP to HTTPS. If you add a root domain, Render adds `www` and redirects it to the root. Cost: the Hobby workspace includes 2 custom domains and each extra is $0.25 per month. Free services can use custom domains too.
3. **Fly:** run `fly certs add polls.example.org`. It prints the records to create: A and AAAA records for a root domain, or a CNAME to `your-app.fly.dev` for a subdomain. `fly certs check polls.example.org` shows progress. Certificates are issued automatically by Let's Encrypt. Fly's custom-domain page does not mention a certificate cost.
4. **Tell Ority its address.** Set `SITE_URL=https://polls.example.org` (on Render as an environment variable, on Fly as a build argument) and deploy again. Canonical links, the sitemap, `robots.txt` and share images then use your domain.
5. **Old links keep working.** Participant and organizer links made on the old address stay valid as long as that address still points at the service, because links carry only a code.

## Backups

- `npm run backup` writes a safe copy of the database while the app is running, to `backups/ority-<date>-<time>.db`. It uses the same `DB_PATH` as the server.
- On Render open the service's **Shell**; on Fly run `fly ssh console -C "npm run backup"`. A backup kept on the same disk protects against mistakes, not against losing the disk, so copy it somewhere else now and then. Confirm the snapshot options and how long they are kept for your plan.
- **Restoring:** stop the app, replace the database file with the backup, delete the `-wal` and `-shm` files next to it, and start the app. A restored copy opens like any other database.
- Organizers can also download a results file (CSV) from any closed poll, and rebuild a poll from it on the home page.

## Checking a deployment

- **Health:** open `/api/health`. It should say `{"ok":true,"storage":"sqlite",...}`, and `backup` shows whether copies are being saved.
- **Load test:** `npm run loadtest -- --url https://your.domain --polls 1` runs 50 simulated people against your site. Creating polls is limited to 10 per hour per address, so keep `--polls` small, and only test a site you own. The test leaves its polls behind, and they delete themselves after 90 days.
- **Before a live session:** open the participant link on a phone, and download a backup.

## Load test results

Run on a laptop with the server and all simulated people in one process, which is demanding for one machine, so these numbers lean cautious on CPU. They do not include internet delay.

| Run | Result |
| --- | --- |
| 50 people in one poll (each of the four methods) | All passed. Votes took about 6 to 35 ms at the median. The busiest request took about 110 ms. |
| 200 people across 10 polls, all four methods at once, with a restart | Passed. Results identical after a restart. Median vote about 80 ms, 95th percentile about 230 ms. |
| 400 people across 8 polls at once | Passed three times in a row. About 10 seconds each. Median vote about 200 ms, 95th percentile 240 to 370 ms. Memory about 275 MB for server and simulated people together. |

The test also checks that nobody receives anyone else's votes or name, that the organizer never receives individual votes, that people who drop their connection and return lose nothing, and that the final results match a separate tally. One run in the 400-person group needed a few dozen connection retries, which is how a browser would behave when hundreds of connections arrive in a burst.

## Settings reference

| Variable | What it does |
| --- | --- |
| `PORT` | Port to listen on (default 3000). |
| `DB_PATH` | Database file. Must be on the persistent disk when hosted. |
| `STORAGE` | Storage adapter (default `sqlite`, the only one built in). |
| `BACKUP_S3_ENDPOINT`, `BACKUP_S3_BUCKET`, `BACKUP_S3_KEY_ID`, `BACKUP_S3_SECRET` | Save copies of the database to a private S3-compatible bucket, and restore on startup. Set all four or none. |
| `BACKUP_S3_REGION` | Only if it cannot be read from the endpoint. |
| `BACKUP_PREFIX` | Folder inside the bucket (default `ority/`). Use a different one for anything on your own computer. |
| `BACKUP_INTERVAL_SECONDS` | How often to check for changes (default 60, at least 5). |
| `TRUST_PROXY` | Set to `1` behind a host's proxy. |
| `DEMO_NOTICE` | Set to `1` to show the demo banner on every page. |
| `SITE_URL` | The public address, used when the site is built (canonical links, sitemap, share images). |
