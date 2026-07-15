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
  /** Small decorative emoji shown next to the section heading. */
  icon: string;
  paragraphs?: string[];
  bullets?: string[];
  /** Representative example questions — users can ask naturally; these are illustrative, not exact syntax. */
  examples?: string[];
  /** Decorative emoji prefixed to this section's example chips, when one fits the topic without adding clutter. */
  chipIcon?: string;
}

export const TOM_HELP_SECTIONS: TomHelpSection[] = [
  {
    id: "about-tom",
    title: "About Tom",
    icon: "🤖",
    paragraphs: [
      "Tom Morrow is Disney Wait Planner's AI assistant, inspired by Disney's classic futuristic character of the same name. Tom answers questions about Disney parks, attractions, dining, entertainment, wait times, and news, and can also answer read-only questions about your local trip planner.",
      "This guide is the full reference for what Tom can currently do. For a quick in-chat reference with clickable examples, use the Help button in the Ask Tom chat window.",
    ],
  },
  {
    id: "getting-started",
    title: "Getting Started",
    icon: "🚀",
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
    icon: "🏰",
    paragraphs: [
      "Tom can answer general Disney questions spanning parks, lands, attractions, wait times, dining, entertainment, and news. The sections below break these down by category.",
    ],
  },
  {
    id: "parks-lands",
    title: "Parks & Lands",
    icon: "🗺️",
    paragraphs: ["Ask about parks and themed lands at Disneyland Resort and Walt Disney World."],
    examples: ["What's new at Magic Kingdom?", "EPCOT updates", "What's new at Galaxy's Edge?"],
  },
  {
    id: "attractions",
    title: "Attractions",
    icon: "🎢",
    paragraphs: ["Ask about specific rides and attractions, including what to expect."],
    examples: ["Tell me about TRON.", "Tell me about Rise of the Resistance."],
    chipIcon: "🎢",
  },
  {
    id: "wait-times",
    title: "Wait Times",
    icon: "⏱️",
    paragraphs: ["Ask about current wait times for attractions."],
    examples: ["Wait for Rise of the Resistance", "What's the wait for Space Mountain?"],
    chipIcon: "⏱️",
  },
  {
    id: "dining",
    title: "Dining",
    icon: "🍽️",
    paragraphs: ["Ask about dining options at the parks."],
    examples: ["What's good to eat at EPCOT?", "Tell me about Oga's Cantina."],
    chipIcon: "🍽️",
  },
  {
    id: "entertainment",
    title: "Entertainment",
    icon: "🎆",
    paragraphs: ["Ask about shows, parades, and fireworks."],
    examples: ["What entertainment is at Magic Kingdom?", "Tell me about Fantasmic."],
    chipIcon: "🎆",
  },
  {
    id: "disney-news",
    title: "Disney News",
    icon: "📰",
    paragraphs: ["Ask about the latest Disney, Star Wars, and Marvel news."],
    examples: ["What's the latest Star Wars news?", "What's the latest Marvel news?", "Disney Parks Blog news"],
    chipIcon: "📰",
  },
  {
    id: "savis-workshop",
    title: "Savi's Workshop",
    icon: "🛠️",
    paragraphs: [
      "Ask about Savi's Workshop, the custom lightsaber-building experience at Star Wars: Galaxy's Edge.",
    ],
    examples: ["Tell me about Savi's Workshop."],
    chipIcon: "🛠️",
  },
  {
    id: "planner",
    title: "Planner",
    icon: "📅",
    paragraphs: [
      "Tom can answer questions about your local planner, but can't make changes to it. Tom understands your itinerary information, including plans, Lightning Lane, dining, entertainment, conflicts, repeats, and park assignments.",
      "Tom also understands common Disney abbreviations and aliases when looking things up — for example MK, EPCOT, DHS, DAK, DLR, and DCA. These are just examples, not a complete list.",
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
    chipIcon: "📅",
  },
  {
    id: "lightning-lane",
    title: "Lightning Lane",
    icon: "⚡",
    paragraphs: ["Ask about your saved Lightning Lane selections."],
    examples: ["What Lightning selections do I have?"],
    chipIcon: "⚡",
  },
  {
    id: "planner-analytics",
    title: "Planner Analytics",
    icon: "📊",
    paragraphs: [
      "Tom can look across your itinerary to answer higher-level questions, like which day has the most or fewest items planned, or what's first or last on a given day, where your planner has enough detail to support it. Results depend on how much you've entered and may vary as your plans change.",
      "Activity ordering is fully deterministic: days are ordered the way they appear in your itinerary, same-day activities are ordered by their explicit times, and anything without a time (or a tied time) keeps its original planner order. Tom never invents an order from names, categories, or typical touring patterns.",
      "Tom can also tell you what's immediately before or after an activity you name explicitly, like a specific attraction, show, or reservation — not general moments like \"after lunch\" or \"in the evening\", since those aren't real planner items.",
      "If you've given a day a custom name, Tom uses it naturally in answers, and \"Day 2\"-style references still work the same way. Today/tomorrow questions only work when your planner days have real dates attached — without them, Tom will let you know rather than guess.",
    ],
    examples: [
      "Which day has the most planned?",
      "Which day has the fewest things planned?",
      "What's the first thing I'm doing on Day 1?",
      "What's the last thing I'm doing on Day 2?",
      "What's my earliest activity?",
      "What comes after Space Mountain?",
    ],
    chipIcon: "📊",
  },
  {
    id: "follow-up-conversations",
    title: "Follow-up Conversations",
    icon: "💬",
    paragraphs: [
      "Tom remembers the current conversation, so you can ask natural follow-up questions — including about your planner — without repeating context.",
    ],
    examples: ["Tell me more about number 2.", "What about dining there?", "Any other news?", "Show me the next one."],
    chipIcon: "💬",
  },
  {
    id: "privacy",
    title: "Privacy",
    icon: "🔒",
    bullets: [
      "Your planner stays local-first, on this device.",
      "Only a compact, read-only planner summary is sent to Tom.",
      "Tom cannot modify your planner data.",
    ],
  },
  {
    id: "current-limitations",
    title: "Current Limitations",
    icon: "⚠️",
    paragraphs: ["Tom cannot currently:"],
    bullets: ["Add, edit, or move planner items", "Optimize itineraries", "Synchronize with Disney accounts"],
  },
  {
    id: "tips",
    title: "Tips",
    icon: "💡",
    bullets: [
      "Ask naturally — exact wording doesn't matter, and these examples are just starting points.",
      "Start a New Chat anytime for a clean conversation.",
      "Use common abbreviations like MK, EPCOT, DHS, DAK, DLR, and DCA — Tom understands them.",
      "Open Help in the Ask Tom chat window for one-click example prompts you can edit before sending.",
    ],
  },
];
