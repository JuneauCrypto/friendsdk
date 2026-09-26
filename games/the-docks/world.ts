/* The Docks — a place where activated Friends dock side by side.
 * Pure logic, no rendering. Session-only in this preview (the SDK sandbox has no storage).
 *
 * - A plot is one owner's group of Friends, arranged however they like (gaps allowed).
 * - Plots dock edge to edge; the seam where two plots touch is the walkway between them.
 * - Crossing a seam into someone else's plot needs their approval unless they keep it open. */
import { rewardWeight, type Friend } from "./land.js";

export type Access = "open" | "invite";
export type Placed = { friend: Friend; x: number; y: number };           // world tile position of the footprint origin
export type Plot = {
  id: string; name: string; mine: boolean; access: Access;
  friends: Placed[]; docked: boolean;
  policy?: "approve" | "decline";                                          // sample neighbours' simulated answer
};
export type Visit = "none" | "pending" | "approved" | "declined";
export type World = {
  plots: Plot[]; visits: Map<string, Visit>; version: number;
  /** pier: tiles inside a Friend's whole-cell footprint that its land doesn't cover — boardwalk. */
  occ: Map<string, { plot: Plot; placed: Placed; blocked: boolean; pier?: boolean }>;
};

const key = (x: number, y: number) => `${x},${y}`;
/** The on-chain grid (DocksRegistry): 4x4-tile cells; each Friend covers whole cells at true size. */
export const CELL = 4;
export const snap = (v: number) => Math.round(v / CELL) * CELL;
export const cellsW = (f: Friend) => Math.ceil(f.w / CELL), cellsH = (f: Friend) => Math.ceil(f.h / CELL);
export const mine = (w: World) => w.plots.find(p => p.mine)!;

export function rebuild(w: World) {
  w.occ = new Map();
  for (const plot of w.plots) for (const pl of plot.friends) {
    const f = pl.friend, W = cellsW(f) * CELL, H = cellsH(f) * CELL;
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
      const land = i < f.w && j < f.h && f.tiles[j * f.w + i];
      w.occ.set(key(pl.x + i, pl.y + j), land ? { plot, placed: pl, blocked: f.blocked[j * f.w + i] } : { plot, placed: pl, blocked: false, pier: true });
    }
  }
  w.version++;
}

export function createWorld(neighbours: Plot[], myPlot: Plot): World {
  const w: World = { plots: [], visits: new Map(), version: 0, occ: new Map() };
  // Grow the sample community: each neighbour plot docks onto what is already there.
  for (const p of neighbours) {
    if (!w.plots.length) { p.docked = true; w.plots.push(p); rebuild(w); continue; }
    w.plots.push(p); p.docked = false;
    const slot = dockSlots(w, p)[0];
    if (slot) { shiftPlot(p, slot.dx, slot.dy); p.docked = true; }
    rebuild(w);
  }
  w.plots.unshift(myPlot);
  placeAdrift(w);
  return w;
}

/* ── plot geometry ── */
function cellsOf(p: Plot) {
  const cells: [number, number][] = [];
  for (const pl of p.friends) { const W = cellsW(pl.friend) * CELL, H = cellsH(pl.friend) * CELL; for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) cells.push([pl.x + i, pl.y + j]); }
  return cells;
}
export function plotBounds(p: Plot) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const pl of p.friends) { x0 = Math.min(x0, pl.x); y0 = Math.min(y0, pl.y); x1 = Math.max(x1, pl.x + cellsW(pl.friend) * CELL); y1 = Math.max(y1, pl.y + cellsH(pl.friend) * CELL); }
  return { x0, y0, x1, y1 };
}
export function communityBounds(w: World) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of w.plots) { if (!p.docked || !p.friends.length) continue; const b = plotBounds(p); x0 = Math.min(x0, b.x0); y0 = Math.min(y0, b.y0); x1 = Math.max(x1, b.x1); y1 = Math.max(y1, b.y1); }
  return { x0, y0, x1, y1 };
}
export function shiftPlot(p: Plot, dx: number, dy: number) { for (const pl of p.friends) { pl.x += dx; pl.y += dy; } }

/** Float my plot just off the community until I dock it. */
export function placeAdrift(w: World) {
  const me = mine(w), c = communityBounds(w);
  me.docked = false;
  if (!me.friends.length) return;
  const b = plotBounds(me);
  const cx = Number.isFinite(c.x0) ? snap((c.x0 + c.x1) / 2 - (b.x1 - b.x0) / 2) : 0;
  const cy = Number.isFinite(c.y1) ? c.y1 + 2 * CELL : 0;
  shiftPlot(me, cx - b.x0, cy - b.y0);
  rebuild(w);
}

/* ── docking ── */
export type Slot = { dx: number; dy: number; touches: Plot[]; seam: number };
function evaluate(w: World, p: Plot, dx: number, dy: number) {
  const touches = new Set<Plot>(); let seam = 0;
  for (const [x, y] of cellsOf(p)) {
    const o = w.occ.get(key(x + dx, y + dy));
    if (o && o.plot !== p) return null;
    for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const n = w.occ.get(key(x + dx + ox, y + dy + oy));
      if (n && n.plot !== p && n.plot.docked) { touches.add(n.plot); seam++; }
    }
  }
  return { touches: [...touches], seam };
}
/** Every spot where the plot docks flush against the community (slides in along each side of each docked plot). */
export function dockSlots(w: World, p: Plot): Slot[] {
  if (!p.friends.length) return [];
  const pb = plotBounds(p), pw = pb.x1 - pb.x0, ph = pb.y1 - pb.y0, out = new Map<string, Slot>();
  for (const q of w.plots) {
    if (q === p || !q.docked || !q.friends.length) continue;
    const qb = plotBounds(q);
    const tries: [number, number, number, number][] = [];
    for (let o = -ph + CELL; o < qb.y1 - qb.y0; o += CELL) { tries.push([qb.x1, qb.y0 + o, -CELL, 0]); tries.push([qb.x0 - pw, qb.y0 + o, CELL, 0]); }
    for (let o = -pw + CELL; o < qb.x1 - qb.x0; o += CELL) { tries.push([qb.x0 + o, qb.y1, 0, -CELL]); tries.push([qb.x0 + o, qb.y0 - ph, 0, CELL]); }
    for (let [tx, ty, sx, sy] of tries) {
      let dx = tx - pb.x0, dy = ty - pb.y0;
      let best = evaluate(w, p, dx, dy);
      if (!best) continue;
      for (let s = 0; s < 10 && best && best.seam === 0; s++) { const n = evaluate(w, p, dx + sx, dy + sy); if (!n) break; dx += sx; dy += sy; best = n; }
      if (!best || best.seam < CELL) continue;
      const k = key(dx, dy);
      if (!out.has(k)) out.set(k, { dx, dy, touches: best.touches, seam: best.seam });
    }
  }
  const sorted = [...out.values()].sort((a, b) => b.touches.length - a.touches.length || b.seam - a.seam);
  const picked: Slot[] = [];
  for (const s of sorted) {
    if (picked.some(q => Math.abs(q.dx - s.dx) < pw * 0.6 && Math.abs(q.dy - s.dy) < ph * 0.6)) continue;
    picked.push(s); if (picked.length >= 8) break;
  }
  return picked;
}
export function dock(w: World, slot: Slot) { const me = mine(w); shiftPlot(me, slot.dx, slot.dy); me.docked = true; rebuild(w); }
export function undock(w: World) { placeAdrift(w); }
export function neighboursOf(w: World, p: Plot) {
  const set = new Set<Plot>();
  if (!p.docked) return [];
  for (const [x, y] of cellsOf(p)) for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const n = w.occ.get(key(x + ox, y + oy)); if (n && n.plot !== p && n.plot.docked) set.add(n.plot);
  }
  return [...set];
}

/* ── arranging my own Friends (any layout, gaps allowed, no overlaps) ── */
export function canPlace(w: World, placed: Placed, x: number, y: number) {
  const W = cellsW(placed.friend) * CELL, H = cellsH(placed.friend) * CELL;
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const o = w.occ.get(key(x + i, y + j));
    if (o && o.placed !== placed) return false;
  }
  return true;
}
/** Move several of my Friends by the same step at once (the whole crew relocates together). */
export function moveGroup(w: World, group: Placed[], dx: number, dy: number) {
  const inGroup = new Set(group);
  for (const pl of group) {
    const W = cellsW(pl.friend) * CELL, H = cellsH(pl.friend) * CELL;
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
      const o = w.occ.get(key(pl.x + dx + i, pl.y + dy + j));
      if (o && !inGroup.has(o.placed)) return false;
    }
  }
  for (const pl of group) { pl.x += dx; pl.y += dy; }
  rebuild(w); return true;
}
export function moveFriend(w: World, placed: Placed, dx: number, dy: number) {
  if (!canPlace(w, placed, placed.x + dx, placed.y + dy)) return false;
  placed.x += dx; placed.y += dy; rebuild(w); return true;
}
/** Put a newly added Friend next to the rest of my plot (first free spot, spiralling out). */
export function addToPlot(w: World, friend: Friend) {
  const me = mine(w);
  const placed: Placed = { friend, x: 0, y: 0 };
  if (!me.friends.length) { me.friends.push(placed); placeAdrift(w); return placed; }
  const b = plotBounds(me);
  const candidates: [number, number][] = [];
  const fw = cellsW(friend) * CELL, fh = cellsH(friend) * CELL;
  for (let r = 0; r < 40; r += CELL) for (const [x, y] of [[b.x1 + r, b.y0], [b.x0, b.y1 + r], [b.x0 - fw - r, b.y0], [b.x0, b.y0 - fh - r], [b.x1 + r, b.y1 - fh]]) candidates.push([x, y]);
  me.friends.push(placed);
  for (const [x, y] of candidates) if (canPlace(w, placed, x, y)) { placed.x = x; placed.y = y; rebuild(w); return placed; }
  placed.x = b.x1 + 15 * CELL; placed.y = b.y0; rebuild(w); return placed;
}
export function removeFromPlot(w: World, tokenId: bigint) {
  const me = mine(w); me.friends = me.friends.filter(p => p.friend.tokenId !== tokenId); rebuild(w);
}
/** Swap in freshly read art/traits (e.g. after an upgrade). Returns false if the new footprint no longer fits. */
export function replaceFriend(w: World, fresh: Friend) {
  for (const p of w.plots) for (const pl of p.friends) if (pl.friend.tokenId === fresh.tokenId) {
    const old = pl.friend; pl.friend = fresh;
    if (!canPlace(w, pl, pl.x, pl.y)) { pl.friend = old; return false; }
    rebuild(w); return true;
  }
  return true;
}

/* ── walking & access ── */
export function tileAt(w: World, x: number, y: number) { return w.occ.get(key(Math.floor(x), Math.floor(y))); }
export function canEnter(w: World, p: Plot) { return p.mine || p.access === "open" || w.visits.get(p.id) === "approved"; }
export function plotAt(w: World, x: number, y: number) { return tileAt(w, x, y)?.plot ?? null; }

/* ── rank from the Rare Friends reward system ── */
export const RANKS = [
  { min: 0, name: "Speck" }, { min: 5, name: "Hamlet" }, { min: 50, name: "Village" },
  { min: 500, name: "Town" }, { min: 5000, name: "City" }, { min: 50000, name: "Capital" },
] as const;
export function plotWeight(p: Plot) { return p.friends.reduce((s, pl) => s + rewardWeight(pl.friend), 0); }
export function rankOf(p: Plot) {
  const wgt = plotWeight(p); let i = 0; RANKS.forEach((r, k) => { if (wgt >= r.min) i = k; });
  return { weight: wgt, rank: RANKS[i].name, index: i, next: RANKS[i + 1] ? RANKS[i + 1].min - wgt : 0 };
}
