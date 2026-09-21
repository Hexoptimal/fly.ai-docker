/**
 * Flinder's dating profiles: a name, a colour, a brain seed and the five traits (readout.ts) the swiper's brain
 * senses (plus a rival's smell on some). The bio, job, flags and prompts are only words; they decide nothing.
 * The names stay as they are; the words are in the page's language (flinder.profile.* in i18n/).
 */
import { anyOfT, listOf, t } from "./i18n.ts";
import { TRAITS, type Trait, type Traits } from "./readout.ts";

export interface Profile {
  id: number;
  name: string;
  age: number;          // days
  cm: number;           // how far away
  job: string;
  bio: string;
  color: string;
  seed: number;         // its own brain, for when it judges the swiper back
  traits: Traits;
  red: string[];         // 🚩 bio jokes
  green: string[];
  prompt: [string, string];
  rival: boolean;       // smells of another fly's cVA (readout.ts sensed)
  bot: boolean;         // a spam mosquito
}

const NAMES = [
  "Buzz Aldrin", "Fly Guy", "Jeff Goldblum", "Wingston", "Drosophilia", "Maggot Robbie", "Hover Wilson",
  "Zzzach", "Beelzebub", "Sir Swats-a-lot", "Lord of the Flies", "Fruity Pebbles", "Bananya", "Compound Iris",
  "Proboscis Paul", "Thorax Tom", "Six Legs Sally", "Larva Lamar", "Pupa Pam", "Halteres Harry", "Buzzlightyear",
  "Mothman's Cousin", "Flynn Rider", "Flyoncé", "Fly-Z", "Bugs Bunny", "Gnatalie", "Swattney Spears", "Flo Rida",
  "Wingrid", "Ommatidia Olivia", "Vinnie Vinegar", "Rotten Rita", "Peachy Pete", "Mango Mo", "Flyson Chandler",
  "Buzzanne", "Antenna Anna", "Chad Chitin", "Fly Diddy", "Ms. Frizzle Fly", "Flyrah Fawcett", "Zzzendaya",
];
const COLORS = ["#e0342c", "#3d8bff", "#ffc83d", "#3ddc84", "#c46bff", "#ff8a1f", "#ff6fb5", "#6cc4d8", "#a0e05a", "#f5f5f5"];
const BOT_NAMES = ["Hot Mosquito 🩸", "Mosquito_Bae_69", "Crypto Mosquito", "Real Fly (not a mosquito)"];

/** The trait chips' labels, in the page's language. */
export const traitLabel = (k: Trait) => t(`flinder.traits.${k}`);

let nextId = 1;
const pick = <T>(xs: readonly T[]) => xs[Math.floor(Math.random() * xs.length)];
const randomTraits = () => Object.fromEntries(TRAITS.map((k) => [k, Math.round(Math.random() * 100) / 100])) as Traits;

/** The bio talks about its two strongest traits and shrugs about its weakest. */
function bioOf(traits: Traits): string {
  const order = [...TRAITS].sort((a, b) => traits[b] - traits[a]);
  const line = (k: Trait, strong: boolean) => anyOfT(`profile.lines.${k}.${strong ? "high" : "low"}`);
  return [line(order[0], true), traits[order[1]] > 0.5 ? line(order[1], true) : "", line(order[4], false)].filter(Boolean).join(" · ");
}

export function randomProfile(avoid: string[] = []): Profile {
  // now and then a spam mosquito: its traits (all the brain sees) are as random as anyone's
  const bot = Math.random() < 1 / 12;
  let name = bot ? pick(BOT_NAMES) : pick(NAMES);
  while (avoid.includes(name)) name = bot ? pick(BOT_NAMES) : pick(NAMES);
  const traits = randomTraits();
  const reds = listOf("profile.red").sort(() => Math.random() - 0.5).slice(0, Math.random() < 0.6 ? 1 : 0);
  const q = Math.floor(Math.random() * listOf("profile.prompts").length);
  return {
    id: nextId++, name,
    bio: bot ? anyOfT("profile.botBios") : bioOf(traits),
    age: 1 + Math.floor(Math.random() * 40),
    cm: 1 + Math.floor(Math.random() * 90),
    job: bot ? t("flinder.profile.botJob") : anyOfT("profile.jobs"),
    color: bot ? "#9aa0a6" : pick(COLORS),
    seed: 1 + Math.floor(Math.random() * 2 ** 30),
    traits,
    red: bot ? [t("flinder.profile.botRed")] : reds,
    green: bot || Math.random() < 0.5 ? [] : [anyOfT("profile.green")],
    prompt: bot ? [t("flinder.profile.botPromptQ"), t("flinder.profile.botPromptA")] : [t(`flinder.profile.prompts.${q}.q`), anyOfT(`profile.prompts.${q}.a`)],
    rival: !bot && Math.random() < 0.15,
    bot,
  };
}

// ---- a fly you can send to a friend ------------------------------------------------------------------------
/** The swiper as a link: same name, colour, brain seed and traits, so a friend's page runs the same fly. */
export function flyToHash(p: Profile): string {
  const t = TRAITS.map((k) => Math.round(p.traits[k] * 100)).join(".");
  return `fly=${encodeURIComponent(p.name)}~${p.color.slice(1)}~${p.seed}~${p.age}~${t}`;
}
export function flyFromHash(hash: string): Profile | null {
  const m = /fly=([^&]+)/.exec(hash);
  if (!m) return null;
  const [name, color, seed, age, t] = decodeURIComponent(m[1]).split("~");
  const vals = (t ?? "").split(".").map(Number);
  if (!name || !/^[0-9a-f]{6}$/i.test(color ?? "") || !(Number(seed) > 0) || vals.length !== 5 || vals.some((v) => !(v >= 0 && v <= 100))) return null;
  const p = randomProfile();
  const traits = Object.fromEntries(TRAITS.map((k, i) => [k, vals[i] / 100])) as Traits;
  return { ...p, name: name.slice(0, 30), color: `#${color}`, seed: Number(seed), age: Math.max(1, Math.min(40, Number(age) || 1)), traits,
    bio: bioOf(traits), rival: false, bot: false, red: [], green: [] };
}
