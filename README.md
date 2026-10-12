# brainstorm_app

A web app for live, silent prioritization exercises. Anyone can open the site, create a board of idea cards in colored columns, send one link to their group, and see what people star. Everyone votes privately and at the same time.

**Live app: https://brainstorm-app-wqbg.onrender.com**

Open it, click **Facilitate a session**, and share the participant link it gives you. It runs on Render's free plan, so it sleeps after about 15 minutes without visitors (the first visit then takes up to a minute to wake it) and boards are forgotten when it sleeps or restarts. See "Hosting" below.

**Status:** boards, links, voting, sync, facilitator controls, timer, results, presentation mode and CSV export are working. A 50-person load test is next (phase 5). See [CLAUDE.md](CLAUDE.md) for the rules and plan.

## How a session runs

1. **Create a board** on the home page: give it a title, start blank or from an example. You get two links:
   - a **participant link** (`/s/<code>`) to share, and
   - a **private facilitator link** (`/f/<code>#<secret>`) to bookmark. There are no accounts, so this link is your access. Anyone who has it can run the session.
2. **Build the board** (facilitator, "Build the board" tab): set the title, subtitle and page color; add columns with their own colors and descriptions; add cards with a short code, an audience tag, a title, a summary and longer details. Or import a CSV/JSON file, and download the board as JSON to reuse later.
3. **Run the session** ("Run the session" tab): share the participant link, pick a quiet voting time (or none), choose stars per person, anonymous or named results, and whether people can add their own ideas. Start voting.
4. **Participants** open the link, enter a name, read the ideas, and star up to their limit. They can add their own ideas before voting starts. They press "I'm done" when finished. You see only how many have submitted, never what anyone picked.
5. **Control the clock:** pause, resume, add time, lock voting (or let it lock automatically), and reopen if needed.
6. **Reveal the results.** After locking, click **Reveal results**. Until then nobody can see the tally, including you. The Results tab ranks ideas by stars, labels ties (tied ideas share a rank: 1, 2, 2, 4), and can group the same results by column. Click **Present full screen** to project it, and **Download CSV** to keep a copy. Results are anonymous unless you chose "Who starred what" before revealing. Participants never see the tally; they only see that results are being shared. **Hide results** takes them off screen again.

CSV import: a header row with `title`, and optionally `column`, `summary`, `details`, `audience`, `code`. Columns are created as needed. JSON import also accepts a `columns` list with colors. See `ideas.example.json`.

Boards that nobody has used for 90 days are deleted automatically.

## Run locally

Requires Node 22+.

```bash
npm install
npm run build
npm start
```

Open http://localhost:3000, click "Create board", and use the participant link in a second browser (or a private window) to try it as a participant.

For development with hot reload, run `npm run dev:server` and `npm run dev:client` in two terminals and open the Vite URL (http://localhost:5173).

Other commands: `npm test`, `npm run typecheck`.

Windows note: if the repo lives in a folder whose path contains `&` (for example a OneDrive folder), `npm run` fails because of how Windows cmd handles that character. Run the tools directly, for example `node node_modules/vitest/vitest.mjs run`, or move the repo to a simpler path.

## Configuration

Copy `.env.example` to `.env` (gitignored). Real data lives in `data/` (gitignored); never commit facilitator links, keys or exported results. Stars per person, anonymity, idea limits, the timer and colors are facilitator settings, not code constants.

| Variable | Purpose |
| --- | --- |
| `PORT` | Port to listen on (default 3000). |
| `DB_PATH` | SQLite file (default `data/brainstorm.db`). Must be on persistent storage when hosted. |
| `TRUST_PROXY` | Set to `1` when behind a hosting proxy so the board-creation rate limit sees real client IPs. |

## Hosting for a live session

The app is one Node process holding WebSockets and timers in memory, with a SQLite file. That means:

- **Run exactly one instance.** Do not scale out or use scale-to-zero.
- **The database needs a persistent disk**, so boards and votes survive restarts and deploys.
- **It needs a public HTTPS URL.** WebSockets (`wss://`) must be allowed, which every mainstream host does.

Config files are included for two hosts (the Docker build has not yet been run on a real host):

**Fly.io** (`fly.toml`, `Dockerfile`):

```bash
fly launch --no-deploy --copy-config     # pick a unique app name
fly volumes create brainstorm_data --size 1
fly deploy
```

The site is then at `https://<app-name>.fly.dev/`. Anyone can create boards there, so consider the abuse limits (board creation is rate limited per client, and idle boards are deleted) before sharing the address widely.

**Render, free plan** (`render.yaml`), no cost and no card needed:

1. Sign in at https://render.com with GitHub and open https://dashboard.render.com/blueprint/new?repo=https://github.com/fosterj3/brainstorm_app (allow Render to read the repo when asked).
2. Click **Deploy Blueprint**. The first build takes a few minutes.
3. Render shows the address, like `https://brainstorm-app-xxxx.onrender.com`. That is the link anyone can use.

Free plan limits: the service sleeps after about 15 minutes with no visitors (the next visit takes up to a minute to wake it), and it has no persistent disk, so **boards are forgotten when it sleeps or restarts**. Download your board as JSON (Build the board, Import and export) so you can re-import it. For boards that must survive, switch the service to a paid plan and add a disk mounted at `/app/data`.

Before a live session, do a quick join from a phone. Back up the `data/` volume if the results matter to you.
