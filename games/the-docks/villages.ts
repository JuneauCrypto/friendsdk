/* Villages — SIMULATED in this preview. Mirrors contracts/src/docks/DocksVillages.sol,
 * DocksVillageTreasury.sol and DocksUniV3Liquidity.sol:
 *  - plant a flag and lock the first RF; anyone locks more until FLAG_TARGET (a setting); every
 *    locker holds a soulbound founder mark with what they locked; not full by the deadline →
 *    everyone takes their RF back;
 *  - full → founded: half to the village treasury (RF only), half permanent one-sided RF/ETH
 *    liquidity; nothing can be withdrawn after that, so it can't be rugged;
 *  - everyone brings one island: founders free, anyone else enrolls (10,000 RF into the pool,
 *    half treasury / half liquidity). Open for the first week; after that, what the village votes;
 *  - votes: every Friend on a member's island is a vote; founders multiply theirs by
 *    (1 + their share of the pool). Enrollment fees grow the pool, so newcomers dilute founders;
 *  - harvest: fees are collected, the ETH part buys back RF, the burn share (half) is burned and
 *    the rest fills the treasury. */
import { addMember, flagProblem, newVillage, walletOf, type Plot, type Proposal, type ProposalKind, type Village, type World } from "./world.js";
import type { Economy } from "./launch.js";

export const FLAG_TARGET = 1_000_000;                 // RF to fill a flag (a contract setting)
export const FLAG_DAYS = 30;                          // days a flag has to fill
export const MIN_LOCK = 1_000;                        // smallest lock (unless it fills the flag)
export const ENROLL_PRICE = 10_000;                   // RF to enroll an island (a contract setting)
export const ENROLL_WINDOW_DAYS = 7;                  // open enrollment after founding
export const FOUNDING_GRACE_DAYS = 7;
export const VOTE_DAYS = 3;
export const FOLLOW_UP_DAYS = 1;                      // the price / threshold vote
export const QUORUM = 0.2;                            // share of all power that must vote on spends
export const RF_PER_ETH = 100_000;                    // simulated price for the buyback
export const YOU = "you";
export const MARKETPLACE = "Rare Friends marketplace";
export const DAY = 86_400_000;

export const ENROLL_CHOICES = ["Keep open at the current price", "Open at a different price", "Close now", "Close at a population"];

export const pct = (v: Village) => Math.min(100, Math.floor(v.locked / v.target * 100));
export const rising = (v: Village, now = Date.now()) => !v.founded && !v.failed && now < v.deadline && v.locked < v.target;
export const weightOf = (v: Village, who: string) => v.lockers.get(who) ?? 0;
export const daysLeft = (v: Village, now = Date.now()) => Math.max(0, Math.ceil((v.deadline - now) / DAY));
export const islandOf = (v: Village, who: string) => v.members.find(p => walletOf(p) === who) ?? null;
export const population = (v: Village) => v.members.reduce((n, p) => n + p.friends.length, 0);
/** Founder multiplier: 1 + RF locked / pool. */
export const multiplier = (v: Village, who: string) => 1 + (v.pool ? weightOf(v, who) / v.pool : 0);
/** Voting power: Friends on your village island × your founder multiplier. */
export const powerOf = (v: Village, who: string) => { const p = islandOf(v, who); return p ? p.friends.length * multiplier(v, who) : 0; };
export const totalPower = (v: Village) => v.members.reduce((n, p) => n + powerOf(v, walletOf(p)), 0);
export const inWindow = (v: Village, now = Date.now()) => v.founded && now < v.foundedAt + ENROLL_WINDOW_DAYS * DAY;
/** RF to enroll now, or 0 when enrollment is closed. */
export function enrollPrice(v: Village, now = Date.now()) {
  if (!v.founded) return 0;
  if (!inWindow(v, now) && (!v.enrollOpen || (v.enrollCap && population(v) >= v.enrollCap))) return 0;
  return v.enrollPrice;
}

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

/** Full flag → village: half to the treasury, half to permanent liquidity; the seat is the
 *  planter's island; open enrollment starts, with the vote on what comes after it. */
export function found(w: World, v: Village) {
  if (v.founded || v.failed) throw new Error(`${v.name} can't be founded.`);
  if (v.locked < v.target) throw new Error(`${v.name}'s flag is ${pct(v)}% full.`);
  v.founded = true; v.foundedAt = Date.now(); v.pool = v.locked; v.enrollPrice = ENROLL_PRICE;
  v.treasury = v.locked / 2; v.liquidity = v.locked - v.treasury;
  v.members = [v.seat];
  v.enrollVote = newProposal(v, "enrollment", [], "", ENROLL_WINDOW_DAYS);
  w.version++;
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

/* ── people: everyone brings one island ── */

/** Founders bring one island of theirs, free. */
export function bring(w: World, v: Village, p: Plot) {
  if (!weightOf(v, walletOf(p))) throw new Error(`Only ${v.name}'s founders bring an island free; everyone else enrolls.`);
  addMember(w, v, p);
}
/** Enroll one island for the enrollment price, paid into the pool (half treasury, half liquidity). */
export function enroll(w: World, e: Economy | null, v: Village, p: Plot) {
  const price = enrollPrice(v); if (!price) throw new Error(`${v.name}'s enrollment is closed.`);
  addMember(w, v, p);
  if (e && e.rf < price) { v.members = v.members.filter(x => x !== p); throw new Error(`Enrolling costs ${price.toLocaleString()} RF; you have ${e.rf.toLocaleString()}.`); }
  if (e) e.rf -= price;
  v.pool += price; v.treasury += price / 2; v.pendingLiquidity += price / 2;
  return price;
}
export function provideLiquidity(v: Village) { v.liquidity += v.pendingLiquidity; v.pendingLiquidity = 0; }

/** Trading through the village's liquidity earns fees (simulated volume). */
export function accrueFees(v: Village, rand = Math.random) {
  if (!v.founded) return;
  v.fees.rf += Math.round(200 + rand() * 600);
  v.fees.eth += +(0.001 + rand() * 0.004).toFixed(4);
}

/** Collect fees, buy back RF with the ETH, burn the burn share, keep the rest. Members only. */
export function harvest(v: Village, e: Economy, who = YOU) {
  if (!v.founded) throw new Error(`${v.name} isn't founded yet.`);
  if (!islandOf(v, who)) throw new Error(`Only ${v.name}'s members harvest (they set the buyback's minimum).`);
  const bought = Math.round(v.fees.eth * RF_PER_ETH), total = v.fees.rf + bought;
  const burned = Math.round(total * v.burnBps / 10_000), kept = total - burned;
  const out = { rf: v.fees.rf, eth: v.fees.eth, bought, burned, kept };
  v.fees = { rf: 0, eth: 0 }; v.burned += burned; v.treasury += kept; e.burned += burned;
  return out;
}

/* ── votes: Friends × founder multiplier ── */

const CHOICES: Record<ProposalKind, number> = { spend: 2, burnShare: 2, enrollment: 4, enrollPrice: 3, enrollCap: 3 };
function newProposal(v: Village, kind: ProposalKind, options: number[], memo: string, days: number): Proposal {
  const p: Proposal = { id: v.proposals.length, kind, options, memo: memo.trim().slice(0, 140), tally: Array(CHOICES[kind]).fill(0),
    voters: new Map(), ends: Date.now() + days * DAY, settled: false, winner: -1 };
  v.proposals.push(p); return p;
}
/** Spend treasury RF (e.g. a marketplace upgrade) or set the burn share. Members propose. */
export function propose(v: Village, who: string, kind: "spend" | "burnShare", value: number, memo: string) {
  if (!v.founded) throw new Error(`${v.name} isn't founded yet.`);
  if (!islandOf(v, who)) throw new Error(`Only ${v.name}'s members make proposals.`);
  if (kind === "spend" && !(value > 0)) throw new Error("How much RF?");
  if (kind === "burnShare" && !(value >= 0 && value <= 10_000)) throw new Error("Burn share is 0–100%.");
  return newProposal(v, kind, [value], memo, VOTE_DAYS);
}
/** Start an enrollment vote (one at a time). */
export function proposeEnrollment(v: Village, who: string) {
  if (!v.founded) throw new Error(`${v.name} isn't founded yet.`);
  if (!islandOf(v, who)) throw new Error(`Only ${v.name}'s members start votes.`);
  if (v.enrollVote) throw new Error("An enrollment vote is already running.");
  v.enrollVote = newProposal(v, "enrollment", [], "", VOTE_DAYS);
  return v.enrollVote;
}
/** Spend / burn share: choice 1 = yes, 0 = no. Enrollment votes: the option's index. */
export function vote(v: Village, p: Proposal, who: string, choice: number) {
  if (Date.now() >= p.ends) throw new Error("Voting closed.");
  if (p.voters.has(who)) throw new Error("Already voted.");
  if (!(choice >= 0 && choice < p.tally.length)) throw new Error("No such choice.");
  const power = powerOf(v, who); if (!power) throw new Error("Bring or enroll an island with Friends on it to vote.");
  p.voters.set(who, choice); p.tally[choice] += power;
}
export const passed = (v: Village, p: Proposal) => p.tally[1] > p.tally[0] && p.tally[0] + p.tally[1] >= totalPower(v) * QUORUM;
const plurality = (p: Proposal) => p.tally.reduce((best, t, i) => (t > p.tally[best] ? i : best), 0);
export const priceOptions = (v: Village) => [v.enrollPrice / 2, v.enrollPrice * 2, v.enrollPrice * 5];
export const capOptions = (pop: number) => [Math.max(Math.floor(pop * 3 / 2), pop + 10), Math.max(pop * 2, pop + 25), Math.max(pop * 4, pop + 100)];

/** After a vote ends: carry it out. Returns a line saying what happened. */
export function settle(v: Village, p: Proposal): string {
  if (p.settled) throw new Error("Already settled.");
  if (Date.now() < p.ends) throw new Error("Voting is still open.");
  p.settled = true;
  if (p.kind === "spend" || p.kind === "burnShare") {
    p.winner = passed(v, p) ? 1 : 0;
    if (!p.winner) return `${v.name}'s vote didn't pass.`;
    if (p.kind === "spend") {
      if (v.treasury < p.options[0]) return `${v.name}'s treasury is short: nothing spent.`;
      v.treasury -= p.options[0]; return `${v.name} spent ${p.options[0].toLocaleString()} RF on the marketplace (simulated): ${p.memo}.`;
    }
    v.burnBps = p.options[0]; return `${v.name} now burns ${p.options[0] / 100}% of each buyback.`;
  }
  p.winner = plurality(p); v.enrollVote = null;
  if (p.kind === "enrollment") {
    v.enrollOpen = p.winner === 0;
    if (p.winner === 0 || p.winner === 2) v.enrollCap = 0;
    if (p.winner === 1) { v.enrollVote = newProposal(v, "enrollPrice", priceOptions(v), "", FOLLOW_UP_DAYS); return `${v.name} voted to change the enrollment price: closed until the day-long price vote ends.`; }
    if (p.winner === 3) { v.enrollVote = newProposal(v, "enrollCap", capOptions(population(v)), "", FOLLOW_UP_DAYS); return `${v.name} voted to close at a population: closed until the day-long threshold vote ends.`; }
    return p.winner === 0 ? `${v.name} keeps enrollment open at ${v.enrollPrice.toLocaleString()} RF.` : `${v.name} closed enrollment.`;
  }
  if (p.kind === "enrollPrice") { v.enrollPrice = p.options[p.winner]; v.enrollCap = 0; v.enrollOpen = true; return `${v.name}'s enrollment is open at ${v.enrollPrice.toLocaleString()} RF.`; }
  v.enrollCap = p.options[p.winner]; v.enrollOpen = true;
  return `${v.name}'s enrollment is open until it has ${v.enrollCap.toLocaleString()} Friends.`;
}
