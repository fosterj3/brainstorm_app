# brainstorm_app

Web app for live, silent prioritization exercises with leadership teams. A facilitator loads "ideas for action"; participants join by link, enter a name, and during a timed quiet period star their top N ideas. The facilitator locks voting and reveals ranked results.

Scale targets: 5 participants first, must handle 20 and 50 concurrent.

## The exercise

- Facilitator loads ideas: title, 1-2 sentence description, optional theme.
- Participants join by link, enter a name, and star their top N ideas (default 3) during a timed quiet period. Stars mean strongest affinity for adopting the idea as a leadership priority.
- Facilitator locks voting, then reveals results.

### Participant view
- Cards grouped by theme, collapsible groups, readable on laptop and phone.
- Star toggle with a hard cap at N, a visible counter ("2 of 3 used"), and easy un-star/re-star until voting locks.
- Participants can add their own ideas (title, short description, optional theme) while the facilitator allows it. Added ideas appear for everyone and can be starred.
- Votes are private: participants never see running totals.
- Countdown timer synced to the facilitator.

### Facilitator view (passcode protected)
- Import ideas from CSV or JSON; add/edit/delete in the UI.
- Facilitator owns the idea list: participants' additions can be edited, merged, or removed by the facilitator.
- Settings: votes per person, anonymous vs. named results, whether participants may add ideas (and whether additions need approval).
- The sample ideas in `ideas.example.json` are for development only; a real session's ideas come from the facilitator, never from the example file.
- Start, pause, and extend the timer. Sees only how many people have submitted, never what they picked.
- Lock voting, then reveal results.
- Results: ranked by stars, ties shown clearly, grouped-by-theme view, full-screen presentation mode for projecting.
- Export results to CSV.

## Technical constraints

- Single server, SQLite, WebSockets for real-time sync. No Redis, queues, or microservices.
- Must handle 50 concurrent participants; layout stays usable with 10 ideas or 60.
- Reconnects and refreshes must not lose votes (server is the source of truth; persist every vote change).
- No accounts. Only name entry and the facilitator passcode.
- Accessible: keyboard navigable, good contrast. Polished, minimal design.
- **Ask before adding any major dependency.**

## Server-side invariants

- The vote cap, lock state, and timer are enforced on the server. Never trust the client.
- Participant-facing messages must never include other people's votes or totals. Vote data is sent only to the facilitator after reveal, and per-person picks only when results are set to named.
- The facilitator's live view gets submission counts only, not picks.

## Repo rules

- Never commit real ideas content, passcodes, or exported results.
- Real data goes in `/data` (gitignored). Commit only `ideas.example.json` with made-up sample ideas.
- Secrets go in `.env` (gitignored). Commit `.env.example`.
- Vote cap and anonymity are facilitator settings, never hardcoded. The default of 3 is only an initial setting value.
- Write tests for vote-cap logic, lock behavior, and result tallying.
- Keep the README current with run-locally and hosting instructions.

## Workflow

Build in phases and pause for the user's review after each one:
1. Single-user voting UI with the hard star cap
2. Multi-user real-time sync
3. Facilitator controls and timer
4. Results, presentation mode, and CSV export
5. Load test simulating 50 participants

At the end, document how to run locally and what is needed to host a live session.

Do not commit or push unless asked.
