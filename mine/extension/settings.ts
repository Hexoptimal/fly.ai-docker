/** What the extension stores, shared by the popup, the background worker and the offscreen miner. */
import type { GpuProbe } from "../web/mine-core.ts";

export interface Settings {
  /** off until the user turns it on */
  enabled: boolean;
  engine: "gpu" | "cpu";
  batch: number;
  threads: number;
  /** optional name stored with a new miner; the wallet is proven separately (Connect wallet) */
  label: string;
  /** the mining server's origin */
  server: string;
  /** also run our own world simulations and brain probes (+1% on those jobs); buyers' programs run on the website only */
  programs: boolean;
}

export const DEFAULTS: Settings = {
  enabled: false,
  engine: "gpu",
  batch: 32,
  threads: 1,
  label: "",
  server: "https://flyai-mine.fly.dev",
  programs: true,
};

/** chrome.storage.local: settings and token. */
export async function loadSettings(): Promise<Settings> {
  const { settings } = await chrome.storage.local.get("settings") as { settings?: Partial<Settings> };
  return { ...DEFAULTS, ...(settings ?? {}) };
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await loadSettings()), ...patch };
  await chrome.storage.local.set({ settings: next });
  return next;
}

/** chrome.storage.session: what the offscreen miner is doing, for the popup. */
export interface MinerState {
  status: string;
  job: string;
  /** the engine actually running, which is the CPU if the GPU turned out unusable */
  engine: "gpu" | "cpu" | null;
  lanes: { name: string; text: string; progress: number }[];
  session: { jobs: number; units: number; perMinute: number; unitsPerMinute?: number } | null;
  /** what the background miner's WebGPU sees, which can differ from the popup's */
  probe: GpuProbe | null;
}

export const IDLE: MinerState = { status: "off", job: "—", engine: null, lanes: [], session: null, probe: null };
