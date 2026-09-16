/**
 * Wiring of the page: fixed-timestep simulation, rendering, and the overlay.
 *
 * The simulation runs at a fixed 50 Hz (flybrain.dt = 20 ms) in its own
 * accumulator loop, so the network step is decoupled from the frame rate.
 * Every label and bar on screen is a readout of population firing rates.
 */
import "./style.css";
import * as THREE from "three";
import { BrainView, MODALITY_COLOR, POP_COLOR } from "./brainview.ts";
import { Renderer } from "./scene.ts";
import { ECOLOGY, MOTOR, World, type Fly } from "./sim.ts";
import { ORN_AVERSIVE, ORN_CVA, ORN_FOOD, POPULATIONS, type Modality } from "./wiring.ts";
import { Wiz } from "./wiz.ts";
import { WizView } from "./wizview.ts";
import { PuppeteerView } from "./puppeteer.ts";
import { DataPanel } from "./datapanel.ts";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const START_FLIES = 36;
// brains start frozen: with learning on the flies forage worse and the population dies out (world/README, tools/lifedata.ts).
// Switch either rule on in the Data card to watch them rewire.
const world = new World(START_FLIES, 1234, { learning: { hebbian: false, reward: false, mb: true } });
const dataPanel = new DataPanel(world);
const renderer = new Renderer($<HTMLCanvasElement>("view"), world);
const wiz = new Wiz(world);
const wizView = new WizView(renderer.scene, `${import.meta.env.BASE_URL}models/wiz.glb`);
const puppeteer = new PuppeteerView(renderer.scene);
let wizCam = false;
let wizFrame = 0;
const brainView = new BrainView($<HTMLCanvasElement>("brain"), world.wiring, $<HTMLCanvasElement>("raster"));

// ---------------------------------------------------------------- overlay ---
interface Bars { L: HTMLElement; R: HTMLElement }

function makeRow(host: HTMLElement, label: string, sub: string, color: string, solo = false): Bars {
  const row = document.createElement("div");
  row.className = solo ? "row solo" : "row";
  row.innerHTML =
    `<span title="${sub}">${label}</span>` +
    `<div class="bar"><i style="background:${color}"></i></div>` +
    (solo ? "" : `<div class="bar"><i style="background:${color}"></i></div>`);
  host.appendChild(row);
  const bars = row.querySelectorAll<HTMLElement>(".bar i");
  return { L: bars[0], R: bars[solo ? 0 : 1] };
}

function heading(host: HTMLElement, text: string, color: string): void {
  const h = document.createElement("div");
  h.className = "group";
  h.textContent = text;
  h.style.color = color;
  host.appendChild(h);
}

const LIGAND: Record<string, string> = {
  ORN_DM1: "ethyl acetate: ripe fruit",
  ORN_VM5d: "ethyl butyrate: fermenting fruit",
  ORN_VL2a: "acetic acid: vinegar",
  IR92a: "ammonia and amines: carrion, dung, droppings",
  ORN_DA1: "cVA: the pheromone other flies release",
  ORN_VA1d: "cVA: the pheromone other flies release",
  Or56a: "geosmin: mould. Aversive.",
  Gr21a: "CO2: compost, and frightened flies. Aversive.",
};

heading($("eyes"), "vision", MODALITY_COLOR.vision);
const eyeRows = {
  loom: makeRow($("eyes"), "LPLC2", "looming: something getting bigger", POP_COLOR.LPLC2),
  threat: makeRow($("eyes"), "LC4", "fast looming / threat", POP_COLOR.LC4),
  small: makeRow($("eyes"), "LPLC1", "small approaching objects", POP_COLOR.LPLC1),
  chase: makeRow($("eyes"), "LC10a", "a target at close range", POP_COLOR.LC10a),
};
heading($("eyes"), "olfaction — food", MODALITY_COLOR.olfaction);
const ornRows = ORN_FOOD.map((t) => ({ type: t, bars: makeRow($("eyes"), t.replace("ORN_", ""), LIGAND[t], POP_COLOR[t]) }));
heading($("eyes"), "olfaction — cVA (other flies)", MODALITY_COLOR.olfaction);
ornRows.push(...ORN_CVA.map((t) => ({ type: t, bars: makeRow($("eyes"), t.replace("ORN_", ""), LIGAND[t], POP_COLOR[t]) })));
heading($("eyes"), "olfaction — aversive", "#ff7a7a");
ornRows.push(...ORN_AVERSIVE.map((t) => ({ type: t, bars: makeRow($("eyes"), t, LIGAND[t], POP_COLOR[t] ?? "#ff7a7a") })));
heading($("eyes"), "mechanosensory", MODALITY_COLOR.mechanosensory);
const mechRows = {
  jo: makeRow($("eyes"), "JO", "Johnston's organ: airflow, airspeed, wingbeat", POP_COLOR.JO),
  leg: makeRow($("eyes"), "SNta", "tarsal contact (phasic)", POP_COLOR.SNta),
  load: makeRow($("eyes"), "LgLG", "hair plate / campaniform: knocks", POP_COLOR.LgLG),
  taste: makeRow($("eyes"), "LB3", "labellar taste: food", POP_COLOR.LB3, true),
  flow: makeRow($("eyes"), "VS", "ventral optic flow: how low and how fast", POP_COLOR.VS ?? "#7fc8ff", true),
};

const rateRows: { bars: Bars; iL: number; iR: number }[] = [];
let lastModality: Modality | null = null;
for (const p of POPULATIONS) {
  if (p.modality !== lastModality) {
    heading($("rates"), p.modality, MODALITY_COLOR[p.modality]);
    lastModality = p.modality;
  }
  rateRows.push({
    bars: makeRow($("rates"), p.name, p.note, POP_COLOR[p.name] ?? "#9aa7b5"),
    iL: world.wiring.pops.findIndex((q) => q.name === p.name && q.side === "L"),
    iR: world.wiring.pops.findIndex((q) => q.name === p.name && q.side === "R"),
  });
}

const dnRows = {
  turn: makeRow($("dn"), "DNa02", "steering: right minus left", MODALITY_COLOR.descending),
  thrust: makeRow($("dn"), "DNg100", "forward flight", MODALITY_COLOR.descending, true),
  back: makeRow($("dn"), "MDN", "backward", MODALITY_COLOR.descending, true),
  escape: makeRow($("dn"), "DNp01", "giant fibre escape", MODALITY_COLOR.descending, true),
};
const mnRows = {
  dlm: makeRow($("motor"), "DLM", "wing power, and therefore lift", MODALITY_COLOR.motor, true),
  b1: makeRow($("motor"), "b1/b2", "basalar muscles: wing steering", MODALITY_COLOR.motor),
  jump: makeRow($("motor"), "TiExt+St", "tibia extensor + sternotrochanter: take-off", MODALITY_COLOR.motor),
  flex: makeRow($("motor"), "Ti/Tr flex", "leg flexors: backing off", MODALITY_COLOR.motor, true),
};
const motorText = document.createElement("div");
motorText.className = "note";
$("motor").appendChild(motorText);

const wizRows = {
  arms: makeRow($("wizbars"), "arm strings", "DNp02/03/04/11, DNg40: looming and threat yank the arms · left · right", MODALITY_COLOR.descending),
  legs: makeRow($("wizbars"), "leg strings", "DNge104/122, DNg20, DNge102: touch kicks the legs · left · right", MODALITY_COLOR.descending),
  head: makeRow($("wizbars"), "head string", "DNa05/07, DNg111, DNae002: jerks the head · left · right", MODALITY_COLOR.descending),
  steer: makeRow($("wizbars"), "DNa02", "steering: turns him · left · right", MODALITY_COLOR.descending),
  escape: makeRow($("wizbars"), "DNp01", "giant fibre: jump · left · right", MODALITY_COLOR.descending),
};
const wizText = document.createElement("div");
wizText.className = "note";
$("wizbars").appendChild(wizText);

// world legend
const LEGEND_COLOR: Record<string, string> = {
  fruit: "#c2493d", mould: "#6f7d63", carrion: "#9b7d76", dung: "#5b4630",
  compost: "#3b3024", plant: "#4b7a54", poop: "#e8e4d8", obstacle: "#3c4756",
  spider: "#15171b", egg: "#f2eddc", larva: "#f2eddc",
};
for (const [kind, color] of Object.entries(LEGEND_COLOR)) {
  const s = document.createElement("span");
  s.innerHTML = `<i style="background:${color}"></i>${ECOLOGY[kind].label}`;
  $("worldlegend").appendChild(s);
}

// --- sliders ----------------------------------------------------------------
interface SliderSpec {
  label: string; min: number; max: number; step: number; value: number;
  apply: (v: number) => void; fmt?: (v: number) => string;
}

const sliders: SliderSpec[] = [
  { label: "flies", min: 1, max: 80, step: 1, value: START_FLIES, apply: (v) => world.setFlyCount(v) },
  { label: "wind (m/s)", min: 0, max: 3, step: 0.05, value: world.wind.strength, apply: (v) => (world.wind.strength = v), fmt: (v) => v.toFixed(2) },
  { label: "odour strength", min: 0, max: 3, step: 0.05, value: 1, apply: (v) => (world.odourStrength = v), fmt: (v) => v.toFixed(2) },
  { label: "tonic drive", min: 0, max: 0.2, step: 0.005, value: world.params.tonic, apply: (v) => (world.params.tonic = v) },
  { label: "synaptic gain", min: 0.2, max: 4, step: 0.05, value: world.params.gain, apply: (v) => (world.params.gain = v) },
  { label: "noise rate (Hz)", min: 0, max: 8, step: 0.1, value: world.params.noiseHz, apply: (v) => (world.params.noiseHz = v) },
  { label: "simulation speed", min: 0, max: 3, step: 0.05, value: 1, apply: (v) => (world.speedScale = v), fmt: (v) => v.toFixed(2) + "x" },
];

for (const s of sliders) {
  const el = document.createElement("label");
  el.className = "slider";
  const fmt = s.fmt ?? ((v: number) => String(v));
  el.innerHTML = `<span>${s.label}</span><output>${fmt(s.value)}</output>` +
    `<input type="range" min="${s.min}" max="${s.max}" step="${s.step}" value="${s.value}">`;
  const input = el.querySelector("input")!;
  const out = el.querySelector("output")!;
  input.addEventListener("input", () => {
    const v = Number(input.value);
    out.textContent = fmt(v);
    s.apply(v);
  });
  $("sliders").appendChild(el);
}

$("wiz").addEventListener("click", () => {
  wiz.summon(new URL(`${import.meta.env.BASE_URL}connectome/`, document.baseURI).href);
  $("wiz").setAttribute("disabled", "");
});
$("wizcam").addEventListener("click", () => {
  wizCam = !wizCam;
  $("wizcam").classList.toggle("on", wizCam);
  if (wizCam) renderer.camMode = "orbit";
});
$("threat").addEventListener("click", () => world.dropThreat());
$("gust").addEventListener("click", () => {
  world.wind.strength = Math.min(3, world.wind.strength + 1.2);
  world.wind.angle += 1.1;
  setTimeout(() => (world.wind.strength = Math.max(0, world.wind.strength - 1.2)), 4000);
});
$("next").addEventListener("click", () => {
  world.selected = (world.selected + 1) % world.flies.length;
  brainView.clear();
});
$("flycam").addEventListener("click", () => {
  renderer.camMode = renderer.camMode === "follow" ? "orbit" : "follow";
  $("flycam").classList.toggle("on", renderer.camMode === "follow");
});
let drama = false;
$("drama").addEventListener("click", () => {
  drama = !drama;
  $("drama").classList.toggle("on", drama);
  if (drama) {
    renderer.camMode = "follow";
    $("flycam").classList.add("on");
  }
});
$("follow").addEventListener("click", () => {
  renderer.camMode = renderer.camMode === "orbit" ? "follow" : "orbit";
  $("follow").textContent = "follow: " + (renderer.camMode === "follow" ? "on" : "off");
  $("follow").classList.toggle("on", renderer.camMode === "follow");
});
// the "what this is" card: open by default, collapsible, remembered per browser
const aboutCard = document.querySelector<HTMLElement>(".card.about")!;
const aboutToggle = $("abouttoggle");
let aboutOpen = true;
try {
  aboutOpen = localStorage.getItem("fly.about") !== "closed";
} catch { /* private window: just leave it open */ }
function setAbout(open: boolean): void {
  aboutOpen = open;
  aboutCard.classList.toggle("folded", !open);
  aboutToggle.textContent = open ? "hide" : "what is this?";
  try {
    localStorage.setItem("fly.about", open ? "open" : "closed");
  } catch { /* ignore */ }
}
setAbout(aboutOpen);
aboutToggle.addEventListener("click", () => setAbout(!aboutOpen));

$("reset").addEventListener("click", () => location.reload());
$("toggle").addEventListener("click", () => $("panel").classList.toggle("hidden"));

// --- labels above the flies --------------------------------------------------
const labelHost = $("labels");
const tags: HTMLElement[] = [];
const ndc = new THREE.Vector3();
const here = new THREE.Vector3();
let labelFrame = 0;

// ------------------------------------------------------------------- loop ---
const DT = world.params.dt;
let acc = 0;
let last = performance.now();
let fps = 60;
let simMs = 0;
let lastSelected = -1;
let dramaTimer = 0;

function tick(now: number): void {
  requestAnimationFrame(tick);
  const wall = Math.min(0.1, (now - last) / 1000);
  last = now;
  fps += ((1 / Math.max(wall, 1e-4)) - fps) * 0.08;

  acc += wall * world.speedScale;
  let steps = 0;
  const t0 = performance.now();
  while (acc >= DT && steps < 6) {
    world.step();
    wiz.step(world, DT);
    const sel = world.flies[world.selected];
    if (sel) {
      if (world.selected !== lastSelected) {
        brainView.clear();
        lastSelected = world.selected;
      }
      brainView.record(sel.brain);
    }
    acc -= DT;
    steps++;
  }
  if (acc > DT * 8) acc = 0;
  if (steps) simMs += ((performance.now() - t0) / steps - simMs) * 0.1;

  // drama cam: whoever is panicking hardest, else whoever has eaten most
  dramaTimer -= wall;
  if (drama && dramaTimer <= 0) {
    dramaTimer = 3;
    let best = world.flies[0], score = -1;
    for (const f of world.flies) {
      const s = f.dn.escape * 100 + (f.feeding ? 3 : 0) + f.motor.jump * 20;
      if (s > score) { score = s; best = f; }
    }
    const idx = world.flies.indexOf(best);
    if (idx >= 0 && idx !== world.selected) {
      world.selected = idx;
      brainView.clear();
    }
  }

  brainView.draw();
  wizView.update(wiz, wall, wizCam, renderer.camera, renderer.controls);
  puppeteer.update(wiz, wizView, wall);
  if (wizFrame++ % 4 === 0) updateWiz();
  renderer.render(wall);
  updateLabels();
  updateEvents();
  updatePanel();
}

// --- event markers: what just happened, floating where it happened ----------
const EVENT_FACE: Record<string, string> = {
  mate: "♥",      // heart
  egg: "●",       // egg laid
  hatch: "✻",     // something new
  feed: "◆",      // a meal started
  attack: "✖",    // a spider strike
  death: "☠",     // a fly died
  poop: "○",      // a dropping: amines for everybody else
  arrive: "➤",    // a newcomer flies in (the always-on world never runs empty)
};
const eventEls: HTMLElement[] = [];
const seenEvents = new WeakSet<object>();

function updateEvents(): void {
  const evs = world.events;
  while (eventEls.length < 40) {
    const el = document.createElement("div");
    el.className = "ev";
    el.style.display = "none";
    labelHost.appendChild(el);
    eventEls.push(el);
  }
  const w = innerWidth, h = innerHeight;
  for (let i = 0; i < eventEls.length; i++) {
    const el = eventEls[i];
    const e = evs[i];
    if (!e) { el.style.display = "none"; continue; }
    if (!seenEvents.has(e)) {
      seenEvents.add(e);
      el.className = "ev " + e.kind;
      el.innerHTML = `<i>${EVENT_FACE[e.kind]}</i>${e.text}`;
    }
    // it rises and fades over its 6 s life
    const k = Math.min(1, e.age / 6);
    const visible = renderer.project(e.x, e.y + 0.5 + k * 1.4, e.z, ndc);
    if (!visible) { el.style.display = "none"; continue; }
    el.style.display = "";
    el.style.opacity = String(Math.max(0, 1 - k * k));
    el.style.transform = `translate(${(ndc.x * 0.5 + 0.5) * w}px, ${(-ndc.y * 0.5 + 0.5) * h}px) translate(-50%, -100%)`;
  }
}

function updateLabels(): void {
  if (labelFrame++ % 2) return;
  const flies = world.flies;
  while (tags.length < flies.length) {
    const el = document.createElement("div");
    el.className = "tag";
    labelHost.appendChild(el);
    tags.push(el);
  }
  const w = innerWidth, h = innerHeight;
  for (let i = 0; i < tags.length; i++) {
    const el = tags[i];
    const f = flies[i];
    if (!f) { el.style.display = "none"; continue; }
    const visible = renderer.project(f.x, f.y + 0.45, f.z, ndc);
    const dist = renderer.camera.position.distanceTo(here.set(f.x, f.y, f.z));
    if (!visible || dist > 26) { el.style.display = "none"; continue; }
    el.style.display = "";
    el.style.transform = `translate(${(ndc.x * 0.5 + 0.5) * w}px, ${(-ndc.y * 0.5 + 0.5) * h}px) translate(-50%, -100%)`;
    const cls = "tag " + f.state + (i === world.selected ? " sel" : "");
    if (el.className !== cls) {
      el.className = cls;
      el.innerHTML = `<b>${f.name}</b> ${f.state}`;
    }
  }
}

/** what to call the current hour, for the header */
const PHASE = (t: number): string =>
  t < 0.21 ? "night" : t < 0.3 ? "dawn" : t < 0.46 ? "morning"
  : t < 0.56 ? "midday" : t < 0.72 ? "afternoon" : t < 0.82 ? "dusk" : "night";

let frame = 0;
const set = (b: HTMLElement, v: number) => (b.style.width = Math.max(0, Math.min(100, v * 100)) + "%");

function updatePanel(): void {
  const fly = world.flies[world.selected];
  const n = frame++; // read once: checking frame after the ++ only ever saw odd numbers
  if (!fly || n % 2) return;

  const d = fly.vision.drive;
  set(eyeRows.loom.L, d.loomL / 0.8); set(eyeRows.loom.R, d.loomR / 0.8);
  set(eyeRows.threat.L, d.threatL / 0.8); set(eyeRows.threat.R, d.threatR / 0.8);
  set(eyeRows.small.L, d.smallL / 0.8); set(eyeRows.small.R, d.smallR / 0.8);
  set(eyeRows.chase.L, d.chaseL / 0.8); set(eyeRows.chase.R, d.chaseR / 0.8);

  for (const r of ornRows) {
    const [l, right] = fly.smell.drive[r.type];
    set(r.bars.L, l / 0.5);
    set(r.bars.R, right / 0.5);
  }
  set(mechRows.jo.L, fly.mech.jo[0] / 0.8); set(mechRows.jo.R, fly.mech.jo[1] / 0.8);
  set(mechRows.leg.L, fly.mech.leg[0] / 0.8); set(mechRows.leg.R, fly.mech.leg[1] / 0.8);
  set(mechRows.load.L, fly.mech.load[0] / 0.8); set(mechRows.load.R, fly.mech.load[1] / 0.8);
  set(mechRows.taste.L, fly.mech.taste / 0.8);
  set(mechRows.flow.L, fly.mech.flow / 0.8);

  for (const r of rateRows) {
    set(r.bars.L, fly.brain.rate[r.iL] / 25);
    set(r.bars.R, fly.brain.rate[r.iR] / 25);
  }

  const dn = fly.dn;
  set(dnRows.turn.L, Math.max(0, -dn.turn) * 6);
  set(dnRows.turn.R, Math.max(0, dn.turn) * 6);
  set(dnRows.thrust.L, dn.thrust * 4);
  set(dnRows.back.L, dn.back * 4);
  set(dnRows.escape.L, dn.escape * 4);

  const m = fly.motor;
  set(mnRows.dlm.L, world.pair("DLM MN", fly) * 3);
  set(mnRows.b1.L, (world.rate("b1 MN", "L", fly) + world.rate("b2 MN", "L", fly)) * 1.6);
  set(mnRows.b1.R, (world.rate("b1 MN", "R", fly) + world.rate("b2 MN", "R", fly)) * 1.6);
  set(mnRows.jump.L, (world.rate("Ti extensor MN", "L", fly) + world.rate("Sternotrochanter MN", "L", fly)) * 1.6);
  set(mnRows.jump.R, (world.rate("Ti extensor MN", "R", fly) + world.rate("Sternotrochanter MN", "R", fly)) * 1.6);
  set(mnRows.flex.L, m.back * 4);

  motorText.textContent =
    `DLM ${(m.thrust * MOTOR.maxRate).toFixed(1)} Hz → lift ${(MOTOR.lift * m.thrust).toFixed(1)} m/s² ` +
    `(gravity ${MOTOR.gravity}) · turn ${(m.turn * MOTOR.turn).toFixed(2)} rad/s · ` +
    `speed ${fly.speed.toFixed(1)} m/s · height ${fly.y.toFixed(1)} m · ${fly.state}`;

  const parents = fly.mother !== null
    ? ` · child of ${world.log.lineage.get(fly.mother)?.name ?? "?"} & ${world.log.lineage.get(fly.father ?? -1)?.name ?? "?"}`
    : " · founder";
  $("flyid").textContent =
    `${fly.name} ${fly.sex} · gen ${fly.generation}${parents} · ${fly.age.toFixed(0)}s old${fly.mated ? " · mated" : ""}` +
    ` · brain changed ${(fly.brain.drift() * 100).toFixed(1)}%` +
    `${fly.courting > 4 ? " · P1 " + fly.courting.toFixed(0) + " Hz" : ""}`;
  $("stats").textContent =
    `${world.clock} ${PHASE(world.timeOfDay)} · ${world.flies.length} flies × ${world.wiring.n} neurons (${world.wiring.nnz} synapses each) · ` +
    `${fps.toFixed(0)} fps · brain step ${simMs.toFixed(2)} ms · ${world.field.puffCount} odour puffs · ` +
    `wind ${world.wind.strength.toFixed(1)} m/s · ${world.matings} matings, ${world.eggsLaid} eggs, ` +
    `${world.hatched} hatched · deaths: ${world.deaths.age} old, ${world.deaths.starved} starved, ` +
    `${world.deaths.eaten} eaten, ${world.deaths.swatted} swatted`;

  if (n % 30 === 0) updateBoard();
  if (n % 60 === 0) updatePopulation();
  if (n % 60 === 30) dataPanel.update();
  if (n % 10 === 0) updateFeed();
}

function updateWiz(): void {
  $("wizstatus").textContent = wiz.status;
  if (!wiz.ready) return;
  const hz = (name: string) => wiz.rate(name) / 25;
  const p = wiz.pull;
  set(wizRows.arms.L, p.armL / 1.5); set(wizRows.arms.R, p.armR / 1.5);
  set(wizRows.legs.L, p.legL / 1.5); set(wizRows.legs.R, p.legR / 1.5);
  set(wizRows.head.L, Math.max(0, p.head)); set(wizRows.head.R, Math.max(0, -p.head));
  set(wizRows.steer.L, hz("DNa02 L")); set(wizRows.steer.R, hz("DNa02 R"));
  set(wizRows.escape.L, hz("DNp01 L")); set(wizRows.escape.R, hz("DNp01 R"));
  const realtime = Math.min(1, 20 / Math.max(20, wiz.ms));
  const doing: Record<string, string> = {
    stand: "working out how legs work", walk: "trying to walk", stumble: "losing his balance", fallen: "fell over", getup: "getting up",
  };
  wizText.textContent =
    `${doing[wiz.mode]} · fallen ${wiz.falls}× · ${wiz.fired.toLocaleString()} neurons fired this step · ` +
    `${wiz.ms.toFixed(1)} ms/step (${(realtime * 100).toFixed(0)}% real time)`;
}

// --- population graph: the ecology over the last 5 minutes -------------------
// world.history is [adults, eggs+larvae], one sample per second, capped at 300.
const POP_W = 470;
const POP_H = 120;
const popCanvas = $<HTMLCanvasElement>("popgraph");
popCanvas.width = POP_W;
popCanvas.height = POP_H;
const popCtx = popCanvas.getContext("2d")!;

function drawPopulation(): void {
  const h = world.history;
  const g = popCtx;
  g.fillStyle = "#0a0d12";
  g.fillRect(0, 0, POP_W, POP_H);

  let peak = 4;
  for (const [a, l] of h) peak = Math.max(peak, a, l);
  const top = Math.ceil(peak / 5) * 5;

  // gridlines, one per 5 flies
  g.strokeStyle = "#161b23";
  g.fillStyle = "#4a5666";
  g.font = "9px ui-monospace, monospace";
  g.lineWidth = 1;
  for (let v = 0; v <= top; v += 5) {
    const y = Math.round(POP_H - 12 - (POP_H - 20) * (v / top)) + 0.5;
    g.beginPath();
    g.moveTo(0, y);
    g.lineTo(POP_W, y);
    g.stroke();
    if (v > 0) g.fillText(String(v), 2, y - 2);
  }

  if (h.length < 2) {
    g.fillStyle = "#4a5666";
    g.fillText("waiting for the first minute…", 8, POP_H / 2);
    return;
  }

  const x = (i: number) => (POP_W * i) / Math.max(1, h.length - 1);
  const y = (v: number) => POP_H - 12 - (POP_H - 20) * (v / top);

  const series = (pick: (s: [number, number]) => number, color: string, fill: string) => {
    g.beginPath();
    g.moveTo(x(0), y(pick(h[0])));
    for (let i = 1; i < h.length; i++) g.lineTo(x(i), y(pick(h[i])));
    g.strokeStyle = color;
    g.lineWidth = 1.5;
    g.stroke();
    g.lineTo(x(h.length - 1), POP_H - 12);
    g.lineTo(x(0), POP_H - 12);
    g.closePath();
    g.fillStyle = fill;
    g.fill();
  };
  series((s) => s[1], "#ffb23e", "rgba(255,178,62,0.10)");
  series((s) => s[0], "#6cf08a", "rgba(108,240,138,0.12)");

  // time axis: the window is history.length seconds, oldest on the left
  g.fillStyle = "#4a5666";
  g.fillText(`-${h.length}s`, 2, POP_H - 2);
  g.fillText("now", POP_W - 20, POP_H - 2);
}

function updateFeed(): void {
  $("clock").textContent = `${world.clock} · ${PHASE(world.timeOfDay)}`;
  const recent = world.events.slice(-6).reverse();
  if (!recent.length) {
    $("feed").innerHTML = `<div class="feed-empty">nothing yet — mating, eggs, meals,
      spider strikes and deaths appear here and over the fly they happened to.</div>`;
    return;
  }
  $("feed").innerHTML = recent.map((e) =>
    `<div class="feed-row ${e.kind}"><i>${EVENT_FACE[e.kind]}</i><span>${e.text}</span>` +
    `<span>${e.age < 1 ? "now" : e.age.toFixed(0) + "s ago"}</span></div>`).join("");
}

function updatePopulation(): void {
  drawPopulation();
  const males = world.flies.filter((f) => f.sex === "M").length;
  const brood = world.props.filter((p) => p.kind === "egg" || p.kind === "larva").length;
  const meanAge = world.flies.reduce((s, f) => s + f.age, 0) / Math.max(1, world.flies.length);
  const d = world.deaths;
  $("popnow").textContent = `${world.flies.length} adults · ${brood} brood`;
  $("popstats").innerHTML =
    `<span>adults <b>${world.flies.length}</b> (${males}M / ${world.flies.length - males}F)</span>` +
    `<span>mean age <b>${meanAge.toFixed(0)}s</b></span>` +
    `<span>matings <b>${world.matings}</b> · eggs <b>${world.eggsLaid}</b></span>` +
    `<span>hatched <b>${world.hatched}</b></span>` +
    `<span>died old <b>${d.age}</b> · starved <b>${d.starved}</b></span>` +
    `<span>eaten <b>${d.eaten}</b> · swatted <b>${d.swatted}</b></span>`;
}

function updateBoard(): void {
  const best = [...world.flies].sort((a, b) => b.stats.fed - a.stats.fed).slice(0, 5);
  const row = (i: number, f: Fly) =>
    `<div class="board-row"><span>${i + 1}</span><b>${f.name}</b>` +
    `<span>${(f.stats.fed * DT).toFixed(0)}s fed · ${f.stats.distance.toFixed(0)}m</span>` +
    `<span>${f.stats.panics} panics${f.stats.swatted ? " · swatted" : ""}</span></div>`;
  $("board").innerHTML = best.map((f, i) => row(i, f)).join("");
}

if (import.meta.env.DEV) {
  (window as unknown as { __fly: unknown }).__fly = { world, renderer, brainView, wiz, wizView };
}

requestAnimationFrame(tick);
