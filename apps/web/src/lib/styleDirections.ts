/**
 * STAGING ONLY (T-482): what the picker (/style-preview) says about each visual direction. The looks themselves are
 * app/style-directions.css; this is the case for each, tied to the taste it answers, so Aaron can react to choices
 * rather than guess at them.
 */

import type { StyleDirection } from "@/lib/stylePreview";

export interface DirectionCard {
  key: StyleDirection;
  name: string;
  idea: string;
  /** Each choice and the taste line it answers (paraphrased, never quoted). */
  choices: { choice: string; because: string }[];
  type: { role: string; family: string; css: string; sample: string; size: string; style?: "italic"; weight?: number }[];
  palette: { name: string; hex: string }[];
  spacing: string;
  motion: string;
  strong: string;
  risk: string;
  learnedFrom: string;
}

export const DIRECTION_CARDS: DirectionCard[] = [
  {
    key: "book",
    name: "Hand-set book",
    idea: "The site as a small-press book: one column, set in Garamond, ink and one spot colour on laid paper.",
    choices: [
      { choice: "Everything in EB Garamond, small and quiet", because: "reading should feel like an old book, but alive" },
      { choice: "No cards or boxes; space and a short rule between sections", because: "calm order with room; boxy grids feel off" },
      { choice: "Ink plus one moss spot colour", because: "one earthy tone, never shifting colour" },
      { choice: "A brush ensō drawn once around the mark", because: "handmade and analog; alive as the page opens" },
    ],
    type: [
      { role: "Reading and interface", family: "EB Garamond", css: '"EB Garamond", serif', sample: "Come work beside people who build.", size: "1.15rem" },
      { role: "Headings", family: "EB Garamond italic", css: '"EB Garamond", serif', sample: "A place in the practice", size: "1.9rem", style: "italic" },
    ],
    palette: [
      { name: "Laid paper", hex: "#ebe6d9" },
      { name: "Ink", hex: "#27231d" },
      { name: "Moss (spot colour)", hex: "#4b5a2c" },
      { name: "Walnut (prices)", hex: "#6e4f2f" },
    ],
    spacing: "One centred column at a 40rem measure; type set 12% larger (Garamond's small x-height); rules instead of frames.",
    motion: "Pages settle like ink: blocks rise a few pixels on shrinking gaps (0, 110, 200, 260ms), 900ms each, on one ease-out curve. On home the ensō draws first (1.6s), then the title (at 500ms), its line, the actions. Nothing moves after; the portal stays still.",
    strong: "The most distinct from today and the most like reading. It turns a dashboard into a publication, and it fits the community-of-practice voice.",
    risk: "All-serif interface text is slow to scan in the portal and admin; buttons and forms in italic Garamond can feel precious. Step 2 would likely add a sans for working screens.",
    learnedFrom: "Fitzcarraldo Editions, The Public Domain Review, Craig Mod",
  },
  {
    key: "field",
    name: "Field guide",
    idea: "A naturalist's guide to the place: a painted view of the Flatirons, entries on framed plates, moss and ochre.",
    choices: [
      { choice: "A painted Flatirons landscape opens the home page", because: "evocative imagery in balance with text; painted landscapes appeal" },
      { choice: "Fraunces (soft, light) for headings, Source Serif for reading, Public Sans for labels", because: "a quiet book serif with a clean sans alongside" },
      { choice: "Moss and ochre only", because: "one or two earthy, ecological tones" },
      { choice: "Content on framed plates, left aligned like guide entries", because: "ordered and calm, presenting information in its own way" },
    ],
    type: [
      { role: "Headings", family: "Fraunces 300, soft", css: '"Fraunces", serif', sample: "Agents Building Night", size: "1.9rem", weight: 300 },
      { role: "Reading", family: "Source Serif 4", css: '"Source Serif 4", serif', sample: "Bring what you're building with agents.", size: "1.05rem" },
      { role: "Labels and buttons", family: "Public Sans", css: '"Public Sans", sans-serif', sample: "Try a free day", size: "0.95rem", weight: 500 },
    ],
    palette: [
      { name: "Lichen paper", hex: "#e6e8dc" },
      { name: "Ink", hex: "#22291e" },
      { name: "Moss", hex: "#44593a" },
      { name: "Ochre", hex: "#b0702f" },
    ],
    spacing: "Plates with a thin double frame and 3px corners; pill buttons; generous inner padding, tight gaps between plates.",
    motion: "On home the painting settles back to front like haze lifting (far range, mountain and slabs, pines, near trees; 1.4s each, 0 to 340ms apart), the title rises 10px at 260ms, its line and the actions after. Other pages: the same settle on their blocks, 1s.",
    strong: "The warmest and most place-specific: it says Boulder before a word is read, and it carries the ecological side of RegenHub without a photo shoot.",
    risk: "The painting is code-drawn for this preview; a real commissioned painting (or a member's) would be needed to ship. Plates everywhere can drift back towards cards if step 2 isn't strict.",
    learnedFrom: "Stripe Press, Hakai Magazine, Low-tech Magazine, Dark Mountain",
  },
  {
    key: "studio",
    name: "Studio",
    idea: "A calm working studio: one clean grotesk, flat tiles, ink and pine, and one very large serif line.",
    choices: [
      { choice: "Instrument Sans for everything", because: "a quiet clean grotesk, plain words in labels" },
      { choice: "One oversized Instrument Serif line per page", because: "oversized type only to land one message" },
      { choice: "A real photo of the place beside the line", because: "evocative photos in balance with text" },
      { choice: "Ink and pine, flat warm-grey tiles, left aligned on a wide page", because: "bold, never bland, without clutter" },
    ],
    type: [
      { role: "The one big line", family: "Instrument Serif", css: '"Instrument Serif", serif', sample: "Boulder's regenerative coworking space", size: "2.4rem" },
      { role: "Everything else", family: "Instrument Sans", css: '"Instrument Sans", sans-serif', sample: "Come to a night. Your first day is free.", size: "1rem" },
    ],
    palette: [
      { name: "Warm white", hex: "#f5f4ef" },
      { name: "Ink", hex: "#191a17" },
      { name: "Pine", hex: "#1f4a3a" },
      { name: "Tile", hex: "#eae8e1" },
    ],
    spacing: "Left aligned on an 80rem page; flat tiles with 6px corners and no frame; the home hero in two columns (line, photo).",
    motion: "The big line is drawn up from its baseline (a 900ms clip reveal); its line and the actions fade up a few pixels at 120 and 220ms. Other pages: a short 700ms settle.",
    strong: "The easiest to live with every day, and the easiest to extend to the portal and admin. The big line gives the home page a voice.",
    risk: "Closest to a familiar modern-studio template; without the photo and the serif line it would turn bland. It leans less on the handmade side of the taste.",
    learnedFrom: "Kinfolk, Stripe Press, Robin Sloan",
  },
];

export const RECOMMENDATION =
  "Field guide, with the Studio's working screens. Field guide is the one only RegenHub could have: the place, the " +
  "ecology and the calm all show at once, and its plates give step 2 a clear rule for every page. For the portal and " +
  "admin, its Public Sans labels and flat tiles (as in Studio) keep daily screens quick to scan. Hand-set book is the " +
  "boldest; if Aaron wants a publication more than a place, it is the one to pick.";

/** The research behind the three, each checked live in a browser on 2026-11-20. */
export const REFERENCES: { name: string; url: string; note: string; informs: string }[] = [
  { name: "Fitzcarraldo Editions", url: "https://fitzcarraldoeditions.com/", note: "A small press whose plain, near-uniform covers sit on an empty page: restraint as the identity.", informs: "book" },
  { name: "The Public Domain Review", url: "https://publicdomainreview.org/", note: "Antique engravings beside small calligraphic-serif text (Alegreya); images never crowd the words.", informs: "book" },
  { name: "Craig Mod", url: "https://craigmod.com/", note: "A writer's site in small serif with lots of air; photography kept quiet.", informs: "book" },
  { name: "Robin Sloan", url: "https://www.robinsloan.com/", note: "Cream paper, one bold red display face, plain prose: a personal site that shows its maker's mind.", informs: "book, studio" },
  { name: "Stripe Press", url: "https://press.stripe.com/", note: "Painted landscapes behind condensed serif titles; each book an object. Bold, with almost no chrome.", informs: "field, studio" },
  { name: "Hakai Magazine", url: "https://hakaimagazine.com/", note: "A painted illustration leads the page; science writing in a calm serif and sans pairing.", informs: "field" },
  { name: "Low-tech Magazine", url: "https://solar.lowtechmagazine.com/", note: "Solar-powered, dithered images, plain serif: the ecology is in how the site is built.", informs: "field" },
  { name: "Dark Mountain Project", url: "https://dark-mountain.net/", note: "A full-bleed photograph with an italic serif line set over it; an immersive dark page that earns it.", informs: "field" },
  { name: "Emergence Magazine", url: "https://emergencemagazine.org/", note: "Dark, slow and immersive; shows when a dark page works (fully immersive), and why our default stays light.", informs: "field (contrast)" },
  { name: "Kinfolk", url: "https://www.kinfolk.com/", note: "Mostly white page, one cover image, small type: room as the main material.", informs: "studio" },
  { name: "Ink & Switch", url: "https://www.inkandswitch.com/", note: "A research lab's home page is an interactive drawing you play with: information shown in a new way.", informs: "studio" },
];
