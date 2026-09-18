/**
 * /jobs: buy compute. A buyer picks an experiment (a preset sweep), how many repeats and how fast (the price per run),
 * and gets one sentence with the size and the most it can cost. Everything the API takes is under Advanced settings,
 * and the presets just fill those fields in. The order is funded with one $FLYAI transfer of its exact budget (the
 * server reads it from the chain) or from the wallet's balance. Orders, progress, results and a Stop button are listed
 * for the signed-in wallet (account.ts), which spends the balance and stops orders without another signature. A
 * payment sent before a reload is remembered in this browser, so the order still gets funded.
 */
import { API } from "./config.ts";
import { errorText, mined, mountAccount, onAccount, requireWallet, sessionHeaders, sessionLost, transact } from "./account.ts";
import { api } from "./mine-core.ts";
import { shortAddress } from "./wallet.ts";
interface Config {
  open: boolean; pay_to: string | null; token: string; transfer_selector: string;
  min_bid: string; cached_price: string; pool_share: number; max_jobs: number; max_parallel: number; max_hours: number; redundancy: number;
  market: { live_orders: number; top_bid: string | null; median_bid: string | null };
  channels: string[]; steps: number; dt: number | null;
  chain_id: number; chain_name: string; rpc: string; explorer: string; token_symbol: string;
  /** card buyers: USDC on Base, credited in $FLYAI at the live price */
  usdc: { chain_id: number; chain_name: string; rpc: string; explorer: string; token: string; decimals: number; pay_to: string; gasless: boolean; onramp_url: string | null; card: boolean; card_min_usd?: number } | null;
  embed?: { models: Record<string, { dim: number; about: string }>; max_texts: number; max_text_chars: number };
}
interface Order {
  id: string; wallet: string; status: "unpaid" | "expired" | "live" | "done" | "ended"; end_reason: string | null;
  jobs: number; taken_on: number; out: number; settled: number; bid: string; budget: string; budget_wei: string; spent: string; returned: string | null;
  hours: number | null; created_at: number; ends_at: number | null; tx: string | null; webhook_secret?: string | null; order_key?: string | null; kind?: string;
  usdc_payment?: { tx: string; usdc: string; flyai: string; explorer: string } | null;
  guest?: boolean; card?: { state: "open" | "paid" | "failed"; usdc: string; reason: string | null } | null;
  webhook: { url: string; delivered_seq: number; done: boolean; failures: number; error: string | null } | null;
  spec: { channels: string[]; sides: string[]; amounts: number[]; gains: number[]; tonics: number[]; seeds: number[]; warm: number };
}

/** What each sense is, in words (world/src/eyes.ts, world/src/wiring.ts). */
const SENSES: Record<string, string> = {
  LPLC2: "looming", LC4: "fast looming", LPLC1: "small approaching object", LC10a: "target up close", SNta: "leg touch", none: "nothing (control)",
};

const STRENGTHS = [0.1, 0.2, 0.4, 0.8];
const PRESETS = [
  { id: "escape", name: "Escape", text: "Something big rushes at the fly. Does the giant-fiber escape fire, and how fast does it build with the threat?", channels: ["LPLC2", "LC4", "none"] },
  { id: "collision", name: "Collision", text: "A small object on a collision course. Which way does the fly try to turn?", channels: ["LPLC1", "none"] },
  { id: "chase", name: "Chase", text: "A target up close, the view courtship chasing starts from. What do the legs and head do?", channels: ["LC10a", "none"] },
  { id: "touch", name: "Touch", text: "Its legs touch something. Which reflexes kick in, on which side?", channels: ["SNta", "none"] },
  { id: "everything", name: "Full map", text: "Every sense, on both sides, at four strengths. The whole sensory-to-motor map in one order.", channels: ["LPLC2", "LC4", "LPLC1", "LC10a", "SNta", "none"] },
  { id: "custom", name: "Custom", text: "Set the senses, strengths and brain settings yourself under Advanced settings.", channels: null },
] as const;
const REPEATS = [{ n: 3, name: "Quick" }, { n: 10, name: "Solid" }, { n: 30, name: "Thorough" }];
const MODES = [
  { key: "brain", title: "Brain experiment", small: "ready-made: pick what the fly senses" },
  { key: "program", title: "Your own program", small: "WebAssembly or a GPU shader: anything" },
  { key: "embed", title: "Embeddings", small: "text in, vectors out, on miners' GPUs" },
];
/** "Your own program": the uploads so far */
const upload = { program: null as null | { hash: string; kind: "wasm" | "wgsl"; name: string }, inputs: [] as string[] };
/** "Embeddings": the text batches uploaded so far, one job each */
const embedUpload = { inputs: [] as string[], texts: 0 };
const isEmbed = () => pressed("modes") === "embed";
// embeddings are priced like any program job: by their time limit (60 s)
const isProgram = () => pressed("modes") === "program" || isEmbed();
const timeoutS = () => (isEmbed() ? 60 : Number(input("timeout").value || 60));
const SPEEDS = [{ x: 1, name: "Normal" }, { x: 2, name: "Faster" }, { x: 5, name: "Fastest" }];

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const input = (id: string) => $<HTMLInputElement>(id);
const PENDING = "flyai-compute-pending-payment";
let config: Config;
let account: string | null = null;
let spec: object | null = null;
let balance = 0;
/** what the whole experiment costs at the current price, from the last quote */
let fullCost = 0;

const fmt = (tokens: string | number) => `${Number(tokens).toLocaleString("en-US", { maximumFractionDigits: 4 })} $${config.token_symbol}`;
const count = (n: number) => n.toLocaleString("en-US");
const numbers = (id: string) => input(id).value.split(",").map((x) => x.trim()).filter(Boolean).map(Number);
const store = {
  get: (): { order: string; tx: string; chain?: "base" } | null => {
    try { return JSON.parse(localStorage.getItem(PENDING) ?? "null"); } catch { return null; }
  },
  set: (v: { order: string; tx: string; chain?: "base" } | null) => {
    try { v ? localStorage.setItem(PENDING, JSON.stringify(v)) : localStorage.removeItem(PENDING); } catch { /* private window */ }
  },
};

// ---- choices ------------------------------------------------------------------------------------------------
function choiceButtons(host: string, items: { key: string; title: string; text?: string; small?: string }[], pick: (key: string) => void): void {
  $(host).replaceChildren(...items.map((it) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "choice";
    b.dataset.key = it.key;
    b.setAttribute("aria-pressed", "false");
    const title = document.createElement("b");
    title.textContent = it.title;
    b.append(title);
    if (it.text) b.append(it.text);
    if (it.small) {
      const s = document.createElement("small");
      s.textContent = it.small;
      b.append(s);
    }
    b.addEventListener("click", () => pick(it.key));
    return b;
  }));
}

function press(host: string, key: string | null): void {
  for (const b of $(host).querySelectorAll<HTMLButtonElement>(".choice")) b.setAttribute("aria-pressed", String(b.dataset.key === key));
}

const pressed = (host: string) => $(host).querySelector<HTMLButtonElement>('.choice[aria-pressed="true"]')?.dataset.key ?? null;

function pickPreset(id: string): void {
  const preset = PRESETS.find((p) => p.id === id)!;
  press("presets", id);
  if (preset.channels) {
    for (const box of document.querySelectorAll<HTMLInputElement>("input[name=channel]")) box.checked = (preset.channels as readonly string[]).includes(box.value);
    for (const box of document.querySelectorAll<HTMLInputElement>("input[name=side]")) box.checked = true;
    input("amounts").value = STRENGTHS.join(", ");
    input("gains").value = "3";
    input("tonics").value = "0.14";
    input("warm").value = "250";
  } else {
    (document.querySelector("details.advanced") as HTMLDetailsElement).open = true;
  }
  changed();
}

function pickRepeats(n: string): void {
  press("repeats", n);
  input("seeds").value = n;
  changed();
}

function pickSpeed(x: string): void {
  press("speeds", x);
  const min = isProgram() ? Number(config.min_bid) * Math.ceil(timeoutS() / 30) : Number(config.min_bid);
  input("bid").value = String(min * Number(x));
  changed();
}

// ---- pricing ------------------------------------------------------------------------------------------------
function readSpec() {
  const checked = (name: string) => [...document.querySelectorAll<HTMLInputElement>(`input[name=${name}]:checked`)].map((i) => i.value);
  return {
    kind: "connectome-sweep",
    channels: checked("channel"),
    sides: checked("side"),
    amounts: numbers("amounts"),
    gains: numbers("gains"),
    tonics: numbers("tonics"),
    seeds: Number(input("seeds").value),
    warm: Number(input("warm").value),
  };
}

async function uploadFile(file: Blob): Promise<string> {
  const res = await fetch(`${API}/api/blobs`, { method: "POST", body: file });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `upload failed: HTTP ${res.status}`);
  return data.hash;
}

function programSpec() {
  if (isEmbed()) {
    return { kind: "embed", model: $<HTMLSelectElement>("embed-model").value, inputs: embedUpload.inputs, redundancy: Number($<HTMLSelectElement>("embed-redundancy").value) };
  }
  const p = upload.program!;
  const byFiles = pressed("input-modes") === "files";
  const tolerance = input("tolerance").value.trim();
  return {
    kind: p.kind, program: p.hash,
    ...(byFiles ? { inputs: upload.inputs } : { count: Number(input("count").value) }),
    timeout_s: Number(input("timeout").value), redundancy: Number($<HTMLSelectElement>("redundancy").value), keep_open: input("keep-open").checked,
    ...(p.kind === "wgsl" ? {
      dispatch: [Number(input("dispatch-x").value), Number(input("dispatch-y").value), Number(input("dispatch-z").value)],
      output_bytes: Number(input("output-bytes").value),
      compare: tolerance ? { f32_tolerance: Number(tolerance) } : "exact",
    } : {}),
  };
}

/**
 * Texts from a file: a JSON array of strings, JSON lines (a string or {"text": ...} per line), or plain text with one
 * text per line. Blank lines are skipped.
 */
function parseTexts(name: string, body: string): string[] {
  const clean = (xs: unknown[]) => xs.map((x) => (typeof x === "string" ? x : typeof (x as { text?: unknown })?.text === "string" ? (x as { text: string }).text : "")).map((t) => t.trim()).filter(Boolean);
  let texts: string[];
  if (/\.json$/i.test(name)) {
    const data = JSON.parse(body);
    if (!Array.isArray(data)) throw new Error("a .json file should be an array of texts");
    texts = clean(data);
  } else if (/\.jsonl$/i.test(name)) {
    texts = clean(body.split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l)));
  } else {
    texts = clean(body.split(/\r?\n/));
  }
  if (!texts.length) throw new Error("no texts found in that file");
  return texts;
}

/** Speed choices show this mode's price: a program's lowest price grows with its time limit. */
function speedLabels(): void {
  const min = isProgram() ? Number(config.min_bid) * Math.ceil(timeoutS() / 30) : Number(config.min_bid);
  for (const b of $("speeds").querySelectorAll<HTMLButtonElement>(".choice")) {
    b.querySelector("small")!.textContent = `${fmt(min * Number(b.dataset.key))} per ${isProgram() ? "job" : "run"}`;
  }
}

function setMode(key: string): void {
  press("modes", key);
  const program = key === "program" || key === "embed";
  $("headline").textContent = key === "embed" ? "Embed your texts on the network" : program ? "Run your own code on the network" : "Run an experiment on the fly brain";
  $("lede").textContent = key === "embed"
    ? "Upload texts and get back one vector per text, for search, clustering or RAG. Miners' GPUs run the model, and two of them must agree on every vector. You pay in $FLYAI only for batches that finish."
    : program
    ? "Upload a WebAssembly program or a GPU shader and as many inputs as you like. Miners run it in their browsers, sandboxed, and send back the outputs. You pay in $FLYAI only for jobs that finish, and most of it goes straight to the miners who ran them."
    : $("lede").dataset.brain!;
  $("speed-card").style.gridColumn = program ? "1 / -1" : "";
  speedLabels();
  $("brain-card").hidden = program;
  $("repeats-card").hidden = program;
  $("program-card").hidden = key !== "program";
  $("embed-card").hidden = key !== "embed";
  $("brain-advanced").hidden = program;
  changed();
}

/** What the order is sent with; an empty budget means the whole experiment. */
const terms = () => ({
  bid: input("bid").value.trim(),
  budget: input("budget").value.trim() || String(fullCost),
  hours: input("hours").value.trim(),
  max_parallel: input("parallel").value.trim(),
  webhook: input("webhook").value.trim(),
});

function setButtons(): void {
  const ready = !!spec && config.open && fullCost > 0 && !!input("bid").value.trim();
  $<HTMLButtonElement>("buy").disabled = !ready;
  $<HTMLButtonElement>("buy-usdc").disabled = !ready;
  $("buy-usdc").hidden = !config.usdc?.card;
  const useBalance = $<HTMLButtonElement>("use-balance");
  useBalance.hidden = !account || balance <= 0;
  useBalance.disabled = !ready || balance < Number(terms().budget);
}

let timer: ReturnType<typeof setTimeout> | undefined;
function changed(): void {
  clearTimeout(timer);
  timer = setTimeout(() => void requote(), 250);
}

let quoting = 0;
async function requote(): Promise<void> {
  const n = ++quoting;
  try {
    if (isEmbed()) {
      if (!embedUpload.inputs.length) throw new Error("Upload a text file to see the price.");
      const speed = Number(pressed("speeds") ?? 0);
      if (speed) input("bid").value = String(Number(config.min_bid) * Math.ceil(timeoutS() / 30) * speed);
      const q = await api(API, "/api/orders/quote", null, { spec: programSpec(), bid: input("bid").value.trim() || undefined });
      if (n !== quoting) return;
      spec = programSpec();
      fullCost = Number(q.full_cost);
      const budget = input("budget").value.trim();
      $("summary").innerHTML = [
        `<b>${count(embedUpload.texts)} texts</b> in ${count(q.jobs)} batches with ${$<HTMLSelectElement>("embed-model").value}, at ${fmt(q.bid)} a batch.`,
        budget && Number(budget) < fullCost ? `It stops after spending <b>${fmt(budget)}</b>.` : `It costs at most <b>${fmt(q.full_cost)}</b>, and ${fmt(q.full_to_pool)} goes straight to the miners who run it.`,
      ].join(" ") + dollars(fullCost);
      $("note").textContent = "";
      setButtons();
      return;
    }
    if (isProgram()) {
      if (!upload.program) throw new Error("Upload a program to see the price.");
      if (pressed("input-modes") === "files" && !upload.inputs.length && !input("keep-open").checked) throw new Error("Upload input files, or pick a number of jobs.");
      // a program's lowest price grows with its time limit; the speed choice multiplies it
      const speed = Number(pressed("speeds") ?? 0);
      const min = Number(config.min_bid) * Math.ceil(timeoutS() / 30);
      if (speed) input("bid").value = String(min * speed);
      const q = await api(API, "/api/orders/quote", null, { spec: programSpec(), bid: input("bid").value.trim() || undefined });
      if (n !== quoting) return;
      spec = programSpec();
      fullCost = Number(q.full_cost);
      const budget = input("budget").value.trim();
      $("summary").innerHTML = [
        `<b>${count(q.jobs)} jobs</b> of your ${upload.program.kind === "wasm" ? "WebAssembly program" : "GPU shader"} at ${fmt(q.bid)} each (the lowest is ${fmt(q.min_bid)} for a ${input("timeout").value} s limit).`,
        budget && Number(budget) < fullCost ? `It stops after spending <b>${fmt(budget)}</b>.` : `It costs at most <b>${fmt(q.full_cost)}</b>, and ${fmt(q.full_to_pool)} goes straight to the miners who run it.`,
        input("keep-open").checked ? "It stays open for more jobs from code until the budget, a time limit or Stop." : "",
      ].filter(Boolean).join(" ") + dollars(fullCost);
      $("note").textContent = "";
      setButtons();
      return;
    }
    const wanted = readSpec();
    const q = await api(API, "/api/orders/quote", null, { spec: wanted, bid: input("bid").value.trim() || undefined });
    if (n !== quoting) return;
    spec = q.spec;
    fullCost = Number(q.full_cost);
    const perRepeat = q.jobs / (q.spec.seeds.length || 1);
    const preset = PRESETS.find((p) => p.id === pressed("presets"));
    const name = preset && preset.id !== "custom" ? preset.name : "your experiment";
    const budget = input("budget").value.trim();
    const hours = input("hours").value.trim();
    const parts = [
      `<b>${count(q.jobs)} runs</b> of ${name} (${count(perRepeat)} conditions × ${count(q.spec.seeds.length)} repeats) at ${fmt(q.bid)} each.`,
      budget && Number(budget) < fullCost
        ? `It stops after spending <b>${fmt(budget)}</b> of the ${fmt(q.full_cost)} the whole experiment would cost.`
        : `The whole experiment costs at most <b>${fmt(q.full_cost)}</b>, and ${fmt(q.full_to_pool)} of it goes to miners.`,
      q.cached ? `${count(q.cached)} of the runs are already done, so they're cheaper and ready at once.` : "",
      hours ? `It stops after ${hours} hours if it isn't done.` : "",
    ];
    // numbers and names here come from the server's normalized spec or our own constants
    $("summary").innerHTML = parts.filter(Boolean).join(" ") + dollars(fullCost);
    $("note").textContent = "";
  } catch (err) {
    if (n !== quoting) return;
    spec = null;
    fullCost = 0;
    $("summary").textContent = "—";
    $("note").textContent = errorText(err);
  }
  setButtons();
}

// ---- wallet and paying --------------------------------------------------------------------------------------
async function rpc(method: string, params: unknown[]): Promise<any> {
  const res = await fetch(config.rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const body = await res.json();
  if (body.error) throw new Error(body.error.message ?? "RPC error");
  return body.result;
}

const word = (v: bigint | string) => (typeof v === "string" ? v.replace(/^0x/, "").toLowerCase().padStart(64, "0") : v.toString(16).padStart(64, "0"));

/** Hand the transaction to the server until the chain it reads has it too. */
async function confirmPayment(order: string, tx: string, chain?: "base"): Promise<Order> {
  for (let i = 0; ; i++) {
    try {
      const o = await api(API, `/api/orders/${order}/pay`, null, { tx, chain });
      store.set(null);
      return o;
    } catch (err) {
      const status = (err as { status?: number }).status;
      if ((status !== 409 && status !== 502) || i >= 40 || /already/.test(String(err))) throw err;
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

/** Spending the balance or stopping an order, as the signed-in wallet. */
async function signed(order: string, action: "fund" | "stop"): Promise<Order> {
  try {
    return await api(API, `/api/orders/${order}/${action}`, null, {}, sessionHeaders());
  } catch (err) {
    if (sessionLost(err)) throw new Error("your sign-in expired: sign in again, then retry");
    throw err;
  }
}

const started = (o: Order) =>
  o.status === "done" ? "Done ✓ Your results are below." : o.status === "ended" ? `Ended (${o.end_reason}).` : "Running ✓ Miners are on it; results fill in below.";

async function order(method: "flyai" | "card" | "balance", tab: Window | null = null): Promise<void> {
  const buttons = [$<HTMLButtonElement>("buy"), $<HTMLButtonElement>("buy-usdc"), $<HTMLButtonElement>("use-balance")];
  buttons.forEach((b) => { b.disabled = true; });
  $("tx").removeAttribute("data-standing");
  const say = (text: string) => { delete $("tx").dataset.standing; $("tx").textContent = text; };
  try {
    // paying by card needs no wallet at all: the order is a guest's, kept in this browser
    if (method !== "card") {
      account = await requireWallet();
      if (!account) return;
    }
    if (!spec) throw new Error("pick what to run first");
    const t = terms();
    const created: Order = await api(API, "/api/orders", null, {
      ...(method === "card" ? { guest: true } : { wallet: account }),
      spec, bid: t.bid, budget: t.budget, hours: t.hours || undefined, max_parallel: t.max_parallel || undefined,
      webhook: t.webhook || undefined,
    });
    if (created.webhook_secret) {
      $("secret-value").textContent = created.webhook_secret;
      $("secret").hidden = false;
    }
    if (created.order_key && method !== "card") {
      $("key-value").textContent = created.order_key;
      $("key").hidden = false;
    }
    let result: Order;
    if (method === "balance") {
      result = await signed(created.id, "fund");
    } else if (method === "card") {
      cardOrders.add(created.id, created.order_key ?? null);
      void listOrders();
      result = await payByCard(created.id, tab, say);
    } else {
      const amount = BigInt(created.budget_wei);
      const held = BigInt(await rpc("eth_call", [{ to: config.token, data: `0x70a08231${word(account!)}` }, "latest"]));
      if (held < amount) throw new Error(`this wallet holds ${fmt(Number(held / 10n ** 14n) / 10_000)}; the order needs ${fmt(created.budget)}`);
      const tx = await transact(config.token, config.transfer_selector + word(config.pay_to!) + word(amount), (text) => {
        $("tx").textContent = `Pay ${fmt(created.budget)}: ${text}`;
      });
      store.set({ order: created.id, tx });
      $("tx").textContent = "Payment sent, waiting for the chain…";
      await mined(tx).catch(() => {}); // the server's own read of the chain decides
      result = await confirmPayment(created.id, tx);
    }
    $("tx").dataset.standing = "ok";
    $("tx").textContent = method === "card" ? `Paid ✓ ${started(result)} Your order is saved in this browser, under Your orders.` : started(result);
  } catch (err) {
    tab?.close();
    $("tx").dataset.standing = "zeroed";
    $("tx").textContent = errorText(err);
  } finally {
    await listOrders().catch(() => {});
    setButtons();
  }
}

// ---- USDC (card buyers) --------------------------------------------------------------------------------------
let flyaiUsd = 0;
const usd = (n: number) => (n >= 1 ? `$${n.toFixed(2)}` : `$${n.toPrecision(2)}`);
/** " (about $X)" after a $FLYAI amount, once the price is known */
const dollars = (tokens: number) => (flyaiUsd && tokens ? ` That's about <b>${usd(tokens * flyaiUsd)}</b>${config.usdc?.card ? ", and you can pay by card" : ""}.` : "");

/** Card orders made in this browser (a guest has no wallet to list them by), newest first, with their keys. */
const CARD_ORDERS = "flyai-compute-card-orders";
const cardOrders = {
  all(): { id: string; key: string | null }[] {
    try { return JSON.parse(localStorage.getItem(CARD_ORDERS) ?? "[]"); } catch { return []; }
  },
  add(id: string, key: string | null): void {
    const list = cardOrders.all();
    const known = list.find((g) => g.id === id);
    const next = [{ id, key: key ?? known?.key ?? null }, ...list.filter((g) => g.id !== id)].slice(0, 50);
    try { localStorage.setItem(CARD_ORDERS, JSON.stringify(next)); } catch { /* private window: this visit only */ }
  },
};

/**
 * Pay for an order by card: a secure Coinbase checkout (in `tab`, opened during the click so it isn't blocked), then
 * wait for the server to see the payment. No wallet or signature.
 */
async function payByCard(orderId: string, tab: Window | null, say: (text: string) => void): Promise<Order> {
  say("Opening the secure checkout…");
  const c = await api(API, `/api/orders/${orderId}/card`, null, {});
  if (!tab) {
    location.href = c.url; // pop-ups blocked: go to the checkout; it brings the buyer back to this order
    return new Promise(() => {});
  }
  tab.location.href = c.url;
  say(`Pay $${c.usdc} in the checkout tab, by card or Apple Pay. This page continues by itself when the payment arrives.`);
  return waitForCard(orderId, say);
}

/** Checks the order's card payment every 5 seconds (the server asks Coinbase) until it starts or fails. */
async function waitForCard(orderId: string, say: (text: string) => void): Promise<Order> {
  for (let i = 0; i < 2160; i++) {
    const o: Order | null = await api(API, `/api/orders/${orderId}/card`, null).catch(() => null);
    if (o) {
      if (o.status !== "unpaid" && o.status !== "expired") return o;
      if (o.card?.state === "failed") throw new Error(`The card payment didn't go through${o.card.reason ? ` (${o.card.reason})` : ""}. You can try again.`);
      if (i === 36) say("Still waiting for the payment. It can take a few minutes after you pay; you can leave this page open or come back later.");
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error("No payment has arrived yet. If you paid, your order still starts: check back on this page.");
}

/** An order someone made from code, waiting to be paid: one button, the exact transfer, then it starts. */
async function showPayCard(id: string): Promise<void> {
  const card = $("pay-card");
  const status = $("pay-status");
  const button = $<HTMLButtonElement>("pay-btn");
  let o: Order;
  try {
    o = await api(API, `/api/orders/${id}`, null);
  } catch (err) {
    card.hidden = false;
    $("pay-text").textContent = `Couldn't find order ${id}: ${errorText(err)}`;
    button.hidden = true;
    return;
  }
  card.hidden = false;
  card.scrollIntoView({ block: "start" });
  $("pay-title").textContent = `Pay ${fmt(o.budget)}`;
  $("pay-text").textContent = `For order ${o.id}: ${describe(o)}. Pay by card, or with $FLYAI from ${shortAddress(o.wallet)}, the wallet it was made for.`;
  const usdcButton = $<HTMLButtonElement>("pay-usdc");
  const paid = () => {
    button.hidden = true;
    usdcButton.hidden = true;
    status.dataset.standing = "ok";
    status.textContent = `Paid ✓ ${started(o)} You can go back to the program that made the order.`;
  };
  if (o.status !== "unpaid" && o.status !== "expired") return paid();
  /** signed in as the order's wallet, or an error saying how to get there */
  const orderWallet = async () => {
    const wallet = await requireWallet();
    if (wallet && wallet.toLowerCase() !== o.wallet.toLowerCase()) throw new Error(`you're signed in as ${shortAddress(wallet)}, but this order is for ${shortAddress(o.wallet)}: sign out and in with that wallet`);
    return wallet;
  };
  if (config.usdc?.card) {
    usdcButton.hidden = false;
    usdcButton.addEventListener("click", () => {
      const tab = window.open("about:blank", "_blank");
      void (async () => {
        usdcButton.disabled = true;
        try {
          cardOrders.add(o.id, null);
          o = await payByCard(o.id, tab, (text) => { delete status.dataset.standing; status.textContent = text; });
          paid();
          await listOrders().catch(() => {});
        } catch (err) {
          tab?.close();
          status.dataset.standing = "zeroed";
          status.textContent = errorText(err);
        } finally {
          usdcButton.disabled = false;
        }
      })();
    });
  }
  button.addEventListener("click", () => void (async () => {
    button.disabled = true;
    delete status.dataset.standing;
    try {
      const wallet = await orderWallet();
      if (!wallet) return;
      const amount = BigInt(o.budget_wei);
      const held = BigInt(await rpc("eth_call", [{ to: config.token, data: `0x70a08231${word(wallet)}` }, "latest"]));
      if (held < amount) throw new Error(`this wallet holds ${fmt(Number(held / 10n ** 14n) / 10_000)}; the order needs ${fmt(o.budget)}`);
      const tx = await transact(config.token, config.transfer_selector + word(config.pay_to!) + word(amount), (text) => { status.textContent = text; });
      store.set({ order: o.id, tx });
      status.textContent = "Payment sent, waiting for the chain…";
      o = await confirmPayment(o.id, tx);
      paid();
      await listOrders().catch(() => {});
    } catch (err) {
      status.dataset.standing = "zeroed";
      status.textContent = errorText(err);
    } finally {
      button.disabled = false;
    }
  })());
}

// ---- orders -------------------------------------------------------------------------------------------------
function describe(o: Order): string {
  const s = o.spec;
  if (o.kind === "wasm" || o.kind === "wgsl") return `your ${o.kind === "wasm" ? "WebAssembly program" : "GPU shader"}`;
  if (o.kind === "embed") return `embeddings with ${(s as unknown as { program: string }).program}`;
  const senses = s.channels.map((c) => SENSES[c] ?? c).join(", ");
  return `${senses} · ${s.seeds.length} repeat${s.seeds.length === 1 ? "" : "s"}`;
}

const link = (href: string, text: string, className = "") => {
  const a = document.createElement("a");
  a.href = href;
  a.target = "_blank";
  a.rel = "noopener";
  a.textContent = text;
  if (className) a.className = className;
  return a;
};

let polling: ReturnType<typeof setTimeout> | null = null;
async function listOrders(): Promise<void> {
  if (polling) clearTimeout(polling);
  const local = cardOrders.all();
  const [mine, cards] = await Promise.all([
    account ? api(API, `/api/orders?wallet=${account}`, null) as Promise<{ balance: string; orders: Order[] }> : Promise.resolve(null),
    Promise.all(local.map((g) => api(API, `/api/orders/${g.id}`, null).catch(() => null) as Promise<Order | null>)),
  ]);
  if (mine) {
    balance = Number(mine.balance);
    $("balance-row").hidden = balance <= 0;
    $("balance").textContent = fmt(mine.balance);
  } else {
    balance = 0;
    $("balance-row").hidden = true;
  }
  setButtons();
  const keys = new Map(local.map((g) => [g.id, g.key]));
  const byId = new Map<string, Order>();
  for (const o of [...(mine?.orders ?? []), ...cards.filter((o): o is Order => !!o)]) byId.set(o.id, o);
  const shown = [...byId.values()]
    .filter((o) => (o.status !== "expired" && o.status !== "unpaid") || o.card?.state === "open")
    .sort((a, b) => b.created_at - a.created_at);
  const list = $("orders");
  if (!shown.length) {
    list.innerHTML = `<p class="caption">${account ? "No orders from this wallet yet." : "Orders you pay for show up here."}</p>`;
    return;
  }
  list.replaceChildren(...shown.map((o) => {
    const row = document.createElement("div");
    row.className = "item";
    row.innerHTML = `<div><b class="what"></b><div class="meta"></div></div><div class="amount"></div><div class="state"></div>`;
    (row.querySelector(".what") as HTMLElement).textContent = `${count(o.settled)} of ${count(o.jobs)} runs done`;
    (row.querySelector(".meta") as HTMLElement).textContent = `${new Date(o.created_at).toLocaleString()} · ${describe(o)} · ${fmt(o.bid)} per run · order ${o.id}`;
    // a card order in dollars: the share of what was paid that the runs have used
    const paidUsd = o.card?.state === "paid" ? Number(o.card.usdc) : 0;
    (row.querySelector(".amount") as HTMLElement).textContent = paidUsd
      ? `$${(paidUsd * Number(o.spent) / Math.max(Number(o.budget), 1e-18)).toFixed(2)} of $${paidUsd.toFixed(2)} used`
      : `${fmt(o.spent)} of ${fmt(o.budget)}`;
    const state = row.querySelector(".state") as HTMLElement;
    const status = document.createElement("span");
    status.dataset.standing = o.status === "live" ? "unchecked" : o.status === "done" ? "ok" : "";
    status.textContent = o.status === "unpaid" || o.status === "expired"
      ? "waiting for the card payment"
      : o.status === "live"
      ? `running · ${o.out} with miners now${o.ends_at ? ` · stops ${new Date(o.ends_at).toLocaleString()}` : ""}`
      : `${o.status === "done" ? "done ✓" : `ended: ${o.end_reason === "budget" ? "budget spent" : o.end_reason === "time" ? "time's up" : "stopped"}`}${o.returned && Number(o.returned) > 0 ? ` · ${fmt(o.returned)} back to balance` : ""}`;
    state.append(status);
    if (o.settled) {
      const partial = o.status === "live" ? " so far" : "";
      state.append(link(`${API}/api/orders/${o.id}/results?format=csv`, `CSV${partial}`, "btn sm"), link(`${API}/api/orders/${o.id}/results`, `JSON${partial}`, "btn sm"));
    }
    if (o.status === "live" && (!o.guest || keys.get(o.id))) {
      const stop = document.createElement("button");
      stop.type = "button";
      stop.className = "btn sm";
      stop.textContent = "Stop";
      stop.addEventListener("click", () => void (async () => {
        if (!confirm("Stop this order? Runs with miners now are dropped, and what it hasn't spent goes back to your balance.")) return;
        stop.disabled = true;
        try {
          if (o.guest) {
            const res = await fetch(`${API}/api/orders/${o.id}/stop`, { method: "POST", headers: { authorization: `Bearer ${keys.get(o.id)}` } });
            if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
          } else {
            await signed(o.id, "stop");
          }
          $("tx").dataset.standing = "ok";
          $("tx").textContent = "Stopped ✓";
        } catch (err) {
          $("tx").dataset.standing = "zeroed";
          $("tx").textContent = errorText(err);
        }
        await listOrders().catch(() => {});
      })());
      state.append(stop);
    }
    if (o.webhook) {
      const hook = document.createElement("span");
      hook.textContent = o.webhook.error ? `webhook failing (${o.webhook.error}), retrying` : o.webhook.done ? "webhook delivered ✓" : "webhook on";
      hook.dataset.standing = o.webhook.error ? "zeroed" : "";
      state.append(hook);
    }
    if (o.tx) state.append(link(`${config.explorer}/tx/${o.tx}`, "payment"));
    if (o.card?.state === "paid") state.append(Object.assign(document.createElement("span"), { textContent: `paid $${o.card.usdc} by card` }));
    else if (o.usdc_payment) state.append(link(`${o.usdc_payment.explorer}/tx/${o.usdc_payment.tx}`, `paid ${o.usdc_payment.usdc} USDC`));
    if (o.guest) state.append(link(`${location.pathname}?order=${o.id}`, "link to this order"));
    return row;
  }));
  if (shown.some((o) => o.status === "live" || o.card?.state === "open")) polling = setTimeout(() => void listOrders().catch(() => {}), 15_000);
}

// ---- boot ---------------------------------------------------------------------------------------------------
async function boot(): Promise<void> {
  config = await api(API, "/api/orders/config", null);
  $("channels").replaceChildren(...config.channels.map((c) => {
    const label = document.createElement("label");
    label.className = "chip";
    label.innerHTML = `<input type="checkbox" name="channel"> <span></span>`;
    label.querySelector("input")!.value = c;
    (label.querySelector("span") as HTMLElement).textContent = c === "none" ? SENSES.none : `${c} · ${SENSES[c] ?? ""}`;
    return label;
  }));
  const perRun = (x: number) => fmt(Number(config.min_bid) * x);
  choiceButtons("presets", PRESETS.map((p) => ({ key: p.id, title: p.name, text: p.text, small: p.channels ? p.channels.filter((c) => c !== "none").join(" · ") : undefined })), pickPreset);
  choiceButtons("repeats", REPEATS.map((r) => ({ key: String(r.n), title: r.name, small: `${r.n} repeats` })), pickRepeats);
  choiceButtons("speeds", SPEEDS.map((s) => ({ key: String(s.x), title: s.name, small: `${perRun(s.x)} per run` })), pickSpeed);

  input("warm").max = String(config.steps - 1);
  input("parallel").max = String(config.max_parallel);
  input("parallel").placeholder = `up to ${config.max_parallel}`;
  input("hours").max = String(config.max_hours);
  if (config.dt) $("job-length").textContent = `${(config.steps * config.dt).toFixed(0)} simulated seconds`;
  const share = `${Math.round(config.pool_share * 100)}%`;
  $("pool-share").textContent = share;
  $("h-pool").textContent = share;
  $("h-cached").textContent = fmt(config.cached_price);
  $("h-redundancy").textContent = String(config.redundancy);
  const m = config.market;
  $("market").textContent = m.live_orders
    ? `${m.live_orders} other order${m.live_orders === 1 ? " is" : "s are"} running now, paying up to ${fmt(m.top_bid!)} per run.`
    : "No other orders are running, so Normal gets the whole network.";
  if (!config.open) $("note").textContent = "Paid orders aren't open yet.";

  // editing the raw fields un-picks the choice they came from
  const advanced = document.querySelector("details.advanced")!;
  advanced.addEventListener("input", (e) => {
    const id = (e.target as HTMLElement).id;
    const name = (e.target as HTMLInputElement).name;
    if (id === "seeds") press("repeats", REPEATS.some((r) => String(r.n) === input("seeds").value) ? input("seeds").value : null);
    else if (id === "bid") press("speeds", null);
    else if (["amounts", "gains", "tonics", "warm"].includes(id) || name === "channel" || name === "side") press("presets", "custom");
    changed();
  });
  mountAccount();
  onAccount((wallet) => {
    account = wallet;
    $("account").textContent = wallet ? shortAddress(wallet) : "not signed in";
    $("account").title = wallet ?? "";
    $("connect").textContent = wallet ? "Refresh" : "Sign in";
    // signed in or not, the list shows this browser's card orders too
    void listOrders().catch((err) => { $("note").textContent = errorText(err); });
  });
  $("connect").addEventListener("click", () => void (account ? listOrders() : requireWallet()).catch((err) => { $("note").textContent = errorText(err); }));
  $("buy").addEventListener("click", () => void order("flyai"));
  $("buy-usdc").addEventListener("click", () => {
    // open the checkout tab during the click, or the browser blocks it
    const tab = window.open("about:blank", "_blank");
    void order("card", tab);
  });
  if (config.usdc) void api(API, "/api/price", null).then((p) => { flyaiUsd = p.flyai_usd; changed(); }, () => {});
  $("key-copy").addEventListener("click", () => void navigator.clipboard.writeText($("key-value").textContent ?? "").then(() => { $("key-copy").textContent = "Copied"; }));

  // your own program
  choiceButtons("modes", MODES.map((m) => ({ key: m.key, title: m.title, small: m.small })), setMode);
  choiceButtons("input-modes", [
    { key: "count", title: "A number of jobs", small: "each gets its job number" },
    { key: "files", title: "Input files", small: "one job per file" },
  ], (key) => {
    press("input-modes", key);
    $("count-field").hidden = key !== "count";
    $("files-field").hidden = key !== "files";
    changed();
  });
  press("input-modes", "count");
  // embeddings: the models the server offers, and a text file split into batches (one job each)
  $<HTMLSelectElement>("embed-model").replaceChildren(...Object.entries(config.embed?.models ?? {}).map(([id, m]) => new Option(`${id}: ${m.about}`, id)));
  let embedRun = 0;
  const embedFile = async () => {
    const file = input("embed-file").files?.[0];
    if (!file) return;
    // a newer file or batch size replaces an upload still running
    const run = ++embedRun;
    embedUpload.inputs = [];
    embedUpload.texts = 0;
    const inputs: string[] = [];
    try {
      const texts = parseTexts(file.name, await file.text());
      const size = Number($<HTMLSelectElement>("embed-batch").value);
      const limit = config.embed?.max_text_chars ?? 8000;
      for (let i = 0; i < texts.length; i += size) {
        $("embed-status").textContent = `uploading batch ${i / size + 1} of ${Math.ceil(texts.length / size)}…`;
        const batch = texts.slice(i, i + size).map((t) => t.slice(0, limit));
        inputs.push(await uploadFile(new Blob([JSON.stringify(batch)], { type: "application/json" })));
        if (run !== embedRun) return;
      }
      embedUpload.inputs = inputs;
      embedUpload.texts = texts.length;
      $("embed-status").textContent = `${file.name} · ${count(texts.length)} texts in ${count(embedUpload.inputs.length)} batches${texts.some((t) => t.length > limit) ? ` · texts over ${count(limit)} characters were cut` : ""}`;
    } catch (err) {
      if (run !== embedRun) return;
      embedUpload.inputs = [];
      $("embed-status").textContent = errorText(err);
    }
    changed();
  };
  input("embed-file").addEventListener("change", () => void embedFile());
  $("embed-batch").addEventListener("change", () => void embedFile());
  for (const id of ["embed-model", "embed-redundancy"]) $(id).addEventListener("change", changed);
  input("program-file").addEventListener("change", () => void (async () => {
    const file = input("program-file").files?.[0];
    if (!file) return;
    const kind = file.name.toLowerCase().endsWith(".wgsl") ? "wgsl" : "wasm";
    $("program-status").textContent = `uploading ${file.name}…`;
    try {
      upload.program = { hash: await uploadFile(file), kind, name: file.name };
      $("program-status").textContent = `${file.name} · ${kind === "wasm" ? "WebAssembly" : "WGSL shader"} · ${Math.ceil(file.size / 1024)} KB · checked when you order`;
      $("gpu-fields").hidden = kind !== "wgsl";
    } catch (err) {
      upload.program = null;
      $("program-status").textContent = errorText(err);
    }
    changed();
  })());
  input("input-files").addEventListener("change", () => void (async () => {
    const files = [...(input("input-files").files ?? [])];
    upload.inputs = [];
    try {
      for (const [i, f] of files.entries()) {
        $("inputs-status").textContent = `uploading ${i + 1} of ${files.length}…`;
        upload.inputs.push(await uploadFile(f));
      }
      $("inputs-status").textContent = `${files.length} input${files.length === 1 ? "" : "s"} uploaded`;
    } catch (err) {
      $("inputs-status").textContent = errorText(err);
    }
    changed();
  })());
  $("lede").dataset.brain = $("lede").textContent ?? "";
  input("timeout").addEventListener("input", speedLabels);
  for (const id of ["count", "timeout", "redundancy", "dispatch-x", "dispatch-y", "dispatch-z", "output-bytes", "tolerance", "keep-open"]) $(id).addEventListener("input", changed);
  $("secret-copy").addEventListener("click", () => void navigator.clipboard.writeText($("secret-value").textContent ?? "").then(() => { $("secret-copy").textContent = "Copied"; }));
  $("use-balance").addEventListener("click", () => void order("balance"));

  press("modes", "brain");
  pickPreset("escape");
  pickRepeats("10");
  pickSpeed("1");

  // /compute/jobs?order=<id>: back from the card checkout, or a saved link to a card order
  const saved = new URLSearchParams(location.search).get("order");
  if (saved && /^[0-9a-f-]{36}$/.test(saved)) {
    cardOrders.add(saved, null);
    $("orders").scrollIntoView({ block: "start" });
    void api(API, `/api/orders/${saved}/card`, null).then((o: Order) => {
      if (o.card?.state !== "open" || (o.status !== "unpaid" && o.status !== "expired")) return;
      const say = (text: string) => { delete $("tx").dataset.standing; $("tx").textContent = text; };
      say("Checking your card payment…");
      return waitForCard(saved, say).then((paidOrder) => { $("tx").dataset.standing = "ok"; $("tx").textContent = `Paid ✓ ${started(paidOrder)}`; });
    }).catch((err) => { $("tx").dataset.standing = "zeroed"; $("tx").textContent = errorText(err); }).finally(() => void listOrders().catch(() => {}));
  }

  // /compute/jobs?pay=<order id>: an order made elsewhere (a script, the btc-pool setup), paid here with the wallet
  const payFor = new URLSearchParams(location.search).get("pay");
  if (payFor && /^[0-9a-f-]{36}$/.test(payFor)) void showPayCard(payFor);

  // a payment sent before a reload
  const pending = store.get();
  if (pending) {
    $("tx").textContent = "Finishing a payment sent earlier…";
    confirmPayment(pending.order, pending.tx, pending.chain).then(
      (o) => { $("tx").dataset.standing = "ok"; $("tx").textContent = `Earlier payment confirmed. ${started(o)}`; },
      (err) => { store.set(null); $("tx").dataset.standing = "zeroed"; $("tx").textContent = `An earlier payment couldn't be matched: ${errorText(err)}`; },
    );
  }
}

void boot();
