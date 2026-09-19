/**
 * Flinder's profile photos: Fly Roulette's cartoon fly, posed for the camera, with props for its strongest
 * traits (shades for moves, a gold chain for musk, a flower for scent, a banana for snacks, headphones for song).
 * One renderer: it plays the top card live and takes the snapshots the other cards show.
 */
import * as THREE from "three";
import { Fly, inked, toon } from "../roulette/scene.ts";
import type { Profile } from "./profiles.ts";

const SETS = [0xffd66b, 0x7fd1c7, 0xff9fb2, 0xa3d977, 0xb9a6ff, 0xffb86b, 0x8fc1ff];
const PROP = 0.6;     // a trait at least this strong shows in the photo

function props(fly: Fly, p: Profile): void {
  const H = Fly.HEAD, t = p.traits;
  if (t.moves >= PROP) {                          // shades
    const shades = new THREE.Group();
    const black = new THREE.MeshBasicMaterial({ color: 0x0b0b10 });
    for (const s of [-1, 1]) {
      const lens = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.16, 0.06), black);
      lens.position.set(0.2 * s, 0, 0);
      shades.add(lens);
    }
    shades.add(new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.04, 0.04), black));
    shades.position.set(0, H.y + 0.1, H.z + 0.34);
    fly.head.add(shades);
  }
  if (t.musk >= PROP) {                           // gold chain
    const chain = inked(new THREE.TorusGeometry(0.34, 0.04, 8, 28), toon(0xffc83d), 0.1);
    chain.rotation.x = Math.PI / 2 - 0.5;
    chain.position.set(0, 0.95, 0.2);
    fly.body.add(chain);
    const medal = inked(new THREE.CylinderGeometry(0.09, 0.09, 0.03, 16), toon(0xffc83d), 0.1);
    medal.rotation.x = Math.PI / 2;
    medal.position.set(0, 0.72, 0.5);
    fly.body.add(medal);
  }
  if (t.scent >= PROP) {                          // a flower behind one antenna
    const flower = new THREE.Group();
    for (let k = 0; k < 5; k++) {
      const petal = inked(new THREE.SphereGeometry(0.07, 10, 8), toon(0xff6fb5), 0.1);
      const a = (k / 5) * Math.PI * 2;
      petal.position.set(Math.cos(a) * 0.08, Math.sin(a) * 0.08, 0);
      flower.add(petal);
    }
    flower.add(inked(new THREE.SphereGeometry(0.05, 10, 8), toon(0xffe066), 0.1));
    flower.position.set(0.3, H.y + 0.28, H.z + 0.05);
    flower.rotation.y = 0.6;
    fly.head.add(flower);
  }
  if (t.snack >= PROP) {                          // a banana to share
    const banana = inked(new THREE.TorusGeometry(0.42, 0.1, 10, 24, Math.PI * 0.8), toon(0xffe14d), 0.06);
    banana.position.set(-0.85, 0.3, 0.35);
    banana.rotation.set(0.2, 0.5, 2.0);
    fly.root.add(banana);
  }
  if (p.bot) {                                    // a mosquito: long nose, stripy legs
    const nose = inked(new THREE.CylinderGeometry(0.012, 0.035, 0.7, 8), toon(0x1a1c22), 0.1);
    nose.rotation.x = Math.PI / 2 - 0.5;
    nose.position.set(0, H.y - 0.12, H.z + 0.55);
    fly.head.add(nose);
    for (const leg of fly.legs) leg.scale.set(1, 1.6, 1);
  }
  if (t.song >= PROP) {                           // headphones
    const band = inked(new THREE.TorusGeometry(0.36, 0.035, 8, 24, Math.PI), toon(0x3d8bff), 0.1);
    band.position.set(0, H.y + 0.02, H.z - 0.05);
    fly.head.add(band);
    for (const s of [-1, 1]) {
      const cup = inked(new THREE.CylinderGeometry(0.11, 0.11, 0.08, 16), toon(0x3d8bff), 0.1);
      cup.rotation.z = Math.PI / 2;
      cup.position.set(0.36 * s, H.y, H.z - 0.05);
      fly.head.add(cup);
    }
  }
}

export class Portrait {
  readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(32, 3 / 4, 0.1, 50);
  private readonly ground: THREE.Mesh;
  private fly: Fly | null = null;
  private clock = new THREE.Clock();
  private readonly look = new THREE.Vector3();
  /** 0 calm, 1 smitten: wings buzz and the fly bounces */
  excite = 0;
  /** a reaction to being swiped: droops (left) or spins for joy (right) */
  private mood: "sad" | "happy" | null = null;
  private moodAt = 0;
  react(mood: "sad" | "happy"): void { this.mood = mood; this.moodAt = this.clock.elapsedTime; }

  constructor() {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(2, devicePixelRatio));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.domElement.className = "live";
    this.ground = new THREE.Mesh(new THREE.CircleGeometry(3, 40), toon(0xffffff));
    this.ground.rotation.x = -Math.PI / 2;
    this.scene.add(this.ground);
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(2, 4, 3);
    this.scene.add(key, new THREE.HemisphereLight(0xffffff, 0x554433, 1.4));
    this.camera.position.set(1.25, 1.85, 5.4);
    this.look.set(0, 0.45, 0);
    this.camera.lookAt(this.look);
  }

  /** Sets the stage for a profile: its fly, props and backdrop. */
  pose(p: Profile): void {
    if (this.fly) this.scene.remove(this.fly.root);
    this.fly = new Fly(p.color);
    this.fly.root.rotation.y = 0.25;
    props(this.fly, p);
    this.scene.add(this.fly.root);
    const bg = new THREE.Color(SETS[p.id % SETS.length]);
    this.scene.background = bg;
    (this.ground.material as THREE.MeshToonMaterial).color.copy(bg).multiplyScalar(0.8);
    this.excite = 0;
    this.mood = null;
  }

  size(w: number, h: number): void {
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** One live frame: idle, blinking, looking into the camera. */
  frame(): void {
    const dt = Math.min(0.05, this.clock.getDelta());
    const t = this.clock.elapsedTime;
    if (!this.fly) return;
    this.fly.flap = this.excite;
    this.fly.tick(t, dt, this.camera.position);
    if (this.excite > 0.5) this.fly.body.position.y = Math.abs(Math.sin(t * 9)) * 0.12;
    const m = Math.min(1, (t - this.moodAt) / 0.35);
    if (this.mood === "sad") { this.fly.body.rotation.x = 0.45 * m; this.fly.sweat.visible = true; this.fly.eyeScale = 0.7; }
    else if (this.mood === "happy") { this.fly.root.rotation.y = 0.25 + m * Math.PI * 2; this.fly.flap = 1; this.fly.body.position.y = Math.sin(m * Math.PI) * 0.4; }
    else this.fly.body.rotation.x = 0;
    this.renderer.render(this.scene, this.camera);
  }

  /** A still of a profile, for cards not on top and the match screen (the live pose is put back after). */
  snapshot(p: Profile, w = 360, h = 480, live: Profile | null = null): string {
    const cw = this.renderer.domElement.width, ch = this.renderer.domElement.height;
    this.pose(p);
    this.renderer.setPixelRatio(1);
    this.size(w, h);
    this.fly!.tick(0, 0, this.camera.position);
    this.fly!.head.lookAt(this.camera.position);
    this.renderer.render(this.scene, this.camera);
    const url = this.renderer.domElement.toDataURL("image/jpeg", 0.85);
    this.renderer.setPixelRatio(Math.min(2, devicePixelRatio));
    this.size(cw / this.renderer.getPixelRatio(), ch / this.renderer.getPixelRatio());
    if (live) this.pose(live);
    return url;
  }
}
