/**
 * tomHelpContent.ts — Phase 10.4.4 Tom Full Help Guide content
 *
 * Plain data describing each section of /tom/help. Kept separate from the
 * page component so future phases can add a section, tweak a description, or
 * add/remove example questions by editing this list only — no page layout
 * changes required.
 *
 * Documents only currently implemented, user-facing Tom capabilities. Tom
 * answers questions; it never edits the planner, makes recommendations, or
 * links Disney accounts.
 */

export interface TomHelpSection {
  /** Anchor id, also used as the React key and table-of-contents target. */
  id: string;
  title: string;
  paragraphs?: string[];
  bullets?: string[];
  /** Representative example questions — users can ask naturally; these are illustrative, not exact syntax. */
  examples?: string[];
}

export const TOM_HELP_SECTIONS: TomHelpSection[] = [
  {
    id: "about-tom",
    title: "About Tom",
    paragraphs: [
      "Tom Morrow is Disney Wait Planner's AI assistant, inspired by Disney's classic futuristic character of the same name. Tom answers questions about Disney parks, attractions, dining, entertainment, wait times, and news, and can also answer read-only questions about your local trip planner.",
      "This guide is the full reference for what Tom can currently do. For a quick in-chat reference with clickable examples, use the Help button in the Ask Tom chat window.",
    ],
  },
  {
    id: "getting-started",
    title: "Getting Started",
    paragraphs: [
      "Ask Tom naturally, the way you'd ask a person — there's no required command syntax. Every example question in this guide is representative, not an exact script; you can phrase things however feels natural.",
      "Tom understands common Disney park abbreviations and aliases, like MK, EPCOT, DHS, DAK, DLR, and DCA.",
      "Use New Chat in the Ask Tom header anytime you want to start a fresh conversation.",
    ],
    examples: ["What's new at Magic Kingdom?", "What do I have planned today?"],
  },
  {
    id: "disney-information",
    title: "Disney Information",
    paragraphs: [
      "Tom can answer general Disney questions spanning parks, lands, attractions, wait times, dining, entertainment, and news. The sections below break these down by category.",
    ],
  },
  {
    id: "parks-lands",
    title: "Parks & Lands",
    paragraphs: ["Ask about parks and themed lands at Disneyland Resort and Walt Disney World."],
    examples: ["What's new at Magic Kingdom?", "EPCOT updates", "What's new at Galaxy's Edge?"],
  },
  {
    id: "attractions",
    title: "Attractions",
    paragraphs: ["Ask about specific rides and attractions, including what to expect."],
    examples: ["Tell me about TRON.", "Tell me about Rise of the Resistance."],
  },
  {
    id: "wait-times",
    title: "Wait Times",
    paragraphs: ["Ask about current wait times for attractions."],
    examples: ["Wait for Rise of the Resistance", "What's the wait for Space Mountain?"],
  },
  {
    id: "dining",
    title: "Dining",
    paragraphs: ["Ask about dining options at the parks."],
    examples: ["What's good to eat at EPCOT?", "Tell me about Oga's Cantina."],
  },
  {
    id: "entertainment",
    title: "Entertainment",
    paragraphs: ["Ask about shows, parades, and fireworks."],
    examples: ["What entertainment is at Magic Kingdom?", "Tell me about Fantasmic."],
  },
  {
    id: "disney-news",
    title: "Disney News",
    paragraphs: ["Ask about the latest Disney, Star Wars, and Marvel news."],
    examples: ["What's the latest Star Wars news?", "What's the latest Marvel news?", "Disney Parks Blog news"],
  },
  {
    id: "savis-workshop",
    title: "Savi's Workshop",
    paragraphs: [
      "Ask about Savi's Workshop, the custom lightsaber-building experience at Star Wars: Galaxy's Edge.",
    ],
    examples: ["Tell me about Savi's Workshop."],
  },
  {
    id: "planner",
    title: "Planner",
    paragraphs: [
      "Tom can answer read-only questions about your local trip planner, using a compact summary of your plans, days, and Lightning selections. Tom never edits your planner — it only answers questions about it.",
    ],
    bullets: [
      "Trip itinerary summaries",
      "Individual day summaries",
      "Park assignment lookups — which park a given day visits",
      "Park-to-day lookups — which day a given park falls on",
      "Dining included in your planner",
      "Entertainment included in your planner",
      "Conflicts between plans and Lightning selections",
      "Repeated items across days",
    ],
    examples: [
      "What do I have planned today?",
      "What are my plans for Day 2?",
      "What park am I visiting on Day 3?",
      "What day is Magic Kingdom?",
      "What dining do I have?",
      "What entertainment do I have?",
      "Do I have any conflicts?",
      "What am I repeating?",
    ],
  },
  {
    id: "lightning-lane",
    title: "Lightning Lane",
    paragraphs: ["Ask about your saved Lightning Lane selections."],
    examples: ["What Lightning selections do I have?"],
  },
  {
    id: "planner-analytics",
    title: "Planner Analytics",
    paragraphs: [
      "Tom can look across your itinerary to answer higher-level questions, like which day has the most or fewest items planned, or what's first or last on a given day, where your planner has enough detail to support it. Results depend on how much you've entered and may vary as your plans change.",
    ],
    examples: [
      "Which day has the most planned?",
      "Which day has the fewest things planned?",
      "What's the first thing I'm doing on Day 1?",
      "What's the last thing I'm doing on Day 2?",
    ],
  },
  {
    id: "follow-up-conversations",
    title: "Follow-up Conversations",
    paragraphs: [
      "Tom remembers the current conversation, so you can ask natural follow-up questions — including about your planner — without repeating context.",
    ],
    examples: ["Tell me more about number 2.", "What about dining there?", "Any other news?", "Show me the next one."],
  },
  {
    id: "privacy",
    title: "Privacy",
    bullets: [
      "Your planner stays local-first, on this device.",
      "Only a compact, read-only planner summary is sent to Tom.",
      "Tom cannot modify your planner data.",
    ],
  },
  {
    id: "current-limitations",
    title: "Current Limitations",
    paragraphs: ["Tom cannot currently:"],
    bullets: ["Add, edit, or move planner items", "Optimize itineraries", "Synchronize with Disney accounts"],
  },
  {
    id: "tips",
    title: "Tips",
    bullets: [
      "Ask naturally — exact wording doesn't matter, and these examples are just starting points.",
      "Start a New Chat anytime for a clean conversation.",
      "Use common abbreviations like MK, EPCOT, DHS, DAK, DLR, and DCA — Tom understands them.",
      "Open Help in the Ask Tom chat window for one-click example prompts you can edit before sending.",
    ],
  },
];
