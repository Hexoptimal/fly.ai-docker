/**
 * Fly Roulette's bet games, played on the server: the float connectome (world/src/connectome.ts, the same
 * engine and the same turn code as the page, world/src/roulette/readout.ts) and the rules in
 * world/src/roulette/game.ts. Live games share this thread one turn at a time, in turn order, so every table
 * keeps moving. A game restarted after a server restart replays from its seeds to the same events.
 *
 * in:  {type: "start", game, serverSeed, clientSeed, flies}
 * out: {type: "ready"} · {type: "event", game, seq, event} · {type: "error", game, text}
 */
import { parentPort, workerData } from "node:worker_threads";
import { ConnectomeBrain, cells } from "../../world/src/connectome.ts";
import { deriveRng, playGame, setup } from "../../world/src/roulette/game.ts";
import { groups, runTurn } from "../../world/src/roulette/readout.ts";
import { loadModel } from "./load.ts";

const port = parentPort!;
const model = loadModel(workerData.dir as string);
const g = groups(model.meta, cells);
port.postMessage({ type: "ready" });

// one turn at a time across all live games, first come first served
const waiting: (() => void)[] = [];
let busy = false;
function next(): void {
  const go = waiting.shift();
  if (!go) { busy = false; return; }
  busy = true;
  go();                                   // the game's turn runs in the microtasks after this
  setImmediate(next);
}
const slot = () => new Promise<void>((resolve) => {
  waiting.push(resolve);
  if (!busy) { busy = true; setImmediate(next); }
});

async function play(game: string, serverSeed: string, clientSeed: string, flies: number): Promise<void> {
  const rng = await deriveRng(serverSeed, clientSeed);
  const table = setup(flies, rng);
  const brains: ConnectomeBrain[] = [];
  const brainOf = (i: number) => (brains[i] ??= new ConnectomeBrain(model.w, model.meta.params, table.seeds[i]));
  let seq = 0;
  for await (const event of playGame(table, rng, async (i, chamber) => {
    await slot();
    return runTurn(brainOf(i), g, chamber);
  })) {
    port.postMessage({ type: "event", game, seq: seq++, event });
  }
}

port.on("message", (msg: { type: "start"; game: string; serverSeed: string; clientSeed: string; flies: number }) => {
  if (msg.type !== "start") return;
  play(msg.game, msg.serverSeed, msg.clientSeed, msg.flies)
    .catch((err) => port.postMessage({ type: "error", game: msg.game, text: String(err) }));
});
