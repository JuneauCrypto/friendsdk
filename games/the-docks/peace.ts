/* Peace economy — SIMULATED in this preview. The second economy: make things and trade them.
 *
 *  - Peace land: any island that isn't a war island (a flag's peace islands, and islands in no
 *    flag) produces goods from its peace items: Farm → Grain, Fishery → Fish, Workshop → Tools,
 *    Loom → Cloth, Kiln → Pottery. A Market stall on the island adds MARKET_BOOST to its output.
 *    Goods pile up on the island until its owner collects them.
 *  - Market: sell goods (and your own items) from a peace island at your price. Buyers are
 *    islands docked next to it or bridged to it, or its flag-mates. War islands don't trade.
 *    Islands in no flag trade with each other freely when connected.
 *  - Tax: a sale from a flag's peace island pays TRADE_TAX_BPS to that flag's treasury (its
 *    pool). A sale between islands in no flag pays none. */
import { connected, stanceOf, villageOf, walletOf, type Item, type Plot, type World } from "./world.js";
import { CATALOG, HOUR, YOU, isReady, itemsOn } from "./villages.js";
import type { Economy } from "./launch.js";

export const PEACE = {
  TRADE_TAX_BPS: 500,        // 5% of a sale to the seller's flag treasury
  MARKET_BOOST: 0.2,         // a Market stall on the island: +20% output
  MAX_STOCK_HOURS: 48,       // goods pile up for at most this long before collecting
};
export const GOODS = [
  { name: "Grain", icon: "🌾", base: 8 },
  { name: "Fish", icon: "🐟", base: 12 },
  { name: "Tools", icon: "🔨", base: 30 },
  { name: "Cloth", icon: "🧵", base: 25 },
  { name: "Pottery", icon: "🏺", base: 60 },
];
/** Catalog item name → the good it makes and how many per hour. */
export const PRODUCERS: Record<string, { good: number; perHour: number }> = {
  Farm: { good: 0, perHour: 6 },
  Fishery: { good: 1, perHour: 4 },
  Workshop: { good: 2, perHour: 2 },
  Loom: { good: 3, perHour: 2 },
  Kiln: { good: 4, perHour: 1 },
};

/** Extra output multiplier for an island (its flag Friend's level); set by the game. */
let boostOf: (w: World, p: Plot) => number = () => 1;
export function setPeaceBoost(fn: (w: World, p: Plot) => number) { boostOf = fn; }

export type Listing = { id: number; seller: string; from: Plot; good: number | null; item: Item | null; qty: number; price: number; at: number };
export type Market = {
  inv: Map<string, number[]>;            // wallet → goods held
  lastCollect: Map<Plot, number>;         // island → last collected
  listings: Listing[]; seq: number;
  sales: { good: string; qty: number; total: number; tax: number; buyer: string; seller: string; at: number }[];
};
export const newMarket = (): Market => ({ inv: new Map(), lastCollect: new Map(), listings: [], seq: 0, sales: [] });
export const invOf = (m: Market, who: string) => { let v = m.inv.get(who); if (!v) { v = GOODS.map(() => 0); m.inv.set(who, v); } return v; };

/** Peace land: not a war island. */
export const peaceful = (w: World, p: Plot) => stanceOf(w, p) !== "war";
/** Goods per hour an island makes now (built producers; war islands make nothing). */
export function outputOf(w: World, p: Plot, now = Date.now()) {
  const out = GOODS.map(() => 0);
  if (!peaceful(w, p)) return out;
  const items = itemsOn(w, p).filter(it => isReady(it, now));
  const boost = (items.some(it => CATALOG[it.kind].name === "Market stall") ? 1 + PEACE.MARKET_BOOST : 1) * boostOf(w, p);
  for (const it of items) { const pr = PRODUCERS[CATALOG[it.kind].name]; if (pr) out[pr.good] += pr.perHour * boost; }
  return out;
}
/** Goods waiting on the island since it was last collected. */
export function waiting(w: World, m: Market, p: Plot, now = Date.now()) {
  const since = m.lastCollect.get(p) ?? now;
  const hours = Math.min(PEACE.MAX_STOCK_HOURS, Math.max(0, (now - since) / HOUR));
  return outputOf(w, p, now).map(r => Math.floor(r * hours));
}
/** Start the clock on an island's producers (called when an island is first seen). */
export function track(m: Market, p: Plot, now = Date.now()) { if (!m.lastCollect.has(p)) m.lastCollect.set(p, now); }
export function collect(w: World, m: Market, p: Plot, who = YOU, now = Date.now()) {
  if (!peaceful(w, p)) throw new Error(`${p.name} is a war island: it doesn't produce.`);
  const got = waiting(w, m, p, now), inv = invOf(m, who);
  got.forEach((n, i) => { inv[i] += n; });
  m.lastCollect.set(p, now);
  return got;
}

/** Can `buyer` (an island) trade with `from`? Null if yes. */
export function tradeProblem(w: World, buyer: Plot, from: Plot): string | null {
  if (!peaceful(w, from)) return `${from.name} is a war island: no trading.`;
  if (!peaceful(w, buyer)) return `${buyer.name} is a war island: trade from a peace island.`;
  if (buyer === from || connected(w, buyer, from)) return null;
  const f = villageOf(w, from); if (f && villageOf(w, buyer) === f) return null;
  return `Dock next to ${from.name} (or bridge to it) to trade.`;
}
/** The first of `mine` that can buy from `from`, or null. */
export const buyerFor = (w: World, mine: Plot[], from: Plot) => mine.find(p => !tradeProblem(w, p, from)) ?? null;

/** List goods (or one of your own items) for sale from one of your peace islands. */
export function list(w: World, m: Market, from: Plot, what: { good: number } | { item: Item }, qty: number, price: number, who = YOU): Listing {
  if (!peaceful(w, from)) throw new Error(`${from.name} is a war island: sell from a peace island.`);
  if (!(price > 0)) throw new Error("Set a price.");
  let good: number | null = null, item: Item | null = null;
  if ("good" in what) {
    const inv = invOf(m, who); good = what.good;
    if (!(qty >= 1) || inv[good] < qty) throw new Error(`You have ${inv[good]} ${GOODS[good].name}.`);
    inv[good] -= qty;
  } else {
    item = what.item; qty = 1;
    if (item.owner !== who) throw new Error("Only your own items can be sold.");
    if (m.listings.some(l => l.item === item)) throw new Error("It's already listed.");
    item.plot = null;
  }
  const l: Listing = { id: m.seq++, seller: who, from, good, item, qty, price, at: Date.now() };
  m.listings.push(l); w.version++; return l;
}
export function unlist(w: World, m: Market, l: Listing, who = YOU) {
  if (l.seller !== who) throw new Error("Not your listing.");
  if (l.good !== null) invOf(m, who)[l.good] += l.qty;
  m.listings = m.listings.filter(x => x !== l); w.version++;
}
const nameOf = (l: Listing) => l.good !== null ? GOODS[l.good].name : CATALOG[l.item!.kind].name;
/** Buy `qty` of a listing. The tax goes to the seller island's flag treasury (its pool). */
export function buy(w: World, m: Market, e: Economy | null, l: Listing, qty: number, buyer: Plot, who = YOU, sellerEcon: Economy | null = null) {
  const why = tradeProblem(w, buyer, l.from); if (why) throw new Error(why);
  if (l.seller === who) throw new Error("That's your own listing.");
  qty = Math.min(l.qty, Math.max(1, Math.floor(qty)));
  const total = qty * l.price;
  if (e && e.rf < total) throw new Error(`That costs ${total.toLocaleString()} RF; you have ${Math.floor(e.rf).toLocaleString()}.`);
  if (e) e.rf -= total;
  const f = villageOf(w, l.from), tax = f ? Math.floor(total * PEACE.TRADE_TAX_BPS / 10_000) : 0;
  if (f) f.pendingLiquidity += tax;
  if (sellerEcon) sellerEcon.rf += total - tax;
  if (l.good !== null) invOf(m, who)[l.good] += qty;
  else { l.item!.owner = who; l.item!.village = null; }
  l.qty -= qty; if (l.qty <= 0) m.listings = m.listings.filter(x => x !== l);
  m.sales.push({ good: nameOf(l), qty, total, tax, buyer: who, seller: l.seller, at: Date.now() });
  w.version++;
  return { total, tax, flag: f?.name ?? null, village: f };
}
/** Sample islands post goods for sale from their peace land (simulated market makers). */
export function sampleListings(w: World, m: Market, rand = Math.random) {
  for (const p of w.plots) {
    if (p.mine || !p.friends.length || !peaceful(w, p) || m.listings.some(l => l.from === p)) continue;
    const g = Math.floor(rand() * GOODS.length);
    m.listings.push({ id: m.seq++, seller: walletOf(p), from: p, good: g, item: null, qty: 5 + Math.floor(rand() * 20), price: Math.round(GOODS[g].base * (0.8 + rand() * 0.6)), at: Date.now() });
  }
  w.version++;
}
