/**
 * The extension popup: the switch, engine and intensity (saved to storage, which the background worker
 * acts on), what the offscreen miner reports, what this machine's GPU looks like, and today's numbers.
 */
import { api, ApiError, probeGpu } from "../web/mine-core.ts";
import { shortAddress } from "../web/wallet.ts";
import { IDLE, loadSettings, saveSettings, type MinerState, type Settings } from "./settings.ts";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const cores = Math.max(1, navigator.hardwareConcurrency || 2);
let settings: Settings;

/** The website's compute pages: on flyaiworld.com, or the local server when mining against one. */
const webPage = (page: string) => /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(settings.server)
  ? `${settings.server}/compute/${page}`
  : `https://www.flyaiworld.com/compute/${page}`;

// ---- controls ----------------------------------------------------------------------------------------
function showControls(): void {
  $<HTMLInputElement>("enabled").checked = settings.enabled;
  $<HTMLSelectElement>("engine").value = settings.engine;
  $<HTMLSelectElement>("batch").value = String(settings.batch);
  $<HTMLSelectElement>("threads").value = String(settings.threads);
  $<HTMLInputElement>("programs").checked = settings.programs !== false;
  const gpu = settings.engine === "gpu";
  $("batch-field").hidden = !gpu;
  $("threads-field").hidden = gpu;
  // Chrome on Windows ignores WebGPU's powerPreference and runs on the GPU its graphics process started on
  $("gpu-hint").hidden = !(gpu && /Windows/.test(navigator.userAgent));
  $<HTMLInputElement>("label").value = settings.label;
  $<HTMLInputElement>("server").value = settings.server;
}

async function change(patch: Partial<Settings>): Promise<void> {
  settings = await saveSettings(patch);
  showControls();
}

// ---- what the miner reports ---------------------------------------------------------------------------
function showState(s: MinerState): void {
  $("state-line").textContent = !settings.enabled
    ? "Off. Nothing runs until you turn it on."
    : s.engine ? `On, using the ${s.engine.toUpperCase()}. Keeps running while Chrome is open.` : "On, starting…";
  $("status").textContent = settings.enabled ? s.status : "off";
  $("job").textContent = s.job;
  $("session").textContent = s.session
    ? `${s.session.jobs} jobs · ${s.session.units.toFixed(1)} units · ${(s.session.unitsPerMinute ?? 0).toFixed(1)} units/min`
    : "—";
  const rows = s.lanes.map((lane) => {
    const row = document.createElement("div");
    row.className = "lane";
    row.innerHTML = `<span class="name"></span><div class="bar"><div></div></div><span class="text"></span>`;
    (row.querySelector(".name") as HTMLElement).textContent = lane.name;
    (row.querySelector(".bar > div") as HTMLElement).style.width = `${100 * lane.progress}%`;
    (row.querySelector(".text") as HTMLElement).textContent = lane.text;
    return row;
  });
  $("slots").replaceChildren(...rows);
  const mg = $("miner-gpu");
  if (s.probe) {
    mg.className = "v";
    mg.textContent = s.probe.usable ? `${s.probe.name} ✓` : `no usable GPU: ${s.probe.reason}`;
  } else if (!settings.enabled) {
    mg.className = "v";
    mg.textContent = "starts when you turn it on";
  }
}

async function readState(): Promise<void> {
  const { state } = await chrome.storage.session.get("state") as { state?: MinerState };
  showState(state ?? IDLE);
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
    const s = await api(settings.server, "/api/stats", null);
    $("fleet").textContent = `${s.miners_online} online · ${s.jobs_today} jobs today`;
  } catch {
    $("fleet").textContent = `can't reach ${settings.server}`;
  }
  const { token } = await chrome.storage.local.get("token") as { token?: string };
  if (!token) return;
  try {
    const me = await api(settings.server, "/api/me", token);
    $("wallet").textContent = me.wallet ? `${shortAddress(me.wallet)} ✓` : "not linked";
    $("wallet").title = me.wallet ?? "";
    $("connect-wallet").textContent = me.wallet ? "Change" : "Connect";
    $("stake").textContent = me.stake
      ? `${me.stake.tier ?? "no tier"} · ${me.stake.multiplier}×${me.stake.tomorrow ? `, ${me.stake.tomorrow.multiplier}× tomorrow` : ""}`
      : me.wallet ? "not live yet: 1×" : "link a wallet";
    $("month").textContent = me.wallet
      ? [
        `${me.month_points.toFixed(1)} pts · ${(me.month_share * 100).toFixed(2)}%`,
        me.month_rank ? `#${me.month_rank}` : null,
        me.month_estimate !== null ? `≈ ${Math.round(me.month_estimate).toLocaleString("en-US")} FLYAI` : null,
        `${me.month_days_left}d left`,
      ].filter(Boolean).join(" · ")
      : `${me.month_points.toFixed(1)} pts, link a wallet`;
    $("today-jobs").textContent = String(me.jobs);
    $("today-checked").textContent = String(me.checked);
    $("today-units").textContent = me.credited.toFixed(1);
    $("today-share").textContent = `${(me.share * 100).toFixed(1)}%`;
    $("today-standing").textContent = STANDING[me.standing] ?? me.standing;
    $("today-standing").dataset.standing = me.standing;
  } catch (err) {
    if (!(err instanceof ApiError)) return;
  }
}

// ---- wallet ------------------------------------------------------------------------------------------
/**
 * Wallet extensions don't inject into other extensions' pages, so the popup gets a one-time link code and
 * opens the server's /connect page, where the user signs in a normal tab.
 */
async function connectWallet(): Promise<void> {
  try {
    let { token } = await chrome.storage.local.get("token") as { token?: string };
    if (!token) {
      token = (await api(settings.server, "/api/register", null, { label: settings.label })).token as string;
      await chrome.storage.local.set({ token });
    }
    const { url } = await api(settings.server, "/api/link", token, {});
    await chrome.tabs.create({ url });
  } catch (err) {
    $("wallet").textContent = err instanceof Error ? err.message : String(err);
  }
}

// ---- boot --------------------------------------------------------------------------------------------
async function boot(): Promise<void> {
  settings = await loadSettings();
  const threads = $<HTMLSelectElement>("threads");
  for (let i = 1; i <= Math.min(4, Math.max(1, cores - 1)); i++) threads.add(new Option(String(i), String(i)));
  showControls();
  $<HTMLAnchorElement>("claims-link").href = webPage("claim");
  $<HTMLAnchorElement>("leaderboard-link").href = webPage("leaderboard");
  $<HTMLAnchorElement>("stake-link").href = webPage("stake");
  $("cpu").textContent = `${cores} threads`;

  const probe = await probeGpu();
  $("gpu").textContent = probe.usable ? `${probe.name} (WebGPU)` : `can't mine on the GPU: ${probe.reason}`;
  const gpuOption = $<HTMLSelectElement>("engine").options[0];
  if (!probe.usable) {
    gpuOption.disabled = true;
    gpuOption.textContent = "GPU (not available)";
    if (settings.engine === "gpu") await change({ engine: "cpu" });
  }

  $<HTMLInputElement>("enabled").addEventListener("change", (e) => void change({ enabled: (e.target as HTMLInputElement).checked }));
  $<HTMLSelectElement>("engine").addEventListener("change", (e) => void change({ engine: (e.target as HTMLSelectElement).value as "gpu" | "cpu" }));
  $<HTMLSelectElement>("batch").addEventListener("change", (e) => void change({ batch: Number((e.target as HTMLSelectElement).value) }));
  $<HTMLSelectElement>("threads").addEventListener("change", (e) => void change({ threads: Number((e.target as HTMLSelectElement).value) }));
  $<HTMLInputElement>("programs").addEventListener("change", (e) => void change({ programs: (e.target as HTMLInputElement).checked }));
  $("connect-wallet").addEventListener("click", () => void connectWallet());
  $("save").addEventListener("click", async () => {
    const label = $<HTMLInputElement>("label").value.trim();
    const raw = $<HTMLInputElement>("server").value.trim().replace(/\/+$/, "");
    let origin: string;
    try {
      origin = new URL(raw).origin;
    } catch {
      $("saved").textContent = "that server isn't a URL";
      return;
    }
    // the manifest only grants the fly.dev server, localhost and flyaiworld.com up front; anything else is asked for here
    if (!(await chrome.permissions.contains({ origins: [`${origin}/*`] })) && !(await chrome.permissions.request({ origins: [`${origin}/*`] }))) {
      $("saved").textContent = "permission to reach that server was refused";
      return;
    }
    if (origin !== settings.server) await chrome.storage.local.remove("token"); // miners are per server
    await change({ label, server: origin });
    $("saved").textContent = "saved";
    void refresh();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "session" && changes.state) showState((changes.state.newValue as MinerState | undefined) ?? IDLE);
    if (area === "local" && changes.settings) {
      settings = { ...settings, ...(changes.settings.newValue as Partial<Settings>) };
      showControls();
      void readState();
    }
  });
  await readState();
  void refresh();
  setInterval(() => void refresh(), 10_000);
}

void boot();
