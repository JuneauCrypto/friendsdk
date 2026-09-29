/* Flag skins and OGs — SIMULATED in this preview (on chain: DocksVillages.skinTier / ogAllotment).
 *  - Skins: a flag's population unlocks its look and its walls: 100, 1,000, 10,000, 100,000 Friends,
 *    then one more tier for every further 100,000. Every tier gives every island in the flag
 *    DEFENSE_PER_TIER more defense (bigger walls, better defenses for everyone in the flag).
 *  - OGs: a flag's founders are its OGs (royalty). Up to OG_CAP of its Friends carry an OG mark,
 *    shared between founders by what each locked into the flag; each founder marks their own
 *    Friends in the flag first, then flag-mates' Friends, strongest first. OGs get more options later (an OG council for peace
 *    deals, mergers and large trades between flags). */
import { rankOf, walletOf, type Plot, type Village } from "./world.js";
import { population } from "./villages.js";

export const SKIN = {
  DEFENSE_PER_TIER: 0.04,
  OG_CAP: 1_000,
  NAMES: ["Plain", "Palisade", "Stone walls", "Citadel", "Fortress city"],
  ICONS: ["", "🪵", "🧱", "🏰", "⚜️"],
};
/** 0 below 100 Friends; 1 at 100, 2 at 1,000, 3 at 10,000, 4 at 100,000, +1 per further 100,000. */
export function skinTier(pop: number) {
  if (pop < 100) return 0; if (pop < 1_000) return 1; if (pop < 10_000) return 2; if (pop < 100_000) return 3;
  return 4 + Math.floor((pop - 100_000) / 100_000);
}
export const tierOfFlag = (v: Village) => v.founded ? skinTier(population(v)) : 0;
export function nextMilestone(pop: number) { return pop < 100 ? 100 : pop < 1_000 ? 1_000 : pop < 10_000 ? 10_000 : pop < 100_000 ? 100_000 : (Math.floor(pop / 100_000) + 1) * 100_000; }
export const skinName = (t: number) => t < SKIN.NAMES.length ? SKIN.NAMES[t] : `Empire ${"★".repeat(Math.min(5, t - 3))}`;
export const skinIcon = (t: number) => t < SKIN.ICONS.length ? SKIN.ICONS[t] : "🌟";
export const defenseBoost = (t: number) => 1 + SKIN.DEFENSE_PER_TIER * t;

/** How many OG marks each founder gets: min(OG_CAP, population) × their share of the lock. */
export function ogAllotment(v: Village) {
  const slots = Math.min(SKIN.OG_CAP, population(v)), out = new Map<string, number>();
  if (!v.founded || !v.locked) return out;
  for (const [who, amt] of v.lockers) out.set(who, Math.floor(slots * amt / v.locked));
  return out;
}
/** The OG Friends. Each founder hands out their allotment: their own Friends in the flag first,
 *  then flag-mates' Friends, strongest first (founders will pick by hand later). */
export function ogFriends(v: Village) {
  const og = new Map<bigint, string>(), allot = ogAllotment(v);
  const strong = (a: { gen: number; tier: number; id: bigint }, b: { gen: number; tier: number; id: bigint }) => a.gen - b.gen || b.tier - a.tier || (a.id < b.id ? -1 : 1);
  const everyone = v.members.flatMap(p => p.friends.map(pl => pl.m)).sort(strong);
  for (const [who, n] of [...allot].sort((a, b) => b[1] - a[1])) {
    let left = n;
    const own = v.members.filter((p: Plot) => walletOf(p) === who).flatMap(p => p.friends.map(pl => pl.m)).sort(strong);
    for (const m of [...own, ...everyone]) { if (left <= 0) break; if (!og.has(m.id)) { og.set(m.id, who); left--; } }
  }
  return og;
}
/** A flag's strength at a glance, for its card. */
export const flagWeight = (v: Village) => v.members.reduce((s, p) => s + rankOf(p).weight, 0);
