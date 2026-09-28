/* Token launches — SIMULATED in this preview. Mirrors contracts/src/docks/DocksLaunchpad.sol:
 * 1,000 RF per launch; fixed supply, no owner; airdrops and claims land in the Friend's own
 * wallet; every claim costs the launch's RF price. Like every fee in The Docks, launch fees and
 * claim prices go to a permanent RF/ETH pool (the island's village's, or the shared Docks pool):
 * nothing is burned; the pools' trading fees buy RF to build with. */
import { connected, villageOf, type Plot, type World } from "./world.js";

export const LAUNCH_FEE = 1000;
export const START_RF = 5000;                                   // simulated RF for the preview
export type Scope = "anyDocked" | "holderPlot" | "plotAndNeighbours" | "visitors" | "village";
export const SCOPES: { id: Scope; label: string; hint: string }[] = [
  { id: "holderPlot", label: "My island", hint: "only Friends on the launching island" },
  { id: "plotAndNeighbours", label: "My island + neighbours", hint: "plus every island docked next to it or bridged to it" },
  { id: "village", label: "My village", hint: "every island under your village's flag" },
  { id: "visitors", label: "Visitors", hint: "islands allowed onto the launching island (open, or approved)" },
  { id: "anyDocked", label: "Everyone docked", hint: "any Friend on a docked island" },
];
export type Launch = {
  id: number; name: string; symbol: string; supply: number; creator: Plot; creatorFriend: bigint;
  scope: Scope; claimEach: number; claimPrice: number; claimRemaining: number; claimed: Set<bigint>;
};
export type Economy = {
  rf: number; pooled: number; docksPool: number; docksFund: number; platform: number; launches: Launch[];
  /** token balances in each Friend's own wallet: friendId → symbol → amount */
  wallets: Map<bigint, Map<string, number>>;
};
export const createEconomy = (): Economy => ({ rf: START_RF, pooled: 0, docksPool: 0, docksFund: 0, platform: 0, launches: [], wallets: new Map() });
/** Platform fee on every fee: 0 to start, never above 5% (DocksVillageTreasury). */
export const PLATFORM_FEE_BPS = 0;
/** A fee: into the pool of the island's village, or the shared Docks pool (minus the platform fee). */
export function toPool(e: Economy, w: World, p: Plot | null, amount: number) {
  const cut = amount * PLATFORM_FEE_BPS / 10_000, rest = amount - cut, v = p ? villageOf(w, p) : null;
  e.platform += cut; e.pooled += rest;
  if (v) v.pendingLiquidity += rest; else e.docksPool += rest;
}
export const poolName = (w: World, p: Plot | null) => { const v = p ? villageOf(w, p) : null; return v ? `${v.name}'s pool` : "the Docks pool"; };

function credit(e: Economy, id: bigint, symbol: string, amount: number) {
  const w = e.wallets.get(id) ?? new Map<string, number>();
  w.set(symbol, (w.get(symbol) ?? 0) + amount); e.wallets.set(id, w);
}

export function eligibleFriends(w: World, l: Pick<Launch, "scope" | "creator">, canVisit: (p: Plot, host: Plot) => boolean) {
  const out: { plot: Plot; id: bigint }[] = [];
  for (const p of w.plots) {
    const docked = Boolean(p.berth);
    const ok = p === l.creator || (docked && (l.scope === "anyDocked" || (l.scope === "visitors" && canVisit(p, l.creator))
      || (l.scope === "plotAndNeighbours" && connected(w, p, l.creator))
      || (l.scope === "village" && villageOf(w, p) !== null && villageOf(w, p) === villageOf(w, l.creator))));
    if (ok) for (const pl of p.friends) out.push({ plot: p, id: pl.m.id });
  }
  return out;
}

export type LaunchInput = {
  name: string; symbol: string; supply: number; creator: Plot; creatorFriend: bigint;
  airdropScope: Scope | "none"; airdropEach: number; claimScope: Scope; claimPool: number; claimEach: number; claimPrice: number;
};
export function launch(e: Economy, w: World, input: LaunchInput, canVisit: (p: Plot, host: Plot) => boolean): Launch {
  const name = input.name.trim(), symbol = input.symbol.trim().toUpperCase();
  if (!name || !/^[A-Z0-9]{2,8}$/.test(symbol)) throw new Error("Give it a name and a 2–8 letter ticker.");
  if (e.launches.some(l => l.symbol === symbol)) throw new Error(`$${symbol} already exists here.`);
  if (!input.creator.berth) throw new Error("Dock and save your island first: launches come from a Friend on a saved, docked island.");
  if (e.rf < LAUNCH_FEE) throw new Error(`Launching costs ${LAUNCH_FEE.toLocaleString()} RF; you have ${e.rf.toLocaleString()}.`);
  const drop = input.airdropScope === "none" ? [] : eligibleFriends(w, { scope: input.airdropScope, creator: input.creator }, canVisit);
  const dropTotal = drop.length * input.airdropEach;
  if (!(input.supply > 0) || dropTotal + input.claimPool > input.supply) throw new Error("Airdrop + claim pool can't exceed the supply.");
  if ((input.claimPool === 0) !== (input.claimEach === 0) || input.claimEach > input.claimPool) throw new Error("Set both a claim pool and an amount per claim (or neither).");
  e.rf -= LAUNCH_FEE; toPool(e, w, input.creator, LAUNCH_FEE);
  const l: Launch = { id: e.launches.length, name, symbol, supply: input.supply, creator: input.creator, creatorFriend: input.creatorFriend,
    scope: input.claimScope, claimEach: input.claimEach, claimPrice: input.claimPrice, claimRemaining: input.claimPool, claimed: new Set() };
  e.launches.push(l);
  for (const d of drop) credit(e, d.id, symbol, input.airdropEach);
  const rest = input.supply - dropTotal - input.claimPool;
  if (rest > 0) credit(e, input.creatorFriend, symbol, rest);
  return l;
}

/** Sample launches by other plots have their own RF; the player's claims spend the player's RF. */
export function seedLaunch(e: Economy, l: Omit<Launch, "id" | "claimed">) {
  const full: Launch = { ...l, id: e.launches.length, claimed: new Set() };
  e.launches.push(full); credit(e, l.creatorFriend, l.symbol, l.supply - l.claimRemaining);
  return full;
}

export function claim(e: Economy, w: World, l: Launch, friendId: bigint, canVisit: (p: Plot, host: Plot) => boolean) {
  if (l.claimed.has(friendId)) throw new Error(`#${friendId} already claimed $${l.symbol}.`);
  if (l.claimEach === 0 || l.claimRemaining < l.claimEach) throw new Error(`$${l.symbol}'s claim pool is empty.`);
  if (!eligibleFriends(w, l, canVisit).some(x => x.id === friendId)) throw new Error(`#${friendId} isn't eligible for $${l.symbol}.`);
  if (e.rf < l.claimPrice) throw new Error(`Claiming costs ${l.claimPrice} RF.`);
  e.rf -= l.claimPrice; toPool(e, w, l.creator, l.claimPrice);
  l.claimed.add(friendId); l.claimRemaining -= l.claimEach;
  credit(e, friendId, l.symbol, l.claimEach);
}

/** Claim for many of your Friends at once (on chain: DocksLaunchpad.claimMany, chunked). */
export function claimAll(e: Economy, w: World, l: Launch, ids: bigint[], canVisit: (p: Plot, host: Plot) => boolean) {
  const ok = new Set(eligibleFriends(w, l, canVisit).map(x => x.id));
  let n = 0;
  for (const id of ids) {
    if (!ok.has(id) || l.claimed.has(id) || l.claimRemaining < l.claimEach || e.rf < l.claimPrice) continue;
    e.rf -= l.claimPrice; toPool(e, w, l.creator, l.claimPrice); l.claimed.add(id); l.claimRemaining -= l.claimEach;
    credit(e, id, l.symbol, l.claimEach); n++;
  }
  return n;
}

export const fmt = (n: number) => n >= 1e6 ? `${+(n / 1e6).toFixed(2)}M` : n >= 1e4 ? `${+(n / 1e3).toFixed(1)}k` : n.toLocaleString();
