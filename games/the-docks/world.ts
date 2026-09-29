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
 *   next to another island (a loading zone): beside it, or on the level right above or below
 *   it. Neighbouring islands are joined by a boardwalk a couple of steps long, levels by
 *   stairs, so a block of docked islands (a flag) walks like one big island.
 * - Levels: berths stack from LEVELS.MIN (below the waterline) to LEVELS.MAX (up in the air).
 *   Every level is its own berth grid; an island on a level joins the islands beside it on
 *   that level and the ones straight above and below it.
 * - Bridges (a 2 RF docking fee) join islands on the same level that aren't neighbours.
 * - A flag's islands are each war or peace. Islands outside a flag dock next to its peace
 *   islands only, never directly against a war island (its border).
 * - Crossing onto someone else's island needs their approval unless they keep it open.
 * Built to scale to 10,000+ Friends per island: layout needs no artwork (footprints come from
 * generation) and occupancy is per cell. */
import { REWARD_WEIGHT, type Friend } from "./land.js";

export const CELL = 4;                                             // tiles per cell side
export const GAP = 2;                                              // tiles of boardwalk between neighbouring islands
export const SEA = 10;                                             // tiles of open water between blocks of islands
const MIN_BERTH = 6;                                               // tiles: an empty berth column or row
/** Levels: 0 is the water line; islands dock straight above (+1…) or below (−1…) another. */
export const LEVELS = { MIN: -2, MAX: 3 } as const;
export const levelName = (z: number) => z === 0 ? "Water level" : z > 0 ? `Upper deck ${z}` : `Lower deck ${-z}`;
/** Footprint in cells by generation: lands are 30, 20, 18×16, 12, 8 and 4 tiles across. */
export const FOOTPRINT: Readonly<Record<number, readonly [number, number]>> = { 1: [8, 8], 2: [5, 5], 3: [5, 4], 4: [3, 3], 5: [2, 2], 6: [1, 1] };
/** RF paid per Friend moved on its island when saved on chain (DocksIslands.FEE_GEN1…6), into a pool. */
export const ARRANGE_FEE: Readonly<Record<number, number>> = { 1: 100, 2: 50, 3: 20, 4: 10, 5: 5, 6: 1 };
export const feeOf = (m: { gen: number }) => ARRANGE_FEE[m.gen] ?? 1;
/** Docking fee: RF paid each time an island docks next to another or builds a bridge, into The
 *  Docks fund (the Docks rewards reserve). Flat, cheap to start (DocksIslands.DOCKING_FEE). */
export const DOCKING_FEE = 2;

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
export type Berth = { x: number; y: number; z?: number };             // z: level (0 when missing)
export const zOf = (b: Berth | null | undefined) => b?.z ?? 0;
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
/** A walkable rectangle of boardwalk on a level (x1, y1 exclusive). */
export type WalkRect = { x0: number; y0: number; x1: number; y1: number; z: number };
/** Stairs: step on them to go to level `to`, arriving at (x, y). */
export type Lift = { to: number; x: number; y: number };
export type Box = { x0: number; y0: number; x1: number; y1: number };
export type World = {
  plots: Plot[]; visits: Map<string, Visit>; version: number; bridges: Bridge[];
  occ: Map<Plot, Map<number, Placed>>;                             // island cell → Friend
  holeOcc: Map<Plot, Map<number, Hole>>;                           // island cell → hole
  berths: Map<number, Plot>;
  origin: Map<Plot, { x: number; y: number }>;                     // world tile of the island's cell (0, 0)
  box: Map<Plot, Box>;                                             // island bounds, world tiles
  cols: { b: number; x0: number; x1: number }[]; rows: { b: number; y0: number; y1: number }[];
  walk: Map<number, "gangway" | "bridge">;                         // walkway tiles over the water, keyed tk(x, y, z)
  decks: WalkRect[];                                               // boardwalk rectangles (between close neighbours, piers)
  deckGrid: Map<number, WalkRect[]>;                               // the same by 32-tile bucket
  lifts: Map<number, Lift>;                                        // stairs between levels, keyed tk(x, y, z)
  grid: Map<number, Plot[]>;                                       // islands by 32-tile bucket (for tileAt)
  blocks: { plots: Plot[]; box: Box }[];                           // islands joined by neighbouring berths
  villages: Village[];
  items: Item[];
  bonds: Map<bigint, { village: Village; until: number }>;       // a Friend that left a flagged island
  cooldown: Map<Plot, number>;                                   // islands holding a Friend bound elsewhere
  genesis: number;                                               // epoch clock start
};
/** An item built on an island cell. Flag items belong to the flag; own items to their owner. */
export type Item = { id: number; kind: number; village: Village | null; owner: string | null; plot: Plot | null; cx: number; cy: number; readyAt: number };
export type Raffle = { item: Item; ends: number; tickets: Map<string, number> };
/** A flag planted on an island rises as people lock RF into it; full, it's founded as a flag
 *  and other islands choose to join while connected to it. Mirrors contracts/src/docks/DocksVillages.sol. */
/** A flag's island is at war (fights: boards ships, defends) or at peace (produces, trades). */
export type Stance = "war" | "peace";
export type Village = {
  id: string; name: string; seat: Plot; flag: { x: number; y: number }; color: string;
  members: Plot[];                                                // a wallet may bring several islands
  stance: Map<Plot, Stance>;                                      // each member island: war or peace
  target: number; deadline: number; locked: number; lockers: Map<string, number>;   // founder (wallet label) → RF locked
  founded: boolean; failed: boolean; foundedAt: number;
  pool: number;                                                   // locked + enrollment fees: founder shares are of this
  enrollOpen: boolean; enrollPrice: number; enrollCap: number; enrollVote: Proposal | null;
  liquidity: number; pendingLiquidity: number; fees: { rf: number; eth: number }; poolBps: number; compounded: number;
  credited: Map<string, number>; spent: Map<string, number>;      // allowances: founders' half of their lock + these
  removals: Map<Plot, number>;                                    // island → epoch boundary it leaves at
  raffles: Raffle[];
  proposals: Proposal[];
};
export type ProposalKind = "poolShare" | "enrollment" | "enrollPrice" | "enrollCap" | "war";
export type Proposal = {
  id: number; kind: ProposalKind; options: number[]; memo: string;
  tally: number[]; voters: Map<string, number>; ends: number; settled: boolean; winner: number;
};
/** Who an island's votes belong to: you, or the sample neighbour's wallet (named after it). */
export const walletOf = (p: Plot) => (p.mine ? "you" : p.name);

// Numeric keys (fast for large islands). Coordinates stay well inside ±2^20.
const K = 1 << 21, HALF = 1 << 20;
export const ck = (x: number, y: number) => (x + HALF) * K + (y + HALF);
const LV = 2 ** 42;
/** Key of a tile or berth on a level. */
export const tk = (x: number, y: number, z = 0) => ck(x, y) + (z + 8) * LV;
export const bk = (b: Berth) => tk(b.x, b.y, zOf(b));
export const untk = (k: number) => { const z = Math.floor(k / LV) - 8, r = k - (z + 8) * LV; return { x: Math.floor(r / K) - HALF, y: (r % K) - HALF, z }; };
const T = (c: number) => c * CELL;
export const myPlots = (w: World) => w.plots.filter(p => p.mine);
export const plotOf = (w: World, id: bigint) => w.plots.find(p => p.friends.some(pl => pl.m.id === id)) ?? null;

/* ── building the world ── */

export function emptyWorld(): World {
  return { plots: [], visits: new Map(), version: 0, bridges: [], occ: new Map(), holeOcc: new Map(), berths: new Map(), origin: new Map(), box: new Map(), cols: [], rows: [], walk: new Map(), decks: [], deckGrid: new Map(), lifts: new Map(), grid: new Map(), blocks: [], villages: [], items: [], bonds: new Map(), cooldown: new Map(), genesis: Date.now() };
}

export function rebuild(w: World) {
  w.occ = new Map(); w.holeOcc = new Map(); w.berths = new Map();
  for (const p of w.plots) {
    const m = new Map<number, Placed>(), hm = new Map<number, Hole>();
    for (const pl of p.friends) for (let j = 0; j < pl.m.ch; j++) for (let i = 0; i < pl.m.cw; i++) m.set(ck(pl.x + i, pl.y + j), pl);
    for (const h of p.holes ?? []) for (let j = 0; j < h.ch; j++) for (let i = 0; i < h.cw; i++) hm.set(ck(h.x + i, h.y + j), h);
    w.occ.set(p, m); w.holeOcc.set(p, hm);
    const hasShape = p.friends.length > 0 || (p.holes?.length ?? 0) > 0;
    if (p.berth && hasShape) w.berths.set(bk(p.berth), p);
    else if (p.berth) p.berth = null;
  }
  w.bridges = w.bridges.filter(b => b.a.berth && b.b.berth && same(b.a.berth, b.at[0]) && same(b.b.berth, b.at[1]));
  layout(w);
  w.version++;
}
const same = (a: Berth, b: Berth) => a.x === b.x && a.y === b.y && zOf(a) === zOf(b);

/** Where everything goes, in world tiles.
 *  - Blocks: islands joined by neighbouring berths (beside, above or below) are one block, and
 *    blocks whose berth rectangles overlap are merged. A block is laid out tight, as one big
 *    island: each berth column as wide as its widest island, each row as tall as its tallest,
 *    with only a GAP-tile boardwalk between them. Every level of a berth shares its spot (the
 *    upper decks are drawn raised over it).
 *  - Blocks sit in a coarse table of all berth columns and rows with SEA tiles of water between;
 *    a column only grows as far as the blocks spanning it need. */
function layout(w: World) {
  const docked = w.plots.filter(p => p.berth && (p.friends.length || p.holes?.length));
  const size = new Map<Plot, { w: number; h: number }>();
  for (const p of docked) { const b = plotBounds(p); size.set(p, { w: T(b.x1 - b.x0), h: T(b.y1 - b.y0) }); }
  // 1. blocks
  const at = new Map(docked.map((p, i) => [p, i])), parent = docked.map((_, i) => i);
  const root = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  for (const p of docked) for (const n of around(p.berth!)) { const q = w.berths.get(bk(n)), j = q ? at.get(q) : undefined; if (j !== undefined) parent[root(j)] = root(at.get(p)!); }
  type Blk = { plots: Plot[]; bx0: number; bx1: number; by0: number; by1: number };
  const byRoot = new Map<number, Blk>();
  for (const p of docked) {
    const r = root(at.get(p)!), b = p.berth!; let k = byRoot.get(r);
    if (!k) byRoot.set(r, k = { plots: [], bx0: b.x, bx1: b.x, by0: b.y, by1: b.y });
    k.plots.push(p); k.bx0 = Math.min(k.bx0, b.x); k.bx1 = Math.max(k.bx1, b.x); k.by0 = Math.min(k.by0, b.y); k.by1 = Math.max(k.by1, b.y);
  }
  let blocks = [...byRoot.values()];
  for (let merged = true; merged;) {
    merged = false;
    for (let i = 0; i < blocks.length; i++) for (let j = i + 1; j < blocks.length; j++) {
      const A = blocks[i], B = blocks[j];
      if (A.bx0 <= B.bx1 && B.bx0 <= A.bx1 && A.by0 <= B.by1 && B.by0 <= A.by1) {
        A.plots.push(...B.plots); A.bx0 = Math.min(A.bx0, B.bx0); A.bx1 = Math.max(A.bx1, B.bx1); A.by0 = Math.min(A.by0, B.by0); A.by1 = Math.max(A.by1, B.by1);
        blocks[j] = blocks[blocks.length - 1]; blocks.pop(); j--; merged = true;
      }
    }
  }
  blocks.sort((a, b) => a.by0 - b.by0 || a.bx0 - b.bx0);
  // 2. each block packed tight: every berth (with all its levels) is one unit, as big as the
  //    biggest island stacked on it. Start from a table of the block's columns and rows, then
  //    compact: slide every unit left, then up, until it's GAP tiles from whatever is in the way.
  //    Rows stay in order left to right and columns top to bottom, so neighbours stay neighbours.
  const local = blocks.map(k => {
    type U = { bx: number; by: number; w: number; h: number; x: number; y: number };
    const units = new Map<string, U>();
    for (const p of k.plots) {
      const s = size.get(p)!, key = `${p.berth!.x},${p.berth!.y}`, u = units.get(key);
      if (u) { u.w = Math.max(u.w, s.w); u.h = Math.max(u.h, s.h); } else units.set(key, { bx: p.berth!.x, by: p.berth!.y, w: s.w, h: s.h, x: 0, y: 0 });
    }
    const colW = new Map<number, number>(), rowH = new Map<number, number>();
    for (const u of units.values()) { colW.set(u.bx, Math.max(colW.get(u.bx) ?? 4, u.w)); rowH.set(u.by, Math.max(rowH.get(u.by) ?? 4, u.h)); }
    const lx = new Map<number, number>(), ly = new Map<number, number>();
    let x = 0; for (let b = k.bx0; b <= k.bx1; b++) { lx.set(b, x); x += (colW.get(b) ?? 4) + GAP; }
    let y = 0; for (let b = k.by0; b <= k.by1; b++) { ly.set(b, y); y += (rowH.get(b) ?? 4) + GAP; }
    const list = [...units.values()];
    for (const u of list) { u.x = lx.get(u.bx)! + Math.floor((colW.get(u.bx)! - u.w) / 2); u.y = ly.get(u.by)! + Math.floor((rowH.get(u.by)! - u.h) / 2); }
    const near = (a0: number, a1: number, b0: number, b1: number) => a0 < b1 + GAP && b0 < a1 + GAP;
    const done: U[] = [];
    for (const u of [...list].sort((a, b) => a.x - b.x || a.y - b.y)) {
      let nx = 0; for (const q of done) if (near(u.y, u.y + u.h, q.y, q.y + q.h)) nx = Math.max(nx, q.x + q.w + GAP);
      u.x = nx; done.push(u);
    }
    done.length = 0;
    for (const u of [...list].sort((a, b) => a.y - b.y || a.x - b.x)) {
      let ny = 0; for (const q of done) if (near(u.x, u.x + u.w, q.x, q.x + q.w)) ny = Math.max(ny, q.y + q.h + GAP);
      u.y = ny; done.push(u);
    }
    return { units, w: Math.max(...list.map(u => u.x + u.w)), h: Math.max(...list.map(u => u.y + u.h)) };
  });
  // 3. the coarse table
  const W = new Map<number, number>(), H = new Map<number, number>();
  w.cols = []; w.rows = [];
  const colX = new Map<number, number>(), rowY = new Map<number, number>();
  const span = (m: Map<number, number>, a: number, b: number) => { let s = (b - a) * SEA; for (let i = a; i <= b; i++) s += m.get(i)!; return s; };
  if (blocks.length) {
    const gx0 = Math.min(...blocks.map(k => k.bx0)), gx1 = Math.max(...blocks.map(k => k.bx1));
    const gy0 = Math.min(...blocks.map(k => k.by0)), gy1 = Math.max(...blocks.map(k => k.by1));
    for (let b = gx0; b <= gx1; b++) W.set(b, MIN_BERTH);
    for (let b = gy0; b <= gy1; b++) H.set(b, MIN_BERTH);
    const grow = (m: Map<number, number>, a: number, b: number, need: number) => { const d = need - span(m, a, b); if (d > 0) { const add = Math.ceil(d / (b - a + 1)); for (let i = a; i <= b; i++) m.set(i, m.get(i)! + add); } };
    [...blocks.keys()].sort((i, j) => (blocks[i].bx1 - blocks[i].bx0) - (blocks[j].bx1 - blocks[j].bx0)).forEach(i => grow(W, blocks[i].bx0, blocks[i].bx1, local[i].w));
    [...blocks.keys()].sort((i, j) => (blocks[i].by1 - blocks[i].by0) - (blocks[j].by1 - blocks[j].by0)).forEach(i => grow(H, blocks[i].by0, blocks[i].by1, local[i].h));
    for (let b = gx0, x = 0; b <= gx1; b++) { colX.set(b, x); w.cols.push({ b, x0: x, x1: x + W.get(b)! }); x += W.get(b)! + SEA; }
    for (let b = gy0, y = 0; b <= gy1; b++) { rowY.set(b, y); w.rows.push({ b, y0: y, y1: y + H.get(b)! }); y += H.get(b)! + SEA; }
  }
  w.origin = new Map(); w.box = new Map();
  const place = (p: Plot, left: number, top: number, width: number, height: number) => {
    const b = plotBounds(p), wT = T(b.x1 - b.x0), hT = T(b.y1 - b.y0);
    const ox = left + Math.floor((width - wT) / 2) - T(b.x0), oy = top + Math.floor((height - hT) / 2) - T(b.y0);
    w.origin.set(p, { x: ox, y: oy });
    w.box.set(p, { x0: ox + T(b.x0), y0: oy + T(b.y0), x1: ox + T(b.x1), y1: oy + T(b.y1) });
  };
  w.blocks = blocks.map((k, i) => {
    const L = local[i];
    const left = colX.get(k.bx0)! + Math.floor((span(W, k.bx0, k.bx1) - L.w) / 2);
    const top = rowY.get(k.by0)! + Math.floor((span(H, k.by0, k.by1) - L.h) / 2);
    for (const p of k.plots) { const u = L.units.get(`${p.berth!.x},${p.berth!.y}`)!; place(p, left + u.x, top + u.y, u.w, u.h); }
    return { plots: k.plots, box: { x0: left, y0: top, x1: left + L.w, y1: top + L.h } };
  });
  // islands floating free (mine, not docked yet) drift just below the docks
  let fx = 0; const fy = (w.rows.at(-1)?.y1 ?? 0) + SEA * 2;
  for (const p of w.plots) if (!p.berth && (p.friends.length || p.holes?.length)) {
    const b = plotBounds(p), wT = T(b.x1 - b.x0), hT = T(b.y1 - b.y0);
    place(p, fx, fy, wT, hT); fx += wT + SEA;
  }
  // bucket index for tileAt
  w.grid = new Map();
  for (const [p, b] of w.box) for (let gx = Math.floor(b.x0 / BUCKET); gx <= Math.floor((b.x1 - 1) / BUCKET); gx++) for (let gy = Math.floor(b.y0 / BUCKET); gy <= Math.floor((b.y1 - 1) / BUCKET); gy++) {
    const k = ck(gx, gy), l = w.grid.get(k); if (l) l.push(p); else w.grid.set(k, [p]);
  }
  // walkways: a boardwalk between neighbours on a level (across their whole shared side),
  // stairs between levels, bridges wherever built
  w.walk = new Map(); w.lifts = new Map(); w.decks = []; w.deckGrid = new Map();
  const deck = (x0: number, y0: number, x1: number, y1: number, z: number) => {
    if (x1 <= x0 || y1 <= y0) return;
    const r: WalkRect = { x0, y0, x1, y1, z }; w.decks.push(r);
    for (let gx = Math.floor(x0 / BUCKET); gx <= Math.floor((x1 - 1) / BUCKET); gx++) for (let gy = Math.floor(y0 / BUCKET); gy <= Math.floor((y1 - 1) / BUCKET); gy++) {
      const k = ck(gx, gy), l = w.deckGrid.get(k); if (l) l.push(r); else w.deckGrid.set(k, [r]);
    }
  };
  const centre = (p: Plot) => { const b = w.box.get(p)!; return { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 }; };
  for (const p of docked) {
    const z = zOf(p.berth), a = w.box.get(p)!, ca = centre(p);
    for (const [dx, dy] of [[1, 0], [0, 1]]) {
      const q = w.berths.get(bk({ x: p.berth!.x + dx, y: p.berth!.y + dy, z })); if (!q) continue;
      const b = w.box.get(q)!, cb = centre(q);
      // a two-tile walk, centre to centre: along the first axis, then the other
      const ax = Math.floor(ca.x), ay = Math.floor(ca.y), bx = Math.floor(cb.x), by = Math.floor(cb.y);
      if (dx) { deck(Math.min(ax, bx) - 1, ay - 1, Math.max(ax, bx) + 1, ay + 1, z); deck(bx - 1, Math.min(ay, by) - 1, bx + 1, Math.max(ay, by) + 1, z); }
      else { deck(ax - 1, Math.min(ay, by) - 1, ax + 1, Math.max(ay, by) + 1, z); deck(Math.min(ax, bx) - 1, by - 1, Math.max(ax, bx) + 1, by + 1, z); }
      // close neighbours: the boardwalk spans their whole facing sides, like one island
      if (dx && b.x0 - a.x1 <= 8) deck(a.x1 - 1, Math.max(a.y0, b.y0), b.x0 + 1, Math.min(a.y1, b.y1), z);
      if (dy && b.y0 - a.y1 <= 8) deck(Math.max(a.x0, b.x0), a.y1 - 1, Math.min(a.x1, b.x1), b.y0 + 1, z);
    }
    const up = w.berths.get(bk({ x: p.berth!.x, y: p.berth!.y, z: z + 1 }));
    if (up) {
      // Stairs sit on little piers just off the islands' sides (never blocked by buildings):
      // up from the lower island's left side, down from the upper island's right side. Each
      // arrives on a pier beside the other island, a step below its own stairs.
      const b = w.box.get(up)!, am = Math.floor((a.y0 + a.y1) / 2), bm = Math.floor((b.y0 + b.y1) / 2);
      const pier = (x0: number, x1: number, y: number, lv: number) => deck(x0, y, x1 + 1, y + 2, lv);
      pier(a.x0 - 3, a.x0 + 3, am - 1, z); pier(a.x0 - 3, a.x0 + 3, am + 1, z);            // lower: up-stairs + arrival from above
      pier(b.x1 - 4, b.x1 + 2, bm - 1, z + 1); pier(b.x1 - 4, b.x1 + 2, bm + 1, z + 1);   // upper: down-stairs + arrival from below
      pier(b.x0 - 3, b.x0 + 3, bm + 1, z + 1); pier(a.x1 - 4, a.x1 + 2, am + 1, z);
      for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) {
        w.lifts.set(tk(a.x0 - 3 + i, am - 1 + j, z), { to: z + 1, x: b.x0 - 2, y: bm + 2 });
        w.lifts.set(tk(b.x1 + 1 + i, bm - 1 + j, z + 1), { to: z, x: a.x1 + 1.5, y: am + 2 });
      }
    }
  }
  for (const br of w.bridges) {
    const a = centre(br.a), b = centre(br.b), len = Math.hypot(b.x - a.x, b.y - a.y), z = zOf(br.a.berth);
    for (let t = 0; t <= len; t += 0.5) {
      const x = a.x + (b.x - a.x) * t / len, y = a.y + (b.y - a.y) * t / len;
      for (const [ox, oy] of [[-0.7, -0.7], [0.7, -0.7], [-0.7, 0.7], [0.7, 0.7]]) {
        const k = tk(Math.floor(x + ox), Math.floor(y + oy), z); if (!w.walk.has(k)) w.walk.set(k, "bridge");
      }
    }
  }
}
const BUCKET = 32;

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

/** The berths touching `b`: beside it on its level, and straight above and below it. */
function around(b: Berth): Berth[] {
  const z = zOf(b), out: Berth[] = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dy]) => ({ x: b.x + dx, y: b.y + dy, z }));
  if (z < LEVELS.MAX) out.push({ x: b.x, y: b.y, z: z + 1 });
  if (z > LEVELS.MIN) out.push({ x: b.x, y: b.y, z: z - 1 });
  return out;
}
/** Free berths next to a docked island (beside it, above or below), where `p` can dock. The
 *  first island docks anywhere. */
export function loadingZones(w: World, p: Plot): Berth[] {
  const out = new Map<number, Berth>();
  for (const q of w.plots) if (q !== p && q.berth && q.friends.length && !hostileBorder(w, p, q))
    for (const b of around(q.berth)) { const o = w.berths.get(bk(b)); if (!o || o === p) out.set(bk(b), b); }
  // never directly against (or over, or under) someone else's war island
  for (const [k, b] of out) if (around(b).some(n => { const q = w.berths.get(bk(n)); return q && q !== p && q.friends.length && hostileBorder(w, p, q); })) out.delete(k);
  if (!out.size && ![...w.berths.values()].some(q => q !== p)) out.set(tk(0, 0), { x: 0, y: 0 });
  return [...out.values()];
}
export function dockAt(w: World, p: Plot, b: Berth) {
  const o = w.berths.get(bk(b));
  if (o && o !== p) return false;
  if (!loadingZones(w, p).some(z => same(z, b))) return false;
  p.berth = { ...b }; rebuild(w); return true;
}
/** Loading zones right next to `target` where `p` could dock. */
export function zonesNextTo(w: World, p: Plot, target: Plot): Berth[] {
  if (!target.berth) return [];
  return loadingZones(w, p).filter(z => dist(z, target.berth!) === 1);
}
export function undock(w: World, p: Plot) { p.berth = null; rebuild(w); }
const dist = (a: Berth, b: Berth) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y) + Math.abs(zOf(a) - zOf(b));
/** Berth steps between two islands (levels count as steps). */
export const berthDist = dist;
/** Straight above or below each other. */
export const stacked = (a: Plot, b: Plot) => Boolean(a.berth && b.berth && a.berth.x === b.berth.x && a.berth.y === b.berth.y && zOf(a.berth) !== zOf(b.berth));
export const hasBridge = (w: World, a: Plot, b: Plot) => w.bridges.some(x => (x.a === a && x.b === b) || (x.a === b && x.b === a));
export function connected(w: World, a: Plot, b: Plot) {
  if (!a.berth || !b.berth || a === b) return false;
  return dist(a.berth, b.berth) === 1 || hasBridge(w, a, b);
}
export function neighboursOf(w: World, p: Plot) { return w.plots.filter(q => q.friends.length && connected(w, p, q)); }
export function addBridge(w: World, a: Plot, b: Plot) {
  if (!a.berth || !b.berth || zOf(a.berth) !== zOf(b.berth) || connected(w, a, b) || hostileBorder(w, a, b)) return false;
  w.bridges.push({ a, b, at: [{ ...a.berth }, { ...b.berth }] }); rebuild(w); return true;
}

/* ── villages (membership; the flag's RF economy is in villages.ts) ── */

const FLAG_COLORS = ["#ff4d6d", "#4dabf7", "#ffd43b", "#69db7c", "#b197fc", "#ff922b", "#f7931a", "#8c8cff", "#14f195", "#f4b728", "#23c2f5", "#ff66c4"];
/** The founded village an island is in (a rising flag isn't a flag yet). */
export const villageOf = (w: World, p: Plot) => w.villages.find(v => v.founded && v.members.includes(p)) ?? null;
/** War or peace for an island in a founded flag; null outside one. */
export const stanceOf = (w: World, p: Plot): Stance | null => { const v = villageOf(w, p); return v ? v.stance.get(p) ?? "peace" : null; };
/** A war island of a flag `p` isn't in: `p` can't dock directly against it or bridge to it. */
export const hostileBorder = (w: World, p: Plot, q: Plot) => stanceOf(w, q) === "war" && villageOf(w, q) !== villageOf(w, p);
/** A flag still rising on this island (it's the seat). */
export const risingFlagOf = (w: World, p: Plot) => w.villages.find(v => !v.founded && !v.failed && v.seat === p) ?? null;
/** Why `p` can't plant a flag (null: it can). `at` is an island-local tile the flag stands on. */
export function flagProblem(w: World, p: Plot, at: { x: number; y: number }): string | null {
  if (!p.berth) return `Dock ${p.name} first: flags go on docked islands.`;
  const v = villageOf(w, p) ?? risingFlagOf(w, p); if (v) return `${p.name} already flies ${v.name}'s flag.`;
  const cx = Math.floor(at.x / CELL), cy = Math.floor(at.y / CELL);
  if (!w.occ.get(p)?.has(ck(cx, cy))) return "Stand on your island's land to plant the flag.";
  return null;
}
export function newVillage(w: World, seat: Plot, name: string, at: { x: number; y: number }, target: number, deadline: number): Village {
  const clean = name.trim().slice(0, 32); if (!clean) throw new Error("Name your flag.");
  const v: Village = { id: `v${w.villages.length + 1}-${seat.id}`, name: clean, seat, flag: { ...at }, members: [],
    color: FLAG_COLORS[w.villages.length % FLAG_COLORS.length], target, deadline, locked: 0, lockers: new Map(), founded: false, failed: false, foundedAt: 0,
    pool: 0, enrollOpen: false, enrollPrice: 0, enrollCap: 0, enrollVote: null,
    liquidity: 0, pendingLiquidity: 0, fees: { rf: 0, eth: 0 }, poolBps: 5000, compounded: 0,
    credited: new Map(), spent: new Map(), removals: new Map(), raffles: [], proposals: [], stance: new Map() };
  w.villages.push(v); w.version++; return v;
}
/** Everyone in a flag brings exactly one island (one per wallet). Why `p` can't (null: it can). */
export function joinProblem(w: World, v: Village, p: Plot): string | null {
  if (!v.founded) return `${v.name}'s flag is still rising: islands join once it's founded.`;
  if (!p.berth) return `Dock ${p.name} first.`;
  const cur = villageOf(w, p) ?? risingFlagOf(w, p); if (cur) return cur === v ? `${p.name} is in ${v.name}.` : `${p.name} already flies ${cur.name}'s flag.`;
  return null;
}
export function addMember(w: World, v: Village, p: Plot, stance: Stance = "peace") {
  const why = joinProblem(w, v, p); if (why) throw new Error(why);
  v.members.push(p); v.stance.set(p, stance); w.version++;
}
export function flagTile(w: World, v: Village) {
  const o = w.origin.get(v.seat); return o ? { x: o.x + v.flag.x, y: o.y + v.flag.y } : null;
}

/* ── walking & access (world tiles) ── */

export type TileInfo = { plot: Plot | null; placed: Placed | null; blocked: boolean; walkway?: "gangway" | "bridge"; lift?: Lift };
function islandTile(w: World, p: Plot, x: number, y: number): TileInfo | null {
  const o = w.origin.get(p); if (!o) return null;
  const lx = x - o.x, ly = y - o.y, pl = w.occ.get(p)?.get(ck(Math.floor(lx / CELL), Math.floor(ly / CELL)));
  if (!pl) return null;
  const f = pl.m.friend, i = lx - T(pl.x), j = ly - T(pl.y);
  if (!f) return { plot: p, placed: pl, blocked: false };           // art not loaded yet: walkable ground
  const land = i < f.w && j < f.h && f.tiles[j * f.w + i];
  return { plot: p, placed: pl, blocked: land ? f.blocked[j * f.w + i] : false };
}
/** What's at a world tile on level `z` (islands floating free are on level 0). */
export function tileAt(w: World, x: number, y: number, z = 0): TileInfo | undefined {
  const tx = Math.floor(x), ty = Math.floor(y), lift = w.lifts.get(tk(tx, ty, z));
  for (const p of w.grid.get(ck(Math.floor(tx / BUCKET), Math.floor(ty / BUCKET))) ?? []) {
    if (zOf(p.berth) !== z) continue;
    const b = w.box.get(p)!; if (tx < b.x0 || tx >= b.x1 || ty < b.y0 || ty >= b.y1) continue;
    const t = islandTile(w, p, tx, ty); if (t) return lift ? { ...t, blocked: false, lift } : t;
  }
  const k = w.walk.get(tk(tx, ty, z)) ?? ((w.deckGrid.get(ck(Math.floor(tx / BUCKET), Math.floor(ty / BUCKET))) ?? []).some(r => r.z === z && tx >= r.x0 && tx < r.x1 && ty >= r.y0 && ty < r.y1) ? "gangway" as const : undefined);
  return lift ? { plot: null, placed: null, blocked: false, walkway: "gangway", lift } : k ? { plot: null, placed: null, blocked: false, walkway: k } : undefined;
}
/** Walking onto an island: your own; any island docked next to or bridged to one of yours (for
 *  now free; a toll to its owner and the Docks may come later); every island of a flag you're in;
 *  or, as a visitor just exploring, a flag's islands once you're connected to one of them. */
export function canEnter(w: World, p: Plot) {
  if (p.mine) return true;
  const mine = w.plots.filter(q => q.mine);
  if (mine.some(q => connected(w, q, p))) return true;
  const f = villageOf(w, p); if (!f) return false;
  return mine.some(q => villageOf(w, q) === f) || mine.some(q => f.members.some(m => connected(w, q, m)));
}
/** The same rule seen from any island `from` (used for launch "visitors" scopes). */
export function canEnterFrom(w: World, from: Plot, p: Plot) {
  if (from === p || connected(w, from, p)) return true;
  const f = villageOf(w, p); if (!f) return false;
  return villageOf(w, from) === f || f.members.some(m => connected(w, from, m));
}
/** On a flag island as a visitor (exploring only). */
export const exploring = (w: World, p: Plot) => !p.mine && canEnter(w, p) && !w.plots.some(q => q.mine && villageOf(w, q) === villageOf(w, p));

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
