/** Display text for what the translator can read, what a fly did, and what a holder can poke. */
export type Word = { tag: string; says: string; really: string; cells: string };

export const WORDS: Record<string, Word> = {
  threat: { tag: "threat", says: "Something big is coming at me.", really: "a looming shape", cells: "LC4 + LPLC2" },
  mate: { tag: "mate", says: "Someone over there is worth following.", really: "a moving, fly-sized target", cells: "LC10a" },
  wind: { tag: "wind", says: "It's windy out here.", really: "wind on the antennae", cells: "JO-C + JO-E" },
  taste: { tag: "taste", says: "Tasting something.", really: "taste neurons in the mouth", cells: "pharyngeal GRNs" },
  touch: { tag: "touch", says: "Something brushed my eye.", really: "eye bristles touched", cells: "BM_InOm" },
  cva: { tag: "cVA", says: "Smells like another male around here.", really: "cVA, the male pheromone", cells: "ORN_DA1" },
  nothing: { tag: "nothing", says: "…", really: "nothing at all", cells: "none" },
};

export const word = (w: string): Word => WORDS[w] ?? { tag: w, says: w, really: w, cells: "?" };

/**
 * Ways to say each word. Every line means exactly what the translator read, nothing more: `sure` for posts
 * the brain read right, `unsure` for misreads and hallucinations (the card says which, and what really
 * happened). Which line a post gets is fixed by its id, so a post always reads the same.
 */
const LINES: Record<string, { sure: string[]; unsure: string[] }> = {
  threat: {
    sure: ["Something big is coming at me.", "Incoming. Something huge.", "A shadow just swooped over me.",
           "That thing is getting bigger fast.", "Something's looming. Not sticking around.", "Big shape, closing in."],
    unsure: ["Wait, is something coming at me?", "I'd swear something just loomed.", "Did a shadow just move?",
             "Something big… maybe?"],
  },
  mate: {
    sure: ["Someone over there is worth following.", "There's a fly moving over there.", "Oh, who's that?",
           "Something fly-sized just went past.", "Keeping my eyes on that one.", "A mover, right over there."],
    unsure: ["Was that a fly going past?", "I think someone moved over there.", "Someone worth following… I think.",
             "Saw a mover. Probably."],
  },
  wind: {
    sure: ["It's windy out here.", "Breeze on my antennae.", "Air's moving.", "Hold on, gust.", "Feeling the wind."],
    unsure: ["Is that a breeze?", "Air moving… I think.", "Felt a draft, maybe."],
  },
  taste: {
    sure: ["Tasting something.", "Mm. Something on my tongue.", "That tastes like something.", "Food? Tasting it."],
    unsure: ["Am I tasting something?", "Thought I tasted something.", "Something on my tongue… maybe."],
  },
  touch: {
    sure: ["Something brushed my eye.", "Hey, something touched my face.", "Bristles, touched.", "Something poked my eye."],
    unsure: ["Did something brush my eye?", "Felt a touch… I think.", "Something on my face?"],
  },
  cva: {
    sure: ["Smells like another male around here.", "I smell another male.", "Male scent in the air.", "Another guy's been here."],
    unsure: ["Is that another male I smell?", "Smells male… or not.", "Getting a whiff of someone, maybe."],
  },
};

/** A stable pick from a list for a given id (and a salt, so two picks from one post differ). */
export function pick<T>(items: T[], id: number, salt = 0): T {
  let h = (id * 2654435761 + salt * 40503) >>> 0;
  h = (h ^ (h >>> 15)) >>> 0;   // XOR gives a signed int; keep it unsigned or the index can go negative
  return items[h % items.length];
}

export function line(w: string, sure: boolean, id: number): string {
  const set = LINES[w];
  if (!set) return word(w).says;
  return pick(sure ? set.sure : set.unsure, id);
}

/** What the action reader found: a neuron group firing well above rest (worker/actions.py). */
export type Action = { key: string; z: number; side?: string };

const ACTION_LABELS: Record<string, string> = {
  jumped: "jumped",
  backed_up: "backed up",
  walked: "walked forward",
  turned: "turned",
  groomed: "groomed",
  buzzed: "buzzed its wings",
};

export const actionText = (a: Action): string =>
  a.key === "turned" && a.side ? `turned ${a.side}` : ACTION_LABELS[a.key] ?? a.key.replace(/_/g, " ");

/** The strongest actions first (the worker stores them that way), at most `n`. */
export const strongest = (actions: Action[] | undefined, n = 2): Action[] =>
  [...(actions ?? [])].sort((a, b) => b.z - a.z).slice(0, n);

export function joinActions(actions: Action[]): string {
  const parts = actions.map(actionText);
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

export const ordinal = (n: number): string => {
  const s = ["th", "st", "nd", "rd"], v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
};

/** What a holder can drop into a patch. Each is the same stimulus the worker uses for that word. */
export const POKES = [
  { stimulus: "threat", label: "Cast a shadow", done: "a shadow loomed over", hint: "Drives the looming detectors (LC4, LPLC2)." },
  { stimulus: "wind", label: "Blow a gust", done: "a gust of wind", hint: "Drives the antennal wind sensors (Johnston's organ)." },
  { stimulus: "taste", label: "Offer a taste", done: "a taste", hint: "Drives the taste neurons in the mouth." },
  { stimulus: "touch", label: "Brush its face", done: "a brush across the eyes", hint: "Drives the bristles around the eyes." },
  { stimulus: "cva", label: "Waft male scent", done: "a whiff of male scent", hint: "Drives the cVA pheromone receptors (ORN_DA1)." },
  { stimulus: "mate", label: "Send a fly past", done: "a fly walked past", hint: "Drives the moving-target detectors (LC10a)." },
];

/** How close a neighbour's effect was: peak input as a share of a direct stimulus (worker/patch.py). */
const nearness = (strength?: number): string =>
  strength === undefined ? "nearby" : strength >= 0.6 ? "right next to it" : strength >= 0.2 ? "nearby" : "across the patch";

/** What a neighbour did that reached this fly's senses (worker/patch.py channels). */
export function causeText(channel: string, name: string, strength?: number): string {
  switch (channel) {
    case "loom": return `${name} jumping ${nearness(strength)}`;
    case "target": return `${name} moving ${nearness(strength)}`;
    case "sound": return `${name}'s wings buzzing ${nearness(strength)}`;
    case "bump": return `${name} bumping into it`;
    default: return name;
  }
}
