/**
 * The extension's miner: an offscreen document running web/mine-core.ts's Miner. Offscreen documents only
 * get chrome.runtime, so orders and the token arrive by message and state goes back the same way.
 */
import { Miner, probeGpu, type GpuProbe } from "../web/mine-core.ts";
import { IDLE, type MinerState, type Settings } from "./settings.ts";

const state: MinerState = { ...IDLE, status: "starting" };
let token: string | null = null;
let label = "";
let miner: Miner | null = null;
let server = "";
/** the settings the running miner was started with; a label change alone doesn't restart it */
let runningKey = "";
let probe: Promise<GpuProbe> = probeGpu();

const toBackground = (msg: object) => chrome.runtime.sendMessage({ target: "background", ...msg }).catch(() => {});

let reportQueued = false;
function report(): void {
  if (reportQueued) return;
  reportQueued = true;
  setTimeout(() => {
    reportQueued = false;
    void toBackground({ type: "state", state });
  }, 400);
}

/** The brain files: the website's copy, unless mining against a local server. */
const connectomeFor = (origin: string) =>
  (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) ? `${origin}/connectome` : "https://www.flyaiworld.com/simulation/connectome");

function minerFor(origin: string): Miner {
  return new Miner({
    server: origin,
    connectome: connectomeFor(origin),
    getToken: () => token,
    setToken: (t) => {
      token = t;
      void toBackground({ type: "token", token: t });
    },
    label: () => label,
    // the shared miner says "mining"; the extension describes what it does: running research jobs
    status: (text) => { state.status = text === "mining" ? "running" : text; report(); },
    lanes: (names) => { state.lanes = names.map((name) => ({ name, text: "starting", progress: 0 })); report(); },
    lane: (i, text, progress) => {
      const lane = state.lanes[i];
      if (!lane) return;
      if (text) lane.text = text;
      if (progress !== undefined) lane.progress = progress;
      report();
    },
    job: (text) => { state.job = text; report(); },
    session: (s) => { state.session = s; report(); },
  });
}

async function start(settings: Settings, tok: string | null): Promise<void> {
  token = tok;
  label = settings.label;
  const key = JSON.stringify([settings.engine, settings.batch, settings.threads, settings.server, settings.programs]);
  if (miner?.running && key === runningKey) return;
  runningKey = key;
  miner?.stop("");
  if (!miner || settings.server !== server) {
    server = settings.server;
    miner = minerFor(server);
  }
  let engine = settings.engine;
  state.probe = await probe;
  if (engine === "gpu" && !state.probe.usable) {
    engine = "cpu";
    state.status = `the GPU can't be used here (${state.probe.reason}); using the CPU`;
  }
  state.engine = engine;
  state.session = null;
  report();
  // "programs" here are our own world runs and brain probes, which ship inside the extension. Buyers' WebAssembly
  // and shaders, and embeddings (model code from a CDN), are downloaded code, which the store doesn't allow in an
  // extension: those stay on the website
  await miner.start({ engine, batch: settings.batch, threads: settings.threads, programs: settings.programs !== false, embed: false, buyerPrograms: false });
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.target !== "offscreen") return;
  if (msg.type === "start") void start(msg.settings, msg.token);
  else if (msg.type === "probe") {
    probe = probeGpu();
    void probe.then((p) => { state.probe = p; report(); });
  }
});

void probe.then((p) => {
  state.probe = p;
  report();
});
void toBackground({ type: "ready" });
