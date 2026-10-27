# Ority

Ority helps a group agree on what matters most. (Formerly "brainstorm_app"; the repository and its first Render address keep the old name until the hosting step, see below.)



**Live app: https://ority.onrender.com**

Open it, click **Create a poll**, and share the participant link it gives you. It runs on Render's free plan, so it sleeps after about 15 minutes without visitors (the first visit then takes up to a minute to wake it) and polls are forgotten when it sleeps or restarts. See "Hosting" below.

**Status:** polls, links, dot voting, live sync, organizer controls, timer, results, presentation mode and CSV export are working. All six planned phases are done: the new language and data model, four voting methods, open polls, the one-screen create flow, the website and SEO, the storage interface, the 50-person load test and the hosting comparison. Hosting stays on the free plan for now. See [CLAUDE.md](CLAUDE.md) for the rules and plan.

## The website

Ority has a public website as well as the app. Every page is real HTML written at build time, so search engines and link previews see the right title, description and content before any script runs.

| Address | What it is |
| --- | --- |
| `/` | Landing page: the tagline, a Create a poll button, 3 steps, use-case cards, example results, questions, a closing call to action |
| `/templates` | The six templates in detail, each with a "Use this template" link |
| `/voting-methods` | The four voting methods explained, with a comparison table |
| `/faq` | Frequently asked questions |
| `/privacy`, `/terms` | Plain-language drafts with placeholders for you to edit |
| `/create` | The app: create a poll, join one, find your polls (not listed in search engines) |
| `/s/<code>`, `/f/<code>` | A poll and its organizer screen (kept out of search engines) |
| anything else | A friendly "page not found" page with a real 404 status |

Every website page shares one header and footer, a "Skip to main content" link for keyboard users, and works on a phone. Links like `/create?template=survey-actions` and `/create?method=rank` open the create screen already filled in.

### How the pages are built

- `shared/routes.ts` lists every page with its title, description and whether search engines may list it. `shared/faq.ts` holds the FAQ, `shared/templates.ts` the templates, and `shared/site.ts` the site name, address and the placeholders for the legal pages.
- `client/src/pages/` has the page components. They are plain content with no hooks or browser-only code, so they can be prerendered.
- `client/prerender.tsx` is called by the build (through `vite-prerender-plugin`, which comes with `@preact/preset-vite`) once per page. It returns the page HTML and its head tags: description, canonical link, share tags (Open Graph and Twitter) and structured data (a WebSite entry on the home page and a FAQPage on the FAQ). Pages that are not for search engines get `noindex`.
- `client/src/renderStatic.ts` is a small in-repo renderer that turns the components into HTML. It is used instead of the usual `preact-render-to-string` package so no new dependency was added. You can swap that package in later by changing `renderToString` in that one file.
- The build also writes `sitemap.xml` (public content pages only) and `robots.txt` (keeps search engines out of `/s/`, `/f/` and `/api/`).
- `server/static.ts` serves it all: each page address gets its own file, poll links get the bare app page, and unknown addresses get the 404 page. Hashed files under `/assets` are cached for a year, and pages are always rechecked.
- Tests: `client/src/pages/pages.test.tsx` checks every page (one h1, heading order, working links, titles and descriptions, share tags, structured data, sitemap and robots), and `server/static.test.ts` checks the routing and the 404 status.

### Your web address (SITE_URL)

Canonical links, the sitemap and share images need the site's full address. By default they use the current Render address in `shared/site.ts`. To use your own, set `SITE_URL` (for example `https://ority.example.org`) in the environment of the build. The Dockerfile passes it through as a build argument: on Render add it as an environment variable, and on Fly use `[build.args]` in `fly.toml`. Rebuild after changing it.

### Editing the website

- **Wording:** edit the components in `client/src/pages/`. Keep it friendly and plain, with no em dashes.
- **Privacy and terms:** replace the bracketed placeholders (your organization, contact email, date) in `shared/site.ts`, then read both pages and have them reviewed before you rely on them.
- **Add a page:** add its title and description to `shared/routes.ts`, its component to `client/src/pages/`, and the component to the list in `client/src/pages/registry.tsx`. The build, the sitemap and the server all pick the new page up from the route list, and the tests tell you if anything is missing.
- **Preview locally:** `npm run build` then `npm start`, and open http://localhost:3000. (`npm run dev:client` shows the app pages but not the prerendered ones.)

## Two ways to run a poll

- **Open poll** (the default on the create screen): people vote any time before it closes. Set a closing time, or none and close it yourself. Best for groups in different places or time zones. It takes votes from the moment it is created.
- **Live session**: you run it with everyone together. Build the poll, share the link, start voting (with an optional timer), lock and reveal. This is the original flow.

Both use the same options, groups and voting methods.

## Creating a poll

The create screen is built to take under a minute. Pick a template (or start blank), set the title, list the options, and press **Create poll**. Add options one at a time (press Enter for the next), or open **Paste a list** and paste one option per line (bullets and numbers are removed, repeats are skipped). Everything else is under **More options**: the voting method, open poll or live session, when it closes, votes per person, anonymous or named results, and whether participants can see the results afterwards.

Six templates fill in the title, the question, a voting method and sample options, and you can edit all of it: **Team priorities**, **Feature or roadmap voting**, **Post-survey action planning** (the same poll as `ideas.example.json`, with groups, codes, tags and details), **Offsite or event ideas**, **Proposal or candidate ranking** and **Quick group decision**. They live in `shared/templates.ts`, and a test keeps the survey template identical to the example file.

## Open polls

- An open poll is open from the moment it is created. Participants see when it closes, in their own time zone, and cannot vote after that.
- **It closes by itself.** The closing time is stored with the poll and checked on every request, not held in a timer, so it closes on time even if the server restarted or was asleep. A timer only nudges screens that are open, so they switch to "closed" without a reload.
- **Results.** When it closes (or when you press **Close poll now**) the results appear for you. Participants see nothing unless you switch on **Let participants see the results after the poll closes**. That is off by default, and what they see is always anonymous totals, even if you chose named results. Only people who joined that poll can see them.
- **Organizer controls:** change or remove the closing time while it is open, add a day or a week, close it now, or reopen it later with a new closing time (or none). Reopening hides the results again.
- Participants cannot add their own options to an open poll, and there is no timer or lock step.
- **Hosting matters.** An open poll can run for days, so it needs storage that survives restarts. On Render's free plan polls are erased when the service sleeps or restarts, so use it for trying Ority, not for a poll people must find open next week. See Hosting below.

## How a poll runs

Words used in the app: a **poll** has **options** (optionally sorted into **groups**), people cast **votes**, and the person who creates it is the **organizer**.

1. **Create a poll** on the home page (see Creating a poll above). You get two links:
   - a **participant link** (`/s/<code>`) to share, and
   - a **private organizer link** (`/f/<code>#<secret>`) to bookmark. There are no accounts, so this link is your access. Anyone who has it can run the poll.
2. **Build the poll** (organizer, "Build the poll" tab): set the title, description and page color, and add options one at a time, each with a title, a short description and optional details. Groups are optional: add one to sort related options under a heading with its own color. A short code and a tag are available per option but stay hidden until you ask for them. You can also import a CSV/JSON file, and download the poll as JSON to reuse later. With no groups, participants see one plain list of options.
3. **Run the poll** ("Run the poll" tab): share the participant link, pick a quiet voting time (or none), choose votes per person, anonymous or named results, and whether people can add their own options. Start voting.
4. **Participants** open the link, enter a name, read the options, and vote the way the organizer chose (see Voting methods below). They can add their own options before voting starts. They press "Submit my votes" when finished. You see only how many have submitted, never what anyone picked.
5. **Control the clock:** pause, resume, add time, lock voting (or let it lock automatically), and reopen if needed.
6. **Reveal the results.** After locking, click **Reveal results**. Until then nobody can see the tally, including you. The Results tab ranks options by votes, labels ties (tied options share a rank: 1, 2, 2, 4), and can group the same results by group when the poll has groups. Click **Present full screen** to project it, and **Download CSV** to keep a copy. Results are anonymous unless you chose "Who voted for what" before revealing. Participants never see the tally; they only see that results are being shared. **Hide results** takes them off screen again.

CSV import: a header row with `title` (or `option`), and optionally `group`, `summary`, `details`, `tag`, `code`. Groups are created as needed, and rows with no group go in the ungrouped list. JSON import also accepts a `groups` list with colors. Older files that use `column`, `idea` and `audience` still work. See `ideas.example.json`.

**Making sure everyone submits.** While voting is open, a bar pinned to the bottom of each participant's screen shows how many votes they have used and a large **Submit my votes** button. It turns green once they submit, and "Undo" lets them change their mind until voting locks. If someone hasn't submitted when under a minute is left (or time is up), they get a bold prompt, and the browser asks before they leave the page with unsubmitted votes. On your side, the Controls panel lists the **names of people who haven't submitted** (never what they picked) and a **Remind everyone to submit** button that sends them a prompt. Locking voting warns you who hasn't submitted yet. Votes are counted whether or not someone presses Submit; Submit is how they tell you they are done.

**Restoring results.** Hosting can erase polls, so download the CSV from the Results tab and keep it. On the home page, **Restore results from a CSV** takes that file and a title and rebuilds the poll as a new one, opening on the ranking: the options, their groups, vote counts and ties (and who voted, if the file has names). The ranking is recomputed from the vote counts. A restored poll can be projected, downloaded again, or reopened for more voting, and new votes are added on top. Participation counts (who joined and submitted) are not in the file, so they are not restored. Both the current CSV (`Option`, `Group`, `Tag`, `Votes`, `Voted by`) and older downloads (`Idea`, `Column`, `Audience`, `Stars`, `Starred by`) are accepted, and a hand-made CSV with just an option title and a vote count works too.

**Your polls.** The home page lists the polls you have created on this device, with their status (setting up, voting, locked, results showing), how many people have joined and submitted, and when they were last used. From there you can open a poll again, copy its participant link, or delete it. You can also delete a poll from the bottom of its "Run the poll" tab. Deleting erases the poll, its options, people and votes, and participants are told it has ended. The list is stored in this browser, so keep your private organizer links to get back in from another device. People who joined a poll see it listed under "Polls you have joined".

**Removing test votes.** On the Run tab, the Responses panel lists who joined (names and whether they submitted, never what anyone picked). Use **Remove** to take one person and their votes out, or **Clear all responses** to start collecting again on the same link, with the options and settings kept. If the poll has anonymous results and they have already been shown, removing one person is turned off, because the totals would reveal what that person picked. Clearing everything still works.

**Adding options closes when voting starts.** Participants can only add their own options before you start voting, so the app reminds you before you start (with a confirmation that says so), reminds participants while they are waiting, and shows them a "closed" tile once voting has begun. You can still edit the poll yourself afterwards.

Polls that nobody has used for 90 days are deleted automatically.

## Voting methods

The organizer picks how people vote under **Settings, How people vote** (before voting starts). Each choice has a one-sentence explanation in the app.

| Method | What a person does | How results are counted |
| --- | --- | --- |
| **Dot voting** (default) | Spends a fixed number of votes on their favorites. | The number of votes each option received. |
| **Rank order** | Puts the options in order, favorite first. Drag the handle, or use the up and down buttons (keyboard friendly). With 10 options or fewer they rank all of them; with more they choose and order their top 5. | Borda count. With K ranking places, 1st earns K points, 2nd K-1, down to 1, and unranked options earn 0. Points add up across everyone. |
| **Score** | Rates options from 1 to 5. Skipping an option is fine. | The average of the scores. Equal averages are separated by the number of ratings, and unrated options come last. |
| **100 point method** | Splits 100 points across the options. They can save a draft, but must use exactly 100 to submit. | The total points each option received. |

In every method, ties share a rank and the next rank skips (1, 2, 2, 4). The server checks every ballot against the method's rules (rank places unique and starting at 1, scores 1 to 5, points whole numbers adding to at most 100), plus the phase and that every option belongs to the poll. Results stay hidden until the organizer reveals them, for every method, and participants only ever receive their own ballot.

Notes:
- The method cannot change once voting starts. The "votes per person" setting only applies to dot voting.
- In rank, score and points polls, merging two options is blocked once either has votes, because those votes cannot be added together sensibly. Deleting an option after people have voted is allowed (the organizer sees a warning); rank ballots are tidied to 1, 2, 3 when counted, and a 100 point ballot that is left short of 100 will need its owner to finish it.
- Unsubmitted ballots still count, as with dot voting. "Submit" tells the organizer someone is done. If someone edits a submitted ballot so it is no longer complete, the submitted mark is removed.
- The results CSV labels its score column by method (`Votes`, `Points`, `Borda points`, or `Average score` plus `Ratings`). Restoring from a CSV rebuilds a dot-style poll from the numbers, so it works for votes, points and Borda points, but not for average scores.
## Data model notes

- Tables keep their original names (`sessions`, `columns`, `ideas`, `votes`) and the `/s/<code>` and `/f/<code>#secret` URLs are unchanged, so nothing saved or shared breaks. "Poll", "option" and "group" are the user-facing words for them.
- The ungrouped section is a `columns` row with `kind = 'group'` (shown as "Other options"). Options created without a group, and options participants add, live there. Named groups are `kind = 'normal'` rows. A poll with only the ungrouped section is shown as a plain list.
- `votes.value` (default `1`) is what a vote is worth: 1 for a dot, or a rank, a 1 to 5 score, or points. Every existing row is a dot vote, so the column was added with a safe migration at startup.
- Per-poll settings (a key/value table) now include `method` (`dots`, `rank`, `score`, `points`; default `dots`), `mode` (`live` or `poll`; default `live`) and `deadline` (epoch ms or none; default none). Unknown values fall back to the defaults. All four methods work in both modes. `mode: poll` polls close at their stored `deadline` (checked on every request), and `share_results` controls whether participants can see anonymous results after an open poll closes.
## Run locally

Requires Node 22+.

```bash
npm install
npm run build
npm start
```

Open http://localhost:3000, click "Create poll", and use the participant link in a second browser (or a private window) to try it as a participant.

For development with hot reload, run `npm run dev:server` and `npm run dev:client` in two terminals and open the Vite URL (http://localhost:5173).

Other commands: `npm test`, `npm run typecheck`, `npm run backup`, `npm run loadtest`.

Windows note: if the repo lives in a folder whose path contains `&` (for example a OneDrive folder), `npm run` fails because of how Windows cmd handles that character. Run the tools directly, for example `node node_modules/vitest/vitest.mjs run`, or move the repo to a simpler path.

## Configuration

Copy `.env.example` to `.env` (gitignored). Real data lives in `data/` (gitignored); never commit organizer links, keys or exported results. Votes per person, anonymity, option limits, the timer and colors are organizer settings, not code constants.

| Variable | Purpose |
| --- | --- |
| `PORT` | Port to listen on (default 3000). |
| `STORAGE` | Storage adapter (default `sqlite`, the only one built in). |
| `BACKUP_S3_ENDPOINT`, `BACKUP_S3_BUCKET`, `BACKUP_S3_KEY_ID`, `BACKUP_S3_SECRET` | Keep polls across restarts by saving copies to a private S3-compatible bucket (Backblaze B2 has a free plan). Set all four or none. |
| `BACKUP_PREFIX`, `BACKUP_INTERVAL_SECONDS` | Folder in the bucket (default `ority/`) and how often to check for changes (default 60 seconds). |
| `DEMO_NOTICE` | Set to `1` to show a "Demo site" notice on every page. |
| `SITE_URL` | The public address, used when the site is built (canonical links, sitemap, share images). |
| `DB_PATH` | SQLite file. Default `data/ority.db`, or `data/brainstorm.db` if only that older file exists, so renaming never hides existing polls. Must be on persistent storage when hosted. |
| `TRUST_PROXY` | Set to `1` when behind a hosting proxy so the poll-creation rate limit sees real client IPs. |

## Hosting

Ority is one Node process with a SQLite file, so it needs **one copy, always on, with a disk that survives restarts**. Open polls can stay open for days, which makes the disk matter more than it does for a live session. See **[docs/HOSTING.md](docs/HOSTING.md)** for the full comparison of options with current prices, how to switch tiers, how to rename the service and attach your own domain, backups, and the load test results.

| Option | Cost per month | Polls survive restarts? |
| --- | --- | --- |
| Free demo (Render free) | $0 | No: it sleeps after 15 minutes and its files are erased on restart |
| **Free demo plus automatic backup** (Backblaze B2) | $0 | **Yes**, restored from a copy saved at most a minute ago |
| Render paid plan with a 1 GB disk | about $7.25 | Yes |
| Fly.io with a 1 GB volume | about $3.84 | Yes |
| Railway Hobby | about $5 | Yes |

The free demo is what runs today, and no paid hosting is the chosen direction. **To make polls survive sleeping, restarts, deploys and weeks of quiet at no cost, set up the automatic backup** (about 15 minutes, steps in docs/HOSTING.md under A+): Ority saves a copy of its database to a free private Backblaze bucket and restores it on startup. Until that is set up, `render.yaml` sets `DEMO_NOTICE=1`, which shows a visible "Demo site" notice on every page, so nobody expects a poll to last. Nothing in `render.yaml` or `fly.toml` is set up for a paid plan; docs/HOSTING.md has the steps if that changes.

### Deploying

Config files are included for two hosts (the Docker build has not yet been run on a real Fly account):

**Render, free plan** (`render.yaml`), no cost and no card needed:

1. Sign in at https://render.com with GitHub and open https://dashboard.render.com/blueprint/new?repo=https://github.com/fosterj3/brainstorm_app (allow Render to read the repo when asked).
2. Click **Deploy Blueprint**. The first build takes a few minutes.
3. Render shows the address, like `https://ority-xxxx.onrender.com`. That is the link anyone can use.

Free plan limits: the service sleeps after about 15 minutes with no visitors (the next visit takes up to a minute to wake it), and it has no persistent disk, so **polls are forgotten when it sleeps or restarts**. Download your results as a CSV when a poll closes. To keep polls, move to a paid plan and add a disk mounted at `/app/data` (steps in docs/HOSTING.md).

**Fly.io** (`fly.toml`, `Dockerfile`):

```bash
fly launch --no-deploy --copy-config     # pick a unique app name
fly volumes create ority_data --size 1
fly deploy
```

The site is then at `https://<app-name>.fly.dev/`. (`fly.toml` is named `ority-change-me`; pick your own unique name.) Anyone can create polls there, so consider the abuse limits (poll creation is rate limited per client, and idle polls are deleted) before sharing the address widely.

### Renaming the service

On Render, a service's `onrender.com` address cannot be changed, and renaming a service in the dashboard only changes its display name, so renaming never breaks links. `render.yaml` currently says `name: ority`. It is not documented what Render does with a Blueprint whose `name` no longer matches a service, and it may create a second service. **Before you sync the Blueprint, rename the service in the dashboard (Settings, Name) so the two match.** Details and the custom domain steps are in docs/HOSTING.md.

### Storage

All reading and writing goes through a small interface in `server/storage.ts`. When backup is set up, `server/persist.ts` saves a compressed copy of the database to a bucket whenever it has changed and restores it on an empty disk, using a small S3 client in `server/s3.ts` (no extra package). SQLite (through `better-sqlite3`) is the only backend built in. The interface is synchronous and speaks SQLite's SQL, so another engine that runs inside the server process can be added as one more adapter. The tests in `server/storage.test.ts` are the checklist for a new backend. A database that answers only over the network would need every call made asynchronous first, which is a larger change.

### Day-to-day commands

```bash
npm run backup                       # safe copy of the database into backups/, while the app is running
npm run backup:check                # test your backup bucket settings (saves and deletes a tiny test file)
npm run loadtest                     # 50 simulated people vote at once, then the results are checked
npm run loadtest -- --polls 10 --participants 20 --method mixed --restart
```

`GET /api/health` answers `{"ok":true,...}` when the database works, for hosting health checks.

Before a live session, do a quick join from a phone, and take a backup if the results matter to you.
## Brand and design

Ority's colors are design tokens at the top of `client/src/styles.css`. The brand color is black currant `#2E183B`, used for headings, primary buttons, the header and the footer. Surfaces and borders are tints of the same purple, amber marks the top-ranked result, and status colors cover success, warning and errors. Organizer-chosen column colors and page backgrounds still work. `client/src/contrast.test.ts` checks the token pairs against WCAG AA, so a color change that hurts readability fails `npm test`.

The favicon, touch icon and social preview image are in `client/public/`. Social sites need an absolute image address, so it is built from `SITE_URL` (see The website, above) and defaults to the current Render address.

Copy style: clear, friendly and professional, with no jargon and no em dashes.