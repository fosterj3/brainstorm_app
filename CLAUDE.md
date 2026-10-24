# Ority

Ority (formerly brainstorm_app) is being evolved into a multi-purpose prioritization product. Phases: (1) rebrand and design tokens, (2) language and data-model generalization (poll, options, votes, organizer), (3) voting methods (dots, rank, score, 100 point), (4) open polls with deadlines and a one-screen creation flow, (5) website pages and SEO, (6) hosting, persistence, URL and the 50-person load test. Pause for review after each phase. Everything under Server-side invariants stays in force.

A web app where anyone can run a prioritization vote. An organizer creates a poll (options, optionally in colored groups), shares one link, and participants vote for their top choices, in a live timed session or, soon, an open poll with a deadline. The organizer locks voting and reveals ranked results.

Scale targets: 5 participants first, must handle 20 and 50 concurrent in one session, with many sessions on one server.

## How it works

Words in the product: **poll**, **options** (optionally in **groups**), **votes**, **organizer**. Database table names and the `/s/<code>` and `/f/<code>#secret` URLs keep their old names on purpose. Ority has two modes of one product: a **live session** (the organizer runs a timed vote, locks it and reveals results) and an **open poll** (open from creation; people vote any time before a stored deadline, and it closes and reveals itself then). Open polls are the default on the create screen.

- **No accounts.** Anyone can open the site and create a poll. Access is by capability links:
  - Participant link `/s/<code>`: the code is public and short (8 characters).
  - Organizer link `/f/<code>#<secret>`: the secret is a long random key in the URL fragment, so it is never sent to the server in a request line. Only a hash of it is stored.
- **Each poll is its own session**: its own options, groups, settings, timer, participants and votes. Nothing is shared between polls.
- **Polls are deleted after 90 days idle**, with everything in them.

### Organizer (secret link)
- Builds the poll: title, description, page background, options (title, short description, details; a short code and tag are optional and hidden until asked for) and optional groups (name, description, any color, reorder, delete). With no groups the options show as one plain list.
- Import options/groups from CSV or JSON, add/edit/move/merge/delete in the UI, export the poll as JSON. Preview exactly what participants see.
- Settings: votes per person, anonymous vs. named results, whether participants may add options (and how many each), auto-lock when time runs out.
- Timer: preset, custom, or none. Start, pause, resume, extend, lock, reopen.
- Sees only headcounts (joined, online, submitted), never what anyone picked.
- Then lock voting and reveal results: ranked by votes, ties shown clearly (shared rank, 1-2-2-4), grouped view when the poll has groups, full-screen presentation mode, CSV export. Results are gated on the server: nothing is tallied until the reveal, and participants never receive them.

### Participant (public link)
- Joins by entering a name. Sees the options (in colored groups if there are any), readable on laptop and phone. Cards show title, short description and a "Details" disclosure, plus a code and tag only if the organizer set them.
- Votes for up to the cap with a visible "2 of 3 votes used" counter and easy un-vote/re-vote until voting locks. A hard cap, enforced by the server.
- Votes are private: no running totals anywhere.
- Can add their own options (before voting starts) via the dashed "Add your own option" tile; these go in the poll's ungrouped section. The author is stored but never shown to participants.
- Countdown synced to the server's clock. "Submit my votes" feeds the organizer's count; edits stay possible until lock.

### Data model
- The ungrouped section is a `columns` row with `kind = 'group'`, shown as "Other options". Named groups are `kind = 'normal'`.
- `votes.value` (default 1) is what a vote is worth: 1 per dot, or a rank, a 1 to 5 score, or points. Settings `method` (`dots` default), `mode` (`live` default) and `deadline` are per-poll and validated on read. All four methods work in live mode; `mode: poll` polls start in the voting phase, take no participant-added options and no timer, and `reconcile()` closes them (phase `revealed`) when `now >= deadline`. That check runs on every request from the stored time, never from an in-memory timer, so it survives restarts; the server timer only pushes a refresh to open screens and re-arms from the database at startup.
### Voting methods (server rules in `server/ballots.ts`, tallies in `server/results.ts`)
- Dots: toggle one option at a time (`PUT /api/s/:sid/votes/:id`), capped by votes per person. Rank, score and points: the whole ballot is sent and replaced at once (`PUT /api/s/:sid/ballot`). Each route rejects the other method.
- Rank: places unique and starting at 1; all options ranked when there are 10 or fewer, otherwise the top 5. Tally is a Borda count (K places: 1st earns K, last earns 1, unranked 0), with each person's ranks tidied to 1, 2, 3 first. Score: whole numbers 1 to 5, skipping allowed; tally is the average with ties split by number of ratings, compared as exact fractions. Points: whole numbers, total at most 100, exactly 100 to submit; tally is the sum.
- Submitting needs a finished ballot per method, and editing a submitted ballot into an unfinished one clears the submitted mark. The method can only change during setup. Merging options with votes is blocked outside dot polls.
- Every method keeps the same invariants: nothing is tallied until reveal, participants only receive their own ballot, ties are 1, 2, 2, 4, and tests cover each rule (`server/methods.test.ts`, `client/src/methods.test.ts`).

- Results CSV headers are `Rank, Tied, Code, Option, Group, Tag, Votes[, Voted by]`. Restore and import also accept the older names.
## Technical constraints

- Single server, SQLite, WebSockets for real-time sync. No Redis, queues, or microservices. Run exactly one instance.
- Stack: Node 22 + TypeScript, Fastify, `ws`, `better-sqlite3`, Vite + Preact, Vitest.
- Handle 50 concurrent participants per session; layout stays usable with 10 ideas or 60.
- Reconnects and refreshes must not lose votes. The server is the source of truth; every vote change is persisted. Clients refetch their state on every socket (re)connect.
- Accessible: keyboard navigable, good contrast, announced timer milestones. Polished, minimal design.
- **Ask before adding any major dependency.**

## Server-side invariants

- Every query is scoped by session id. An organizer key or participant token for one session must never read or change another. Tests cover this.
- The vote cap, phase (setup/voting/locked) and timer are enforced on the server. Never trust the client.
- Participant-facing messages never include other people's votes or totals, or who suggested an option. Vote data is sent only to the organizer after reveal, and per-person picks only when results are set to named.
- The organizer's live view gets headcounts only, not picks. Tallies exist only in the `revealed` phase, and only for the organizer key.
- CSV export neutralises spreadsheet formulas (cells starting with = + - @), because option titles come from participants.
- Organizer secrets are compared by hash in constant time, never logged, never put in query strings (except the websocket handshake) and never committed.
- Creating polls is rate limited per client.

### Open polls (rules in `server/session.ts` and `server/index.ts`)
- Create: `POST /api/sessions` takes title, subtitle, method, mode, deadline, options, groups and settings, and validates everything before anything is saved (an open poll needs two options and a deadline between now and a year away).
- Organizer: `close` (open to revealed), `reopen` (with a new deadline or none; an old past deadline is never kept), and a `deadline` setting while open. Participants never get results unless `share_results` is on, the poll is closed, and they hold a token for that poll; `GET /api/s/:sid/results` is then anonymous no matter what the organizer sees.
- Tests: `server/openpoll.test.ts` (deadline closing from the stored time, restart, privacy, validation), `shared/templates.test.ts`.

### Website and SEO (phase 5)
- Content pages (`/`, `/templates`, `/voting-methods`, `/faq`, `/privacy`, `/terms`, `/404`) are components in `client/src/pages/` that must stay free of hooks, `window`, `localStorage` and other browser-only code, because `client/prerender.tsx` renders them to HTML at build time (via the `vite-prerender-plugin` that ships with `@preact/preset-vite`). Their titles, descriptions and indexing live in `shared/routes.ts`; the head tags, sitemap and robots.txt are generated from that one list.
- No new dependency was added for this: `client/src/renderStatic.ts` is a small in-repo renderer. Ask before replacing it with a package.
- App pages (`/create`, `/s/<code>`, `/f/<code>`) are drawn in the browser and are `noindex`. Poll and organizer links must never appear in the sitemap.
- `server/static.ts` decides what every address shows and returns a real 404 for unknown addresses. Hashed assets are cached for a year, HTML is always revalidated.
- Copy rules still apply: clear, friendly, no jargon, no em dashes. Privacy and terms are drafts with bracketed placeholders in `shared/site.ts`; do not present them as final legal text.
- Tests: `client/src/pages/pages.test.tsx` (every page), `server/static.test.ts` (routing and 404). A page that skips a heading level, links to a missing page, or lacks a description fails them.

### Hosting, storage and load testing (phase 6)
- All database access goes through the interface in `server/storage.ts` (`DB` in `server/db.ts` is another name for it): `prepare` (get, all, run), `exec`, `transaction`, `backup`, `close`. It must stay synchronous and SQLite-compatible. Add a backend as one more adapter there, and run the contract tests in `server/storage.test.ts` against it. Do not import `better-sqlite3` anywhere else.
- Connection events in `server/hub.ts` run outside any request, so an error there would stop the whole process. They are wrapped and logged, and `server/shutdown.test.ts` guards that. Keep new socket handlers equally safe.
- `GET /api/health` (database check) and `GET /api/config` (demo notice flag) are public and reveal nothing private. `DEMO_NOTICE=1` shows a banner on every page.
- `npm run backup` makes a safe copy of the database. `npm run loadtest` (scripts/loadtest.ts) simulates people over real HTTP and WebSocket connections and checks that nothing is lost, nobody sees anyone else's data, and the results equal an independent tally. `server/load.test.ts` runs it in the normal tests, including a check that it fails when the data is tampered with.
- `docs/HOSTING.md` holds the hosting comparison, prices (with the date they were checked), tier changes, renaming and custom domain steps. Update the prices there when they are re-checked. Paid hosting and any new dependency need the owner's approval first. The owner has decided not to pay for hosting: the free Render service runs with `DEMO_NOTICE=1` (set in `render.yaml`).

## Brand rules

- Brand color is black currant `#2E183B`. Use design tokens from `client/src/styles.css`; never hardcode grays or colors in components. Per-column colors chosen by organizers are the exception.
- Text must meet WCAG AA. Add any new color pair to `client/src/contrast.test.ts`.
- Copy is clear, friendly and professional. No jargon and no em dashes.
- Browser storage keys keep the old `brainstorm.` prefix so saved organizer links keep working. The default database file is `data/ority.db`, falling back to `data/brainstorm.db` if only that exists.

## Repo rules

- Never commit real option content, organizer links or keys, passcodes, or exported results.
- Real data goes in `/data` (gitignored). Commit only `ideas.example.json` (made-up sample poll).
- Secrets and local settings go in `.env` (gitignored). Commit `.env.example`.
- Vote cap, anonymity, option limits, timer and colors are organizer settings, never hardcoded. Defaults are only initial values.
- Write tests for vote-cap logic, lock behavior, and result tallying, plus session isolation.
- Keep the README current with run-locally and hosting instructions. Phases 1 to 6 (rebrand, language and data model, voting methods, open polls and creation, website and SEO, hosting options, storage interface and load test) are done. The 5-phase plan item "Load test simulating 50 participants" is complete.

## Workflow

Built in phases, pausing for the user's review after each:
1. Single-user voting UI with the hard star cap (done)
2. Multi-user real-time sync (done)
3. Facilitator controls and timer (done)
3b. Multi-board web app: home page, create-your-own board, colors, secret links (done)
4. Results, presentation mode, and CSV export (done)
5. Load test simulating 50 participants

At the end, document how to run locally and what is needed to host a live session.

Do not commit or push unless asked.
