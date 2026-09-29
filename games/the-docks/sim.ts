/* The simulated Docks — SIMULATED in this preview, so there's a living world to play in before
 * other players arrive. Built the same every time (a seeded random), it adds:
 *  - six founded flags with nods crypto natives will recognise (no tickers, no logos): each a
 *    block of islands with war islands on three sides and a peace harbor front on the fourth
 *    (its open slips are where visitors dock to trade), peace islands in the middle, its own
 *    flag Friend, loot vault, ships and market. The bigger flags build up and down: upper
 *    decks over their peace core (and a lower deck under one of them), joined by stairs;
 *  - fifty independent wanderers in no flag, drifting between them, some bridged to one island,
 *    some to several;
 *  - thousands of simulated residents. They are not real NFTs: their IDs start at SIM_BASE and
 *    they borrow the on-chain artwork of a few real Friends of the same generation (read live),
 *    so every land looks like a real Rare Friends land. Nobody owns them.
 * The world then keeps moving on its own: residents trade in the markets, and flags raid each
 * other now and then (see tick in index.tsx). */
import { CELL, addBridge, addMember, autoArrange, member, newVillage, rebuild, type Member, type Plot, type Village, type World } from "./world.js";
import * as VX from "./villages.js";
import * as WR from "./war.js";
import * as FF from "./flagfriend.js";

export const SIM_BASE = 9_000_000n;
/** Real activated Friends whose artwork simulated residents borrow, by generation. */
export const TEMPLATES: Record<number, bigint[]> = { 3: [7153n, 7174n, 7573n, 7730n, 7096n], 4: [7060n, 7843n], 5: [7333n], 6: [7834n] };
export const isSim = (id: bigint) => id >= SIM_BASE;
export const templateOf = (m: Member) => { const t = TEMPLATES[m.gen] ?? TEMPLATES[6]; return t[Number(m.id % BigInt(t.length))]; };

/** mulberry32: the same world every time. */
export function seeded(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

type FlagSpec = { name: string; color: string; x: number; y: number; cols: number; rows: number; words: [string[], string[]]; loot: number; ff: number; nod: string;
  decks?: { z: number; cells: [number, number][] }[] };     // islands on upper (z > 0) or lower (z < 0) levels, over (col, row) of the block
/** Nods, not names: the flags people will recognise without a ticker in sight. */
export const SIM_FLAGS: FlagSpec[] = [
  { name: "Cashcat Cove", color: "#00c805", x: 7, y: -9, cols: 6, rows: 6, loot: 420_000, ff: 200_000, nod: "the Robinhood Chain cat that ran",
    decks: [{ z: 1, cells: [[2, 2], [3, 2], [2, 3]] }],
    words: [["Whisker", "Purr", "Tabby", "Catnip", "Kitten", "Pounce", "Meow", "Paw"], ["Wharf", "Point", "Nook", "Den", "Jetty", "Perch", "Loft", "Yard"]] },
  { name: "The Orange Citadel", color: "#f7931a", x: -15, y: -12, cols: 8, rows: 8, loot: 900_000, ff: 600_000, nod: "21 million, not one more",
    decks: [{ z: 1, cells: [[2, 2], [3, 2], [4, 2], [5, 2], [2, 3], [5, 3], [2, 4], [3, 4], [4, 4], [5, 4]] }, { z: 2, cells: [[3, 3], [4, 3], [3, 4], [4, 4]] }, { z: 3, cells: [[3, 3]] }],
    words: [["Genesis", "Halving", "Cold", "Block", "Hash", "Sat", "Whitepaper", "Hodl"], ["Keep", "Vault", "Bastion", "Rampart", "Mint", "Tower", "Hold", "Gate"]] },
  { name: "Ultrasound Bay", color: "#8c8cff", x: 7, y: 6, cols: 6, rows: 6, loot: 650_000, ff: 350_000, nod: "the merge, gwei and burned fees",
    decks: [{ z: 1, cells: [[2, 2], [3, 2]] }, { z: -1, cells: [[2, 3], [3, 3], [4, 3]] }],
    words: [["Gwei", "Merge", "Beacon", "Blob", "Validator", "Gas", "Rollup", "Shard"], ["Harbor", "Quay", "Dock", "Landing", "Pier", "Basin", "Slip", "Mole"]] },
  { name: "Solstice Atoll", color: "#14f195", x: -13, y: 6, cols: 6, rows: 5, loot: 380_000, ff: 150_000, nod: "a summer that never ended, and very fast blocks",
    words: [["Summer", "Sunrise", "Turbine", "Slot", "Leader", "Epoch", "Firedancer", "Degen"], ["Atoll", "Lagoon", "Reef", "Sands", "Cay", "Shore", "Spit", "Beach"]] },
  { name: "Shielded Reef", color: "#f4b728", x: -20, y: 6, cols: 5, rows: 5, loot: 260_000, ff: 90_000, nod: "what's shielded stays shielded",
    words: [["Veiled", "Hidden", "Masked", "Silent", "Proof", "Zero", "Cloaked", "Sapling"], ["Reef", "Grotto", "Hollow", "Cove", "Cavern", "Fen", "Shoal", "Bank"]] },
  { name: "Ripple Shoals", color: "#23c2f5", x: 15, y: -9, cols: 6, rows: 5, loot: 310_000, ff: 120_000, nod: "settles in seconds, since the old days",
    words: [["Ledger", "Settle", "Bridge", "Swift", "Current", "Tide", "Escrow", "Wave"], ["Shoals", "Crossing", "Ferry", "Sound", "Channel", "Inlet", "Straits", "Flats"]] },
];
const WANDERER_WORDS: [string[], string[]] = [["Drifter", "Lone", "Salt", "Castaway", "Nomad", "Tidewalker", "Kelp", "Gull", "Mist", "Rover"], ["Raft", "Skiff", "Buoy", "Barge", "Hut", "Rock", "Float", "Isle", "Cay", "Spar"]];

export type SimWorld = { flags: Village[]; wanderers: Plot[]; islands: number; friends: number };

/**
 * Build the simulated Docks into `w` (after the sample islands are in). Flag Friends, loot
 * vaults and ships go into `ff` and `book`.
 */
export function buildSimulation(w: World, ff: FF.FlagFriends, book: WR.WarBook, seed = 0x0d0c5): SimWorld {
  const rnd = seeded(seed), pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)];
  let next = SIM_BASE, n = 0;
  const used = new Set(w.plots.filter(p => p.berth).map(p => `${p.berth!.x},${p.berth!.y}`));
  const names = new Set(w.plots.map(p => p.name));
  const nameFrom = (words: [string[], string[]]) => {
    for (let i = 0; i < 50; i++) { const s = `${pick(words[0])} ${pick(words[1])}`; if (!names.has(s)) { names.add(s); return s; } }
    const s = `${pick(words[0])} ${pick(words[1])} ${++n}`; names.add(s); return s;
  };
  const residents = (count: number, heavy: boolean) => autoArrange(Array.from({ length: count }, () => {
    const r = rnd(), gen = heavy ? (r < 0.3 ? 3 : r < 0.6 ? 4 : r < 0.85 ? 5 : 6) : (r < 0.15 ? 3 : r < 0.4 ? 4 : r < 0.7 ? 5 : 6);
    return member(next++, gen, Math.floor(rnd() * 5));
  }));
  const island = (id: string, name: string, x: number, y: number, count: number, heavy: boolean, z = 0): Plot => {
    const p: Plot = { id, name, mine: false, access: "open", friends: residents(count, heavy), berth: z ? { x, y, z } : { x, y } };
    if (!z) used.add(`${x},${y}`); w.plots.push(p); return p;
  };
  // every flag's harbor: the free slips along its peace front, kept open for visitors
  const slips = new Set<string>();
  for (const f of SIM_FLAGS) for (let c = 0; c < f.cols; c++) slips.add(`${f.x + c},${f.y + f.rows}`);

  const flags: Village[] = [];
  for (const [fi, f] of SIM_FLAGS.entries()) {
    const isles: { p: Plot; edge: boolean }[] = [];
    const big = fi === 1;   // the Orange Citadel: the oldest and most crowded, past 10,000 Friends (a level 3 citadel)
    for (let r = 0; r < f.rows; r++) for (let c = 0; c < f.cols; c++) {
      const x = f.x + c, y = f.y + r; if (used.has(`${x},${y}`)) continue;
      // war islands on three sides; the last row is the peace harbor front, facing the slips
      const edge = r === 0 || ((c === 0 || c === f.cols - 1) && r < f.rows - 1);
      isles.push({ p: island(`sim-f${fi}-${r}-${c}`, nameFrom(f.words), x, y, big ? (edge ? 100 + Math.floor(rnd() * 60) : 120 + Math.floor(rnd() * 80)) : edge ? 6 + Math.floor(rnd() * 11) : 3 + Math.floor(rnd() * 8), edge), edge });
    }
    for (const d of f.decks ?? []) for (const [c, r] of d.cells)     // upper and lower decks: peace, joined by stairs
      isles.push({ p: island(`sim-f${fi}-z${d.z}-${r}-${c}`, nameFrom(f.words), f.x + c, f.y + r, big ? 60 + Math.floor(rnd() * 60) : 3 + Math.floor(rnd() * 7), false, d.z), edge: false });
    rebuild(w);
    const seat = isles.find(i => !i.edge)!.p, pl = seat.friends[0];
    const v = newVillage(w, seat, f.name, { x: (pl.x + pl.m.cw / 2) * CELL, y: (pl.y + pl.m.ch / 2) * CELL }, VX.FLAG_TARGET, Date.now() - VX.DAY);
    v.color = f.color;
    const founders = isles.slice(0, 6 + Math.floor(rnd() * 6)).map(i => i.p);
    let left = VX.FLAG_TARGET;
    founders.forEach((p, k) => { const amt = k === founders.length - 1 ? left : Math.round(left * (0.2 + rnd() * 0.3) / 1000) * 1000; v.lockers.set(p.name, amt); left -= amt; });
    v.locked = VX.FLAG_TARGET;
    VX.found(w, v);
    v.foundedAt = Date.now() - (20 + Math.floor(rnd() * 60)) * VX.DAY;               // founded weeks ago: past its shield
    if (v.enrollVote) { v.enrollVote.ends = Date.now() - 1; VX.settle(v, v.enrollVote); }
    v.stance.set(seat, "peace");
    for (const { p, edge } of isles) if (p !== seat) addMember(w, v, p, edge ? "war" : "peace");
    v.enrollOpen = true; v.enrollPrice = VX.ENROLL_PRICE;
    v.liquidity += 200_000 + Math.floor(rnd() * 800_000); v.compounded = Math.floor(rnd() * 120_000);
    WR.onFounded(book, v); book.loot.set(v, WR.lootOf(book, v) + f.loot);
    const fr = FF.spawn(ff, v); FF.onFounded(ff, v); FF.fundIt(fr, f.ff, true);
    book.ships.set(v, [...WR.shipsOf(book, v),
      ...Array.from({ length: 2 + Math.floor(rnd() * 4) }, () => ({ id: book.seq++, kind: 1 + Math.floor(rnd() * 3), readyAt: 0, owner: v.name }))]);
    flags.push(v);
  }

  // fifty wanderers in no flag, in open water between the flags, never against a war island
  const wanderers: Plot[] = [];
  const border = new Set<string>(slips);
  for (const v of flags) for (const p of v.members) if (v.stance.get(p) === "war")
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) border.add(`${p.berth!.x + dx},${p.berth!.y + dy}`);
  // The docks are a table: every island in a row or column widens it. Near the start (the sample
  // islands' rows and columns) only small rafts drift, so the first neighbours stay close.
  const nearStart = (x: number, y: number) => (y >= -3 && y <= 4) || (x >= -4 && x <= 5);
  for (let tries = 0; wanderers.length < 50 && tries < 5000; tries++) {
    const x = -21 + Math.floor(rnd() * 43), y = -14 + Math.floor(rnd() * 28), k = `${x},${y}`;
    if (used.has(k) || border.has(k) || (Math.abs(x) <= 3 && Math.abs(y) <= 2)) continue;   // keep the samples' loading zones free
    const small = nearStart(x, y);
    const p = island(`sim-w${wanderers.length}`, nameFrom(WANDERER_WORDS), x, y, small ? 1 + Math.floor(rnd() * 3) : 2 + Math.floor(rnd() * 8), false);
    if (small) p.friends = autoArrange(p.friends.map(pl => member(pl.m.id, 5 + Math.floor(rnd() * 2), pl.m.tier)));
    wanderers.push(p);
  }
  rebuild(w);
  // some bridged to one island, some to several (peace islands or other wanderers)
  const peaceful = [...wanderers, ...flags.flatMap(v => v.members.filter(p => v.stance.get(p) === "peace"))];
  const dist = (a: Plot, b: Plot) => Math.abs(a.berth!.x - b.berth!.x) + Math.abs(a.berth!.y - b.berth!.y);
  wanderers.forEach((p, i) => {
    let want = i % 5 === 0 ? 2 + Math.floor(rnd() * 2) : i % 2 === 0 ? 1 : 0;
    const near = peaceful.filter(q => q !== p && !q.berth!.z && dist(p, q) > 1 && dist(p, q) <= 3).sort((a, b) => dist(p, a) - dist(p, b));
    for (const q of near.slice(0, 6)) { if (want <= 0) break; if (addBridge(w, p, q)) want--; }
  });
  rebuild(w);
  const all = [...flags.flatMap(v => v.members), ...wanderers];
  return { flags, wanderers, islands: all.length, friends: all.reduce((s, p) => s + p.friends.length, 0) };
}
