/* The Docks — renders every Friend's real on-chain artwork side by side, with the
 * seams between plots, and walks the selected Friend across them. */
import { useEffect, useMemo, useRef, useState } from "react";
import { spriteFrame, type GenerationSprites, type SpriteFacing } from "@rarefriends/friendsdk/sprites";
import { fromScreen, toScreen, type Friend } from "./land.js";
import { canEnter, mine, rankOf, tileAt, type Placed, type Plot, type World } from "./world.js";

export type ViewApi = { focusOn: (x: number, y: number) => void; position: () => { x: number; y: number }; teleport: (x: number, y: number) => void };
type Props = {
  world: World; version: number; sprites: GenerationSprites | null; walkerId: bigint;
  zoom: number; paused: boolean; reducedMotion: boolean;
  selected: Placed | null;                       // arrange mode selection
  onBlocked: (plot: Plot) => void; onEnterPlot: (plot: Plot | null) => void;
  apiRef: React.MutableRefObject<ViewApi | null>;
};

const SPEED = 4;                                  // tiles per second
const screenDir: Record<string, [number, number]> = {
  w: [-1, -1], arrowup: [-1, -1], s: [1, 1], arrowdown: [1, 1], a: [-1, 1], arrowleft: [-1, 1], d: [1, -1], arrowright: [1, -1],
};

/** Walkable tile nearest to a Friend's centre. */
export function spawnOn(w: World, pl: Placed) {
  const f = pl.friend, cx = f.w / 2, cy = f.h / 2;
  let best = { x: pl.x + cx, y: pl.y + cy }, bd = Infinity;
  for (let j = 0; j < f.h; j++) for (let i = 0; i < f.w; i++) {
    if (!f.tiles[j * f.w + i] || f.blocked[j * f.w + i]) continue;
    const d = Math.hypot(i + 0.5 - cx, j + 0.5 - cy);
    if (d < bd) { bd = d; best = { x: pl.x + i + 0.5, y: pl.y + j + 0.5 }; }
  }
  return best;
}

function outline(f: Friend, ox: number, oy: number) {
  const segs: string[] = [];
  const has = (i: number, j: number) => i >= 0 && j >= 0 && i < f.w && j < f.h && f.tiles[j * f.w + i];
  const L = (x1: number, y1: number, x2: number, y2: number) => { const a = toScreen(ox + x1, oy + y1), b = toScreen(ox + x2, oy + y2); segs.push(`M${a.x.toFixed(1)} ${a.y.toFixed(1)}L${b.x.toFixed(1)} ${b.y.toFixed(1)}`); };
  for (let j = 0; j < f.h; j++) for (let i = 0; i < f.w; i++) {
    if (!has(i, j)) continue;
    if (!has(i, j - 1)) L(i, j, i + 1, j);
    if (!has(i, j + 1)) L(i, j + 1, i + 1, j + 1);
    if (!has(i - 1, j)) L(i, j, i, j + 1);
    if (!has(i + 1, j)) L(i + 1, j, i + 1, j + 1);
  }
  return segs.join("");
}

export function DocksView({ world, version, sprites, walkerId, zoom, paused, reducedMotion, selected, onBlocked, onEnterPlot, apiRef }: Props) {
  const viewport = useRef<HTMLDivElement>(null), layer = useRef<HTMLDivElement>(null), avatar = useRef<HTMLCanvasElement>(null);
  const player = useRef({ x: 0, y: 0, facing: "down" as SpriteFacing, walking: false, target: null as null | { x: number; y: number } });
  const focus = useRef<{ x: number; y: number } | null>(null);
  const keys = useRef(new Set<string>());
  const state = useRef({ paused, zoom, reducedMotion, selected, onBlocked, onEnterPlot, world, sprites, lastPlot: null as Plot | null, lastBlock: 0 });
  state.current = { ...state.current, paused, zoom, reducedMotion, selected, onBlocked, onEnterPlot, world, sprites };

  // initial position: on my selected Friend
  useEffect(() => {
    const me = mine(world), pl = me.friends.find(p => p.friend.tokenId === walkerId) ?? me.friends[0];
    if (pl) { const s = spawnOn(world, pl); player.current.x = s.x; player.current.y = s.y; }
  }, [walkerId]); // eslint-disable-line react-hooks/exhaustive-deps

  apiRef.current = {
    focusOn: (x, y) => { focus.current = { x, y }; },
    position: () => ({ x: player.current.x, y: player.current.y }),
    teleport: (x, y) => { player.current.x = x; player.current.y = y; player.current.target = null; focus.current = null; },
  };

  // input
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLElement && e.target.closest("input,.rf-frame-menu")) return;
      const k = e.key.toLowerCase();
      if (screenDir[k] && !state.current.selected) { e.preventDefault(); keys.current.add(k); player.current.target = null; focus.current = null; }
    };
    const up = (e: KeyboardEvent) => keys.current.delete(e.key.toLowerCase());
    const stop = () => { keys.current.clear(); player.current.target = null; };
    window.addEventListener("keydown", down); window.addEventListener("keyup", up); window.addEventListener("blur", stop);
    document.addEventListener("visibilitychange", stop);
    return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); window.removeEventListener("blur", stop); document.removeEventListener("visibilitychange", stop); };
  }, []);

  const onPointer = (e: React.PointerEvent) => {
    if (state.current.paused || state.current.selected || !viewport.current || !layer.current) return;
    const r = viewport.current.getBoundingClientRect(), m = new DOMMatrixReadOnly(getComputedStyle(layer.current).transform);
    const wx = (e.clientX - r.left - m.e) / m.a, wy = (e.clientY - r.top - m.f) / m.d;
    player.current.target = fromScreen(wx, wy); focus.current = null;
  };

  // walk / camera / avatar loop
  useEffect(() => {
    let raf = 0, last = performance.now(), t = 0, frameKey = "";
    const walkable = (x: number, y: number) => {
      const o = tileAt(state.current.world, x, y);
      if (!o || o.blocked) return { ok: false as const };
      if (!canEnter(state.current.world, o.plot)) return { ok: false as const, gate: o.plot };
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
    const draw = () => {
      const cv = avatar.current, s = state.current.sprites; if (!cv) return;
      const p = player.current, frame = state.current.reducedMotion ? 0 : Math.floor(t * (p.walking ? 10 : 5)) % 8;
      const k = `${s?.cacheKey}:${p.facing}:${p.walking}:${frame}`;
      if (k === frameKey) return; frameKey = k;
      const ctx = cv.getContext("2d")!; ctx.clearRect(0, 0, cv.width, cv.height);
      const rows = s ? spriteFrame(s, p.facing, p.walking, frame).frame.rows
        : Array.from({ length: 16 }, (_, y) => Array.from({ length: 16 }, (_, x) => Math.hypot(x - 7.5, y - 9) < 5 ? "#" : ".").join(""));
      const S = 2;
      ctx.fillStyle = "#fff";
      rows.forEach((row, y) => [...row].forEach((c, x) => { if (c === "#") ctx.fillRect(x * S, y * S, S * 3, S * 3); }));
      ctx.fillStyle = "#000";
      rows.forEach((row, y) => [...row].forEach((c, x) => { if (c === "#") ctx.fillRect((x + 1) * S, (y + 1) * S, S, S); }));
    };
    const tick = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000); last = now; t += dt;
      const st = state.current, p = player.current;
      if (!st.paused && !st.selected) {
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
        const here = tileAt(st.world, p.x, p.y)?.plot ?? null;
        if (here !== st.lastPlot) { st.lastPlot = here; st.onEnterPlot(here); }
      } else p.walking = false;
      // camera
      const vp = viewport.current, ly = layer.current;
      if (vp && ly) {
        const target = st.selected ? { x: st.selected.x + st.selected.friend.w / 2, y: st.selected.y + st.selected.friend.h / 2 } : focus.current ?? p;
        const sc = toScreen(target.x, target.y), z = st.zoom;
        ly.style.transform = `translate(${(vp.clientWidth / 2 - sc.x * z).toFixed(1)}px, ${(vp.clientHeight * 0.55 - sc.y * z).toFixed(1)}px) scale(${z})`;
      }
      const a = avatar.current;
      if (a) { const s = toScreen(p.x, p.y); a.style.left = `${(s.x - 13.5).toFixed(2)}px`; a.style.top = `${(s.y - 25.5 - (p.walking && !st.reducedMotion ? Math.abs(Math.sin(t * 12)) * 1.2 : 0)).toFixed(2)}px`; }
      draw();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  // static layers (recomputed when the world changes)
  const me = mine(world);
  const lands = useMemo(() => world.plots.flatMap(plot => plot.friends.map(pl => ({ plot, pl })))
    .sort((a, b) => (a.pl.x + a.pl.y + (a.pl.friend.w + a.pl.friend.h) / 2) - (b.pl.x + b.pl.y + (b.pl.friend.w + b.pl.friend.h) / 2)),
  [world, version]); // eslint-disable-line react-hooks/exhaustive-deps
  const seams = useMemo(() => {
    const open: string[] = [], shut: string[] = [], gates = new Map<string, { x: number; y: number; n: number; plot: Plot }>();
    for (const [k, o] of world.occ) {
      const [x, y] = k.split(",").map(Number);
      for (const [dx, dy] of [[1, 0], [0, 1]]) {
        const n = world.occ.get(`${x + dx},${y + dy}`);
        if (!n || n.plot === o.plot || !o.plot.docked || !n.plot.docked) continue;
        const other = o.plot.mine ? n.plot : n.plot.mine ? o.plot : (canEnter(world, o.plot) ? n.plot : o.plot);
        const shutNow = !canEnter(world, o.plot) || !canEnter(world, n.plot);
        const a = dx ? toScreen(x + 1, y) : toScreen(x, y + 1), b = dx ? toScreen(x + 1, y + 1) : toScreen(x + 1, y + 1);
        (shutNow ? shut : open).push(`M${a.x.toFixed(1)} ${a.y.toFixed(1)}L${b.x.toFixed(1)} ${b.y.toFixed(1)}`);
        const gk = [o.plot.id, n.plot.id].sort().join("|"), g = gates.get(gk) ?? { x: 0, y: 0, n: 0, plot: other };
        g.x += (a.x + b.x) / 2; g.y += (a.y + b.y) / 2; g.n++; gates.set(gk, g);
      }
    }
    return { open: open.join(""), shut: shut.join(""), gates: [...gates.values()].map(g => ({ x: g.x / g.n, y: g.y / g.n, plot: g.plot })) };
  }, [world, version]); // eslint-disable-line react-hooks/exhaustive-deps
  const labels = useMemo(() => world.plots.filter(p => p.friends.length).map(p => {
    let top = { x: 0, y: Infinity };
    for (const pl of p.friends) { const c = toScreen(pl.x + pl.friend.w / 2, pl.y); if (c.y < top.y) top = c; }
    return { plot: p, x: top.x, y: top.y - 26, rank: rankOf(p).rank };
  }), [world, version]); // eslint-disable-line react-hooks/exhaustive-deps

  return <div className="docks-viewport" ref={viewport} onPointerDown={onPointer} aria-hidden="true">
    <div className="docks-layer" ref={layer}>
      {lands.map(({ plot, pl }, i) => {
        const o = toScreen(pl.x, pl.y), f = pl.friend;
        const src = plot.mine && f.tokenId === walkerId ? f.artWithoutPortrait : f.art;
        return <img key={`${plot.id}-${f.tokenId}`} className={`docks-land ${plot.docked ? "" : "adrift"}`} src={src} alt="" draggable={false}
          style={{ left: o.x - f.anchor.x, top: o.y - f.anchor.y, zIndex: 10 + i }} />;
      })}
      <svg className="docks-seams" width="1" height="1" style={{ zIndex: 500 }}>
        <path d={seams.open} className="seam-open" /><path d={seams.shut} className="seam-shut" />
        {selected && <path d={outline(selected.friend, selected.x, selected.y)} className="selected-outline" />}
        {me.friends.length > 1 && selected && me.friends.filter(p => p !== selected).map(p => <path key={String(p.friend.tokenId)} d={outline(p.friend, p.x, p.y)} className="other-outline" />)}
      </svg>
      {seams.gates.map((g, i) => <span key={i} className={`docks-gate ${canEnter(world, g.plot) ? "open" : "shut"}`} style={{ left: g.x, top: g.y, zIndex: 600 }}>{canEnter(world, g.plot) ? "⇄" : "🔒"}</span>)}
      {labels.map(l => <span key={l.plot.id} className={`docks-plot-label ${l.plot.mine ? "mine" : ""}`} style={{ left: l.x, top: l.y, zIndex: 700 }}>
        {l.plot.name} · {l.rank}{l.plot.mine ? "" : l.plot.access === "open" ? " · open" : " · invite"}{l.plot.docked ? "" : " · adrift"}</span>)}
      {selected && me.friends.map(p => { const c = toScreen(p.x + p.friend.w / 2, p.y + p.friend.h / 2);
        return <span key={String(p.friend.tokenId)} className={`docks-friend-tag ${p === selected ? "sel" : ""}`} style={{ left: c.x, top: c.y, zIndex: 800 }}>#{String(p.friend.tokenId)}</span>; })}
      <canvas ref={avatar} className="docks-avatar" width={36} height={36} style={{ zIndex: 900 }} />
    </div>
  </div>;
}
