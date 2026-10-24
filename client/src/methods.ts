import type { Limits, Method } from "./api";

/** Plain-language names and one-sentence explanations, shown wherever someone picks or meets a method. */
export const METHODS: { id: Method; label: string; blurb: string }[] = [
  { id: "dots", label: "Dot voting", blurb: "Each person spends a fixed number of votes on their favorites." },
  { id: "rank", label: "Rank order", blurb: "Each person puts the options in order, from most to least important." },
  { id: "score", label: "Score", blurb: "Each person rates every option from 1 to 5." },
  { id: "points", label: "$100 method", blurb: "Each person splits 100 points across the options, giving more to what matters most." },
];

/** Move one item to a new place in a list, returning a new list. */
export function moveItem<T>(list: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return list;
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

/** A ranking as the server wants it: option id to place (1 is best). */
export const rankValues = (order: number[]): Record<number, number> => Object.fromEntries(order.map((id, i) => [id, i + 1]));

/**
 * The order to show in a rank poll: the person's saved ranking if they have one, otherwise every option in its
 * listed order when they all fit, or an empty list when the person has to choose their top few.
 */
export function orderFromBallot(ballot: Record<number, number>, ideaIds: number[], slots: number): number[] {
  const known = new Set(ideaIds);
  const saved = Object.entries(ballot)
    .map(([id, place]) => ({ id: Number(id), place }))
    .filter((r) => known.has(r.id))
    .sort((a, b) => a.place - b.place || a.id - b.id)
    .map((r) => r.id);
  if (saved.length > 0) return saved.slice(0, Math.max(slots, 0));
  return ideaIds.length <= slots ? [...ideaIds] : [];
}

export const pointsUsed = (ballot: Record<number, number>) => Object.values(ballot).reduce((sum, v) => sum + v, 0);

/** Whether a ballot is finished enough to submit. This mirrors the server, which makes the final call. */
export function isReady(method: Method, ballot: Record<number, number>, limits: Limits, dotsUsed: number, rankLength: number): boolean {
  switch (method) {
    case "dots": return dotsUsed > 0;
    case "score": return Object.keys(ballot).length > 0;
    case "rank": return limits.rankSlots > 0 && rankLength >= limits.rankSlots;
    case "points": return pointsUsed(ballot) === limits.pointsTotal;
  }
}

/** The short counter shown in the top bar of the voting screen. */
export function counterText(method: Method, a: { ballot: Record<number, number>; limits: Limits; votesPerPerson: number; dotsUsed: number; rankLength: number; optionCount: number }): string {
  switch (method) {
    case "dots": return `${a.dotsUsed} of ${a.votesPerPerson} votes used`;
    case "rank": return `${a.rankLength} of ${a.limits.rankSlots} ranked`;
    case "score": return `${Object.keys(a.ballot).length} of ${a.optionCount} rated`;
    case "points": return `${pointsUsed(a.ballot)} of ${a.limits.pointsTotal} points used`;
  }
}

/** The sentence under the poll title that tells people what to do. */
export function instruction(method: Method, a: { votesPerPerson: number; limits: Limits; optionCount: number }): string {
  switch (method) {
    case "dots": return `Vote for up to ${a.votesPerPerson}, then press Submit.`;
    case "rank":
      return a.limits.rankSlots < a.optionCount
        ? `Choose and order your top ${a.limits.rankSlots}, with your favorite first, then press Submit.`
        : "Put the options in order, with your favorite first, then press Submit.";
    case "score": return `Rate each option from 1 to ${a.limits.scoreMax}, then press Submit. You can skip any you have no view on.`;
    case "points": return `Split ${a.limits.pointsTotal} points across the options, giving more to what matters most, then press Submit.`;
  }
}

/** What the bar at the bottom says while someone has not submitted yet. */
export function submitHint(method: Method, a: { votesPerPerson: number; dotsUsed: number; ballot: Record<number, number>; limits: Limits; rankLength: number; ready: boolean }): string {
  switch (method) {
    case "dots":
      return a.dotsUsed === 0 ? `Vote for up to ${a.votesPerPerson} options, then submit.`
        : a.dotsUsed >= a.votesPerPerson ? "You've used all your votes. Submit when you're happy with them."
        : `${a.dotsUsed} of ${a.votesPerPerson} votes used. Submit when you're done.`;
    case "rank":
      return a.ready ? "Happy with your order? Submit it." : `Choose ${a.limits.rankSlots - a.rankLength} more to finish your top ${a.limits.rankSlots}.`;
    case "score":
      return a.ready ? "Submit when you're done. You can skip options you have no view on." : "Rate at least one option, then submit.";
    case "points": {
      const left = a.limits.pointsTotal - pointsUsed(a.ballot);
      return left === 0 ? "All points used. Submit when you're happy with them." : left > 0 ? `${left} points left to give out.` : `You are ${-left} points over.`;
    }
  }
}
