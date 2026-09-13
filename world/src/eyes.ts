/**
 * What a fly sees, and how that reaches the brain. Both routes from flybrain/eyes.py:
 *
 *  1. Eyes: a 1-D luminance panorama over azimuth (-1 far left .. +1 far right),
 *     projected onto the R1-6 photoreceptors, drive = 0.45*lum + 1.6*|change|.
 *     Photoreceptors are inhibitory here, as in the real fly.
 *  2. Feature detectors: drive the visual projection neuron types directly, on
 *     the side where things are -- the route that actually works in the Python.
 *       LPLC2 looming, LC4 fast looming / threat, LPLC1 small approaching
 *       objects, LC10a the target the fly tracks.
 *
 * Nothing here decides what the fly does. It only converts geometry into
 * voltage on named sensory neurons.
 */
import type { Brain } from "./brain.ts";
import type { Population, Wiring } from "./wiring.ts";

export type Kind = "fly" | "fruit" | "mould" | "carrion" | "dung" | "compost" | "plant" | "poop" | "spider" | "egg" | "larva" | "obstacle" | "threat";

export interface Seen {
  id: number;
  x: number;
  y: number;
  z: number;
  radius: number;
  kind: Kind;
}

/** Encoder parameters, same names as flybrain.eyes.ENCODER (values retuned for a
 *  50 Hz 3-D world instead of a 2-D game at frame rate). */
export const ENCODER = {
  loom_gain: 26.0, // angular growth per step -> LPLC2
  loom_size: 0.15, // angular size -> LPLC2 (looming cells also report size)
  chase_base: 0.08, // LC10a barely answers a distant target...
  chase_gain: 1.9, // ...it is angular size that drives it, so this is close range
  threat_max: 0.85, // LC4 when a threat is close and coming
  small_gain: 20.0, // small-object angular growth -> LPLC1
  cap: 0.8, // most voltage any channel adds in one step
  eye_gain: 0.62, // photoreceptor drive scale (flybrain.eye_gain)
};

export const FOV_HALF = 2.3; // radians either side of straight ahead
const MIN_DIST = 0.8;
const BACKGROUND = 0.9; // flybrain.eyes.BACKGROUND

const DARKNESS: Record<Kind, number> = {
  fly: 0.55, fruit: 0.5, mould: 0.5, carrion: 0.6, dung: 0.5, compost: 0.65,
  plant: 0.55, poop: 0.3, spider: 0.9, egg: 0.2, larva: 0.35, obstacle: 0.8, threat: 0.95,
};

/** Things a fly might land on and feed from: these are LC10a targets at close
 *  range, and they only loom weakly. Everything else is an obstacle. */
const TARGET: Partial<Record<Kind, boolean>> = {
  fruit: true, mould: true, carrion: true, dung: true, compost: true, poop: true,
};

export interface ChannelDrive {
  loomL: number; loomR: number;
  threatL: number; threatR: number;
  smallL: number; smallR: number;
  chaseL: number; chaseR: number;
}

const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x);

export class Vision {
  private prevAngle = new Map<number, number>();
  private seenNow = new Map<number, number>();
  private lum: Float32Array;
  private prevLum: Float32Array | null = null;
  readonly photo: { pop: Population; azimuth: Float32Array }[];
  readonly drive: ChannelDrive = {
    loomL: 0, loomR: 0, threatL: 0, threatR: 0, smallL: 0, smallR: 0, chaseL: 0, chaseR: 0,
  };

  private w: Wiring;

  constructor(wiring: Wiring) {
    const w = wiring;
    this.w = w;
    this.photo = (["L", "R"] as const).map((side) => {
      const pop = w.index.get("R1-6_" + side)!;
      const azimuth = new Float32Array(pop.count);
      for (let k = 0; k < pop.count; k++) {
        const t = (k + 0.5) / pop.count; // 0..1 across that eye
        azimuth[k] = side === "L" ? -1 + t : t;
      }
      return { pop, azimuth };
    });
    this.lum = new Float32Array(this.photo[0].pop.count * 2);
  }

  /**
   * Look around and inject. `objects` are everything visible; `self` is the
   * looking fly's position and heading (yaw, +Z forward at yaw 0).
   */
  look(brain: Brain, px: number, py: number, pz: number, yaw: number, objects: Seen[], selfId: number,
       daylight = 1): void {
    const d = this.drive;
    d.loomL = d.loomR = d.threatL = d.threatR = d.smallL = d.smallR = d.chaseL = d.chaseR = 0;
    this.seenNow.clear();
    // the sky is the background luminance, so night is genuinely darker to the
    // photoreceptors - there is no "it is night" flag anywhere in the brain
    const sky = BACKGROUND * daylight;
    this.lum.fill(sky);

    const cos = Math.cos(yaw), sin = Math.sin(yaw);
    const p = ENCODER;
    const half = this.photo[0].pop.count; // photoreceptors per eye

    for (const o of objects) {
      if (o.id === selfId) continue;
      const dx = o.x - px, dy = o.y - py, dz = o.z - pz;
      const dist = Math.hypot(dx, dy, dz);
      if (dist > 40) continue;
      // into the fly's frame: forward = +Z rotated by yaw, right = +X rotated
      const fwd = dx * sin + dz * cos;
      const right = dx * cos - dz * sin;
      const bearing = Math.atan2(right, fwd);
      if (Math.abs(bearing) > FOV_HALF) continue;

      const angle = (2 * o.radius) / Math.max(dist, MIN_DIST); // angular size
      const prev = this.prevAngle.get(o.id);
      this.seenNow.set(o.id, angle);
      const growth = Math.max(0, angle - (prev === undefined ? angle : prev));
      const side = bearing < 0 ? "L" : "R";

      // --- feature detectors -------------------------------------------------
      const loom = clamp(growth * p.loom_gain + angle * p.loom_size, 0, p.cap);
      // Any expanding surface drives LPLC2. A fruit only counts once it fills
      // a lot of the eye (under about 3.5 m) and then only weakly: enough to
      // slow the wings for a landing, not enough to read as an obstacle.
      if (!TARGET[o.kind]) {
        if (side === "L") d.loomL = Math.max(d.loomL, loom);
        else d.loomR = Math.max(d.loomR, loom);
      } else if (angle > 0.55) {
        const soft = loom * 0.45;
        if (side === "L") d.loomL = Math.max(d.loomL, soft);
        else d.loomR = Math.max(d.loomR, soft);
      }
      if (o.kind === "fly") {
        const small = clamp(growth * p.small_gain + angle * 0.25, 0, p.cap);
        if (side === "L") d.smallL = Math.max(d.smallL, small);
        else d.smallR = Math.max(d.smallR, small);
      }
      if (TARGET[o.kind]) {
        const chase = clamp(p.chase_base + p.chase_gain * angle, 0, p.cap);
        if (side === "L") d.chaseL = Math.max(d.chaseL, chase);
        else d.chaseR = Math.max(d.chaseR, chase);
      }
      if (o.kind === "threat") {
        const threat = clamp(p.threat_max * clamp(angle * 3 + growth * 20, 0, 1), 0, p.cap);
        if (side === "L") d.threatL = Math.max(d.threatL, threat);
        else d.threatR = Math.max(d.threatR, threat);
      }

      // --- panorama for the photoreceptors ----------------------------------
      const center = clamp(bearing / FOV_HALF, -1, 1);
      const width = clamp(angle * 0.5, 0.02, 0.7);
      const dark = sky * (1 - DARKNESS[o.kind]);
      const lo = Math.max(0, Math.floor(((center - width + 1) / 2) * this.lum.length));
      const hi = Math.min(this.lum.length - 1, Math.ceil(((center + width + 1) / 2) * this.lum.length));
      for (let i = lo; i <= hi; i++) if (dark < this.lum[i]) this.lum[i] = dark;
    }

    const tmp = this.prevAngle;
    this.prevAngle = this.seenNow;
    this.seenNow = tmp;

    // photoreceptors: luminance plus change, exactly flybrain.eyes.Eyes.drive
    if (!this.prevLum) this.prevLum = new Float32Array(this.lum);
    for (let s = 0; s < 2; s++) {
      const { pop } = this.photo[s];
      for (let k = 0; k < pop.count; k++) {
        const i = s * half + k;
        const change = Math.abs(this.lum[i] - this.prevLum[i]);
        const drive = clamp(0.45 * this.lum[i] + 1.6 * change, 0, 1) * p.eye_gain;
        brain.stimulateAt(pop.start + k, drive);
      }
    }
    this.prevLum.set(this.lum);

    // feature detectors, both sides
    const inject = (type: string, side: "L" | "R", amount: number) => {
      if (amount > 0) brain.stimulate(this.w.index.get(type + "_" + side)!, amount);
    };
    inject("LPLC2", "L", d.loomL);
    inject("LPLC2", "R", d.loomR);
    inject("LC4", "L", d.threatL);
    inject("LC4", "R", d.threatR);
    inject("LPLC1", "L", d.smallL);
    inject("LPLC1", "R", d.smallR);
    inject("LC10a", "L", d.chaseL);
    inject("LC10a", "R", d.chaseR);
  }
}
