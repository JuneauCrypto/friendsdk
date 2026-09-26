/* The Docks — pure logic, no rendering. Built to scale from 1 to 10,000+ Friends per plot.
 *
 * - Everything lives on the on-chain grid (DocksPlots): 4 × 4-tile cells. A Friend covers
 *   whole cells at true size by generation, so layout needs no artwork; art loads lazily.
 * - A plot is one holder's Friends. Its Friends must form one connected shape: each touches
 *   another along at least part of a side. Holes are fine.
 * - Plots dock edge to edge; the seam where two plots touch is the walkway between them.
 *   Crossing into someone else's plot needs their approval unless they keep it open. */
import { REWARD_WEIGHT, type Friend } from "./land.js";

export const CELL = 4;                                             // tiles per cell side
/** Footprint in cells by generation: lands are 30, 20, 18×16, 12, 8 and 4 tiles across. */
export const FOOTPRINT: Readonly<Record<number, readonly [number, number]>> = { 1: [8, 8], 2: [5, 5], 3: [5, 4], 4: [3, 3], 5: [2, 2], 6: [1, 1] };

/** RF burned per Friend moved when an arrangement is saved on chain (DocksPlots.FEE_GEN1…6). */
export const ARRANGE_FEE: Readonly<Record<number, number>> = { 1: 100, 2: 50, 3: 20, 4: 10, 5: 5, 6: 1 };
export const feeOf = (m: { gen: number }) => ARRANGE_FEE[m.gen] ?? 1;
/** Friends whose spot differs from the last saved (on-chain) arrangement, and the RF that saving burns. */
export function pendingChanges(p: Plot, saved: ReadonlyMap<bigint, { x: number; y: number }>) {
  let rf = 0; const moved: Placed[] = [];
  for (const pl of p.friends) { const s = saved.get(pl.m.id); if (!s || s.x !== pl.x || s.y !== pl.y) { moved.push(pl); rf += feeOf(pl.m); } }
  const gone = [...saved.keys()].filter(id => !p.friends.some(pl => pl.m.id === id));
  return { moved, rf, gone };
}

export type Member = {
  id: bigint; gen: number; tier: number; cw: number; ch: number;
  friend: Friend | null;                                           // on-chain art + walk mask, loaded when near the camera
};
export const member = (id: bigint, gen: number, tier: number, friend: Friend | null = null): Member => {
  const [cw, ch] = FOOTPRINT[gen] ?? [1, 1];
  return { id, gen, tier, cw, ch, friend };
};
export const memberOf = (f: Friend) => member(f.tokenId, Number(f.traits.Generation), Number(f.traits["Activation tier"] ?? 0), f);

export type Access = "open" | "invite";
export type Placed = { m: Member; x: number; y: number };        // cell position of the footprint's corner
export type Plot = {
  id: string; name: string; mine: boolean; access: Access;
  friends: Placed[]; docked: boolean;
  policy?: "approve" | "decline";                                  // sample neighbours' simulated answer
};
export type Visit = "none" | "pending" | "approved" | "declined";
export type World = {
  plots: Plot[]; visits: Map<string, Visit>; version: number;
  occ: Map<number, { plot: Plot; placed: Placed }>;                // cell → occupant
};

// Numeric cell keys (fast for large plots). Coordinates stay well inside ±2^20.
const K = 1 << 21, H = 1 << 20;
export const ck = (x: number, y: number) => (x + H) * K + (y + H);
export const mine = (w: World) => w.plots.find(p => p.mine)!;

function occupy(w: World, plot: Plot, pl: Placed) {
  for (let j = 0; j < pl.m.ch; j++) for (let i = 0; i < pl.m.cw; i++) w.occ.set(ck(pl.x + i, pl.y + j), { plot, placed: pl });
}
function vacate(w: World, pl: Placed) {
  for (let j = 0; j < pl.m.ch; j++) for (let i = 0; i < pl.m.cw; i++) {
    const k = ck(pl.x + i, pl.y + j); if (w.occ.get(k)?.placed === pl) w.occ.delete(k);
  }
}
export function rebuild(w: World) {
  w.occ = new Map();
  for (const plot of w.plots) for (const pl of plot.friends) occupy(w, plot, pl);
  w.version++;
}

export function createWorld(neighbours: Plot[], myPlot: Plot): World {
  const w: World = { plots: [], visits: new Map(), version: 0, occ: new Map() };
  for (const p of neighbours) {                                    // grow the sample community plot by plot
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

/* ── auto-arrange: one connected block, biggest Friends first ──
 * Shelf packing: rows of Friends flush side by side; each row starts with its tallest Friend
 * and sits flush under the previous row, so every Friend touches another along a side. */
export function autoArrange(members: Member[]): Placed[] {
  const list = [...members].sort((a, b) => b.cw * b.ch - a.cw * a.ch || b.ch - a.ch || (a.id < b.id ? -1 : 1));
  const area = list.reduce((s, m) => s + m.cw * m.ch, 0);
  const width = Math.max(list[0]?.cw ?? 1, Math.ceil(Math.sqrt(area) * 1.15));
  const out: Placed[] = [];
  let x = 0, y = 0, rowH = 0;
  for (const m of list) {
    if (x > 0 && x + m.cw > width) { x = 0; y += rowH; rowH = 0; }
    out.push({ m, x, y }); x += m.cw; rowH = Math.max(rowH, m.ch);
  }
  return out;
}

/** Friends not connected to the first one (each must touch another along part of a side). */
export function disconnected(w: World, p: Plot): Placed[] {
  if (p.friends.length < 2) return [];
  const seen = new Set<Placed>([p.friends[0]]), queue = [p.friends[0]];
  while (queue.length) {
    const pl = queue.pop()!;
    for (const [nx, ny] of edgeCells(pl)) {
      const o = w.occ.get(ck(nx, ny));
      if (o && o.plot === p && !seen.has(o.placed)) { seen.add(o.placed); queue.push(o.placed); }
    }
  }
  return p.friends.filter(pl => !seen.has(pl));
}
/** Cells just outside a Friend's footprint, along its four sides. */
function* edgeCells(pl: Placed): Generator<[number, number]> {
  for (let i = 0; i < pl.m.cw; i++) { yield [pl.x + i, pl.y - 1]; yield [pl.x + i, pl.y + pl.m.ch]; }
  for (let j = 0; j < pl.m.ch; j++) { yield [pl.x - 1, pl.y + j]; yield [pl.x + pl.m.cw, pl.y + j]; }
}

/* ── plot geometry ── */
export function plotBounds(p: Plot) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const pl of p.friends) { x0 = Math.min(x0, pl.x); y0 = Math.min(y0, pl.y); x1 = Math.max(x1, pl.x + pl.m.cw); y1 = Math.max(y1, pl.y + pl.m.ch); }
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
  const me = mine(w), others = { ...w, plots: w.plots.filter(p => p !== me) }, c = communityBounds(others);
  me.docked = false;
  if (!me.friends.length) { rebuild(w); return; }
  const b = plotBounds(me);
  const cx = Number.isFinite(c.x0) ? Math.round((c.x0 + c.x1) / 2 - (b.x1 - b.x0) / 2) : 0;
  const cy = Number.isFinite(c.y1) ? c.y1 + 3 : 0;
  shiftPlot(me, cx - b.x0, cy - b.y0);
  rebuild(w);
}

/* ── docking ── */
export type Slot = { dx: number; dy: number; touches: Plot[]; seam: number };
/** Cells of a plot, boundary cells first (overlaps are nearly always found there). */
function cellsOf(p: Plot) {
  const own = new Set<number>(), edge: [number, number][] = [], inner: [number, number][] = [];
  for (const pl of p.friends) for (let j = 0; j < pl.m.ch; j++) for (let i = 0; i < pl.m.cw; i++) own.add(ck(pl.x + i, pl.y + j));
  for (const pl of p.friends) for (let j = 0; j < pl.m.ch; j++) for (let i = 0; i < pl.m.cw; i++) {
    const x = pl.x + i, y = pl.y + j;
    const inside = [[1, 0], [-1, 0], [0, 1], [0, -1]].every(([ox, oy]) => own.has(ck(x + ox, y + oy)));
    (inside ? inner : edge).push([x, y]);
  }
  return { edge, all: [...edge, ...inner] };
}
function evaluate(w: World, p: Plot, cells: ReturnType<typeof cellsOf>, dx: number, dy: number) {
  // only docked plots (and never p itself) can block a spot; adrift plots float elsewhere
  for (const [x, y] of cells.all) { const o = w.occ.get(ck(x + dx, y + dy)); if (o && o.plot !== p && o.plot.docked) return null; }
  const touches = new Set<Plot>(); let seam = 0;
  for (const [x, y] of cells.edge) for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const n = w.occ.get(ck(x + dx + ox, y + dy + oy));
    if (n && n.plot !== p && n.plot.docked) { touches.add(n.plot); seam++; }
  }
  return { touches: [...touches], seam };
}
/** Spots where the plot docks flush against the community (slides in along each side of each docked plot). */
export function dockSlots(w: World, p: Plot): Slot[] {
  if (!p.friends.length) return [];
  const cells = cellsOf(p);
  const pb = plotBounds(p), pw = pb.x1 - pb.x0, ph = pb.y1 - pb.y0, out = new Map<number, Slot>();
  for (const q of w.plots) {
    if (q === p || !q.docked || !q.friends.length) continue;
    const qb = plotBounds(q), qw = qb.x1 - qb.x0, qh = qb.y1 - qb.y0;
    const stepY = Math.max(1, Math.round((ph + qh) / 16)), stepX = Math.max(1, Math.round((pw + qw) / 16));
    const tries: [number, number, number, number][] = [];
    for (let o = -ph + 1; o < qh; o += stepY) { tries.push([qb.x1, qb.y0 + o, -1, 0]); tries.push([qb.x0 - pw, qb.y0 + o, 1, 0]); }
    for (let o = -pw + 1; o < qw; o += stepX) { tries.push([qb.x0 + o, qb.y1, 0, -1]); tries.push([qb.x0 + o, qb.y0 - ph, 0, 1]); }
    for (const [tx, ty, sx, sy] of tries) {
      let dx = tx - pb.x0, dy = ty - pb.y0;
      let best = evaluate(w, p, cells, dx, dy);
      if (!best) continue;
      for (let s = 0; s < 12 && best && best.seam === 0; s++) { const n = evaluate(w, p, cells, dx + sx, dy + sy); if (!n) break; dx += sx; dy += sy; best = n; }
      if (!best || best.seam < 1) continue;
      const k = ck(dx, dy);
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
  for (const pl of p.friends) for (const [x, y] of edgeCells(pl)) {
    const n = w.occ.get(ck(x, y)); if (n && n.plot !== p && n.plot.docked) set.add(n.plot);
  }
  return [...set];
}
/** Whether a Friend touches any Friend of `host` along a side (the on-chain `adjacent`). */
export function touchesPlot(w: World, pl: Placed, host: Plot) {
  for (const [x, y] of edgeCells(pl)) if (w.occ.get(ck(x, y))?.plot === host) return true;
  return false;
}

/* ── arranging my own Friends (any shape, connected, no overlaps) ── */
export function moveGroup(w: World, group: Placed[], dx: number, dy: number) {
  if (!group.length) return false;
  const inGroup = new Set(group);
  for (const pl of group) for (let j = 0; j < pl.m.ch; j++) for (let i = 0; i < pl.m.cw; i++) {
    const o = w.occ.get(ck(pl.x + dx + i, pl.y + dy + j));
    if (o && !inGroup.has(o.placed)) return false;
  }
  const plot = w.occ.get(ck(group[0].x, group[0].y))?.plot;
  for (const pl of group) vacate(w, pl);
  for (const pl of group) { pl.x += dx; pl.y += dy; if (plot) occupy(w, plot, pl); }
  w.version++; return true;
}
export const moveFriend = (w: World, pl: Placed, dx: number, dy: number) => moveGroup(w, [pl], dx, dy);
/** In a packed plot: stepping onto a same-size Friend of the same plot swaps the two. */
export function swapInto(w: World, pl: Placed, dx: number, dy: number) {
  const o = w.occ.get(ck(pl.x + dx, pl.y + dy));
  if (!o || o.placed === pl) return false;
  const other = o.placed;
  if (other.x !== pl.x + dx || other.y !== pl.y + dy || other.m.cw !== pl.m.cw || other.m.ch !== pl.m.ch) return false;
  if (w.occ.get(ck(pl.x, pl.y))?.plot !== o.plot) return false;
  [other.x, other.y, pl.x, pl.y] = [pl.x, pl.y, other.x, other.y];
  occupy(w, o.plot, pl); occupy(w, o.plot, other); w.version++;
  return true;
}
export function removeFromPlot(w: World, id: bigint) { const me = mine(w); me.friends = me.friends.filter(p => p.m.id !== id); rebuild(w); }
/** Attach a Friend flush against my plot (first free spot touching it). */
export function addToPlot(w: World, m: Member) {
  const me = mine(w), placed: Placed = { m, x: 0, y: 0 };
  if (!me.friends.length) { me.friends.push(placed); placeAdrift(w); return placed; }
  const b = plotBounds(me);
  me.friends.push(placed);
  for (let r = 0; r < 256; r++) for (const [x, y] of [[b.x1, b.y0 + r], [b.x0 + r, b.y1], [b.x0 - m.cw, b.y0 + r], [b.x0 + r, b.y0 - m.ch]]) {
    placed.x = x; placed.y = y;
    let free = true;
    for (let j = 0; j < m.ch && free; j++) for (let i = 0; i < m.cw; i++) if (w.occ.has(ck(x + i, y + j))) { free = false; break; }
    if (free && touchesPlot(w, placed, me)) { occupy(w, me, placed); w.version++; return placed; }
  }
  placed.x = b.x1; placed.y = b.y0; rebuild(w); return placed;
}
/** Fresh art/traits after an on-chain check. Returns false if the footprint changed and it must be re-placed. */
export function refreshMember(w: World, fresh: Friend) {
  for (const p of w.plots) for (const pl of p.friends) if (pl.m.id === fresh.tokenId) {
    pl.m.friend = fresh; pl.m.tier = Number(fresh.traits["Activation tier"] ?? 0);
    if (Number(fresh.traits.Generation) !== pl.m.gen) return false;
    w.version++; return true;
  }
  return true;
}

/* ── walking & access ── */
export type TileInfo = { plot: Plot; placed: Placed; blocked: boolean; pier: boolean };
export function tileAt(w: World, x: number, y: number): TileInfo | undefined {
  const tx = Math.floor(x), ty = Math.floor(y);
  const o = w.occ.get(ck(Math.floor(tx / CELL), Math.floor(ty / CELL)));
  if (!o) return undefined;
  const f = o.placed.m.friend, i = tx - o.placed.x * CELL, j = ty - o.placed.y * CELL;
  if (!f) return { ...o, blocked: false, pier: false };           // art not loaded yet: walkable ground
  const land = i < f.w && j < f.h && f.tiles[j * f.w + i];
  return { ...o, blocked: land ? f.blocked[j * f.w + i] : false, pier: !land };
}
export function canEnter(w: World, p: Plot) { return p.mine || p.access === "open" || w.visits.get(p.id) === "approved"; }

/* ── rank from the Rare Friends reward system ── */
export const RANKS = [
  { min: 0, name: "Speck" }, { min: 5, name: "Hamlet" }, { min: 50, name: "Village" },
  { min: 500, name: "Town" }, { min: 5000, name: "City" }, { min: 50000, name: "Capital" },
] as const;
export const weightOf = (m: Member) => REWARD_WEIGHT[m.gen]?.[Math.max(0, Math.min(4, m.tier))] ?? 0;
export function plotWeight(p: Plot) { let s = 0; for (const pl of p.friends) s += weightOf(pl.m); return s; }
export function rankOf(p: Plot) {
  const wgt = plotWeight(p); let i = 0; RANKS.forEach((r, k) => { if (wgt >= r.min) i = k; });
  return { weight: wgt, rank: RANKS[i].name, index: i, next: RANKS[i + 1] ? RANKS[i + 1].min - wgt : 0 };
}
