import { useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
import type { Column, Idea } from "./api";

export interface VoteUi {
  votes: Set<number>;
  /** Stars can be toggled right now. */
  enabled: boolean;
  /** The person has used every star, so un-starred cards are blocked. */
  full: boolean;
  onToggle: (id: number) => void;
}

/**
 * The board: one panel per column, each tinted with the facilitator's color, with cards inside.
 * Used by participants (with stars) and by the facilitator's preview (without).
 */
export function Board(props: {
  columns: Column[];
  ideas: Idea[];
  vote?: VoteUi;
  /** Rendered at the end of the group column, e.g. the "Add your own idea" tile. */
  groupExtra?: ComponentChildren;
  /** Show the group column even when it has no ideas yet. */
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

  const shown = columns.filter((c) => c.kind === "normal" || props.showEmptyGroup || ideas.some((i) => i.columnId === c.id));
  return (
    <div class="board">
      {shown.map((col) => {
        const items = ideas.filter((i) => i.columnId === col.id);
        const open = !collapsed.has(col.id);
        const starred = vote ? items.filter((i) => vote.votes.has(i.id)).length : 0;
        return (
          <section class="column" key={col.id} style={{ "--c": col.color }}>
            <h2>
              <button class="column-toggle" aria-expanded={open} aria-controls={`col-${col.id}`} onClick={() => toggle(col.id)}>
                <span class="dot" aria-hidden="true" />
                <span class="column-name">{col.name}</span>
                <span class="meta">{items.length}{starred ? ` · ${starred} starred` : ""}</span>
                <span class="chev" aria-hidden="true">{open ? "▾" : "▸"}</span>
              </button>
            </h2>
            {col.description && <p class="column-desc">{col.description}</p>}
            <div id={`col-${col.id}`} hidden={!open}>
              <ul class="cards">
                {items.map((idea) => <Card key={idea.id} idea={idea} vote={vote} />)}
                {col.kind === "group" && props.groupExtra && <li class="card-slot">{props.groupExtra}</li>}
              </ul>
              {items.length === 0 && col.kind === "normal" && <p class="empty">No ideas in this column yet.</p>}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function Card({ idea, vote }: { idea: Idea; vote?: VoteUi }) {
  const [open, setOpen] = useState(false);
  const on = vote?.votes.has(idea.id) ?? false;
  const blocked = !!vote && (!vote.enabled || (!on && vote.full));
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
      <div class="card-foot">
        {idea.details ? (
          <button class="details-link" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? "Hide details" : "Details"}</button>
        ) : <span />}
        {vote && (
          <button
            class="star" aria-pressed={on} aria-disabled={blocked}
            aria-label={`${on ? "Remove star from" : "Star"} ${idea.title}`}
            onClick={() => vote.onToggle(idea.id)}
          >
            <span aria-hidden="true">{on ? "★" : "☆"}</span>
          </button>
        )}
      </div>
    </li>
  );
}
