import { useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
import type { Column, Idea, Limits, Method } from "./api";
import { pointsUsed } from "./methods";

export interface VoteUi {
  method: Method;
  /** Options this person has a dot on (dot polls). */
  votes: Set<number>;
  /** Option id to value: a score or points. Used by score and points polls. */
  ballot: Record<number, number>;
  limits: Limits;
  /** Voting is open right now. */
  enabled: boolean;
  /** The person has used every dot, so cards without one are blocked. */
  full: boolean;
  onToggle: (id: number) => void;
  /** Set a score or points for an option, or clear it with null. */
  onSetValue: (id: number, value: number | null) => void;
}

/**
 * The poll's options: one panel per group, each tinted with the organizer's color, with cards inside. A poll with
 * no named groups is a plain list of cards instead. Each card carries the control for the poll's voting method
 * (a star, a 1 to 5 score, or a points box). Rank order polls use their own list instead (see Rank.tsx).
 * Used by participants (with voting controls) and by the organizer's preview (without).
 */
export function Board(props: {
  columns: Column[];
  ideas: Idea[];
  vote?: VoteUi;
  /** Rendered at the end of the ungrouped section, e.g. the "Add your own option" tile. */
  groupExtra?: ComponentChildren;
  /** Show the ungrouped section even when it has no options yet. */
  showEmptyGroup?: boolean;
}) {
  const { columns, ideas, vote } = props;
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const toggle = (id: number) =>
    setCollapsed((c) => {
      const n = new Set(c);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });

  // No named groups: skip the column chrome and show the options as one plain list.
  if (!columns.some((c) => c.kind === "normal")) {
    return (
      <div class="board flat" style={{ "--c": "var(--tint-4)" }}>
        <ul class="cards">
          {ideas.map((idea) => <Card key={idea.id} idea={idea} vote={vote} />)}
          {props.groupExtra && <li class="card-slot">{props.groupExtra}</li>}
        </ul>
      </div>
    );
  }

  const given = (id: number) => (vote?.method === "dots" ? vote.votes.has(id) : vote?.ballot[id] !== undefined);
  const word = vote?.method === "dots" ? "voted" : vote?.method === "points" ? "given points" : vote?.method === "score" ? "rated" : "";
  const shown = columns.filter((c) => c.kind === "normal" || props.showEmptyGroup || ideas.some((i) => i.columnId === c.id));
  return (
    <div class="board">
      {shown.map((col) => {
        const items = ideas.filter((i) => i.columnId === col.id);
        const open = !collapsed.has(col.id);
        const starred = vote ? items.filter((i) => given(i.id)).length : 0;
        return (
          <section class="column" key={col.id} style={{ "--c": col.color }}>
            <h2>
              <button class="column-toggle" aria-expanded={open} aria-controls={`col-${col.id}`} onClick={() => toggle(col.id)}>
                <span class="dot" aria-hidden="true" />
                <span class="column-name">{col.name}</span>
                <span class="meta">{items.length}{starred && word ? ` · ${starred} ${word}` : ""}</span>
                <span class="chev" aria-hidden="true">{open ? "▾" : "▸"}</span>
              </button>
            </h2>
            {col.description && <p class="column-desc">{col.description}</p>}
            <div id={`col-${col.id}`} hidden={!open}>
              <ul class="cards">
                {items.map((idea) => <Card key={idea.id} idea={idea} vote={vote} />)}
                {col.kind === "group" && props.groupExtra && <li class="card-slot">{props.groupExtra}</li>}
              </ul>
              {items.length === 0 && col.kind === "normal" && <p class="empty">No options in this group yet.</p>}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function Card({ idea, vote }: { idea: Idea; vote?: VoteUi }) {
  const [open, setOpen] = useState(false);
  const method = vote?.method ?? "dots";
  const value = vote?.ballot[idea.id];
  const on = method === "dots" ? vote?.votes.has(idea.id) ?? false : value !== undefined;
  const blocked = !!vote && (!vote.enabled || (method === "dots" && !on && vote.full));
  return (
    <li class={`card${on ? " on" : ""}`}>
      {(idea.code || idea.audience) && (
        <div class="card-top">
          {idea.code && <strong class="code">{idea.code}</strong>}
          {idea.audience && <span class="aud">{idea.audience}</span>}
        </div>
      )}
      <h3>{idea.title}</h3>
      {idea.summary && <p class="summary">{idea.summary}</p>}
      {open && idea.details && <p class="details">{idea.details}</p>}
      <div class={`card-foot${vote && method !== "dots" ? " stacked" : ""}`}>
        {idea.details ? (
          <button class="details-link" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? "Hide details" : "Details"}</button>
        ) : <span />}
        {vote && method === "dots" && (
          <button
            class="star" aria-pressed={on} aria-disabled={blocked}
            aria-label={`${on ? "Remove your vote from" : "Vote for"} ${idea.title}`}
            onClick={() => vote.onToggle(idea.id)}
          >
            <span aria-hidden="true">{on ? "★" : "☆"}</span>
          </button>
        )}
        {vote && method === "score" && <ScoreControl idea={idea} vote={vote} value={value} />}
        {vote && method === "points" && <PointsControl idea={idea} vote={vote} value={value} />}
      </div>
    </li>
  );
}

/** Buttons 1 to 5. Pressing the chosen one again clears it, so skipping an option stays easy. */
function ScoreControl({ idea, vote, value }: { idea: Idea; vote: VoteUi; value: number | undefined }) {
  const max = vote.limits.scoreMax;
  return (
    <div class="score">
      <div class="score-buttons" role="radiogroup" aria-label={`Rating for ${idea.title}`}>
        {Array.from({ length: max }, (_, i) => i + 1).map((n) => (
          <button
            key={n} type="button" role="radio" aria-checked={value === n} aria-label={`${n} out of ${max}`}
            class={`score-btn${value === n ? " on" : ""}`} aria-disabled={!vote.enabled}
            onClick={() => vote.enabled && vote.onSetValue(idea.id, value === n ? null : n)}
          >
            {n}
          </button>
        ))}
      </div>
      <button type="button" class="link small" hidden={value === undefined} disabled={!vote.enabled} aria-label={`Clear rating for ${idea.title}`} onClick={() => vote.onSetValue(idea.id, null)}>Clear</button>
    </div>
  );
}

/** A points box with small step buttons. It never lets the total go past the points available. */
function PointsControl({ idea, vote, value }: { idea: Idea; vote: VoteUi; value: number | undefined }) {
  const current = value ?? 0;
  const left = vote.limits.pointsTotal - pointsUsed(vote.ballot);
  const set = (next: number) => {
    const clamped = Math.max(0, Math.min(next, current + left));
    if (clamped !== current) vote.onSetValue(idea.id, clamped === 0 ? null : clamped);
    return clamped;
  };
  return (
    <div class="points">
      <button type="button" class="step" aria-label={`Fewer points for ${idea.title}`} disabled={!vote.enabled || current === 0} onClick={() => set(current - 5)}>−</button>
      <input
        type="number" min="0" max={vote.limits.pointsTotal} step="1" inputMode="numeric" placeholder="0"
        aria-label={`Points for ${idea.title}`} value={value ?? ""} disabled={!vote.enabled}
        onChange={(e) => {
          const input = e.target as HTMLInputElement;
          const n = input.value === "" ? 0 : Math.floor(Number(input.value));
          const kept = Number.isFinite(n) ? set(n) : current;
          input.value = kept === 0 ? "" : String(kept); // show what was actually kept if it was trimmed to fit
        }}
      />
      <button type="button" class="step" aria-label={`More points for ${idea.title}`} disabled={!vote.enabled || left <= 0} onClick={() => set(current + Math.min(5, left))}>+</button>
    </div>
  );
}
