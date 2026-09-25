/* The Docks — the chain, status and game rules. Pure logic, no rendering.
 * Everything here is simulated and session-only (the SDK sandbox has no storage).
 *
 * Every Friend's land keeps its true on-chain size. Lands attach edge to edge,
 * so the chain grows without limit; there is no fixed grid. */
import { sampleLand, type Land } from "./land.js";

export const DECK_W = 10, DECK_H = 6;

export const CREDITS_PER_RF = 100;       // simulated: 100 credits = 1 RF of purchase value
export const BURN_SHARE_PURCHASE = 0.5;  // share of credit purchases that buys & burns RF
export const BURN_SHARE_DOCK = 0.5;      // share of attach fees burned
export const MARKET_FEE = 0.05;          // stall-sale fee, burned
export const ADJ_BONUS = 0.25;           // +25% produce & XP per land you touch

export const SURF = { water: 0, land: 1, deck: 2, plank: 3 } as const;
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

/** A land plus its deck, as one piece in piece-local tile coordinates. */
export type Piece = {
  w: number; h: number; surface: Uint8Array; blocked: Uint8Array;
  land: { x: number; y: number }; deck: { x: number; y: number };
};
export type PlotState = {
  id: string; name: string; owner: "you" | "neighbour"; accent: number;
  land: Land; piece: Piece;
  pos: { x: number; y: number };        // world position of the piece's top-left tile
  attached: boolean;                     // false = adrift (yours, before attaching)
  plants: Plant[]; animals: Animal[]; stall: ItemId[];
  thanks: number; development: number;   // development points (samples: fixed; yours: computed)
};
export type Pet = { hunger: number; joy: number; kibbleAt: number };
export type World = {
  plots: PlotState[];
  credits: number; burnedRf: number; xp: number; level: number;
  bag: Record<ItemId, number>; hat: ItemId | null; pet: Pet; log: string[]; charmBoost: number;
  version: number;                       // bumps whenever the chain layout changes
};

/** Deck-local layout (tiles inside the 10 × 6 deck). */
export const DECK = {
  beds: [{ x: 1, y: 1 }, { x: 2, y: 1 }, { x: 3, y: 1 }],
  pen: { x: 5, y: 1, w: 4, h: 4 },           // fence ring; interior x 6..7, y 2..3
  stall: { x: 1, y: 4 },
  sign: { x: 4.5, y: 5.4 },
};

const TINY = /tiny|sprout|flower|reeds/;
/** Build the piece: land on top, deck centred underneath, joined by a short gangway if needed. */
export function buildPiece(land: Land): Piece {
  const w = Math.max(land.w, DECK_W);
  const lx = Math.floor((w - land.w) / 2), dx = Math.floor((w - DECK_W) / 2);
  // the deck sits one row below the land's lowest tile in the deck's middle columns (or the bbox bottom)
  const cols = [dx + 4, dx + 5].map(c => c - lx);
  let bottom = -1;
  for (const c of cols) for (let y = land.h - 1; y >= 0; y--) if (c >= 0 && c < land.w && land.tiles[y * land.w + c]) { bottom = Math.max(bottom, y); break; }
  const dy = bottom >= 0 ? bottom + 1 : land.h + 1;
  const h = Math.max(land.h, dy + DECK_H);
  const surface = new Uint8Array(w * h), blocked = new Uint8Array(w * h);
  const set = (x: number, y: number, v: number) => { if (x >= 0 && y >= 0 && x < w && y < h) surface[y * w + x] = v; };
  const block = (x: number, y: number) => { if (x >= 0 && y >= 0 && x < w && y < h) blocked[y * w + x] = 1; };
  land.tiles.forEach((t, i) => { if (t) set(lx + (i % land.w), Math.floor(i / land.w), SURF.land); });
  for (let y = 0; y < DECK_H; y++) for (let x = 0; x < DECK_W; x++) if (!surface[(dy + y) * w + dx + x]) set(dx + x, dy + y, SURF.deck);
  if (bottom < 0) for (const c of [dx + 4, dx + 5]) for (let y = dy - 1; y >= 0 && surface[y * w + c] !== SURF.land; y--) set(c, y, SURF.plank);
  for (const pr of land.props) if (!TINY.test(pr.name)) block(lx + Math.floor(pr.x), Math.floor(pr.y));
  for (const b of DECK.beds) block(dx + b.x, dy + b.y);
  const pen = DECK.pen;
  for (let i = 0; i < pen.w; i++) { block(dx + pen.x + i, dy + pen.y); block(dx + pen.x + i, dy + pen.y + pen.h - 1); }
  for (let i = 0; i < pen.h; i++) { block(dx + pen.x, dy + pen.y + i); block(dx + pen.x + pen.w - 1, dy + pen.y + i); }
  block(dx + DECK.stall.x, dy + DECK.stall.y);
  return { w, h, surface, blocked, land: { x: lx, y: 0 }, deck: { x: dx, y: dy } };
}

export const landOrigin = (p: PlotState) => ({ x: p.pos.x + p.piece.land.x, y: p.pos.y + p.piece.land.y });
export const deckOrigin = (p: PlotState) => ({ x: p.pos.x + p.piece.deck.x, y: p.pos.y + p.piece.deck.y });

const mulberry = (seed: number) => () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const newAnimals = (rand: () => number, n: number): Animal[] => Array.from({ length: n }, () => ({ hunger: 40 + rand() * 40, lay: rand() * 20, x: 7, y: 3, tx: 7, ty: 3 }));

/* ── Status: weight (land size) + development ── */
export const STATUS_TIERS = [
  { min: 0, name: "Drifter", color: 0xbfbfbf },
  { min: 120, name: "Settler", color: 0x7db4db },
  { min: 260, name: "Merchant", color: 0xccff00 },
  { min: 450, name: "Harbor Master", color: 0xf2ce68 },
  { min: 700, name: "Admiral", color: 0xed927e },
] as const;
export const landWeight = (p: PlotState) => p.land.tiles.filter(Boolean).length;
export function developmentOf(w: World, p: PlotState) {
  if (p.owner !== "you") return p.development;
  const kept = w.bag.can * 40 + (w.bag.cap + w.bag.crown) * 30;
  return Math.round((w.level - 1) * 25 + kept + touching(w, p).length * 30 + Math.min(80, w.burnedRf * 10));
}
export function statusOf(w: World, p: PlotState) {
  const weight = landWeight(p), development = developmentOf(w, p), score = weight + development;
  let tier = 0; STATUS_TIERS.forEach((t, i) => { if (score >= t.min) tier = i; });
  const next = STATUS_TIERS[tier + 1];
  return { weight, development, score, tier, name: STATUS_TIERS[tier].name, color: STATUS_TIERS[tier].color, next: next ? next.min - score : 0 };
}
export const statusBonus = (w: World) => 0.1 * statusOf(w, you(w)).tier;

/* ── Chain geometry ── */
type Occ = Map<string, PlotState>;
const key = (x: number, y: number) => `${x},${y}`;
function occupancy(w: World, except?: PlotState): Occ {
  const occ: Occ = new Map();
  for (const p of w.plots) {
    if (p === except || !p.attached) continue;
    for (let y = 0; y < p.piece.h; y++) for (let x = 0; x < p.piece.w; x++)
      if (p.piece.surface[y * p.piece.w + x]) occ.set(key(p.pos.x + x, p.pos.y + y), p);
  }
  return occ;
}
function fit(piece: Piece, x0: number, y0: number, occ: Occ) {
  const touches = new Set<PlotState>(); let contact = 0;
  for (let y = 0; y < piece.h; y++) for (let x = 0; x < piece.w; x++) {
    if (!piece.surface[y * piece.w + x]) continue;
    const X = x0 + x, Y = y0 + y;
    if (occ.has(key(X, Y))) return null;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const o = occ.get(key(X + dx, Y + dy));
      if (o) { touches.add(o); contact++; }
    }
  }
  return { touches: [...touches], contact };
}
export type Slot = { x: number; y: number; touches: PlotState[]; contact: number; price: number };
/** Every place the piece can attach: slide it along each attached land's four sides until it touches. */
export function attachSlots(w: World, plot: PlotState): Slot[] {
  const occ = occupancy(w, plot), pc = plot.piece, out = new Map<string, Slot>();
  for (const q of w.plots) {
    if (q === plot || !q.attached) continue;
    const Q = q.pos, qw = q.piece.w, qh = q.piece.h;
    const tries: [number, number, number, number][] = [];   // start x, y, and the direction to slide in
    for (let o = -pc.h + 2; o < qh - 1; o += 2) { tries.push([Q.x + qw, Q.y + o, -1, 0]); tries.push([Q.x - pc.w, Q.y + o, 1, 0]); }
    for (let o = -pc.w + 2; o < qw - 1; o += 2) { tries.push([Q.x + o, Q.y + qh, 0, -1]); tries.push([Q.x + o, Q.y - pc.h, 0, 1]); }
    for (let [x, y, dx, dy] of tries) {
      let best = fit(pc, x, y, occ);
      if (!best) continue;
      for (let s = 0; s < 8 && best && best.contact === 0; s++) { const n = fit(pc, x + dx, y + dy, occ); if (!n) break; x += dx; y += dy; best = n; }
      if (!best || best.contact < 2) continue;
      const k = key(x, y);
      if (!out.has(k)) out.set(k, { x, y, touches: best.touches, contact: best.contact, price: 60 + 60 * best.touches.length + Math.min(120, best.contact * 2) });
    }
  }
  // keep the best-connected slots, spread around the chain
  const sorted = [...out.values()].sort((a, b) => b.touches.length - a.touches.length || b.contact - a.contact);
  const picked: Slot[] = [];
  for (const s of sorted) {
    if (picked.some(q => Math.abs(q.x - s.x) < pc.w * 0.6 && Math.abs(q.y - s.y) < pc.h * 0.6)) continue;
    picked.push(s); if (picked.length >= 8) break;
  }
  return picked;
}
const touchCache = new WeakMap<PlotState, { v: number; x: number; y: number; t: PlotState[] }>();
export function touching(w: World, p: PlotState) {
  if (!p.attached) return [];
  const c = touchCache.get(p);
  if (c && c.v === w.version && c.x === p.pos.x && c.y === p.pos.y) return c.t;
  const occ = occupancy(w, p), res = fit(p.piece, p.pos.x, p.pos.y, occ), t = res ? res.touches : [];
  touchCache.set(p, { v: w.version, x: p.pos.x, y: p.pos.y, t });
  return t;
}
export const bonus = (w: World) => 1 + ADJ_BONUS * touching(w, you(w)).length + statusBonus(w);

export function chainBounds(w: World) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of w.plots) { if (!p.attached) continue; x0 = Math.min(x0, p.pos.x); y0 = Math.min(y0, p.pos.y); x1 = Math.max(x1, p.pos.x + p.piece.w); y1 = Math.max(y1, p.pos.y + p.piece.h); }
  return { x0, y0, x1, y1 };
}

/** `land` is the player's imported on-chain land (or a stand-in). Neighbours are fictional samples. */
export function createWorld(friendId: bigint, land: Land): World {
  const rand = mulberry(Number(friendId % 2147483647n) || 1);
  // sample lands at true size, from a big generation-2-style land down to a tiny gen-6 one
  const samples: [string, string, string, number, number, number, number][] = [
    ["Harbor Heights", "Garden", "Dither", 13, 11, 0xccff00, 260],
    ["Pip's Orchard", "Garden", "Plain", 9, 8, 0xb9d984, 120],
    ["Juniper Wharf", "Coastal", "Plain", 6, 6, 0x7db4db, 60],
    ["Rook's Roost", "Rooftop", "Cross Grid", 9, 8, 0xb3a0d8, 200],
    ["Moss Landing", "Mineral", "Hatch", 4, 4, 0xf2ce68, 40],
    ["Quill Quay", "Reading", "Plain", 6, 6, 0xed927e, 90],
    ["Tinker Pier", "Industrial", "Dither", 9, 8, 0xd9d9d9, 150],
    ["Buoy Nook", "Coastal", "Hatch", 2, 2, 0x7db4db, 10],
  ];
  const world: World = { plots: [], credits: 300, burnedRf: 0, xp: 0, level: 1,
    bag: { feed: 2, fert: 1, can: 0, cap: 0, crown: 0, berry: 2, egg: 0 }, hat: null,
    pet: { hunger: 70, joy: 65, kibbleAt: 0 }, log: [], charmBoost: 0, version: 0 };
  samples.forEach(([name, scenery, floor, cw, ch, accent, dev], i) => {
    const l = sampleLand(1000 + i * 77, scenery, floor, cw, ch);
    const p: PlotState = { id: `n${i}`, name, owner: "neighbour", accent, land: l, piece: buildPiece(l), pos: { x: 0, y: 0 }, attached: false,
      plants: DECK.beds.map(() => ({ stage: Math.floor(rand() * 3), growth: rand(), water: 5 + rand() * 30 })),
      animals: newAnimals(rand, 1 + (i % 2)),
      stall: [(["feed", "fert", "can"] as ItemId[])[i % 3], (["cap", "crown", "feed", "fert"] as ItemId[])[i % 4]],
      thanks: 0, development: dev };
    if (i > 0) {
      // grow the sample chain deterministically: pick a slot that keeps it compact
      world.plots.push(p);
      const slots = attachSlots(world, p);
      const pick = slots[Math.floor(rand() * Math.min(3, slots.length))];
      if (pick) p.pos = { x: pick.x, y: pick.y };
      p.attached = true;
      return;
    }
    p.attached = true; world.plots.push(p);
  });
  const mine: PlotState = { id: "you", name: "Your land", owner: "you", accent: 0xccff00, land, piece: buildPiece(land), pos: { x: 0, y: 0 }, attached: false,
    plants: DECK.beds.map(() => ({ stage: 1, growth: 0, water: 60 })), animals: newAnimals(rand, 1), stall: [], thanks: 0, development: 0 };
  world.plots.unshift(mine);
  placeAdrift(world);
  return world;
}
/** Float the player's piece just off the chain until they attach. */
export function placeAdrift(w: World) {
  const b = chainBounds(w), me = you(w);
  me.attached = false; me.pos = { x: Math.round((b.x0 + b.x1) / 2 - me.piece.w / 2), y: b.y1 + 6 };
}

export const you = (w: World) => w.plots[0];
export function surfaceAt(w: World, x: number, y: number): { surf: number; blocked: boolean; plot: PlotState | null } {
  const tx = Math.floor(x), ty = Math.floor(y);
  for (const p of w.plots) {
    const lx = tx - p.pos.x, ly = ty - p.pos.y;
    if (lx < 0 || ly < 0 || lx >= p.piece.w || ly >= p.piece.h) continue;
    const i = ly * p.piece.w + lx;
    if (p.piece.surface[i]) return { surf: p.piece.surface[i], blocked: Boolean(p.piece.blocked[i]), plot: p };
  }
  return { surf: SURF.water, blocked: false, plot: null };
}
export const walkable = (w: World, x: number, y: number) => { const s = surfaceAt(w, x, y); return s.surf !== SURF.water && !s.blocked; };

export function spawnPoint(w: World, p: PlotState) {
  const o = landOrigin(p), cx = o.x + p.land.w / 2, cy = o.y + p.land.h / 2;
  let best = { x: cx, y: cy }, bd = Infinity;
  for (let y = 0; y < p.land.h; y++) for (let x = 0; x < p.land.w; x++) {
    const tx = o.x + x + 0.5, ty = o.y + y + 0.5;
    if (!walkable(w, tx, ty)) continue;
    const d = Math.hypot(tx - cx, ty - cy);
    if (d < bd) { bd = d; best = { x: tx, y: ty }; }
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
  if (s.kind === "sign") return you(w).attached ? "Chain map" : "Attach your land";
  if (s.kind === "stall") return mine ? "Your stall · sell" : `${s.plot.name} stall`;
  if (s.kind === "pen") return mine ? "Feed your chickens" : "Feed their chickens";
  const plant = s.plot.plants[s.index];
  if (mine && plant.stage >= 3) return "Harvest berries";
  return mine ? "Water plant" : "Water their plant";
}
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
export function attach(w: World, slot: Slot): string {
  const me = you(w);
  if (w.credits < slot.price) return "Not enough credits.";
  const check = attachSlots(w, me).find(s => s.x === slot.x && s.y === slot.y);
  if (!check) return "That spot is no longer free.";
  w.credits -= slot.price; w.burnedRf += (slot.price / CREDITS_PER_RF) * BURN_SHARE_DOCK;
  me.pos = { x: slot.x, y: slot.y }; me.attached = true; w.version++;
  const n = touching(w, me).length;
  return `Attached! Touching ${n} land${n === 1 ? "" : "s"} · +${Math.round(n * ADJ_BONUS * 100)}% produce & rep.`;
}
export function detach(w: World) { placeAdrift(w); w.version++; }
/** Swap in a freshly imported land (e.g. after the on-chain read finishes). */
export function setLand(w: World, land: Land) {
  const me = you(w); me.land = land; me.piece = buildPiece(land);
  if (me.attached) {
    // the real land may be a different size: re-seat it at the nearest free slot
    const slots = attachSlots(w, me), here = me.pos;
    if (!slots.some(s => s.x === here.x && s.y === here.y)) {
      const best = slots.sort((a, b) => Math.hypot(a.x - here.x, a.y - here.y) - Math.hypot(b.x - here.x, b.y - here.y))[0];
      if (best) me.pos = { x: best.x, y: best.y }; else placeAdrift(w);
    }
  } else placeAdrift(w);
  w.version++;
}
