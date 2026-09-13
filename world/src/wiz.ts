/**
 * Wiz: a monkey wizard puppeted by the real fruit fly connectome (166,700 neurons, run in
 * connectome.worker.ts). A fly brain trying to work a monkey.
 *
 * What is coded and what is brain, plainly:
 *  - CODED: only the wish to wander (a random spot to head for, or a pause).
 *  - PROCEDURAL BODY: an under-damped balance wobble, feet that stay planted until the hips leave them
 *    behind and then step toward where he is tipping, falling when the lean passes the point of no
 *    return (then toppling like a pendulum), springs for everything else. wizview.ts puts the feet and
 *    hands where this says with two-bone IK.
 *  - BRAIN IN: his eyes run the flies' own Vision geometry into LPLC2, LC4, LPLC1 and LC10a; each real
 *    footfall touches SNta, and lying down touches both soles. The world's +X side is his anatomical
 *    left, so Vision's "R" goes to the connectome's left neurons.
 *  - BRAIN OUT, the strings: descending neurons that really fire for those senses (wiz/dnscreen.json).
 *    Looming/threat DNs (DNp02/03/04/11, DNg40) raise the arms, touch DNs (DNge104/122, DNg20, DNge102)
 *    kick a foot into a misstep, DNa05/07, DNg111, DNae002 turn the head, DNa02 steers, DNp01 (giant
 *    fibre) hops. No DN he can drive is a walking command (wiz/dnscreen.py), and DNs do not reach this
 *    model's motor neurons (wiz/vnc*.py), which is why the wish to walk is coded.
 */
import { Vision } from "./eyes.ts";
import { WORLD_RADIUS, type World } from "./sim.ts";

export const WIZ = {
  height: 9, // metres; flies are ~0.5 m in this world
  eyeFrac: 0.62,
  // strings
  restHz: 0.6, // descending neurons idle at 0-0.9 Hz
  fullHz: 20, // looming drives DNp01 to ~19-25 Hz
  stringHz: 10, // a string rate this far above rest pulls it all the way
  twitch: 0.03, // pull per spike on a string
  turnDeadHz: 1.0,
  turnPerHz: 0.2,
  jumpAt: 0.35,
  jump: 5,
  gravity: 20,
  // body, measured off the rig at 9 m tall
  hipX: 0.7,
  legLen: 0.84,
  // walking
  walk: 0.75, // m/s at best
  accel: 0.8,
  turnRate: 0.7,
  stepAt: 0.3, // a foot this far from where it should be takes a step
  stepTime: 0.36,
  lead: 0.35, // plant ahead of the hips by speed * lead
  capture: 1.6, // and toward where he is tipping by lean * capture
  // balance: an under-damped spring, so he wobbles
  leanK: 5,
  leanC: 2.2,
  sway: 6, // random wobble while walking
  catch: 0.7, // how much wobble speed survives planting a foot
  kickAt: 0.07, // spikes x twitch in one step that kick a foot out
  kick: 1.3, // how hard a kick unbalances him
  fallLean: 0.38, // radians of lean he cannot come back from
  topple: 2.4, // g / height, for the fall
  touch: 0.5, // SNta voltage while a sole touches the ground
  touchSteps: 4,
};

export type WizMode = "stand" | "walk" | "stumble" | "fallen" | "getup";

export interface WizFoot { x: number; z: number; y: number; lift: number }

interface Swing { fx: number; fz: number; tx: number; tz: number; t: number }

/** A critically damped spring: moves toward its target smoothly, never overshooting. */
export class Spring {
  x: number;
  v = 0;
  constructor(x = 0) { this.x = x; }
  to(target: number, omega: number, dt: number): number {
    const f = 1 + 2 * dt * omega, oo = omega * omega, hoo = dt * oo, hhoo = dt * hoo;
    const det = 1 / (f + hhoo);
    const x = (f * this.x + dt * this.v + hhoo * target) * det;
    this.v = (this.v + hoo * (target - this.x)) * det;
    this.x = x;
    return x;
  }
}

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

export class Wiz {
  readonly id = -7;
  x = 0; z = -WORLD_RADIUS * 0.35; y = 0; vy = 0; yaw = 0; speed = 0;
  t = 0;
  mode: WizMode = "stand";
  modeT = 0;
  falls = 0;
  /** balance: lean forward (+pitch) and toward his left (+roll), radians */
  pitch = 0; roll = 0;
  private pitchV = 0; private rollV = 0;
  private yawRate = new Spring();
  /** falling over: angle from upright, and which way (0 front, +pi/2 his left) */
  tilt = 0; fallDir = 0;
  private tiltV = 0;
  private downFor = 3;
  private rise = new Spring();
  /** 0 left, 1 right; world positions */
  feet: [WizFoot, WizFoot];
  private swings: (Swing | null)[] = [null, null];
  private soles = [0, 0];
  crouch = new Spring();
  armUp = [new Spring(), new Spring()];
  head = new Spring();
  /** decoded from the brain */
  turn = 0; escape = 0;
  pull = { armL: 0, armR: 0, legL: 0, legR: 0, head: 0 };
  private kickCool = [0, 0];
  private jumpCool = 0;
  private target = { x: 0, z: 0 };
  private wanderT = 0;

  summoned = false;
  ready = false;
  status = "asleep";
  outputs: string[] = [];
  hz = new Map<string, number>();
  private hits = new Map<string, number>();
  fired = 0; ms = 0; brainSteps = 0;
  private worker: Worker | null = null;
  private vision: Vision;

  constructor(world: World) {
    this.vision = new Vision(world.wiring);
    this.target = { x: this.x, z: this.z };
    this.feet = [this.spotFoot(0), this.spotFoot(1)];
  }

  summon(base: string): void {
    if (this.worker) return;
    this.summoned = true;
    this.status = "loading";
    this.worker = new Worker(new URL("./connectome.worker.ts", import.meta.url), { type: "module" });
    this.worker.onmessage = (e: MessageEvent) => {
      const m = e.data;
      if (m.type === "progress") this.status = m.text;
      else if (m.type === "error") this.status = "failed: " + m.text;
      else if (m.type === "ready") {
        this.outputs = m.outputs;
        this.ready = true;
        this.status = `${m.n.toLocaleString()} neurons · ${(m.nnz / 1e6).toFixed(1)} M synapses`;
      } else if (m.type === "rates") {
        m.hz.forEach((v: number, i: number) => this.hz.set(this.outputs[i], v));
        m.hits.forEach((v: number, i: number) => this.hits.set(this.outputs[i], (this.hits.get(this.outputs[i]) ?? 0) + v));
        this.fired = m.fired;
        this.ms = m.ms;
        this.brainSteps = m.steps;
      }
    };
    this.worker.postMessage({ type: "load", base });
  }

  rate(name: string): number {
    return this.hz.get(name) ?? 0;
  }

  /** spikes on a group since the last call */
  private take(name: string): number {
    const v = this.hits.get(name) ?? 0;
    this.hits.set(name, 0);
    return v;
  }

  private setMode(mode: WizMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    this.modeT = 0;
  }

  /** where foot s (0 left, 1 right) wants to be: under its hip, ahead by speed, toward the tip */
  private spotFoot(s: number, offFwd = 0, offSide = 0): WizFoot {
    const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
    const lx = Math.cos(this.yaw), lz = -Math.sin(this.yaw);
    const side = (s === 0 ? 1 : -1) * WIZ.hipX + this.roll * WIZ.capture + offSide;
    const ahead = this.speed * WIZ.lead + this.pitch * WIZ.capture + offFwd;
    return { x: this.x + lx * side + fx * ahead, z: this.z + lz * side + fz * ahead, y: 0, lift: 0 };
  }

  private startStep(s: number, offFwd = 0, offSide = 0): void {
    const to = this.spotFoot(s, offFwd, offSide);
    const f = this.feet[s];
    this.swings[s] = { fx: f.x, fz: f.z, tx: to.x, tz: to.z, t: 0 };
  }

  private stepFeet(dt: number): void {
    for (let s = 0; s < 2; s++) {
      const sw = this.swings[s];
      if (!sw) continue;
      sw.t = Math.min(1, sw.t + dt / WIZ.stepTime);
      const e = sw.t * sw.t * (3 - 2 * sw.t);
      const f = this.feet[s];
      f.x = sw.fx + (sw.tx - sw.fx) * e;
      f.z = sw.fz + (sw.tz - sw.fz) * e;
      f.lift = Math.sin(Math.PI * sw.t);
      if (sw.t >= 1) {
        this.swings[s] = null;
        f.lift = 0;
        this.soles[s] = WIZ.touchSteps; // a real footfall: the sole touches down
        this.pitchV *= WIZ.catch; // planting a foot catches some of the wobble
        this.rollV *= WIZ.catch;
      }
    }
    if (this.swings[0] || this.swings[1]) return;
    let best = -1, far = 0;
    for (let s = 0; s < 2; s++) {
      const want = this.spotFoot(s);
      const d = Math.hypot(this.feet[s].x - want.x, this.feet[s].z - want.z);
      if (d > far) { far = d; best = s; }
    }
    const moving = this.speed > 0.08 || Math.hypot(this.pitch, this.roll) > 0.12;
    if (best >= 0 && far > (moving ? WIZ.stepAt : WIZ.stepAt * 1.8)) this.startStep(best);
  }

  step(world: World, dt: number): void {
    if (!this.summoned) { world.giant = null; return; }
    this.t += dt;
    world.giant = { id: this.id, x: this.x, y: this.y + WIZ.height * 0.5 * Math.cos(Math.min(1.4, this.tilt)), z: this.z,
      radius: WIZ.height * 0.28, kind: "giant" };
    if (!this.ready || !this.worker) return;

    // ---- senses in ------------------------------------------------------------
    const eyeY = this.y + WIZ.height * WIZ.eyeFrac * Math.cos(Math.min(1.4, this.tilt));
    this.vision.measure(this.x, eyeY, this.z, this.yaw, world.visible, this.id, world.daylight);
    const d = this.vision.drive;
    const lying = this.tilt > 1;
    const touchL = lying || this.soles[0] > 0 ? WIZ.touch : 0;
    const touchR = lying || this.soles[1] > 0 ? WIZ.touch : 0;
    this.soles[0] = Math.max(0, this.soles[0] - 1);
    this.soles[1] = Math.max(0, this.soles[1] - 1);
    this.worker.postMessage({ type: "input", drive: {
      LPLC2_L: d.loomR, LPLC2_R: d.loomL, LC4_L: d.threatR, LC4_R: d.threatL,
      LPLC1_L: d.smallR, LPLC1_R: d.smallL, LC10a_L: d.chaseR, LC10a_R: d.chaseL,
      SNta_L: touchL, SNta_R: touchR,
    } });

    // ---- strings out ------------------------------------------------------------
    const above = (hz: number, full: number) => Math.max(0, hz - WIZ.restHz) / full;
    const k = Math.min(1, 4 * dt);
    const pull = this.pull;
    const kicks = [0, 0];
    const strings = [["armL", "arm pull L"], ["armR", "arm pull R"], ["legL", "leg kick L"], ["legR", "leg kick R"]] as const;
    strings.forEach(([key, group], i) => {
      const spikes = this.take(group);
      if (i >= 2) kicks[i - 2] = spikes;
      const target = Math.min(1.5, above(this.rate(group), WIZ.stringHz));
      pull[key] = Math.min(2, pull[key] + (target - pull[key]) * k + spikes * WIZ.twitch);
    });
    const headTarget = clamp((this.rate("head tug L") - this.rate("head tug R")) / WIZ.stringHz, -1, 1);
    pull.head += (headTarget - pull.head) * k + (this.take("head tug L") - this.take("head tug R")) * WIZ.twitch;
    this.escape = Math.min(1, above((this.rate("DNp01 L") + this.rate("DNp01 R")) * 0.5, WIZ.fullHz));
    const diff = this.rate("DNa02 L") - this.rate("DNa02 R");
    this.turn = Math.sign(diff) * Math.max(0, Math.abs(diff) - WIZ.turnDeadHz) * WIZ.turnPerHz;

    // ---- body ---------------------------------------------------------------------
    this.modeT += dt;
    const upright = this.mode !== "fallen" && this.mode !== "getup";
    const grounded = this.y <= 0;
    this.jumpCool -= dt;

    if (upright) {
      // the coded wish: somewhere to go, or a pause
      this.wanderT -= dt;
      if (this.wanderT <= 0) {
        if (Math.random() < 0.3) {
          this.target = { x: this.x, z: this.z };
          this.wanderT = 2 + Math.random() * 3;
        } else {
          const a = Math.random() * Math.PI * 2, r = Math.random() * (WORLD_RADIUS - 10);
          this.target = { x: Math.cos(a) * r, z: Math.sin(a) * r };
          this.wanderT = 8 + Math.random() * 10;
        }
      }
      const dx = this.target.x - this.x, dz = this.target.z - this.z;
      const dist = Math.hypot(dx, dz);
      const err = wrap(Math.atan2(dx, dz) - this.yaw);
      const turnWant = (dist > 1 ? clamp(err * 1.2, -WIZ.turnRate, WIZ.turnRate) : 0) + this.turn;
      this.yaw += this.yawRate.to(turnWant, 2.5, dt) * dt;

      const lean = Math.hypot(this.pitch, this.roll);
      const wobbly = Math.min(1, lean / WIZ.fallLean);
      const speedWant = (dist > 1 ? WIZ.walk * Math.min(1, dist / 3) : 0) * Math.max(0, Math.cos(err)) * (1 - 0.85 * wobbly);
      const before = this.speed;
      this.speed += clamp(speedWant - this.speed, -WIZ.accel * dt, WIZ.accel * dt);
      const accel = (this.speed - before) / dt;

      // balance: lean into walking, lag behind speeding up, lean out of turns, a little sway
      const pitchRest = this.speed * 0.1 - accel * 0.15 - (pull.armL + pull.armR) * 0.06;
      const rollRest = -this.yawRate.x * this.speed * 0.3;
      this.pitchV += (-WIZ.leanK * (this.pitch - pitchRest) - WIZ.leanC * this.pitchV) * dt;
      this.rollV += (-WIZ.leanK * (this.roll - rollRest) - WIZ.leanC * this.rollV + (Math.random() - 0.5) * WIZ.sway * this.speed) * dt;
      this.pitch += this.pitchV * dt;
      this.roll += this.rollV * dt;

      // brain: the giant fibre hops him
      if (grounded && this.escape > WIZ.jumpAt && this.jumpCool <= 0) {
        this.vy = WIZ.jump * this.escape;
        this.jumpCool = 1.5;
        this.pitchV -= 0.6;
      }
      // brain: a burst on a leg string kicks that foot out into a misstep
      for (let s = 0; s < 2; s++) {
        this.kickCool[s] -= dt;
        if (kicks[s] * WIZ.twitch > WIZ.kickAt && this.kickCool[s] <= 0 && grounded && !this.swings[s]) {
          this.startStep(s, (Math.random() - 0.3) * 0.7, (s === 0 ? 1 : -1) * Math.random() * 0.6);
          this.rollV += (s === 0 ? 1 : -1) * WIZ.kick;
          this.pitchV += (Math.random() - 0.5) * WIZ.kick * 1.2;
          this.kickCool[s] = 0.8;
        }
      }

      this.setMode(lean > 0.25 ? "stumble" : this.speed > 0.12 ? "walk" : "stand");
      if (lean > WIZ.fallLean) {
        // past the point of no return
        this.fallDir = Math.atan2(this.roll, this.pitch);
        this.tilt = lean;
        this.tiltV = Math.max(0.2, (this.pitchV * this.pitch + this.rollV * this.roll) / lean);
        this.pitch = this.roll = this.pitchV = this.rollV = 0;
        this.falls++;
        this.downFor = 2.5 + Math.random() * 2.5;
        this.setMode("fallen");
      }
      if (grounded) this.stepFeet(dt);
    } else if (this.mode === "fallen") {
      // topple like a pendulum until the ground stops him, with a small bounce
      this.tiltV += WIZ.topple * Math.sin(this.tilt) * dt;
      this.tilt += this.tiltV * dt;
      if (this.tilt > 1.5) { this.tilt = 1.5; this.tiltV = -Math.abs(this.tiltV) * 0.25; }
      this.speed *= Math.exp(-4 * dt);
      if (this.modeT > this.downFor) {
        this.rise.x = this.tilt;
        this.rise.v = 0;
        this.setMode("getup");
      }
    } else {
      this.tilt = this.rise.to(0, 1.6, dt);
      this.speed = 0;
      if (this.tilt < 0.03) {
        this.tilt = 0;
        this.feet = [this.spotFoot(0), this.spotFoot(1)];
        this.swings = [null, null];
        this.wanderT = 1 + Math.random() * 2;
        this.target = { x: this.x, z: this.z };
        this.setMode("stand");
      }
    }

    // ---- vertical, position, bumps -------------------------------------------------
    const wasAir = this.y > 0;
    this.vy -= WIZ.gravity * dt;
    this.y += this.vy * dt;
    if (this.y < 0) {
      if (wasAir && upright) { // a clumsy landing
        this.pitchV += (Math.random() - 0.5) * 3.5;
        this.rollV += (Math.random() - 0.5) * 3.5;
      }
      this.y = 0;
      this.vy = 0;
    }
    const mx = Math.sin(this.yaw) * this.speed * dt, mz = Math.cos(this.yaw) * this.speed * dt;
    this.x += mx;
    this.z += mz;
    if (!grounded) for (const f of this.feet) { f.x += mx; f.z += mz; }
    for (const f of this.feet) f.y = this.y;
    for (const p of world.props) {
      if (p.kind !== "obstacle") continue;
      const dx = this.x - p.x, dz = this.z - p.z, dist = Math.hypot(dx, dz), min = p.radius + 1.2;
      if (dist < min && dist > 1e-4) {
        this.x = p.x + (dx / dist) * min;
        this.z = p.z + (dz / dist) * min;
        if (upright && this.speed > 0.2) { this.pitchV -= 1.4 * this.speed; this.speed *= -0.3; } // bonk
      }
    }
    const r = Math.hypot(this.x, this.z), max = WORLD_RADIUS - 5;
    if (r > max) { this.x *= max / r; this.z *= max / r; this.target = { x: 0, z: 0 }; }

    // ---- smoothed limbs for the view ---------------------------------------------------
    this.crouch.to(Math.min(1, this.escape * 0.8 + (this.y > 0 ? 0.3 : 0)), 4, dt);
    // arms: strings raise them, the giant fibre throws both up, a lean throws the other arm out
    this.armUp[0].to(Math.min(1.4, pull.armL * 1.8 + this.escape * 1.1 + Math.max(0, -this.roll) * 3), 3.2, dt);
    this.armUp[1].to(Math.min(1.4, pull.armR * 1.8 + this.escape * 1.1 + Math.max(0, this.roll) * 3), 3.2, dt);
    const look = (d.loomR + d.threatR + d.smallR - d.loomL - d.threatL - d.smallL) * 0.8;
    this.head.to(clamp(pull.head * 0.8 + this.turn * 0.5 + look, -0.9, 0.9), 2.5, dt);
  }
}
