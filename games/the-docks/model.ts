/* The Docks — world layout and game rules. Pure logic, no rendering.
 * Everything here is simulated and session-only (the SDK sandbox has no storage). */
import { MAX_H, MAX_W, sampleLand, type Land } from "./land.js";

// A berth = the Friend's imported land (up to MAX_W × MAX_H tiles) + a short gangway + a wooden deck.
export const BERTH_W = MAX_W + 2;              // 22
export const LAND_H = MAX_H;                   // 18
export const LINK = 2;
export const DECK_W = 10, DECK_H = 6;
export const BERTH_H = LAND_H + LINK + DECK_H; // 26
export const GAP = 3;
export const GRID = 3;
export const MARGIN = 2;
export const HARBOR_Y = MARGIN + GRID * BERTH_H + (GRID - 1) * GAP + 4;
export const WORLD_W = MARGIN * 2 + GRID * BERTH_W + (GRID - 1) * GAP;
export const WORLD_H = HARBOR_Y + BERTH_H + MARGIN;

export const CREDITS_PER_RF = 100;       // simulated: 100 credits = 1 RF of purchase value
export const BURN_SHARE_PURCHASE = 0.5;  // share of credit purchases that buys & burns RF
export const BURN_SHARE_DOCK = 0.5;      // share of docking fees burned
export const MARKET_FEE = 0.05;          // stall-sale fee, burned
export const ADJ_BONUS = 0.25;           // +25% produce & XP per adjacent docked neighbour

export const SURF = { water: 0, land: 1, deck: 2, plank: 3 } as const;
export type Berth = { bx: number; by: number };
export type Plant = { stage: number; growth: number; water: number };
export type Animal = { hunger: number; lay: number; x: number; y: number; tx: number; ty: number };
export type ItemId = "feed" | "fert" | "can" | "cap" | "crown" | "berry" | "egg";
export type Item = { name: string; icon: string; price: number; kind: "consumable" | "tool" | "hat" | "produce"; blurb: string };
export const ITEMS: Readonly<Record<ItemId, Item>> = {
  feed: { name: "Feed Sack", icon: "🌾", price: 15, kind: "consumable", blurb: "Feeds an animal once (+50 food)" },
  fert: { name: "Fertilizer", icon: "🧪", price: 25, kind: "consumable", blurb: "Instantly grows a plant one stage" },
  can: { name: "Golden Can", icon: "🚿", price: 120, kind: "tool", blurb: "Watering fills to 100 and waters the whole garden" },
  cap: { name: "Sailor Cap", icon: "⚓", price: 150, kind: "hat", blurb: "Cosmetic hat your Friend wears" },
  crown: { name: "Flower Crown", icon: "🌼", price: 220, kind: "hat", blurb: "Cosmetic hat your Friend wears" },
  berry: { name: "Dock Berries", icon: "🫐", price: 6, kind: "produce", blurb: "Grown on your deck. Sell, feed your Friend or animals" },
  egg: { name: "Fresh Egg", icon: "🥚", price: 12, kind: "produce", blurb: "Laid by well-fed chickens. Sell at your stall" },
};

export type PlotState = {
  id: string; name: string; owner: "you" | "neighbour"; accent: number;
  berth: Berth | null;                  // null = adrift in the harbor (yours, before docking)
  land: Land;
  plants: Plant[]; animals: Animal[]; stall: ItemId[];
  thanks: number;
};
export type Pet = { hunger: number; joy: number; kibbleAt: number };
export type World = {
  plots: PlotState[]; surface: Uint8Array; blocked: Uint8Array;
  credits: number; burnedRf: number; xp: number; level: number;
  bag: Record<ItemId, number>; hat: ItemId | null; pet: Pet; log: string[]; charmBoost: number;
};

/** Deck-local layout (tiles inside the 10 × 6 deck). */
export const DECK = {
  beds: [{ x: 1, y: 1 }, { x: 2, y: 1 }, { x: 3, y: 1 }],
  pen: { x: 5, y: 1, w: 4, h: 4 },           // fence ring; interior x 6..7, y 2..3
  stall: { x: 1, y: 4 },
  sign: { x: 4.5, y: 5.4 },
};

export const berthOrigin = (b: Berth | null) => b
  ? { x: MARGIN + b.bx * (BERTH_W + GAP), y: MARGIN + b.by * (BERTH_H + GAP) }
  : { x: MARGIN + BERTH_W + GAP, y: HARBOR_Y };
export const landOrigin = (p: PlotState) => { const o = berthOrigin(p.berth); return { x: o.x + Math.floor((BERTH_W - p.land.w) / 2), y: o.y + Math.floor((LAND_H - p.land.h) / 2) }; };
export const deckOrigin = (p: PlotState) => { const o = berthOrigin(p.berth); return { x: o.x + (BERTH_W - DECK_W) / 2, y: o.y + LAND_H + LINK }; };
export const berthKey = (b: Berth) => `${b.bx},${b.by}`;
export const berthPrice = (b: Berth) => (b.bx === 1 && b.by === 1 ? 250 : 100);

const mulberry = (seed: number) => () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const newAnimals = (rand: () => number, n: number): Animal[] => Array.from({ length: n }, () => ({ hunger: 40 + rand() * 40, lay: rand() * 20, x: 7, y: 3, tx: 7, ty: 3 }));

/** `land` is the player's imported on-chain land (or a fallback). Neighbours are fictional samples. */
export function createWorld(friendId: bigint, land: Land): World {
  const rand = mulberry(Number(friendId % 2147483647n) || 1);
  const neighbours: [string, Berth, string, string, number][] = [
    ["Pip's Orchard", { bx: 1, by: 0 }, "Garden", "Dither", 0xccff00],
    ["Juniper Wharf", { bx: 0, by: 1 }, "Coastal", "Plain", 0x7db4db],
    ["Rook's Roost", { bx: 2, by: 1 }, "Rooftop", "Cross Grid", 0xb3a0d8],
    ["Moss Landing", { bx: 0, by: 2 }, "Mineral", "Hatch", 0xf2ce68],
  ];
  const plots: PlotState[] = [
    { id: "you", name: "Your land", owner: "you", accent: 0xccff00, berth: null, land,
      plants: DECK.beds.map(() => ({ stage: 1, growth: 0, water: 60 })), animals: newAnimals(rand, 1), stall: [], thanks: 0 },
    ...neighbours.map(([name, berth, scenery, floor, accent], i) => ({
      id: `n${i}`, name, owner: "neighbour" as const, accent, berth,
      land: sampleLand(1000 + i * 77, scenery, floor, 6 + (i % 3), 5 + ((i + 1) % 3)),
      plants: DECK.beds.map(() => ({ stage: Math.floor(rand() * 3), growth: rand(), water: 5 + rand() * 30 })),
      animals: newAnimals(rand, 1 + (i % 2)),
      stall: [(["feed", "fert", "can"] as ItemId[])[i % 3], (["cap", "crown", "feed", "fert"] as ItemId[])[i]],
      thanks: 0,
    })),
  ];
  const world: World = { plots, surface: new Uint8Array(0), blocked: new Uint8Array(0), credits: 300, burnedRf: 0, xp: 0, level: 1,
    bag: { feed: 2, fert: 1, can: 0, cap: 0, crown: 0, berry: 2, egg: 0 }, hat: null,
    pet: { hunger: 70, joy: 65, kibbleAt: 0 }, log: [], charmBoost: 0 };
  rebuildTiles(world);
  return world;
}

export const you = (w: World) => w.plots[0];
const idx = (x: number, y: number) => y * WORLD_W + x;
const inWorld = (x: number, y: number) => x >= 0 && y >= 0 && x < WORLD_W && y < WORLD_H;
export const surfaceAt = (w: World, x: number, y: number) => inWorld(Math.floor(x), Math.floor(y)) ? w.surface[idx(Math.floor(x), Math.floor(y))] : 0;
export const walkable = (w: World, x: number, y: number) => {
  const tx = Math.floor(x), ty = Math.floor(y);
  return inWorld(tx, ty) && w.surface[idx(tx, ty)] !== SURF.water && !w.blocked[idx(tx, ty)];
};

export function adjacentBerths(b: Berth): Berth[] {
  return [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dy]) => ({ bx: b.bx + dx, by: b.by + dy }))
    .filter(n => n.bx >= 0 && n.by >= 0 && n.bx < GRID && n.by < GRID);
}
export function neighboursOf(w: World, p: PlotState) {
  if (!p.berth) return [];
  const keys = new Set(adjacentBerths(p.berth).map(berthKey));
  return w.plots.filter(q => q !== p && q.berth && keys.has(berthKey(q.berth)));
}
export const bonus = (w: World) => 1 + ADJ_BONUS * neighboursOf(w, you(w)).length;

const TINY = /tiny|sprout|flower|reeds/;
/** BFS over water from any `from` tile to any `to` tile inside a box; lay a 2-wide plank path. */
function bridge(w: World, from: Set<number>, to: Set<number>, box: { x0: number; y0: number; x1: number; y1: number }) {
  const prev = new Map<number, number>(); const queue: number[] = [];
  for (const s of from) { prev.set(s, -1); queue.push(s); }
  let found = -1;
  while (queue.length && found < 0) {
    const cur = queue.shift()!; const cx = cur % WORLD_W, cy = Math.floor(cur / WORLD_W);
    for (const [dx, dy] of [[0, 1], [1, 0], [0, -1], [-1, 0]]) {
      const nx = cx + dx, ny = cy + dy;
      if (nx < box.x0 || ny < box.y0 || nx > box.x1 || ny > box.y1) continue;
      const n = idx(nx, ny); if (prev.has(n)) continue;
      if (to.has(n)) { prev.set(n, cur); found = cur; break; }
      if (w.surface[n] !== SURF.water) continue;
      prev.set(n, cur); queue.push(n);
    }
  }
  for (let c = found; c >= 0 && !from.has(c); c = prev.get(c)!) {
    w.surface[c] = SURF.plank;
    const cx = c % WORLD_W, cy = Math.floor(c / WORLD_W), p = prev.get(c)!;
    // widen perpendicular to travel
    const vertical = p >= 0 && p % WORLD_W === cx;
    const side = vertical ? idx(cx + 1, cy) : idx(cx, cy + 1);
    if (inWorld(vertical ? cx + 1 : cx, vertical ? cy : cy + 1) && w.surface[side] === SURF.water) w.surface[side] = SURF.plank;
  }
}

function tilesOf(w: World, p: PlotState, which: "land" | "deck") {
  const s = new Set<number>();
  if (which === "land") { const o = landOrigin(p); p.land.tiles.forEach((t, i) => { if (t) s.add(idx(o.x + (i % p.land.w), o.y + Math.floor(i / p.land.w))); }); }
  else { const o = deckOrigin(p); for (let y = 0; y < DECK_H; y++) for (let x = 0; x < DECK_W; x++) s.add(idx(o.x + x, o.y + y)); }
  return s;
}

/** Surfaces: imported land, decks, gangways and bridges between adjacent docked berths. */
export function rebuildTiles(w: World) {
  w.surface = new Uint8Array(WORLD_W * WORLD_H); w.blocked = new Uint8Array(WORLD_W * WORLD_H);
  const block = (x: number, y: number) => { if (inWorld(x, y)) w.blocked[idx(x, y)] = 1; };
  for (const p of w.plots) {
    const lo = landOrigin(p), d = deckOrigin(p);
    for (const i of tilesOf(w, p, "land")) w.surface[i] = SURF.land;
    for (const i of tilesOf(w, p, "deck")) w.surface[i] = SURF.deck;
    for (const pr of p.land.props) if (!TINY.test(pr.name)) block(lo.x + Math.floor(pr.x), lo.y + Math.floor(pr.y));
    for (const b of DECK.beds) block(d.x + b.x, d.y + b.y);
    const pen = DECK.pen;
    for (let i = 0; i < pen.w; i++) { block(d.x + pen.x + i, d.y + pen.y); block(d.x + pen.x + i, d.y + pen.y + pen.h - 1); }
    for (let i = 0; i < pen.h; i++) { block(d.x + pen.x, d.y + pen.y + i); block(d.x + pen.x + pen.w - 1, d.y + pen.y + i); }
    block(d.x + DECK.stall.x, d.y + DECK.stall.y);
    // gangway from deck to land
    const o = berthOrigin(p.berth);
    bridge(w, tilesOf(w, p, "deck"), tilesOf(w, p, "land"), { x0: o.x, y0: o.y, x1: o.x + BERTH_W - 1, y1: o.y + BERTH_H - 1 });
  }
  for (const a of w.plots) for (const b of w.plots) {
    if (!a.berth || !b.berth) continue;
    const oa = berthOrigin(a.berth), ob = berthOrigin(b.berth);
    if (b.berth.bx === a.berth.bx + 1 && b.berth.by === a.berth.by)
      bridge(w, tilesOf(w, a, "land"), tilesOf(w, b, "land"), { x0: oa.x, y0: oa.y, x1: ob.x + BERTH_W - 1, y1: oa.y + LAND_H - 1 });
    if (b.berth.by === a.berth.by + 1 && b.berth.bx === a.berth.bx)
      bridge(w, tilesOf(w, a, "deck"), tilesOf(w, b, "land"), { x0: oa.x, y0: oa.y, x1: oa.x + BERTH_W - 1, y1: ob.y + BERTH_H - 1 });
  }
}

/** A walkable spawn point near the middle of a plot's land. */
export function spawnPoint(w: World, p: PlotState) {
  const o = landOrigin(p), cx = o.x + p.land.w / 2, cy = o.y + p.land.h / 2;
  let best = { x: cx, y: cy }, bd = Infinity;
  for (let y = 0; y < p.land.h; y++) for (let x = 0; x < p.land.w; x++) {
    const tx = o.x + x, ty = o.y + y;
    if (!walkable(w, tx + 0.5, ty + 0.5)) continue;
    const d = Math.hypot(tx + 0.5 - cx, ty + 0.5 - cy);
    if (d < bd) { bd = d; best = { x: tx + 0.5, y: ty + 0.5 }; }
  }
  return best;
}

export function xpForLevel(level: number) { return 60 + level * 40; }
export function gainXp(w: World, amount: number) {
  const mood = (w.pet.hunger + w.pet.joy) / 200;
  w.xp += amount * bonus(w) * (0.5 + mood) * (1 + w.charmBoost);
  let levelled = false;
  while (w.xp >= xpForLevel(w.level)) { w.xp -= xpForLevel(w.level); w.level++; levelled = true; }
  return levelled;
}

/** Advance simulation by dt seconds. Animal positions are deck-local. */
export function step(w: World, dt: number) {
  w.pet.hunger = Math.max(0, w.pet.hunger - 0.25 * dt);
  w.pet.joy = Math.max(0, w.pet.joy - 0.2 * dt);
  for (const p of w.plots) {
    for (const plant of p.plants) {
      plant.water = Math.max(0, plant.water - (p.owner === "you" ? 1.2 : 0.8) * dt);
      if (plant.water > 0 && plant.stage < 3) {
        plant.growth += dt / 18;
        if (plant.growth >= 1) { plant.growth = 0; plant.stage++; }
      }
    }
    for (const a of p.animals) {
      a.hunger = Math.max(0, a.hunger - 0.9 * dt);
      if (p.owner === "you" && a.hunger > 40) {
        a.lay += dt;
        if (a.lay >= 30) { a.lay = 0; w.bag.egg += Math.round(1 * bonus(w)); w.log.unshift("Your chicken laid an egg 🥚"); }
      }
      const dx = a.tx - a.x, dy = a.ty - a.y, d = Math.hypot(dx, dy);
      if (d < 0.05) { a.tx = 6.2 + Math.random() * 1.6; a.ty = 2.2 + Math.random() * 1.6; }
      else { const s = Math.min(d, 0.8 * dt); a.x += (dx / d) * s; a.y += (dy / d) * s; }
    }
  }
}

/* ── Interactions ── */
export type Spot = { kind: "bed" | "pen" | "stall" | "sign"; plot: PlotState; index: number; x: number; y: number };

export function spots(w: World): Spot[] {
  const out: Spot[] = [];
  for (const p of w.plots) {
    const d = deckOrigin(p);
    DECK.beds.forEach((b, i) => out.push({ kind: "bed", plot: p, index: i, x: d.x + b.x + 0.5, y: d.y + b.y + 0.5 }));
    out.push({ kind: "pen", plot: p, index: 0, x: d.x + DECK.pen.x + 2, y: d.y + DECK.pen.y + 2 });
    out.push({ kind: "stall", plot: p, index: 0, x: d.x + DECK.stall.x + 0.5, y: d.y + DECK.stall.y + 0.5 });
    if (p.owner === "you") out.push({ kind: "sign", plot: p, index: 0, x: d.x + DECK.sign.x, y: d.y + DECK.sign.y });
  }
  return out;
}
const REACH: Record<Spot["kind"], number> = { bed: 1.5, pen: 2.9, stall: 1.6, sign: 1.4 };
export function nearestSpot(w: World, x: number, y: number) {
  let best: Spot | null = null, bd = Infinity;
  for (const s of spots(w)) { const d = Math.hypot(s.x - x, s.y - y); if (d <= REACH[s.kind] && d < bd) { bd = d; best = s; } }
  return best;
}
export function spotLabel(w: World, s: Spot): string {
  const mine = s.plot.owner === "you";
  if (s.kind === "sign") return you(w).berth ? "Harbor map" : "Dock your land";
  if (s.kind === "stall") return mine ? "Your stall · sell" : `${s.plot.name} stall`;
  if (s.kind === "pen") return mine ? "Feed your chickens" : "Feed their chickens";
  const plant = s.plot.plants[s.index];
  if (mine && plant.stage >= 3) return "Harvest berries";
  return mine ? "Water plant" : "Water their plant";
}

/** Returns a message describing what happened. */
export function useSpot(w: World, s: Spot): string {
  const mine = s.plot.owner === "you";
  if (s.kind === "bed") {
    const plant = s.plot.plants[s.index];
    if (mine && plant.stage >= 3) {
      const n = Math.round(3 * bonus(w)); w.bag.berry += n; plant.stage = 0; plant.growth = 0; gainXp(w, 6);
      return `Harvested ${n} berries 🫐`;
    }
    const targets = w.bag.can && mine ? s.plot.plants : [plant];
    for (const t of targets) t.water = w.bag.can ? 100 : Math.min(100, t.water + 55);
    if (mine) { gainXp(w, 2); return w.bag.can ? "Golden Can: whole garden watered 🚿" : "Watered 💧"; }
    s.plot.thanks++; gainXp(w, 5); w.credits += 3; w.pet.joy = Math.min(100, w.pet.joy + 4);
    return `Watered ${s.plot.name}'s plant · +3 credits tip (simulated)`;
  }
  if (s.kind === "pen") {
    const hungry = s.plot.animals.reduce((m, a) => (a.hunger < m.hunger ? a : m));
    const food: ItemId | null = w.bag.feed > 0 ? "feed" : w.bag.berry > 0 ? "berry" : null;
    if (!food) return "No feed or berries. Buy feed at a neighbour's stall or harvest berries.";
    w.bag[food]--; hungry.hunger = Math.min(100, hungry.hunger + (food === "feed" ? 50 : 30));
    if (mine) { gainXp(w, 3); return `Fed your chicken with ${ITEMS[food].name}`; }
    s.plot.thanks++; gainXp(w, 8); w.credits += 5; w.pet.joy = Math.min(100, w.pet.joy + 6);
    return `Fed ${s.plot.name}'s chicken · +5 credits tip (simulated)`;
  }
  return "";
}

export function buyFromStall(w: World, item: ItemId): string {
  const it = ITEMS[item];
  if (w.credits < it.price) return "Not enough credits.";
  if ((it.kind === "tool" || it.kind === "hat") && w.bag[item] > 0) return "You already own that.";
  w.credits -= it.price; w.bag[item]++;
  w.burnedRf += (it.price * MARKET_FEE) / CREDITS_PER_RF;
  if (it.kind === "hat" && !w.hat) w.hat = item;
  return `Bought ${it.name}. ${Math.round(it.price * MARKET_FEE * 10) / 10} credit fee burned as RF (simulated).`;
}
export function sellProduce(w: World, item: "berry" | "egg", count = 1): string {
  const n = Math.min(count, w.bag[item]);
  if (!n) return `No ${ITEMS[item].name} to sell.`;
  w.bag[item] -= n; const earned = n * ITEMS[item].price; w.credits += earned;
  w.burnedRf += (earned * MARKET_FEE) / CREDITS_PER_RF;
  return `Sold ${n} ${ITEMS[item].name} for ${earned} credits (5% fee burned, simulated).`;
}
export function buyCredits(w: World, credits: number) {
  w.credits += credits; w.burnedRf += (credits / CREDITS_PER_RF) * BURN_SHARE_PURCHASE;
}
export function dock(w: World, b: Berth): string {
  const mine = you(w);
  if (w.plots.some(p => p !== mine && p.berth && berthKey(p.berth) === berthKey(b))) return "That berth is taken.";
  const price = berthPrice(b);
  if (w.credits < price) return "Not enough credits.";
  w.credits -= price; w.burnedRf += (price / CREDITS_PER_RF) * BURN_SHARE_DOCK;
  mine.berth = b; rebuildTiles(w);
  const n = neighboursOf(w, mine).length;
  return `Docked! ${n} neighbour${n === 1 ? "" : "s"} next door · +${Math.round(n * ADJ_BONUS * 100)}% produce & XP.`;
}
/** Swap in a freshly imported land (e.g. after a retry). */
export function setLand(w: World, land: Land) { you(w).land = land; rebuildTiles(w); }
