import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { moveOptions, watchedTiles } from "../../engine/engine";
import type { TurnRecord } from "../../engine/record";
import { otherSide, type Board, type Coord, type GameEvent, type GameState, type RulesConfig, type Side } from "../../engine/types";
import type { Presenter } from "../../runner/MatchRunner";
import { dotTexture, grainTexture, hazardTexture, PALETTE, seeded } from "./materials";
import { buildRobot, lighten, type RobotRig } from "./robot";
import { Animator, ease, lerp, lerpAngle } from "./tween";

export type SoundName = "step" | "fire" | "hit" | "shield" | "overwatch" | "capture" | "disabled" | "score";

export interface BattlefieldOptions {
  reducedMotion?: boolean;
  onSound?: (name: SoundName) => void;
}

interface RobotView {
  rig: RobotRig;
  side: Side;
  pos: Coord;
  facing: number;
  braced: boolean;
  disabled: number;
  walking: number;
  plate: HTMLDivElement;
  plateHp: HTMLDivElement;
  plateName: HTMLSpanElement;
}

interface UplinkView {
  id: string;
  at: Coord;
  value: number;
  ring: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  beacon: THREE.Mesh<THREE.SphereGeometry, THREE.MeshStandardMaterial>;
  beam: THREE.Mesh<THREE.CylinderGeometry, THREE.MeshBasicMaterial>;
  owner: Side | null;
}

interface Floater {
  el: HTMLDivElement;
  world: THREE.Vector3;
}

const TILE_HEIGHT = 0.42;
const ROBOT_SCALE = 1.32;
const ELEVATION = Math.atan(1 / Math.SQRT2) * 0.92; // a touch flatter than true isometric
const BASE_YAW = Math.PI / 4;

/** Thin coloured quads over tiles, one InstancedMesh per layer. */
class TileLayer {
  readonly mesh: THREE.InstancedMesh;
  private readonly material: THREE.MeshBasicMaterial;
  private readonly dummy = new THREE.Object3D();
  private target = 0;

  constructor(
    private readonly capacity: number,
    geometry: THREE.BufferGeometry,
    private readonly maxOpacity: number,
    height: number,
  ) {
    this.material = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, color: "#ffffff" });
    this.mesh = new THREE.InstancedMesh(geometry, this.material, capacity);
    this.mesh.count = 0;
    this.mesh.renderOrder = 3;
    this.mesh.position.y = height;
    this.mesh.frustumCulled = false;
  }

  set(tiles: Coord[], color: THREE.Color | string, toWorld: (c: Coord) => THREE.Vector3): void {
    const n = Math.min(tiles.length, this.capacity);
    for (let i = 0; i < n; i++) {
      const p = toWorld(tiles[i]);
      this.dummy.position.set(p.x, 0, p.z);
      this.dummy.rotation.set(-Math.PI / 2, 0, 0);
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(i, this.dummy.matrix);
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.material.color.set(color);
    this.target = n ? this.maxOpacity : 0;
  }

  clear(): void {
    this.target = 0;
  }

  /** Eases opacity towards its target; returns true while still changing. */
  step(dt: number): boolean {
    const o = this.material.opacity;
    if (Math.abs(o - this.target) < 0.002) {
      this.material.opacity = this.target;
      if (this.target === 0) this.mesh.count = 0;
      return false;
    }
    this.material.opacity = lerp(o, this.target, Math.min(1, dt * 9));
    return true;
  }
}

/**
 * The isometric battlefield. It is driven imperatively (never by React renders): the match runner
 * calls `present()` for each completed decision and awaits the returned promise before continuing.
 */
export class Battlefield implements Presenter {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-5, 5, 5, -5, 0.1, 100);
  private readonly animator = new Animator();
  private readonly labels: HTMLDivElement;
  private readonly resizeObserver: ResizeObserver;
  private boardGroup = new THREE.Group();
  private readonly fx = new THREE.Group();
  private robots: Record<Side, RobotView> | null = null;
  private uplinks: UplinkView[] = [];
  private board: Board | null = null;
  private boardKey = "";
  private rules: RulesConfig | null = null;
  private colors: Record<Side, string> = { A: "#4c7dff", B: "#ff5b3a" };
  private yaw = BASE_YAW;
  private yawTarget = BASE_YAW;
  private viewExtent = { cx: 0, cy: 0, w: 10, h: 10 };
  private raf = 0;
  private lastTime = 0;
  private floaters: Floater[] = [];
  private smoke: { sprite: THREE.Sprite; t: number; side: Side }[] = [];
  private disposed = false;
  private readonly dotTex = dotTexture();
  private readonly layers: { move: TileLayer; watchA: TileLayer; watchB: TileLayer; path: TileLayer; target: TileLayer };
  private readonly tmp = new THREE.Vector3();
  private readonly reducedMotion: boolean;
  private readonly onSound: (name: SoundName) => void;
  private width = 1;
  private height = 1;
  /** Screen space (px) covered by overlays at the top and bottom of the stage; the board is centred between them. */
  private insets = { top: 0, bottom: 0 };

  constructor(
    private readonly container: HTMLElement,
    options: BattlefieldOptions = {},
  ) {
    this.reducedMotion = options.reducedMotion ?? false;
    this.onSound = options.onSound ?? (() => {});
    this.animator.speed = this.reducedMotion ? 0.45 : 1;

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.domElement.className = "bf-canvas";
    this.renderer.domElement.setAttribute("aria-hidden", "true");
    container.appendChild(this.renderer.domElement);

    this.labels = document.createElement("div");
    this.labels.className = "bf-labels";
    container.appendChild(this.labels);

    this.setupLights();
    this.scene.add(this.boardGroup, this.fx);

    const n = 400;
    const quad = new THREE.PlaneGeometry(0.9, 0.9);
    const disc = new THREE.CircleGeometry(0.11, 20);
    const frame = new THREE.RingGeometry(0.3, 0.4, 4, 1);
    frame.rotateZ(Math.PI / 4);
    this.layers = {
      move: new TileLayer(n, quad, 0.2, 0.006),
      watchA: new TileLayer(n, quad, 0.16, 0.004),
      watchB: new TileLayer(n, quad, 0.16, 0.005),
      path: new TileLayer(64, disc, 0.85, 0.014),
      target: new TileLayer(4, frame, 0.95, 0.016),
    };
    for (const layer of Object.values(this.layers)) this.scene.add(layer.mesh);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
    this.raf = requestAnimationFrame(this.frame);
  }

  // ---------------------------------------------------------------- setup

  private setupLights(): void {
    // A soft studio environment gives metal and painted parts believable reflections; generated once, no image files.
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const room = new RoomEnvironment();
    this.scene.environment = pmrem.fromScene(room, 0.04).texture;
    this.scene.environmentIntensity = 0.45;
    room.dispose();
    pmrem.dispose();

    const hemi = new THREE.HemisphereLight("#c4d2ec", "#4a3a2e", 0.8);
    this.scene.add(hemi);
    const sun = new THREE.DirectionalLight("#ffe0b8", 2.6);
    sun.position.set(-7, 12, 5);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.02;
    sun.shadow.radius = 3;
    const cam = sun.shadow.camera;
    cam.left = -8;
    cam.right = 8;
    cam.top = 8;
    cam.bottom = -8;
    cam.near = 1;
    cam.far = 40;
    this.scene.add(sun);
    const rim = new THREE.DirectionalLight("#8fb2ff", 0.7);
    rim.position.set(8, 6, -8);
    this.scene.add(rim);
  }

  toWorld = (c: Coord): THREE.Vector3 => {
    const b = this.board!;
    return new THREE.Vector3(c[0] - (b.width - 1) / 2, 0, c[1] - (b.height - 1) / 2);
  };

  /** Builds (or rebuilds) the diorama for a board. Robots are re-created so colours and positions are fresh. */
  setMatch(board: Board, rules: RulesConfig, state: GameState, colors: Record<Side, string>, names: Record<Side, string>): void {
    this.animator.finishAll();
    const key = `${board.mapId}:${board.starts.A.join()}`;
    this.board = board;
    this.rules = rules;
    this.colors = { ...colors };
    if (key !== this.boardKey) {
      this.boardKey = key;
      this.buildBoard(board);
    }
    this.buildRobots(names);
    this.sync(state);
    this.computeExtent();
    this.fitCamera();
  }

  private disposeGroup(group: THREE.Object3D): void {
    group.traverse((obj) => {
      const m = obj as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
      const mat = m.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
      else mat?.dispose();
    });
  }

  private buildBoard(board: Board): void {
    this.scene.remove(this.boardGroup);
    this.disposeGroup(this.boardGroup);
    const group = new THREE.Group();
    this.boardGroup = group;
    this.scene.add(group);
    const rand = seeded(board.width * 131 + board.height * 17 + board.mapId.length * 7);

    // Plinth: two earth strata under the tiles, visible through the seams and at the edges.
    const w = board.width + 0.34;
    const d = board.height + 0.34;
    const grain = grainTexture(11, 256, 1.2);
    grain.repeat.set(2, 1);
    const top = new THREE.Mesh(new RoundedBoxGeometry(w, 0.5, d, 2, 0.06), new THREE.MeshStandardMaterial({ color: PALETTE.plinthTop, roughness: 0.95, map: grain }));
    top.position.y = -TILE_HEIGHT - 0.2;
    top.receiveShadow = true;
    const bottom = new THREE.Mesh(new RoundedBoxGeometry(w - 0.3, 0.55, d - 0.3, 2, 0.08), new THREE.MeshStandardMaterial({ color: PALETTE.plinthBottom, roughness: 1, map: grain }));
    bottom.position.y = -TILE_HEIGHT - 0.68;
    group.add(top, bottom);
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(board.width * 2.2, board.height * 2.2),
      new THREE.MeshBasicMaterial({ map: this.dotTex, color: "#000000", transparent: true, opacity: 0.55, depthWrite: false }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -TILE_HEIGHT - 1.0;
    ground.renderOrder = -1;
    group.add(ground);
    const seam = new THREE.Mesh(new THREE.BoxGeometry(board.width - 0.04, 0.3, board.height - 0.04), new THREE.MeshStandardMaterial({ color: "#2a221d", roughness: 1 }));
    seam.position.y = -TILE_HEIGHT * 0.5 - 0.06;
    group.add(seam);

    // Floor tiles: one instanced, bevelled block per tile with subtle colour variation.
    const tileGeo = new RoundedBoxGeometry(0.955, TILE_HEIGHT, 0.955, 2, 0.045);
    const tileMat = new THREE.MeshStandardMaterial({ color: "#ffffff", roughness: 0.86, metalness: 0.02, map: grainTexture(3) });
    const padMat = new THREE.MeshStandardMaterial({ color: PALETTE.pad, roughness: 0.38, metalness: 0.45, map: grainTexture(5, 256, 0.6) });
    const tiles = new THREE.InstancedMesh(tileGeo, tileMat, board.width * board.height);
    const dummy = new THREE.Object3D();
    const color = new THREE.Color();
    let i = 0;
    for (let y = 0; y < board.height; y++) {
      for (let x = 0; x < board.width; x++) {
        const p = this.toWorld([x, y]);
        const kind = board.tiles[y][x];
        if (kind === "uplink") {
          const pad = new THREE.Mesh(tileGeo, padMat);
          pad.position.set(p.x, -TILE_HEIGHT / 2, p.z);
          pad.receiveShadow = true;
          group.add(pad);
          continue;
        }
        dummy.position.set(p.x, -TILE_HEIGHT / 2 - rand() * 0.012, p.z);
        dummy.rotation.set(0, 0, 0);
        dummy.updateMatrix();
        tiles.setMatrixAt(i, dummy.matrix);
        color.set((x + y) % 2 ? PALETTE.floorA : PALETTE.floorB);
        color.offsetHSL((rand() - 0.5) * 0.012, (rand() - 0.5) * 0.03, (rand() - 0.5) * 0.035);
        tiles.setColorAt(i, color);
        i++;
      }
    }
    tiles.count = i;
    tiles.receiveShadow = true;
    tiles.castShadow = false;
    group.add(tiles);

    // Walls: weathered concrete pillars with a steel cap, heights varied for a natural skyline.
    const wallTiles: Coord[] = [];
    const barrierTiles: Coord[] = [];
    for (let y = 0; y < board.height; y++)
      for (let x = 0; x < board.width; x++) {
        if (board.tiles[y][x] === "wall") wallTiles.push([x, y]);
        if (board.tiles[y][x] === "barrier") barrierTiles.push([x, y]);
      }
    const pillarGeo = new RoundedBoxGeometry(0.8, 1, 0.8, 2, 0.05);
    const capGeo = new RoundedBoxGeometry(0.86, 0.1, 0.86, 2, 0.03);
    const pillarMat = new THREE.MeshStandardMaterial({ color: PALETTE.wall, roughness: 0.9, map: grainTexture(7, 256, 1.4) });
    const capMat = new THREE.MeshStandardMaterial({ color: PALETTE.wallCap, roughness: 0.45, metalness: 0.55 });
    const pillars = new THREE.InstancedMesh(pillarGeo, pillarMat, Math.max(1, wallTiles.length));
    const caps = new THREE.InstancedMesh(capGeo, capMat, Math.max(1, wallTiles.length));
    wallTiles.forEach((c, k) => {
      const p = this.toWorld(c);
      const h = 0.78 + rand() * 0.3;
      dummy.position.set(p.x, h / 2, p.z);
      dummy.scale.set(1, h, 1);
      dummy.rotation.set(0, 0, 0);
      dummy.updateMatrix();
      pillars.setMatrixAt(k, dummy.matrix);
      dummy.position.set(p.x, h + 0.04, p.z);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      caps.setMatrixAt(k, dummy.matrix);
    });
    pillars.count = caps.count = wallTiles.length;
    for (const m of [pillars, caps]) {
      m.castShadow = true;
      m.receiveShadow = true;
      group.add(m);
    }

    // Barriers: low concrete jersey barriers with a hazard band, aligned to their neighbours.
    const shape = new THREE.Shape();
    shape.moveTo(-0.3, 0);
    shape.lineTo(0.3, 0);
    shape.lineTo(0.2, 0.12);
    shape.lineTo(0.12, 0.46);
    shape.lineTo(-0.12, 0.46);
    shape.lineTo(-0.2, 0.12);
    shape.closePath();
    const barrierGeo = new THREE.ExtrudeGeometry(shape, { depth: 0.84, bevelEnabled: true, bevelSize: 0.02, bevelThickness: 0.02, bevelSegments: 2 });
    barrierGeo.translate(0, 0, -0.42);
    const bandGeo = new THREE.BoxGeometry(0.27, 0.07, 0.86);
    const barrierMat = new THREE.MeshStandardMaterial({ color: PALETTE.barrier, roughness: 0.85, map: grainTexture(9, 256, 1.2) });
    const band = hazardTexture();
    band.repeat.set(1, 3);
    const bandMat = new THREE.MeshStandardMaterial({ map: band, roughness: 0.6 });
    const barriers = new THREE.InstancedMesh(barrierGeo, barrierMat, Math.max(1, barrierTiles.length));
    const bands = new THREE.InstancedMesh(bandGeo, bandMat, Math.max(1, barrierTiles.length));
    barrierTiles.forEach((c, k) => {
      const p = this.toWorld(c);
      const vertical = board.tiles[c[1] - 1]?.[c[0]] === "barrier" || board.tiles[c[1] + 1]?.[c[0]] === "barrier";
      const rot = vertical ? 0 : Math.PI / 2;
      dummy.position.set(p.x, 0, p.z);
      dummy.rotation.set(0, rot, 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      barriers.setMatrixAt(k, dummy.matrix);
      dummy.position.set(p.x, 0.31, p.z);
      dummy.updateMatrix();
      bands.setMatrixAt(k, dummy.matrix);
    });
    barriers.count = bands.count = barrierTiles.length;
    for (const m of [barriers, bands]) {
      m.castShadow = true;
      m.receiveShadow = true;
      group.add(m);
    }

    // Uplinks: steel pad, owner-coloured inset ring, antenna mast with a beacon and a faint beam.
    this.uplinks = board.uplinks.map((u) => {
      const p = this.toWorld(u.at);
      const g = new THREE.Group();
      g.position.copy(p);
      const prime = u.value > 1;
      const ring = new THREE.Mesh(new THREE.RingGeometry(prime ? 0.27 : 0.25, prime ? 0.36 : 0.32, 48), new THREE.MeshBasicMaterial({ color: PALETTE.neutral, transparent: true, opacity: 0.85 }));
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.008;
      g.add(ring);
      if (prime) {
        const inner = new THREE.Mesh(new THREE.RingGeometry(0.16, 0.19, 40), ring.material);
        inner.rotation.x = -Math.PI / 2;
        inner.position.y = 0.008;
        g.add(inner);
      }
      const mastHeight = prime ? 1.05 : 0.75;
      const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.03, mastHeight, 8), capMat);
      mast.position.set(0.36, mastHeight / 2, -0.36);
      mast.castShadow = true;
      g.add(mast);
      const foot = new THREE.Mesh(new RoundedBoxGeometry(0.14, 0.06, 0.14, 1, 0.02), capMat);
      foot.position.set(0.36, 0.03, -0.36);
      g.add(foot);
      const beacon = new THREE.Mesh(new THREE.SphereGeometry(prime ? 0.06 : 0.045, 16, 12), new THREE.MeshStandardMaterial({ color: "#111", emissive: PALETTE.neutral, emissiveIntensity: 1.4 }));
      beacon.position.set(0.36, mastHeight + 0.04, -0.36);
      g.add(beacon);
      const beam = new THREE.Mesh(
        new THREE.CylinderGeometry(0.3, 0.33, 1.6, 32, 1, true),
        new THREE.MeshBasicMaterial({ color: PALETTE.neutral, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }),
      );
      beam.position.y = 0.8;
      g.add(beam);
      group.add(g);
      return { id: u.id, at: u.at, value: u.value, ring: ring as UplinkView["ring"], beacon: beacon as UplinkView["beacon"], beam: beam as UplinkView["beam"], owner: null };
    });
  }

  private buildRobots(names: Record<Side, string>): void {
    if (this.robots) {
      for (const view of Object.values(this.robots)) {
        this.scene.remove(view.rig.root);
        view.rig.dispose();
        view.plate.remove();
      }
    }
    for (const s of this.smoke) this.fx.remove(s.sprite);
    this.smoke = [];
    const make = (side: Side): RobotView => {
      const rig = buildRobot(this.colors[side]);
      rig.root.scale.setScalar(ROBOT_SCALE);
      this.scene.add(rig.root);
      const plate = document.createElement("div");
      plate.className = "bf-plate";
      plate.dataset.side = side;
      const plateName = document.createElement("span");
      plateName.className = "bf-plate-name";
      plateName.textContent = names[side];
      const bar = document.createElement("div");
      bar.className = "bf-plate-bar";
      const plateHp = document.createElement("div");
      plateHp.className = "bf-plate-hp";
      bar.appendChild(plateHp);
      plate.append(plateName, bar);
      plate.style.setProperty("--team", this.colors[side]);
      this.labels.appendChild(plate);
      return { rig, side, pos: [0, 0], facing: 0, braced: false, disabled: 0, walking: 0, plate, plateHp, plateName };
    };
    this.robots = { A: make("A"), B: make("B") };
  }

  setColors(colors: Record<Side, string>): void {
    this.colors = { ...colors };
    if (!this.robots) return;
    for (const side of ["A", "B"] as const) {
      this.robots[side].rig.setColor(colors[side]);
      this.robots[side].plate.style.setProperty("--team", colors[side]);
    }
    for (const u of this.uplinks) this.paintUplink(u, u.owner, 1);
  }

  setNames(names: Record<Side, string>): void {
    if (!this.robots) return;
    this.robots.A.plateName.textContent = names.A;
    this.robots.B.plateName.textContent = names.B;
  }

  private paintUplink(u: UplinkView, owner: Side | null, _t: number): void {
    u.owner = owner;
    const c = owner ? new THREE.Color(this.colors[owner]) : new THREE.Color(PALETTE.neutral);
    u.ring.material.color.copy(c);
    u.beacon.material.emissive.copy(owner ? lighten(this.colors[owner], 0.2) : c);
    u.beam.material.color.copy(c);
    u.beam.material.opacity = owner ? 0.07 : 0;
  }

  /** Snap every visual to a state instantly (setup, replay scrubbing, after interrupts). */
  sync(state: GameState): void {
    if (!this.robots || !this.board || !this.rules) return;
    this.animator.finishAll();
    for (const side of ["A", "B"] as const) {
      const view = this.robots[side];
      const robot = state.robots[side];
      view.pos = robot.pos;
      const p = this.toWorld(robot.pos);
      view.rig.root.position.copy(p);
      const enemy = this.toWorld(state.robots[otherSide(side)].pos);
      view.facing = Math.atan2(enemy.x - p.x, enemy.z - p.z);
      view.rig.root.rotation.y = view.facing;
      view.braced = robot.braced;
      this.setShield(view, robot.braced ? 1 : 0);
      view.disabled = robot.hp <= 0 ? 1 : 0;
      view.rig.setDisabled(view.disabled);
      view.rig.flash(0);
      view.walking = 0;
      this.resetPose(view);
      this.setPlateHp(view, robot.hp);
      if (view.disabled) this.ensureSmoke(side);
    }
    this.smoke = this.smoke.filter((s) => {
      if (state.robots[s.side].hp > 0) {
        this.fx.remove(s.sprite);
        return false;
      }
      return true;
    });
    for (const u of this.uplinks) this.paintUplink(u, state.owners[u.id] ?? null, 1);
    this.showWatch("A", state.robots.A.overwatch ? watchedTiles(this.board, this.rules, state.robots.A.pos) : []);
    this.showWatch("B", state.robots.B.overwatch ? watchedTiles(this.board, this.rules, state.robots.B.pos) : []);
    this.layers.path.clear();
    this.layers.target.clear();
  }

  private resetPose(view: RobotView): void {
    const r = view.rig;
    r.legL.rotation.x = r.legR.rotation.x = 0;
    r.kneeL.rotation.x = r.kneeR.rotation.x = 0;
    r.gun.rotation.x = 0;
    r.torso.position.z = 0;
  }

  private setPlateHp(view: RobotView, hp: number): void {
    const max = this.rules?.maxHp ?? 12;
    view.plateHp.style.transform = `scaleX(${Math.max(0, hp) / max})`;
    view.plate.classList.toggle("is-down", hp <= 0);
  }

  private setShield(view: RobotView, amount: number): void {
    const mat = view.rig.shield.material as THREE.ShaderMaterial;
    mat.uniforms.uOpacity.value = amount;
    view.rig.shield.visible = amount > 0.001;
    view.rig.shield.scale.setScalar(0.85 + amount * 0.15);
  }

  private showWatch(side: Side, tiles: Coord[]): void {
    const layer = side === "A" ? this.layers.watchA : this.layers.watchB;
    if (!tiles.length) layer.clear();
    else layer.set(tiles, this.colors[side], this.toWorld);
  }

  /** While a model thinks, its legal destinations glow faintly: the decision space viewers are watching. */
  showThinking(side: Side | null, state: GameState | null): void {
    if (!side || !state || !this.board || !this.rules || state.result) {
      this.layers.move.clear();
      return;
    }
    const tiles = [...moveOptions(this.board, this.rules, state, side).values()].map((p) => p[p.length - 1]);
    this.layers.move.set(tiles, this.colors[side], this.toWorld);
  }

  /** Highlights a past action (from the turn feed) without changing the robots. */
  previewTurn(turn: TurnRecord | null): void {
    if (!turn || !this.board) {
      this.layers.path.clear();
      this.layers.target.clear();
      return;
    }
    const moved = turn.events.find((e): e is Extract<GameEvent, { kind: "moved" }> => e.kind === "moved");
    if (moved) {
      this.layers.path.set(moved.path.slice(1), this.colors[turn.side], this.toWorld);
      this.layers.target.set([moved.path[moved.path.length - 1]], this.colors[turn.side], this.toWorld);
    } else {
      this.layers.path.clear();
      this.layers.target.set([turn.stateBefore.robots[turn.side].pos], this.colors[turn.side], this.toWorld);
    }
  }

  rotate(direction: 1 | -1): void {
    this.yawTarget += (direction * Math.PI) / 2;
  }

  // ---------------------------------------------------------------- presenting turns

  interrupt(): void {
    this.animator.finishAll();
  }

  async present(turn: TurnRecord): Promise<void> {
    if (!this.robots || !this.board) return;
    this.layers.move.clear();
    for (const event of turn.events) {
      if (this.disposed) return;
      await this.playEvent(event);
    }
    await this.animator.wait(120);
    this.sync(turn.stateAfter);
  }

  private async playEvent(e: GameEvent): Promise<void> {
    const robots = this.robots!;
    switch (e.kind) {
      case "overwatch-expired":
        this.showWatch(e.side, []);
        return;
      case "braced": {
        const view = robots[e.side];
        this.onSound("shield");
        view.braced = true;
        await this.animator.run(380, (t) => this.setShield(view, t), ease.outBack);
        return;
      }
      case "overwatch-set": {
        const view = robots[e.side];
        this.onSound("overwatch");
        this.showWatch(e.side, e.watched);
        await this.animator.run(420, (t) => {
          view.rig.gun.rotation.x = -Math.sin(t * Math.PI) * 0.25;
          view.rig.head.rotation.y = Math.sin(t * Math.PI * 2) * 0.35;
        });
        view.rig.head.rotation.y = 0;
        return;
      }
      case "moved":
        await this.walk(robots[e.side], e.path);
        return;
      case "fired":
        await this.fire(robots[e.side], robots[e.target], e.damage, e.modifiers, e.reaction);
        return;
      case "captured": {
        const u = this.uplinks.find((x) => x.id === e.uplinkId);
        if (!u) return;
        this.onSound("capture");
        this.paintUplink(u, e.side, 1);
        await this.pulse(u.at, this.colors[e.side]);
        return;
      }
      case "scored": {
        const view = robots[e.side];
        this.float(view, `+${e.points}`, "score", 0.55);
        this.onSound("score");
        await this.animator.wait(160);
        return;
      }
      case "disabled": {
        const view = robots[e.side];
        this.onSound("disabled");
        this.setShield(view, 0);
        await this.animator.run(800, (t) => {
          view.disabled = t;
          view.rig.setDisabled(t);
        }, ease.outCubic);
        this.ensureSmoke(e.side);
        return;
      }
      case "game-over":
        return;
    }
  }

  private async turnTo(view: RobotView, target: THREE.Vector3): Promise<void> {
    const p = view.rig.root.position;
    const goal = Math.atan2(target.x - p.x, target.z - p.z);
    const from = view.facing;
    let diff = Math.abs(((goal - from + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
    if (diff < 0.05) return;
    diff = Math.min(diff, Math.PI);
    await this.animator.run(120 + diff * 110, (t) => {
      view.facing = lerpAngle(from, goal, t);
      view.rig.root.rotation.y = view.facing;
    });
    view.facing = goal;
  }

  private async walk(view: RobotView, path: Coord[]): Promise<void> {
    this.layers.path.set(path.slice(1), this.colors[view.side], this.toWorld);
    this.layers.target.set([path[path.length - 1]], this.colors[view.side], this.toWorld);
    if (view.braced) {
      view.braced = false;
      void this.animator.run(200, (t) => this.setShield(view, 1 - t));
    }
    for (let i = 1; i < path.length; i++) {
      const from = this.toWorld(path[i - 1]);
      const to = this.toWorld(path[i]);
      await this.turnTo(view, to);
      this.onSound("step");
      await this.animator.run(
        340,
        (t) => {
          view.rig.root.position.lerpVectors(from, to, t);
          const phase = t * Math.PI * 2;
          const swing = Math.sin(phase) * 0.55;
          view.rig.legL.rotation.x = swing;
          view.rig.legR.rotation.x = -swing;
          view.rig.kneeL.rotation.x = Math.max(0, -Math.sin(phase)) * 0.7;
          view.rig.kneeR.rotation.x = Math.max(0, Math.sin(phase)) * 0.7;
          view.rig.body.position.y = Math.abs(Math.sin(phase)) * 0.035;
        },
        ease.linear,
      );
      view.pos = path[i];
    }
    this.resetPose(view);
    view.rig.body.position.y = 0;
    this.layers.path.clear();
    this.layers.target.clear();
  }

  private async fire(shooter: RobotView, target: RobotView, damage: number, modifiers: string[], reaction: boolean): Promise<void> {
    const targetPos = target.rig.root.position.clone();
    await this.turnTo(shooter, targetPos);
    this.layers.target.set([target.pos], this.colors[shooter.side], this.toWorld);
    if (reaction) this.float(shooter, "Overwatch", "tag", 0.55);

    shooter.rig.root.updateMatrixWorld(true);
    const start = shooter.rig.muzzle.getWorldPosition(new THREE.Vector3());
    const end = targetPos.clone().add(new THREE.Vector3(0, 0.55 * ROBOT_SCALE, 0));
    const color = lighten(this.colors[shooter.side], 0.45);
    this.onSound("fire");

    // Muzzle flash and recoil.
    const flash = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.dotTex, color, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
    flash.position.copy(start);
    this.fx.add(flash);
    const recoil = this.animator.run(220, (t) => {
      shooter.rig.torso.position.z = -Math.sin(t * Math.PI) * 0.05;
      const s = Math.sin(Math.min(1, t * 2) * Math.PI) * 0.55;
      flash.scale.setScalar(s);
    });

    // Bolt travelling to the target.
    const bolt = new THREE.Mesh(
      new THREE.CylinderGeometry(0.022, 0.022, 0.5, 6),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    const dir = end.clone().sub(start);
    const length = dir.length();
    bolt.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
    this.fx.add(bolt);
    await this.animator.run(Math.max(110, length * 40), (t) => bolt.position.lerpVectors(start, end, t), ease.linear);
    this.fx.remove(bolt);
    bolt.geometry.dispose();
    (bolt.material as THREE.Material).dispose();

    // Impact.
    this.onSound("hit");
    this.sparks(end, color);
    this.float(target, `−${damage}`, "damage", 0.7, modifiers.filter((m) => m !== "minimum").join(" · "));
    await Promise.all([
      recoil,
      this.animator.run(360, (t) => {
        target.rig.flash(Math.sin(t * Math.PI) * 0.9);
        target.rig.body.position.x = Math.sin(t * Math.PI * 4) * 0.025 * (1 - t);
        if (target.braced) {
          const mat = target.rig.shield.material as THREE.ShaderMaterial;
          mat.uniforms.uOpacity.value = 1 + Math.sin(t * Math.PI) * 1.2;
        }
      }),
    ]);
    target.rig.body.position.x = 0;
    this.fx.remove(flash);
    flash.material.dispose();
    this.layers.target.clear();
  }

  private sparks(at: THREE.Vector3, color: THREE.Color): void {
    const n = 26;
    const positions = new Float32Array(n * 3);
    const velocity: THREE.Vector3[] = [];
    const rand = seeded(Math.floor(at.x * 1000 + at.z * 77 + performance.now()));
    for (let i = 0; i < n; i++) {
      velocity.push(new THREE.Vector3((rand() - 0.5) * 2.4, rand() * 2 + 0.4, (rand() - 0.5) * 2.4));
      positions.set([at.x, at.y, at.z], i * 3);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    const material = new THREE.PointsMaterial({ color, size: 5, sizeAttenuation: false, map: this.dotTex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
    const points = new THREE.Points(geometry, material);
    this.fx.add(points);
    void this.animator
      .run(
        520,
        (t) => {
          const time = t * 0.52;
          for (let i = 0; i < n; i++) {
            const v = velocity[i];
            positions[i * 3] = at.x + v.x * time;
            positions[i * 3 + 1] = at.y + v.y * time - 4.5 * time * time;
            positions[i * 3 + 2] = at.z + v.z * time;
          }
          geometry.attributes.position.needsUpdate = true;
          material.opacity = 1 - t;
        },
        ease.linear,
      )
      .then(() => {
        this.fx.remove(points);
        geometry.dispose();
        material.dispose();
      });
  }

  private async pulse(at: Coord, color: string): Promise<void> {
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.3, 0.36, 48), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide }));
    ring.rotation.x = -Math.PI / 2;
    const p = this.toWorld(at);
    ring.position.set(p.x, 0.02, p.z);
    this.fx.add(ring);
    await this.animator.run(
      560,
      (t) => {
        ring.scale.setScalar(1 + t * 1.6);
        (ring.material as THREE.MeshBasicMaterial).opacity = 0.9 * (1 - t);
      },
      ease.outCubic,
    );
    this.fx.remove(ring);
    ring.geometry.dispose();
    (ring.material as THREE.Material).dispose();
  }

  private ensureSmoke(side: Side): void {
    if (this.smoke.some((s) => s.side === side)) return;
    for (let i = 0; i < 5; i++) {
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.dotTex, color: "#55504a", transparent: true, opacity: 0, depthWrite: false }));
      this.fx.add(sprite);
      this.smoke.push({ sprite, t: i / 5, side });
    }
  }

  private float(view: RobotView, text: string, kind: "damage" | "score" | "tag", height: number, sub = ""): void {
    const el = document.createElement("div");
    el.className = `bf-float bf-float--${kind}`;
    el.style.setProperty("--team", this.colors[view.side]);
    el.textContent = text;
    if (sub) {
      const small = document.createElement("small");
      small.textContent = sub;
      el.appendChild(small);
    }
    this.labels.appendChild(el);
    const floater: Floater = { el, world: view.rig.root.position.clone().add(new THREE.Vector3(0, height * 1.2, 0)) };
    this.floaters.push(floater);
    window.setTimeout(() => {
      el.remove();
      this.floaters = this.floaters.filter((f) => f !== floater);
    }, 1300);
  }

  // ---------------------------------------------------------------- frame loop

  private computeExtent(): void {
    if (!this.board) return;
    const hw = this.board.width / 2 + 0.2;
    const hd = this.board.height / 2 + 0.2;
    const points: THREE.Vector3[] = [];
    for (const x of [-hw, hw]) for (const z of [-hd, hd]) for (const y of [-TILE_HEIGHT - 0.95, 1.3]) points.push(new THREE.Vector3(x, y, z));
    // Extents in the camera's screen plane for the current yaw.
    const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const forward = new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    const up = new THREE.Vector3(0, Math.cos(ELEVATION), 0).addScaledVector(forward, -Math.sin(ELEVATION));
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const p of points) {
      const sx = p.dot(right);
      const sy = p.dot(up);
      minX = Math.min(minX, sx);
      maxX = Math.max(maxX, sx);
      minY = Math.min(minY, sy);
      maxY = Math.max(maxY, sy);
    }
    this.viewExtent = { cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, w: maxX - minX, h: maxY - minY };
  }

  setInsets(top: number, bottom: number): void {
    this.insets = { top, bottom };
    this.fitCamera();
  }

  private fitCamera(): void {
    const pad = this.width < 640 ? 1.03 : 1.08;
    const { w, h, cx, cy } = this.viewExtent;
    const avail = Math.max(80, this.height - this.insets.top - this.insets.bottom);
    // World units per pixel: whichever of width or (inset-reduced) height is the tighter fit.
    const perPx = Math.max((w * pad) / this.width, (h * pad) / avail);
    const halfW = (this.width * perPx) / 2;
    const top = cy + (this.insets.top + avail / 2) * perPx;
    this.camera.left = cx - halfW;
    this.camera.right = cx + halfW;
    this.camera.top = top;
    this.camera.bottom = top - this.height * perPx;
    const dist = 30;
    this.camera.position.set(Math.sin(this.yaw) * Math.cos(ELEVATION) * dist, Math.sin(ELEVATION) * dist, Math.cos(this.yaw) * Math.cos(ELEVATION) * dist);
    this.camera.lookAt(0, 0, 0);
    // Shift the frustum rather than the camera so the extents stay centred.
    this.camera.updateProjectionMatrix();
  }

  private resize(): void {
    const rect = this.container.getBoundingClientRect();
    this.width = Math.max(1, rect.width);
    this.height = Math.max(1, rect.height);
    this.renderer.setSize(this.width, this.height, false);
    this.fitCamera();
  }

  private frame = (now: number): void => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.frame);
    const dt = Math.min(0.05, (now - (this.lastTime || now)) / 1000);
    this.lastTime = now;
    this.animator.tick(now);

    if (Math.abs(this.yaw - this.yawTarget) > 0.0005) {
      this.yaw = lerp(this.yaw, this.yawTarget, Math.min(1, dt * 6));
      this.computeExtent();
      this.fitCamera();
    }
    for (const layer of Object.values(this.layers)) layer.step(dt);

    const t = now / 1000;
    if (this.robots) {
      for (const view of Object.values(this.robots)) {
        if (!this.reducedMotion && view.disabled === 0) view.rig.torso.position.y = 0.41 + Math.sin(t * 2.1 + (view.side === "A" ? 0 : 1.7)) * 0.006;
        const mat = view.rig.shield.material as THREE.ShaderMaterial;
        mat.uniforms.uTime.value = t;
      }
    }
    for (const u of this.uplinks) {
      const glow = u.owner ? 0.75 + Math.sin(t * 2.4 + u.at[0]) * 0.15 : 0.55;
      u.ring.material.opacity = this.reducedMotion ? 0.85 : glow;
      u.beacon.material.emissiveIntensity = u.owner ? 1.6 + Math.sin(t * 4 + u.at[1]) * 0.6 : 1;
    }
    for (const s of this.smoke) {
      const view = this.robots?.[s.side];
      if (!view) continue;
      s.t = (s.t + dt * 0.35) % 1;
      const base = view.rig.root.position;
      s.sprite.position.set(base.x + Math.sin(s.t * 6 + s.sprite.id) * 0.08, 0.6 + s.t * 1.1, base.z + Math.cos(s.t * 5) * 0.08);
      s.sprite.scale.setScalar(0.25 + s.t * 0.55);
      s.sprite.material.opacity = Math.sin(s.t * Math.PI) * 0.45;
    }

    this.renderer.render(this.scene, this.camera);
    this.updateLabels();
  };

  private project(world: THREE.Vector3): { x: number; y: number } {
    this.tmp.copy(world).project(this.camera);
    return { x: ((this.tmp.x + 1) / 2) * this.width, y: ((1 - this.tmp.y) / 2) * this.height };
  }

  private updateLabels(): void {
    if (this.robots) {
      for (const view of Object.values(this.robots)) {
        const p = this.project(this.tmp.copy(view.rig.root.position).setY(1.45));
        view.plate.style.transform = `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px) translate(-50%, -100%)`;
      }
    }
    for (const f of this.floaters) {
      const p = this.project(f.world);
      f.el.style.left = `${p.x.toFixed(1)}px`;
      f.el.style.top = `${p.y.toFixed(1)}px`;
    }
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.animator.finishAll();
    this.resizeObserver.disconnect();
    this.disposeGroup(this.scene);
    this.scene.environment?.dispose();
    this.dotTex.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.labels.remove();
  }
}
