/**
 * Copy our house orders' results from the mining server into local files, picking up where the last pull stopped.
 *
 *   node mine/scripts/pull-house.ts [--server https://flyai-mine.fly.dev] [--out mine/data/house] [--label tuning/]
 *
 * For each house order, <out>/<label>/<order id>/ gets:
 *   order.json      the order: spec, status, progress
 *   results.jsonl   one settled row per line, in settle order (appended; `next` in cursor.json)
 *   outputs/        program outputs by seq: world runs as <seq>.json, probes as <seq>.u16 (+ layout.json), others .bin
 * Brain sweeps have no outputs: their rows hold the spike counts.
 *
 * Probe layout: a probe output is u16 counts, bins x neurons, over the record sets in order. layout.json lists each
 * set's neurons (connectome index, cell type, side) from the local connectome files, which match the miners' ones.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const SERVER = arg("server", process.env.SERVER ?? "https://flyai-mine.fly.dev");
const OUT = arg("out", fileURLToPath(new URL("../data/house/", import.meta.url)));
const LABEL = arg("label", "");
const CONNECTOME = fileURLToPath(new URL("../../world/public/connectome/", import.meta.url));

const get = async (path: string) => {
  const res = await fetch(SERVER + path);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res;
};

let layouts: Map<string, unknown> | null = null;
async function probeLayout(record: string[]): Promise<unknown> {
  layouts ??= new Map();
  const key = record.join(",");
  if (!layouts.has(key)) {
    const { loadModel } = await import("../src/load.ts");
    const { recordSets } = await import("../src/probe.ts");
    const model = loadModel(CONNECTOME);
    const side = ["", "L", "R"];
    layouts.set(key, {
      format: "u16 little-endian, bins x neurons, record sets in order",
      sets: recordSets(model, record as ("descending" | "wing")[]).map((set, i) => ({
        name: record[i],
        neurons: Array.from(set, (n) => ({ index: n, type: model.meta.types[model.meta.typeIdx[n]], side: side[model.meta.side[n]] })),
      })),
    });
  }
  return layouts.get(key);
}

const { orders } = await (await get("/api/house")).json() as { orders: { id: string; label: string; kind: string; status: string; settled: number }[] };
let total = 0;
for (const summary of orders) {
  if (LABEL && !summary.label.startsWith(LABEL)) continue;
  const dir = join(OUT, summary.label, summary.id);
  mkdirSync(join(dir, "outputs"), { recursive: true });
  const order = await (await get(`/api/orders/${summary.id}`)).json();
  writeFileSync(join(dir, "order.json"), JSON.stringify(order, null, 2));
  const cursorFile = join(dir, "cursor.json");
  let after = existsSync(cursorFile) ? JSON.parse(readFileSync(cursorFile, "utf8")).next : 0;
  let rows = 0;
  for (;;) {
    const page = await (await get(`/api/orders/${summary.id}/results?after=${after}&limit=5000`)).json();
    for (const row of page.rows) {
      appendFileSync(join(dir, "results.jsonl"), `${JSON.stringify(row)}\n`);
      if (row.output?.url) {
        const ext = order.kind === "world" ? "json" : order.kind === "probe" ? "u16" : "bin";
        const file = join(dir, "outputs", `${row.seq}.${ext}`);
        if (!existsSync(file)) writeFileSync(file, Buffer.from(await (await get(row.output.url)).arrayBuffer()));
      }
      rows++;
    }
    after = page.next;
    writeFileSync(cursorFile, JSON.stringify({ next: after }));
    if (!page.more || !page.rows.length) break;
  }
  if (order.kind === "probe" && !existsSync(join(dir, "outputs", "layout.json"))) {
    writeFileSync(join(dir, "outputs", "layout.json"), JSON.stringify(await probeLayout(order.spec.params.record)));
  }
  total += rows;
  console.log(`${summary.label} ${summary.id.slice(0, 8)}: ${summary.status}, +${rows} rows (${summary.settled} settled)`);
}
console.log(`pulled ${total} new rows into ${OUT}`);
