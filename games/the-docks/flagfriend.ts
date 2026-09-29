/* The flag Friend — SIMULATED in this preview. Every flag gets one when it's planted: a
 * character generated from the flag (its look comes from the flag's name and colour, so every
 * flag's is different and the same flag always gets the same one). It belongs to the flag, not
 * to anyone, and it grows with it:
 *  - Upgrade fund: FROM_FOUNDING_BPS of the flag's locked RF at founding, FROM_ENROLL_BPS of every
 *    enrollment fee (the population growing), and its own revenue.
 *  - Its own revenue: it runs the flag's market. TAX_SHARE_BPS of the trade tax on the flag's
 *    peace islands goes to its fund; the rest to the flag's treasury.
 *  - Levels: when the fund covers the next level it levels up on its own. Each level gives the
 *    flag's peace islands PEACE_BOOST_PER_LEVEL more output (more goods, more trade, more tax:
 *    more revenue) and its war islands DEFENSE_PER_LEVEL more defense. At the top level its
 *    fund's overflow goes to the flag's loot vault. */
import type { Village } from "./world.js";

export const FLAG_FRIEND = {
  FROM_FOUNDING_BPS: 500,          // 5% of the founding RF (out of the liquidity half)
  FROM_ENROLL_BPS: 1_000,          // 10% of every enrollment fee
  TAX_SHARE_BPS: 5_000,            // half of the flag's trade tax
  LEVEL_COSTS: [0, 10_000, 40_000, 120_000, 350_000] as number[],   // RF to reach levels 1–5 (level 1 is free)
  PEACE_BOOST_PER_LEVEL: 0.05,
  DEFENSE_PER_LEVEL: 0.03,
  TITLES: ["Sprout", "Keeper", "Warden", "Champion", "Legend"],
};

export type FlagFriend = { name: string; level: number; fund: number; spent: number; earned: number; seed: number };
export type FlagFriends = Map<Village, FlagFriend>;

const hash = (s: string) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
const FIRST = ["Bo", "Ki", "Ra", "Mo", "Lu", "Ze", "Pi", "Ta", "No", "Vi", "Ju", "Fe"];
const LAST = ["dge", "ppo", "nko", "lly", "rin", "mbo", "sk", "xo", "tt", "ndle", "rk", "va"];

/** Plant a flag → its Friend is generated (deterministic from the flag). */
export function spawn(ff: FlagFriends, v: Village) {
  if (ff.has(v)) return ff.get(v)!;
  const seed = hash(`${v.id}|${v.name}`);
  const f: FlagFriend = { name: `${FIRST[seed % FIRST.length]}${LAST[(seed >>> 8) % LAST.length]}`, level: 1, fund: 0, spent: 0, earned: 0, seed };
  ff.set(v, f); return f;
}
export const nextCost = (f: FlagFriend) => FLAG_FRIEND.LEVEL_COSTS[f.level] ?? null;
/** Add RF to its fund and level up while it can. Returns the levels gained and any overflow. */
export function fundIt(f: FlagFriend, rf: number, revenue = false) {
  f.fund += rf; if (revenue) f.earned += rf;
  let gained = 0, overflow = 0;
  for (let c = nextCost(f); c !== null && f.fund >= c; c = nextCost(f)) { f.fund -= c; f.spent += c; f.level++; gained++; }
  if (nextCost(f) === null && f.fund > 0) { overflow = f.fund; f.fund = 0; }
  return { gained, overflow };
}
/** At founding: a share of the founding RF, out of the liquidity half. */
export function onFounded(ff: FlagFriends, v: Village) {
  const f = spawn(ff, v), n = Math.round(v.locked * FLAG_FRIEND.FROM_FOUNDING_BPS / 10_000);
  v.liquidity = Math.max(0, v.liquidity - n);
  return { n, ...fundIt(f, n) };
}
export const title = (f: FlagFriend) => FLAG_FRIEND.TITLES[Math.min(FLAG_FRIEND.TITLES.length, f.level) - 1];
export const peaceBoost = (f: FlagFriend | undefined) => f ? 1 + FLAG_FRIEND.PEACE_BOOST_PER_LEVEL * (f.level - 1) : 1;
export const defenseBoost = (f: FlagFriend | undefined) => f ? 1 + FLAG_FRIEND.DEFENSE_PER_LEVEL * (f.level - 1) : 1;

/** A 12×12 pixel character in the flag's colour, mirrored; it grows a crown, then sparkles, with its level. */
export function art(f: FlagFriend, color: string) {
  let r = f.seed || 1; const rnd = () => { r ^= r << 13; r ^= r >>> 17; r ^= r << 5; return (r >>> 0) / 4294967296; };
  const px: string[] = [];
  for (let y = 2; y < 12; y++) for (let x = 0; x < 6; x++) {
    const edge = Math.abs(x - 5) + Math.abs(y - 7) * 0.8;
    if (rnd() < (edge < 4.2 ? 0.78 : 0.18)) { px.push(`M${x} ${y}h1v1h-1z`, `M${11 - x} ${y}h1v1h-1z`); }
  }
  const eyeY = 4 + Math.floor(rnd() * 3), eyeX = 2 + Math.floor(rnd() * 2);
  const crown = f.level >= 3 ? `<path d="M3 0h1v1h1v-1h2v1h1v-1h1v2h-6z" fill="#ffd400" stroke="#000" stroke-width=".15"/>` : "";
  const spark = f.level >= 5 ? `<path d="M0 1h1v1h-1zM11 3h1v1h-1zM1 11h1v1h-1z" fill="#fff"/>` : "";
  return `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="-0.5 -0.5 13 13" shape-rendering="crispEdges"><path d="${px.join("")}" fill="${color}" stroke="#000" stroke-width=".12"/><path d="M${eyeX} ${eyeY}h1v1h-1zM${11 - eyeX} ${eyeY}h1v1h-1z" fill="#000"/>${crown}${spark}</svg>`)}`;
}
