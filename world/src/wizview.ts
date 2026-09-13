/**
 * Wiz's model, posed procedurally from wiz.ts: the whole body leans and falls around the feet,
 * two-bone IK puts each foot on its planted (or swinging) spot and each hand where the strings pull it,
 * and the spine and head take the rest of the lean. Reads Wiz, never writes it.
 */
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import { PropertyBinding } from "three";
import type { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { WIZ, type Wiz } from "./wiz.ts";

const X = new THREE.Vector3(1, 0, 0);
const Y = new THREE.Vector3(0, 1, 0);
const Z = new THREE.Vector3(0, 0, 1);
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/** Half-width of his belly and coat (metres from the middle) at height y, measured off the skinned
 *  rest pose at 9 m tall: ~1.45 m below the hips, ~1.57 m at the coat, ~1.25 m at the chest. */
const bodyHalfWidth = (y: number) => (y < 0.5 ? 0 : y < 1.3 ? 1.46 : y < 2.3 ? 1.57 : y < 3.5 ? 1.25 : 0);
const HAND_CLEARANCE = 0.35;

interface Rest { local: THREE.Quaternion; model: THREE.Quaternion; modelInv: THREE.Quaternion }

const POSED = ["torso", "torso.001", "torso.002", "head", "jaw", "thigh.L", "shin.L", "thigh.R", "shin.R",
  "upper_arm.L", "fore_arm.L", "upper_arm.R", "fore_arm.R"];

export class WizView {
  readonly root = new THREE.Group();
  /** between the yaw and the model: leans and tips him over around his feet */
  private tipper = new THREE.Group();
  private model: THREE.Object3D | null = null;
  private bones = new Map<string, THREE.Object3D>();
  private rest = new Map<THREE.Object3D, Rest>();
  private modelY = 0;
  private ankleY = 0.57;
  // scratch
  private q = new THREE.Quaternion();
  private q2 = new THREE.Quaternion();
  private qa = new THREE.Quaternion();
  private qb = new THREE.Quaternion();
  private A = new THREE.Vector3();
  private B = new THREE.Vector3();
  private C = new THREE.Vector3();
  private D = new THREE.Vector3();
  private P = new THREE.Vector3();
  private K = new THREE.Vector3();
  private T = new THREE.Vector3();
  private u = new THREE.Vector3();
  private v = new THREE.Vector3();
  private axis = new THREE.Vector3();
  private camVec = new THREE.Vector3();
  private targetVec = new THREE.Vector3();

  constructor(scene: THREE.Scene, url: string) {
    this.root.visible = false;
    this.root.add(this.tipper);
    scene.add(this.root);
    const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
    loader.load(url, (gltf) => {
      const model = gltf.scene;
      const box = new THREE.Box3().setFromObject(model);
      const scale = WIZ.height / (box.max.y - box.min.y);
      model.scale.setScalar(scale);
      this.modelY = -box.min.y * scale;
      model.position.y = this.modelY;
      model.traverse((o) => {
        o.frustumCulled = false;
        this.bones.set(o.name, o);
      });
      this.tipper.add(model);
      this.model = model;
      model.updateMatrixWorld(true);
      const rootInv = model.getWorldQuaternion(new THREE.Quaternion()).invert();
      model.traverse((o) => {
        const m = rootInv.clone().multiply(o.getWorldQuaternion(new THREE.Quaternion()));
        this.rest.set(o, { local: o.quaternion.clone(), model: m, modelInv: m.clone().invert() });
      });
      const foot = this.bone("foot.L");
      if (foot) this.ankleY = foot.getWorldPosition(new THREE.Vector3()).y;
    });
  }

  private bone(name: string): THREE.Object3D | undefined {
    return this.bones.get(PropertyBinding.sanitizeNodeName(name));
  }

  /** World position of a bone after this frame's pose (for the puppeteer's strings). */
  anchor(name: string, out: THREE.Vector3): boolean {
    const b = this.bone(name);
    if (!b || !this.root.visible) return false;
    b.getWorldPosition(out);
    return true;
  }

  /** Rest pose rotated by `turns` (axis in model space, angle), applied in order. */
  private pose(name: string, ...turns: [THREE.Vector3, number][]): void {
    const b = this.bone(name);
    const r = b && this.rest.get(b);
    if (!b || !r) return;
    this.q.identity();
    for (const [axis, angle] of turns) this.q.premultiply(this.q2.setFromAxisAngle(axis, angle));
    this.q.premultiply(r.modelInv).multiply(r.model);
    b.quaternion.copy(r.local).multiply(this.q);
  }

  /** Rotate `bone` (by weight w) so that the point `from` on it swings to `to`, in world space. */
  private aim(bone: THREE.Object3D, from: THREE.Vector3, to: THREE.Vector3, w: number): void {
    bone.getWorldPosition(this.A);
    this.u.subVectors(from, this.A).normalize();
    this.v.subVectors(to, this.A).normalize();
    this.qa.setFromUnitVectors(this.u, this.v);
    if (w < 1) this.qa.slerp(this.qb.identity(), 1 - w);
    bone.getWorldQuaternion(this.qb).premultiply(this.qa);
    bone.parent!.getWorldQuaternion(this.q2).invert();
    bone.quaternion.copy(this.q2.multiply(this.qb));
    bone.updateMatrixWorld(true);
  }

  /** Two-bone IK: upper -> lower -> end reaches `target`, bending toward `pole`. */
  private ik(upper: string, lower: string, end: string, target: THREE.Vector3, pole: THREE.Vector3, w: number): void {
    const a = this.bone(upper), b = this.bone(lower), c = this.bone(end);
    if (!a || !b || !c || w <= 0) return;
    const A = a.getWorldPosition(new THREE.Vector3());
    b.getWorldPosition(this.B);
    c.getWorldPosition(this.C);
    const l1 = A.distanceTo(this.B), l2 = this.B.distanceTo(this.C);
    this.D.subVectors(target, A);
    const dist = clamp(this.D.length(), Math.abs(l1 - l2) + 1e-3, l1 + l2 - 1e-3);
    this.D.normalize();
    const along = (l1 * l1 - l2 * l2 + dist * dist) / (2 * dist);
    const out = Math.sqrt(Math.max(0, l1 * l1 - along * along));
    this.P.copy(pole).addScaledVector(this.D, -pole.dot(this.D));
    if (this.P.lengthSq() < 1e-6) this.P.set(0, 0, 1);
    this.P.normalize();
    this.K.copy(A).addScaledVector(this.D, along).addScaledVector(this.P, out);
    this.aim(a, this.B, this.K, w);
    b.getWorldPosition(this.B);
    c.getWorldPosition(this.C);
    this.T.copy(A).addScaledVector(this.D, dist);
    this.aim(b, this.C, this.T, w);
  }

  /** a tip of `angle` toward direction `dir` (0 front, +pi/2 his left), about the feet */
  private tip(out: THREE.Quaternion, dir: number, angle: number): THREE.Quaternion {
    return out.setFromAxisAngle(this.axis.set(Math.cos(dir), 0, -Math.sin(dir)), angle);
  }

  update(wiz: Wiz, dt: number, follow: boolean, camera: THREE.PerspectiveCamera, controls: OrbitControls): void {
    this.root.visible = wiz.summoned && !!this.model;
    if (!this.root.visible || !this.model) return;
    this.root.position.set(wiz.x, wiz.y, wiz.z);
    this.root.rotation.y = wiz.yaw;

    // whole body: the fall, and part of the balance lean, both pivot at the feet
    const lean = Math.hypot(wiz.pitch, wiz.roll);
    const leanDir = Math.atan2(wiz.roll, wiz.pitch);
    this.tip(this.tipper.quaternion, wiz.fallDir, wiz.tilt).multiply(this.tip(this.q, leanDir, lean * 0.45));

    // hips drop as the feet spread, and with a crouch; IK bends the knees to match
    let spread = 0;
    for (const f of wiz.feet) spread = Math.max(spread, Math.hypot(f.x - wiz.x, f.z - wiz.z) - WIZ.hipX * 0.6);
    const drop = WIZ.legLen - Math.sqrt(Math.max(0.2, WIZ.legLen * WIZ.legLen - spread * spread)) + wiz.crouch.x * 0.35;
    this.model.position.y = this.modelY - drop;

    // spine, head and jaw from rest; the spine takes the rest of the lean
    for (const name of POSED) this.pose(name);
    const up = 1 - clamp(wiz.tilt / 0.6, 0, 1); // how much he is on his feet
    const flat = clamp((wiz.tilt - 0.8) / 0.7, 0, 1);
    const p = wiz.pull;
    this.pose("torso.001", [X, wiz.pitch * 0.5 * up + wiz.crouch.x * 0.25], [Z, -wiz.roll * 0.5 * up]);
    this.pose("torso.002", [X, wiz.pitch * 0.25 * up], [Z, -wiz.roll * 0.3 * up]);
    this.pose("head", [Y, wiz.head.x], [X, -wiz.pitch * 0.4 * up]);
    this.pose("jaw", [X, clamp(Math.max(p.armL, p.armR, p.legL, p.legR) * 0.25 + wiz.escape * 0.35 + flat * 0.15, 0, 0.45)]);
    // lying down: the leg strings kick the legs about the hips (IK is off)
    const wig = (k: number) => Math.sin(wiz.t * 3 + k) * 0.15 * flat;
    this.pose("thigh.L", [X, -p.legL * 0.8 * flat + wig(0)]);
    this.pose("thigh.R", [X, -p.legR * 0.8 * flat + wig(2)]);
    this.pose("shin.L", [X, p.legL * 0.5 * flat]);
    this.pose("shin.R", [X, p.legR * 0.5 * flat]);
    this.model.updateMatrixWorld(true);

    // feet: IK onto the spots the body chose, weighted off while he falls
    const knee = this.v.set(0, 0, 1).applyQuaternion(this.tipper.getWorldQuaternion(this.q)).clone();
    for (let s = 0; s < 2; s++) {
      const f = wiz.feet[s];
      const target = this.camVec.set(f.x, f.y + this.ankleY + f.lift * 0.35, f.z).clone();
      this.ik(`thigh.${s === 0 ? "L" : "R"}`, `shin.${s === 0 ? "L" : "R"}`, `foot.${s === 0 ? "L" : "R"}`, target, knee, up);
    }

    // hands: hanging just outside the coat, swinging against the opposite foot, raised by the arm strings
    const tq = this.tipper.getWorldQuaternion(this.q);
    for (let s = 0; s < 2; s++) {
      const side = s === 0 ? 1 : -1;
      const other = wiz.feet[1 - s];
      const local = this.tipper.worldToLocal(this.D.set(other.x, 0, other.z));
      const swing = clamp(local.z * 0.8, -0.4, 0.4) * up;
      const raise = wiz.armUp[s].x;
      const y = 1.6 + 2.3 * raise;
      const x = Math.max(1.95 + 0.35 * raise, bodyHalfWidth(y) + HAND_CLEARANCE);
      const hand = this.T.set(side * x, y, 0.2 + swing - 0.2 * raise);
      this.tipper.localToWorld(hand); // the tipper frame already carries the fall and the lean
      // elbows bend out and back, so the forearm stays off the belly
      const elbow = this.P.set(side, -0.3, -0.6).applyQuaternion(tq).clone();
      this.ik(`upper_arm.${s === 0 ? "L" : "R"}`, `fore_arm.${s === 0 ? "L" : "R"}`, `hand.${s === 0 ? "L" : "R"}`, hand.clone(), elbow, 1);
    }

    if (follow) {
      // a bit to the side and high enough to keep the puppeteer fly in the shot
      const back = 24, upCam = 13;
      const yaw = wiz.yaw - 0.5;
      this.camVec.set(wiz.x - Math.sin(yaw) * back, wiz.y + upCam, wiz.z - Math.cos(yaw) * back);
      camera.position.lerp(this.camVec, Math.min(1, dt * 1.5));
      controls.target.lerp(this.targetVec.set(wiz.x, wiz.y + WIZ.height, wiz.z), Math.min(1, dt * 3));
    }
  }
}
