/* The Docks — blocky 3D renderer, camera and movement (three.js). */
import * as THREE from "three";
import { spriteFrame, type GenerationSprites, type SpriteFacing } from "@rarefriends/friendsdk/sprites";
import {
  DECK, SURF, deckOrigin, landOrigin, nearestSpot, spawnPoint, statusOf, walkable, you,
  type Spot, type World,
} from "./model.js";
import { floorTexture, makeDecor, makeProp } from "./props3d.js";

type Options = {
  onNear: (spot: Spot | null) => void;
  onTick: (dt: number) => void;
  onTapSpot: (spot: Spot) => void;
};
export type Engine = ReturnType<typeof createEngine>;

const SPEED = 3.4, RADIUS = 0.28, VOXEL = 0.085;
const box = new THREE.BoxGeometry(1, 1, 1);
const mat = (color: number) => new THREE.MeshLambertMaterial({ color });
const MATS = {
  water: mat(0x2f86bd), slab: mat(0x111111), deck: mat(0xc0894f), dirt: mat(0x8a5a3b), dirtDark: mat(0x5e3b25), plank: mat(0xb9844f), post: mat(0x7a5230),
  wall: mat(0xfff1d6), door: mat(0x6b3f23), fence: mat(0xd8b47a), stem: mat(0x3f9b3a), berry: mat(0x4b4bd6),
  chicken: mat(0xfafafa), comb: mat(0xe23b3b), beak: mat(0xffb020), awning2: mat(0xffffff), board: mat(0xfff6e0),
  ink: mat(0x16131f), halo: mat(0xffffff), drop: mat(0x2f8cff), hungry: mat(0xff9f1c), shadow: new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.18 }),
  cap: mat(0x1f3a8a), capBrim: mat(0xffffff), crown: mat(0xffd84a), petal: mat(0xff7eb6),
};

const LINE_MAT = new THREE.LineBasicMaterial({ color: 0x000000 });
const floorMats = new Map<string, THREE.Material>();
function cube(material: THREE.Material, w: number, h: number, d: number, x: number, y: number, z: number) {
  const m = new THREE.Mesh(box, material); m.scale.set(w, h, d); m.position.set(x, y, z); return m;
}

export function createEngine(container: HTMLElement, world: World, opts: Options) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "low-power" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.domElement.className = "docks-canvas";
  renderer.domElement.setAttribute("aria-hidden", "true");
  container.appendChild(renderer.domElement);
  const labels = document.createElement("div"); labels.className = "docks-labels"; container.appendChild(labels);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x2f86bd);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x6b8fa3, 1.6));
  const sun = new THREE.DirectionalLight(0xffffff, 1.4); sun.position.set(-6, 14, 4); scene.add(sun);

  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 200);
  const OFFSET = new THREE.Vector3(14, 17, 14);
  const focus = new THREE.Vector3();

  // endless sea: a large plane that follows the camera
  const water = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), MATS.water);
  water.rotation.x = -Math.PI / 2; water.position.y = -0.75; scene.add(water);

  /* ── statics (rebuilt after docking) ── */
  let statics = new THREE.Group(); scene.add(statics);
  type Dyn = { plants: THREE.Group[][]; chickens: THREE.Group[][]; needs: THREE.Mesh[][]; hungry: THREE.Mesh[][] };
  let dyn: Dyn = { plants: [], chickens: [], needs: [], hungry: [] };
  let labelEls: { el: HTMLDivElement; pos: THREE.Vector3 }[] = [];
  let spinners: THREE.Object3D[] = [];

  function buildStatics() {
    scene.remove(statics);
    statics.traverse(o => { if ((o instanceof THREE.Mesh || o instanceof THREE.InstancedMesh) && o.geometry !== box && !o.userData.shared) o.geometry.dispose(); });
    statics = new THREE.Group(); scene.add(statics);
    dyn = { plants: [], chickens: [], needs: [], hungry: [] };
    labels.replaceChildren(); labelEls = []; spinners = [];
    const tmpM = new THREE.Object3D();
    const instanced = (material: THREE.Material, cells: [number, number][], h: number, y: number, jitter = 0) => {
      if (!cells.length) return;
      const im = new THREE.InstancedMesh(box, material, cells.length);
      cells.forEach(([x, z], i) => { tmpM.position.set(x + 0.5, y, z + 0.5); tmpM.scale.set(1, h + (jitter ? ((x * 13 + z * 7) % 3) * jitter : 0), 1); tmpM.updateMatrix(); im.setMatrixAt(i, tmpM.matrix); });
      statics.add(im);
    };

    // planks (gangways) from each piece
    const planks: [number, number][] = [];
    for (const p of world.plots) p.piece.surface.forEach((v, i) => { if (v === SURF.plank) planks.push([p.pos.x + (i % p.piece.w), p.pos.y + Math.floor(i / p.piece.w)]); });
    instanced(MATS.plank, planks, 0.14, -0.12);
    planks.forEach(([x, y], i) => { if (i % 3 === 0) statics.add(cube(MATS.post, 0.14, 0.9, 0.14, x + 0.15, -0.5, y + 0.15)); });

    for (const p of world.plots) {
      // imported land: black slab sides, white patterned top (like the on-chain renderer)
      const lo = landOrigin(p);
      const cells: [number, number][] = [];
      p.land.tiles.forEach((t, i) => { if (t) cells.push([lo.x + (i % p.land.w), lo.y + Math.floor(i / p.land.w)]); });
      instanced(MATS.slab, cells, 0.9, -0.55);
      let top = floorMats.get(p.land.floor);
      if (!top) { top = new THREE.MeshLambertMaterial({ map: floorTexture(p.land.floor) }); floorMats.set(p.land.floor, top); }
      instanced(top, cells, 0.12, -0.04);
      // outline the land's top edge
      const seg: number[] = [];
      const has = (x: number, y: number) => x >= 0 && y >= 0 && x < p.land.w && y < p.land.h && p.land.tiles[y * p.land.w + x];
      for (let y = 0; y < p.land.h; y++) for (let x = 0; x < p.land.w; x++) {
        if (!has(x, y)) continue;
        const X = lo.x + x, Z = lo.y + y;
        if (!has(x, y - 1)) seg.push(X, 0.03, Z, X + 1, 0.03, Z);
        if (!has(x, y + 1)) seg.push(X, 0.03, Z + 1, X + 1, 0.03, Z + 1, X, -0.99, Z + 1, X + 1, -0.99, Z + 1);
        if (!has(x - 1, y)) seg.push(X, 0.03, Z, X, 0.03, Z + 1);
        if (!has(x + 1, y)) seg.push(X + 1, 0.03, Z, X + 1, 0.03, Z + 1, X + 1, -0.99, Z, X + 1, -0.99, Z + 1);
      }
      const lg = new THREE.BufferGeometry(); lg.setAttribute("position", new THREE.Float32BufferAttribute(seg, 3));
      statics.add(new THREE.LineSegments(lg, LINE_MAT));
      for (const pr of p.land.props) {
        const m = makeProp(pr.name);
        m.position.set(lo.x + pr.x, 0.02, lo.y + pr.y);
        m.scale.multiplyScalar(Math.min(1.3, Math.max(0.6, pr.scale)));
        if (pr.flip) m.rotation.y = Math.PI / 2;
        m.traverse(o => { o.userData.shared = true; });
        statics.add(m);
      }

      for (const d of p.decor) {
        const m = makeDecor(d.item); m.position.set(lo.x + d.x + 0.5, 0.02, lo.y + d.y + 0.5);
        m.traverse(o => { o.userData.shared = true; if (o.userData.spin) spinners.push(o); });
        statics.add(m);
      }
      // deck with the game's farm
      const d = deckOrigin(p);
      const g = new THREE.Group(); g.position.set(d.x, 0, d.y); statics.add(g);
      const deckCells: [number, number][] = [];
      p.piece.surface.forEach((v, i) => { if (v === SURF.deck) deckCells.push([p.pos.x + (i % p.piece.w), p.pos.y + Math.floor(i / p.piece.w)]); });
      instanced(MATS.deck, deckCells, 0.3, -0.15, 0.02);
      // status flag: taller pole and tier colour as the land gains weight and development
      const st = statusOf(world, p);
      let fx = lo.x + p.land.w / 2, fz = lo.y + 1;
      for (let i = 0; i < p.land.tiles.length; i++) if (p.land.tiles[i] && !p.piece.blocked[(p.piece.land.y + Math.floor(i / p.land.w)) * p.piece.w + p.piece.land.x + (i % p.land.w)]) { fx = lo.x + (i % p.land.w) + 0.5; fz = lo.y + Math.floor(i / p.land.w) + 0.5; break; }
      const poleH = 1.6 + st.tier * 0.7;
      statics.add(cube(MATS.post, 0.08, poleH, 0.08, fx, poleH / 2, fz));
      const flag = cube(mat(st.color), 0.06, 0.45 + st.tier * 0.08, 0.7 + st.tier * 0.12, fx, poleH - 0.3, fz + 0.4);
      statics.add(flag);
      const plants: THREE.Group[] = [], needs: THREE.Mesh[] = [];
      DECK.beds.forEach(b => {
        g.add(cube(MATS.dirtDark, 0.9, 0.25, 0.9, b.x + 0.5, 0.1, b.y + 0.5));
        const plant = new THREE.Group(); plant.position.set(b.x + 0.5, 0.22, b.y + 0.5);
        plant.add(cube(MATS.stem, 0.14, 1, 0.14, 0, 0.5, 0));
        plant.add(cube(MATS.stem, 0.5, 0.35, 0.5, 0, 0.95, 0));
        for (let i = 0; i < 4; i++) plant.add(cube(MATS.berry, 0.16, 0.16, 0.16, Math.cos(i * 1.6) * 0.28, 0.8 + (i % 2) * 0.25, Math.sin(i * 1.6) * 0.28));
        g.add(plant); plants.push(plant);
        const need = cube(MATS.drop, 0.22, 0.3, 0.22, b.x + 0.5, 1.9, b.y + 0.5); g.add(need); needs.push(need);
      });
      dyn.plants.push(plants); dyn.needs.push(needs);
      const pen = DECK.pen;
      for (let i = 0; i < pen.w; i++) for (let j = 0; j < pen.h; j++) {
        if (i !== 0 && j !== 0 && i !== pen.w - 1 && j !== pen.h - 1) continue;
        g.add(cube(MATS.fence, 0.16, 0.7, 0.16, pen.x + i + 0.5, 0.35, pen.y + j + 0.5));
        g.add(cube(MATS.fence, i === 0 || i === pen.w - 1 ? 0.1 : 1, 0.1, j === 0 || j === pen.h - 1 ? 0.1 : 1, pen.x + i + 0.5, 0.5, pen.y + j + 0.5));
      }
      const chickens: THREE.Group[] = [], hungry: THREE.Mesh[] = [];
      for (const _ of p.animals) {
        const c = new THREE.Group();
        c.add(cube(MATS.chicken, 0.42, 0.34, 0.5, 0, 0.3, 0));
        c.add(cube(MATS.chicken, 0.26, 0.26, 0.26, 0, 0.55, 0.22));
        c.add(cube(MATS.comb, 0.08, 0.12, 0.16, 0, 0.73, 0.22));
        c.add(cube(MATS.beak, 0.1, 0.08, 0.12, 0, 0.53, 0.4));
        const hm = cube(MATS.hungry, 0.18, 0.18, 0.18, 0, 1.05, 0); c.add(hm); hungry.push(hm);
        g.add(c); chickens.push(c);
      }
      dyn.chickens.push(chickens); dyn.hungry.push(hungry);
      const s = DECK.stall, accent = mat(p.accent);
      g.add(cube(MATS.board, 0.95, 0.8, 0.8, s.x + 0.5, 0.4, s.y + 0.5));
      g.add(cube(MATS.post, 0.08, 1.5, 0.08, s.x + 0.1, 0.75, s.y + 0.15));
      g.add(cube(MATS.post, 0.08, 1.5, 0.08, s.x + 0.9, 0.75, s.y + 0.15));
      for (let i = 0; i < 4; i++) g.add(cube(i % 2 ? MATS.awning2 : accent, 0.26, 0.1, 1, s.x + 0.12 + i * 0.25, 1.5, s.y + 0.4));
      if (p.owner === "you") {
        g.add(cube(MATS.post, 0.1, 1.1, 0.1, DECK.sign.x, 0.55, DECK.sign.y));
        g.add(cube(MATS.board, 0.9, 0.45, 0.08, DECK.sign.x, 1.05, DECK.sign.y + 0.05));
      }
      const el = document.createElement("div"); el.className = `docks-label ${p.owner === "you" ? "mine" : ""}`;
      el.textContent = p.owner === "you" ? `Your land · ${st.name}${p.attached ? "" : " · adrift"}` : `${p.name} · ${st.name} · sample`;
      el.style.borderColor = "#000"; el.style.background = `#${st.color.toString(16).padStart(6, "0")}`;
      labels.appendChild(el); labelEls.push({ el, pos: new THREE.Vector3(fx, poleH + 0.6, fz) });
    }
  }
  buildStatics();

  /* ── the player's Friend, as voxels ── */
  const friend = new THREE.Group(); scene.add(friend);
  const body = new THREE.Group(); body.rotation.y = Math.PI / 4; friend.add(body);
  const shadow = new THREE.Mesh(new THREE.CircleGeometry(0.42, 16), MATS.shadow); shadow.rotation.x = -Math.PI / 2; shadow.position.y = 0.02; friend.add(shadow);
  const inkMesh = new THREE.InstancedMesh(box, MATS.ink, 256), haloMesh = new THREE.InstancedMesh(box, MATS.halo, 256);
  body.add(haloMesh, inkMesh);
  const hatGroup = new THREE.Group(); body.add(hatGroup);
  let sprites: GenerationSprites | null = null, frameKey = "", hat: string | null = null;
  const tmp = new THREE.Object3D();

  function drawFriend(facing: SpriteFacing, walking: boolean, frame: number) {
    const key = `${sprites ? sprites.cacheKey : "none"}:${facing}:${walking}:${frame}:${world.hat}`;
    if (key === frameKey) return; frameKey = key;
    let rows: readonly string[];
    if (sprites) rows = spriteFrame(sprites, facing, walking, frame).frame.rows;
    else rows = Array.from({ length: 16 }, (_, y) => Array.from({ length: 16 }, (_, x) => Math.hypot(x - 7.5, y - 9) < 5.5 ? "#" : ".").join(""));
    let n = 0, h = 0, top = 16;
    const filled = (x: number, y: number) => y >= 0 && y < 16 && x >= 0 && x < 16 && rows[y][x] === "#";
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      const px = (x - 7.5) * VOXEL, py = (15 - y) * VOXEL + VOXEL / 2;
      if (filled(x, y)) {
        top = Math.min(top, y);
        tmp.position.set(px, py, 0); tmp.scale.set(VOXEL, VOXEL, VOXEL * 2); tmp.updateMatrix(); inkMesh.setMatrixAt(n++, tmp.matrix);
      } else if (filled(x + 1, y) || filled(x - 1, y) || filled(x, y + 1) || filled(x, y - 1)) {
        tmp.position.set(px, py, -VOXEL * 0.2); tmp.scale.set(VOXEL, VOXEL, VOXEL * 1.4); tmp.updateMatrix(); haloMesh.setMatrixAt(h++, tmp.matrix);
      }
    }
    inkMesh.count = n; haloMesh.count = h; inkMesh.instanceMatrix.needsUpdate = true; haloMesh.instanceMatrix.needsUpdate = true;
    if (hat !== world.hat) {
      hat = world.hat; hatGroup.clear();
      if (hat === "cap") { hatGroup.add(cube(MATS.cap, 0.62, 0.22, 0.3, 0, 0.12, 0)); hatGroup.add(cube(MATS.capBrim, 0.7, 0.06, 0.34, 0, 0.0, 0.02)); }
      if (hat === "crown") for (let i = 0; i < 5; i++) hatGroup.add(cube(i % 2 ? MATS.petal : MATS.crown, 0.14, 0.14, 0.2, -0.3 + i * 0.15, 0.07, 0));
    }
    hatGroup.position.set(0, (16 - top) * VOXEL + 0.02, 0);
  }

  /* ── player state & input ── */
  const start = spawnPoint(world, you(world));
  const player = { x: start.x, y: start.y, facing: "down" as SpriteFacing, walking: false, target: null as null | { x: number; y: number } };
  const keys = new Set<string>();
  let paused = false, reducedMotion = false, near: Spot | null = null, raf = 0, last = performance.now(), t = 0;

  const screenDir = { up: [-1, -1], down: [1, 1], left: [-1, 1], right: [1, -1] } as const;
  const onKeyDown = (e: KeyboardEvent) => {
    const k = e.key.toLowerCase();
    if (["w", "a", "s", "d", "arrowup", "arrowdown", "arrowleft", "arrowright"].includes(k)) {
      if (e.target instanceof HTMLElement && e.target.closest(".rf-frame-menu")) return;
      e.preventDefault(); keys.add(k); player.target = null;
    }
  };
  const onKeyUp = (e: KeyboardEvent) => keys.delete(e.key.toLowerCase());
  const stopAll = () => { keys.clear(); player.target = null; player.walking = false; };
  const onVisibility = () => { if (document.hidden) stopAll(); };
  window.addEventListener("keydown", onKeyDown); window.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", stopAll); document.addEventListener("visibilitychange", onVisibility);

  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2(), ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), hit = new THREE.Vector3();
  const onPointer = (e: PointerEvent) => {
    if (paused) return;
    const r = renderer.domElement.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    if (!ray.ray.intersectPlane(ground, hit)) return;
    const spot = nearestSpot(world, hit.x, hit.z);
    const tapped = spot && Math.hypot(spot.x - hit.x, spot.y - hit.z) < 1.2 ? spot : null;
    if (tapped && near === tapped) { opts.onTapSpot(tapped); return; }
    player.target = { x: hit.x, y: hit.z };
  };
  renderer.domElement.addEventListener("pointerdown", onPointer);

  function tryMove(dx: number, dy: number) {
    const ok = (x: number, y: number) => [[-RADIUS, -RADIUS], [RADIUS, -RADIUS], [-RADIUS, RADIUS], [RADIUS, RADIUS]].every(([ox, oy]) => walkable(world, x + ox, y + oy));
    let moved = false;
    if (ok(player.x + dx, player.y)) { player.x += dx; moved = true; }
    if (ok(player.x, player.y + dy)) { player.y += dy; moved = true; }
    return moved;
  }

  function resize() {
    const w = container.clientWidth || 1, h = container.clientHeight || 1;
    renderer.setSize(w, h, false);
    const viewH = w < h ? 19 : 15, aspect = w / h;
    camera.left = -viewH * aspect / 2; camera.right = viewH * aspect / 2; camera.top = viewH / 2; camera.bottom = -viewH / 2;
    camera.updateProjectionMatrix();
  }
  const ro = new ResizeObserver(resize); ro.observe(container); resize();

  const proj = new THREE.Vector3();
  function frame(now: number) {
    const dt = Math.min(0.1, (now - last) / 1000); last = now; t += dt;
    if (!paused) {
      // movement
      let mx = 0, my = 0;
      for (const k of keys) {
        const d = k === "w" || k === "arrowup" ? screenDir.up : k === "s" || k === "arrowdown" ? screenDir.down : k === "a" || k === "arrowleft" ? screenDir.left : screenDir.right;
        mx += d[0]; my += d[1];
      }
      if (!mx && !my && player.target) {
        const dx = player.target.x - player.x, dy = player.target.y - player.y, d = Math.hypot(dx, dy);
        if (d < 0.1) player.target = null; else { mx = dx / d; my = dy / d; }
      }
      const len = Math.hypot(mx, my);
      player.walking = len > 0;
      if (len) {
        mx /= len; my /= len;
        if (!tryMove(mx * SPEED * dt, my * SPEED * dt) && player.target) player.target = null;
        // screen-space facing: screen x ∝ (x - y), screen y ∝ (x + y)
        const sx = mx - my, sy = mx + my;
        player.facing = Math.abs(sx) > Math.abs(sy) ? (sx > 0 ? "right" : "left") : (sy > 0 ? "down" : "up");
      }
      opts.onTick(dt);
      const n = nearestSpot(world, player.x, player.y);
      if (n !== near) { near = n; opts.onNear(n); }
    }
    // friend
    const bob = reducedMotion || !player.walking ? 0 : Math.abs(Math.sin(t * 10)) * 0.06;
    friend.position.set(player.x, bob, player.y);
    drawFriend(player.facing, player.walking, reducedMotion ? 0 : Math.floor(t * (player.walking ? 10 : 5)) % 8);
    if (!reducedMotion) for (const sp of spinners) sp.rotation.z += dt * 1.2;
    // dynamic props
    world.plots.forEach((p, pi) => {
      p.plants.forEach((pl, i) => {
        const g = dyn.plants[pi]?.[i]; if (!g) return;
        const s = [0.25, 0.5, 0.75, 1][pl.stage];
        g.scale.set(s, s, s);
        g.children.slice(2).forEach(c => (c.visible = pl.stage >= 3));
        const need = dyn.needs[pi][i];
        need.visible = pl.water < 25 && pl.stage < 3;
        need.position.y = 1.9 + (reducedMotion ? 0 : Math.sin(t * 3 + i) * 0.1);
      });
      p.animals.forEach((a, i) => {
        const c = dyn.chickens[pi]?.[i]; if (!c) return;
        c.position.set(a.x, reducedMotion ? 0 : Math.abs(Math.sin(t * 6 + i)) * 0.04, a.y);
        c.rotation.y = Math.atan2(a.tx - a.x, a.ty - a.y);
        dyn.hungry[pi][i].visible = a.hunger < 30;
      });
    });
    // camera
    const k = reducedMotion ? 1 : 1 - Math.pow(0.001, dt);
    focus.lerp(new THREE.Vector3(player.x, 0, player.y), k);
    camera.position.copy(focus).add(OFFSET); camera.lookAt(focus);
    water.position.x = focus.x; water.position.z = focus.z;
    renderer.render(scene, camera);
    // labels
    const w = container.clientWidth, h = container.clientHeight;
    for (const l of labelEls) {
      proj.copy(l.pos).project(camera);
      const on = proj.z < 1 && Math.abs(proj.x) < 1.1 && Math.abs(proj.y) < 1.1;
      l.el.style.display = on ? "" : "none";
      if (on) l.el.style.transform = `translate(-50%,-50%) translate(${((proj.x + 1) / 2) * w}px,${((1 - proj.y) / 2) * h}px)`;
    }
    raf = requestAnimationFrame(frame);
  }
  focus.set(player.x, 0, player.y);
  raf = requestAnimationFrame(frame);

  return {
    setSprites(s: GenerationSprites | null) { sprites = s; frameKey = ""; },
    setPaused(p: boolean) { paused = p; if (p) stopAll(); },
    setReducedMotion(r: boolean) { reducedMotion = r; },
    /** Rebuild scenery after docking; move the player with their land. */
    relocate(from: { x: number; y: number }, to: { x: number; y: number }) {
      player.x += to.x - from.x; player.y += to.y - from.y; player.target = null;
      if (!walkable(world, player.x, player.y)) { const s = spawnPoint(world, you(world)); player.x = s.x; player.y = s.y; }
      focus.set(player.x, 0, player.y); buildStatics(); near = null; opts.onNear(null);
    },
    /** Rebuild after the player's land changes (e.g. the on-chain import finished). */
    rebuild(respawn = false) {
      if (respawn || !walkable(world, player.x, player.y)) { const s = spawnPoint(world, you(world)); player.x = s.x; player.y = s.y; focus.set(player.x, 0, player.y); }
      buildStatics(); near = null; opts.onNear(null);
    },
    refreshHat() { frameKey = ""; },
    get near() { return near; },
    get position() { return { x: player.x, y: player.y }; },
    dispose() {
      cancelAnimationFrame(raf); ro.disconnect();
      window.removeEventListener("keydown", onKeyDown); window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", stopAll); document.removeEventListener("visibilitychange", onVisibility);
      renderer.domElement.removeEventListener("pointerdown", onPointer);
      scene.traverse(o => { if (o instanceof THREE.Mesh && o.geometry !== box) o.geometry.dispose(); });
      renderer.dispose(); renderer.domElement.remove(); labels.remove();
    },
  };
}
