/* Villages — SIMULATED in this preview. Mirrors contracts/src/docks/DocksVillages.sol,
 * DocksVillageTreasury.sol and DocksUniV3Liquidity.sol:
 *  - plant a flag and lock the first RF; anyone locks more until FLAG_TARGET (a setting);
 *  - every locker holds a soulbound founder mark = the RF they locked = their vote weight;
 *  - full → founded: half the RF to the village treasury (RF only), half as permanent one-sided
 *    RF/ETH liquidity that earns trading fees; nothing can be withdrawn, so it can't be rugged;
 *  - harvest: fees are collected, the ETH part buys back RF, BURN share burned (half by default),
 *    the rest fills the treasury;
 *  - not full by the deadline → everyone takes their RF back.
 * Founders vote with their weight: spend treasury RF (e.g. marketplace upgrades) or change the
 * burn share. */
import { flagProblem, newVillage, type Plot, type Proposal, type Village, type World } from "./world.js";
import type { Economy } from "./launch.js";

export const FLAG_TARGET = 1_000_000;                 // RF to fill a flag (a contract setting)
export const FLAG_DAYS = 30;                          // days a flag has to fill
export const MIN_LOCK = 1_000;                        // smallest lock (unless it fills the flag)
export const FOUNDING_GRACE_DAYS = 7;
export const VOTE_DAYS = 3;
export const QUORUM = 0.2;                            // share of founder weight that must vote
export const RF_PER_ETH = 100_000;                    // simulated price for the buyback
export const YOU = "you";
export const MARKETPLACE = "Rare Friends marketplace";
const DAY = 86_400_000;

export const pct = (v: Village) => Math.min(100, Math.floor(v.locked / v.target * 100));
export const rising = (v: Village, now = Date.now()) => !v.founded && !v.failed && now < v.deadline && v.locked < v.target;
export const weightOf = (v: Village, who: string) => v.lockers.get(who) ?? 0;
export const daysLeft = (v: Village, now = Date.now()) => Math.max(0, Math.ceil((v.deadline - now) / DAY));

function take(e: Economy | null, amount: number) {
  if (e && e.rf < amount) throw new Error(`You have ${e.rf.toLocaleString()} RF.`);
  if (e) e.rf -= amount;
}

/** Plant a flag where `at` (island-local tile) is, locking the first RF. */
export function plant(w: World, e: Economy | null, seat: Plot, name: string, at: { x: number; y: number }, amount: number, who = YOU): Village {
  const why = flagProblem(w, seat, at); if (why) throw new Error(why);
  if (amount < MIN_LOCK) throw new Error(`Lock at least ${MIN_LOCK.toLocaleString()} RF to plant a flag.`);
  if (!name.trim()) throw new Error("Name your village.");
  const v = newVillage(w, seat, name, at, FLAG_TARGET, Date.now() + FLAG_DAYS * DAY);
  lock(w, e, v, amount, who);
  return v;
}

/** Lock RF into a rising flag; the last lock is trimmed to what's missing. Returns RF taken. */
export function lock(w: World, e: Economy | null, v: Village, amount: number, who = YOU): number {
  if (!rising(v)) throw new Error(v.founded ? `${v.name} is already founded.` : v.locked >= v.target ? `${v.name}'s flag is full.` : `${v.name}'s flag closed.`);
  const missing = v.target - v.locked, taken = Math.min(amount, missing);
  if (taken < MIN_LOCK && taken !== missing) throw new Error(`Lock at least ${MIN_LOCK.toLocaleString()} RF.`);
  take(e, taken);
  v.locked += taken; v.lockers.set(who, weightOf(v, who) + taken); w.version++;
  return taken;
}

/** Full flag → village: half to the treasury, half to permanent liquidity. */
export function found(w: World, v: Village) {
  if (v.founded || v.failed) throw new Error(`${v.name} can't be founded.`);
  if (v.locked < v.target) throw new Error(`${v.name}'s flag is ${pct(v)}% full.`);
  v.founded = true; v.treasury = v.locked / 2; v.liquidity = v.locked - v.treasury; w.version++;
}

/** After the deadline (plus a grace week for a full flag nobody founded): take your RF back. */
export function refund(w: World, e: Economy | null, v: Village, who = YOU) {
  if (v.founded) throw new Error(`${v.name} is founded: its RF is locked for good.`);
  const closes = v.deadline + (v.locked >= v.target ? FOUNDING_GRACE_DAYS * DAY : 0);
  if (Date.now() < closes) throw new Error(`${v.name}'s flag is still open.`);
  const amount = weightOf(v, who); if (!amount) throw new Error("Nothing of yours is locked there.");
  v.lockers.delete(who); v.locked -= amount; v.failed = true; if (e) e.rf += amount; w.version++;
  return amount;
}

/** Trading through the village's liquidity earns fees (simulated volume). */
export function accrueFees(v: Village, rand = Math.random) {
  if (!v.founded) return;
  v.fees.rf += Math.round(200 + rand() * 600);
  v.fees.eth += +(0.001 + rand() * 0.004).toFixed(4);
}

/** Collect fees, buy back RF with the ETH, burn the burn share, keep the rest. Founders only. */
export function harvest(v: Village, e: Economy, who = YOU) {
  if (!v.founded) throw new Error(`${v.name} isn't founded yet.`);
  if (!weightOf(v, who)) throw new Error(`Only ${v.name}'s founders harvest (they set the buyback's minimum).`);
  const bought = Math.round(v.fees.eth * RF_PER_ETH), total = v.fees.rf + bought;
  const burned = Math.round(total * v.burnBps / 10_000), kept = total - burned;
  const out = { rf: v.fees.rf, eth: v.fees.eth, bought, burned, kept };
  v.fees = { rf: 0, eth: 0 }; v.burned += burned; v.treasury += kept; e.burned += burned;
  return out;
}

/* ── votes ── */

export function propose(v: Village, who: string, p: { kind: Proposal["kind"]; amount?: number; burnBps?: number; memo: string }) {
  if (!v.founded) throw new Error(`${v.name} isn't founded yet.`);
  if (!weightOf(v, who)) throw new Error(`Only ${v.name}'s founders make proposals.`);
  if (p.kind === "spend" && !(p.amount && p.amount > 0)) throw new Error("How much RF?");
  if (p.kind === "burnShare" && !(p.burnBps !== undefined && p.burnBps >= 0 && p.burnBps <= 10_000)) throw new Error("Burn share is 0–100%.");
  const prop: Proposal = { id: v.proposals.length, kind: p.kind, amount: p.amount ?? 0, burnBps: p.burnBps ?? 0, memo: p.memo.trim().slice(0, 140),
    yes: 0, no: 0, voters: new Set(), ends: Date.now() + VOTE_DAYS * DAY, executed: false };
  v.proposals.push(prop); return prop;
}
export function vote(v: Village, prop: Proposal, who: string, support: boolean) {
  if (Date.now() >= prop.ends) throw new Error("Voting closed.");
  if (prop.voters.has(who)) throw new Error("Already voted.");
  const w = weightOf(v, who); if (!w) throw new Error("Only founders vote.");
  prop.voters.add(who); if (support) prop.yes += w; else prop.no += w;
}
export const passed = (v: Village, prop: Proposal) => prop.yes > prop.no && prop.yes + prop.no >= v.locked * QUORUM;
export function execute(v: Village, prop: Proposal) {
  if (prop.executed) throw new Error("Already done.");
  if (Date.now() < prop.ends) throw new Error("Voting is still open.");
  if (!passed(v, prop)) throw new Error("It didn't pass.");
  if (prop.kind === "spend") { if (v.treasury < prop.amount) throw new Error("Not enough in the treasury."); v.treasury -= prop.amount; }
  else v.burnBps = prop.burnBps;
  prop.executed = true;
}
