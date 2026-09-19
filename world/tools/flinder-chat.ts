/**
 * Flinder chats, measured on the real connectome: a swiper swipes through random profiles on one brain; each
 * mutual right swipe becomes a chat between the swiper's brain and the match's own brain (readout.ts CHAT).
 * Prints each chat's replies with counts and how chats end, so the CHAT constants can be checked.
 *   node --experimental-strip-types tools/flinder-chat.ts [swipers=6] [cards=20]
 */
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { ConnectomeBrain, cells, parseMeta, parseWeights } from "../src/connectome.ts";
import { TRAITS, carried, chatGroups, ending, groups, runReply, runSwipe, type Ending, type Reply, type Traits } from "../src/flinder/readout.ts";

const dir = "public/connectome";
const unpack = (raw: Buffer) => { const b = raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw) : raw; return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer; };
const parts: string[] = JSON.parse(readFileSync(`${dir}/brain.json`, "utf8")).parts;
const meta = parseMeta(unpack(readFileSync(`${dir}/meta.bin`)));
const w = parseWeights(unpack(Buffer.concat(parts.map((p) => readFileSync(`${dir}/${p}`)))));
const g = groups(meta, cells), cg = chatGroups(meta, cells, g);
const SWIPERS = Number(process.argv[2] ?? 6), CARDS = Number(process.argv[3] ?? 20);
let seed = 777;
const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
const traits = (): Traits => Object.fromEntries(TRAITS.map((k) => [k, rnd()])) as Traits;

const ends: Record<Ending, number> = { date: 0, ghosted: 0, unmatched: 0, texting: 0 };
const kinds: Record<Reply, number> = { flirt: 0, spooked: 0, groom: 0, dry: 0 };
let matches = 0;
for (let s = 0; s < SWIPERS; s++) {
  const me = traits(), mine = new ConnectomeBrain(w, meta.params, 1 + s * 7919);
  for (let c = 0; c < CARDS; c++) {
    const them = traits(), theirSeed = 100000 + s * 1000 + c;
    const a = runSwipe(mine, g, them);
    if (a.choice !== "right") continue;
    const theirs = new ConnectomeBrain(w, meta.params, theirSeed);
    if (runSwipe(theirs, g, me).choice !== "right") continue;
    matches++;
    // the swiper opens with a flirt as strong as its swipe; then they take turns reading each other
    const msgs: Reply[] = ["flirt"];
    let msg = carried("flirt", a.heart), end: Ending | null = null;
    const line: string[] = [`open(${a.heart})`];
    for (let turn = 1; !end; turn++) {
      const reader = turn % 2 ? theirs : mine, sender = turn % 2 ? me : them;
      const r = runReply(reader, cg, sender, msg);
      msgs.push(r.reply); kinds[r.reply]++;
      line.push(`${r.reply}(${r.heart}/${r.gf}/${r.groom})`);
      msg = carried(r.reply, r.heart);
      end = ending(msgs);
    }
    ends[end]++;
    console.log(`swiper ${s + 1} card ${c + 1}: ${end.padEnd(9)} ${line.join(" ")}`);
  }
}
console.log(`${matches} matches · endings ${JSON.stringify(ends)} · replies ${JSON.stringify(kinds)}`);
