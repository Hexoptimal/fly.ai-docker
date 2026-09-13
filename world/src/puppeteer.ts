/**
 * The puppeteer: a giant cartoon fruit fly hovering over Wiz, working a wooden control bar.
 * It is decoration, but its strings are the real ones from wiz.ts: each string lights up green as
 * the descending neurons that pull it fire, and the bar tips toward whichever strings are pulling.
 * Reads Wiz and WizView, never writes them.
 */
import * as THREE from "three";
import { Spring, type Wiz } from "./wiz.ts";
import type { WizView } from "./wizview.ts";

const S = 4.5; // times the size of a world fly (scene.ts builds those)
const HOVER = 11; // metres above his head bone (his neck), so the bar clears the hat
const THREAD = new THREE.Color(0xd9d2bf);
const FIRING = new THREE.Color(0x6cf08a);
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

interface PuppetString {
  mesh: THREE.Mesh;
  mat: THREE.MeshStandardMaterial;
  /** attachment on the control bar, in bar coordinates */
  from: THREE.Vector3;
  bone: string;
  pull: (w: Wiz) => number;
}

export class PuppeteerView {
  private group = new THREE.Group(); // follows him: position and yaw
  private body = new THREE.Group(); // the fly's own lean and hover
  private bar = new THREE.Group();
  private wings: THREE.Mesh[] = [];
  private strings: PuppetString[] = [];
  private px = new Spring(); private py = new Spring(); private pz = new Spring();
  private yaw = new Spring();
  private started = false;
  private a = new THREE.Vector3();
  private b = new THREE.Vector3();
  private dir = new THREE.Vector3();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private t = 0;

  constructor(scene: THREE.Scene) {
    this.group.visible = false;
    scene.add(this.group);
    this.group.add(this.body);

    const fly = new THREE.MeshStandardMaterial({ color: 0x6b6459, flatShading: true, roughness: 0.7 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x23211d, flatShading: true, roughness: 0.85 });
    const eye = new THREE.MeshStandardMaterial({ color: 0xd0322a, flatShading: true, roughness: 0.35, emissive: 0x2a0705 });
    const add = (geo: THREE.BufferGeometry, mat: THREE.Material, parent: THREE.Object3D = this.body) => {
      const m = new THREE.Mesh(geo, mat);
      parent.add(m);
      return m;
    };

    const thorax = new THREE.IcosahedronGeometry(0.26 * S, 1);
    thorax.scale(0.62, 0.58, 1.2);
    add(thorax, fly);
    const abdomen = new THREE.IcosahedronGeometry(0.24 * S, 1);
    abdomen.scale(0.72, 0.66, 1.35);
    abdomen.translate(0, -0.02 * S, -0.38 * S);
    add(abdomen, dark);
    const head = new THREE.IcosahedronGeometry(0.15 * S, 1);
    head.translate(0, 0.02 * S, 0.36 * S);
    add(head, fly);
    for (const side of [1, -1]) {
      const e = new THREE.IcosahedronGeometry(0.12 * S, 1);
      e.translate(side * 0.12 * S, 0.06 * S, 0.42 * S);
      add(e, eye);
    }
    const wingGeo = new THREE.PlaneGeometry(0.72 * S, 0.22 * S);
    wingGeo.rotateX(-Math.PI / 2);
    wingGeo.translate(0.36 * S, 0, -0.05 * S);
    const wingMat = new THREE.MeshStandardMaterial({
      color: 0xeaf7ff, transparent: true, opacity: 0.32, side: THREE.DoubleSide, roughness: 0.15, emissive: 0x16222b, depthWrite: false,
    });
    for (const side of [1, -1]) {
      const w = add(wingGeo, wingMat);
      w.position.y = 0.14 * S;
      w.scale.x = side;
      this.wings.push(w);
    }
    // six legs; the front four reach down to the control bar
    const legGeo = new THREE.CylinderGeometry(0.018 * S, 0.012 * S, 0.55 * S, 5);
    legGeo.translate(0, -0.275 * S, 0);
    for (const side of [1, -1]) {
      for (let i = 0; i < 3; i++) {
        const leg = add(legGeo, dark);
        leg.position.set(side * 0.1 * S, -0.1 * S, (0.12 - i * 0.14) * S);
        leg.rotation.set((1 - i) * 0.35, 0, side * (i === 2 ? 0.9 : 0.25));
      }
    }

    // the control bar: a wooden cross hanging under the front legs
    this.bar.position.set(0, -0.58 * S, 0.08 * S); // where the front legs end
    this.body.add(this.bar);
    const wood = new THREE.MeshStandardMaterial({ color: 0x8a5a2b, flatShading: true, roughness: 0.85 });
    add(new THREE.BoxGeometry(3.6, 0.16, 0.16), wood, this.bar);
    add(new THREE.BoxGeometry(0.16, 0.16, 2.8), wood, this.bar);

    const stringGeo = new THREE.CylinderGeometry(0.035, 0.035, 1, 6);
    stringGeo.translate(0, 0.5, 0); // base at the origin, one unit along +Y
    const spec: [THREE.Vector3, string, (w: Wiz) => number][] = [
      [new THREE.Vector3(1.8, 0, 0), "hand.L", (w) => w.pull.armL],
      [new THREE.Vector3(-1.8, 0, 0), "hand.R", (w) => w.pull.armR],
      [new THREE.Vector3(0.7, 0, -0.1), "shin.L", (w) => w.pull.legL],
      [new THREE.Vector3(-0.7, 0, -0.1), "shin.R", (w) => w.pull.legR],
      [new THREE.Vector3(0, 0, 1.4), "head", (w) => Math.abs(w.pull.head) * 2],
    ];
    for (const [from, bone, pull] of spec) {
      const mat = new THREE.MeshStandardMaterial({ color: THREAD.clone(), roughness: 0.6, emissive: 0x000000 });
      const mesh = new THREE.Mesh(stringGeo, mat);
      mesh.frustumCulled = false;
      mesh.visible = false;
      scene.add(mesh);
      this.strings.push({ mesh, mat, from, bone, pull });
    }
  }

  update(wiz: Wiz, view: WizView, dt: number): void {
    const on = wiz.summoned && view.anchor("head", this.a);
    this.group.visible = on;
    for (const s of this.strings) s.mesh.visible = on;
    if (!on) return;
    this.t += dt;

    // hover above his head, trailing behind him on springs; it comes down with him when he falls
    const tx = this.a.x, ty = this.a.y + HOVER, tz = this.a.z;
    if (!this.started) {
      this.started = true;
      this.px.x = tx; this.py.x = ty; this.pz.x = tz; this.yaw.x = wiz.yaw;
    }
    const x = this.px.to(tx, 1.6, dt), y = this.py.to(ty, 1.4, dt), z = this.pz.to(tz, 1.6, dt);
    const yaw = this.yaw.to(this.yaw.x + wrap(wiz.yaw - this.yaw.x), 1.8, dt);
    this.group.position.set(x, y + Math.sin(this.t * 2.1) * 0.25, z);
    this.group.rotation.y = yaw;

    // the fly leans into its own drift, nose a little down to watch him
    const fwd = this.px.v * Math.sin(yaw) + this.pz.v * Math.cos(yaw);
    const side = this.px.v * Math.cos(yaw) - this.pz.v * Math.sin(yaw);
    this.body.rotation.set(0.3 + clamp(fwd * 0.12, -0.3, 0.3), 0, clamp(-side * 0.12, -0.35, 0.35));
    const flap = Math.sin(this.t * 70) * 0.45;
    this.wings[0].rotation.z = 0.3 + flap;
    this.wings[1].rotation.z = -0.3 - flap;

    // working the bar: whichever strings are pulling tip it that way
    const p = wiz.pull;
    this.bar.rotation.set(clamp((p.legL + p.legR) * 0.12 - 0.3, -0.6, 0.3), 0,
      clamp((p.armL - p.armR) * 0.4 + (p.legL - p.legR) * 0.15, -0.5, 0.5));
    this.group.updateMatrixWorld(true);

    for (const s of this.strings) {
      this.bar.localToWorld(this.a.copy(s.from));
      if (!view.anchor(s.bone, this.b)) { s.mesh.visible = false; continue; }
      this.dir.subVectors(this.b, this.a);
      const len = this.dir.length();
      s.mesh.position.copy(this.a);
      s.mesh.quaternion.setFromUnitVectors(this.up, this.dir.divideScalar(Math.max(len, 1e-4)));
      s.mesh.scale.set(1, len, 1);
      const tension = clamp(s.pull(wiz), 0, 1);
      s.mat.color.copy(THREAD).lerp(FIRING, tension);
      s.mat.emissive.copy(FIRING).multiplyScalar(tension * 0.7);
    }
  }
}
