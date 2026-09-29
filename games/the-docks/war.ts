/* War — SIMULATED in this preview (the contract comes later, with Dice for the rounds).
 *
 * Only founded flags fight. Every number below is a setting in WAR / SHIPS so the balance can be
 * tuned (and new dynamics added) without changing the rules' shape.
 *
 *  - Loot vault: each flag has one. It's the ONLY thing a flag can lose. It fills from a share of
 *    the flag's founding RF, a share of every harvest of its AMM fees, and loot won. A member's
 *    wallet and their allowance are never at risk.
 *  - Shield: a new flag gets SHIELD_DAYS to build (items, ships, members). No raids either way.
 *    After that anyone can raid it, flag or no flag declared.
 *  - Tiers: every island has one (its level × √Friends × items). Nobody ever fights more than one
 *    tier away: each island aboard a ship duels a defending island of its tier or one above or
 *    below, so it stays fair however islands grow. Flag tiers are shown for pride (skins later).
 *  - Ships go on tours: a member deploys a ship at a target flag; islands board first come,
 *    first served (members can set their island to auto-join tours), and it sails when full if
 *    the deployer chose auto-sail, or when the deployer says so. Each ship carries islands up to
 *    its tier; a dinghy takes one island of any tier: a solo, one-on-one tour. A ship on a lost
 *    raid sinks and comes back after SHIP_REGEN_HOURS.
 *  - Duel: best of 3 rounds (Broadside: ships + attack items, Boarding: raw strength, Siege:
 *    defense items, home advantage). Each round the attacker wins with chance A ÷ (A + D). On
 *    chain: one Dice roll per round. The raid goes to whoever wins more duels.
 *  - Loot: the winner takes lossPct(tier) of the loser's vault × the share of duels it won
 *    (gentler in higher tiers, so a big vault is a target but never wiped out) plus a bounty
 *    from the Docks rewards reserve. Half goes to the winning side's islands that fought, by
 *    level, claimable to the Friend's wallet; half into the winner's vault.
 *  - War: a flag can declare war on another by vote. For WAR_DAYS its raids on that flag skip the
 *    raid cooldown and pay a double bounty. */
import { rankOf, walletOf, type Plot, type Village, type World } from "./world.js";
/** Extra defense multiplier for an island (its flag Friend's level); set by the game. */
let defenseOf: (w: World, p: Plot) => number = () => 1;
export function setDefenseBoost(fn: (w: World, p: Plot) => number) { defenseOf = fn; }
/** A member island's stance in its flag (peace unless set to war). */
export const atWarStance = (v: Village, p: Plot) => (v.stance.get(p) ?? "peace") === "war";
import { CATALOG, DAY, HOUR, YOU, allowanceOf, islandOf, itemsOn, isReady, population } from "./villages.js";
import type { Economy } from "./launch.js";

export const WAR = {
  SHIELD_DAYS: 7,
  LOOT_FROM_FOUNDING_BPS: 1_000,       // 10% of a flag's locked RF starts its loot vault (from the liquidity half)
  LOOT_FROM_FEES_BPS: 1_000,           // 10% of every harvest of the flag's AMM fees goes to the vault (DocksVillageTreasury.LOOT_BPS)
  DOCKS_BOUNTY_BPS: 100,               // 1% of the Docks rewards reserve per win
  TO_FIGHTERS_BPS: 5_000,              // half the loot to the islands that fought, half to the winner's vault
  BASE_LOSS_BPS: 1_000,                // tier 1 loses 10% of its vault per lost battle; higher tiers less
  HOME_ADVANTAGE: 0.1,
  EMPTY_SEAT_STRENGTH: 0.5,            // a flag with no war islands defends with its peace islands at half strength
  RAID_COOLDOWN_HOURS: 24,             // between raids on the same flag (not during a declared war)
  WAR_DAYS: 3,
  ITEM_BONUS_CAP: 0.6,                 // most a single island gets from items, per side
  INTRO_DINGHIES: 2,                   // every founded flag gets these free
  SHIP_REGEN_HOURS: 24,                // a sunk ship comes back after this
  TIERS: [0, 2_000, 10_000, 50_000, 250_000] as number[],          // flag tiers (by flag power)
  ISLAND_TIERS: [0, 600, 1_500, 4_000, 10_000] as number[],       // island tiers (by island power): duels stay within ±1
  TIER_NAMES: ["Driftwood", "Harbor", "Fleet", "Armada", "Empire"],
};

/** maxTier: the highest island tier (0-based) the ship carries. A dinghy carries any tier: 1 v 1. */
export const SHIPS = [
  { name: "Dinghy", icon: "🛶", seats: 1, price: 2_000, build: HOUR, attack: 0, maxTier: 4 },
  { name: "Sloop", icon: "⛵", seats: 3, price: 12_000, build: 6 * HOUR, attack: 0.05, maxTier: 1 },
  { name: "Frigate", icon: "🚢", seats: 6, price: 40_000, build: DAY, attack: 0.1, maxTier: 2 },
  { name: "Galleon", icon: "🏴‍☠️", seats: 12, price: 120_000, build: 3 * DAY, attack: 0.15, maxTier: 4 },
];

/** Battle value of catalog items (by name), per side. Anything else counts for nothing in war. */
export const ITEM_WAR: Record<string, { attack: number; defense: number }> = {
  Watchtower: { attack: 0, defense: 0.1 },
  Cannon: { attack: 0.08, defense: 0.02 },
  "Sea wall": { attack: 0, defense: 0.08 },
  Armory: { attack: 0.15, defense: 0 },
  Fort: { attack: 0, defense: 0.15 },
};

export type Ship = { id: number; kind: number; readyAt: number; owner: string; sunkUntil?: number };
export type Duel = { attacker: Plot; defender: Plot | null; rounds: boolean[]; won: boolean | null };
export type Tour = { id: number; ship: Ship; from: Village; target: Village; deployer: string; autoSail: boolean; crew: Plot[]; sailed: boolean };
export type Battle = {
  id: number; attacker: Village; defender: Village; seats: number; ships: Ship[]; duels: Duel[];
  attackers: Plot[]; defenders: Plot[]; rounds: boolean[]; attackerWon: boolean | null; loot: number; bounty: number;
  shares: Map<string, number>; at: number; war: boolean;
};
export type WarDeclaration = { from: Village; to: Village; until: number };
export type WarBook = {
  loot: Map<Village, number>; ships: Map<Village, Ship[]>; earned: Map<string, number>;
  battles: Battle[]; wars: WarDeclaration[]; lastRaid: Map<string, number>; seq: number;
  tours: Tour[]; autoJoin: Set<Plot>;
};
export const newWarBook = (): WarBook => ({ loot: new Map(), ships: new Map(), earned: new Map(), battles: [], wars: [], lastRaid: new Map(), seq: 0, tours: [], autoJoin: new Set() });

/* ── the flag's numbers ── */

export const lootOf = (b: WarBook, v: Village) => b.loot.get(v) ?? 0;
const addLoot = (b: WarBook, v: Village, n: number) => b.loot.set(v, Math.max(0, lootOf(b, v) + n));
export const shipsOf = (b: WarBook, v: Village) => b.ships.get(v) ?? [];
export const sunk = (s: Ship, now = Date.now()) => (s.sunkUntil ?? 0) > now;
export const onTour = (b: WarBook, s: Ship) => b.tours.some(t => t.ship === s && !t.sailed);
export const readyShips = (b: WarBook, v: Village, now = Date.now()) => shipsOf(b, v).filter(s => now >= s.readyAt && !sunk(s, now) && !onTour(b, s));
export const seatsOf = (ships: Ship[]) => ships.reduce((n, s) => n + SHIPS[s.kind].seats, 0);
export const shieldEnds = (v: Village) => v.foundedAt + WAR.SHIELD_DAYS * DAY;
export const shielded = (v: Village, now = Date.now()) => v.founded && now < shieldEnds(v);

/** An island's level: its rank (from the Rare Friends reward weight) plus its size. */
export const levelOf = (p: Plot) => rankOf(p).index + 1 + Math.floor(Math.log2(1 + p.friends.length));
/** Items on the island that count in battle (built only), capped per side. */
export function itemBonus(w: World, p: Plot, now = Date.now()) {
  let attack = 0, defense = 0;
  for (const it of itemsOn(w, p)) { if (!isReady(it, now)) continue; const v = ITEM_WAR[CATALOG[it.kind].name]; if (v) { attack += v.attack; defense += v.defense; } }
  return { attack: Math.min(WAR.ITEM_BONUS_CAP, attack), defense: Math.min(WAR.ITEM_BONUS_CAP, defense) };
}
/** Raw strength of an island: level × √Friends. */
export const strengthOf = (p: Plot) => levelOf(p) * Math.sqrt(Math.max(1, p.friends.length));
/** A flag's battle power: every member island's strength with its items at their best side. */
export function flagPower(w: World, v: Village) {
  return v.members.reduce((n, p) => { const b = itemBonus(w, p); return n + strengthOf(p) * (1 + Math.max(b.attack, b.defense)); }, 0) * 100;
}
/** An island's battle power and tier (its items at their best side). */
export function islandPower(w: World, p: Plot) { const b = itemBonus(w, p); return strengthOf(p) * (1 + Math.max(b.attack, b.defense)) * 100; }
export function islandTier(w: World, p: Plot) { const x = islandPower(w, p); let t = 0; WAR.ISLAND_TIERS.forEach((min, i) => { if (x >= min) t = i; }); return t; }
export function tierOf(w: World, v: Village) { const p = flagPower(w, v); let t = 0; WAR.TIERS.forEach((min, i) => { if (p >= min) t = i; }); return t; }
export const tierName = (t: number) => `Tier ${t + 1} · ${WAR.TIER_NAMES[t]}`;
/** Share of the loser's vault taken per lost battle: gentler as tiers go up (10%, 6.7%, 5%, 4%, 3.3%). */
export const lossBps = (tier: number) => Math.round(WAR.BASE_LOSS_BPS / (1 + 0.5 * tier));

/** Battle readiness during the shield (a checklist; the shield ends on its own). */
export function readiness(w: World, b: WarBook, v: Village) {
  const items = v.members.flatMap(p => itemsOn(w, p)).filter(it => isReady(it) && ITEM_WAR[CATALOG[it.kind].name]);
  const checks = [
    { label: "3+ islands", ok: v.members.length >= 3 },
    { label: "a defense item built", ok: items.some(it => ITEM_WAR[CATALOG[it.kind].name].defense > 0) },
    { label: "an attack item built", ok: items.some(it => ITEM_WAR[CATALOG[it.kind].name].attack > 0) },
    { label: "a ship bigger than a dinghy", ok: shipsOf(b, v).some(s => s.kind > 0) },
    { label: "10k+ RF in the loot vault", ok: lootOf(b, v) >= 10_000 },
  ];
  return { checks, pct: Math.round(checks.filter(c => c.ok).length / checks.length * 100) };
}

/* ── funding the vault ── */

/** At founding: a share of the flag's RF goes to its loot vault (out of the liquidity half), and the intro dinghies. */
export function onFounded(b: WarBook, v: Village) {
  const n = Math.round(v.locked * WAR.LOOT_FROM_FOUNDING_BPS / 10_000);
  v.liquidity = Math.max(0, v.liquidity - n); addLoot(b, v, n);
  const ships = shipsOf(b, v);
  for (let i = 0; i < WAR.INTRO_DINGHIES; i++) ships.push({ id: b.seq++, kind: 0, readyAt: 0, owner: v.name });
  b.ships.set(v, ships);
  return n;
}
/** At a harvest: a share of what members would share goes to the vault instead. Returns that share. */
export function fromHarvest(b: WarBook, v: Village, shared: number) {
  const n = Math.round(shared * WAR.LOOT_FROM_FEES_BPS / 10_000); addLoot(b, v, n); return n;
}
/** Anyone can add RF to a flag's vault (a bigger vault is a bigger target, and a bigger buffer). */
export function fund(b: WarBook, e: Economy, v: Village, n: number) {
  if (!v.founded) throw new Error(`${v.name} isn't founded yet.`);
  if (n <= 0) throw new Error("Add some RF.");
  if (e.rf < n) throw new Error(`You have ${Math.floor(e.rf).toLocaleString()} RF.`);
  e.rf -= n; addLoot(b, v, n);
}

/* ── ships ── */

/** Build a ship for your flag, from your allowance or your own RF. Ships belong to the flag. */
export function buildShip(b: WarBook, e: Economy, v: Village, kind: number, from: "allowance" | "rf", who = YOU) {
  if (!v.founded) throw new Error(`${v.name} isn't founded yet.`);
  if (!islandOf(v, who)) throw new Error(`Only ${v.name}'s members build its ships.`);
  const s = SHIPS[kind]; if (!s) throw new Error("Unknown ship.");
  if (from === "allowance") {
    if (allowanceOf(v, who) < s.price) throw new Error(`Your ${v.name} allowance is ${Math.floor(allowanceOf(v, who)).toLocaleString()} RF.`);
    v.spent.set(who, (v.spent.get(who) ?? 0) + s.price); v.pendingLiquidity += s.price;
  } else {
    if (e.rf < s.price) throw new Error(`A ${s.name} costs ${s.price.toLocaleString()} RF; you have ${Math.floor(e.rf).toLocaleString()}.`);
    e.rf -= s.price; v.pendingLiquidity += s.price;
  }
  const ship: Ship = { id: b.seq++, kind, readyAt: Date.now() + s.build, owner: who };
  b.ships.set(v, [...shipsOf(b, v), ship]); return ship;
}
export function finishShips(b: WarBook, v: Village) { for (const s of shipsOf(b, v)) { s.readyAt = Math.min(s.readyAt, Date.now()); if (s.sunkUntil) s.sunkUntil = 0; } }

/* ── matchmaking ── */

export const atWar = (b: WarBook, a: Village, d: Village, now = Date.now()) => b.wars.some(x => x.from === a && x.to === d && now < x.until);
/** Why `a` can't raid `d` now (null: it can). */
export function raidProblem(w: World, b: WarBook, a: Village, d: Village, now = Date.now()): string | null {
  if (a === d) return "That's your own flag.";
  if (!a.founded || !d.founded) return "Only founded flags go to war.";
  if (shielded(a, now)) return `${a.name} is still building up (shield for ${Math.ceil((shieldEnds(a) - now) / DAY)} more days): no raids either way.`;
  if (shielded(d, now)) return `${d.name} is under its first-week shield.`;
  if (!d.members.length) return `${d.name} has no islands to fight.`;
  const last = b.lastRaid.get(`${a.id}>${d.id}`) ?? 0;
  if (!atWar(b, a, d, now) && now < last + WAR.RAID_COOLDOWN_HOURS * HOUR) return `${a.name} raided ${d.name} recently: ${Math.ceil((last + WAR.RAID_COOLDOWN_HOURS * HOUR - now) / HOUR)} h to go (or declare war).`;
  return null;
}
export const targets = (w: World, b: WarBook, a: Village) => w.villages.filter(d => d !== a && d.founded);

/** Declare war (the flag voted for it): WAR_DAYS of raids on that flag with no cooldown and a double bounty. */
export function declareWar(b: WarBook, a: Village, d: Village) {
  if (!a.founded || !d.founded) throw new Error("Only founded flags go to war.");
  b.wars = b.wars.filter(x => !(x.from === a && x.to === d));
  const war = { from: a, to: d, until: Date.now() + WAR.WAR_DAYS * DAY }; b.wars.push(war); return war;
}

/* ── tours: ships fill up first come, first served, then sail ── */

/** Can island `p` board `ship`? Null if it can. */
export function boardProblem(w: World, b: WarBook, t: Tour, p: Plot) {
  if (t.sailed) return "That ship has sailed.";
  if (!t.from.members.includes(p)) return `Only ${t.from.name}'s islands board its ships.`;
  if (t.crew.includes(p)) return `${p.name} is already aboard.`;
  if (!atWarStance(t.from, p)) return `${p.name} is a peace island: only war islands board ships.`;
  if (b.tours.some(o => !o.sailed && o.crew.includes(p))) return `${p.name} is aboard another ship.`;
  const s = SHIPS[t.ship.kind];
  if (t.crew.length >= s.seats) return `The ${s.name} is full.`;
  const tier = islandTier(w, p);
  if (tier > s.maxTier) return `${p.name} is ${islandTierName(tier)}: a ${s.name} carries up to ${islandTierName(s.maxTier)}. Take a bigger ship, or a dinghy (any tier, one on one).`;
  return null;
}
export const islandTierName = (t: number) => `tier ${t + 1}`;
/** Put a ship on a tour at `target`. The deployer's island boards first, then members set to auto-join. */
export function deployTour(w: World, b: WarBook, a: Village, target: Village, shipId: number, deployer: Plot, autoSail: boolean): Tour {
  if (!atWarStance(a, deployer)) throw new Error(`${deployer.name} is a peace island: set it to war to send ships.`);
  const why = raidProblem(w, b, a, target); if (why) throw new Error(why);
  const ship = readyShips(b, a).find(s => s.id === shipId); if (!ship) throw new Error("That ship isn't ready.");
  const t: Tour = { id: b.seq++, ship, from: a, target, deployer: walletOf(deployer), autoSail, crew: [], sailed: false };
  const first = boardProblem(w, b, t, deployer); if (first) throw new Error(first);
  b.tours.push(t); t.crew.push(deployer);
  for (const p of a.members) if (p !== deployer && b.autoJoin.has(p) && !boardProblem(w, b, t, p)) t.crew.push(p);
  w.version++; return t;
}
export function board(w: World, b: WarBook, t: Tour, p: Plot) {
  const why = boardProblem(w, b, t, p); if (why) throw new Error(why);
  t.crew.push(p); w.version++;
}
export const full = (t: Tour) => t.crew.length >= SHIPS[t.ship.kind].seats;
export function cancelTour(b: WarBook, t: Tour) { b.tours = b.tours.filter(x => x !== t); }

/* ── the battle: duels within one tier ── */

function duelStrength(w: World, p: Plot, side: "attack" | "defense", round: number, shipBonus: number, k = 1) {
  const bonus = itemBonus(w, p), base = strengthOf(p), item = side === "attack" ? bonus.attack : bonus.defense;
  const s = round === 0 ? base * (1 + (side === "attack" ? item + shipBonus : item)) : round === 1 ? base : base * (1 + (side === "defense" ? 2 * item : item / 2));
  return (side === "defense" ? s * (1 + WAR.HOME_ADVANTAGE) * defenseOf(w, p) : s) * k;
}
/** Best of 3 rounds between two islands (`defK` < 1: peace islands defending as militia). */
export function duel(w: World, att: Plot, def: Plot, shipBonus: number, rand = Math.random, defK = 1) {
  const rounds: boolean[] = [];
  for (let r = 0; r < 3 && rounds.filter(Boolean).length < 2 && rounds.filter(x => !x).length < 2; r++) {
    const A = duelStrength(w, att, "attack", r, shipBonus), D = duelStrength(w, def, "defense", r, 0, defK);
    rounds.push(rand() < A / (A + D));
  }
  return { rounds, won: rounds.filter(Boolean).length >= 2 };
}

/**
 * The tour sails: every island aboard duels a defender of its tier or one above or below
 * (first come, first served among `defending`, each defender once). An island with no match
 * sits it out. The raid goes to whoever wins more duels; a tie moves no loot. `rand` stands in
 * for Dice.
 */
export function sail(w: World, b: WarBook, e: Economy, t: Tour, defending: Plot[], rand = Math.random): Battle {
  if (t.sailed) throw new Error("That ship has sailed.");
  const a = t.from, d = t.target;
  const why = raidProblem(w, b, a, d); if (why) throw new Error(why);
  if (!t.crew.length) throw new Error("Nobody's aboard.");
  t.sailed = true; b.tours = b.tours.filter(x => x !== t);
  const s = SHIPS[t.ship.kind], shipBonus = s.attack;
  // war islands defend; a flag with none left defends with its peace islands at half strength
  const warPool = defending.filter(p => d.members.includes(p) && atWarStance(d, p));
  const militia = !warPool.length, pool = militia ? defending.filter(p => d.members.includes(p)) : warPool;
  const used = new Set<Plot>(), duels: Duel[] = [];
  for (const att of t.crew) {
    const ta = islandTier(w, att);
    const def = pool.find(p => !used.has(p) && Math.abs(islandTier(w, p) - ta) <= 1) ?? null;
    if (!def) { duels.push({ attacker: att, defender: null, rounds: [], won: null }); continue; }
    used.add(def);
    const r = duel(w, att, def, shipBonus, rand, militia ? WAR.EMPTY_SEAT_STRENGTH : 1);
    duels.push({ attacker: att, defender: def, rounds: r.rounds, won: r.won });
  }
  const fought = duels.filter(x => x.won !== null), wins = fought.filter(x => x.won).length, losses = fought.length - wins;
  const attackerWon = wins > losses ? true : losses > wins ? false : null;
  const war = atWar(b, a, d);
  let loot = 0, bounty = 0; const shares = new Map<string, number>();
  if (attackerWon !== null) {
    const [winner, loser] = attackerWon ? [a, d] : [d, a];
    const share = (attackerWon ? wins : losses) / Math.max(1, fought.length);
    loot = Math.floor(lootOf(b, loser) * lossBps(tierOf(w, loser)) / 10_000 * share);
    bounty = Math.floor(e.docksFund * WAR.DOCKS_BOUNTY_BPS * (war ? 2 : 1) / 10_000);
    addLoot(b, loser, -loot); e.docksFund -= bounty;
    const prize = loot + bounty, toFighters = Math.floor(prize * WAR.TO_FIGHTERS_BPS / 10_000);
    addLoot(b, winner, prize - toFighters);
    const fighters = fought.map(x => attackerWon ? x.attacker : x.defender!);
    const levels = fighters.reduce((n, p) => n + levelOf(p), 0);
    for (const p of fighters) { const who = walletOf(p), n = levels ? toFighters * levelOf(p) / levels : 0; shares.set(who, (shares.get(who) ?? 0) + n); b.earned.set(who, (b.earned.get(who) ?? 0) + n); }
    if (!attackerWon) t.ship.sunkUntil = Date.now() + WAR.SHIP_REGEN_HOURS * HOUR;   // it comes back
  }
  b.lastRaid.set(`${a.id}>${d.id}`, Date.now());
  const battle: Battle = { id: b.battles.length, attacker: a, defender: d, seats: s.seats, ships: [t.ship], duels,
    attackers: t.crew, defenders: [...used], rounds: fought.map(x => Boolean(x.won)), attackerWon, loot, bounty, shares, at: Date.now(), war };
  b.battles.push(battle); w.version++;
  return battle;
}

/** Earned loot is claimable to the Friend's own wallet: once claimed it's theirs, never at risk. */
export function claim(b: WarBook, e: Economy, who = YOU) {
  const n = Math.floor(b.earned.get(who) ?? 0); if (!n) throw new Error("No loot to claim.");
  b.earned.set(who, 0); e.rf += n; return n;
}

/** Sample flags defend on their own: every member answers, strongest first. */
export const autoDefenders = (d: Village) => [...d.members].sort((x, y) => Number(atWarStance(d, y)) - Number(atWarStance(d, x)) || strengthOf(y) - strengthOf(x));
export const popOf = population;
