/**
 * Flinder's chat wording. The brains pick what kind of message each fly sends (readout.ts: a flirt, how strong,
 * spooked, grooming or dry); these only put that kind into words, flavoured by the sender's strongest trait.
 */
import { CHAT, TRAITS, type DateEnd, type Ending, type Reply, type Trait, type Traits } from "./readout.ts";

const anyOf = <T>(xs: readonly T[]) => xs[Math.floor(Math.random() * xs.length)];
const best = (t: Traits): Trait => [...TRAITS].sort((a, b) => t[b] - t[a])[0];

const OPENERS: Record<Trait, string[]> = {
  musk: ["u smell like u lift 👀", "is that cVA or are you just happy to see me"],
  moves: ["saw your wing dance. wanna zigzag?", "you + me + one lampshade. circles all night"],
  snack: ["i know a banana that JUST turned 🍌", "dumpster date? my treat"],
  scent: ["you smell like a fresh pupa 🌸", "caught your scent from 3 rooms away hi"],
  song: ["sing me the 150 Hz one again 🎵", "your pulse song lives in my antennae rent free"],
};
const FLIRT: Record<Trait, string[]> = {
  musk: ["been hitting the compost gym 💪", "i smell this good on purpose", "ur pheromones r loud today"],
  moves: ["wanna see my zigzag 🕺", "i'd circle the lamp for you", "my wings do a thing when i see u"],
  snack: ["what's ur fav fruit? mine's whatever ur having", "i saved u half a grape 🍇", "brunch on the windowsill?"],
  scent: ["u smell like a sunday morning 🌸", "can't stop thinking about ur scent", "sniffing the air hoping it's u"],
  song: ["wrote u a little wing song 🎵", "ur voice hits 150 Hz different", "hum for me"],
};
const GENERAL = ["hehe 😳", "ur cute", "stop ur making my antennae twitch", "👉👈", "bzz 💕", "ok ur kinda perfect"];
const STRONG = [
  "ok what's ur address 📍", "I'M FLYING OVER RN 💨", "marry me. i have 30 days to live",
  "i already told my larvae about u", "moving in tonight, i'll bring the banana", "is it too soon to say i love u",
];
const SPOOKED = ["woah. too fast 😳", "ok bye 💨", "*buzzes out the window*", "that's a lot. i'm out", "um. no. 🫥"];
const GROOM = ["brb cleaning my antennae", "sorry was grooming my legs 🦵", "one sec, eye grooming", "hold on, wing dust"];
const DRY = ["k", "lol", "haha", "cool", "ya", "mhm", "👍", "nice", "oh"];
const PLACES = ["the rotten banana", "the dumpster behind the pizza place", "the kitchen lamp", "a wine glass left out overnight", "the fruit bowl", "grandma's jam jar"];
const TIMES = ["8pm", "sunset", "right now", "tomorrow at dawn", "after the lights go off"];

export const opener = (to: Traits) => anyOf([...OPENERS[best(to)], "hey 😳", "your place or the fruit bowl?", "bzz bzz 👉👈"]);

/** Words for a reply of this kind, from a sender with these traits whose pC1 fired `heart` spikes. */
export function say(kind: Reply, from: Traits, heart: number): string {
  if (kind === "flirt") return heart >= CHAT.comeOn ? anyOf(STRONG) : anyOf([...FLIRT[best(from)], ...GENERAL]);
  return anyOf(kind === "spooked" ? SPOOKED : kind === "groom" ? GROOM : DRY);
}

/** How a chat ended, told from the swiper's phone. `last` is who sent the message that ended it. */
export function endLine(end: Ending, last: "me" | "them", name: string): string {
  if (end === "date") return `📍 Date set: ${anyOf(PLACES)}, ${anyOf(TIMES)}`;
  if (end === "texting") return "💬 still texting…";
  if (end === "unmatched") return last === "them" ? `💔 ${name} unmatched you` : `💔 you unmatched ${name}`;
  return last === "them" ? `👻 ${name} ghosted you` : `👻 you ghosted ${name}`;
}

// ---- extras: bots, nerves, voice notes, exes, date night, share card ---------------------------------------
const BOT = {
  flirt: ["u seem cute. click here 🔗 bit.ly/fr33-bl00d", "send 0.1 ETH to unlock my pics 🩸", "r u single? i'm a real fly 100%"],
  spooked: ["error 404 love not found", "account suspended 🚫"],
  groom: ["beep. updating. brb", "🔄 loading…"],
  dry: ["👋", "hi", "k", "click link"],
};
/** A spam mosquito's version of the same reply kinds. */
export const botSay = (kind: Reply) => anyOf(BOT[kind]);

/** The opener when the swiper's brain didn't feel it on a second look (its nerves won). */
export const nervousOpener = () => anyOf(["hey", "hi", "yo", "sup", "hiii 👉👈"]);
export const UNSENT = ["hey so i was thinking maybe we could", "ur literally so", "ok this is weird but", "HI HELLO"];

/** A flirt from a fly with a big song trait sometimes goes out as a voice note. */
export const voiceNote = () => `🎙️ ▶ ${[..."▁▂▃▅▆▇"].sort(() => Math.random() - 0.5).join("")}${[..."▁▃▆▃▁"].join("")} 0:0${2 + Math.floor(Math.random() * 7)} bzzzz`;

/** Seen at a very late hour (under the last message of a ghosting). */
export const seenAt = () => `Seen ✓✓ ${anyOf(["2", "3", "4"])}:${String(Math.floor(Math.random() * 60)).padStart(2, "0")} AM`;

export const EX_OPENERS = ["hey stranger 👀", "u up?", "been thinking about u… and that banana", "new phone who dis. jk hi", "i changed. i clean my legs now"];

export const DATE_END: Record<DateEnd, string[]> = {
  together: ["flew off into the sunset together 💕", "moved in together. behind the fridge", "posting couple pics on Flybook now"],
  bailed: ["one of them bailed through the window 💨", "left mid-date. said the banana was 'mid'", "faked a swatter emergency and flew"],
  groomed: ["groomed each other's antennae for an hour 🧼", "spent the whole date cleaning their legs. romantic?"],
  awkward: ["awkward silence. split the banana 50/50", "talked about the weather for 2 hours", "'let's just be flies'"],
};

/** A title for the share card, from matches per swipe. */
export function rizz(swipes: number, matches: number, dates: number): string {
  if (dates >= 2) return "certified heartbreaker 🔥";
  if (dates === 1) return "has rizz 😎";
  const r = swipes ? matches / swipes : 0;
  return r > 0.25 ? "fruit bowl royalty 👑" : r > 0.1 ? "pupa-level rizz" : matches ? "larva-level rizz 🐛" : "zero rizz. egg. 🥚";
}
