# brainstorm_app

Live, silent prioritization exercises for leadership teams. A facilitator loads ideas; participants join by link, enter a name, and star their top N during a timed quiet period; the facilitator locks voting and reveals ranked results.

**Status:** Phase 3 of 5 (facilitator controls and timer). Results, presentation mode and CSV export are phase 4; the 50-person load test is phase 5. See [CLAUDE.md](CLAUDE.md) for the rules and plan.

## How a session runs

1. **Set up** (`/facilitator`, passcode protected): import ideas from CSV or JSON, or add, edit, merge and delete them in the UI. Choose stars per person, whether results will be anonymous or named, whether participants may suggest ideas, and a quiet-voting time (or no timer at all).
2. **Share the participant link** (shown on the facilitator screen). People enter a name and can read the ideas and suggest their own while you set up.
3. **Start voting.** The countdown starts on everyone's screen, synced to the server's clock. Participants star ideas up to the cap and press "I'm done" when finished. You see only how many have submitted, never what anyone picked.
4. **Control the clock:** pause, resume, add a minute or five, or lock voting when you are ready (or let it lock automatically when time runs out). You can reopen voting after a lock.

Ideas CSV: a header row with `title` and optionally `description` and `theme`. JSON: a list of objects with the same fields. See `ideas.example.json`.

## Run locally

Requires Node 22+.

```bash
npm install
cp .env.example .env     # then set FACILITATOR_PASSCODE
npm run build
npm start
```

Open http://localhost:3000 (participants) and http://localhost:3000/facilitator (facilitator). Without `FACILITATOR_PASSCODE` the facilitator view is disabled.

The database starts empty. For development, set `SEED_EXAMPLE=1` in `.env` to load the made-up sample ideas from `ideas.example.json` into an empty database.

For development with hot reload, run `npm run dev:server` and `npm run dev:client` in two terminals and open the Vite URL (http://localhost:5173). To try multi-user sync, open the page in two different browsers (or a normal and a private window) and join with different names.

Other commands: `npm test`, `npm run typecheck`.

Windows note: if the repo lives in a folder whose path contains `&` (for example a OneDrive folder), `npm run` fails because of how Windows cmd handles that character. Run the tools directly, for example `node node_modules/vitest/vitest.mjs run`, or move the repo to a simpler path.

## Configuration

Copy `.env.example` to `.env` (gitignored). Real ideas go in `data/` (gitignored); never commit them, passcodes or exported results. Stars per person, anonymity, idea limits and the timer are facilitator settings, not code constants.

| Variable | Purpose |
| --- | --- |
| `FACILITATOR_PASSCODE` | Required for the facilitator view. Use something unguessable. |
| `PORT` | Port to listen on (default 3000). |
| `DB_PATH` | SQLite file (default `data/brainstorm.db`). Must be on persistent storage when hosted. |
| `TRUST_PROXY` | Set to `1` when behind a hosting proxy so the passcode attempt limit sees real client IPs. |
| `SEED_EXAMPLE` | Development only: `1` loads the sample ideas into an empty database. |

## Hosting for a live session

The app is one Node process holding WebSockets and timers in memory, with a SQLite file. That means:

- **Run exactly one instance.** Do not scale out or use scale-to-zero.
- **The database needs a persistent disk**, so votes survive restarts and deploys.
- **It needs a public HTTPS URL.** WebSockets (`wss://`) must be allowed, which every mainstream host does.

Config files are included for two hosts (the Docker build has not yet been run on a real host):

**Fly.io** (`fly.toml`, `Dockerfile`):

```bash
fly launch --no-deploy --copy-config     # pick a unique app name
fly volumes create brainstorm_data --size 1
fly secrets set FACILITATOR_PASSCODE=<choose-a-passcode>
fly deploy
```

Participants then use `https://<app-name>.fly.dev/` and you use `https://<app-name>.fly.dev/facilitator`.

**Render** (`render.yaml`): create a Blueprint from this repo, set `FACILITATOR_PASSCODE` when prompted. A persistent disk requires a paid plan.

Before a live session: open the facilitator link on the day, load your ideas, and do a quick join from a phone. Delete `data/` (or reset the volume) between sessions so one group's participants and votes never carry into the next.
