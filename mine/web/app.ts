/**
 * The miner page: shows this machine and runs web/mine-core.ts's Miner on the GPU or CPU threads.
 * The miner token lives in localStorage; losing it just means registering again.
 */
import { API, CONNECTOME } from "./config.ts";
import { api, ApiError, Miner, probeGpu } from "./mine-core.ts";
import { isPhone, mountAccount, onAccount, requireWallet, sessionHeaders, sessionLost, signedIn } from "./account.ts";
import { shortAddress } from "./wallet.ts";

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
    $("session").textContent = `${s.jobs} jobs · ${s.units.toFixed(1)} units · ${s.unitsPerMinute.toFixed(1)} units/min`;
  },
});

async function toggle(): Promise<void> {
  const button = $<HTMLButtonElement>("toggle");
  if (miner.running) {
    miner.stop();
    void keepAwake(false);
    button.textContent = "Start mining";
    return;
  }
  const engine = $<HTMLSelectElement>("engine").value as "gpu" | "cpu";
  store.set(LABEL_KEY, $<HTMLInputElement>("label").value.trim());
  store.set(ENGINE_KEY, engine);
  button.textContent = "Stop";
  refresh();
  void keepAwake(true);
  await miner.start({
    engine, batch: Number($<HTMLSelectElement>("batch").value), threads: Number($<HTMLSelectElement>("threads").value),
    programs: $<HTMLInputElement>("programs").checked,
  });
  if (!miner.running) {
    button.textContent = "Start mining";
    void keepAwake(false);
  }
}

// ---- phones ------------------------------------------------------------------------------------------
// A phone pauses a tab that's in the background or behind a locked screen, and mining pauses with it. While
// mining, the screen is kept on (Screen Wake Lock); the browser drops the lock when the tab is hidden, so
// it's taken again on return. Jobs held while paused go back out on their own (JOB_TTL on the server).
let wakeLock: WakeLockSentinel | null = null;
async function keepAwake(on: boolean): Promise<void> {
  if (!on) {
    await wakeLock?.release().catch(() => {});
    wakeLock = null;
    return;
  }
  if (wakeLock && !wakeLock.released) return;
  try {
    wakeLock = await navigator.wakeLock?.request("screen") ?? null;
  } catch { /* refused (battery saver, or not on screen right now) */ }
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && miner.running) void keepAwake(true);
});

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
    meLoaded = true;
    showWallet(me.wallet);
    // signed in on this site and the miner has no wallet yet: it takes the signed-in one, no questions
    if (!me.wallet && signedIn()) void linkMiner();
    $("stake").textContent = me.stake
      ? `${Number(me.stake.staked).toLocaleString("en-US")} FLYAI · ${me.stake.tier ?? "no tier"} · ${me.stake.multiplier}× points today${me.stake.tomorrow ? ` (${me.stake.tomorrow.multiplier}× from tomorrow)` : ""}`
      : me.wallet ? "staking isn't live yet: 1× points" : "link a wallet first";
    const days = `ends in ${me.month_days_left} day${me.month_days_left === 1 ? "" : "s"}`;
    $("month").textContent = me.wallet
      ? [
        `${me.month_points.toFixed(1)} points · ${(me.month_share * 100).toFixed(2)}%`,
        me.month_rank ? `#${me.month_rank} of ${me.month_wallets}` : null,
        days,
      ].filter(Boolean).join(" · ")
      : `${me.month_points.toFixed(1)} points · ${days} · link a wallet to keep them`;
    // what those points are worth at today's pool: an estimate that moves as everyone mines
    const pool = me.month_announced_pool;
    $("share-estimate").textContent = pool === null
      ? "the month's pool isn't announced yet"
      : [
        `≈ ${Math.round(me.month_estimate).toLocaleString("en-US")} $FLYAI`,
        `${(me.month_estimate_share * 100).toFixed(2)}% of a ${Number(pool).toLocaleString("en-US")} pool`,
        Number(me.month_program_pay) > 0 ? `incl. ${Math.round(Number(me.month_program_pay)).toLocaleString("en-US")} already earned from buyers` : null,
        me.wallet ? null : "if you link a wallet",
      ].filter(Boolean).join(" · ");
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
let linked: string | null = null;
let meLoaded = false;
function showWallet(wallet: string | null): void {
  linked = wallet;
  const me = signedIn();
  $("wallet").textContent = wallet ? `${shortAddress(wallet)} ✓` : "not linked: credit can't be paid";
  $("wallet").title = wallet ?? "";
  // the button offers what would change: sign in, or move this miner to the signed-in wallet
  $("connect-wallet").hidden = !!wallet && wallet === me;
  $("connect-wallet").textContent = !me ? "Sign in" : wallet ? `Use ${shortAddress(me)}` : "Link";
}

/** Link this browser's miner to the signed-in wallet (signing in first if needed). */
async function linkMiner(): Promise<void> {
  const button = $<HTMLButtonElement>("connect-wallet");
  button.disabled = true;
  try {
    if (!(await requireWallet())) return;
    let token = store.get(TOKEN_KEY);
    if (!token) {
      token = (await api(API, "/api/register", null, { label: $<HTMLInputElement>("label").value.trim() })).token as string;
      store.set(TOKEN_KEY, token);
    }
    $("wallet").textContent = "linking…";
    const { wallet } = await api(API, "/api/session/link", token, {}, sessionHeaders());
    showWallet(wallet);
    refresh();
  } catch (err) {
    if (sessionLost(err)) showWallet(linked);
    else $("wallet").textContent = err instanceof Error ? err.message : String(err);
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
    : "CPU threads, one connectome copy each (~350 MB memory per thread)";
}

const threads = $<HTMLSelectElement>("threads");
const phone = isPhone();
// each thread holds its own ~350 MB copy: a phone's browser tab is killed well before its RAM is full
const maxThreads = Math.min(phone ? 2 : 4, Math.max(1, cores - 1), memoryGb ? Math.max(1, Math.floor(memoryGb / (phone ? 3 : 1))) : 4);
for (let i = 1; i <= maxThreads; i++) threads.add(new Option(String(i), String(i), i === 1, i === 1));
$<HTMLInputElement>("label").value = store.get(LABEL_KEY) ?? "";
$("phone-hint").hidden = !phone;
// a phone GPU runs a batch far slower than a desktop one; a smaller batch reports back sooner
if (phone) $<HTMLSelectElement>("batch").value = "8";
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
$("connect-wallet").addEventListener("click", () => { void linkMiner(); });
mountAccount();
onAccount((wallet) => {
  showWallet(linked);
  // signing in with a miner here whose wallet isn't linked yet links it (refresh does the same once /api/me is in)
  if (wallet && meLoaded && !linked && store.get(TOKEN_KEY)) void linkMiner();
});
const COIN_NAMES: Record<string, string> = { KAS: "Kaspa", BTC: "Bitcoin" };
const LANES: Record<string, string> = { kaspa: "GPU", yespower: "CPU" };

/** Each pool's public page for our payout address, so anyone can check the numbers. */
function poolPage(c: { pool: string; address: string }): string | null {
  if (c.pool.endsWith("zpool.ca")) return `https://zpool.ca/wallet/${c.address}`;
  if (c.pool.endsWith("herominers.com")) return `https://${c.pool}/#/dashboard?addr=${c.address}`;
  return null;
}

/** The project's own mining: jobs done by the fleet and what the pools say they owe us. */
async function refreshMining(): Promise<void> {
  let m: any;
  try {
    m = await api(API, "/api/mining", null);
  } catch {
    return; // server away; keep what's shown
  }
  if (!m.coins?.length) return;
  $("mining-card").hidden = false;
  $("mining-rows").replaceChildren(...m.coins.map((c: any) => {
    const row = document.createElement("div");
    row.className = "row";
    const k = document.createElement("span");
    k.className = "k";
    k.textContent = `${COIN_NAMES[c.coin] ?? c.coin} · ${c.algo} (${LANES[c.name] ?? c.name})`;
    const v = document.createElement("span");
    v.className = "v";
    const digits = c.coin === "BTC" ? 8 : 2;
    v.textContent = [
      c.earned === null ? "pool stats unavailable" : `${c.earned.toFixed(digits)} ${c.coin}`,
      c.usd === null || c.usd === undefined ? null : `≈ $${c.usd.toFixed(2)}`,
      `${Number(c.jobs_settled).toLocaleString("en-US")} jobs`,
      c.live ? null : "paused",
    ].filter(Boolean).join(" · ");
    if (c.pending) v.title = `${c.pending.toFixed(digits)} ${c.coin} pending, ${Number(c.paid ?? 0).toFixed(digits)} paid out`;
    row.append(k, v);
    return row;
  }));
  $("mining-links").replaceChildren(...m.coins.flatMap((c: any, i: number) => {
    const url = poolPage(c);
    const a = document.createElement("a");
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = c.pool.split(".").slice(-2).join(".");
    if (url) a.href = url;
    return i ? [document.createTextNode(" · "), a] : [a];
  }));
}

refresh();
setInterval(refresh, 20_000);
void refreshMining();
setInterval(() => void refreshMining(), 60_000);
