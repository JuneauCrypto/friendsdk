/* The Docks — renders every Friend's real on-chain artwork side by side, with the seams
 * between plots, and walks you (and your crew) across them. Only what's near the camera is
 * drawn, and art is requested lazily, so plots of 10,000 Friends stay smooth. */
import { useEffect, useMemo, useRef, useState } from "react";
import { spriteFrame, type GenerationSprites, type SpriteFacing } from "@rarefriends/friendsdk/sprites";
import { fromScreen, toScreen as groundScreen } from "./land.js";
import { CATALOG, population } from "./villages.js";
import * as SK from "./flagskin.js";
import { flowerColors, gardenOdds, hash, landFilter } from "./looks.js";
import { CELL, LEVELS, canEnter, neighboursOf, plotOf, rankOf, stacked, tileAt, untk, villageOf, flagTile, zOf, type Placed, type Plot, type World, type Village } from "./world.js";

/** Screen pixels one level up (upper decks are drawn raised by this much, lower decks sunk). */
export const LEVEL_PX = 110;
/** Screen point of a ground point on level `z`. */
const toScreen = (x: number, y: number, z = 0) => { const s = groundScreen(x, y); return { x: s.x, y: s.y - z * LEVEL_PX }; };
/** World tiles a level's drawing is shifted by (to cull what's on screen). */
const LEVEL_TILES = fromScreen(0, -LEVEL_PX).x;
const plotZ = (p: Plot | null | undefined) => zOf(p?.berth);

/** A Friend walking around off its land: following the lead, or left standing somewhere. */
/** A Friend walking around: following `leader` (in line behind it) or standing where it was left. */
export type CrewMember = { id: bigint; sprites: GenerationSprites | null; mode: "follow" | "park"; leader?: bigint };
export type ViewApi = {
  focusOn: (x: number, y: number, z?: number) => void; position: () => { x: number; y: number; z: number }; teleport: (x: number, y: number, z?: number) => void;
  fitAll: () => void;                            // zoom out to show every island
  recenter: () => void;                          // camera back on the lead
};
export const ZOOM_MIN = 0.06, ZOOM_MAX = 5;
export const clampZoom = (z: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
type Props = {
  world: World; version: number; sprites: GenerationSprites | null;
  walkerId: bigint;                              // the lead: the Friend you control
  offLand: Set<bigint>;                          // Friends away from their land (lead + crew): their land art drops the standing figure
  zoom: number; paused: boolean; reducedMotion: boolean;
  arranging: boolean; selected: Placed[];
  crew: CrewMember[];                            // Friends walking behind you or left somewhere (capped by the caller)
  crewSel: Set<bigint>;                          // crew picked on the map
  onWalkerTap: (id: bigint, at: { x: number; y: number }) => void;   // tapped a walking Friend (client px)
  onFriendTap: (id: bigint, at: { x: number; y: number }) => void;   // tapped one of your Friends at home
  onIslandTap?: (plotId: string | null, at: { x: number; y: number }) => void; // tapped someone else's island (null: anywhere else)
  flagFriendArt?: (v: Village) => string | null;                   // the flag's generated Friend, drawn by its pole
  lookOverride?: number | null;                                    // preview every flag at this level (looks only)
  onBlocked: (plot: Plot) => void; onEnterPlot: (plot: Plot | null) => void;
  onPick: (pl: Placed) => void;                  // arrange mode: tap one of your Friends
  onVisible: (pls: Placed[]) => void;            // Friends near the camera (for lazy art loading)
  onZoom: (z: number) => void;                   // wheel, pinch and +/− keys
  apiRef: React.MutableRefObject<ViewApi | null>;
};

const SPEED = 4;                                  // tiles per second
const screenDir: Record<string, [number, number]> = {
  w: [-1, -1], arrowup: [-1, -1], s: [1, 1], arrowdown: [1, 1], a: [-1, 1], arrowleft: [-1, 1], d: [1, -1], arrowright: [1, -1],
};
const T = (c: number) => c * CELL;                // cells → tiles

/** World tile of a Friend's footprint corner. */
export const worldXY = (w: World, p: Plot, pl: Placed) => { const o = w.origin.get(p) ?? { x: 0, y: 0 }; return { x: o.x + T(pl.x), y: o.y + T(pl.y) }; };
/** Walkable tile nearest to a Friend's centre (world tiles). */
export function spawnOn(w: World, pl: Placed) {
  const p = plotOf(w, pl.m.id); const at = p ? worldXY(w, p, pl) : { x: 0, y: 0 }, z = plotZ(p);
  const f = pl.m.friend, W = T(pl.m.cw), Hh = T(pl.m.ch), cx = W / 2, cy = Hh / 2;
  let best = { x: at.x + cx, y: at.y + cy, z }, bd = Infinity;
  if (!f) return best;
  for (let j = 0; j < f.h; j++) for (let i = 0; i < f.w; i++) {
    if (!f.tiles[j * f.w + i] || f.blocked[j * f.w + i]) continue;
    const d = Math.hypot(i + 0.5 - cx, j + 0.5 - cy);
    if (d < bd) { bd = d; best = { x: at.x + i + 0.5, y: at.y + j + 0.5, z }; }
  }
  return best;
}

/** A little garden bed (2 × 2 tiles, in screen px around its centre) with flowers, and a
 *  gardener at work beside it. */
function Garden({ colors, seed, gardener, motion }: { colors: string[]; seed: number; gardener: boolean; motion: boolean }) {
  const c = groundScreen(0, 0), P = (x: number, y: number) => { const s = groundScreen(x, y); return `${(s.x - c.x).toFixed(1)} ${(s.y - c.y).toFixed(1)}`; };
  const bed = `M${P(-1, -1)}L${P(1, -1)}L${P(1, 1)}L${P(-1, 1)}Z`;
  const dots: { x: number; y: number; c: string }[] = [];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) { const s = groundScreen(-0.6 + i * 0.6, -0.6 + j * 0.6); dots.push({ x: s.x - c.x, y: s.y - c.y - 1.2, c: colors[(seed >> (i * 3 + j)) % colors.length] }); }
  return <svg className="docks-garden-art" viewBox="-24 -12 48 24" width={48} height={24} aria-hidden="true">
    <path d={bed} className="bed" />
    {dots.map((d, k) => <g key={k}><rect x={d.x - 0.5} y={d.y} width={1} height={1.6} className="stem" /><rect x={d.x - 1.1} y={d.y - 1.4} width={2.2} height={1.8} fill={d.c} /></g>)}
    {gardener && <g className={`gardener${motion ? " moving" : ""}`} transform={`translate(${seed % 2 ? 13 : -15} -6)`}>
      <rect x={-1.5} y={-7} width={3} height={1.2} fill={colors[0]} /><rect x={-1} y={-5.8} width={2} height={2} className="skin" />
      <rect x={-1.5} y={-3.8} width={3} height={4} className="body" /><rect x={-1.5} y={0.2} width={1} height={2} className="body" /><rect x={0.5} y={0.2} width={1} height={2} className="body" />
      <g className="hoe"><rect x={1.5} y={-5} width={0.7} height={7} className="handle" /><rect x={0.2} y={1.6} width={2.4} height={0.8} className="handle" /></g></g>}
  </svg>;
}

const diamond = (x0: number, y0: number, x1: number, y1: number, z = 0) => {
  const a = toScreen(x0, y0, z), b = toScreen(x1, y0, z), c = toScreen(x1, y1, z), d = toScreen(x0, y1, z);
  return `M${a.x.toFixed(1)} ${a.y.toFixed(1)}L${b.x.toFixed(1)} ${b.y.toFixed(1)}L${c.x.toFixed(1)} ${c.y.toFixed(1)}L${d.x.toFixed(1)} ${d.y.toFixed(1)}Z`;
};

type Follower = { x: number; y: number; z: number; facing: SpriteFacing; walking: boolean };
function drawSprite(cv: HTMLCanvasElement, s: GenerationSprites | null, facing: SpriteFacing, walking: boolean, frame: number) {
  const ctx = cv.getContext("2d")!; ctx.clearRect(0, 0, cv.width, cv.height);
  const rows = s ? spriteFrame(s, facing, walking, frame).frame.rows
    : Array.from({ length: 16 }, (_, y) => Array.from({ length: 16 }, (_, x) => Math.hypot(x - 7.5, y - 9) < 5 ? "#" : ".").join(""));
  const S = 2;
  ctx.fillStyle = "#fff";
  rows.forEach((row, y) => [...row].forEach((c, x) => { if (c === "#") ctx.fillRect(x * S, y * S, S * 3, S * 3); }));
  ctx.fillStyle = "#000";
  rows.forEach((row, y) => [...row].forEach((c, x) => { if (c === "#") ctx.fillRect((x + 1) * S, (y + 1) * S, S, S); }));
}

export function DocksView(props: Props) {
  const { world, version, walkerId, arranging, selected, crew, crewSel, offLand, apiRef } = props;
  const viewport = useRef<HTMLDivElement>(null), layer = useRef<HTMLDivElement>(null), avatar = useRef<HTMLCanvasElement>(null), youTag = useRef<HTMLSpanElement>(null);
  const crewCanvases = useRef(new Map<string, HTMLCanvasElement>());
  const crewMarks = useRef(new Map<string, HTMLSpanElement>());
  const followers = useRef(new Map<string, Follower>());
  const trail = useRef<{ x: number; y: number; z: number }[]>([]);
  const visRef = useRef<{ plot: Plot; pl: Placed; x: number; y: number }[]>([]);
  const player = useRef({ x: 0, y: 0, z: 0, facing: "down" as SpriteFacing, walking: false, target: null as null | { x: number; y: number } });
  const focus = useRef<{ x: number; y: number; z?: number } | null>(null);
  const [pz, setPz] = useState(0);                                   // the lead's level (other levels are drawn faded)
  const keys = useRef(new Set<string>());
  const [vis, setVis] = useState({ x0: -160, y0: -160, x1: 160, y1: 160 });  // visible box, world tiles
  const state = useRef({ ...props, lastPlot: null as Plot | null, lastBlock: 0, visKey: "" });
  state.current = { ...state.current, ...props };

  // the lead: start on its land; when you take over another Friend, swap places with it
  const prevLead = useRef<bigint | null>(null);
  useEffect(() => {
    const pc = player.current, old = prevLead.current;
    const f = followers.current.get(String(walkerId));
    if (old !== null && old !== walkerId) followers.current.set(String(old), { x: pc.x, y: pc.y, z: pc.z, facing: pc.facing, walking: false });
    if (f) { pc.x = f.x; pc.y = f.y; pc.z = f.z; followers.current.delete(String(walkerId)); }
    else { const p = plotOf(world, walkerId), pl = p?.friends.find(x => x.m.id === walkerId); if (pl) { const s = spawnOn(world, pl); pc.x = s.x; pc.y = s.y; pc.z = s.z; } }
    setPz(pc.z);
    pc.target = null; trail.current = []; focus.current = null; prevLead.current = walkerId;
  }, [walkerId]); // eslint-disable-line react-hooks/exhaustive-deps

  const camTarget = useRef({ x: 0, y: 0 });
  apiRef.current = {
    focusOn: (x, y, z) => { focus.current = { x, y, z }; },
    recenter: () => { focus.current = null; },
    fitAll: () => {
      const vp = viewport.current; if (!vp) return;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const [p, b] of state.current.world.box) for (const [x, y] of [[b.x0, b.y0], [b.x1, b.y0], [b.x0, b.y1], [b.x1, b.y1]]) {
        const sc = toScreen(x, y, plotZ(p)); x0 = Math.min(x0, sc.x); x1 = Math.max(x1, sc.x); y0 = Math.min(y0, sc.y); y1 = Math.max(y1, sc.y);
      }
      if (!Number.isFinite(x0)) return;
      const z = clampZoom(Math.min(vp.clientWidth / (x1 - x0 + 60), vp.clientHeight * 0.7 / (y1 - y0 + 80)));
      focus.current = fromScreen((x0 + x1) / 2, (y0 + y1) / 2);
      state.current.onZoom(z);
    },
    position: () => ({ x: player.current.x, y: player.current.y, z: player.current.z }),
    teleport: (x, y, z = 0) => {
      player.current.x = x; player.current.y = y; player.current.z = z; player.current.target = null; focus.current = null; trail.current = []; setPz(z);
      const follow = new Set(state.current.crew.filter(m => m.mode === "follow").map(m => String(m.id)));
      for (const [k, f] of followers.current) if (follow.has(k)) { f.x = x; f.y = y; f.z = z; }
    },
  };

  // input
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLElement && e.target.closest("input,select,.rf-frame-menu")) return;
      const k = e.key.toLowerCase();
      if (k === "+" || k === "=") { state.current.onZoom(clampZoom(state.current.zoom * 1.25)); return; }
      if (k === "-" || k === "_") { state.current.onZoom(clampZoom(state.current.zoom / 1.25)); return; }
      if (screenDir[k] && !state.current.arranging) { e.preventDefault(); keys.current.add(k); player.current.target = null; focus.current = null; }
    };
    const up = (e: KeyboardEvent) => keys.current.delete(e.key.toLowerCase());
    const stop = () => { keys.current.clear(); player.current.target = null; };
    window.addEventListener("keydown", down); window.addEventListener("keyup", up); window.addEventListener("blur", stop);
    document.addEventListener("visibilitychange", stop);
    return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); window.removeEventListener("blur", stop); document.removeEventListener("visibilitychange", stop); };
  }, []);

  // gestures: tap (walk / pick), drag (pan), pinch (zoom); mouse wheel zooms
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ x: number; y: number; moved: boolean; cam: { x: number; y: number }; pinch?: number; zoom?: number } | null>(null);
  useEffect(() => {
    const vp = viewport.current; if (!vp) return;
    const wheel = (e: WheelEvent) => { e.preventDefault(); if (state.current.paused) return; state.current.onZoom(clampZoom(state.current.zoom * Math.exp(-e.deltaY * 0.0015))); };
    vp.addEventListener("wheel", wheel, { passive: false });
    return () => vp.removeEventListener("wheel", wheel);
  }, []);
  const onDown = (e: React.PointerEvent) => {
    if (state.current.paused) return;
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const pts = [...pointers.current.values()];
    if (pts.length === 1) gesture.current = { x: e.clientX, y: e.clientY, moved: false, cam: { ...camTarget.current } };
    else if (pts.length === 2 && gesture.current) {
      gesture.current.moved = true; gesture.current.pinch = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y); gesture.current.zoom = state.current.zoom;
    }
  };
  const onMove = (e: React.PointerEvent) => {
    const g = gesture.current; if (!g || !pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const pts = [...pointers.current.values()];
    if (pts.length >= 2 && g.pinch) {
      const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      state.current.onZoom(clampZoom((g.zoom ?? 1) * d / g.pinch)); return;
    }
    const dx = e.clientX - g.x, dy = e.clientY - g.y;
    if (!g.moved && Math.hypot(dx, dy) > 8) g.moved = true;
    if (g.moved) {                                   // drag pans the camera
      const c = toScreen(g.cam.x, g.cam.y), z = state.current.zoom;
      focus.current = fromScreen(c.x - dx / z, c.y - dy / z);
    }
  };
  const onUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    const g = gesture.current;
    if (pointers.current.size === 0) { gesture.current = null; if (g && !g.moved) onTap(e); }
  };

  const onTap = (e: React.PointerEvent) => {
    const st = state.current;
    if (st.paused || !viewport.current || !layer.current) return;
    const r = viewport.current.getBoundingClientRect(), m = new DOMMatrixReadOnly(getComputedStyle(layer.current).transform);
    const z = player.current.z, onLevel = (lv: number) => fromScreen((e.clientX - r.left - m.e) / m.a, (e.clientY - r.top - m.f) / m.d + lv * LEVEL_PX);
    const at = onLevel(z);
    if (st.arranging) {
      const o = tileAt(st.world, at.x, at.y, z);
      if (o?.plot?.mine && o.placed) st.onPick(o.placed);
      return;
    }
    // tapping one of your walking Friends picks it (to lead it, leave it or bring it along)
    const sx = (e.clientX - r.left - m.e) / m.a, sy = (e.clientY - r.top - m.f) / m.d;
    let hit: bigint | null = null, best = 12;
    for (const c of st.crew) {
      const f = followers.current.get(String(c.id)); if (!f) continue;
      const s = toScreen(f.x, f.y, f.z), d = Math.hypot(s.x - sx, s.y - 10 - sy);
      if (d < best) { best = d; hit = c.id; }
    }
    if (hit !== null) { st.onWalkerTap(hit, { x: e.clientX, y: e.clientY }); return; }
    // tapping one of your Friends standing on its own land opens its options (control it, call it…)
    let home: bigint | null = null, hb = 20;
    for (const v of visRef.current) {
      const f = v.pl.m.friend; if (!v.plot.mine || !f || st.offLand.has(v.pl.m.id) || v.pl.m.id === st.walkerId) continue;
      const o = toScreen(v.x, v.y, plotZ(v.plot)), fx = o.x - f.anchor.x + f.figure.x, fy = o.y - f.anchor.y + f.figure.y;
      const d = Math.hypot(fx - sx, fy - sy); if (d < hb) { hb = d; home = v.pl.m.id; }
    }
    if (home !== null) { st.onFriendTap(home, { x: e.clientX, y: e.clientY }); return; }
    // someone else's island: its options (dock next to it, bridge, chat); you still walk there if you can
    // (the top-most island under the finger, on any level)
    let o = null as ReturnType<typeof tileAt> | null;
    for (let lv = LEVELS.MAX; lv >= LEVELS.MIN && !o?.plot; lv--) { const q = onLevel(lv); o = tileAt(st.world, q.x, q.y, lv) ?? null; }
    st.onIslandTap?.(o?.plot && !o.plot.mine ? o.plot.id : null, { x: e.clientX, y: e.clientY });
    player.current.target = at; focus.current = null;
  };

  // walk / crew / camera loop
  useEffect(() => {
    let raf = 0, last = performance.now(), t = 0, frameKey = "";
    const walkable = (x: number, y: number) => {
      const o = tileAt(state.current.world, x, y, player.current.z);
      if (!o || o.blocked) return { ok: false as const };
      if (o.plot && !canEnter(state.current.world, o.plot)) return { ok: false as const, gate: o.plot };
      return { ok: true as const };
    };
    const R = 0.25;
    const tryMove = (dx: number, dy: number) => {
      const p = player.current;
      const test = (x: number, y: number) => {
        for (const [ox, oy] of [[-R, -R], [R, -R], [-R, R], [R, R]]) { const r = walkable(x + ox, y + oy); if (!r.ok) return r; }
        return { ok: true as const };
      };
      let moved = false;
      const a = test(p.x + dx, p.y), b = a.ok ? null : a;
      if (a.ok) { p.x += dx; moved = true; }
      const c = test(p.x, p.y + dy);
      if (c.ok) { p.y += dy; moved = true; }
      const gate = (b && "gate" in b && b.gate) || (!c.ok && "gate" in c && c.gate) || null;
      if (gate && performance.now() - state.current.lastBlock > 1200) { state.current.lastBlock = performance.now(); state.current.onBlocked(gate); }
      return moved;
    };
    const stepCrew = (dt: number) => {
      const p = player.current, tr = trail.current, lastPt = tr[tr.length - 1];
      if (!lastPt || lastPt.z !== p.z || Math.hypot(lastPt.x - p.x, lastPt.y - p.y) > 0.3) { tr.push({ x: p.x, y: p.y, z: p.z }); if (tr.length > 400) tr.shift(); }
      let n = 0; const queue = new Map<string, number>();
      state.current.crew.forEach(m => {
        const key = String(m.id);
        let f = followers.current.get(key);
        if (!f) {                                     // called away from its land: set off from there
          const home = plotOf(state.current.world, m.id)?.friends.find(x => x.m.id === m.id);
          const s = home ? spawnOn(state.current.world, home) : { x: p.x, y: p.y, z: p.z };
          f = { x: s.x, y: s.y, z: s.z, facing: "down", walking: false }; followers.current.set(key, f);
        }
        if (m.mode === "park") { f.walking = false; return; }
        let goal: { x: number; y: number; z?: number };
        if (m.leader === undefined || m.leader === state.current.walkerId) { n++; goal = tr[Math.max(0, tr.length - 1 - n * 4)] ?? p; }
        else {                                        // in line behind a leader you're not steering: queue up behind it
          const L = followers.current.get(String(m.leader)); if (!L) { f.walking = false; return; }
          const k = (queue.get(String(m.leader)) ?? 0) + 1; queue.set(String(m.leader), k);
          goal = { x: L.x - 0.6 * k, y: L.y - 0.6 * k, z: L.z };
        }
        if (goal.z !== undefined && goal.z !== f.z) { f.z = goal.z; f.x = goal.x; f.y = goal.y; }   // took the stairs
        const dx = goal.x - f.x, dy = goal.y - f.y, d = Math.hypot(dx, dy);
        f.walking = d > 0.15;
        if (f.walking) {
          const step = Math.min(d, SPEED * 1.15 * dt * (d > 3 ? 2 : 1));
          f.x += dx / d * step; f.y += dy / d * step;
          const sx = dx - dy, sy = dx + dy;
          f.facing = Math.abs(sx) > Math.abs(sy) ? (sx > 0 ? "right" : "left") : (sy > 0 ? "down" : "up");
        }
      });
    };
    const draw = () => {
      const st = state.current, p = player.current, cv = avatar.current; if (!cv) return;
      const frame = st.reducedMotion ? 0 : Math.floor(t * (p.walking ? 10 : 5)) % 8;
      const k = `${st.sprites?.cacheKey}:${p.facing}:${p.walking}:${frame}`;
      if (k !== frameKey) { frameKey = k; drawSprite(cv, st.sprites, p.facing, p.walking, frame); }
      for (const m of st.crew) {
        const f = followers.current.get(String(m.id)), c = crewCanvases.current.get(String(m.id)); if (!f || !c) continue;
        const ff = st.reducedMotion ? 0 : Math.floor(t * (f.walking ? 10 : 5) + Number(m.id % 7n)) % 8;
        const kk = `${m.sprites?.cacheKey}:${f.facing}:${f.walking}:${ff}`;
        if (c.dataset.k !== kk) { c.dataset.k = kk; drawSprite(c, m.sprites, f.facing, f.walking, ff); }
        const sc = toScreen(f.x, f.y, f.z); c.style.left = `${(sc.x - 13.5).toFixed(2)}px`; c.style.top = `${(sc.y - 25.5).toFixed(2)}px`;
        const mk = crewMarks.current.get(String(m.id)); if (mk) { mk.style.left = `${sc.x.toFixed(2)}px`; mk.style.top = `${(sc.y - 26).toFixed(2)}px`; }
      }
    };
    const tick = (now: number) => {
      const dt = Math.max(0, Math.min(0.1, (now - last) / 1000)); last = Math.max(last, now); t += dt;
      const st = state.current, p = player.current;
      if (!st.paused && !st.arranging) {
        let mx = 0, my = 0;
        for (const k of keys.current) { const d = screenDir[k]; if (d) { mx += d[0]; my += d[1]; } }
        if (!mx && !my && p.target) { const dx = p.target.x - p.x, dy = p.target.y - p.y, d = Math.hypot(dx, dy); if (d < 0.08) p.target = null; else { mx = dx / d; my = dy / d; } }
        const len = Math.hypot(mx, my); p.walking = len > 0;
        if (len) {
          mx /= len; my /= len;
          const on = tileAt(st.world, p.x, p.y, p.z), fast = on && !on.plot ? 2.5 : 1;   // boardwalks and bridges: quick steps
          if (!tryMove(mx * SPEED * fast * dt, my * SPEED * fast * dt)) p.target = null;
          const now = tileAt(st.world, p.x, p.y, p.z);
          if (now?.lift) {                                // took the stairs: land on the nearest open ground up (or down) there
            const L = now.lift, ok = (x: number, y: number) => { const o = tileAt(st.world, x, y, L.to); return o && !o.blocked && !o.lift; };
            let at = { x: L.x, y: L.y };
            search: for (let r = 0; r <= 8; r++) for (let i = -r; i <= r; i++) for (const [dx, dy] of [[i, -r], [i, r], [-r, i], [r, i]]) if (ok(L.x + dx, L.y + dy)) { at = { x: L.x + dx, y: L.y + dy }; break search; }
            p.z = L.to; p.x = at.x; p.y = at.y; p.target = null; setPz(p.z);
          }
          const sx = mx - my, sy = mx + my;
          p.facing = Math.abs(sx) > Math.abs(sy) ? (sx > 0 ? "right" : "left") : (sy > 0 ? "down" : "up");
        }
        stepCrew(dt);
        for (const k of followers.current.keys()) if (!st.crew.some(c => String(c.id) === k)) followers.current.delete(k);   // sent home
        const under = tileAt(st.world, p.x, p.y, p.z);
        if (!under) {                                   // islands re-laid out under us: step back onto my Friend
          const home = plotOf(st.world, st.walkerId)?.friends.find(x => x.m.id === st.walkerId);
          if (home) { const sp = spawnOn(st.world, home); p.x = sp.x; p.y = sp.y; p.target = null; if (p.z !== sp.z) { p.z = sp.z; setPz(p.z); } }
        }
        const here = tileAt(st.world, p.x, p.y, p.z)?.plot ?? null;
        if (here !== st.lastPlot) { st.lastPlot = here; st.onEnterPlot(here); }
      } else p.walking = false;
      // camera
      const vp = viewport.current, ly = layer.current;
      if (vp && ly) {
        const sel = st.selected[0] ?? null, sp = sel ? plotOf(st.world, sel.m.id) : null, sw = sel && sp ? worldXY(st.world, sp, sel) : null;
        const target: { x: number; y: number; z?: number } = focus.current ?? (st.arranging && sel && sw ? { x: sw.x + T(sel.m.cw) / 2, y: sw.y + T(sel.m.ch) / 2, z: plotZ(sp) } : p);
        const tz = target.z ?? 0, lift = fromScreen(0, -tz * LEVEL_PX);
        camTarget.current = { x: target.x + lift.x, y: target.y + lift.y };      // (ground point drawn where the target is)
        const sc = toScreen(target.x, target.y, tz), z = st.zoom;
        const ox = vp.clientWidth / 2 - sc.x * z, oy = vp.clientHeight * (vp.clientHeight > vp.clientWidth ? 0.38 : 0.55) - sc.y * z;
        ly.style.transform = `translate(${ox.toFixed(1)}px, ${oy.toFixed(1)}px) scale(${z})`;
        // visible box in cells (from the four viewport corners), padded and quantised
        const corners = [[0, 0], [vp.clientWidth, 0], [0, vp.clientHeight], [vp.clientWidth, vp.clientHeight]].map(([x, y]) => fromScreen((x - ox) / z, (y - oy) / z));
        const q = (v: number, up: boolean) => (up ? Math.ceil : Math.floor)(v / 24) * 24;
        const box = { x0: q(Math.min(...corners.map(c => c.x)), false) - 48, y0: q(Math.min(...corners.map(c => c.y)), false) - 48,
          x1: q(Math.max(...corners.map(c => c.x)), true) + 24, y1: q(Math.max(...corners.map(c => c.y)), true) + 24 };
        const key = `${box.x0},${box.y0},${box.x1},${box.y1}`;
        if (key !== st.visKey) { st.visKey = key; setVis(box); }
      }
      const a = avatar.current;
      const yt = youTag.current;
      if (yt) { const s = toScreen(p.x, p.y, p.z); yt.style.left = `${s.x.toFixed(2)}px`; yt.style.top = `${(s.y - 27).toFixed(2)}px`; yt.style.transform = `translate(-50%, -100%) scale(${Math.max(1, 0.85 / st.zoom).toFixed(3)})`; }
      if (a) { const s = toScreen(p.x, p.y, p.z); a.style.left = `${(s.x - 13.5).toFixed(2)}px`; a.style.top = `${(s.y - 25.5 - (p.walking && !st.reducedMotion ? Math.abs(Math.sin(t * 12)) * 1.2 : 0)).toFixed(2)}px`; }
      draw();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  // what's near the camera (world tiles)
  type Vis = { plot: Plot; pl: Placed; x: number; y: number; z: number };
  const visible = useMemo(() => {
    const out: Vis[] = [];
    for (const plot of world.plots) {
      const b = world.box.get(plot), o = world.origin.get(plot), z = plotZ(plot), sh = LEVEL_TILES * z;   // raised levels show further up
      if (!b || !o || b.x1 + sh < vis.x0 || b.x0 + sh > vis.x1 || b.y1 + sh < vis.y0 || b.y0 + sh > vis.y1) continue;
      for (const pl of plot.friends) {
        const x = o.x + T(pl.x), y = o.y + T(pl.y);
        if (x + T(pl.m.cw) + sh >= vis.x0 && x + sh <= vis.x1 && y + T(pl.m.ch) + sh >= vis.y0 && y + sh <= vis.y1) out.push({ plot, pl, x, y, z });
      }
    }
    return out.sort((a, b) => a.z - b.z || (a.x + a.y + T(a.pl.m.cw + a.pl.m.ch) / 2) - (b.x + b.y + T(b.pl.m.cw + b.pl.m.ch) / 2));
  }, [world, version, vis]); // eslint-disable-line react-hooks/exhaustive-deps
  // looks: an island in no flag stays black and white; a flag's islands take its colour by level
  const looks = useMemo(() => {
    const m = new Map<Plot, { level: number; color: string }>();
    for (const v of world.villages) { if (v.failed) continue;
      const lv = props.lookOverride ?? (v.founded ? SK.tierOfFlag(v) : 0);
      for (const p of v.founded ? v.members : [v.seat]) m.set(p, { level: lv, color: v.color }); }
    return m;
  }, [world, version, props.lookOverride]); // eslint-disable-line react-hooks/exhaustive-deps
  // Zoomed far out: draw the islands' outlines only and don't fetch art for thousands of lands.
  const simple = visible.length > 600 || props.zoom < 0.2;
  visRef.current = simple ? [] : visible;
  useEffect(() => { if (!simple) props.onVisible(visible.map(v => v.pl)); }, [visible, simple]); // eslint-disable-line react-hooks/exhaustive-deps

  const boards = useMemo(() => visible.map(v => diamond(v.x, v.y, v.x + T(v.pl.m.cw), v.y + T(v.pl.m.ch), v.z)).join(""), [visible]);
  const holes = useMemo(() => {
    const out: { key: string; d: string; x: number; y: number; id: bigint }[] = [];
    for (const plot of world.plots) {
      const o = world.origin.get(plot), z = plotZ(plot); if (!o) continue;
      for (const h of plot.holes ?? []) {
        const x = o.x + T(h.x), y = o.y + T(h.y);
        if (x + T(h.cw) < vis.x0 || x > vis.x1 || y + T(h.ch) < vis.y0 || y > vis.y1) continue;
        const c = toScreen(x + T(h.cw) / 2, y + T(h.ch) / 2, z);
        out.push({ key: `${plot.id}-${h.id}`, d: diamond(x, y, x + T(h.cw), y + T(h.ch), z), x: c.x, y: c.y, id: h.id });
      }
    }
    return out;
  }, [world, version, vis]); // eslint-disable-line react-hooks/exhaustive-deps
  const walkways = useMemo(() => {
    const g: string[] = [], br: string[] = [];
    for (const [k, kind] of world.walk) {
      const { x, y, z } = untk(k), sh = LEVEL_TILES * z;
      if (x + sh < vis.x0 || x + sh > vis.x1 || y + sh < vis.y0 || y + sh > vis.y1) continue;
      if (tileAt(world, x + 0.5, y + 0.5, z)?.plot) continue;         // island ground takes precedence
      (kind === "bridge" ? br : g).push(diamond(x, y, x + 1, y + 1, z));
    }
    for (const r of world.decks) {                                  // boardwalk rectangles
      const sh = LEVEL_TILES * r.z; if (r.x1 + sh < vis.x0 || r.x0 + sh > vis.x1 || r.y1 + sh < vis.y0 || r.y0 + sh > vis.y1) continue;
      g.push(diamond(r.x0, r.y0, r.x1, r.y1, r.z));
    }
    return { gangway: g.join(""), bridge: br.join("") };
  }, [world, version, vis]); // eslint-disable-line react-hooks/exhaustive-deps
  const gates = useMemo(() => {
    const out: { x: number; y: number; open: boolean; key: string }[] = [], seen = new Set<string>();
    for (const p of world.plots) {
      if (!p.berth) continue;
      for (const q of neighboursOf(world, p)) {
        const key = [p.id, q.id].sort().join("|"); if (seen.has(key)) continue; seen.add(key);
        if (stacked(p, q)) continue;                                   // levels are joined by stairs instead
        const a = world.box.get(p)!, b = world.box.get(q)!;
        const c = toScreen(((a.x0 + a.x1) / 2 + (b.x0 + b.x1) / 2) / 2, ((a.y0 + a.y1) / 2 + (b.y0 + b.y1) / 2) / 2, plotZ(p));
        out.push({ x: c.x, y: c.y, open: canEnter(world, p) && canEnter(world, q), key });
      }
    }
    return out;
  }, [world, version]); // eslint-disable-line react-hooks/exhaustive-deps
  const labels = useMemo(() => world.plots.filter(p => p.friends.length && world.box.get(p)).map(p => {
    const b = world.box.get(p)!, z = plotZ(p), c = toScreen(b.x0, b.y0, z);
    return { plot: p, x: c.x, y: c.y - 20, z, rank: rankOf(p).rank, village: villageOf(world, p) };
  }), [world, version]); // eslint-disable-line react-hooks/exhaustive-deps
  const builds = world.items.flatMap(it => { const o = it.plot && world.origin.get(it.plot); if (!o) return [];
    const c = toScreen(o.x + (it.cx + 0.5) * CELL, o.y + (it.cy + 0.5) * CELL, plotZ(it.plot)), k = CATALOG[it.kind];
    return [{ id: it.id, x: c.x, y: c.y, icon: k.icon, name: k.name, ready: Date.now() >= it.readyAt }]; });
  const flags = useMemo(() => world.villages.filter(v => !v.failed).flatMap(v => { const t = flagTile(world, v); if (!t) return [];
    const c = toScreen(t.x + 0.5, t.y + 0.5, plotZ(v.seat)); return [{ v, x: c.x, y: c.y }]; }), [world, version]); // eslint-disable-line react-hooks/exhaustive-deps
  // flags as cities: walls around every founded flag's islands, taller with its population
  // level (its skin), and a banner you can read from far out
  const cities = useMemo(() => world.villages.filter(v => !v.failed).flatMap(v => {
    const isles = (v.founded ? v.members : [v.seat]).filter(p => world.box.get(p));
    if (!isles.length) return [];
    const z = Math.min(...isles.map(plotZ)), ground = isles.filter(p => plotZ(p) === z);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of ground) { const b = world.box.get(p)!; x0 = Math.min(x0, b.x0); y0 = Math.min(y0, b.y0); x1 = Math.max(x1, b.x1); y1 = Math.max(y1, b.y1); }
    const tier = props.lookOverride ?? SK.tierOfFlag(v), m = 3 + Math.min(5, tier); x0 -= m; y0 -= m; x1 += m; y1 += m;
    const P = (x: number, y: number) => toScreen(x, y, z), top = P(x0, y0), right = P(x1, y0), bottom = P(x1, y1), left = P(x0, y1);
    const h = [0, 6, 10, 16, 22, 26][Math.min(5, tier)];
    type Pt = { x: number; y: number };
    const f = (n: number) => n.toFixed(1);
    const face = (a: Pt, b: Pt) => `M${f(a.x)} ${f(a.y)}L${f(b.x)} ${f(b.y)}L${f(b.x)} ${f(b.y - h)}L${f(a.x)} ${f(a.y - h)}Z`;
    // the top of a wall: pointed stakes (palisade) or square merlons (stone), every `step` px
    const crest = (a: Pt, b: Pt, kind: "stakes" | "merlons") => {
      const len = Math.hypot(b.x - a.x, b.y - a.y), step = kind === "stakes" ? 3 : 5, n = Math.max(1, Math.floor(len / step)), out: string[] = [];
      for (let i = 0; i < n; i++) {
        const t0 = i / n, t1 = (i + (kind === "stakes" ? 1 : 0.55)) / n, p0 = { x: a.x + (b.x - a.x) * t0, y: a.y + (b.y - a.y) * t0 - h }, p1 = { x: a.x + (b.x - a.x) * t1, y: a.y + (b.y - a.y) * t1 - h };
        out.push(kind === "stakes" ? `M${f(p0.x)} ${f(p0.y)}L${f((p0.x + p1.x) / 2)} ${f((p0.y + p1.y) / 2 - 2.2)}L${f(p1.x)} ${f(p1.y)}Z` : `M${f(p0.x)} ${f(p0.y)}L${f(p1.x)} ${f(p1.y)}L${f(p1.x)} ${f(p1.y - 2.5)}L${f(p0.x)} ${f(p0.y - 2.5)}Z`);
      }
      return out.join("");
    };
    const kind = tier >= 2 ? "merlons" as const : "stakes" as const;
    const pop = population(v), next = SK.nextMilestone(pop), cx = (left.x + right.x) / 2, cy = (top.y + bottom.y) / 2, rx = (right.x - left.x) / 2;
    return [{ v, tier, h, z, pop, next, ground: diamond(x0, y0, x1, y1, z),
      back: tier ? face(left, top) + face(top, right) : "", front: tier ? face(left, bottom) + face(bottom, right) : "",
      backCrest: tier && tier < 4 ? crest(left, top, kind) + crest(top, right, kind) : "", frontCrest: tier && tier < 4 ? crest(left, bottom, kind) + crest(bottom, right, kind) : "",
      dome: tier >= 4 ? `M${f(left.x)} ${f(cy)}A${f(rx)} ${f(rx * 0.62)} 0 0 1 ${f(right.x)} ${f(cy)}` : "",
      corners: [top, right, bottom, left], banner: toScreen((x0 + x1) / 2, y0 + 2, z), cx, cy }];
  }), [world, version, props.lookOverride]); // eslint-disable-line react-hooks/exhaustive-deps
  const bannerScale = Math.max(1, 1.3 / props.zoom);             // about the same size on screen at any zoom
  // stairs between levels
  const stairs = useMemo(() => {
    const seen = new Map<string, { x: number; y: number; n: number; up: boolean; z: number }>();
    for (const [k, l] of world.lifts) {
      const { x, y, z } = untk(k), key = `${z}|${l.to}|${l.x}|${l.y}`, s = seen.get(key);
      if (s) { s.x += x + 0.5; s.y += y + 0.5; s.n++; } else seen.set(key, { x: x + 0.5, y: y + 0.5, n: 1, up: l.to > z, z });
    }
    return [...seen.entries()].map(([key, s]) => { const c = toScreen(s.x / s.n, s.y / s.n, s.z); return { key, x: c.x, y: c.y, up: s.up, z: s.z }; });
  }, [world, version]); // eslint-disable-line react-hooks/exhaustive-deps
  const selSet = new Set(selected);
  const selPlot = selected[0] ? plotOf(world, selected[0].m.id) : null;
  const myVisible = arranging ? visible.filter(v => v.plot === selPlot) : [];

  return <div className="docks-viewport" ref={viewport} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} aria-hidden="true">
    <div className="docks-layer" ref={layer}>
      <svg className="docks-seams" width="1" height="1" style={{ zIndex: 4 }}>
        {cities.map(c => <g key={c.v.id} className={`docks-city t${Math.min(5, c.tier)}${c.z !== pz ? " other-level" : ""}`} style={{ ["--flag" as string]: c.v.color }}>
          <path d={c.ground} className="yard" /><path d={c.back} className="wall back" /><path d={c.backCrest} className="crest" />
          {c.dome && <path d={c.dome} className="dome" />}</g>)}
      </svg>
      <svg className="docks-seams" width="1" height="1" style={{ zIndex: 5 }}>
        <path d={walkways.gangway} className="gangway" /><path d={walkways.bridge} className="bridge" /><path d={boards} className="pier" />
        {holes.map(h => <path key={h.key} d={h.d} className="hole" />)}</svg>
      {holes.map(h => <span key={h.key} className="docks-hole-tag" style={{ left: h.x, top: h.y, zIndex: 9 }}>hole · #{String(h.id)}</span>)}
      {!simple && visible.map(({ plot, pl, x, y, z }, i) => {
        const f = pl.m.friend, o = toScreen(x, y, z);
        if (!f) { const c = toScreen(x + T(pl.m.cw) / 2, y + T(pl.m.ch) / 2, z);
          return <span key={`${plot.id}-${pl.m.id}`} className="docks-pending" style={{ left: c.x, top: c.y, zIndex: 10 + i }}>#{String(pl.m.id)}</span>; }
        const src = plot.mine && (pl.m.id === walkerId || offLand.has(pl.m.id)) ? f.artWithoutPortrait : f.art;
        const lk = looks.get(plot), level = lk?.level ?? -1, color = lk?.color ?? "#ffffff", seed = hash(`${plot.id}|${pl.m.id}`);
        const garden = pl.m.gen <= 5 && (seed % 1000) / 1000 < gardenOdds(level) ? toScreen(x + T(pl.m.cw) - 2.5, y + T(pl.m.ch) - 2.5, z) : null;
        return <span key={`${plot.id}-${pl.m.id}`} className="docks-landwrap">
          <img className={`docks-land ${plot.berth ? "" : "adrift"}${z !== pz ? " other-level" : ""}`} src={src} alt="" draggable={false}
            style={{ left: o.x - f.anchor.x, top: o.y - f.anchor.y, zIndex: 10 + i, filter: landFilter(level, color) }} />
          {garden && <span className={`docks-garden${z !== pz ? " other-level" : ""}`} style={{ left: garden.x, top: garden.y, zIndex: 10 + i }}>
            <Garden colors={flowerColors(level, color)} seed={seed} gardener={(seed >> 10) % 3 !== 0} motion={!props.reducedMotion} /></span>}
        </span>;
      })}
      <svg className="docks-seams" width="1" height="1" style={{ zIndex: 500 }}>
        {myVisible.map(({ pl, x, y, z }) => <path key={String(pl.m.id)} d={diamond(x, y, x + T(pl.m.cw), y + T(pl.m.ch), z)}
          className={selSet.has(pl) ? "selected-outline" : "other-outline"} />)}
      </svg>
      <svg className="docks-seams" width="1" height="1" style={{ zIndex: 630 }}>
        {cities.filter(c => c.tier).map(c => <g key={c.v.id} className={`docks-city t${Math.min(5, c.tier)}${c.z !== pz ? " other-level" : ""}`} style={{ ["--flag" as string]: c.v.color }}>
          <path d={c.front} className="wall front" /><path d={c.frontCrest} className="crest" />
          {c.tier === 3 && c.corners.map((k, i) => { const th = c.h + 12; return <g key={i} className="tower">
            <path d={`M${(k.x - 5).toFixed(1)} ${k.y.toFixed(1)}h10v${-th}h-10Z`} className="keep" />
            <path d={`M${(k.x - 6.5).toFixed(1)} ${(k.y - th).toFixed(1)}l6.5 -10l6.5 10Z`} className="roof" />
            <path d={`M${k.x.toFixed(1)} ${(k.y - th - 10).toFixed(1)}v-6l6 1.5l-6 1.5`} className="pennant" /></g>; })}
          {c.tier >= 4 && c.corners.map((k, i) => <g key={i} className="pylon">
            <path d={`M${(k.x - 1.5).toFixed(1)} ${k.y.toFixed(1)}h3v${-(c.h + 16)}h-3Z`} className="mast" />
            <circle cx={k.x} cy={k.y - c.h - 18} r={3.2} className="orb" /></g>)}</g>)}
      </svg>
      {cities.map(c => <div key={c.v.id} className={`docks-banner t${Math.min(5, c.tier)}${c.v.founded ? "" : " rising"}`} style={{ left: c.banner.x, top: c.banner.y, zIndex: 660, ["--flag" as string]: c.v.color, transform: `translate(-50%, -100%) scale(${bannerScale})` }}>
        <strong>🚩 {c.v.name}</strong>
        <span>{c.v.founded ? `Lv ${c.tier} · ${SK.skinName(c.tier)} ${SK.skinIcon(c.tier)}` : "Rising flag"} · 👥 {c.pop.toLocaleString()}</span>
        <span>{c.v.founded ? `${c.v.members.length} islands · next level at ${c.next.toLocaleString()}` : `${Math.floor(c.v.locked / c.v.target * 100)}% raised`}</span>
        <em>{c.v.founded ? (c.v.enrollOpen ? `Founding closed · open to join (${c.v.enrollPrice.toLocaleString()} RF)` : "Founding closed · not taking islands") : "Founders wanted: lock RF to be an OG"}</em>
      </div>)}
      {stairs.map(s => <span key={s.key} className={`docks-stairs${s.z !== pz ? " other-level" : ""}`} style={{ left: s.x, top: s.y, zIndex: 620 }} title={s.up ? "Stairs up" : "Stairs down"}>{s.up ? "⬆" : "⬇"}</span>)}
      {gates.map(g => <span key={g.key} className={`docks-gate ${g.open ? "open" : "shut"}`} style={{ left: g.x, top: g.y, zIndex: 600 }}>{g.open ? "⇄" : "🔒"}</span>)}
      {builds.map(b => <span key={b.id} className={`docks-item-mark${b.ready ? "" : " building"}`} style={{ left: b.x, top: b.y, zIndex: 640 }} title={b.name}>{b.icon}{!b.ready && <i>🔨</i>}</span>)}
      {flags.map(f => <span key={f.v.id} className={`docks-flag${f.v.founded ? "" : " rising"} skin-${Math.min(5, SK.tierOfFlag(f.v))}`} style={{ left: f.x, top: f.y, zIndex: 650, ["--flag" as string]: f.v.color, ["--raised" as string]: `${f.v.founded ? 100 : Math.max(8, Math.floor(f.v.locked / f.v.target * 100))}%` }}>
        <i className="pole" /><i className="cloth" />{SK.tierOfFlag(f.v) > 0 && <i className="walls">{SK.skinIcon(SK.tierOfFlag(f.v)).repeat(Math.min(4, SK.tierOfFlag(f.v)))}</i>}{(() => { const a = state.current.flagFriendArt?.(f.v); return a ? <img className="docks-flag-friend" src={a} alt="" /> : null; })()}<b>{f.v.name} · {f.v.founded ? `${f.v.members.length} island${f.v.members.length === 1 ? "" : "s"}` : `${Math.floor(f.v.locked / f.v.target * 100)}% raised`}</b></span>)}
      {labels.map(l => <span key={l.plot.id} className={`docks-plot-label ${l.plot.mine ? "mine" : ""}`} style={{ left: l.x, top: l.y, zIndex: 700 }}>
        {l.village && <i className="docks-pennant" style={{ background: l.village.color }} title={l.village.name} />}{l.z !== 0 && <i className="docks-level-tag">{l.z > 0 ? `▲${l.z}` : `▼${-l.z}`}</i>}{l.plot.name} · {l.rank}{l.plot.mine ? ` · ${l.plot.friends.length}` : l.village ? "" : " · no flag"}{l.plot.berth ? "" : " · floating"}</span>)}
      {myVisible.length <= 150 && myVisible.map(({ pl, x, y, z }) => { const c = toScreen(x + T(pl.m.cw) / 2, y + T(pl.m.ch) / 2, z);
        return <span key={String(pl.m.id)} className={`docks-friend-tag ${selSet.has(pl) ? "sel" : ""}`} style={{ left: c.x, top: c.y, zIndex: 800 }}>#{String(pl.m.id)}</span>; })}
      {crew.map(m => <canvas key={String(m.id)} ref={el => { if (el) crewCanvases.current.set(String(m.id), el); else crewCanvases.current.delete(String(m.id)); }}
        className={`docks-avatar crew${m.mode === "park" ? " parked" : ""}${crewSel.has(m.id) ? " picked" : ""}`} width={36} height={36} style={{ zIndex: 890 }} />)}
      {crew.map(m => <span key={`mk${m.id}`} ref={el => { if (el) crewMarks.current.set(String(m.id), el); else crewMarks.current.delete(String(m.id)); }} className="docks-mine-mark" style={{ zIndex: 895 }} aria-hidden="true">▾</span>)}
      <canvas ref={avatar} className="docks-avatar" width={36} height={36} style={{ zIndex: 900 }} />
      <span ref={youTag} className="docks-you" style={{ zIndex: 910 }} aria-hidden="true">YOU<i>▼</i></span>
    </div>
  </div>;
}
