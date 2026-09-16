/**
 * The extension's service worker. It can't run the brain itself (no WebGPU, and Chrome stops it when idle),
 * so it only keeps an offscreen document running while mining is enabled and passes it its orders.
 * Stateless: every decision is read from storage, so being stopped and restarted by Chrome changes nothing.
 */
import { IDLE, loadSettings } from "./settings.ts";

const OFFSCREEN = "mine/extension/offscreen.html";

async function offscreenOpen(): Promise<boolean> {
  const contexts = await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT] });
  return contexts.length > 0;
}

async function orders(): Promise<void> {
  const settings = await loadSettings();
  const { token } = await chrome.storage.local.get("token") as { token?: string };
  await chrome.runtime.sendMessage({ target: "offscreen", type: "start", settings, token: token ?? null }).catch(() => {});
}

/** Bring the offscreen miner in line with the settings. Queued, so two quick changes can't open two documents. */
let applying = Promise.resolve();
function apply(): Promise<void> {
  applying = applying.then(async () => {
    const { enabled } = await loadSettings();
    if (enabled) {
      if (await offscreenOpen()) await orders();
      // a new document asks for its orders once its script is listening
      else await chrome.offscreen.createDocument({
        url: OFFSCREEN,
        reasons: [chrome.offscreen.Reason.WORKERS],
        justification: "Runs the fruit-fly brain simulation jobs the user turned on, in web workers.",
      });
    } else if (await offscreenOpen()) {
      await chrome.offscreen.closeDocument();
      await chrome.storage.session.set({ state: IDLE });
    }
  }).catch((err) => console.error("fly.ai compute:", err));
  return applying;
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.target !== "background") return;
  if (msg.type === "ready") void orders();
  else if (msg.type === "state") void chrome.storage.session.set({ state: msg.state });
  else if (msg.type === "token") void chrome.storage.local.set({ token: msg.token });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.settings) void apply();
});

chrome.runtime.onStartup.addListener(() => void apply());
chrome.runtime.onInstalled.addListener(() => void apply());
