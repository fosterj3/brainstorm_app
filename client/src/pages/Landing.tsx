import { FAQS, LANDING_FAQ_IDS } from "../../../shared/faq";
import { TEMPLATES } from "../../../shared/templates";
import { PageShell } from "../Site";

/**
 * The landing page. It is written without hooks or browser-only code, so it can be prerendered into real HTML at
 * build time and then hydrated in the browser.
 */

const STEPS = [
  { title: "Create your poll", text: "Pick a template or type your own options. Choose how people vote and when the poll closes." },
  { title: "Share one link", text: "Send it by email or chat. People vote from a phone or a computer, with no account." },
  { title: "See what matters most", text: "When the poll closes you get a ranked list, with ties shown clearly and a file you can download." },
];

const FEATURES = [
  { title: "Votes stay private", text: "Nobody sees what anyone else picked, and results stay hidden until the poll closes." },
  { title: "Four ways to vote", text: "Spend votes, rank the options, score them, or split 100 points. Pick the one that fits your decision." },
  { title: "Open polls or live sessions", text: "Let people vote whenever they like before a closing time, or run it together in one sitting." },
];

/** An example of what results look like. The numbers are made up. */
const SAMPLE = [
  { rank: 1, title: "Protected focus time", votes: 14, tied: false },
  { rank: 2, title: "Fewer, shorter meetings", votes: 11, tied: false },
  { rank: 3, title: "Clear decision owners", votes: 8, tied: false },
  { rank: 4, title: "Better onboarding", votes: 5, tied: true },
  { rank: 4, title: "Improve our tools", votes: 5, tied: true },
];

function SampleResults() {
  const max = Math.max(...SAMPLE.map((r) => r.votes));
  return (
    <div class="sample panel" role="group" aria-labelledby="h-sample-title">
      <p class="sample-label">Example results</p>
      <h3 id="h-sample-title">Team priorities for next quarter</h3>
      <p class="hint">12 people voted, with 3 votes each. Ties share a rank.</p>
      <ol class="result-list">
        {SAMPLE.map((r) => (
          <li key={r.title} class={`result-row${r.rank === 1 ? " top" : ""}`} style={{ "--c": "var(--tint-4)" }}>
            <span class="rank" aria-label={`Rank ${r.rank}${r.tied ? ", tied" : ""}`}>{r.rank}</span>
            <div class="result-body">
              <div class="result-title">
                <strong>{r.title}</strong>
                {r.tied && <span class="tie-badge">Tied</span>}
              </div>
              <div class="bar-track" aria-hidden="true"><div class="bar-fill" style={{ width: `${(r.votes / max) * 100}%` }} /></div>
            </div>
            <span class="stars-count"><strong>{r.votes}</strong><span class="unit"> votes</span></span>
          </li>
        ))}
      </ol>
    </div>
  );
}

export function Landing() {
  const faqs = LANDING_FAQ_IDS.map((id) => FAQS.find((f) => f.id === id)!).filter(Boolean);
  return (
    <PageShell current="/" wide>
      <section class="hero-lg" aria-labelledby="h-hero">
        <h1 id="h-hero">Get a group to agree on what matters most</h1>
        <p class="hero-sub">
          Create a poll in under a minute, share one link, and see what your group chooses. Everyone votes privately, so the loudest voice does not decide.
        </p>
        <p class="hero-actions">
          <a class="button-link primary big" href="/create">Create a poll</a>
          <a class="button-link secondary big" href="#how">See how it works</a>
        </p>
        <p class="hint">Free to try. No account or sign-up needed. <a href="/create#join">Have a poll code? Join a poll.</a></p>
      </section>

      <section id="how" class="block" aria-labelledby="h-how">
        <h2 id="h-how">How it works</h2>
        <ol class="steps-grid">
          {STEPS.map((s, i) => (
            <li key={s.title} class="panel step-card">
              <span class="step-num" aria-hidden="true">{i + 1}</span>
              <h3>{s.title}</h3>
              <p>{s.text}</p>
            </li>
          ))}
        </ol>
      </section>

      <section class="block" aria-labelledby="h-uses">
        <h2 id="h-uses">Made for everyday decisions</h2>
        <p class="lead">Start from a template and change anything you like.</p>
        <ul class="usecases">
          {TEMPLATES.map((t) => (
            <li key={t.id}>
              <a class="usecase" href={`/create?template=${t.id}`}>
                <h3>{t.name}</h3>
                <p>{t.blurb}</p>
                <span class="more-link">Use this template</span>
              </a>
            </li>
          ))}
        </ul>
        <p><a href="/templates">See every template</a></p>
      </section>

      <section class="block split" aria-labelledby="h-sample">
        <div>
          <h2 id="h-sample">Clear results, not a pile of replies</h2>
          <p>
            When voting ends you see a ranked list. Ties are shown honestly, so nobody has to guess which option really won. Download the results as a
            spreadsheet whenever you like.
          </p>
          <p><a href="/voting-methods">Compare the four voting methods</a></p>
        </div>
        <SampleResults />
      </section>

      <section class="block" aria-labelledby="h-why">
        <h2 id="h-why">Why people use Ority</h2>
        <ul class="feature-grid">
          {FEATURES.map((f) => (
            <li key={f.title} class="panel">
              <h3>{f.title}</h3>
              <p>{f.text}</p>
            </li>
          ))}
        </ul>
      </section>

      <section class="block" aria-labelledby="h-faq">
        <h2 id="h-faq">Common questions</h2>
        <div class="faq-list">
          {faqs.map((f) => (
            <details key={f.id} class="faq">
              <summary>{f.q}</summary>
              <p>{f.a}</p>
            </details>
          ))}
        </div>
        <p><a href="/faq">Read all the questions</a></p>
      </section>

      <section class="cta-band" aria-labelledby="h-cta">
        <h2 id="h-cta">Ready to get your group to agree?</h2>
        <p>It takes about a minute to set up, and nobody needs an account.</p>
        <p><a class="button-link light big" href="/create">Create a poll</a></p>
      </section>
    </PageShell>
  );
}
