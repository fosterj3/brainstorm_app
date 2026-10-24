/**
 * Poll templates. They prefill the create screen (title, prompt, voting method and sample options) and are shown
 * on the templates page. They are plain data so the server tests can check them too. Keep the copy friendly,
 * plain and free of em dashes.
 */
export type TemplateMethod = "dots" | "rank" | "score" | "points";

export interface TemplateOption {
  title: string;
  summary?: string;
  details?: string;
  group?: string;
  tag?: string;
  code?: string;
}

export interface TemplateGroup {
  name: string;
  description?: string;
  color?: string;
}

export interface Template {
  id: string;
  /** Short name on the chip and the templates page. */
  name: string;
  /** One sentence on what it is for. */
  blurb: string;
  /** The poll title it starts with. The organizer can change it. */
  title: string;
  /** The question or prompt shown under the title. */
  prompt: string;
  method: TemplateMethod;
  /** Dot voting only: how many votes each person gets. */
  votesPerPerson?: number;
  /** How long an open poll made from it stays open by default. */
  closesInDays: number;
  groups?: TemplateGroup[];
  options: TemplateOption[];
}

export const TEMPLATES: Template[] = [
  {
    id: "team-priorities",
    name: "Team priorities",
    blurb: "Agree on the few things your team should focus on first.",
    title: "Team priorities for next quarter",
    prompt: "Which of these should we focus on first? Vote for the ones that would help most.",
    method: "dots",
    votesPerPerson: 3,
    closesInDays: 7,
    options: [
      { title: "Fewer, shorter meetings", summary: "Cut the calendar so there is more time to do the work." },
      { title: "Clear decision owners", summary: "One named person for every important decision." },
      { title: "Better onboarding", summary: "Help new teammates get up to speed in their first month." },
      { title: "Protected focus time", summary: "Quiet blocks with no meetings or messages." },
      { title: "Improve our tools", summary: "Fix the tools that slow people down every day." },
      { title: "Hear from customers more often", summary: "A regular, simple way to bring customer feedback to the team." },
    ],
  },
  {
    id: "feature-voting",
    name: "Feature or roadmap voting",
    blurb: "Find out which features matter most before you build them.",
    title: "Which features should we build next?",
    prompt: "You have 100 points. Spend more on the features that matter most to you.",
    method: "points",
    closesInDays: 14,
    options: [
      { title: "Single sign-on", summary: "Let people log in with their work account." },
      { title: "Mobile app", summary: "Use everything from a phone." },
      { title: "Reporting dashboard", summary: "See progress at a glance, with charts." },
      { title: "API access", summary: "Connect to the other tools you use." },
      { title: "Bulk import", summary: "Bring in your existing data from a spreadsheet." },
      { title: "Dark mode", summary: "An easier-on-the-eyes look for evenings." },
    ],
  },
  {
    id: "survey-actions",
    name: "Post-survey action planning",
    blurb: "Turn survey results into the few actions people want most.",
    title: "Which survey actions should we take first?",
    prompt: "Choose the actions that you feel would make the biggest difference.",
    method: "dots",
    votesPerPerson: 3,
    closesInDays: 7,
    groups: [
      { name: "Structure", description: "Decision rights, approvals, and how decisions get recorded", color: "#3b6fc4" },
      { name: "Ways of working", description: "Meetings, focus time, and simplification", color: "#e8833a" },
      { name: "Culture", description: "Feedback, recognition, and keeping people informed", color: "#3fa56b" },
    ],
    options: [
      { group: "Structure", code: "S1", tag: "For individuals", title: "Review your own approvals", summary: "Flag one approval you think could sit closer to the person doing the work.", details: "Pick the approval that slows your team most. Propose moving it, try it for a month, and write down what happened." },
      { group: "Structure", code: "S2", tag: "For managers", title: "Remove one unneeded approval", summary: "Find one approval step on your team that could be cut or delegated.", details: "Try the change, note the result, and share it with other managers." },
      { group: "Structure", code: "S3", tag: "For everyone", title: "Write down decisions clearly", summary: "Name the decision, who made it, and why, in one shared place.", details: "Keep a simple log: the decision, the owner, the date, the reasoning, and when it will be reviewed." },
      { group: "Ways of working", code: "W1", tag: "For individuals", title: "Protect focus time", summary: "Block time in your calendar and keep it.", details: "Set visible focus blocks and ask your team to respect them, and respect theirs." },
      { group: "Ways of working", code: "W2", tag: "For managers", title: "Audit your team's meetings", summary: "Review each recurring meeting: is it needed, and could it be shorter?", details: "List every recurring meeting, keep the ones that earn their time, shorten or end the rest." },
      { group: "Ways of working", code: "W3", tag: "For everyone", title: "Default to asynchronous updates", summary: "Share status in writing and keep meetings for decisions.", details: "Agree as a team which updates move to writing, and revisit the agreement each quarter." },
      { group: "Culture", code: "C1", tag: "For managers", title: "Open a feedback channel", summary: "A standing agenda item, a shared doc, or an anonymous survey.", details: "Choose one lightweight way for people to raise concerns, and respond to what comes in." },
      { group: "Culture", code: "C2", tag: "For leaders", title: "Close the loop on feedback", summary: "Show what changed because of what people said.", details: "After each round of feedback, share what you heard, what you will do, and what you won't." },
    ],
  },
  {
    id: "offsite-ideas",
    name: "Offsite or event ideas",
    blurb: "Pick a place or activity the whole group will enjoy.",
    title: "Where should we hold our offsite?",
    prompt: "Rate each idea from 1 to 5. Skip any you have no view on.",
    method: "score",
    closesInDays: 7,
    options: [
      { title: "Lakeside lodge", summary: "Quiet, with walking trails." },
      { title: "City hotel", summary: "Easy to reach by train." },
      { title: "Mountain retreat", summary: "Beautiful, but a long drive." },
      { title: "Our own office", summary: "No travel and no extra cost." },
      { title: "Cooking class and dinner", summary: "A fun evening together near the office." },
    ],
  },
  {
    id: "proposal-ranking",
    name: "Proposal or candidate ranking",
    blurb: "Put proposals, vendors or candidates in order, best first.",
    title: "Which proposal should we choose?",
    prompt: "Rank the proposals from strongest to weakest.",
    method: "rank",
    closesInDays: 7,
    options: [
      { title: "Build it ourselves", summary: "Full control, but it takes the longest." },
      { title: "Buy a ready-made tool", summary: "Fast to start, with less room to customize." },
      { title: "Work with a partner", summary: "Shared effort and shared cost." },
      { title: "Run a small pilot first", summary: "Learn before we commit." },
    ],
  },
  {
    id: "quick-decision",
    name: "Quick group decision",
    blurb: "Settle a simple question fast, one vote each.",
    title: "When should we meet?",
    prompt: "Pick the time that works best for you.",
    method: "dots",
    votesPerPerson: 1,
    closesInDays: 2,
    options: [
      { title: "Tuesday at 10:00" },
      { title: "Wednesday at 14:00" },
      { title: "Thursday at 11:00" },
    ],
  },
];

export const templateById = (id: string): Template | undefined => TEMPLATES.find((t) => t.id === id);
