/* The Docks — world layout and game rules. Pure logic, no rendering.
 * Everything here is simulated and session-only (the SDK sandbox has no storage). */

export const PLOT = 10;          // plot is PLOT × PLOT tiles
export const GAP = 3;            // water channel between berths
export const GRID = 3;           // 3 × 3 berths
export const MARGIN = 2;
export const HARBOR_Y = MARGIN + GRID * PLOT + (GRID - 1) * GAP + 4; // where an undocked plot drifts
export const WORLD_W = MARGIN * 2 + GRID * PLOT + (GRID - 1) * GAP;
export const WORLD_H = HARBOR_Y + PLOT + MARGIN;

export const CREDITS_PER_RF = 100;       // simulated: 100 credits = 1 RF of purchase value
export const BURN_SHARE_PURCHASE = 0.5;  // share of credit purchases that buys & burns RF
export const BURN_SHARE_DOCK = 0.5;      // share of docking fees burned
export const MARKET_FEE = 0.05;          // stall-sale fee, burned
export const ADJ_BONUS = 0.25;           // +25% produce & XP per adjacent docked neighbour

export type Tile = 0 | 1 | 2 | 3;        // water, ground, blocked, plank
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
  berry: { name: "Dock Berries", icon: "🫐", price: 6, kind: "produce", blurb: "Grown in gardens. Sell, feed your Friend or animals" },
  egg: { name: "Fresh Egg", icon: "🥚", price: 12, kind: "produce", blurb: "Laid by well-fed chickens. Sell at your stall" },
};

export type PlotState = {
  id: string; name: string; owner: "you" | "neighbour"; color: number; roof: number;
  berth: Berth | null;                  // null = adrift in the harbor (yours, before docking)
  plants: Plant[]; animals: Animal[]; stall: ItemId[];
  thanks: number;                       // times you helped this neighbour
};

export type Pet = { hunger: number; joy: number; kibbleAt: number };

export type World = {
  plots: PlotState[]; tiles: Tile[]; credits: number; burnedRf: number; xp: number; level: number;
  bag: Record<ItemId, number>; hat: ItemId | null; pet: Pet; log: string[]; charmBoost: number;
};

/** Plot-local layout (tile coordinates inside a 10 × 10 plot). */
export const LAYOUT = {
  house: { x: 1, y: 1, w: 3, h: 3 }, door: { x: 2, y: 4 },
  beds: [{ x: 6, y: 1 }, { x: 7, y: 1 }, { x: 8, y: 1 }],
  pen: { x: 5, y: 5, w: 4, h: 4 },           // fence ring; inside 6..7
  stall: { x: 1, y: 7 },
};

export const berthOrigin = (b: Berth) => ({ x: MARGIN + b.bx * (PLOT + GAP), y: MARGIN + b.by * (PLOT + GAP) });
export const plotOrigin = (p: PlotState) => p.berth ? berthOrigin(p.berth) : { x: Math.floor((WORLD_W - PLOT) / 2), y: HARBOR_Y };
export const berthKey = (b: Berth) => `${b.bx},${b.by}`;
export const berthPrice = (b: Berth) => (b.bx === 1 && b.by === 1 ? 250 : 100);

const mulberry = (seed: number) => () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

function newAnimals(rand: () => number, count: number): Animal[] {
  return Array.from({ length: count }, () => ({ hunger: 40 + rand() * 40, lay: rand() * 20, x: 6.5, y: 6.5, tx: 6.5, ty: 6.5 }));
}

/** Sample neighbours are fictional and clearly labelled in the UI. */
export function createWorld(friendId: bigint): World {
  const rand = mulberry(Number(friendId % 2147483647n) || 1);
  const neighbours: [string, Berth, number, number][] = [
    ["Pip's Orchard", { bx: 1, by: 0 }, 0x9bd17a, 0xd9544f],
    ["Juniper Wharf", { bx: 0, by: 1 }, 0x8fcf8a, 0x4f7dd9],
    ["Rook's Roost", { bx: 2, by: 1 }, 0xa6d58c, 0x8a5bd6],
    ["Moss Landing", { bx: 0, by: 2 }, 0x93c97f, 0xe0a13b],
  ];
  const plots: PlotState[] = [
    { id: "you", name: "Your land", owner: "you", color: 0xa8dd83, roof: 0xff7a59, berth: null,
      plants: LAYOUT.beds.map(() => ({ stage: 1, growth: 0, water: 60 })), animals: newAnimals(rand, 1), stall: [], thanks: 0 },
    ...neighbours.map(([name, berth, color, roof], i) => ({
      id: `n${i}`, name, owner: "neighbour" as const, color, roof, berth,
      plants: LAYOUT.beds.map(() => ({ stage: Math.floor(rand() * 3), growth: rand(), water: 5 + rand() * 30 })),
      animals: newAnimals(rand, 1 + (i % 2)),
      stall: [(["feed", "fert", "can"] as ItemId[])[i % 3], (["cap", "crown", "feed", "fert"] as ItemId[])[i]],
      thanks: 0,
    })),
  ];
  const world: World = { plots, tiles: [], credits: 300, burnedRf: 0, xp: 0, level: 1,
    bag: { feed: 2, fert: 1, can: 0, cap: 0, crown: 0, berry: 2, egg: 0 }, hat: null,
    pet: { hunger: 70, joy: 65, kibbleAt: 0 }, log: [], charmBoost: 0 };
  rebuildTiles(world);
  return world;
}

export const you = (w: World) => w.plots[0];
export const tileAt = (w: World, x: number, y: number): Tile =>
  x < 0 || y < 0 || x >= WORLD_W || y >= WORLD_H ? 0 : w.tiles[Math.floor(y) * WORLD_W + Math.floor(x)];
export const walkable = (w: World, x: number, y: number) => { const t = tileAt(w, x, y); return t === 1 || t === 3; };

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

/** Tile map: plots are ground; house, fence and beds block; planks bridge adjacent docked plots. */
export function rebuildTiles(w: World) {
  const t: Tile[] = new Array(WORLD_W * WORLD_H).fill(0);
  const set = (x: number, y: number, v: Tile) => { if (x >= 0 && y >= 0 && x < WORLD_W && y < WORLD_H) t[y * WORLD_W + x] = v; };
  for (const p of w.plots) {
    const o = plotOrigin(p);
    for (let y = 0; y < PLOT; y++) for (let x = 0; x < PLOT; x++) set(o.x + x, o.y + y, 1);
    const h = LAYOUT.house;
    for (let y = 0; y < h.h; y++) for (let x = 0; x < h.w; x++) set(o.x + h.x + x, o.y + h.y + y, 2);
    for (const b of LAYOUT.beds) set(o.x + b.x, o.y + b.y, 2);
    const pen = LAYOUT.pen;
    for (let i = 0; i < pen.w; i++) { set(o.x + pen.x + i, o.y + pen.y, 2); set(o.x + pen.x + i, o.y + pen.y + pen.h - 1, 2); }
    for (let i = 0; i < pen.h; i++) { set(o.x + pen.x, o.y + pen.y + i, 2); set(o.x + pen.x + pen.w - 1, o.y + pen.y + i, 2); }
    set(o.x + LAYOUT.stall.x, o.y + LAYOUT.stall.y, 2);
  }
  // bridges between horizontally / vertically adjacent docked plots
  for (const a of w.plots) for (const b of w.plots) {
    if (!a.berth || !b.berth) continue;
    const oa = berthOrigin(a.berth);
    if (b.berth.bx === a.berth.bx + 1 && b.berth.by === a.berth.by)
      for (let x = PLOT; x < PLOT + GAP; x++) for (const y of [4, 5]) set(oa.x + x, oa.y + y, 3);
    if (b.berth.by === a.berth.by + 1 && b.berth.bx === a.berth.bx)
      for (let y = PLOT; y < PLOT + GAP; y++) for (const x of [4, 5]) set(oa.x + x, oa.y + y, 3);
  }
  w.tiles = t;
}

export function xpForLevel(level: number) { return 60 + level * 40; }
export function gainXp(w: World, amount: number) {
  const mood = (w.pet.hunger + w.pet.joy) / 200;
  w.xp += amount * bonus(w) * (0.5 + mood) * (1 + w.charmBoost);
  let levelled = false;
  while (w.xp >= xpForLevel(w.level)) { w.xp -= xpForLevel(w.level); w.level++; levelled = true; }
  return levelled;
}

/** Advance simulation by dt seconds. */
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
      // wander inside the pen interior (6..8 exclusive)
      const dx = a.tx - a.x, dy = a.ty - a.y, d = Math.hypot(dx, dy);
      if (d < 0.05) { a.tx = 6.1 + Math.random() * 1.8; a.ty = 6.1 + Math.random() * 1.8; }
      else { const s = Math.min(d, 0.8 * dt); a.x += (dx / d) * s; a.y += (dy / d) * s; }
    }
  }
}

/* ── Interactions ── */
export type Spot = { kind: "door" | "bed" | "pen" | "stall" | "sign"; plot: PlotState; index: number; x: number; y: number };

export function spots(w: World): Spot[] {
  const out: Spot[] = [];
  for (const p of w.plots) {
    const o = plotOrigin(p);
    if (p.owner === "you") out.push({ kind: "door", plot: p, index: 0, x: o.x + LAYOUT.door.x + 0.5, y: o.y + LAYOUT.door.y + 0.5 });
    LAYOUT.beds.forEach((b, i) => out.push({ kind: "bed", plot: p, index: i, x: o.x + b.x + 0.5, y: o.y + b.y + 0.5 }));
    out.push({ kind: "pen", plot: p, index: 0, x: o.x + LAYOUT.pen.x + 2, y: o.y + LAYOUT.pen.y + 2 });
    out.push({ kind: "stall", plot: p, index: 0, x: o.x + LAYOUT.stall.x + 0.5, y: o.y + LAYOUT.stall.y + 0.5 });
    if (p.owner === "you") out.push({ kind: "sign", plot: p, index: 0, x: o.x + 4.5, y: o.y + 9.2 });
  }
  return out;
}
const REACH: Record<Spot["kind"], number> = { door: 1.3, bed: 1.5, pen: 2.9, stall: 1.6, sign: 1.4 };
export function nearestSpot(w: World, x: number, y: number) {
  let best: Spot | null = null, bd = Infinity;
  for (const s of spots(w)) { const d = Math.hypot(s.x - x, s.y - y); if (d <= REACH[s.kind] && d < bd) { bd = d; best = s; } }
  return best;
}
export function spotLabel(w: World, s: Spot): string {
  const mine = s.plot.owner === "you";
  if (s.kind === "door") return "Go inside";
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
