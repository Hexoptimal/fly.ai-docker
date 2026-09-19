/**
 * Flinder's date night: the two cartoon flies on a giant banana under a candle. How the date goes is decided by
 * their brains (readout.ts dateEnd); this only acts it out: fly off together, one bails, they groom, or awkward.
 */
import * as THREE from "three";
import { Fly, inked, toon } from "../roulette/scene.ts";
import type { DateEnd } from "./readout.ts";

export class DateNight {
  readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(38, 3 / 4, 0.1, 60);
  private flies: Fly[] = [];
  private clock = new THREE.Clock();
  private flame: THREE.Mesh;

  constructor() {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(2, devicePixelRatio));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.domElement.className = "date-canvas";
    this.scene.background = new THREE.Color(0x2a1030);
    const banana = inked(new THREE.CapsuleGeometry(0.5, 3.4, 8, 20), toon(0xffe14d), 0.03);
    banana.rotation.set(0, 0.25, Math.PI / 2);
    banana.position.set(0, -0.2, -0.2);
    banana.scale.set(1, 1, 0.75);
    for (const s of [-1, 1]) {                           // brown tips
      const tip = new THREE.Mesh(new THREE.SphereGeometry(0.18, 10, 8), toon(0x5a3a12));
      tip.position.set(s * 2.25 * Math.cos(0.25), -0.2, -0.2 - s * 2.25 * Math.sin(0.25));
      this.scene.add(tip);
    }
    this.scene.add(banana);
    const candle = inked(new THREE.CylinderGeometry(0.12, 0.12, 0.6, 12), toon(0xfff6e0), 0.06);
    candle.position.set(0, 0.5, -0.45);
    this.scene.add(candle);
    this.flame = new THREE.Mesh(new THREE.SphereGeometry(0.09, 10, 8), new THREE.MeshBasicMaterial({ color: 0xffb13d }));
    this.flame.scale.set(1, 1.8, 1);
    this.flame.position.set(0, 0.9, -0.45);
    this.scene.add(this.flame);
    const glow = new THREE.PointLight(0xffb13d, 6, 6);
    glow.position.set(0, 1.2, -0.4);
    this.scene.add(glow, new THREE.HemisphereLight(0xffd6f0, 0x331122, 1.6));
    const key = new THREE.DirectionalLight(0xffffff, 1.2);
    key.position.set(2, 5, 4);
    this.scene.add(key);
    // stars
    const stars = new THREE.BufferGeometry();
    const pts: number[] = [];
    for (let k = 0; k < 120; k++) pts.push((Math.random() - 0.5) * 30, Math.random() * 12 + 1, -8 - Math.random() * 6);
    stars.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
    this.scene.add(new THREE.Points(stars, new THREE.PointsMaterial({ color: 0xffffff, size: 0.08 })));
    this.camera.position.set(0, 2.6, 8.2);
    this.camera.lookAt(0, 0.9, 0);
  }

  size(w: number, h: number): void {
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** Acts out the date over `ms` (already scaled for speed). Resolves when it's over. */
  play(a: string, b: string, end: DateEnd, ms: number): Promise<void> {
    for (const f of this.flies) this.scene.remove(f.root);
    this.flies = [new Fly(a), new Fly(b)];
    this.flies.forEach((f, i) => {
      f.root.position.set(i ? 0.75 : -0.75, 0.2, 0);
      f.root.rotation.y = i ? -1.1 : 1.1;              // facing each other
      f.root.scale.setScalar(0.8);
      this.scene.add(f.root);
    });
    const [fa, fb] = this.flies;
    const t0 = performance.now();
    this.clock.getDelta();
    return new Promise((resolve) => {
      const step = () => {
        const p = Math.min(1, (performance.now() - t0) / ms);
        const dt = Math.min(0.05, this.clock.getDelta()), t = performance.now() / 1000;
        const act = Math.max(0, (p - 0.25) / 0.75);    // a moment of staring first
        if (end === "together") {
          for (const [i, f] of this.flies.entries()) {
            f.flap = act > 0 ? 1 : 0;
            const s = i ? 1 : -1;
            f.root.position.set(s * 0.75 * (1 - act) + Math.sin(act * 9 + i * Math.PI) * act * 0.6, 0.2 + act * 4, -act * 2);
            f.root.rotation.y = s * -1.1 * (1 - act) + act * t * 4;
          }
        } else if (end === "bailed") {
          fb.flap = act > 0 ? 1 : 0;
          fb.root.position.set(0.75 + act * act * 7, 0.2 + act * 2.5, act * 1.5);
          fb.root.rotation.y = -1.1 + act * 2.6;
          fa.sweat.visible = act > 0.3;
          fa.body.rotation.x = act * 0.35;             // head hangs
          fa.root.rotation.y = 1.1 - act * 0.6;
        } else if (end === "groomed") {
          for (const f of this.flies) for (const leg of f.frontLegs) {
            const s = leg.userData.side as number;
            leg.rotation.x = act > 0 ? -1.35 : -0.9;
            leg.rotation.z = act > 0 ? 0.25 * s + Math.sin(t * 22 + s) * 0.18 : 0.7 * s;
          }
          fa.root.position.x = -0.75 + act * 0.3; fb.root.position.x = 0.75 - act * 0.3;
        } else {
          fa.root.rotation.y = 1.1 - act * 2.8;          // both slowly turn away
          fb.root.rotation.y = -1.1 + act * 2.8;
        }
        this.flame.scale.set(1 + Math.sin(t * 20) * 0.1, 1.8 + Math.sin(t * 13) * 0.25, 1);
        for (const f of this.flies) f.tick(t, dt, end === "awkward" || end === "bailed" ? null : this.camera.position);
        this.renderer.render(this.scene, this.camera);
        if (p < 1) requestAnimationFrame(step); else resolve();
      };
      requestAnimationFrame(step);
    });
  }
}
