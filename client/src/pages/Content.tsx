import { FAQS } from "../../../shared/faq";
import { TEMPLATES } from "../../../shared/templates";
import { METHODS } from "../methods";
import { PageShell } from "../Site";

/** Templates, voting methods and FAQ pages. Plain content, so they can be prerendered. */

const methodOf = (id: string) => METHODS.find((m) => m.id === id)!;
const dayWord = (n: number) => (n === 7 ? "1 week" : n === 14 ? "2 weeks" : `${n} ${n === 1 ? "day" : "days"}`);

export function TemplatesPage() {
  return (
    <PageShell current="/templates">
      <h1>Poll templates</h1>
      <p class="lead">
        Start with a ready-made poll and change anything you like: the title, the question, the options and how people vote.
        Each one makes an open poll that closes by itself.
      </p>
      <ul class="template-list">
        {TEMPLATES.map((t) => {
          const m = methodOf(t.method);
          const groups = t.groups?.length ?? 0;
          return (
            <li key={t.id} id={t.id} class="panel template-card">
              <h2>{t.name}</h2>
              <p>{t.blurb}</p>
              <dl class="facts">
                <div><dt>Voting method</dt><dd>{m.label}. {m.blurb}</dd></div>
                <div><dt>Starts with</dt><dd>{t.options.length} options{groups ? ` in ${groups} groups` : ""}</dd></div>
                <div><dt>Closes after</dt><dd>{dayWord(t.closesInDays)} (you can change this)</dd></div>
              </dl>
              <p class="hint">A few of the sample options:</p>
              <ul class="chips">
                {t.options.slice(0, 4).map((o) => <li key={o.title}>{o.title}</li>)}
              </ul>
              <p><a class="button-link primary" href={`/create?template=${t.id}`}>Use this template</a></p>
            </li>
          );
        })}
      </ul>
      <p>Prefer to start from scratch? <a href="/create">Create a blank poll</a>.</p>
    </PageShell>
  );
}

const DETAILS: Record<string, { how: string; counted: string; best: string; watch: string }> = {
  dots: {
    how: "Each person gets a set number of votes (3 by default) and spends them on the options they like best. They can take a vote back and move it before they submit.",
    counted: "An option's total is the number of votes it received.",
    best: "Picking a few favorites from a longer list, such as priorities for next quarter.",
    watch: "It does not show how strongly someone feels, and votes can spread thin when there are many options.",
  },
  rank: {
    how: "Each person puts the options in order, with their favorite first. They drag an option by its handle or use the arrow buttons. With more than 10 options they choose and order their top 5.",
    counted: "Ority uses a Borda count. If people rank K options, first place earns K points, second place earns K minus 1, and so on down to 1 point. Points add up across everyone.",
    best: "A short list where the order matters, such as choosing a vendor, a proposal or a candidate.",
    watch: "It takes more effort than the other methods, and a very long list is tiring to rank.",
  },
  score: {
    how: "Each person rates options from 1 to 5. They can skip any option they have no view on.",
    counted: "An option's score is the average of its ratings. If two averages match, the option with more ratings ranks higher.",
    best: "Comparing many options one by one, such as event ideas or feature requests.",
    watch: "People tend to give high scores, so the differences between options can be small.",
  },
  points: {
    how: "Each person has 100 points to split across the options, giving more to what matters most. They must use exactly 100 points to submit.",
    counted: "An option's total is the points it received.",
    best: "Showing how strongly people feel, such as roadmap planning where a few items matter far more than the rest.",
    watch: "It needs a little arithmetic and takes longer than tapping a star.",
  },
};

const QUICK = [
  { need: "I want the group's top few favorites", id: "dots" },
  { need: "I have a short list and the order matters", id: "rank" },
  { need: "I want to compare lots of options fairly", id: "score" },
  { need: "I want to know how strongly people feel", id: "points" },
];

export function MethodsPage() {
  return (
    <PageShell current="/voting-methods">
      <h1>Voting methods</h1>
      <p class="lead">
        Ority offers four ways for a group to vote. Each one answers a slightly different question, so pick the one that fits your decision.
        You choose the method when you create a poll.
      </p>

      <section aria-labelledby="h-pick">
        <h2 id="h-pick">Which one should I use?</h2>
        <ul class="quick-picks">
          {QUICK.map((q) => (
            <li key={q.id}>
              <span>{q.need}:</span> <a href={`#${q.id}`}>{methodOf(q.id).label}</a>
            </li>
          ))}
        </ul>
        <p class="hint">Not sure? Dot voting is the simplest, and it works well for most groups.</p>
      </section>

      {METHODS.map((m) => {
        const d = DETAILS[m.id];
        return (
          <section key={m.id} id={m.id} class="panel method-card" aria-labelledby={`h-${m.id}`}>
            <h2 id={`h-${m.id}`}>{m.label}</h2>
            <p class="method-blurb">{m.blurb}</p>
            <dl class="facts">
              <div><dt>What a voter does</dt><dd>{d.how}</dd></div>
              <div><dt>How results are counted</dt><dd>{d.counted}</dd></div>
              <div><dt>Best for</dt><dd>{d.best}</dd></div>
              <div><dt>Keep in mind</dt><dd>{d.watch}</dd></div>
            </dl>
            <p><a class="button-link primary" href={`/create?method=${m.id}`}>Create a poll with {m.label.toLowerCase()}</a></p>
          </section>
        );
      })}

      <section aria-labelledby="h-compare">
        <h2 id="h-compare">At a glance</h2>
        <div class="table-wrap">
          <table class="compare">
            <caption class="sr-only">The four voting methods side by side</caption>
            <thead>
              <tr><th scope="col">Method</th><th scope="col">A voter</th><th scope="col">Effort</th><th scope="col">Results show</th></tr>
            </thead>
            <tbody>
              <tr><th scope="row">Dot voting</th><td>Spends a few votes</td><td>Low</td><td>Votes per option</td></tr>
              <tr><th scope="row">Rank order</th><td>Puts options in order</td><td>Medium</td><td>Borda points per option</td></tr>
              <tr><th scope="row">Score</th><td>Rates from 1 to 5</td><td>Medium</td><td>Average score per option</td></tr>
              <tr><th scope="row">$100 method</th><td>Splits 100 points</td><td>Higher</td><td>Total points per option</td></tr>
            </tbody>
          </table>
        </div>
      </section>

      <section aria-labelledby="h-ties">
        <h2 id="h-ties">How ties are shown</h2>
        <p>
          When two or more options end up with the same result, they share a rank and are marked as tied. The next rank skips ahead, so you might see
          1, 2, 2, 4. Ority never picks a winner between tied options for you.
        </p>
      </section>

      <section aria-labelledby="h-private">
        <h2 id="h-private">Privacy works the same way for all of them</h2>
        <p>
          Votes are private. Participants only see their own choices, and results stay hidden until the poll closes. The organizer can choose whether
          the results show names, and whether participants can see the totals afterwards.
        </p>
        <p><a href="/faq">Read the questions people ask</a></p>
      </section>
    </PageShell>
  );
}

export function FaqPage() {
  return (
    <PageShell current="/faq">
      <h1>Frequently asked questions</h1>
      <p class="lead">Short answers to the things people ask most. Can't find yours? Create a poll and try it. It takes about a minute.</p>
      <div class="faq-list">
        {FAQS.map((f) => (
          <details key={f.id} id={f.id} class="faq">
            <summary>{f.q}</summary>
            <p>{f.a}</p>
            {f.more && <p><a href={f.more.href}>{f.more.label}</a></p>}
          </details>
        ))}
      </div>
      <p class="cta-line"><a class="button-link primary" href="/create">Create a poll</a></p>
    </PageShell>
  );
}
