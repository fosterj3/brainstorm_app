import { useEffect, useRef, useState } from "preact/hooks";
import * as api from "./api";
import type { Column, ResultRow, Results } from "./api";

type View = "ranked" | "columns";

const colorOf = (columns: Column[], id: number) => columns.find((c) => c.id === id)?.color ?? "#6b7280";

function Row({ row, max, columns, named }: { row: ResultRow; max: number; columns: Column[]; named: boolean }) {
  return (
    <li class="result-row" style={{ "--c": colorOf(columns, row.columnId) }}>
      <span class="rank" aria-label={`Rank ${row.rank}${row.tied ? ", tied" : ""}`}>{row.rank}</span>
      <div class="result-body">
        <div class="result-title">
          {row.code && <strong class="code">{row.code} </strong>}
          <strong>{row.title}</strong>
          {row.tied && <span class="tie-badge">Tied</span>}
        </div>
        <div class="result-sub">{row.column}{row.audience ? ` · ${row.audience}` : ""}</div>
        <div class="bar-track" aria-hidden="true"><div class="bar-fill" style={{ width: `${max ? (row.stars / max) * 100 : 0}%` }} /></div>
        {named && row.voters && row.voters.length > 0 && <div class="voters">{row.voters.join(", ")}</div>}
      </div>
      <span class="stars-count">
        <strong>{row.stars}</strong>
        <span class="sr-only"> {row.stars === 1 ? "star" : "stars"}</span>
        <span aria-hidden="true"> ★</span>
      </span>
    </li>
  );
}

/** The ranked list, or the same ideas grouped by column. Used on the facilitator screen and in presentation mode. */
export function ResultsView({ results, columns, view }: { results: Results; columns: Column[]; view: View }) {
  const max = Math.max(0, ...results.rows.map((r) => r.stars));
  if (results.rows.length === 0) return <p class="empty">There are no ideas to rank.</p>;
  if (view === "ranked") {
    return <ol class="result-list">{results.rows.map((r) => <Row key={r.id} row={r} max={max} columns={columns} named={results.named} />)}</ol>;
  }
  return (
    <div class="result-columns">
      {columns.map((col) => {
        const rows = results.rows.filter((r) => r.columnId === col.id);
        if (rows.length === 0) return null;
        const total = rows.reduce((s, r) => s + r.stars, 0);
        return (
          <section key={col.id} class="result-column" style={{ "--c": col.color }}>
            <h3><span class="dot" aria-hidden="true" /> {col.name} <span class="meta">{total} {total === 1 ? "star" : "stars"}</span></h3>
            <ol class="result-list">{rows.map((r) => <Row key={r.id} row={r} max={max} columns={columns} named={results.named} />)}</ol>
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
      <button class="secondary" aria-pressed={view === "columns"} onClick={() => onChange("columns")}>By column</button>
    </div>
  );
}

function Summary({ results }: { results: Results }) {
  const t = results.totals;
  return (
    <p class="hint">
      {t.voted} of {t.joined} {t.joined === 1 ? "person" : "people"} starred ideas · {t.stars} {t.stars === 1 ? "star" : "stars"} in total
      {" · "}{results.named ? "Names are shown." : "Anonymous: no names are shown."}
    </p>
  );
}

type Run = (fn: () => Promise<unknown>) => Promise<void>;

export function ResultsPanel(props: { sid: string; title: string; columns: Column[]; revealed: boolean; onPresent: () => void; run: Run }) {
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
        <p>Results stay hidden, even from you, until you lock voting and then reveal them from the “Run the session” tab.</p>
      </section>
    );
  }
  if (!results) return <section class="panel"><p>Loading results…</p></section>;

  return (
    <section class="panel" aria-labelledby="h-results">
      <div class="row wrap spread">
        <h2 id="h-results">Results</h2>
        <div class="row wrap">
          <ViewToggle view={view} onChange={setView} />
          <button class="primary" onClick={props.onPresent}>Present full screen</button>
          <button class="secondary" onClick={() => props.run(() => api.downloadResultsCsv(sid, title))}>Download CSV</button>
        </div>
      </div>
      <Summary results={results} />
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
          <ViewToggle view={view} onChange={setView} />
          <button class="secondary" ref={closeRef} onClick={onClose}>Close</button>
        </div>
      </header>
      {results ? (
        <>
          <Summary results={results} />
          <ResultsView results={results} columns={columns} view={view} />
        </>
      ) : <p>Loading…</p>}
    </div>
  );
}
