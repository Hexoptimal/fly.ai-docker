/**
 * The miner page: shows this machine and runs web/mine-core.ts's Miner on the GPU or CPU threads.
 * The miner token lives in localStorage; losing it just means registering again.
 */
import { API, CONNECTOME } from "./config.ts";
import { api, ApiError, Miner, probeGpu } from "./mine-core.ts";
import { linkWallet, shortAddress } from "./wallet.ts";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const TOKEN_KEY = "flymine.token";
const LABEL_KEY = "flymine.label";
const ENGINE_KEY = "flymine.engine";
const store = {
  get(k: string): string | null {
    try { return localStorage.getItem(k); } catch { return null; }
  },
  set(k: string, v: string | null): void {
    try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* private window */ }
  },
};

const cores = Math.max(1, navigator.hardwareConcurrency || 2);
const memoryGb: number | undefined = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;

// ---- mining ------------------------------------------------------------------------------------------
let lanes: { bar: HTMLElement; text: HTMLElement }[] = [];

const miner = new Miner({
  server: API,
  connectome: CONNECTOME,
  getToken: () => store.get(TOKEN_KEY),
  setToken: (t) => store.set(TOKEN_KEY, t),
  label: () => $<HTMLInputElement>("label").value.trim(),
  status: (text) => { $("status").textContent = text; },
  lanes: (names) => {
    const rows = names.map((name) => {
      const row = document.createElement("div");
      row.className = "lane";
      row.innerHTML = `<span class="name"></span><div class="bar"><div></div></div><span class="text">starting</span>`;
      (row.querySelector(".name") as HTMLElement).textContent = name;
      return row;
    });
    $("slots").replaceChildren(...rows);
    lanes = rows.map((row) => ({ bar: row.querySelector(".bar > div") as HTMLElement, text: row.querySelector(".text") as HTMLElement }));
  },
  lane: (i, text, progress) => {
    const lane = lanes[i];
    if (!lane) return;
    if (text) lane.text.textContent = text;
    if (progress !== undefined) lane.bar.style.width = `${100 * progress}%`;
  },
  job: (text) => { $("job").textContent = text; },
  session: (s) => {
    $("session").textContent = `${s.jobs} jobs · ${s.units.toFixed(1)} units · ${s.perMinute.toFixed(1)} jobs/min`;
  },
});

async function toggle(): Promise<void> {
  const button = $<HTMLButtonElement>("toggle");
  if (miner.running) {
    miner.stop();
    button.textContent = "Start mining";
    return;
  }
  const engine = $<HTMLSelectElement>("engine").value as "gpu" | "cpu";
  store.set(LABEL_KEY, $<HTMLInputElement>("label").value.trim());
  store.set(ENGINE_KEY, engine);
  button.textContent = "Stop";
  refresh();
  await miner.start({
    engine, batch: Number($<HTMLSelectElement>("batch").value), threads: Number($<HTMLSelectElement>("threads").value),
    programs: $<HTMLInputElement>("programs").checked,
  });
  if (!miner.running) button.textContent = "Start mining";
}

// ---- numbers -----------------------------------------------------------------------------------------
const STANDING: Record<string, string> = {
  ok: "credited",
  unchecked: "waiting for first checks",
  zeroed: "a wrong answer zeroed today",
  "no jobs yet": "no jobs yet today",
};

async function refresh(): Promise<void> {
  try {
    const s = await api(API, "/api/stats", null);
    $("fleet").textContent = `${s.miners_online} online · ${s.jobs_today} jobs today · ${s.tasks_done} of ${s.tasks} screen jobs done`;
  } catch { /* server away; keep the old numbers */ }
  const token = store.get(TOKEN_KEY);
  if (!token) return;
  try {
    const me = await api(API, "/api/me", token);
    showWallet(me.wallet);
    $("stake").textContent = me.stake
      ? `${Number(me.stake.staked).toLocaleString("en-US")} FLYAI · ${me.stake.tier ?? "no tier"} · ${me.stake.multiplier}× points today${me.stake.tomorrow ? ` (${me.stake.tomorrow.multiplier}× from tomorrow)` : ""}`
      : me.wallet ? "staking isn't live yet: 1× points" : "link a wallet first";
    $("month").textContent = me.wallet
      ? [
        `${me.month_points.toFixed(1)} points · ${(me.month_share * 100).toFixed(2)}%`,
        me.month_rank ? `#${me.month_rank} of ${me.month_wallets}` : null,
        me.month_estimate !== null ? `≈ ${Math.round(me.month_estimate).toLocaleString("en-US")} $FLYAI at this share` : null,
        `ends in ${me.month_days_left} day${me.month_days_left === 1 ? "" : "s"}`,
      ].filter(Boolean).join(" · ")
      : `${me.month_points.toFixed(1)} points: link a wallet to claim them`;
    $("today-jobs").textContent = String(me.jobs);
    $("today-checked").textContent = String(me.checked);
    $("today-units").textContent = me.credited.toFixed(1);
    $("today-share").textContent = `${(me.share * 100).toFixed(1)}%`;
    $("today-standing").textContent = STANDING[me.standing] ?? me.standing;
    $("today-standing").dataset.standing = me.standing;
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) store.set(TOKEN_KEY, null);
  }
}

// ---- wallet ------------------------------------------------------------------------------------------
function showWallet(wallet: string | null): void {
  $("wallet").textContent = wallet ? `${shortAddress(wallet)} ✓` : "not linked: credit can't be paid";
  $("wallet").title = wallet ?? "";
  $("connect-wallet").textContent = wallet ? "Change" : "Connect";
}

async function connectWallet(): Promise<void> {
  const button = $<HTMLButtonElement>("connect-wallet");
  button.disabled = true;
  try {
    let token = store.get(TOKEN_KEY);
    if (!token) {
      token = (await api(API, "/api/register", null, { label: $<HTMLInputElement>("label").value.trim() })).token as string;
      store.set(TOKEN_KEY, token);
    }
    showWallet(await linkWallet(API, { token }, (text) => { $("wallet").textContent = text; }));
  } catch (err) {
    $("wallet").textContent = err instanceof Error ? err.message : String(err);
  } finally {
    button.disabled = false;
  }
}

// ---- boot --------------------------------------------------------------------------------------------
function showEngine(): void {
  const gpu = $<HTMLSelectElement>("engine").value === "gpu";
  $("batch-field").hidden = !gpu;
  $("threads-field").hidden = gpu;
  // Chrome on Windows ignores WebGPU's powerPreference and runs on the GPU its graphics process started on
  $("gpu-hint").hidden = !(gpu && /Windows/.test(navigator.userAgent));
  $("runs-on").textContent = gpu
    ? "the GPU, a batch of jobs at once (~4 MB of GPU memory per job, plus 125 MB for the wiring)"
    : "CPU threads, one connectome copy each (~200 MB memory per thread)";
}

const threads = $<HTMLSelectElement>("threads");
const maxThreads = Math.min(4, Math.max(1, cores - 1));
for (let i = 1; i <= maxThreads; i++) threads.add(new Option(String(i), String(i), i === 1, i === 1));
$<HTMLInputElement>("label").value = store.get(LABEL_KEY) ?? "";
$("cpu").textContent = `${cores} threads${memoryGb ? ` · ${memoryGb}+ GB memory` : ""}`;
probeGpu().then((probe) => {
  $("gpu").textContent = probe.usable ? `${probe.name} (WebGPU)` : `can't mine on the GPU: ${probe.reason}`;
  const engine = $<HTMLSelectElement>("engine");
  if (probe.usable) engine.add(new Option("GPU", "gpu"), 0);
  engine.value = probe.usable && store.get(ENGINE_KEY) !== "cpu" ? "gpu" : "cpu";
  showEngine();
});
$("engine").addEventListener("change", showEngine);
$("toggle").addEventListener("click", () => { void toggle(); });
$("connect-wallet").addEventListener("click", () => { void connectWallet(); });
refresh();
setInterval(refresh, 20_000);
