/**
 * Frequently asked questions. They appear on the FAQ page, as a short list on the landing page, and as structured
 * data for search engines. Answers are plain text. Keep the tone friendly and free of em dashes.
 */
export interface Faq {
  id: string;
  q: string;
  a: string;
  /** Optional page to read more. */
  more?: { href: string; label: string };
}

export const FAQS: Faq[] = [
  {
    id: "account",
    q: "Do people need an account to vote?",
    a: "No. Participants open your link, enter a name and vote. You do not need an account to create a poll either.",
  },
  {
    id: "share",
    q: "How do I share a poll?",
    a: "When you create a poll you get two links. Send the participant link to your group. Keep the organizer link to yourself, because it controls the poll and is the only way back in from another device.",
  },
  {
    id: "private",
    q: "Can other people see how I voted?",
    a: "No. Votes are private, and participants only ever see their own choices. While voting is open the organizer sees only how many people have joined and submitted. If the organizer chooses named results, only the organizer can see who voted for what.",
    more: { href: "/privacy", label: "Read the privacy page" },
  },
  {
    id: "modes",
    q: "What is the difference between an open poll and a live session?",
    a: "An open poll takes votes any time until its closing time, so people can vote when it suits them. A live session is run by the organizer with everyone together, with an optional timer. The organizer locks voting and then reveals the results.",
  },
  {
    id: "closing",
    q: "What happens when the closing time passes?",
    a: "The poll closes by itself. Nobody can vote after that, and the results appear for the organizer. If the organizer chose to share results, participants can see anonymous totals too.",
  },
  {
    id: "method",
    q: "Which voting method should I use?",
    a: "Dot voting suits picking a few favorites. Rank order suits putting a short list in order. Scoring suits comparing many options one by one. The $100 method suits showing how strongly people feel. The voting methods page compares them.",
    more: { href: "/voting-methods", label: "Compare voting methods" },
  },
  {
    id: "size",
    q: "How many people can vote?",
    a: "Each poll can have up to 300 participants.",
  },
  {
    id: "change",
    q: "Can people change their vote?",
    a: "Yes, until the poll closes or the organizer locks voting.",
  },
  {
    id: "save",
    q: "Can I save the results?",
    a: "Yes. The organizer can download the results as a CSV file for a spreadsheet, and can rebuild a poll from that file later.",
  },
  {
    id: "kept",
    q: "How long are polls kept?",
    a: "A poll is deleted automatically after 90 days without use. While Ority is in early use, polls can also be erased if the service restarts, so download your results as soon as a poll closes.",
  },
  {
    id: "lost",
    q: "I lost my organizer link. What now?",
    a: "On the same browser, open Ority and look for your poll under Your polls. On a different device you need the original organizer link, so keep it somewhere safe.",
  },
  {
    id: "cost",
    q: "Is Ority free?",
    a: "You can create and run polls without paying or signing up.",
  },
];

/** The few questions shown on the landing page. */
export const LANDING_FAQ_IDS = ["account", "private", "modes", "method", "kept"];
