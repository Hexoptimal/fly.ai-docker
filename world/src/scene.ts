/** Low-poly rendering of the world. Nothing here touches the simulation. */
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { WORLD_RADIUS, MAX_FLIES, type Prop, type World } from "./sim.ts";

const COL = {
  bg: 0x07090c,
  ground: 0x1d2f27,
  ground2: 0x294034,
  rock: 0x3c4756,
  stem: 0x3f6148,
  leaf: 0x4b7a54,
  fruit: [0xc2493d, 0xb8862f, 0x8e9b4b],
  mould: 0x6f7d63,
  mouldFuzz: 0xb9c6bb,
  carrion: 0x9b7d76,
  dung: 0x5b4630,
  compost: 0x3b3024,
  poop: 0xe8e4d8,
  spider: 0x15171b,
  egg: 0xf2eddc,
  fly: 0x6b6459,
  flyDark: 0x23211d,
  flyEye: 0xd0322a,
  threat: 0xff5a5a,
  accent: 0x3ed8ff,
};

function skyTexture(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = 2;
  c.height = 256;
  const g = c.getContext("2d")!;
  const grad = g.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, "#05070a");
  grad.addColorStop(0.62, "#0a1016");
  grad.addColorStop(0.88, "#13202a");
  grad.addColorStop(1, "#1b2d33");
  g.fillStyle = grad;
  g.fillRect(0, 0, 2, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.mapping = THREE.EquirectangularReflectionMapping;
  return tex;
}

export class Renderer {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;
  readonly controls: OrbitControls;
  /** "orbit" | "follow": follow rides behind the selected fly */
  camMode: "orbit" | "follow" = "orbit";
  private world: World;
  private bodies: THREE.InstancedMesh;
  private stripes: THREE.InstancedMesh;
  private eyes: THREE.InstancedMesh;
  private wings: THREE.InstancedMesh;
  private ring: THREE.Mesh;
  private swatter: THREE.Group;
  private propMeshes = new Map<number, THREE.Object3D>();
  private propKind = new Map<number, string>();
  private dummy = new THREE.Object3D();
  private wingDummy = new THREE.Object3D();
  private wingMatrix = new THREE.Matrix4();
  private eyeDummy = new THREE.Object3D();
  private eyeMatrix = new THREE.Matrix4();
  private targetVec = new THREE.Vector3();
  private camVec = new THREE.Vector3();
  private raycaster = new THREE.Raycaster();
  private down = { x: 0, y: 0 };
  private wind: THREE.Points;
  private windPos: Float32Array;
  private mats: Record<string, THREE.Material> = {};

  private sun!: THREE.DirectionalLight;
  private sky!: THREE.HemisphereLight;
  private readonly dayFog = new THREE.Color(0x0b1116);
  private readonly nightFog = new THREE.Color(0x05070d);
  private readonly noonSun = new THREE.Color(0xfff3dc);
  private readonly duskSun = new THREE.Color(0xff9a5a);
  private readonly moonSun = new THREE.Color(0x8fa8d8);

  constructor(canvas: HTMLCanvasElement, world: World) {
    this.world = world;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setClearColor(COL.bg);
    this.scene.fog = new THREE.Fog(0x0b1116, 40, 120);
    this.scene.background = skyTexture();

    this.camera = new THREE.PerspectiveCamera(52, 1, 0.05, 400);
    this.camera.position.set(11, 6, 15);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.target.set(0, 1.2, 0);
    this.controls.enableDamping = true;
    this.controls.maxPolarAngle = Math.PI * 0.49;
    this.controls.minDistance = 1.5;
    this.controls.maxDistance = 110;

    this.sky = new THREE.HemisphereLight(0xbfe4ff, 0x24352b, 1.5);
    this.scene.add(this.sky);
    this.sun = new THREE.DirectionalLight(0xfff3dc, 1.9);
    this.sun.position.set(24, 40, 16);
    this.scene.add(this.sun);
    const rim = new THREE.DirectionalLight(COL.accent, 0.55);
    rim.position.set(-30, 12, -25);
    this.scene.add(rim);

    this.mats.rock = new THREE.MeshStandardMaterial({ color: COL.rock, flatShading: true, roughness: 0.95 });
    this.mats.stem = new THREE.MeshStandardMaterial({ color: COL.stem, flatShading: true, roughness: 1 });
    this.mats.leaf = new THREE.MeshStandardMaterial({ color: COL.leaf, flatShading: true, roughness: 0.9, side: THREE.DoubleSide });
    this.mats.mould = new THREE.MeshStandardMaterial({ color: COL.mould, flatShading: true, roughness: 1 });
    this.mats.fuzz = new THREE.MeshStandardMaterial({ color: COL.mouldFuzz, flatShading: true, roughness: 1, transparent: true, opacity: 0.5 });
    this.mats.carrion = new THREE.MeshStandardMaterial({ color: COL.carrion, flatShading: true, roughness: 0.8 });
    this.mats.dung = new THREE.MeshStandardMaterial({ color: COL.dung, flatShading: true, roughness: 1 });
    this.mats.compost = new THREE.MeshStandardMaterial({ color: COL.compost, flatShading: true, roughness: 1 });
    this.mats.poop = new THREE.MeshStandardMaterial({ color: COL.poop, flatShading: true, roughness: 0.7, emissive: 0x151515 });
    this.mats.spider = new THREE.MeshStandardMaterial({ color: COL.spider, flatShading: true, roughness: 0.6 });
    this.mats.egg = new THREE.MeshStandardMaterial({ color: COL.egg, flatShading: true, roughness: 0.5, emissive: 0x1a1a18 });

    this.buildGround();

    const body = new THREE.IcosahedronGeometry(0.26, 0);
    body.scale(0.62, 0.58, 1.5);
    this.bodies = new THREE.InstancedMesh(
      body, new THREE.MeshStandardMaterial({ color: COL.fly, flatShading: true, roughness: 0.7 }), MAX_FLIES);
    this.bodies.frustumCulled = false;
    this.scene.add(this.bodies);

    const abdomen = new THREE.IcosahedronGeometry(0.24, 0);
    abdomen.scale(0.72, 0.66, 1.35);
    abdomen.translate(0, -0.01, -0.3);
    this.stripes = new THREE.InstancedMesh(
      abdomen, new THREE.MeshStandardMaterial({ color: COL.flyDark, flatShading: true, roughness: 0.85 }), MAX_FLIES);
    this.stripes.frustumCulled = false;
    this.scene.add(this.stripes);

    const eye = new THREE.IcosahedronGeometry(0.125, 0);
    this.eyes = new THREE.InstancedMesh(
      eye, new THREE.MeshStandardMaterial({ color: COL.flyEye, flatShading: true, roughness: 0.35, emissive: 0x2a0705 }),
      MAX_FLIES * 2);
    this.eyes.frustumCulled = false;
    this.scene.add(this.eyes);

    const wing = new THREE.PlaneGeometry(0.72, 0.2);
    wing.rotateX(-Math.PI / 2);
    wing.translate(0.36, 0, -0.05);
    this.wings = new THREE.InstancedMesh(
      wing, new THREE.MeshStandardMaterial({
        color: 0xeaf7ff, transparent: true, opacity: 0.3, side: THREE.DoubleSide,
        roughness: 0.15, emissive: 0x16222b, depthWrite: false,
      }), MAX_FLIES * 2);
    this.wings.frustumCulled = false;
    this.scene.add(this.wings);

    this.ring = new THREE.Mesh(
      new THREE.TorusGeometry(0.45, 0.022, 3, 24),
      new THREE.MeshBasicMaterial({ color: COL.accent, transparent: true, opacity: 0.8 }));
    this.ring.rotation.x = Math.PI / 2;
    this.scene.add(this.ring);

    // the swatter
    this.swatter = new THREE.Group();
    const pad = new THREE.Mesh(
      new THREE.BoxGeometry(6.4, 0.35, 6.4),
      new THREE.MeshStandardMaterial({ color: COL.threat, flatShading: true, roughness: 0.55, emissive: 0x3a0b0b }));
    const handle = new THREE.Mesh(
      new THREE.CylinderGeometry(0.22, 0.22, 7, 6),
      new THREE.MeshStandardMaterial({ color: 0x2b2f36, flatShading: true, roughness: 0.8 }));
    handle.position.set(0, 3.6, -3.6);
    handle.rotation.x = 0.35;
    this.swatter.add(pad, handle);
    this.swatter.visible = false;
    this.scene.add(this.swatter);

    const COUNT = 700;
    this.windPos = new Float32Array(COUNT * 3);
    for (let i = 0; i < COUNT; i++) {
      this.windPos[i * 3] = (Math.random() - 0.5) * 2 * WORLD_RADIUS;
      this.windPos[i * 3 + 1] = Math.random() * 7 + 0.2;
      this.windPos[i * 3 + 2] = (Math.random() - 0.5) * 2 * WORLD_RADIUS;
    }
    const wgeo = new THREE.BufferGeometry();
    wgeo.setAttribute("position", new THREE.BufferAttribute(this.windPos, 3));
    this.wind = new THREE.Points(wgeo, new THREE.PointsMaterial({
      color: 0xbfe4ff, size: 0.08, transparent: true, opacity: 0.32, depthWrite: false }));
    this.wind.frustumCulled = false;
    this.scene.add(this.wind);

    this.syncProps();
    this.resize();
    addEventListener("resize", () => this.resize());
    canvas.addEventListener("pointerdown", (e) => { this.down = { x: e.clientX, y: e.clientY }; });
    canvas.addEventListener("pointerup", (e) => {
      if (Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y) < 5) this.pick(e);
    });
  }

  private buildGround(): void {
    const g = new THREE.CircleGeometry(WORLD_RADIUS + 12, 22);
    g.rotateX(-Math.PI / 2);
    const pos = g.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) pos.setY(i, Math.sin(i * 2.3) * 0.45 - 0.9);
    g.computeVertexNormals();
    this.scene.add(new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: COL.ground, flatShading: true, roughness: 1 })));
    const inner = new THREE.CircleGeometry(WORLD_RADIUS, 16);
    inner.rotateX(-Math.PI / 2);
    inner.translate(0, 0.02, 0);
    this.scene.add(new THREE.Mesh(inner, new THREE.MeshStandardMaterial({ color: COL.ground2, flatShading: true, roughness: 1 })));
  }

  private buildProp(p: Prop): THREE.Object3D {
    const g = new THREE.Group();
    const add = (mesh: THREE.Mesh) => { g.add(mesh); return mesh; };
    if (p.kind === "obstacle") {
      const geo = p.shape > 0.5
        ? new THREE.ConeGeometry(p.radius * 1.15, p.height, 6)
        : new THREE.DodecahedronGeometry(p.radius, 0);
      const m = add(new THREE.Mesh(geo, this.mats.rock));
      m.position.y = p.shape > 0.5 ? p.height * 0.5 : p.radius * 0.6;
      m.rotation.y = p.shape * 6.28;
    } else if (p.kind === "plant") {
      const stem = add(new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.1, p.height, 5), this.mats.stem));
      stem.position.y = p.height * 0.5;
      for (let i = 0; i < 5; i++) {
        const leaf = add(new THREE.Mesh(new THREE.CircleGeometry(p.radius * 0.5, 3), this.mats.leaf));
        const a = (i / 5) * 6.28 + p.shape * 3;
        leaf.position.set(Math.cos(a) * p.radius * 0.4, p.height * (0.45 + 0.5 * (i / 5)), Math.sin(a) * p.radius * 0.4);
        leaf.rotation.set(-Math.PI / 2 + 0.9, a, 0);
      }
    } else if (p.kind === "fruit" || p.kind === "mould") {
      const mat = p.kind === "fruit"
        ? new THREE.MeshStandardMaterial({
            color: COL.fruit[p.species % COL.fruit.length], flatShading: true, roughness: 0.65, emissive: 0x120704 })
        : this.mats.mould;
      const m = add(new THREE.Mesh(new THREE.IcosahedronGeometry(p.height * 0.62, 0), mat));
      m.position.y = p.height * 0.55;
      m.rotation.set(p.shape * 3, p.shape * 5, p.shape * 2);
      m.scale.set(1.35, 1, 1.2);
      if (p.kind === "mould") {
        // fuzzy spots, so a mouldy one is obvious at a glance
        for (let i = 0; i < 4; i++) {
          const spot = add(new THREE.Mesh(new THREE.IcosahedronGeometry(p.height * 0.26, 0), this.mats.fuzz));
          const a = i * 1.7 + p.shape * 4;
          spot.position.set(Math.cos(a) * p.height * 0.55, p.height * (0.7 + 0.25 * Math.sin(a)), Math.sin(a) * p.height * 0.5);
        }
      }
    } else if (p.kind === "carrion") {
      const m = add(new THREE.Mesh(new THREE.IcosahedronGeometry(p.radius * 0.62, 0), this.mats.carrion));
      m.position.y = p.height * 0.5;
      m.scale.set(1.6, 0.75, 1.1);
      m.rotation.y = p.shape * 6;
      for (let i = 0; i < 4; i++) { // splayed legs
        const leg = add(new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.03, p.radius * 1.1, 4), this.mats.carrion));
        const a = i * 1.6 + p.shape;
        leg.position.set(Math.cos(a) * p.radius * 0.7, p.height * 0.55, Math.sin(a) * p.radius * 0.5);
        leg.rotation.set(Math.PI / 2.4, a, 0.4);
      }
    } else if (p.kind === "dung") {
      for (let i = 0; i < 3; i++) {
        const m = add(new THREE.Mesh(new THREE.IcosahedronGeometry(p.radius * (0.5 - i * 0.1), 0), this.mats.dung));
        m.position.set((p.shape - 0.5) * i * 0.3, 0.12 + i * 0.16, (0.5 - p.shape) * i * 0.3);
        m.scale.set(1.3, 0.7, 1.3);
      }
    } else if (p.kind === "compost") {
      const m = add(new THREE.Mesh(new THREE.ConeGeometry(p.radius * 1.25, p.height * 1.25, 7), this.mats.compost));
      m.position.y = p.height * 0.6;
      for (let i = 0; i < 5; i++) {
        const bit = add(new THREE.Mesh(new THREE.IcosahedronGeometry(0.28, 0), this.mats.dung));
        const a = i * 1.3 + p.shape * 3;
        bit.position.set(Math.cos(a) * p.radius * 0.8, 0.3 + (i % 3) * 0.35, Math.sin(a) * p.radius * 0.8);
      }
    } else if (p.kind === "spider") {
      const body = add(new THREE.Mesh(new THREE.IcosahedronGeometry(0.3, 0), this.mats.spider));
      body.position.y = 0.3;
      body.scale.set(1.2, 0.8, 1.4);
      for (let i = 0; i < 8; i++) {
        const leg = add(new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.02, 0.85, 4), this.mats.spider));
        const a = (i / 8) * 6.28 + 0.4;
        leg.position.set(Math.cos(a) * 0.36, 0.3, Math.sin(a) * 0.36);
        leg.rotation.set(Math.PI / 2.6, a, 0.5);
      }
    } else if (p.kind === "egg") {
      const m = add(new THREE.Mesh(new THREE.IcosahedronGeometry(0.07, 0), this.mats.egg));
      m.position.y = p.height + 0.04;
      m.scale.set(0.7, 0.7, 1.5);
    } else if (p.kind === "larva") {
      const m = add(new THREE.Mesh(new THREE.IcosahedronGeometry(0.12, 0), this.mats.egg));
      m.position.y = p.height + 0.06;
      m.scale.set(0.8, 0.7, 2.1);
    } else if (p.kind === "poop") {
      const m = add(new THREE.Mesh(new THREE.IcosahedronGeometry(0.09, 0), this.mats.poop));
      m.position.y = 0.06;
      m.scale.set(1.3, 0.7, 1.2);
    }
    g.position.set(p.x, 0, p.z);
    g.userData.prop = p;
    return g;
  }

  /** Props come and go (droppings), so keep the meshes in step with the world. */
  private syncProps(): void {
    const live = new Set<number>();
    for (const p of this.world.props) {
      live.add(p.id);
      if (this.propMeshes.has(p.id) && this.propKind.get(p.id) !== p.kind) {
        this.scene.remove(this.propMeshes.get(p.id)!);
        this.propMeshes.delete(p.id);
      }
      if (!this.propMeshes.has(p.id)) {
        const mesh = this.buildProp(p);
        this.propMeshes.set(p.id, mesh);
        this.propKind.set(p.id, p.kind);
        this.scene.add(mesh);
      }
    }
    for (const [id, mesh] of this.propMeshes) {
      if (live.has(id)) continue;
      this.scene.remove(mesh);
      this.propMeshes.delete(id);
      this.propKind.delete(id);
    }
  }

  private pick(e: PointerEvent): void {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = this.raycaster.intersectObject(this.bodies, false)[0];
    if (hit && hit.instanceId !== undefined && hit.instanceId < this.world.flies.length) {
      this.world.selected = hit.instanceId;
    }
  }

  resize(): void {
    const c = this.renderer.domElement;
    const w = c.clientWidth || 1, h = c.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  render(dt = 0.016): void {
    this.lightTheDay();
    const w = this.world.wind;
    const wx = Math.sin(w.angle) * w.strength, wz = Math.cos(w.angle) * w.strength;
    for (let i = 0; i < this.windPos.length; i += 3) {
      this.windPos[i] += wx * dt;
      this.windPos[i + 2] += wz * dt;
      if (Math.abs(this.windPos[i]) > WORLD_RADIUS) this.windPos[i] -= Math.sign(this.windPos[i]) * 2 * WORLD_RADIUS;
      if (Math.abs(this.windPos[i + 2]) > WORLD_RADIUS) this.windPos[i + 2] -= Math.sign(this.windPos[i + 2]) * 2 * WORLD_RADIUS;
    }
    this.wind.geometry.attributes.position.needsUpdate = true;
    this.syncProps();

    for (const [, mesh] of this.propMeshes) {
      const p = mesh.userData.prop as Prop;
      if (p.kind === "fruit" || p.kind === "mould" || p.kind === "carrion") {
        const k = 0.55 + 0.45 * p.open;
        mesh.scale.setScalar(k);
      } else if (p.kind === "spider") {
        const rear = p.radius / 0.7;
        mesh.scale.set(rear, Math.min(2.2, rear * rear), rear);
      } else if (p.kind === "poop") {
        mesh.visible = p.open > 0;
      }
    }

    const d = this.dummy;
    const flies = this.world.flies;
    for (let i = 0; i < MAX_FLIES; i++) {
      if (i < flies.length) {
        const b = flies[i];
        d.position.set(b.x, b.y, b.z);
        d.rotation.set(0, b.yaw, 0);
        d.scale.setScalar(1);
        d.updateMatrix();
        this.bodies.setMatrixAt(i, d.matrix);
        this.stripes.setMatrixAt(i, d.matrix);
        for (let e = 0; e < 2; e++) {
          const local = this.eyeDummy;
          local.position.set(e === 0 ? -0.115 : 0.115, 0.055, 0.26);
          local.updateMatrix();
          this.eyeMatrix.multiplyMatrices(d.matrix, local.matrix);
          this.eyes.setMatrixAt(i * 2 + e, this.eyeMatrix);
        }
        // a landed, idle fly rubs its legs; a flying one blurs its wings
        const idle = b.landed && b.motor.thrust < 0.1;
        const flap = idle ? Math.sin(b.wing * 3) * 0.25 : Math.sin(b.wing) * 0.85;
        const blur = idle ? 0.85 : 1 + Math.min(0.35, b.motor.thrust * 1.5);
        d.position.set(b.x, b.y + 0.14, b.z);
        d.updateMatrix();
        for (let s = 0; s < 2; s++) {
          const sign = s === 0 ? 1 : -1;
          const local = this.wingDummy;
          local.rotation.set(0, 0, sign * (0.25 + flap * 0.9));
          local.scale.set(sign * blur, 1, idle ? 0.6 : 1);
          local.updateMatrix();
          this.wingMatrix.multiplyMatrices(d.matrix, local.matrix);
          this.wings.setMatrixAt(i * 2 + s, this.wingMatrix);
        }
      } else {
        d.position.set(0, -1000, 0);
        d.scale.setScalar(0.001);
        d.rotation.set(0, 0, 0);
        d.updateMatrix();
        this.bodies.setMatrixAt(i, d.matrix);
        this.stripes.setMatrixAt(i, d.matrix);
        this.eyes.setMatrixAt(i * 2, d.matrix);
        this.eyes.setMatrixAt(i * 2 + 1, d.matrix);
        this.wings.setMatrixAt(i * 2, d.matrix);
        this.wings.setMatrixAt(i * 2 + 1, d.matrix);
      }
    }
    this.bodies.instanceMatrix.needsUpdate = true;
    this.stripes.instanceMatrix.needsUpdate = true;
    this.eyes.instanceMatrix.needsUpdate = true;
    this.wings.instanceMatrix.needsUpdate = true;

    const sel = flies[this.world.selected];
    if (sel) {
      this.ring.position.set(sel.x, sel.y - 0.3, sel.z);
      this.ring.visible = true;
      if (this.camMode === "follow") {
        // ride behind and slightly above the fly
        const back = 1.5, up = 0.55;
        this.camVec.set(
          sel.x - Math.sin(sel.yaw) * back,
          sel.y + up,
          sel.z - Math.cos(sel.yaw) * back);
        this.camera.position.lerp(this.camVec, Math.min(1, dt * 6));
        this.controls.target.lerp(this.targetVec.set(sel.x, sel.y, sel.z), Math.min(1, dt * 8));
      }
    } else {
      this.ring.visible = false;
    }

    const t = this.world.threat;
    this.swatter.visible = !!t;
    if (t) this.swatter.position.set(t.x, t.y, t.z);

    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  /** The sun rides the world clock: position, colour, and how much light the
   *  scene gets. The same `daylight` number dims what the photoreceptors see. */
  private lightTheDay(): void {
    const tod = this.world.timeOfDay;
    const day = this.world.daylight;
    const ang = (tod - 0.25) * Math.PI * 2;
    this.sun.position.set(Math.cos(ang) * 44, Math.sin(ang) * 44, 16);
    this.sun.intensity = 0.15 + 1.85 * day;

    // warm at dawn and dusk (the sun low), cold and dim at night
    const low = Math.max(0, 1 - Math.abs(Math.sin(ang)) * 2.2);
    const c = this.sun.color.copy(this.noonSun).lerp(this.duskSun, low * Math.min(1, day * 1.6));
    if (day < 0.3) c.lerp(this.moonSun, 1 - day / 0.3);

    this.sky.intensity = 0.25 + 1.25 * day;
    const fog = this.scene.fog as THREE.Fog;
    fog.color.copy(this.nightFog).lerp(this.dayFog, day);
    this.renderer.setClearColor(fog.color);
    // the sky is a gradient texture, so dim the texture itself rather than
    // tone-mapping the whole scene (which would change the daytime look)
    this.scene.backgroundIntensity = 0.18 + 0.82 * day;
  }

  /** Screen position of a fly, or null if it is behind the camera. */
  project(x: number, y: number, z: number, out: THREE.Vector3): boolean {
    out.set(x, y, z).project(this.camera);
    return out.z < 1;
  }
}
