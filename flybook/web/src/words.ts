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

export function joinActions(actions: Action[]): string {
  const parts = actions.map(actionText);
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** What a holder can drop into a patch. Each is the same stimulus the worker uses for that word. */
export const POKES = [
  { stimulus: "threat", label: "Cast a shadow", done: "a shadow loomed over", hint: "Drives the looming detectors (LC4, LPLC2)." },
  { stimulus: "wind", label: "Blow a gust", done: "a gust of wind", hint: "Drives the antennal wind sensors (Johnston's organ)." },
  { stimulus: "taste", label: "Offer a taste", done: "a taste", hint: "Drives the taste neurons in the mouth." },
  { stimulus: "touch", label: "Brush its face", done: "a brush across the eyes", hint: "Drives the bristles around the eyes." },
  { stimulus: "cva", label: "Waft male scent", done: "a whiff of male scent", hint: "Drives the cVA pheromone receptors (ORN_DA1)." },
  { stimulus: "mate", label: "Send a fly past", done: "a fly walked past", hint: "Drives the moving-target detectors (LC10a)." },
];

/** What a neighbour did that reached this fly's senses (worker/patch.py channels). */
export function causeText(channel: string, name: string): string {
  switch (channel) {
    case "loom": return `${name} jumping nearby`;
    case "target": return `${name} moving nearby`;
    case "sound": return `${name}'s wings buzzing nearby`;
    case "bump": return `${name} bumping into it`;
    default: return name;
  }
}
