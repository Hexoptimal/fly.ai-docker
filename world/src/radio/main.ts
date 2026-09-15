/**
 * Fly Radio page: channel dial, power button, VU meter, live translation panel. The brain runs in
 * radio.worker.ts; this file turns its wing loudness into sound and shows its captions.
 *
 * Sound: only the envelope is the brain's (wing motor neuron spikes above rest). The ~190 Hz carrier, the
 * per-voice pitch and the noise floor are a sonification choice, ported 1:1 from radio/audio.py.
 */
import radio from "./radio.json";

type Show = (typeof radio.shows)[number];
const SAMPLE_RATE = 22050;
const CARRIER_HZ = 190, ENVELOPE_GAIN = 0.4, LEVEL_SMOOTH = 0.3;
const MAX_AHEAD = 0.6;                                     // seconds of queued sound before we drop to catch up

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const statusEl = $("status"), radioUnit = $("radio-unit"), translationPanel = $("translation-panel");
const onAirSign = $("on-air-sign"), tunerTicks = $("tuner-ticks"), npName = $("np-name"), npTagline = $("np-tagline");
const npCast = $("np-cast"), tuneBtn = $<HTMLButtonElement>("tune-btn"), captionsEl = $("captions");
const vu = $<HTMLCanvasElement>("vu");
const vuCtx = vu.getContext("2d")!;

const SHOWS: Show[] = radio.shows;
let active = SHOWS[0].id;
let tuned = false;
let audioCtx: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let nextStartTime = 0;
let captionLog: { speaker: string; text: string; confidence: number }[] = [];
let brainReady = false;
let lastPerf = 0;

/** Continuous per-voice synthesis state so chunks don't click at their edges (radio/audio.py Voice). */
class Voice {
  phase = 0;
  level = 0;
  constructor(readonly pitch: number, readonly tone: number) {}

  synthesize(env: Float32Array, noise: number): Float32Array {
    const n = Math.round(env.length * radio.dt * SAMPLE_RATE);
    const out = new Float32Array(n);
    if (!n || !env.length) return out;
    let mean = 0;
    for (const x of env) mean += x;
    mean /= env.length;
    const target = Math.min(1, Math.max(0, mean * ENVELOPE_GAIN));
    this.level += (target - this.level) * LEVEL_SMOOTH;
    const freq = CARRIER_HZ * this.pitch;
    const w = 2 * Math.PI * freq / SAMPLE_RATE;
    for (let i = 0; i < n; i++) {
      const pos = (i / SAMPLE_RATE) / radio.dt;             // np.interp over step times, held at the ends
      const k = Math.min(env.length - 1, Math.floor(pos));
      const frac = Math.min(1, pos - k);
      const raw = k + 1 < env.length ? env[k] + (env[k + 1] - env[k]) * frac : env[env.length - 1];
      const amp = Math.min(1, Math.max(0, raw * ENVELOPE_GAIN)) * 0.5 + this.level * 0.5;
      const gauss = Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random());
      const s = Math.sin(this.phase + w * i) * amp * this.tone + gauss * noise * (0.3 + 0.7 * amp);
      out[i] = Math.max(-1, Math.min(1, s * 32000 / 32768));
    }
    this.phase = (this.phase + w * n) % (2 * Math.PI);
    return out;
  }
}
const voices = new Map<string, Voice>();

const worker = new Worker(new URL("./radio.worker.ts", import.meta.url), { type: "module" });
const base = new URL(import.meta.env.DEV ? `${import.meta.env.BASE_URL}connectome/` : "/simulation/connectome/", location.href).href;

worker.onmessage = (e: MessageEvent) => {
  const m = e.data;
  if (m.type === "progress") statusEl.textContent = `loading the fly brain: ${m.text}`;
  else if (m.type === "error") statusEl.textContent = `couldn't load the brain: ${m.text}`;
  else if (m.type === "ready") {
    brainReady = true;
    statusEl.textContent = tuned ? "on air" : `ready: ${m.n.toLocaleString()} neurons`;
  } else if (m.type === "perf") {
    lastPerf = m.ms;
    if (tuned) statusEl.textContent = `on air · ${lastPerf.toFixed(1)} ms per brain step`;
  } else if (m.type === "chunk") {
    if (!tuned || m.show !== active || !audioCtx || !analyser) return;
    const show = SHOWS.find((s) => s.id === m.show)!;
    const cast = show.cast[m.member];
    const key = `${show.id}/${cast.name}`;
    if (!voices.has(key)) voices.set(key, new Voice(cast.pitch, cast.tone));
    schedule(voices.get(key)!.synthesize(m.loud, show.noise));
    markSpeaking(m.speaker);
  } else if (m.type === "caption") {
    if (!tuned || m.show !== active) return;
    const nearBottom = captionsEl.scrollTop + captionsEl.clientHeight >= captionsEl.scrollHeight - 40;
    captionLog.push(m);
    if (captionLog.length > 100) captionLog.shift();
    renderCaptions();
    if (nearBottom) captionsEl.scrollTop = captionsEl.scrollHeight;
  }
};

function schedule(samples: Float32Array): void {
  const ac = audioCtx!;
  const now = ac.currentTime;
  if (nextStartTime - now > MAX_AHEAD) nextStartTime = now + 0.1;   // never drift behind the brain
  const buf = ac.createBuffer(1, samples.length, SAMPLE_RATE);
  buf.getChannelData(0).set(samples);
  const src = ac.createBufferSource();
  src.buffer = buf;
  src.connect(analyser!);
  const startAt = Math.max(nextStartTime, now + 0.05);
  src.start(startAt);
  nextStartTime = startAt + buf.duration;
}

function buildTuner(): void {
  tunerTicks.innerHTML = "";
  SHOWS.forEach((s, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "tick";
    b.setAttribute("role", "tab");
    b.setAttribute("aria-label", s.name);
    b.innerHTML = `<span class="num">${i + 1}</span><span class="name"></span>`;
    b.querySelector(".name")!.textContent = s.name;
    b.addEventListener("click", () => selectShow(s.id));
    tunerTicks.appendChild(b);
  });
}

function renderNowPlaying(): void {
  const show = SHOWS.find((s) => s.id === active)!;
  npName.textContent = show.name;
  npTagline.textContent = show.tagline;
  npCast.innerHTML = "";
  for (const m of show.cast) {
    const chip = document.createElement("span");
    chip.className = "cast-chip";
    chip.dataset.name = m.name;
    chip.innerHTML = '<span class="cast-dot"></span>';
    chip.append(m.name);
    npCast.appendChild(chip);
  }
  Array.from(tunerTicks.children).forEach((b, i) => b.setAttribute("aria-current", SHOWS[i].id === active ? "true" : "false"));
}

function markSpeaking(name: string | null): void {
  for (const chip of Array.from(npCast.children) as HTMLElement[]) chip.classList.toggle("speaking", chip.dataset.name === name);
}

function renderCaptions(): void {
  if (!captionLog.length) {
    captionsEl.innerHTML = `<div class="empty-hint">${tuned ? "Listening. The first reading comes after a second of the show." : "Captions appear once you've tuned in."}</div>`;
    return;
  }
  captionsEl.innerHTML = "";
  for (const c of captionLog) {
    const row = document.createElement("div");
    row.className = "caption-row";
    const who = document.createElement("b");
    who.textContent = c.speaker;
    const said = document.createElement("span");
    said.textContent = `reads ${c.text.toUpperCase()}`;
    const conf = document.createElement("span");
    conf.className = "conf mono";
    conf.textContent = `${Math.round(c.confidence * 100)}%`;
    row.append(who, said, conf);
    captionsEl.appendChild(row);
  }
}

function selectShow(id: string): void {
  active = id;
  captionLog = [];
  renderCaptions();
  renderNowPlaying();
  if (tuned) {
    nextStartTime = 0;
    worker.postMessage({ type: "tune", show: active });
  }
}

async function turnOn(): Promise<void> {
  if (!audioCtx) {
    audioCtx = new AudioContext();
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    analyser.connect(audioCtx.destination);
  }
  await audioCtx.resume();
  tuned = true;
  nextStartTime = 0;
  tuneBtn.textContent = "Turn off";
  radioUnit.classList.add("tuned");
  onAirSign.classList.add("lit");
  renderCaptions();
  if (!brainReady) statusEl.textContent = "loading the fly brain (58 MB, once)";
  worker.postMessage({ type: "load", base });
  worker.postMessage({ type: "tune", show: active });
}

function turnOff(): void {
  tuned = false;
  tuneBtn.textContent = "Tune in";
  radioUnit.classList.remove("tuned");
  onAirSign.classList.remove("lit");
  markSpeaking(null);
  worker.postMessage({ type: "tune", show: null });
  audioCtx?.suspend();
  statusEl.textContent = brainReady ? "off" : "press Tune in";
}

tuneBtn.addEventListener("click", () => (tuned ? turnOff() : turnOn()));

function drawVu(): void {
  requestAnimationFrame(drawVu);
  vuCtx.clearRect(0, 0, vu.width, vu.height);
  if (!analyser || !tuned) return;
  const data = new Uint8Array(analyser.frequencyBinCount);
  analyser.getByteTimeDomainData(data);
  let peak = 0;
  for (const x of data) peak = Math.max(peak, Math.abs(x - 128));
  const level = Math.min(1, peak / 100);
  vuCtx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#e0342c";
  const bars = 22;
  for (let i = 0; i < bars; i++) {
    vuCtx.globalAlpha = i / bars < level ? 1 : 0.15;
    vuCtx.fillRect(4 + i * (vu.width - 8) / bars, 5, (vu.width - 8) / bars - 2, vu.height - 10);
  }
  vuCtx.globalAlpha = 1;
}

function syncPanelHeight(): void {
  if (window.matchMedia("(max-width:760px)").matches) {
    translationPanel.style.height = "";
    return;
  }
  translationPanel.style.height = `${radioUnit.getBoundingClientRect().height}px`;
}
new ResizeObserver(syncPanelHeight).observe(radioUnit);
window.addEventListener("resize", syncPanelHeight);

// research dropdown: hover and keyboard focus open it in CSS; the caret toggles it for touch (as docs/assets/site.js)
const menus = Array.from(document.querySelectorAll<HTMLElement>("nav li.dd"));
const closeMenu = (dd: HTMLElement) => { dd.classList.remove("open"); dd.querySelector(".ddbtn")!.setAttribute("aria-expanded", "false"); };
for (const dd of menus) {
  const btn = dd.querySelector(".ddbtn")!;
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    btn.setAttribute("aria-expanded", String(dd.classList.toggle("open")));
  });
  dd.addEventListener("focusout", (e) => { if (!dd.contains((e as FocusEvent).relatedTarget as Node)) closeMenu(dd); });
}
document.addEventListener("click", (e) => menus.forEach((dd) => { if (!dd.contains(e.target as Node)) closeMenu(dd); }));
document.addEventListener("keydown", (e) => { if (e.key === "Escape") menus.forEach(closeMenu); });

statusEl.textContent = "press Tune in";
buildTuner();
renderNowPlaying();
renderCaptions();
drawVu();
(window as unknown as { __radio: object }).__radio = { get perf() { return lastPerf; }, get captions() { return captionLog.length; },
  get ready() { return brainReady; }, get ahead() { return audioCtx ? nextStartTime - audioCtx.currentTime : 0; } };
