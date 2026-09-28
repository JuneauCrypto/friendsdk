/* The Docks — pure logic, no rendering. Floating islands made of activated Friends.
 *
 * - Every Friend is a small floating island. An island is made of Friends joined together,
 *   laid out on its own grid of 4 × 4-tile cells (true size by generation). Each Friend must
 *   touch another along part of a side. A holder can deploy their Friends across several
 *   islands. Islands are not tokens: the only NFTs are the activated Friends (DocksIslands).
 * - If a saved Friend leaves the wallet (or is deactivated), its spot becomes a hole: reserved
 *   until the Friend returns, or filled with another activated Friend of the same size.
 * - Islands float on one shared berth grid: one island per berth, whatever its size, so the
 *   world grows with the number of plots, not their size. An island docks at a free berth
 *   next to another island (a loading zone). Neighbouring islands are joined by a gangway.
 * - Bridges (paid in RF, per berth of distance) join islands that aren't neighbours.
 * - Crossing onto someone else's island needs their approval unless they keep it open.
 * Built to scale to 10,000+ Friends per island: layout needs no artwork (footprints come from
 * generation) and occupancy is per cell. */
import { REWARD_WEIGHT, type Friend } from "./land.js";

export const CELL = 4;                                             // tiles per cell side
export const GAP = 6;                                              // tiles of water between neighbouring berths
const MIN_BERTH = 12;                                              // tiles: the smallest berth drawn
/** Footprint in cells by generation: lands are 30, 20, 18×16, 12, 8 and 4 tiles across. */
export const FOOTPRINT: Readonly<Record<number, readonly [number, number]>> = { 1: [8, 8], 2: [5, 5], 3: [5, 4], 4: [3, 3], 5: [2, 2], 6: [1, 1] };
/** RF burned per Friend moved on its island when saved on chain (DocksPlots.FEE_GEN1…6). */
export const ARRANGE_FEE: Readonly<Record<number, number>> = { 1: 100, 2: 50, 3: 20, 4: 10, 5: 5, 6: 1 };
export const feeOf = (m: { gen: number }) => ARRANGE_FEE[m.gen] ?? 1;
/** RF burned per berth of distance a bridge spans (DocksPlots.BRIDGE_FEE_PER_BERTH). */
export const BRIDGE_FEE_PER_BERTH = 10;

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
export type Placed = { m: Member; x: number; y: number };        // cell position on its island's own grid
export type Berth = { x: number; y: number };
/** A spot left by a saved Friend that left the wallet or was deactivated. */
export type Hole = { id: bigint; gen: number; cw: number; ch: number; x: number; y: number };
export type Plot = {
  id: string; name: string; mine: boolean; access: Access;
  friends: Placed[];
  holes?: Hole[];
  berth: Berth | null;                                             // null: floating free, not docked
  policy?: "approve" | "decline";                                  // sample neighbours' simulated answer
};
export type Bridge = { a: Plot; b: Plot; at: [Berth, Berth] };   // breaks if either island moves
export type Visit = "none" | "pending" | "approved" | "declined";
export type Box = { x0: number; y0: number; x1: number; y1: number };
export type World = {
  plots: Plot[]; visits: Map<string, Visit>; version: number; bridges: Bridge[];
  occ: Map<Plot, Map<number, Placed>>;                             // island cell → Friend
  holeOcc: Map<Plot, Map<number, Hole>>;                           // island cell → hole
  berths: Map<number, Plot>;
  origin: Map<Plot, { x: number; y: number }>;                     // world tile of the island's cell (0, 0)
  box: Map<Plot, Box>;                                             // island bounds, world tiles
  cols: { b: number; x0: number; x1: number }[]; rows: { b: number; y0: number; y1: number }[];
  walk: Map<number, "gangway" | "bridge">;                         // walkway tiles over the water
  villages: Village[];
};
/** A flag planted on an island starts a village; other islands choose to join while connected
 *  to it (docked next to, or bridged to, a member). Mirrors contracts/src/docks/DocksVillages.sol. */
export type Village = { id: string; name: string; founder: Plot; flag: { x: number; y: number }; members: Plot[]; color: string };

// Numeric keys (fast for large islands). Coordinates stay well inside ±2^20.
const K = 1 << 21, HALF = 1 << 20;
export const ck = (x: number, y: number) => (x + HALF) * K + (y + HALF);
const T = (c: number) => c * CELL;
export const myPlots = (w: World) => w.plots.filter(p => p.mine);
export const plotOf = (w: World, id: bigint) => w.plots.find(p => p.friends.some(pl => pl.m.id === id)) ?? null;

/* ── building the world ── */

export function emptyWorld(): World {
  return { plots: [], visits: new Map(), version: 0, bridges: [], occ: new Map(), holeOcc: new Map(), berths: new Map(), origin: new Map(), box: new Map(), cols: [], rows: [], walk: new Map(), villages: [] };
}

export function rebuild(w: World) {
  w.occ = new Map(); w.holeOcc = new Map(); w.berths = new Map();
  for (const p of w.plots) {
    const m = new Map<number, Placed>(), hm = new Map<number, Hole>();
    for (const pl of p.friends) for (let j = 0; j < pl.m.ch; j++) for (let i = 0; i < pl.m.cw; i++) m.set(ck(pl.x + i, pl.y + j), pl);
    for (const h of p.holes ?? []) for (let j = 0; j < h.ch; j++) for (let i = 0; i < h.cw; i++) hm.set(ck(h.x + i, h.y + j), h);
    w.occ.set(p, m); w.holeOcc.set(p, hm);
    const hasShape = p.friends.length > 0 || (p.holes?.length ?? 0) > 0;
    if (p.berth && hasShape) w.berths.set(ck(p.berth.x, p.berth.y), p);
    else if (p.berth) p.berth = null;
  }
  w.bridges = w.bridges.filter(b => b.a.berth && b.b.berth && same(b.a.berth, b.at[0]) && same(b.b.berth, b.at[1]));
  layout(w);
  w.version++;
}
const same = (a: Berth, b: Berth) => a.x === b.x && a.y === b.y;

/** Berths become a table: each column as wide as its widest island, each row as tall as its
 *  tallest, with water between. Islands sit centred in their berth. */
function layout(w: World) {
  const docked = w.plots.filter(p => p.berth && (p.friends.length || p.holes?.length));
  const colW = new Map<number, number>(), rowH = new Map<number, number>();
  for (const p of docked) {
    const b = plotBounds(p), bx = p.berth!.x, by = p.berth!.y;
    colW.set(bx, Math.max(colW.get(bx) ?? MIN_BERTH, T(b.x1 - b.x0)));
    rowH.set(by, Math.max(rowH.get(by) ?? MIN_BERTH, T(b.y1 - b.y0)));
  }
  const span = (m: Map<number, number>) => { const k = [...m.keys()]; return k.length ? [Math.min(...k), Math.max(...k)] : [0, -1]; };
  const [cx0, cx1] = span(colW), [ry0, ry1] = span(rowH);
  w.cols = []; w.rows = [];
  for (let b = cx0, x = 0; b <= cx1; b++) { const wd = colW.get(b) ?? MIN_BERTH; w.cols.push({ b, x0: x, x1: x + wd }); x += wd + GAP; }
  for (let b = ry0, y = 0; b <= ry1; b++) { const ht = rowH.get(b) ?? MIN_BERTH; w.rows.push({ b, y0: y, y1: y + ht }); y += ht + GAP; }
  w.origin = new Map(); w.box = new Map();
  const place = (p: Plot, left: number, top: number, width: number, height: number) => {
    const b = plotBounds(p), wT = T(b.x1 - b.x0), hT = T(b.y1 - b.y0);
    const ox = left + Math.floor((width - wT) / 2) - T(b.x0), oy = top + Math.floor((height - hT) / 2) - T(b.y0);
    w.origin.set(p, { x: ox, y: oy });
    w.box.set(p, { x0: ox + T(b.x0), y0: oy + T(b.y0), x1: ox + T(b.x1), y1: oy + T(b.y1) });
  };
  for (const p of docked) {
    const c = w.cols.find(c => c.b === p.berth!.x)!, r = w.rows.find(r => r.b === p.berth!.y)!;
    place(p, c.x0, r.y0, c.x1 - c.x0, r.y1 - r.y0);
  }
  // islands floating free (mine, not docked yet) drift just below the docks
  let fx = 0; const fy = (w.rows.at(-1)?.y1 ?? 0) + GAP * 2;
  for (const p of w.plots) if (!p.berth && (p.friends.length || p.holes?.length)) {
    const b = plotBounds(p), wT = T(b.x1 - b.x0), hT = T(b.y1 - b.y0);
    place(p, fx, fy, wT, hT); fx += wT + GAP * 2;
  }
  // walkways: gangways between neighbouring berths, bridges wherever built
  w.walk = new Map();
  const centre = (p: Plot) => { const b = w.box.get(p)!; return { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 }; };
  for (const p of docked) for (const [dx, dy] of [[1, 0], [0, 1]]) {
    const q = w.berths.get(ck(p.berth!.x + dx, p.berth!.y + dy)); if (!q) continue;
    const a = centre(p), b = centre(q);
    if (dx) { const y = Math.floor(w.rows.find(r => r.b === p.berth!.y)!.y0 + (w.rows.find(r => r.b === p.berth!.y)!.y1 - w.rows.find(r => r.b === p.berth!.y)!.y0) / 2);
      for (let x = Math.floor(a.x); x <= Math.ceil(b.x); x++) for (const yy of [y - 1, y]) w.walk.set(ck(x, yy), "gangway"); }
    else { const col = w.cols.find(c => c.b === p.berth!.x)!, x = Math.floor(col.x0 + (col.x1 - col.x0) / 2);
      for (let y = Math.floor(a.y); y <= Math.ceil(b.y); y++) for (const xx of [x - 1, x]) w.walk.set(ck(xx, y), "gangway"); }
  }
  for (const br of w.bridges) {
    const a = centre(br.a), b = centre(br.b), len = Math.hypot(b.x - a.x, b.y - a.y);
    for (let t = 0; t <= len; t += 0.5) {
      const x = a.x + (b.x - a.x) * t / len, y = a.y + (b.y - a.y) * t / len;
      for (const [ox, oy] of [[-0.7, -0.7], [0.7, -0.7], [-0.7, 0.7], [0.7, 0.7]]) {
        const k = ck(Math.floor(x + ox), Math.floor(y + oy)); if (!w.walk.has(k)) w.walk.set(k, "bridge");
      }
    }
  }
}

/** Sample neighbours float at their berths; my islands start floating free until docked. */
export function createWorld(neighbours: Plot[], mineToo: Plot[]): World {
  const w = emptyWorld();
  w.plots = [...mineToo, ...neighbours];
  rebuild(w);
  return w;
}

/* ── an island's own grid ── */

/** One connected block, biggest Friends first: rows flush side by side, each row flush under
 *  the one before and starting with its tallest Friend, so every Friend touches another. */
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
function* edgeCells(pl: Placed): Generator<[number, number]> {
  for (let i = 0; i < pl.m.cw; i++) { yield [pl.x + i, pl.y - 1]; yield [pl.x + i, pl.y + pl.m.ch]; }
  for (let j = 0; j < pl.m.ch; j++) { yield [pl.x - 1, pl.y + j]; yield [pl.x + pl.m.cw, pl.y + j]; }
}
/** Friends not joined to the first one (each must touch another along part of a side). */
export function disconnected(w: World, p: Plot): Placed[] {
  if (p.friends.length + (p.holes?.length ?? 0) < 2 || !p.friends.length) return [];
  const occ = w.occ.get(p)!, hocc = w.holeOcc.get(p)!;
  const asPlaced = (h: Hole): Placed => ({ m: { id: h.id, gen: h.gen, tier: 0, cw: h.cw, ch: h.ch, friend: null }, x: h.x, y: h.y });
  const holeNode = new Map((p.holes ?? []).map(h => [h, asPlaced(h)]));
  const seen = new Set<Placed>([p.friends[0]]), queue = [p.friends[0]];
  while (queue.length) {                               // holes still belong to the island's shape
    const pl = queue.pop()!;
    for (const [nx, ny] of edgeCells(pl)) {
      const k = ck(nx, ny), o = occ.get(k) ?? (hocc.get(k) && holeNode.get(hocc.get(k)!));
      if (o && !seen.has(o)) { seen.add(o); queue.push(o); }
    }
  }
  return p.friends.filter(pl => !seen.has(pl));
}
export function plotBounds(p: Plot): Box {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const rects = [...p.friends.map(pl => ({ x: pl.x, y: pl.y, w: pl.m.cw, h: pl.m.ch })), ...(p.holes ?? []).map(h => ({ x: h.x, y: h.y, w: h.cw, h: h.ch }))];
  for (const r of rects) { x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y); x1 = Math.max(x1, r.x + r.w); y1 = Math.max(y1, r.y + r.h); }
  return rects.length ? { x0, y0, x1, y1 } : { x0: 0, y0: 0, x1: 1, y1: 1 };
}
const blocked = (w: World, p: Plot, x: number, y: number) => w.holeOcc.get(p)?.has(ck(x, y)) ?? false;
export function moveGroup(w: World, p: Plot, group: Placed[], dx: number, dy: number) {
  if (!group.length) return false;
  const occ = w.occ.get(p)!, inGroup = new Set(group);
  for (const pl of group) for (let j = 0; j < pl.m.ch; j++) for (let i = 0; i < pl.m.cw; i++) {
    const o = occ.get(ck(pl.x + dx + i, pl.y + dy + j)); if ((o && !inGroup.has(o)) || blocked(w, p, pl.x + dx + i, pl.y + dy + j)) return false;
  }
  for (const pl of group) { pl.x += dx; pl.y += dy; }
  rebuild(w); return true;
}
/** In a packed island: stepping onto a same-size Friend swaps the two. */
export function swapInto(w: World, p: Plot, pl: Placed, dx: number, dy: number) {
  const other = w.occ.get(p)!.get(ck(pl.x + dx, pl.y + dy));
  if (!other || other === pl || other.x !== pl.x + dx || other.y !== pl.y + dy || other.m.cw !== pl.m.cw || other.m.ch !== pl.m.ch) return false;
  [other.x, other.y, pl.x, pl.y] = [pl.x, pl.y, other.x, other.y];
  rebuild(w); return true;
}
/** Attach a Friend flush against an island (first free spot touching it). */
export function addToPlot(w: World, p: Plot, m: Member) {
  const placed: Placed = { m, x: 0, y: 0 };
  if (!p.friends.length && !p.holes?.length) { p.friends.push(placed); rebuild(w); return placed; }
  const occ = w.occ.get(p)!, b = plotBounds(p);
  for (let r = 0; r < 512; r++) for (const [x, y] of [[b.x1, b.y0 + r], [b.x0 + r, b.y1], [b.x0 - m.cw, b.y0 + r], [b.x0 + r, b.y0 - m.ch]]) {
    let free = true;
    for (let j = 0; j < m.ch && free; j++) for (let i = 0; i < m.cw; i++) if (occ.has(ck(x + i, y + j)) || blocked(w, p, x + i, y + j)) { free = false; break; }
    if (!free) continue;
    placed.x = x; placed.y = y;
    for (const [nx, ny] of edgeCells(placed)) if (occ.has(ck(nx, ny)) || blocked(w, p, nx, ny)) { p.friends.push(placed); rebuild(w); return placed; }
  }
  placed.x = b.x1; placed.y = b.y0; p.friends.push(placed); rebuild(w); return placed;
}
export function removeFromPlot(w: World, id: bigint) {
  for (const p of w.plots) if (p.friends.some(pl => pl.m.id === id)) p.friends = p.friends.filter(pl => pl.m.id !== id);
  rebuild(w);
}
/** Deploy one of my Friends to another of my islands. */
export function deploy(w: World, id: bigint, to: Plot) {
  const from = plotOf(w, id), pl = from?.friends.find(x => x.m.id === id);
  if (!from || !pl || from === to) return false;
  from.friends = from.friends.filter(x => x !== pl); rebuild(w);
  addToPlot(w, to, pl.m); return true;
}
/** A saved Friend left the wallet (or was deactivated): its spot on the island becomes a hole. */
export function burnHole(w: World, id: bigint) {
  const p = plotOf(w, id), pl = p?.friends.find(x => x.m.id === id);
  if (!p || !pl) return null;
  p.friends = p.friends.filter(x => x !== pl);
  const h: Hole = { id, gen: pl.m.gen, cw: pl.m.cw, ch: pl.m.ch, x: pl.x, y: pl.y };
  (p.holes ??= []).push(h); rebuild(w); return { plot: p, hole: h };
}
export const holesOf = (w: World) => w.plots.flatMap(p => (p.holes ?? []).map(h => ({ plot: p, hole: h })));
/** Fill a hole with a Friend of the same size (the Friend that left, back again, or another). */
export function fillHole(w: World, p: Plot, h: Hole, m: Member) {
  if (m.gen !== h.gen) return false;
  for (const q of w.plots) q.friends = q.friends.filter(x => x.m.id !== m.id);
  p.holes = (p.holes ?? []).filter(x => x !== h);
  p.friends.push({ m, x: h.x, y: h.y }); rebuild(w); return true;
}

/** Fresh art/traits after an on-chain check. Returns false if the generation (footprint) changed. */
export function refreshMember(w: World, fresh: Friend) {
  for (const p of w.plots) for (const pl of p.friends) if (pl.m.id === fresh.tokenId) {
    pl.m.friend = fresh; pl.m.tier = Number(fresh.traits["Activation tier"] ?? 0);
    if (Number(fresh.traits.Generation) !== pl.m.gen) return false;
    w.version++; return true;
  }
  return true;
}

/* ── docking (gas only) and bridges (RF) ── */

const around = (b: Berth) => [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dy]) => ({ x: b.x + dx, y: b.y + dy }));
/** Free berths next to a docked island, where `p` can dock. The first island docks anywhere. */
export function loadingZones(w: World, p: Plot): Berth[] {
  const out = new Map<number, Berth>();
  for (const q of w.plots) if (q !== p && q.berth && q.friends.length)
    for (const b of around(q.berth)) { const o = w.berths.get(ck(b.x, b.y)); if (!o || o === p) out.set(ck(b.x, b.y), b); }
  if (!out.size && ![...w.berths.values()].some(q => q !== p)) out.set(ck(0, 0), { x: 0, y: 0 });
  return [...out.values()];
}
export function dockAt(w: World, p: Plot, b: Berth) {
  const o = w.berths.get(ck(b.x, b.y));
  if (o && o !== p) return false;
  if (!loadingZones(w, p).some(z => same(z, b))) return false;
  p.berth = { ...b }; rebuild(w); return true;
}
export function undock(w: World, p: Plot) { p.berth = null; rebuild(w); }
const dist = (a: Berth, b: Berth) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
export const hasBridge = (w: World, a: Plot, b: Plot) => w.bridges.some(x => (x.a === a && x.b === b) || (x.a === b && x.b === a));
export function connected(w: World, a: Plot, b: Plot) {
  if (!a.berth || !b.berth || a === b) return false;
  return dist(a.berth, b.berth) === 1 || hasBridge(w, a, b);
}
export function neighboursOf(w: World, p: Plot) { return w.plots.filter(q => q.friends.length && connected(w, p, q)); }
export function bridgeCost(a: Plot, b: Plot) { return a.berth && b.berth ? dist(a.berth, b.berth) * BRIDGE_FEE_PER_BERTH : 0; }
export function addBridge(w: World, a: Plot, b: Plot) {
  if (!a.berth || !b.berth || connected(w, a, b)) return false;
  w.bridges.push({ a, b, at: [{ ...a.berth }, { ...b.berth }] }); rebuild(w); return true;
}

/* ── villages ── */

const FLAG_COLORS = ["#ff4d6d", "#4dabf7", "#ffd43b", "#69db7c", "#b197fc", "#ff922b"];
export const villageOf = (w: World, p: Plot) => w.villages.find(v => v.members.includes(p)) ?? null;
/** Why `p` can't plant a flag (null: it can). `at` is an island-local tile the flag stands on. */
export function flagProblem(w: World, p: Plot, at: { x: number; y: number }): string | null {
  if (!p.berth) return `Dock ${p.name} first: flags go on docked islands.`;
  const v = villageOf(w, p); if (v) return `${p.name} is already in ${v.name}.`;
  const cx = Math.floor(at.x / CELL), cy = Math.floor(at.y / CELL);
  if (!w.occ.get(p)?.has(ck(cx, cy))) return "Stand on your island's land to plant the flag.";
  return null;
}
export function plantFlag(w: World, p: Plot, name: string, at: { x: number; y: number }): Village {
  const why = flagProblem(w, p, at); if (why) throw new Error(why);
  const clean = name.trim().slice(0, 32); if (!clean) throw new Error("Name your village.");
  const v: Village = { id: `v${w.villages.length + 1}-${p.id}`, name: clean, founder: p, flag: { ...at }, members: [p], color: FLAG_COLORS[w.villages.length % FLAG_COLORS.length] };
  w.villages.push(v); w.version++; return v;
}
/** An island can join while it's docked and connected to any island already in the village. */
export function joinProblem(w: World, v: Village, p: Plot): string | null {
  if (!p.berth) return `Dock ${p.name} first.`;
  const cur = villageOf(w, p); if (cur) return cur === v ? `${p.name} is in ${v.name}.` : `${p.name} is already in ${cur.name}.`;
  if (!v.members.some(m => connected(w, p, m))) return `Dock next to, or bridge to, an island in ${v.name} to join.`;
  return null;
}
export function joinVillage(w: World, v: Village, p: Plot) {
  const why = joinProblem(w, v, p); if (why) throw new Error(why);
  v.members.push(p); w.version++;
}
/** Leaving is free. When the founding island leaves, the flag comes down for everyone. */
export function leaveVillage(w: World, p: Plot) {
  const v = villageOf(w, p); if (!v) return null;
  if (v.founder === p) w.villages = w.villages.filter(x => x !== v); else v.members = v.members.filter(x => x !== p);
  w.version++; return v;
}
export function flagTile(w: World, v: Village) {
  const o = w.origin.get(v.founder); return o ? { x: o.x + v.flag.x, y: o.y + v.flag.y } : null;
}

/* ── walking & access (world tiles) ── */

export type TileInfo = { plot: Plot | null; placed: Placed | null; blocked: boolean; walkway?: "gangway" | "bridge" };
const find = <T extends { x0?: number; x1?: number; y0?: number; y1?: number }>(list: T[], v: number, lo: keyof T, hi: keyof T) => {
  let a = 0, b = list.length - 1;
  while (a <= b) { const m = (a + b) >> 1, it = list[m]; if (v < (it[lo] as number)) b = m - 1; else if (v >= (it[hi] as number)) a = m + 1; else return it; }
  return null;
};
function islandTile(w: World, p: Plot, x: number, y: number): TileInfo | null {
  const o = w.origin.get(p); if (!o) return null;
  const lx = x - o.x, ly = y - o.y, pl = w.occ.get(p)?.get(ck(Math.floor(lx / CELL), Math.floor(ly / CELL)));
  if (!pl) return null;
  const f = pl.m.friend, i = lx - T(pl.x), j = ly - T(pl.y);
  if (!f) return { plot: p, placed: pl, blocked: false };           // art not loaded yet: walkable ground
  const land = i < f.w && j < f.h && f.tiles[j * f.w + i];
  return { plot: p, placed: pl, blocked: land ? f.blocked[j * f.w + i] : false };
}
export function tileAt(w: World, x: number, y: number): TileInfo | undefined {
  const tx = Math.floor(x), ty = Math.floor(y);
  const c = find(w.cols, tx, "x0", "x1"), r = find(w.rows, ty, "y0", "y1");
  if (c && r) { const p = w.berths.get(ck(c.b, r.b)); const t = p && islandTile(w, p, tx, ty); if (t) return t; }
  for (const p of w.plots) if (!p.berth && p.friends.length) { const t = islandTile(w, p, tx, ty); if (t) return t; }
  const k = w.walk.get(ck(tx, ty));
  return k ? { plot: null, placed: null, blocked: false, walkway: k } : undefined;
}
export function canEnter(w: World, p: Plot) { return p.mine || p.access === "open" || w.visits.get(p.id) === "approved"; }

/* ── saving on chain: RF burned per Friend moved on its island ── */

export type Saved = ReadonlyMap<bigint, { plot: string; x: number; y: number }>;
export function pendingChanges(w: World, saved: Saved) {
  let rf = 0; const moved: Placed[] = []; const plots = new Set<Plot>();
  for (const p of myPlots(w)) {
    // Moving a whole island shape together isn't a rearrangement: measure against the most
    // common shift (unless holes pin the island's grid, in which case every shift counts).
    const shifts = new Map<string, number>();
    if (!p.holes?.length) for (const pl of p.friends) {
      const s = saved.get(pl.m.id); if (!s || s.plot !== p.id) continue;
      const k = `${pl.x - s.x},${pl.y - s.y}`; shifts.set(k, (shifts.get(k) ?? 0) + 1);
    }
    const [sx, sy] = ([...shifts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "0,0").split(",").map(Number);
    for (const pl of p.friends) {
      const s = saved.get(pl.m.id);
      if (!s || s.plot !== p.id || s.x + sx !== pl.x || s.y + sy !== pl.y) { moved.push(pl); rf += feeOf(pl.m); plots.add(p); }
    }
  }
  const all = new Set(myPlots(w).flatMap(p => p.friends.map(pl => pl.m.id)));
  const gone = [...saved.keys()].filter(id => !all.has(id));
  return { moved, rf, gone, plots: [...plots] };
}

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
