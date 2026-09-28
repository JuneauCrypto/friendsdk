/* The Docks — renders every Friend's real on-chain artwork side by side, with the seams
 * between plots, and walks you (and your crew) across them. Only what's near the camera is
 * drawn, and art is requested lazily, so plots of 10,000 Friends stay smooth. */
import { useEffect, useMemo, useRef, useState } from "react";
import { spriteFrame, type GenerationSprites, type SpriteFacing } from "@rarefriends/friendsdk/sprites";
import { fromScreen, toScreen } from "./land.js";
import { CELL, canEnter, ck, neighboursOf, plotOf, rankOf, tileAt, type Placed, type Plot, type World } from "./world.js";

/** A Friend walking around off its land: following the lead, or left standing somewhere. */
export type CrewMember = { id: bigint; sprites: GenerationSprites | null; mode: "follow" | "park" };
export type ViewApi = {
  focusOn: (x: number, y: number) => void; position: () => { x: number; y: number }; teleport: (x: number, y: number) => void;
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
  onWalkerTap: (id: bigint) => void;
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
  const p = plotOf(w, pl.m.id); const at = p ? worldXY(w, p, pl) : { x: 0, y: 0 };
  const f = pl.m.friend, W = T(pl.m.cw), Hh = T(pl.m.ch), cx = W / 2, cy = Hh / 2;
  let best = { x: at.x + cx, y: at.y + cy }, bd = Infinity;
  if (!f) return best;
  for (let j = 0; j < f.h; j++) for (let i = 0; i < f.w; i++) {
    if (!f.tiles[j * f.w + i] || f.blocked[j * f.w + i]) continue;
    const d = Math.hypot(i + 0.5 - cx, j + 0.5 - cy);
    if (d < bd) { bd = d; best = { x: at.x + i + 0.5, y: at.y + j + 0.5 }; }
  }
  return best;
}

const diamond = (x0: number, y0: number, x1: number, y1: number) => {
  const a = toScreen(x0, y0), b = toScreen(x1, y0), c = toScreen(x1, y1), d = toScreen(x0, y1);
  return `M${a.x.toFixed(1)} ${a.y.toFixed(1)}L${b.x.toFixed(1)} ${b.y.toFixed(1)}L${c.x.toFixed(1)} ${c.y.toFixed(1)}L${d.x.toFixed(1)} ${d.y.toFixed(1)}Z`;
};

type Follower = { x: number; y: number; facing: SpriteFacing; walking: boolean };
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
  const viewport = useRef<HTMLDivElement>(null), layer = useRef<HTMLDivElement>(null), avatar = useRef<HTMLCanvasElement>(null);
  const crewCanvases = useRef(new Map<string, HTMLCanvasElement>());
  const followers = useRef(new Map<string, Follower>());
  const trail = useRef<{ x: number; y: number }[]>([]);
  const player = useRef({ x: 0, y: 0, facing: "down" as SpriteFacing, walking: false, target: null as null | { x: number; y: number } });
  const focus = useRef<{ x: number; y: number } | null>(null);
  const keys = useRef(new Set<string>());
  const [vis, setVis] = useState({ x0: -160, y0: -160, x1: 160, y1: 160 });  // visible box, world tiles
  const state = useRef({ ...props, lastPlot: null as Plot | null, lastBlock: 0, visKey: "" });
  state.current = { ...state.current, ...props };

  // the lead: start on its land; when you take over another Friend, swap places with it
  const prevLead = useRef<bigint | null>(null);
  useEffect(() => {
    const pc = player.current, old = prevLead.current;
    const f = followers.current.get(String(walkerId));
    if (old !== null && old !== walkerId) followers.current.set(String(old), { x: pc.x, y: pc.y, facing: pc.facing, walking: false });
    if (f) { pc.x = f.x; pc.y = f.y; followers.current.delete(String(walkerId)); }
    else { const p = plotOf(world, walkerId), pl = p?.friends.find(x => x.m.id === walkerId); if (pl) { const s = spawnOn(world, pl); pc.x = s.x; pc.y = s.y; } }
    pc.target = null; trail.current = []; focus.current = null; prevLead.current = walkerId;
  }, [walkerId]); // eslint-disable-line react-hooks/exhaustive-deps

  const camTarget = useRef({ x: 0, y: 0 });
  apiRef.current = {
    focusOn: (x, y) => { focus.current = { x, y }; },
    recenter: () => { focus.current = null; },
    fitAll: () => {
      const vp = viewport.current; if (!vp) return;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const b of state.current.world.box.values()) for (const [x, y] of [[b.x0, b.y0], [b.x1, b.y0], [b.x0, b.y1], [b.x1, b.y1]]) {
        const sc = toScreen(x, y); x0 = Math.min(x0, sc.x); x1 = Math.max(x1, sc.x); y0 = Math.min(y0, sc.y); y1 = Math.max(y1, sc.y);
      }
      if (!Number.isFinite(x0)) return;
      const z = clampZoom(Math.min(vp.clientWidth / (x1 - x0 + 60), vp.clientHeight * 0.7 / (y1 - y0 + 80)));
      focus.current = fromScreen((x0 + x1) / 2, (y0 + y1) / 2);
      state.current.onZoom(z);
    },
    position: () => ({ x: player.current.x, y: player.current.y }),
    teleport: (x, y) => {
      player.current.x = x; player.current.y = y; player.current.target = null; focus.current = null; trail.current = [];
      const follow = new Set(state.current.crew.filter(m => m.mode === "follow").map(m => String(m.id)));
      for (const [k, f] of followers.current) if (follow.has(k)) { f.x = x; f.y = y; }
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
    const at = fromScreen((e.clientX - r.left - m.e) / m.a, (e.clientY - r.top - m.f) / m.d);
    if (st.arranging) {
      const o = tileAt(st.world, at.x, at.y);
      if (o?.plot?.mine && o.placed) st.onPick(o.placed);
      return;
    }
    // tapping one of your walking Friends picks it (to lead it, leave it or bring it along)
    const sx = (e.clientX - r.left - m.e) / m.a, sy = (e.clientY - r.top - m.f) / m.d;
    let hit: bigint | null = null, best = 12;
    for (const c of st.crew) {
      const f = followers.current.get(String(c.id)); if (!f) continue;
      const s = toScreen(f.x, f.y), d = Math.hypot(s.x - sx, s.y - 10 - sy);
      if (d < best) { best = d; hit = c.id; }
    }
    if (hit !== null) { st.onWalkerTap(hit); return; }
    player.current.target = at; focus.current = null;
  };

  // walk / crew / camera loop
  useEffect(() => {
    let raf = 0, last = performance.now(), t = 0, frameKey = "";
    const walkable = (x: number, y: number) => {
      const o = tileAt(state.current.world, x, y);
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
      if (!lastPt || Math.hypot(lastPt.x - p.x, lastPt.y - p.y) > 0.3) { tr.push({ x: p.x, y: p.y }); if (tr.length > 400) tr.shift(); }
      let n = 0;
      state.current.crew.forEach(m => {
        const key = String(m.id);
        let f = followers.current.get(key);
        if (!f) {                                     // called away from its land: set off from there
          const home = plotOf(state.current.world, m.id)?.friends.find(x => x.m.id === m.id);
          const s = home ? spawnOn(state.current.world, home) : { x: p.x, y: p.y };
          f = { x: s.x, y: s.y, facing: "down", walking: false }; followers.current.set(key, f);
        }
        if (m.mode === "park") { f.walking = false; return; }
        n++;
        const goal = tr[Math.max(0, tr.length - 1 - n * 4)] ?? p;
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
        const sc = toScreen(f.x, f.y); c.style.left = `${(sc.x - 13.5).toFixed(2)}px`; c.style.top = `${(sc.y - 25.5).toFixed(2)}px`;
      }
    };
    const tick = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000); last = now; t += dt;
      const st = state.current, p = player.current;
      if (!st.paused && !st.arranging) {
        let mx = 0, my = 0;
        for (const k of keys.current) { const d = screenDir[k]; if (d) { mx += d[0]; my += d[1]; } }
        if (!mx && !my && p.target) { const dx = p.target.x - p.x, dy = p.target.y - p.y, d = Math.hypot(dx, dy); if (d < 0.08) p.target = null; else { mx = dx / d; my = dy / d; } }
        const len = Math.hypot(mx, my); p.walking = len > 0;
        if (len) {
          mx /= len; my /= len;
          if (!tryMove(mx * SPEED * dt, my * SPEED * dt)) p.target = null;
          const sx = mx - my, sy = mx + my;
          p.facing = Math.abs(sx) > Math.abs(sy) ? (sx > 0 ? "right" : "left") : (sy > 0 ? "down" : "up");
        }
        stepCrew(dt);
        for (const k of followers.current.keys()) if (!st.crew.some(c => String(c.id) === k)) followers.current.delete(k);   // sent home
        const under = tileAt(st.world, p.x, p.y);
        if (!under) {                                   // islands re-laid out under us: step back onto my Friend
          const home = plotOf(st.world, st.walkerId)?.friends.find(x => x.m.id === st.walkerId);
          if (home) { const sp = spawnOn(st.world, home); p.x = sp.x; p.y = sp.y; p.target = null; }
        }
        const here = tileAt(st.world, p.x, p.y)?.plot ?? null;
        if (here !== st.lastPlot) { st.lastPlot = here; st.onEnterPlot(here); }
      } else p.walking = false;
      // camera
      const vp = viewport.current, ly = layer.current;
      if (vp && ly) {
        const sel = st.selected[0] ?? null, sp = sel ? plotOf(st.world, sel.m.id) : null, sw = sel && sp ? worldXY(st.world, sp, sel) : null;
        const target = focus.current ?? (st.arranging && sel && sw ? { x: sw.x + T(sel.m.cw) / 2, y: sw.y + T(sel.m.ch) / 2 } : p);
        camTarget.current = { x: target.x, y: target.y };
        const sc = toScreen(target.x, target.y), z = st.zoom;
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
      if (a) { const s = toScreen(p.x, p.y); a.style.left = `${(s.x - 13.5).toFixed(2)}px`; a.style.top = `${(s.y - 25.5 - (p.walking && !st.reducedMotion ? Math.abs(Math.sin(t * 12)) * 1.2 : 0)).toFixed(2)}px`; }
      draw();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  // what's near the camera (world tiles)
  type Vis = { plot: Plot; pl: Placed; x: number; y: number };
  const visible = useMemo(() => {
    const out: Vis[] = [];
    for (const plot of world.plots) {
      const b = world.box.get(plot), o = world.origin.get(plot);
      if (!b || !o || b.x1 < vis.x0 || b.x0 > vis.x1 || b.y1 < vis.y0 || b.y0 > vis.y1) continue;
      for (const pl of plot.friends) {
        const x = o.x + T(pl.x), y = o.y + T(pl.y);
        if (x + T(pl.m.cw) >= vis.x0 && x <= vis.x1 && y + T(pl.m.ch) >= vis.y0 && y <= vis.y1) out.push({ plot, pl, x, y });
      }
    }
    return out.sort((a, b) => (a.x + a.y + T(a.pl.m.cw + a.pl.m.ch) / 2) - (b.x + b.y + T(b.pl.m.cw + b.pl.m.ch) / 2));
  }, [world, version, vis]); // eslint-disable-line react-hooks/exhaustive-deps
  // Zoomed far out: draw the islands' outlines only and don't fetch art for thousands of lands.
  const simple = visible.length > 600 || props.zoom < 0.2;
  useEffect(() => { if (!simple) props.onVisible(visible.map(v => v.pl)); }, [visible, simple]); // eslint-disable-line react-hooks/exhaustive-deps

  const boards = useMemo(() => visible.map(v => diamond(v.x, v.y, v.x + T(v.pl.m.cw), v.y + T(v.pl.m.ch))).join(""), [visible]);
  const holes = useMemo(() => {
    const out: { key: string; d: string; x: number; y: number; id: bigint }[] = [];
    for (const plot of world.plots) {
      const o = world.origin.get(plot); if (!o) continue;
      for (const h of plot.holes ?? []) {
        const x = o.x + T(h.x), y = o.y + T(h.y);
        if (x + T(h.cw) < vis.x0 || x > vis.x1 || y + T(h.ch) < vis.y0 || y > vis.y1) continue;
        const c = toScreen(x + T(h.cw) / 2, y + T(h.ch) / 2);
        out.push({ key: `${plot.id}-${h.id}`, d: diamond(x, y, x + T(h.cw), y + T(h.ch)), x: c.x, y: c.y, id: h.id });
      }
    }
    return out;
  }, [world, version, vis]); // eslint-disable-line react-hooks/exhaustive-deps
  const walkways = useMemo(() => {
    const g: string[] = [], br: string[] = [];
    for (const [k, kind] of world.walk) {
      const x = Math.floor(k / (1 << 21)) - (1 << 20), y = (k % (1 << 21)) - (1 << 20);
      if (x < vis.x0 || x > vis.x1 || y < vis.y0 || y > vis.y1) continue;
      if (tileAt(world, x + 0.5, y + 0.5)?.plot) continue;            // island ground takes precedence
      (kind === "bridge" ? br : g).push(diamond(x, y, x + 1, y + 1));
    }
    return { gangway: g.join(""), bridge: br.join("") };
  }, [world, version, vis]); // eslint-disable-line react-hooks/exhaustive-deps
  const gates = useMemo(() => {
    const out: { x: number; y: number; open: boolean; key: string }[] = [], seen = new Set<string>();
    for (const p of world.plots) {
      if (!p.berth) continue;
      for (const q of neighboursOf(world, p)) {
        const key = [p.id, q.id].sort().join("|"); if (seen.has(key)) continue; seen.add(key);
        const a = world.box.get(p)!, b = world.box.get(q)!;
        const c = toScreen(((a.x0 + a.x1) / 2 + (b.x0 + b.x1) / 2) / 2, ((a.y0 + a.y1) / 2 + (b.y0 + b.y1) / 2) / 2);
        out.push({ x: c.x, y: c.y, open: canEnter(world, p) && canEnter(world, q), key });
      }
    }
    return out;
  }, [world, version]); // eslint-disable-line react-hooks/exhaustive-deps
  const labels = useMemo(() => world.plots.filter(p => p.friends.length && world.box.get(p)).map(p => {
    const b = world.box.get(p)!, c = toScreen(b.x0, b.y0);
    return { plot: p, x: c.x, y: c.y - 20, rank: rankOf(p).rank };
  }), [world, version]); // eslint-disable-line react-hooks/exhaustive-deps
  const selSet = new Set(selected);
  const selPlot = selected[0] ? plotOf(world, selected[0].m.id) : null;
  const myVisible = arranging ? visible.filter(v => v.plot === selPlot) : [];

  return <div className="docks-viewport" ref={viewport} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} aria-hidden="true">
    <div className="docks-layer" ref={layer}>
      <svg className="docks-seams" width="1" height="1" style={{ zIndex: 5 }}>
        <path d={walkways.gangway} className="gangway" /><path d={walkways.bridge} className="bridge" /><path d={boards} className="pier" />
        {holes.map(h => <path key={h.key} d={h.d} className="hole" />)}</svg>
      {holes.map(h => <span key={h.key} className="docks-hole-tag" style={{ left: h.x, top: h.y, zIndex: 9 }}>hole · #{String(h.id)}</span>)}
      {!simple && visible.map(({ plot, pl, x, y }, i) => {
        const f = pl.m.friend, o = toScreen(x, y);
        if (!f) { const c = toScreen(x + T(pl.m.cw) / 2, y + T(pl.m.ch) / 2);
          return <span key={`${plot.id}-${pl.m.id}`} className="docks-pending" style={{ left: c.x, top: c.y, zIndex: 10 + i }}>#{String(pl.m.id)}</span>; }
        const src = plot.mine && (pl.m.id === walkerId || offLand.has(pl.m.id)) ? f.artWithoutPortrait : f.art;
        return <img key={`${plot.id}-${pl.m.id}`} className={`docks-land ${plot.berth ? "" : "adrift"}`} src={src} alt="" draggable={false}
          style={{ left: o.x - f.anchor.x, top: o.y - f.anchor.y, zIndex: 10 + i }} />;
      })}
      <svg className="docks-seams" width="1" height="1" style={{ zIndex: 500 }}>
        {myVisible.map(({ pl, x, y }) => <path key={String(pl.m.id)} d={diamond(x, y, x + T(pl.m.cw), y + T(pl.m.ch))}
          className={selSet.has(pl) ? "selected-outline" : "other-outline"} />)}
      </svg>
      {gates.map(g => <span key={g.key} className={`docks-gate ${g.open ? "open" : "shut"}`} style={{ left: g.x, top: g.y, zIndex: 600 }}>{g.open ? "⇄" : "🔒"}</span>)}
      {labels.map(l => <span key={l.plot.id} className={`docks-plot-label ${l.plot.mine ? "mine" : ""}`} style={{ left: l.x, top: l.y, zIndex: 700 }}>
        {l.plot.name} · {l.rank}{l.plot.mine ? ` · ${l.plot.friends.length}` : l.plot.access === "open" ? " · open" : " · invite"}{l.plot.berth ? "" : " · floating"}</span>)}
      {myVisible.length <= 150 && myVisible.map(({ pl, x, y }) => { const c = toScreen(x + T(pl.m.cw) / 2, y + T(pl.m.ch) / 2);
        return <span key={String(pl.m.id)} className={`docks-friend-tag ${selSet.has(pl) ? "sel" : ""}`} style={{ left: c.x, top: c.y, zIndex: 800 }}>#{String(pl.m.id)}</span>; })}
      {crew.map(m => <canvas key={String(m.id)} ref={el => { if (el) crewCanvases.current.set(String(m.id), el); else crewCanvases.current.delete(String(m.id)); }}
        className={`docks-avatar crew${m.mode === "park" ? " parked" : ""}${crewSel.has(m.id) ? " picked" : ""}`} width={36} height={36} style={{ zIndex: 890 }} />)}
      <canvas ref={avatar} className="docks-avatar" width={36} height={36} style={{ zIndex: 900 }} />
    </div>
  </div>;
}
