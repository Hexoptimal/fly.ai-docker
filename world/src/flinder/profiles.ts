/**
 * Flinder's dating profiles: a name, a colour, a brain seed and the five traits (readout.ts) the swiper's brain
 * senses (plus a rival's smell on some). The bio, job, flags and prompts are only words; they decide nothing.
 */
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
const JOBS = [
  "fruit bowl inspector", "professional window bumper", "CEO of the compost", "wedding crasher (picnics)",
  "lamp orbit specialist", "banana ripeness consultant", "full-time buzzing", "soup taster (uninvited)",
  "trash can influencer", "windshield survivor", "lab fly, 40 years of genetics", "ceiling walker",
];
const LINES: Record<Trait, [string[], string[]]> = {
  musk: [["no cologne, just vibes", "smells like nothing, like a gentlefly"],
    ["gym fly. you can smell it 💪", "drenched in cVA and proud", "alpha pheromones only"]],
  moves: [["i mostly sit on the wall", "not a dancer, sorry"],
    ["my wing dance is illegal in 3 kitchens", "i will chase you around the fruit bowl 🕺", "zigzags so smooth"]],
  snack: [["already ate", "on a juice cleanse"],
    ["first date at the dumpster, my treat 🍌", "i know where the good vinegar is", "brunch? i AM the brunch"]],
  scent: [["unscented", "natural chitin musk"],
    ["smell me from 3 rooms away 🌸", "yes this is my natural pheromone", "fresh out of the pupa, smelling divine"]],
  song: [["no singing, i'm shy", "tone deaf honestly"],
    ["i'll serenade you with my left wing 🎵", "pulse song? sine song? both.", "wrote you a 150 Hz love song"]],
};

const RED = [
  "lives in a trash can", "has 400 siblings", "will die in 30 days", "still lives with its maggots", "lands on poop first, then food",
  "vomits on food to eat it", "hasn't showered since pupa", "thinks the window is open", "has a fruit bowl in every kitchen",
  "ex is a spider", "only texts at 3 am", "can't stop rubbing its hands",
];
const GREEN = ["never bites", "cleans its legs a lot", "5,000 eyes, all on you", "remembers your fruit order", "will share the banana"];
const PROMPTS: [string, string[]][] = [
  ["My toxic trait", ["landing on your food", "buzzing in your ear at 3 am", "i'll never find the open window", "i can smell a banana from 2 rooms"]],
  ["Green flag", ["i don't bite (much)", "i always come back to the lamp", "i clean my face 40 times a day"]],
  ["Perfect first date", ["dumpster behind the pizza place", "circling the kitchen lamp", "a wine glass left out overnight", "your picnic, uninvited"]],
  ["Biggest fear", ["rolled-up newspaper", "the swatter", "fly paper. don't ask", "car windshields"]],
  ["Looking for", ["someone to share compost with", "a fly who'll stay past day 30", "my fruit bowl soulmate", "vibes and vinegar"]],
];
const BOT_NAMES = ["Hot Mosquito 🩸", "Mosquito_Bae_69", "Crypto Mosquito", "Real Fly (not a mosquito)"];
const BOT_BIOS = ["hot singles in your area 🩸", "click the link in my bio to verify 🔗", "send 0.1 ETH and i'll swipe right", "not a bot. definitely a fly. beep"];

export const TRAIT_LABEL: Record<Trait, string> = { musk: "💪 Musk", moves: "🕺 Moves", snack: "🍌 Snacks", scent: "🌸 Scent", song: "🎵 Song" };

let nextId = 1;
const pick = <T>(xs: readonly T[]) => xs[Math.floor(Math.random() * xs.length)];
const randomTraits = () => Object.fromEntries(TRAITS.map((k) => [k, Math.round(Math.random() * 100) / 100])) as Traits;

/** The bio talks about its two strongest traits and shrugs about its weakest. */
function bioOf(traits: Traits): string {
  const order = [...TRAITS].sort((a, b) => traits[b] - traits[a]);
  return [pick(LINES[order[0]][1]), traits[order[1]] > 0.5 ? pick(LINES[order[1]][1]) : "", pick(LINES[order[4]][0])].filter(Boolean).join(" · ");
}

export function randomProfile(avoid: string[] = []): Profile {
  // now and then a spam mosquito: its traits (all the brain sees) are as random as anyone's
  const bot = Math.random() < 1 / 12;
  let name = bot ? pick(BOT_NAMES) : pick(NAMES);
  while (avoid.includes(name)) name = bot ? pick(BOT_NAMES) : pick(NAMES);
  const traits = randomTraits();
  const reds = [...RED].sort(() => Math.random() - 0.5).slice(0, Math.random() < 0.6 ? 1 : 0);
  const [q, answers] = pick(PROMPTS);
  return {
    id: nextId++, name,
    bio: bot ? pick(BOT_BIOS) : bioOf(traits),
    age: 1 + Math.floor(Math.random() * 40),
    cm: 1 + Math.floor(Math.random() * 90),
    job: bot ? "🩸 influencer" : pick(JOBS),
    color: bot ? "#9aa0a6" : pick(COLORS),
    seed: 1 + Math.floor(Math.random() * 2 ** 30),
    traits,
    red: bot ? ["is a mosquito"] : reds,
    green: bot || Math.random() < 0.5 ? [] : [pick(GREEN)],
    prompt: bot ? ["Looking for", "blood. i mean love"] : [q, pick(answers)],
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
