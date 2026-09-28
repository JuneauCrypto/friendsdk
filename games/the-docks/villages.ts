/* Villages — SIMULATED in this preview. Mirrors contracts/src/docks/DocksVillages.sol,
 * DocksVillageTreasury.sol, DocksItems.sol and DocksUniV3Liquidity.sol:
 *  - plant a flag and lock the first RF; anyone locks more until FLAG_TARGET (a setting); every
 *    locker holds a soulbound founder mark; not full by the deadline → everyone gets RF back;
 *  - every RF that comes in: half permanent RF/ETH liquidity, half the payer's allowance (spent
 *    only on items for their flagged island; that RF goes to the liquidity too);
 *  - everyone brings one island: founders free, anyone else enrolls (10,000 RF). Open for the
 *    first week; after that, what the flag votes; a population cap stops new Friends too;
 *  - a Friend that leaves a flagged island stays bound to that flag until the next epoch
 *    (~21 days); an island leaves only by a removal request, carried out at the next epoch; its
 *    flag items are raffled to the members who stayed (RF tickets → liquidity);
 *  - votes: every Friend on a member's island is a vote; founders ×(1 + their share of the pool);
 *  - harvest: fees buy back RF; the pool share (half) goes back into the pool, the rest is
 *    shared by Friends (less the flag's loot-vault share, see war.ts). Nothing is burned. */
import { addMember, CELL, flagProblem, newVillage, villageOf, walletOf, type Item, type Plot, type Proposal, type ProposalKind, type Raffle, type Village, type World } from "./world.js";
import { toPool, type Economy } from "./launch.js";

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
export const EPOCH_DAYS = 21;                         // removals and released Friends happen at epoch boundaries
export const RAFFLE_DAYS = 3;
export const TICKET_PRICE = 100;
export const BOOST_SECONDS_PER_RF = 36;               // each RF cuts 36 s off a build
export const HOUR = 3_600_000;
export const CATALOG = [
  { name: "Lantern", icon: "🏮", price: 1_000, build: HOUR },
  { name: "Market stall", icon: "🏪", price: 10_000, build: DAY },
  { name: "Fountain", icon: "⛲", price: 25_000, build: 3 * DAY },
  { name: "Watchtower", icon: "🗼", price: 50_000, build: 7 * DAY },
  // war items (their battle value is in war.ts ITEM_WAR)
  { name: "Cannon", icon: "💣", price: 20_000, build: DAY },
  { name: "Sea wall", icon: "🧱", price: 20_000, build: DAY },
  { name: "Armory", icon: "⚔️", price: 60_000, build: 3 * DAY },
  { name: "Fort", icon: "🏰", price: 60_000, build: 3 * DAY },
];
/** Flags get dearer as more are planted (a bonding curve): cheap to start early, joining makes
 *  more sense later. FLAG_BASE × FLAG_CURVE^(flags so far), capped at FLAG_TARGET. */
export const FLAG_BASE = 100_000;
export const FLAG_CURVE = 1.25;
export function flagPrice(w: World) {
  const n = w.villages.filter(v => v.founded || rising(v)).length;
  return Math.min(FLAG_TARGET, Math.round(FLAG_BASE * Math.pow(FLAG_CURVE, n) / 1_000) * 1_000);
}

export const ENROLL_CHOICES = ["Keep open at the current price", "Open at a different price", "Close now", "Close at a population"];

export const pct = (v: Village) => Math.min(100, Math.floor(v.locked / v.target * 100));
export const rising = (v: Village, now = Date.now()) => !v.founded && !v.failed && now < v.deadline && v.locked < v.target;
export const weightOf = (v: Village, who: string) => v.lockers.get(who) ?? 0;
export const daysLeft = (v: Village, now = Date.now()) => Math.max(0, Math.ceil((v.deadline - now) / DAY));
export const islandOf = (v: Village, who: string) => v.members.find(p => walletOf(p) === who) ?? null;
export const population = (v: Village) => v.members.reduce((n, p) => n + p.friends.length, 0);
/** Founder multiplier: 1 + RF locked / pool. */
export const multiplier = (v: Village, who: string) => 1 + (v.pool ? weightOf(v, who) / v.pool : 0);
/** Voting power: Friends on your flagged island × your founder multiplier. */
export const powerOf = (v: Village, who: string) => { const p = islandOf(v, who); return p ? p.friends.length * multiplier(v, who) : 0; };
export const totalPower = (v: Village) => v.members.reduce((n, p) => n + powerOf(v, walletOf(p)), 0);
/** RF left to spend on items for your flagged island: half your lock + your credits − spent. */
export const allowanceOf = (v: Village, who: string) => Math.max(0, weightOf(v, who) / 2 + (v.credited.get(who) ?? 0) - (v.spent.get(who) ?? 0));
export const nextEpoch = (w: World, now = Date.now()) => w.genesis + (Math.floor((now - w.genesis) / (EPOCH_DAYS * DAY)) + 1) * EPOCH_DAYS * DAY;
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
  if (!name.trim()) throw new Error("Name your flag.");
  const v = newVillage(w, seat, name, at, flagPrice(w), Date.now() + FLAG_DAYS * DAY);
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
  v.liquidity = v.locked / 2;                                     // the other half: founders' allowances
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
  joinChecks(w, v, p); addMember(w, v, p);
}
function joinChecks(w: World, v: Village, p: Plot) {
  const until = w.cooldown.get(p) ?? 0;
  if (Date.now() < until) throw new Error(`${p.name} holds a Friend still bound to another flag until ${new Date(until).toLocaleDateString()}.`);
  if (v.enrollCap && population(v) + p.friends.length > v.enrollCap) throw new Error(`${v.name} is capped at ${v.enrollCap.toLocaleString()} Friends.`);
}
/** Enroll one island for the enrollment price, paid into the pool (half treasury, half liquidity). */
export function enroll(w: World, e: Economy | null, v: Village, p: Plot) {
  const price = enrollPrice(v); if (!price) throw new Error(`${v.name}'s enrollment is closed.`);
  if (e && e.rf < price) throw new Error(`Enrolling costs ${price.toLocaleString()} RF; you have ${e.rf.toLocaleString()}.`);
  joinChecks(w, v, p); addMember(w, v, p);
  if (e) e.rf -= price;
  const who = walletOf(p);
  v.pool += price; v.credited.set(who, (v.credited.get(who) ?? 0) + price / 2); v.pendingLiquidity += price / 2;
  return price;
}
export function provideLiquidity(v: Village) { v.liquidity += v.pendingLiquidity; v.pendingLiquidity = 0; }

/** Trading through the flag's liquidity earns fees (simulated volume). */
export function accrueFees(v: Village, rand = Math.random) {
  if (!v.founded) return;
  v.fees.rf += Math.round(200 + rand() * 600);
  v.fees.eth += +(0.001 + rand() * 0.004).toFixed(4);
}

/** Collect fees, buy back RF with the ETH: the pool share back into the pool, the rest shared by Friends. Members only. */
export function harvest(v: Village, e: Economy, who = YOU, lootBps = 0) {
  if (!v.founded) throw new Error(`${v.name} isn't founded yet.`);
  if (!islandOf(v, who)) throw new Error(`Only ${v.name}'s members harvest (they set the buyback's minimum).`);
  const bought = Math.round(v.fees.eth * RF_PER_ETH), total = v.fees.rf + bought;
  const toPoolRf = Math.round(total * v.poolBps / 10_000), loot = Math.round((total - toPoolRf) * lootBps / 10_000), kept = total - toPoolRf - loot;
  const out = { rf: v.fees.rf, eth: v.fees.eth, bought, toPool: toPoolRf, kept, loot };
  v.fees = { rf: 0, eth: 0 }; v.pendingLiquidity += toPoolRf; v.compounded += toPoolRf; void e;
  const pop = population(v);
  for (const m of v.members) { const who = walletOf(m); v.credited.set(who, (v.credited.get(who) ?? 0) + (pop ? kept * m.friends.length / pop : 0)); }
  if (!pop) v.pendingLiquidity += kept;
  return out;
}

/* ── votes: Friends × founder multiplier ── */

/** Propose declaring war on another founded flag (`target` = its index in w.villages). Members propose. */
export function proposeWar(w: World, v: Village, who: string, target: Village) {
  if (!v.founded || !target.founded) throw new Error("Only founded flags go to war.");
  if (!islandOf(v, who)) throw new Error(`Only ${v.name}'s members make proposals.`);
  if (v.proposals.some(p => p.kind === "war" && !p.settled && w.villages[p.options[0]] === target)) throw new Error(`A vote on war with ${target.name} is already open.`);
  return newProposal(v, "war", [w.villages.indexOf(target)], target.name, 1);
}

const CHOICES: Record<ProposalKind, number> = { poolShare: 2, enrollment: 4, enrollPrice: 3, enrollCap: 3, war: 2 };
function newProposal(v: Village, kind: ProposalKind, options: number[], memo: string, days: number): Proposal {
  const p: Proposal = { id: v.proposals.length, kind, options, memo: memo.trim().slice(0, 140), tally: Array(CHOICES[kind]).fill(0),
    voters: new Map(), ends: Date.now() + days * DAY, settled: false, winner: -1 };
  v.proposals.push(p); return p;
}
/** Propose a new share of each buyback to put back into the pool (the rest is shared as allowances). Members propose. */
export function proposePoolShare(v: Village, who: string, poolBps: number) {
  if (!v.founded) throw new Error(`${v.name} isn't founded yet.`);
  if (!islandOf(v, who)) throw new Error(`Only ${v.name}'s members make proposals.`);
  if (!(poolBps >= 0 && poolBps <= 10_000)) throw new Error("Pool share is 0–100%.");
  return newProposal(v, "poolShare", [poolBps], "", VOTE_DAYS);
}
/** Start an enrollment vote (one at a time). */
export function proposeEnrollment(v: Village, who: string) {
  if (!v.founded) throw new Error(`${v.name} isn't founded yet.`);
  if (!islandOf(v, who)) throw new Error(`Only ${v.name}'s members start votes.`);
  if (v.enrollVote) throw new Error("An enrollment vote is already running.");
  v.enrollVote = newProposal(v, "enrollment", [], "", VOTE_DAYS);
  return v.enrollVote;
}
/** Burn share: choice 1 = yes, 0 = no. Enrollment votes: the option's index. */
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
  if (p.kind === "war") {
    p.winner = passed(v, p) ? 1 : 0;
    return p.winner ? `${v.name} voted for war on ${p.memo}!` : `${v.name} voted against war on ${p.memo}.`;
  }
  if (p.kind === "poolShare") {
    p.winner = passed(v, p) ? 1 : 0;
    if (!p.winner) return `${v.name}'s vote didn't pass.`;
    v.poolBps = p.options[0]; return `${v.name} now puts ${p.options[0] / 100}% of each buyback back into its pool.`;
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

/* ── staying and leaving ── */

/** Can Friend `id` be placed on `p` now? Null if yes. */
export function placeProblem(w: World, id: bigint, p: Plot): string | null {
  const v = villageOf(w, p), b = w.bonds.get(id);
  if (b && b.village !== v && Date.now() < b.until && v) return `#${id} is still bound to ${b.village.name} until ${new Date(b.until).toLocaleDateString()}.`;
  if (v && v.enrollCap && population(v) >= v.enrollCap) return `${v.name} is at its population cap (${v.enrollCap.toLocaleString()} Friends).`;
  return null;
}
/** Friend `id` is placed on `p`: bind it (or cool the island down if it's bound elsewhere). */
export function onPlace(w: World, id: bigint, p: Plot) {
  const v = villageOf(w, p), b = w.bonds.get(id);
  if (b && b.village !== v && Date.now() < b.until) w.cooldown.set(p, Math.max(w.cooldown.get(p) ?? 0, b.until));
  if (v) w.bonds.delete(id);
}
/** Friend `id` left flagged island `p` (moved off, or its hole burned): bound until the next epoch. */
export function onLeave(w: World, id: bigint, p: Plot) {
  const v = villageOf(w, p); if (v) w.bonds.set(id, { village: v, until: nextEpoch(w) });
}
/** Preview only: jump the clock to the next epoch boundary. */
export function skipEpoch(w: World) {
  const shift = nextEpoch(w) - Date.now() + 1;
  w.genesis -= shift;
  for (const v of w.villages) for (const [p, at] of v.removals) v.removals.set(p, at - shift);
  for (const b of w.bonds.values()) b.until -= shift;
  for (const [p, t] of w.cooldown) w.cooldown.set(p, t - shift);
}
/** Ask to take an island out of its village at the next epoch boundary. */
export function requestRemoval(w: World, v: Village, p: Plot) {
  if (!v.members.includes(p)) throw new Error(`${p.name} isn't in ${v.name}.`);
  if (v.seat === p) throw new Error(`${p.name} is ${v.name}'s seat: the flag stays.`);
  if (v.removals.has(p)) throw new Error(`${p.name} already asked to leave.`);
  const at = nextEpoch(w); v.removals.set(p, at); return at;
}
/** Carry out removals whose epoch has passed: allowance → liquidity, flag items → raffles. */
export function processRemovals(w: World, now = Date.now()): string[] {
  const out: string[] = [];
  for (const v of w.villages) for (const [p, at] of [...v.removals]) {
    if (now < at) continue;
    v.removals.delete(p); v.members = v.members.filter(x => x !== p);
    const who = walletOf(p), left = allowanceOf(v, who);
    v.spent.set(who, (v.spent.get(who) ?? 0) + left); v.pendingLiquidity += left;
    let n = 0;
    for (const it of w.items) if (it.village === v && it.plot === p) { it.plot = null; v.raffles.push({ item: it, ends: now + RAFFLE_DAYS * DAY, tickets: new Map() }); n++; }
    for (const pl of p.friends) { const b = w.bonds.get(pl.m.id); if (b?.village === v) w.bonds.delete(pl.m.id); }
    out.push(`${p.name} left ${v.name}${n ? `: ${n} flag item${n === 1 ? "" : "s"} went to a raffle` : ""}.`);
    w.version++;
  }
  return out;
}

/* ── items ── */

export const itemsOn = (w: World, p: Plot) => w.items.filter(it => it.plot === p);
export const isReady = (it: Item, now = Date.now()) => now >= it.readyAt;
/** Cell for a tile position on `p` (island-local tiles), if it's land with no item. */
export function cellProblem(w: World, p: Plot, cx: number, cy: number): string | null {
  if (!p.friends.some(pl => cx >= pl.x && cx < pl.x + pl.m.cw && cy >= pl.y && cy < pl.y + pl.m.ch)) return "Stand on land to build there.";
  if (w.items.some(it => it.plot === p && it.cx === cx && it.cy === cy)) return "Something is already built on that spot.";
  if (itemsOn(w, p).length >= 64) return "This island has 64 items.";
  return null;
}
export const cellAt = (at: { x: number; y: number }) => ({ cx: Math.floor(at.x / CELL), cy: Math.floor(at.y / CELL) });
function newItem(w: World, kind: number, village: Village | null, owner: string | null, p: Plot, cx: number, cy: number): Item {
  const it: Item = { id: w.items.length, kind, village, owner, plot: p, cx, cy, readyAt: Date.now() + CATALOG[kind].build };
  w.items.push(it); w.version++; return it;
}
/** A flag item on your flagged island, paid from your allowance (its RF → liquidity). */
export function buyForVillage(w: World, v: Village, who: string, kind: number, cx: number, cy: number) {
  const p = islandOf(v, who); if (!p) throw new Error(`Bring or enroll an island in ${v.name} first.`);
  const why = cellProblem(w, p, cx, cy); if (why) throw new Error(why);
  const price = CATALOG[kind].price;
  if (allowanceOf(v, who) < price) throw new Error(`Your ${v.name} allowance is ${Math.floor(allowanceOf(v, who)).toLocaleString()} RF.`);
  v.spent.set(who, (v.spent.get(who) ?? 0) + price); v.pendingLiquidity += price;
  return newItem(w, kind, v, null, p, cx, cy);
}
/** RF paid for own items and boosts: the pool of the island's village, or the Docks pool. */
function payRf(w: World, e: Economy, p: Plot | null, amount: number) {
  if (e.rf < amount) throw new Error(`You have ${Math.floor(e.rf).toLocaleString()} RF.`);
  e.rf -= amount; toPool(e, w, p, amount);
}
/** An item of your own, paid with your RF: always yours. */
export function buyOwn(w: World, e: Economy, who: string, kind: number, p: Plot, cx: number, cy: number) {
  const why = cellProblem(w, p, cx, cy); if (why) throw new Error(why);
  payRf(w, e, p, CATALOG[kind].price);
  return newItem(w, kind, null, who, p, cx, cy);
}
/** Speed up a build: each RF cuts BOOST_SECONDS_PER_RF seconds. */
export function boost(w: World, e: Economy, it: Item, rf: number) {
  if (!it.plot || isReady(it)) throw new Error("It's already built.");
  payRf(w, e, it.plot, rf);
  it.readyAt = Math.max(Date.now(), it.readyAt - rf * BOOST_SECONDS_PER_RF * 1000); w.version++;
}
export function takeOff(w: World, it: Item, who: string) {
  if (it.owner !== who) throw new Error("Flag items stay on their island.");
  it.plot = null; w.version++;
}
export function placeOwn(w: World, it: Item, who: string, p: Plot, cx: number, cy: number) {
  if (it.owner !== who) throw new Error("Not yours.");
  const why = cellProblem(w, p, cx, cy); if (why) throw new Error(why);
  it.plot = p; it.cx = cx; it.cy = cy; w.version++;
}

/* ── raffles ── */

export function buyTickets(w: World, e: Economy | null, v: Village, r: Raffle, who: string, n: number) {
  if (Date.now() >= r.ends) throw new Error("This raffle has ended.");
  if (!islandOf(v, who)) throw new Error(`Only ${v.name}'s members who stayed can enter.`);
  const cost = n * TICKET_PRICE;
  if (e) { if (e.rf < cost) throw new Error(`Tickets cost ${cost.toLocaleString()} RF.`); e.rf -= cost; }
  v.pendingLiquidity += cost; r.tickets.set(who, (r.tickets.get(who) ?? 0) + n);
}
/** After a raffle ends: draw a winner (a raffle nobody entered runs again). */
export function draw(w: World, v: Village, r: Raffle, rand = Math.random): string {
  if (Date.now() < r.ends) throw new Error("The raffle is still open.");
  const total = [...r.tickets.values()].reduce((a, b) => a + b, 0);
  const name = CATALOG[r.item.kind].name;
  if (!total) { r.ends = Date.now() + RAFFLE_DAYS * DAY; return `Nobody entered the ${name} raffle: it runs again.`; }
  let t = Math.floor(rand() * total), winner = "";
  for (const [who, n] of r.tickets) { if (t < n) { winner = who; break; } t -= n; }
  v.raffles = v.raffles.filter(x => x !== r);
  r.item.village = null; r.item.owner = winner; r.item.plot = null; w.version++;
  return winner === YOU ? `You won the ${name} (simulated)! It's yours: place it on one of your islands.` : `${winner} won the ${name} raffle.`;
}
