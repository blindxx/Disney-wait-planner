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
      "You don't need to repeat yourself every time. Tom remembers the current conversation, so you can ask natural follow-up questions — for example, after asking \"What time is Space Mountain?\" you could just ask \"What else do I have planned that day?\"",
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
      "Item day/time lookups — when a specific saved item is scheduled",
      "Category summaries — attractions, dining, and entertainment you have planned",
      "Park assignment lookups — which park a given day visits",
      "Park-to-day lookups — which day a given park falls on",
      "Conflicts between plans and Lightning selections",
      "Repeated items across days",
    ],
    examples: [
      "What do I have planned today?",
      "What are my plans for Day 2?",
      "What day is my Space Mountain Lightning Lane?",
      "What attractions do I have?",
      "What dining do I have?",
      "What entertainment do I have?",
      "What park am I visiting on Day 3?",
      "What day is Magic Kingdom?",
      "What Lightning selections do I have?",
      "Do I have any conflicts?",
      "What am I repeating?",
    ],
    chipIcon: "📅",
  },
  {
    id: "planner-analytics",
    title: "Planner Analytics",
    icon: "📊",
    paragraphs: [
      "Tom can look across your itinerary to answer questions like which day has the most or fewest activities, what's first or last on a day, your earliest or latest activity, and what comes before or after a specific saved item.",
      "Tom uses what's actually saved in your planner rather than filling in missing details. If the same item appears more than once, Tom may ask which one you mean.",
    ],
    examples: [
      "Which day has the most planned?",
      "Which day has the fewest things planned?",
      "What's the first activity on Day 2?",
      "What's my last dining item on Day 4?",
      "What's my earliest activity?",
      "What's my latest activity?",
      "What comes after Space Mountain?",
      "What comes before Fantasmic!?",
    ],
    chipIcon: "📊",
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
