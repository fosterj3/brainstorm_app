import { useEffect, useRef, useState } from "preact/hooks";
import * as api from "./api";
import { Loading } from "./Site";
import type { Column, Method, Mode, ResultRow, Results } from "./api";

type View = "ranked" | "columns";

const colorOf = (columns: Column[], id: number) => columns.find((c) => c.id === id)?.color ?? "#6b7280";

/** The unit shown beside a score, by method. */
const unitFor = (method: Method, value: number) =>
  method === "score" ? "avg" : method === "points" ? (value === 1 ? "point" : "points") : method === "rank" ? (value === 1 ? "pt" : "pts") : value === 1 ? "vote" : "votes";

function Row({ row, max, columns, named, method }: { row: ResultRow; max: number; columns: Column[]; named: boolean; method: Method }) {
  const width = method === "score" ? (row.stars / 5) * 100 : max ? (row.stars / max) * 100 : 0;
  return (
    <li class={`result-row${row.rank === 1 && row.stars > 0 ? " top" : ""}`} style={{ "--c": row.grouped ? colorOf(columns, row.columnId) : "var(--tint-4)" }}>
      <span class="rank" aria-label={`Rank ${row.rank}${row.tied ? ", tied" : ""}`}>{row.rank}</span>
      <div class="result-body">
        <div class="result-title">
          {row.code && <strong class="code">{row.code} </strong>}
          <strong>{row.title}</strong>
          {row.tied && <span class="tie-badge">Tied</span>}
        </div>
        {(row.grouped || row.audience) && <div class="result-sub">{[row.grouped ? row.column : "", row.audience].filter(Boolean).join(" · ")}</div>}
        <div class="bar-track" aria-hidden="true"><div class="bar-fill" style={{ width: `${width}%` }} /></div>
        {method === "score" && <div class="result-sub">{row.ratings} {row.ratings === 1 ? "rating" : "ratings"}</div>}
        {named && row.voters && row.voters.length > 0 && <div class="voters">{row.voters.join(", ")}</div>}
      </div>
      <span class="stars-count">
        <strong>{row.stars}</strong>
        <span class="unit"> {unitFor(method, row.stars)}</span>
      </span>
    </li>
  );
}

const hasGroups = (columns: Column[]) => columns.some((c) => c.kind === "normal");

/** The ranked list, or the same options grouped. Used on the organizer screen and in presentation mode. */
export function ResultsView({ results, columns, view }: { results: Results; columns: Column[]; view: View }) {
  const max = Math.max(0, ...results.rows.map((r) => r.stars));
  if (results.rows.length === 0) return <p class="empty">There are no options to rank.</p>;
  if (view === "ranked" || !hasGroups(columns)) {
    return <ol class="result-list">{results.rows.map((r) => <Row key={r.id} row={r} max={max} columns={columns} named={results.named} method={results.method} />)}</ol>;
  }
  return (
    <div class="result-columns">
      {columns.map((col) => {
        const rows = results.rows.filter((r) => r.columnId === col.id);
        if (rows.length === 0) return null;
        const total = rows.reduce((s, r) => s + (results.method === "score" ? r.ratings : r.stars), 0);
        const unit = results.method === "score" ? (total === 1 ? "rating" : "ratings") : unitFor(results.method, total);
        return (
          <section key={col.id} class="result-column" style={{ "--c": col.color }}>
            <h3><span class="dot" aria-hidden="true" /> {col.name} <span class="meta">{total} {unit}</span></h3>
            <ol class="result-list">{rows.map((r) => <Row key={r.id} row={r} max={max} columns={columns} named={results.named} method={results.method} />)}</ol>
          </section>
        );
      })}
    </div>
  );
}

function ViewToggle({ view, onChange }: { view: View; onChange: (v: View) => void }) {
  return (
    <div class="segmented" role="group" aria-label="Results view">
      <button class="secondary" aria-pressed={view === "ranked"} onClick={() => onChange("ranked")}>Ranked</button>
      <button class="secondary" aria-pressed={view === "columns"} onClick={() => onChange("columns")}>By group</button>
    </div>
  );
}

/** One sentence on how the numbers were worked out, so nobody has to guess what "4.2" or "11" means. */
const HOW: Record<Method, string> = {
  dots: "Each option's number is how many votes it received.",
  points: "Each option's number is the total points people gave it.",
  rank: "Rank order uses a Borda count: first place earns the most points and last place earns 1, and the points add up across everyone.",
  score: "Each option's number is the average of its 1 to 5 scores. When averages are equal, the option with more ratings ranks higher.",
};

export function Summary({ results }: { results: Results }) {
  const t = results.totals;
  const names = results.named ? "Names are shown." : "Anonymous: no names are shown.";
  const verb = { dots: "voted", points: "gave points", rank: "ranked options", score: "rated options" }[results.method];
  const total =
    results.method === "score" ? `${t.stars} ${t.stars === 1 ? "rating" : "ratings"} in total`
    : results.method === "points" ? `${t.stars} ${t.stars === 1 ? "point" : "points"} given`
    : results.method === "rank" ? `${t.stars} Borda ${t.stars === 1 ? "point" : "points"}`
    : `${t.stars} ${t.stars === 1 ? "vote" : "votes"} in total`;
  return (
    <>
      <p class="hint">
        {results.restored ? "Restored from a CSV file" : `${t.voted} of ${t.joined} ${t.joined === 1 ? "person" : "people"} ${verb}`} · {results.restored ? total.replace(" given", " in total") : total} · {names}
      </p>
      <p class="hint">{HOW[results.method]}</p>
    </>
  );
}
type Run = (fn: () => Promise<unknown>) => Promise<void>;

export function ResultsPanel(props: { sid: string; title: string; columns: Column[]; revealed: boolean; mode: Mode; onPresent: () => void; run: Run }) {
  const { sid, title, columns, revealed } = props;
  const [results, setResults] = useState<Results | null>(null);
  const [view, setView] = useState<View>("ranked");

  useEffect(() => {
    if (!revealed) {
      setResults(null);
      return;
    }
    api.adminResults(sid).then(setResults).catch(() => setResults(null));
  }, [sid, revealed]);

  if (!revealed) {
    return (
      <section class="panel" aria-labelledby="h-results">
        <h2 id="h-results">Results</h2>
        <p>
          {props.mode === "poll"
            ? "Results stay hidden, even from you, until the poll closes. That happens at its closing time, or when you press “Close poll now” on the “Run the poll” tab."
            : "Results stay hidden, even from you, until you lock voting and then reveal them from the “Run the poll” tab."}
        </p>
      </section>
    );
  }
  if (!results) return <section class="panel"><Loading label="Loading results…" /></section>;

  return (
    <section class="panel" aria-labelledby="h-results">
      <div class="row wrap spread">
        <h2 id="h-results">Results</h2>
        <div class="row wrap">
          {hasGroups(columns) && <ViewToggle view={view} onChange={setView} />}
          <button class="primary" onClick={props.onPresent}>Present full screen</button>
          <button class="secondary" onClick={() => props.run(() => api.downloadResultsCsv(sid, title))}>Download CSV</button>
        </div>
      </div>
      <Summary results={results} />
      <p class="hint">Download the CSV and keep it. Hosting can erase polls, and you can rebuild these results later from the home page.</p>
      <ResultsView results={results} columns={columns} view={view} />
    </section>
  );
}

/** Full-screen results for projecting. Esc or the Close button leaves it. */
export function Presentation(props: { sid: string; title: string; subtitle: string; columns: Column[]; onClose: () => void }) {
  const { sid, title, subtitle, columns, onClose } = props;
  const [results, setResults] = useState<Results | null>(null);
  const [view, setView] = useState<View>("ranked");
  const closeRef = useRef<HTMLButtonElement>(null);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.adminResults(sid).then(setResults).catch(onClose);
    const opener = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    root.current?.requestFullscreen?.().catch(() => {}); // optional: the overlay already fills the window
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") return onClose();
      if (e.key !== "Tab") return;
      // Keep keyboard focus inside the overlay.
      const buttons = root.current?.querySelectorAll<HTMLElement>("button");
      if (!buttons || buttons.length === 0) return;
      const first = buttons[0];
      const last = buttons[buttons.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
      opener?.focus();
    };
  }, []);

  return (
    <div class="presentation" ref={root} role="dialog" aria-modal="true" aria-label={`Results: ${title}`}>
      <header class="presentation-bar">
        <div>
          <h1>{title}</h1>
          {subtitle && <p class="lead">{subtitle}</p>}
        </div>
        <div class="row wrap">
          {hasGroups(columns) && <ViewToggle view={view} onChange={setView} />}
          <button class="secondary" ref={closeRef} onClick={onClose}>Close</button>
        </div>
      </header>
      {results ? (
        <>
          <Summary results={results} />
          <ResultsView results={results} columns={columns} view={view} />
        </>
      ) : <Loading label="Loading results…" />}
    </div>
  );
}
