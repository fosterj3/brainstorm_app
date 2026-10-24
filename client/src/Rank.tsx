import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { Column, Idea } from "./api";
import { moveItem } from "./methods";

/**
 * A rank order ballot: a list the person puts in order. Three ways to move an option, so it works for everyone:
 * drag the handle (mouse or touch), press the up and down buttons, or use Tab and Enter on those buttons.
 * When there are more options than ranking places, the rest wait in an "Other options" list to be added.
 */
export function RankBallot(props: {
  ideas: Idea[];
  columns: Column[];
  /** Option ids in the person's order, best first. */
  order: number[];
  /** How many places there are to fill. */
  slots: number;
  enabled: boolean;
  /** Called on every step of a change, so the list follows the finger. Not saved yet. */
  onChange: (order: number[]) => void;
  /** Called when a change is finished (a drop, a button press). Save it. */
  onCommit: (order: number[]) => void;
  extra?: ComponentChildren;
}) {
  const { ideas, columns, order, slots, enabled } = props;
  const byId = new Map(ideas.map((i) => [i.id, i]));
  const ranked = order.map((id) => byId.get(id)).filter((i): i is Idea => !!i);
  const pool = ideas.filter((i) => !order.includes(i.id));
  const choosing = ideas.length > slots; // the person picks a top few instead of ranking everything
  const [dragging, setDragging] = useState<number | null>(null);
  const [announce, setAnnounce] = useState("");
  const rows = useRef(new Map<number, HTMLLIElement>());
  const live = useRef(order);
  live.current = dragging === null ? order : live.current;

  const groupOf = (idea: Idea) => {
    const col = columns.find((c) => c.id === idea.columnId);
    return col && col.kind === "normal" ? col.name : "";
  };

  const move = (id: number, to: number) => {
    const next = moveItem(order, order.indexOf(id), to);
    if (next === order) return;
    props.onChange(next);
    props.onCommit(next);
    setAnnounce(`${byId.get(id)?.title ?? "Option"} moved to place ${to + 1} of ${next.length}.`);
  };

  // While dragging, follow the pointer anywhere on the page and drop on release.
  useEffect(() => {
    if (dragging === null) return;
    const onMove = (e: PointerEvent) => {
      // Near the top or bottom edge of the screen, keep the page scrolling so a long list can be dragged all the way.
      if (e.clientY < 90) window.scrollBy(0, -14);
      else if (e.clientY > window.innerHeight - 90) window.scrollBy(0, 14);
      const ids = live.current;
      let target = ids.length - 1;
      for (let i = 0; i < ids.length; i++) {
        const el = rows.current.get(ids[i]);
        if (el && e.clientY < el.getBoundingClientRect().bottom) { target = i; break; }
      }
      const from = ids.indexOf(dragging);
      if (from >= 0 && target !== from) {
        live.current = moveItem(ids, from, target);
        props.onChange(live.current);
      }
    };
    const onUp = () => {
      setDragging(null);
      props.onCommit(live.current);
      setAnnounce(`${byId.get(dragging)?.title ?? "Option"} dropped at place ${live.current.indexOf(dragging) + 1} of ${live.current.length}.`);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [dragging]);

  return (
    <div class="ranker">
      <h2 class="rank-title">{choosing ? `Your top ${slots}` : "Your ranking"}</h2>
      <p class="hint">
        {choosing
          ? `Add up to ${slots} options, then put them in order with your favorite first.`
          : "Drag by the handle, or use the arrow buttons, to put the options in order with your favorite first."}
      </p>
      {ranked.length === 0 && <p class="empty">Nothing here yet. Add options from the list below.</p>}
      <ol class="rank-list">
        {ranked.map((idea, i) => (
          <li
            key={idea.id} class={`rank-item${dragging === idea.id ? " dragging" : ""}`}
            ref={(el) => { if (el) rows.current.set(idea.id, el); else rows.current.delete(idea.id); }}
          >
            <span class="rank-pos" aria-hidden="true">{i + 1}</span>
            <button
              type="button" class="rank-handle" disabled={!enabled}
              aria-label={`Drag ${idea.title} to change its place. Or use the arrow buttons.`}
              onPointerDown={(e) => { if (!enabled) return; e.preventDefault(); live.current = order; setDragging(idea.id); }}
            >
              <span aria-hidden="true">⠿</span>
            </button>
            <div class="rank-text">
              <strong>{idea.title}</strong>
              {(groupOf(idea) || idea.audience) && <small>{[groupOf(idea), idea.audience].filter(Boolean).join(" · ")}</small>}
              {idea.summary && <small>{idea.summary}</small>}
            </div>
            <div class="rank-actions">
              <button type="button" class="step" disabled={!enabled || i === 0} aria-label={`Move ${idea.title} up. It is in place ${i + 1} of ${ranked.length}.`} onClick={() => move(idea.id, i - 1)}>↑</button>
              <button type="button" class="step" disabled={!enabled || i === ranked.length - 1} aria-label={`Move ${idea.title} down. It is in place ${i + 1} of ${ranked.length}.`} onClick={() => move(idea.id, i + 1)}>↓</button>
              {choosing && (
                <button
                  type="button" class="link small" disabled={!enabled} aria-label={`Remove ${idea.title} from your top ${slots}`}
                  onClick={() => { const next = order.filter((x) => x !== idea.id); props.onChange(next); props.onCommit(next); setAnnounce(`${idea.title} removed from your ranking.`); }}
                >
                  Remove
                </button>
              )}
            </div>
          </li>
        ))}
      </ol>
      <p class="sr-only" role="status">{announce}</p>

      {choosing && (
        <>
          <h2 class="rank-title">Other options</h2>
          <ul class="rank-pool">
            {pool.map((idea) => (
              <li key={idea.id} class="rank-item pool">
                <div class="rank-text">
                  <strong>{idea.title}</strong>
                  {idea.summary && <small>{idea.summary}</small>}
                </div>
                <button
                  type="button" class="secondary small" disabled={!enabled || order.length >= slots}
                  aria-label={`Add ${idea.title} to your top ${slots}`}
                  onClick={() => { const next = [...order, idea.id]; props.onChange(next); props.onCommit(next); setAnnounce(`${idea.title} added in place ${next.length} of ${slots}.`); }}
                >
                  Add
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {props.extra}
    </div>
  );
}
