# brainstorm_app

A web app where anyone can run a live, silent prioritization exercise. A facilitator creates a board (colored columns of idea cards), shares one link, and participants star their top N ideas during an optional timed quiet period. The facilitator locks voting and reveals ranked results.

Scale targets: 5 participants first, must handle 20 and 50 concurrent in one session, with many sessions on one server.

## How it works

- **No accounts.** Anyone can open the site and create a board. Access is by capability links:
  - Participant link `/s/<code>`: the code is public and short (8 characters).
  - Facilitator link `/f/<code>#<secret>`: the secret is a long random key in the URL fragment, so it is never sent to the server in a request line. Only a hash of it is stored.
- **Each board is its own session**: its own columns, ideas, settings, timer, participants and votes. Nothing is shared between boards.
- **Boards are deleted after 90 days idle**, with everything in them.

### Facilitator (secret link)
- Builds the board: title, subtitle, page background, columns (name, description, any color, reorder, delete), ideas (short code, audience tag, title, summary, longer "details").
- Import ideas/columns from CSV or JSON, add/edit/move/merge/delete in the UI, export the board as JSON. Preview exactly what participants see.
- Settings: stars per person, anonymous vs. named results, whether participants may add ideas (and how many each), auto-lock when time runs out.
- Timer: preset, custom, or none. Start, pause, resume, extend, lock, reopen.
- Sees only headcounts (joined, online, submitted), never what anyone picked.
- Then lock voting and reveal results: ranked by stars, ties shown clearly (shared rank, 1-2-2-4), grouped-by-column view, full-screen presentation mode, CSV export. Results are gated on the server: nothing is tallied until the reveal, and participants never receive them.

### Participant (public link)
- Joins by entering a name. Sees colored columns of cards, collapsible, readable on laptop and phone. Cards show code, audience tag, title, summary and a "Details" disclosure.
- Stars up to the cap with a visible "2 of 3 used" counter and easy un-star/re-star until voting locks. A hard cap, enforced by the server.
- Votes are private: no running totals anywhere.
- Can add their own ideas (before voting starts) via the dashed "Add your own idea" tile; these go in the board's group column. The author is stored but never shown to participants.
- Countdown synced to the server's clock. "I'm done" submits (feeds the facilitator's count; edits stay possible until lock).

## Technical constraints

- Single server, SQLite, WebSockets for real-time sync. No Redis, queues, or microservices. Run exactly one instance.
- Stack: Node 22 + TypeScript, Fastify, `ws`, `better-sqlite3`, Vite + Preact, Vitest.
- Handle 50 concurrent participants per session; layout stays usable with 10 ideas or 60.
- Reconnects and refreshes must not lose votes. The server is the source of truth; every vote change is persisted. Clients refetch their state on every socket (re)connect.
- Accessible: keyboard navigable, good contrast, announced timer milestones. Polished, minimal design.
- **Ask before adding any major dependency.**

## Server-side invariants

- Every query is scoped by session id. A facilitator key or participant token for one session must never read or change another. Tests cover this.
- The vote cap, phase (setup/voting/locked) and timer are enforced on the server. Never trust the client.
- Participant-facing messages never include other people's votes or totals, or who suggested an idea. Vote data is sent only to the facilitator after reveal, and per-person picks only when results are set to named.
- The facilitator's live view gets headcounts only, not picks. Tallies exist only in the `revealed` phase, and only for the facilitator key.
- CSV export neutralises spreadsheet formulas (cells starting with = + - @), because idea titles come from participants.
- Facilitator secrets are compared by hash in constant time, never logged, never put in query strings (except the websocket handshake) and never committed.
- Creating boards is rate limited per client.

## Repo rules

- Never commit real ideas content, facilitator links or keys, passcodes, or exported results.
- Real data goes in `/data` (gitignored). Commit only `ideas.example.json` (made-up sample board).
- Secrets and local settings go in `.env` (gitignored). Commit `.env.example`.
- Vote cap, anonymity, idea limits, timer and colors are facilitator settings, never hardcoded. Defaults are only initial values.
- Write tests for vote-cap logic, lock behavior, and result tallying, plus session isolation.
- Keep the README current with run-locally and hosting instructions.

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
