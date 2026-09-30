"use client";

import { useEffect, useRef, useState } from "react";
import type { GameComponentProps } from "@rarefriends/friendsdk/runtime";
import { GameMenu } from "@rarefriends/friendsdk/frame";
import { createFriendReader, type GenerationSprites } from "@rarefriends/friendsdk/sprites";
import { readFriend, readOwner, type Friend } from "./land.js";
import { readOwnedLands, withRetry } from "./roster.js";
import {
  ARRANGE_FEE, RANKS, addBridge, addToPlot, autoArrange, canEnter, connected, DOCKING_FEE, createWorld, deploy, disconnected, zonesNextTo,
  dockAt, loadingZones, member, memberOf, moveGroup, myPlots, neighboursOf, pendingChanges, plotOf, rankOf, rebuild,
  refreshMember, removeFromPlot, swapInto, undock, weightOf, burnHole, fillHole, holesOf, feeOf,
  CELL, exploring, hostileBorder, stanceOf, canEnterFrom, flagProblem, joinProblem, newVillage, risingFlagOf, tileAt, villageOf, flagTile, walletOf, type Village,
  zOf, levelName, plotBounds, berthDist,
  type Access, type Berth, type Hole, type Member, type Placed, type Plot, type World,
} from "./world.js";
import { DocksView, clampZoom, spawnOn, type CrewMember, type ViewApi } from "./view.js";
import { ChainMap } from "./chainmap.js";
import * as WR from "./war.js";
import * as PC from "./peace.js";
import * as FF from "./flagfriend.js";
import * as SIM from "./sim.js";
import * as SK from "./flagskin.js";
import * as LK from "./looks.js";
import { LAUNCH_FEE, PLATFORM_FEE_BPS, SCOPES, poolName, toPool, claimAll, createEconomy, eligibleFriends, fmt, launch, seedLaunch, type Economy, type Launch, type Scope } from "./launch.js";
import * as VX from "./villages.js";
import type { Item, Proposal } from "./world.js";

const dur = (ms: number) => { const m = Math.max(0, Math.ceil(ms / 60_000)); return m < 60 ? `${m} min` : m < 2880 ? `${Math.ceil(m / 60)} h` : `${Math.ceil(m / 1440)} days`; };
import "@rarefriends/friendsdk/frame.css";
import "./style.css";

type Menu = "control" | "plot" | "docks" | "village" | "war" | "market" | "tokens" | "help" | "settings" | null;
const CHECK_EVERY_MS = 60_000;
const MAX_DRAWN = 40;                             // crew sprites drawn at once (the rest are counted)
const ART_CONCURRENCY = 6, ART_CACHE = 500;       // lazy on-chain art: parallel reads, Friends kept in memory
const PAGE = 50;
/** A small top-down map of an island: every Friend's footprint, lighter for older generations. */
const GEN_FILL: Record<number, string> = { 1: "#ffffff", 2: "#eeeeee", 3: "#d6d6d6", 4: "#bdbdbd", 5: "#a3a3a3", 6: "#8a8a8a" };
function IslandThumb({ p, color }: { p: Plot; color?: string }) {
  const b = plotBounds(p), W = b.x1 - b.x0, H = b.y1 - b.y0, pad = Math.max(W, H) * 0.08 + 0.3;
  return <svg className="docks-thumb" viewBox={`${b.x0 - pad} ${b.y0 - pad} ${W + pad * 2} ${H + pad * 2}`} role="img" aria-label={`${p.name}: ${p.friends.length} Friends`}>
    {p.friends.map(pl => <rect key={String(pl.m.id)} x={pl.x + 0.08} y={pl.y + 0.08} width={pl.m.cw - 0.16} height={pl.m.ch - 0.16} fill={GEN_FILL[pl.m.gen] ?? "#999"} stroke={color ?? "#000"} strokeWidth={0.12} />)}
  </svg>;
}

/* Sample neighbours: other people's public, activated Friends, read live from chain and clearly
 * labelled, floating at their berths. Their access answers are simulated until a shared world exists. */
const SAMPLE_PLOTS: { id: string; name: string; tokens: bigint[]; access: Access; berth: Berth; policy?: "approve" | "decline" }[] = [
  { id: "s1", name: "Reading Row", tokens: [7153n], access: "open", berth: { x: 0, y: 0 } },
  { id: "s2", name: "Rooftop Pair", tokens: [7174n, 7843n], access: "invite", berth: { x: 1, y: 0 }, policy: "approve" },
  { id: "s3", name: "Crystal Keep", tokens: [7096n], access: "invite", berth: { x: 2, y: 0 }, policy: "decline" },
  { id: "s4", name: "Market Cluster", tokens: [7333n, 7834n], access: "open", berth: { x: 1, y: 1 } },
];
const fmtW = (n: number) => n >= 1000 ? Math.round(n).toLocaleString() : String(Math.round(n * 100) / 100);
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).split("\n")[0];

export default function TheDocks({ friendId, client, paused }: GameComponentProps) {
  const definition = client.definition;
  const [ready, setReady] = useState(false);
  const [fatal, setFatal] = useState("");
  const [sprites, setSprites] = useState<GenerationSprites | null>(null);
  const [menu, setMenu] = useState<Menu>(null);
  const [toast, setToast] = useState("Loading Friends from chain…");
  const [, setTick] = useState(0);
  const [zoom, setZoom] = useState(() => (window.innerWidth < 600 ? 1.5 : 2.2));
  const [reducedMotion, setReducedMotion] = useState(false);
  const [islandId, setIslandId] = useState("me-1");            // the island being arranged / docked
  const [arranging, setArranging] = useState(false), [selected, setSelected] = useState<Placed[]>([]), [pickMany, setPickMany] = useState(false);
  const [here, setHere] = useState<Plot | null>(null);
  const [gate, setGate] = useState<Plot | null>(null);
  const [roster, setRoster] = useState<{ state: "loading" | "done" | "error"; done: number; total: number; error?: string }>({ state: "loading", done: 0, total: 0 });
  // Your Friends as walkers: the lead (you control it), a crew that follows it, and Friends left
  // standing somewhere. Everyone else stands on their own land (as the on-chain art shows).
  const [lead, setLead] = useState<bigint>(friendId);
  const [crewModes, setCrewModes] = useState<Map<bigint, "follow" | "park">>(new Map());
  const [crewLeader, setCrewLeader] = useState<Map<bigint, bigint>>(new Map());   // who each walking Friend follows
  const [primary, setPrimary] = useState<bigint>(friendId);                        // the primary leader: "Call all" gathers here
  const [quick, setQuick] = useState<{ id: bigint; x: number; y: number } | null>(null);  // quick options for a tapped Friend
  const [islandPop, setIslandPop] = useState<{ id: string; x: number; y: number } | null>(null); // tapped someone else's island
  const [chatWith, setChatWith] = useState<string | null>(null);                     // island id, or "*" to pick
  const [chatDraft, setChatDraft] = useState("");
  const chats = useRef<Map<string, { from: string; text: string }[]>>(new Map());      // simulated chat per island
  const [naming, setNaming] = useState<bigint | null>(null);                        // Friend being named
  const [nameDraft, setNameDraft] = useState("");
  const names = useRef<Map<bigint, string>>(new Map());                            // Friend → public name (on chain, simulated)
  const mayors = useRef<Map<string, bigint | null>>(new Map());                     // island → mayor (on chain, simulated)
  const defaults = useRef<Map<string, bigint>>(new Map());                          // island → captain (on chain, simulated)
  const [crewSel, setCrewSel] = useState<Set<bigint>>(new Set());
  const [crewBar, setCrewBar] = useState(false);
  const [crewSprites, setCrewSprites] = useState<Map<bigint, GenerationSprites>>(new Map());
  const [page, setPage] = useState(1);
  const [addId, setAddId] = useState(""), [adding, setAdding] = useState(false), [addError, setAddError] = useState("");
  const [checking, setChecking] = useState(false), [lastCheck, setLastCheck] = useState<Date | null>(null);
  const [requests, setRequests] = useState<string[]>([]);
  const [approvedVisitors, setApprovedVisitors] = useState<string[]>([]);
  const [retry, setRetry] = useState(0);
  const [form, setForm] = useState({ name: "", symbol: "", supply: "1000000", airdropScope: "plotAndNeighbours" as Scope | "none", airdropEach: "1000",
    claimScope: "anyDocked" as Scope, claimPool: "100000", claimEach: "500", claimPrice: "5" });
  const [launchError, setLaunchError] = useState("");
  const [flagName, setFlagName] = useState(""), [villageError, setVillageError] = useState("");
  const [firstLock, setFirstLock] = useState("100000"), [lockAmt, setLockAmt] = useState<Record<string, string>>({});
  const [burnPct, setBurnPct] = useState("25"), [buildKind, setBuildKind] = useState(1);
  const asked = useRef<Set<string>>(new Set());                  // sample islands already asked to join your flag
  // On chain (simulated in this preview): islands created on chain and their last saved layouts.
  // Islands are not tokens: the only NFTs are the activated Friends.
  const onChain = useRef<Map<string, number>>(new Map());
  const savedRef = useRef<Map<bigint, { plot: string; x: number; y: number }>>(new Map());
  const simGone = useRef<Set<bigint>>(new Set());               // preview: Friends "sent to another wallet"
  const [sendId, setSendId] = useState("");
  const [saving, setSaving] = useState(false);
  const world = useRef<World | null>(null);
  const econ = useRef<Economy>(createEconomy());
  const book = useRef<WR.WarBook>(WR.newWarBook());
  const market = useRef<PC.Market>(PC.newMarket());
  const flagFriends = useRef<FF.FlagFriends>(new Map());
  const sim = useRef<SIM.SimWorld | null>(null);                                  // the simulated Docks
  const templateArt = useRef<Map<bigint, Friend>>(new Map());   // template art already read
  const templates = useRef<Map<bigint, Promise<Friend>>>(new Map());              // borrowed on-chain art for simulated residents                           // each flag's generated Friend (simulated)                               // peace economy: goods, listings (simulated)
  const [marketAt, setMarketAt] = useState<string | null>(null);
  const [lookOverride, setLookOverride] = useState<number | null>(null);   // preview flag looks at a level   // a flag's market to show first
  const [sellWhat, setSellWhat] = useState("g0"), [sellQty, setSellQty] = useState("10"), [sellPrice, setSellPrice] = useState("10");                               // war: loot vaults, ships, battles (simulated)
  const [tourShip, setTourShip] = useState<number | null>(null), [autoSail, setAutoSail] = useState(true);   // deploying a ship on a tour
  const [shipKind, setShipKind] = useState(1), [vaultAdd, setVaultAdd] = useState("10000");
  const [lastBattle, setLastBattle] = useState<WR.Battle | null>(null);
  const owner = useRef("");
  const api = useRef<ViewApi | null>(null);
  const epoch = useRef(0);
  const plotSeq = useRef(1);
  const art = useRef({ queue: [] as Member[], inflight: new Set<bigint>(), loaded: new Map<bigint, Member>(), seen: new Map<bigint, number>(), tick: 0 });
  const bump = () => setTick(x => x + 1);
  const lastSay = useRef(0);
  const say = (s: string) => { lastSay.current = Date.now(); setToast(s); };
  /** News from the rest of the docks (samples): never covers something you just did. */
  const sayAmbient = (s: string) => { if (Date.now() - lastSay.current > 8_000) setToast(s); };

  /* ── session start: my Friend, sample islands, then all my Friends automatically ── */
  useEffect(() => {
    const v = ++epoch.current;
    setReady(false); setFatal(""); setMenu(null); setArranging(false); setSprites(null); world.current = null;
    art.current = { queue: [], inflight: new Set(), loaded: new Map(), seen: new Map(), tick: 0 };
    const pref = window.matchMedia("(prefers-reduced-motion: reduce)");
    const upd = () => setReducedMotion(pref.matches); upd(); pref.addEventListener("change", upd);
    void createFriendReader().read(friendId).then(s => { if (v === epoch.current) setSprites(s); }).catch(() => {});
    void (async () => {
      try {
        await client.read();                                  // lets the runtime finish loading
        const [me, own] = await Promise.all([readFriend(friendId), readOwner(friendId)]);
        owner.current = own;
        const samples = await Promise.all(SAMPLE_PLOTS.map(async s => {
          const got = await Promise.allSettled(s.tokens.map(id => withRetry(() => readFriend(id), [500, 1_500])));
          const friends = autoArrange(got.flatMap(r => r.status === "fulfilled" ? [memberOf(r.value)] : []));
          return { id: s.id, name: s.name, mine: false, access: s.access, policy: s.policy, friends, berth: s.berth } as Plot;
        }));
        if (v !== epoch.current) return;
        const walker = memberOf(me);
        art.current.loaded.set(walker.id, walker);
        const home: Plot = { id: "me-1", name: "Your island", mine: true, access: "invite", friends: [{ m: walker, x: 0, y: 0 }], berth: null };
        plotSeq.current = 1;
        world.current = createWorld(samples.filter(s => s.friends.length), [home]);
        econ.current = createEconomy(); rosterRetried.current = false; book.current = WR.newWarBook(); market.current = PC.newMarket(); flagFriends.current = new Map(); setLastBattle(null); setTourShip(null); setLead(friendId); setPrimary(friendId); setCrewLeader(new Map()); setQuick(null); setCrewModes(new Map()); setCrewSel(new Set()); setCrewBar(false); setApprovedVisitors([]); setRequests([]); onChain.current = new Map(); savedRef.current = new Map(); simGone.current = new Set(); setIslandId("me-1");
        const mkt = world.current.plots.find(p => p.id === "s4" && p.friends.length);
        if (mkt) seedLaunch(econ.current, { name: "Market Coin", symbol: "MKT", supply: 1_000_000, creator: mkt, creatorFriend: mkt.friends[0].m.id,
          scope: "anyDocked", claimEach: 500, claimPrice: 5, claimRemaining: 50_000 });
        seedVillages(world.current);
        sim.current = SIM.buildSimulation(world.current, flagFriends.current, book.current);
        PC.sampleListings(world.current, market.current);
        asked.current = new Set();
        setReady(true); setLastCheck(new Date());
        say("Finding the rest of your Friends…");
        void loadRoster(v, true);
      } catch (e) {
        if (v !== epoch.current) return;
        const inactive = (e as { inactive?: boolean }).inactive;
        setFatal(inactive ? `${errText(e)} Reactivate it on Rare Friends to bring its land into The Docks.` : `Couldn't read your Friend from chain: ${errText(e)}`);
      }
    })();
    return () => { epoch.current++; pref.removeEventListener("change", upd); };
  }, [client, friendId, retry]); // eslint-disable-line react-hooks/exhaustive-deps

  PC.setPeaceBoost((w, p) => { const v = villageOf(w, p); return FF.peaceBoost(v ? flagFriends.current.get(v) : undefined); });
  WR.setDefenseBoost((w, p) => { const v = villageOf(w, p); return v ? FF.defenseBoost(flagFriends.current.get(v)) * SK.defenseBoost(SK.tierOfFlag(v)) : 1; });
  /** Is this Friend one of its flag's OGs? */
  const isOg = (id: bigint) => { const w = world.current; if (!w) return false; const p = plotOf(w, id), v = p && villageOf(w, p); return Boolean(v && SK.ogFriends(v).has(id)); };
  /** RF into a flag Friend's fund; past its top level the overflow goes to the flag's loot vault. */
  function feedFlagFriend(v: Village, rf: number, revenue: boolean) {
    const f = FF.spawn(flagFriends.current, v), r = FF.fundIt(f, rf, revenue);
    if (r.overflow) book.current.loot.set(v, WR.lootOf(book.current, v) + r.overflow);
    return { f, ...r };
  }
  /** An enrollment grows the population: part of its fee goes to the flag Friend (out of the liquidity half). */
  function afterEnroll(v: Village, price: number) {
    const cut = Math.round(price * FF.FLAG_FRIEND.FROM_ENROLL_BPS / 10_000);
    v.pendingLiquidity = Math.max(0, v.pendingLiquidity - cut);
    return { cut, ...feedFlagFriend(v, cut, false) };
  }
  /** The flag Friend runs the market: its share of a sale's trade tax (out of the flag's share). */
  function afterSale(v: Village | null, tax: number) {
    if (!v || !tax) return;
    const cut = Math.floor(tax * FF.FLAG_FRIEND.TAX_SHARE_BPS / 10_000);
    v.pendingLiquidity = Math.max(0, v.pendingLiquidity - cut); feedFlagFriend(v, cut, true);
  }
  const home = () => plotOf(world.current!, friendId) ?? myPlots(world.current!)[0];
  const island = () => world.current!.plots.find(p => p.id === islandId && p.mine) ?? home();

  /** Every activated Friend in the same wallet joins your island, arranged as one connected block. */
  const rosterRetried = useRef(false);
  async function loadRoster(v: number, first: boolean): Promise<string[]> {
    const w = world.current; if (!w) return [];
    setRoster(r => ({ ...r, state: "loading", done: 0, total: 0 }));
    try {
      const lands = (await readOwnedLands(owner.current, (done, total) => { if (v === epoch.current) setRoster({ state: "loading", done, total }); }))
        .filter(l => !simGone.current.has(l.id));
      if (v !== epoch.current || !world.current) return [];
      const have = new Map(myPlots(w).flatMap(p => p.friends.map(pl => [pl.m.id, pl] as const)));
      const held = new Map(lands.map(l => [l.id, l]));
      const walkerPl = have.get(friendId);
      if (!held.has(friendId) && walkerPl) held.set(friendId, { id: friendId, gen: walkerPl.m.gen, tier: walkerPl.m.tier });
      const changes: string[] = [];
      if (first) {
        const members = [...held.values()].map(l => have.get(l.id)?.m ?? member(l.id, l.gen, l.tier));
        const h = home(); h.friends = autoArrange(members); rebuild(w);
        const sp = spawnOn(w, h.friends.find(p => p.m.id === friendId)!); api.current?.teleport(sp.x, sp.y, sp.z);
        const sc = sim.current, welcome = sc ? ` 🌊 Simulated Docks: ${sc.flags.length} flags, ${sc.islands} islands, ${sc.friends.toLocaleString()} residents; you start with 50,000 RF. Tap ⤢ to see it all.` : "";
        say((members.length > 1 ? `All ${members.length.toLocaleString()} of your activated Friends joined into one floating island. Open Docks to find a loading zone.`
          : "Your Friend is a floating island. Open Docks to find a loading zone next to the others.") + welcome);
      } else {
        for (const id of have.keys()) if (!held.has(id)) changes.push(friendLeft(id));
        for (const l of held.values()) {
          const pl = have.get(l.id);
          if (!pl) changes.push(friendArrived(member(l.id, l.gen, l.tier)));
          else if (pl.m.tier !== l.tier) { changes.push(`#${l.id} tier ${pl.m.tier} → ${l.tier}`); pl.m.tier = l.tier; pl.m.friend = null; art.current.loaded.delete(l.id); }
        }
        if (changes.length) rebuild(w);
      }
      setRoster({ state: "done", done: lands.length, total: lands.length });
      bump();
      return changes;
    } catch (e) {
      if (v !== epoch.current) return [];
      setRoster({ state: "error", done: 0, total: 0, error: errText(e) });
      if (first && !rosterRetried.current) {
        // one more try a little later: public RPCs sometimes refuse a burst at login
        rosterRetried.current = true;
        say("Couldn't list your other Friends yet; trying again in a few seconds…");
        window.setTimeout(() => { if (v === epoch.current) void loadRoster(v, true); }, 6_000);
      } else if (first) say(`Couldn't list your other Friends automatically (${errText(e)}). Tap 🔄 Check to try again, or add them by number in My islands.`);
      return [];
    }
  }

  /** A Friend left the wallet (or was deactivated). Saved on an island: its spot burns into a hole. */
  function friendLeft(id: bigint) {
    const w = world.current!, s = savedRef.current.get(id);
    setCrewModes(c => { const n = new Map(c); n.delete(id); return n; });
    if (id === lead) setLead(friendId);
    if (id === primary) setPrimary(friendId);
    if (s) {
      const from = plotOf(w, id), v = from ? villageOf(w, from) : null;
      if (from) VX.onLeave(w, id, from);
      const r = burnHole(w, id); savedRef.current.delete(id);
      return r ? `#${id} left your wallet: a hole opened on ${r.plot.name}${v ? `; ${v.name}'s population is down one and #${id} stays bound to it until ${new Date(VX.nextEpoch(w)).toLocaleDateString()}` : ""}` : `#${id} left your wallet`;
    }
    removeFromPlot(w, id); return `#${id} left your wallet`;
  }
  /** A Friend arrived. If it left a hole on one of my islands, it heals that hole for free. */
  function friendArrived(m: Member) {
    const w = world.current!, found = holesOf(w).find(x => x.plot.mine && x.hole.id === m.id);
    if (found) {
      const why = VX.placeProblem(w, m.id, found.plot);
      if (why) { addToPlot(w, home(), m); return `#${m.id} came back, but its spot is closed: ${why} It joined ${home().name}.`; }
      fillHole(w, found.plot, found.hole, m); VX.onPlace(w, m.id, found.plot);
      savedRef.current.set(m.id, { plot: found.plot.id, x: found.hole.x, y: found.hole.y });
      return `#${m.id} came back and healed its hole on ${found.plot.name}`;
    }
    addToPlot(w, home(), m); return `#${m.id} joined your island`;
  }
  /** Fill a hole with an activated Friend of the same generation: its own Friend is free, any other pays its arrange fee. */
  function doFillHole(p: Plot, h: Hole, id: bigint) {
    const w = world.current!, pl = myPlots(w).flatMap(q => q.friends).find(x => x.m.id === id);
    if (!pl) return;
    const cost = id === h.id ? 0 : feeOf(pl.m);
    if (econ.current.rf < cost) { say(`Filling this hole costs ${cost} RF; you have ${fmt(econ.current.rf)}.`); return; }
    if (!fillHole(w, p, h, pl.m)) { say("Holes can only be filled by a Friend of the same generation."); return; }
    econ.current.rf -= cost; toPool(econ.current, w, p, cost);
    savedRef.current.set(id, { plot: p.id, x: h.x, y: h.y });
    bump(); say(`Hole on ${p.name} filled with #${id} (simulated)${cost ? `: ${cost} RF into ${poolName(w, p)}` : ": free"} + gas.`);
  }
  /** Preview only: pretend a Friend was sent to another wallet (or brought back), to see what happens. */
  function previewSend(id: bigint) {
    if (id === friendId) return;
    simGone.current.add(id); say(friendLeft(id)); bump();
  }
  function previewReturn(id: bigint) {
    const w = world.current!; simGone.current.delete(id);
    const gen = holesOf(w).find(x => x.hole.id === id)?.hole.gen ?? 6;
    say(friendArrived(member(id, gen, 0))); bump();
  }

  /* ── lazy on-chain art for Friends near the camera ── */
  function onVisible(pls: Placed[]) {
    const a = art.current, t = ++a.tick; let lent = false;
    const queued = new Set(a.queue);
    for (const pl of pls) {
      a.seen.set(pl.m.id, t);
      if (pl.m.friend) continue;
      // simulated residents borrow a template's art: once it's read, hand it straight over
      const got = SIM.isSim(pl.m.id) ? templateArt.current.get(SIM.templateOf(pl.m)) : undefined;
      if (got) { pl.m.friend = got; lent = true; continue; }
      if (!a.inflight.has(pl.m.id) && !queued.has(pl.m)) { a.queue.push(pl.m); queued.add(pl.m); }
    }
    a.queue = a.queue.filter(m => (a.seen.get(m.id) ?? 0) >= t - 1);   // only what's still on screen
    if (lent && world.current) { world.current.version++; bump(); }
    pump();
  }
  function pump() {
    const a = art.current, v = epoch.current;
    while (a.inflight.size < ART_CONCURRENCY && a.queue.length) {
      const m = a.queue.shift()!;
      if (m.friend) continue;
      a.inflight.add(m.id);
      const sim1 = SIM.isSim(m.id), tid = sim1 ? SIM.templateOf(m) : m.id;
      if (sim1 && !templates.current.has(tid)) templates.current.set(tid, withRetry(() => readFriend(tid), [500, 1_500]));
      (sim1 ? templates.current.get(tid)! : readFriend(m.id)).then(f => {
        if (v !== epoch.current) return;
        if (sim1) {                                     // every queued resident of this template at once
          templateArt.current.set(tid, f); m.friend = f;
          for (const q of a.queue) if (SIM.isSim(q.id) && SIM.templateOf(q) === tid) q.friend = f;
          a.queue = a.queue.filter(q => !q.friend);
          if (world.current) world.current.version++;
          bump(); return;
        }
        m.friend = f; m.tier = Number(f.traits["Activation tier"] ?? m.tier); a.loaded.set(m.id, m);
        if (a.loaded.size > ART_CACHE) {                  // forget art for Friends far from the camera
          const old = [...a.loaded.values()].filter(x => x.id !== friendId).sort((x, y) => (a.seen.get(x.id) ?? 0) - (a.seen.get(y.id) ?? 0));
          for (const x of old.slice(0, a.loaded.size - ART_CACHE)) { x.friend = null; a.loaded.delete(x.id); }
        }
        if (world.current) world.current.version++;
        bump();
      }).catch(e => {
        if (sim1) { templates.current.delete(tid); return; }
        if ((e as { inactive?: boolean }).inactive && world.current) {
          const mineToo = myPlots(world.current).some(q => q.friends.some(x => x.m === m));
          if (mineToo) say(friendLeft(m.id).replace("left your wallet", "was deactivated"));
          else { removeFromPlot(world.current, m.id); say(`#${m.id} was deactivated and left the docks.`); }
          bump();
        }
      }).finally(() => { a.inflight.delete(m.id); pump(); });
    }
  }

  /* ── on-chain checks: upgrades, deactivation, transfers, new Friends ── */
  async function checkChain(manual = false) {
    const w = world.current; if (!w || checking) return;
    setChecking(true);
    const changes: string[] = [];
    try {
      changes.push(...await loadRoster(epoch.current, false));
      for (const m of [...art.current.loaded.values()]) {
        if (SIM.isSim(m.id)) continue;   // simulated residents aren't NFTs
        try {
          const fresh = await readFriend(m.id);
          if (m.friend && fresh.signature !== m.friend.signature) {
            const before = `G${m.gen} T${m.tier}`, after = `G${fresh.traits.Generation} T${fresh.traits["Activation tier"]}`;
            refreshMember(w, fresh);
            changes.push(`#${m.id} updated${before !== after ? ` (${before} → ${after})` : ""}`);
          }
        } catch (e) {
          if ((e as { inactive?: boolean }).inactive) {
            if (m.id === friendId) { changes.push(`#${m.id} was deactivated`); continue; }
            const mineToo = myPlots(w).some(q => q.friends.some(x => x.m === m));
            art.current.loaded.delete(m.id);
            changes.push(mineToo ? friendLeft(m.id).replace("left your wallet", "was deactivated") : (removeFromPlot(w, m.id), `#${m.id} was deactivated and left the docks`));
          }
        }
      }
    } finally {
      setChecking(false); setLastCheck(new Date()); bump();
      const uniq = [...new Set(changes)];
      if (uniq.length) say(`On-chain check: ${uniq.slice(0, 4).join(" · ")}${uniq.length > 4 ? ` · +${uniq.length - 4} more` : ""}`);
      else if (manual) say("On-chain check: everything matches the chain.");
    }
  }
  useEffect(() => {
    if (!ready) return;
    const id = window.setInterval(() => { if (!document.hidden) void checkChain(); }, CHECK_EVERY_MS);
    return () => window.clearInterval(id);
  }); // eslint-disable-line react-hooks/exhaustive-deps

  /* ── sprites for the lead and the crew that's drawn ── */
  const drawnCrew = () => {
    const out: bigint[] = []; let follow = 0;
    for (const [id, mode] of crewModes) { if (mode === "follow") { if (follow++ < MAX_DRAWN) out.push(id); } else if (out.length < MAX_DRAWN * 4) out.push(id); }
    return out;
  };
  useEffect(() => {
    for (const id of [lead, ...drawnCrew()]) if (id !== friendId && !crewSprites.has(id)) {
      void createFriendReader().read(id).then(s => setCrewSprites(m => new Map(m).set(id, s))).catch(() => {});
    }
  }, [crewModes, lead]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ── the crew: control any Friend, call, break off, promote, go solo ── */
  const setModes = (ids: Iterable<bigint>, mode: "follow" | "park" | "home", leader = primary) => {
    const list = [...ids].filter(id => id !== lead);
    setCrewModes(c => { const n = new Map(c); for (const id of list) { if (mode === "home") n.delete(id); else { n.delete(id); n.set(id, mode); } } return n; });
    setCrewLeader(c => { const n = new Map(c); for (const id of list) { if (mode === "follow") n.set(id, leader); else n.delete(id); } return n; });
  };
  const leaderOf = (id: bigint) => crewModes.get(id) === "follow" ? crewLeader.get(id) ?? primary : null;
  /** The line behind a leader, front to back. */
  const lineOf = (leader: bigint) => [...crewModes].filter(([id, m]) => m === "follow" && (crewLeader.get(id) ?? primary) === leader).map(([id]) => id);
  function callAll() {
    const stay = new Set(myPlots(world.current!).map(p => mayorOf(p)).filter((m): m is bigint => m !== undefined && m !== lead && m !== primary));
    const ids = myPlots(world.current!).flatMap(p => p.friends.map(x => x.m.id)).filter(id => id !== lead && id !== primary && !stay.has(id));
    if (primary !== lead) setModes([primary], "park");
    setModes(ids, "follow", primary);
    say(ids.length ? `#${primary} called all ${ids.length.toLocaleString()} Friends over. They're on their way${ids.length > MAX_DRAWN ? ` (${MAX_DRAWN} shown walking, the rest counted)` : ""}.${stay.size ? ` ${stay.size === 1 ? "The mayor stays" : "Mayors stay"} home to greet visitors.` : ""}` : stay.size ? `No one to call: ${stay.size === 1 ? "the mayor stays" : "mayors stay"} home to greet visitors.` : "No other Friends to call.");
  }
  /** Take control of any of your Friends. One that was in a line breaks off from its leader. */
  function control(id: bigint) {
    setQuick(null); setCrewSel(new Set());
    if (id === lead) return;
    const old = lead, was = leaderOf(id);
    setCrewModes(c => { const n = new Map(c); n.delete(id); n.set(old, "park"); return n; });
    setCrewLeader(c => { const n = new Map(c); n.delete(id); n.delete(old); return n; });
    setLead(id);
    say(`You control #${id} now${was !== null ? `: it broke off from #${was}'s line` : ""}. #${old} waits where it was${old === primary ? " (still the primary leader: Call all gathers there)" : ""}.`);
  }
  /** #id and everyone behind it in its line break off; you control #id and they follow it. */
  function breakOffCrew(id: bigint) {
    const L = leaderOf(id); if (L === null) return;
    const line = lineOf(L), behind = line.slice(line.indexOf(id) + 1);
    control(id);
    setCrewLeader(c => { const n = new Map(c); for (const b of behind) n.set(b, id); return n; });
    say(`#${id} broke off from #${L} with ${behind.length.toLocaleString()} Friend${behind.length === 1 ? "" : "s"} behind it. You control #${id}.`);
  }
  function promote() {
    if (lead === primary) return;
    setPrimary(lead);
    say(`#${lead} is the primary leader now: Call all gathers your Friends here.`);
  }
  function walkSolo() {
    const mine = lineOf(lead); setModes(mine, "park");
    say(`#${lead} walks solo. ${mine.length.toLocaleString()} Friend${mine.length === 1 ? "" : "s"} wait${mine.length === 1 ? "s" : ""} here.`);
  }
  function onWalkerTap(id: bigint, at: { x: number; y: number }) { setQuick({ id, x: at.x, y: at.y }); }
  function onFriendTap(id: bigint, at: { x: number; y: number }) { setIslandPop(null); setQuick({ id, x: at.x, y: at.y }); }
  function onIslandTap(id: string | null, at: { x: number; y: number }) { setQuick(null); setIslandPop(id ? { id, x: at.x, y: at.y } : null); }
  // kept for the Islands list
  const takeOver = control;

  /* ── each island's captain: the Friend you chose when you connected, saved on chain once and
     used every time you board (change it any time) ── */
  const storeKey = (islandId: string) => `docks-captain:${owner.current.toLowerCase()}:${islandId}`;
  const oldKey = (islandId: string) => `docks-default-leader:${owner.current.toLowerCase()}:${islandId}`;
  function setCaptain(p: Plot, id: bigint, first = false) {
    defaults.current.set(p.id, id);
    if (mayorOf(p) === id) { mayors.current.set(p.id, null); try { localStorage.removeItem(mayorKey(p.id)); } catch { /* ignore */ } }
    try { localStorage.setItem(storeKey(p.id), String(id)); } catch { /* storage unavailable: session only */ }
    setQuick(null); bump();
    if (first) { const m = `#${id} is your captain (change it in 🏝 Islands).`; setToast(t => t ? `${t} ${m}` : m); }
    else say(`${who(id)} is ${p.name}'s captain (simulated on chain, gas only): you'll board as #${id} every time.`);
  }
  /* ── each island's mayor: a second Friend that stays home and greets visitors ── */
  const mayorKey = (islandId: string) => `docks-mayor:${owner.current.toLowerCase()}:${islandId}`;
  const mayorOf = (p: Plot): bigint | undefined => {
    if (!mayors.current.has(p.id)) {
      let v: bigint | null = null;
      try { const s0 = localStorage.getItem(mayorKey(p.id)); if (s0 && /^[0-9]+$/.test(s0)) v = BigInt(s0); } catch { /* ignore */ }
      mayors.current.set(p.id, v);
    }
    const m = mayors.current.get(p.id);
    return m !== null && m !== undefined && p.friends.some(x => x.m.id === m) ? m : undefined;
  };
  function setMayor(p: Plot, id: bigint | null) {
    if (id !== null && defaults.current.get(p.id) === id) { say(`#${id} is ${p.name}'s captain; pick another Friend as mayor.`); return; }
    mayors.current.set(p.id, id);
    try { if (id === null) localStorage.removeItem(mayorKey(p.id)); else localStorage.setItem(mayorKey(p.id), String(id)); } catch { /* session only */ }
    if (id !== null) setModes([id], "home");
    setQuick(null); bump();
    say(id === null ? `${p.name} has no mayor now.` : `${who(id)} is ${p.name}'s mayor (simulated on chain, gas only): it stays home and greets visitors.`);
  }

  /* ── Friend names: public, set by the holder, saved on chain (simulated) ── */
  const nameOf = (id: bigint) => {
    if (!names.current.has(id)) { let v = ""; try { v = localStorage.getItem(`docks-name:${id}`) ?? ""; } catch { /* ignore */ } names.current.set(id, v); }
    return names.current.get(id) || "";
  };
  const who = (id: bigint) => { const n = nameOf(id); return n ? `${n} (#${id})` : `#${id}`; };
  function saveName(id: bigint, raw: string) {
    const n = raw.trim().replace(/\s+/g, " ");
    if (new TextEncoder().encode(n).length > 24) { say("Names are up to 24 characters."); return; }
    names.current.set(id, n);
    try { if (n) localStorage.setItem(`docks-name:${id}`, n); else localStorage.removeItem(`docks-name:${id}`); } catch { /* session only */ }
    setNaming(null); bump();
    say(n ? `#${id} is now named “${n}” (saved on chain, simulated, gas only; everyone sees it).` : `#${id}'s name was cleared.`);
  }

  useEffect(() => {
    if (!ready || roster.state !== "done") return;
    const h = home(); let d = defaults.current.get(h.id);
    if (d === undefined) { try { const v = localStorage.getItem(storeKey(h.id)) ?? localStorage.getItem(oldKey(h.id)); if (v && /^[0-9]+$/.test(v)) { d = BigInt(v); defaults.current.set(h.id, d); } } catch { /* ignore */ } }
    // First time: the Friend picked in "Choose your captain" becomes this island's captain. No second prompt.
    if (d === undefined) { if (plotOf(world.current!, friendId)?.mine) setCaptain(h, friendId, true); return; }
    if (plotOf(world.current!, d)?.mine && d !== lead) { setLead(d); setPrimary(d); say(`Welcome back, Captain #${d} of ${h.name}.`); }
  }, [ready, roster.state]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ── actions ── */
  function goTo(p: Plot) {
    const w = world.current!, pl = p.friends.find(x => x.m.id === lead) ?? p.friends[0];
    if (pl) { const sp = spawnOn(w, pl); api.current?.teleport(sp.x, sp.y, sp.z); }
  }
  function askToVisit(p: Plot) {
    const w = world.current!; if (w.visits.get(p.id) === "pending") return;
    w.visits.set(p.id, "pending"); bump(); say(`Asked ${p.name} to visit…`);
    window.setTimeout(() => {
      const ok = p.policy !== "decline";
      w.visits.set(p.id, ok ? "approved" : "declined"); w.version++; bump();
      say(ok ? `${p.name} approved your visit (simulated). Walk on in.` : `${p.name} declined your visit (simulated).`);
    }, 2200);
  }
  async function addFriend() {
    const w = world.current; if (!w) return;
    setAddError("");
    let id: bigint;
    try { id = BigInt(addId.trim().replace(/^#/, "")); if (id < 1n) throw 0; } catch { setAddError("Enter a Friend number, like 1234."); return; }
    if (plotOf(w, id)) { setAddError(`Friend #${id} is already in the docks.`); return; }
    setAdding(true);
    try {
      const o = await readOwner(id);
      if (o !== owner.current) { setAddError(`Friend #${id} isn't held by the same wallet as #${friendId}.`); return; }
      const f = await readFriend(id);
      const m = memberOf(f); art.current.loaded.set(id, m);
      addToPlot(w, island(), m);
      setAddId(""); bump(); say(`Friend #${id} joined ${island().name} (G${m.gen} T${m.tier}).`);
    } catch (e) { setAddError(errText(e)); }
    finally { setAdding(false); }
  }
  function newIsland() {
    const w = world.current!, id = `me-${++plotSeq.current}`;
    w.plots.unshift({ id, name: `Island ${plotSeq.current}`, mine: true, access: "invite", friends: [], berth: null });
    rebuild(w); setIslandId(id); bump();
    say(`Island ${plotSeq.current} is ready. Deploy Friends to it from the list; it floats free until you dock it.`);
  }
  function deployTo(id: bigint, to: string) {
    const w = world.current!, target = w.plots.find(p => p.id === to);
    if (!target) return;
    const from = plotOf(w, id);
    const why = VX.placeProblem(w, id, target); if (why) { say(why); return; }
    if (from) VX.onLeave(w, id, from);
    deploy(w, id, target); VX.onPlace(w, id, target);
    if (from && !from.friends.length && from.id !== "me-1" && !onChain.current.has(from.id)) { w.plots = w.plots.filter(p => p !== from); rebuild(w); }
    bump(); say(`#${id} deployed to ${target.name}. Save on chain to make it official.`);
  }
  function startArranging() {
    const p = island();
    setMenu(null); setArranging(true);
    const first = p.friends.find(x => x.m.id === lead) ?? p.friends[0];
    setSelected(first ? [first] : []); setPickMany(false);
    say(`Arranging ${p.name}: tap a Friend to move it, turn on "Pick several" to move a group, or All. Each Friend must touch another along part of a side.`);
  }
  function nudge(dx: number, dy: number) {
    const w = world.current; if (!w || !arranging || !selected.length) return;
    const p = plotOf(w, selected[0].m.id); if (!p) return;
    const group = selected.filter(x => p.friends.includes(x));
    const one = group.length === 1 ? group[0] : null;
    const ok = moveGroup(w, p, group, dx, dy) || (one ? swapInto(w, p, one, one.m.cw * dx, one.m.ch * dy) : false);
    if (!ok) say(one ? "That spot overlaps a different-size Friend. Move that one first, or swap with a same-size neighbour." : "Something else is in the way of this group.");
    bump();
  }
  function reArrange() {
    const w = world.current!, p = island();
    p.friends = autoArrange(p.friends.map(x => x.m)); rebuild(w);
    setSelected([]);
    bump(); say(`Auto-arranged ${p.name} into one connected block.`);
  }
  function finishArranging() {
    const w = world.current!, p = island();
    const loose = disconnected(w, p);
    if (loose.length) {
      setSelected([loose[0]]);
      say(`${loose.length.toLocaleString()} Friend${loose.length === 1 ? " doesn't" : "s don't"} touch the rest (#${loose[0].m.id} selected). Every Friend must touch another along part of a side, or tap Auto-arrange.`);
      return;
    }
    setArranging(false); setSelected([]); goTo(home()); bump();
  }
  /** Save every changed island on chain (simulated): create islands as needed, pay RF per Friend moved into each island's pool. */
  async function saveOnChain() {
    const w = world.current!;
    for (const p of myPlots(w)) {
      const loose = disconnected(w, p);
      if (loose.length) { setIslandId(p.id); setArranging(true); setSelected([loose[0]]); say(`Can't save yet: on ${p.name}, ${loose.length.toLocaleString()} Friend${loose.length === 1 ? " doesn't" : "s don't"} touch the rest.`); return; }
    }
    const c = pendingChanges(w, savedRef.current);
    if (!c.moved.length && !c.gone.length) { say("Nothing to save: your islands match the chain."); return; }
    if (econ.current.rf < c.rf) { say(`Saving costs ${fmt(c.rf)} RF; you have ${fmt(econ.current.rf)}.`); return; }
    setSaving(true);
    await new Promise(r => setTimeout(r, 900));               // stands in for wallet confirmation + receipt
    const minted: number[] = [];
    for (const p of myPlots(w)) if (p.friends.length && !onChain.current.has(p.id)) { const n = 1 + Math.floor(Math.random() * 900); onChain.current.set(p.id, n); minted.push(n); }
    econ.current.rf -= c.rf;
    for (const pl of c.moved) toPool(econ.current, w, plotOf(w, pl.m.id), feeOf(pl.m));
    const pools = [...new Set(c.moved.map(pl => poolName(w, plotOf(w, pl.m.id))))];
    savedRef.current = new Map(myPlots(w).flatMap(p => p.friends.map(pl => [pl.m.id, { plot: p.id, x: pl.x, y: pl.y }] as const)));
    setSaving(false); setArranging(false); setSelected([]);
    const txs = Math.max(1, c.plots.length, Math.ceil(c.moved.length / 100));
    say(`Saved on chain (simulated)${minted.length ? `: created Island #${minted.join(", #")} on chain` : ""} · ${c.moved.length.toLocaleString()} Friend${c.moved.length === 1 ? "" : "s"} moved · ${fmt(c.rf)} RF into ${pools.join(" and ")} · ${txs} transaction${txs === 1 ? "" : "s"} + gas.`);
  }
  function discardChanges() {
    const w = world.current!;
    const saved = savedRef.current;
    if (!saved.size) { reArrange(); return; }
    const mine = myPlots(w), byId = new Map(mine.map(p => [p.id, p]));
    const all = mine.flatMap(p => p.friends);
    for (const p of mine) p.friends = [];
    const unsaved: Member[] = [];
    for (const pl of all) {
      const s = saved.get(pl.m.id), to = s && byId.get(s.plot);
      if (s && to) { pl.x = s.x; pl.y = s.y; to.friends.push(pl); } else unsaved.push(pl.m);
    }
    rebuild(w);
    for (const m of unsaved) addToPlot(w, home() ?? mine[0], m);
    goTo(home()); setArranging(false); setSelected([]); bump(); say("Back to your saved islands.");
  }
  function dockIsland(b: Berth) {
    const w = world.current!, p = island();
    if (!p.friends.length) { say("Deploy at least one Friend to this island before docking it."); return; }
    if (econ.current.rf < DOCKING_FEE) { say(`Docking costs a ${DOCKING_FEE} RF docking fee; you have ${fmt(econ.current.rf)}.`); return; }
    if (!dockAt(w, p, b)) { say("That loading zone was just taken."); return; }
    econ.current.rf -= DOCKING_FEE; econ.current.docksFund += DOCKING_FEE;
    setMenu(null); setIslandPop(null); goTo(p); bump();
    const n = neighboursOf(w, p).filter(q => !q.mine), fl = n.map(q => villageOf(w, q)).find(Boolean);
    say(`${p.name} docked${zOf(b) ? ` on the ${levelName(zOf(b)).toLowerCase()}` : ""}${neighboursOf(w, p).length ? ` next to ${neighboursOf(w, p).map(q => q.name).join(", ")}` : ""}: ${DOCKING_FEE} RF docking fee into The Docks fund (simulated). ${zOf(b) ? "Stairs join the levels" : "A boardwalk joins you"}: your Friends can walk across.${fl ? ` You're at ${fl.name}'s harbor: its whole market is open to you (🧺 Market).` : ""}${n.length ? " 💬 Chat is open with your new neighbours." : ""}`);
  }
  /** Tap another island → Dock: the first free loading zone right next to it. */
  /** Tap another island → Dock: the first free loading zone beside it (or, with `level`, straight above/below it). */
  function dockNextTo(target: Plot, level?: "above" | "below") {
    const w = world.current!, p = island(), tz = zOf(target.berth);
    if (connected(w, p, target)) { say(`${p.name} is already next to ${target.name}.`); return; }
    const z = zonesNextTo(w, p, target).filter(b => level === "above" ? zOf(b) > tz : level === "below" ? zOf(b) < tz : zOf(b) === tz);
    if (!z.length) { say(`No free loading zone ${level ?? "next to"} ${target.name}. Build a bridge to it instead (${DOCKING_FEE} RF docking fee).`); return; }
    dockIsland(z[0]);
  }
  /** Free loading zones at a flag's harbor: beside, above or below any of its peace islands. */
  function harborOf(v: Village) {
    const w = world.current!, p = island(), out: { b: Berth; next: Plot }[] = [], seen = new Set<string>();
    for (const m of v.members) if (stanceOf(w, m) !== "war") for (const b of zonesNextTo(w, p, m)) { const k = `${b.x},${b.y},${zOf(b)}`; if (!seen.has(k)) { seen.add(k); out.push({ b, next: m }); } }
    return out.sort((a, b) => Math.abs(zOf(a.b)) - Math.abs(zOf(b.b)) || (p.berth ? berthDist(a.b, p.berth) - berthDist(b.b, p.berth) : 0));
  }
  function dockAtHarbor(v: Village) {
    const w = world.current!, p = island();
    if (v.members.some(m => connected(w, p, m) && stanceOf(w, m) !== "war")) { setMenu(null); goTo(p); say(`${p.name} is already at ${v.name}'s harbor: walk over, or open 🧺 Market to trade with it.`); return; }
    const h = harborOf(v)[0];
    if (!h) { say(`${v.name}'s harbor is full right now. Dock above or below one of its peace islands, or bridge to one.`); return; }
    dockIsland(h.b);
  }
  function buildBridge(to: Plot) {
    const w = world.current!, p = island();
    if (econ.current.rf < DOCKING_FEE) { say(`A bridge costs a ${DOCKING_FEE} RF docking fee; you have ${fmt(econ.current.rf)}.`); return; }
    if (!addBridge(w, p, to)) { say(p.berth ? "You're already connected to that island." : `Dock ${p.name} first, then bridge.`); return; }
    econ.current.rf -= DOCKING_FEE; econ.current.docksFund += DOCKING_FEE;
    setMenu(null); setIslandPop(null); bump();
    say(`Bridge built from ${p.name} to ${to.name}: ${DOCKING_FEE} RF docking fee into The Docks fund (simulated). Your Friends can walk across; it lasts until either island moves.`);
  }
  /* ── chat with docked neighbours (simulated: sample islands answer on their own) ── */
  const chatNeighbours = () => { const w = world.current!, mineP = myPlots(w);
    return w.plots.filter(q => !q.mine && q.friends.length && mineP.some(m => connected(w, m, q))); };
  const canChat = (p: Plot) => chatNeighbours().includes(p);
  function openChat(p?: Plot) {
    setIslandPop(null); setQuick(null); setChatDraft("");
    const n = chatNeighbours();
    if (p && !canChat(p)) { say(`Dock next to ${p.name} (or bridge to it) to chat.`); return; }
    if (!p && !n.length) { say("Dock next to someone else's island to chat with them."); return; }
    setChatWith(p ? p.id : n.length === 1 ? n[0].id : "*");
  }
  const REPLIES = ["Ahoy, neighbour!", "Welcome to the docks.", "Nice island. How many Friends are on it?", "Want to raise a flag together?", "Come explore across the gangway anytime.", "Good winds to your captain."];
  function sendChat(p: Plot) {
    const text = chatDraft.trim().slice(0, 280);
    if (!text) return;
    if (!canChat(p)) { say(`You're no longer docked with ${p.name}.`); setChatWith(null); return; }
    const log = chats.current.get(p.id) ?? [];
    log.push({ from: "You", text }); chats.current.set(p.id, log.slice(-50)); setChatDraft(""); bump();
    window.setTimeout(() => {
      const l = chats.current.get(p.id) ?? [];
      l.push({ from: p.name, text: REPLIES[(l.length + p.name.length) % REPLIES.length] }); chats.current.set(p.id, l.slice(-50)); bump();
    }, 900);
  }
  /* ── villages: plant a flag, everyone locks RF until it's full, then it's a flag ── */
  /** Samples: Market Town (founded by Market Cluster + Rooftop Pair) and a rising flag on Crystal Keep. */
  function seedVillages(w: World) {
    const at = (p: Plot) => { const f = p.friends[0]; return { x: (f.x + f.m.cw / 2) * CELL, y: (f.y + f.m.ch / 2) * CELL }; };
    const market = w.plots.find(p => p.id === "s4" && p.friends.length), rooftop = w.plots.find(p => p.id === "s2" && p.friends.length);
    const keep = w.plots.find(p => p.id === "s3" && p.friends.length);
    if (market) {
      const v = newVillage(w, market, "Market Town", at(market), VX.FLAG_TARGET, Date.now() - VX.DAY);
      v.lockers.set(market.name, 700_000); v.lockers.set(rooftop?.name ?? "Rooftop Pair", 300_000); v.locked = VX.FLAG_TARGET;
      VX.found(w, v); if (rooftop) VX.bring(w, v, rooftop, "war");   // Market Cluster at peace in the middle, Rooftop Pair its war border
      v.foundedAt -= 10 * VX.DAY; if (v.enrollVote) { v.enrollVote.ends = Date.now() - 1; VX.settle(v, v.enrollVote); }   // founded 10 days ago, kept open
      WR.onFounded(book.current, v); FF.onFounded(flagFriends.current, v); WR.fund(book.current, { ...econ.current, rf: Infinity }, v, 50_000);
      book.current.ships.set(v, [...WR.shipsOf(book.current, v), { id: book.current.seq++, kind: 1, readyAt: 0, owner: v.name }]);
    }
    const reed = w.plots.find(p => p.id === "s1" && p.friends.length);
    if (reed) {   // a small flag: a fair first target
      const v = newVillage(w, reed, "Reed Harbor", at(reed), 200_000, Date.now() - VX.DAY);
      v.lockers.set(reed.name, 200_000); v.locked = 200_000;
      VX.found(w, v); v.foundedAt -= 30 * VX.DAY; if (v.enrollVote) { v.enrollVote.ends = Date.now() - 1; VX.settle(v, v.enrollVote); }
      WR.onFounded(book.current, v); FF.onFounded(flagFriends.current, v); WR.fund(book.current, { ...econ.current, rf: Infinity }, v, 5_000);
    }
    if (keep) {
      const v = newVillage(w, keep, "Crystal Hollow", at(keep), VX.FLAG_TARGET, Date.now() + 12 * VX.DAY);
      v.lockers.set(keep.name, 350_000); v.locked = 350_000; w.version++; FF.spawn(flagFriends.current, v);
    }
  }
  const act = (f: () => void) => { setVillageError(""); try { f(); bump(); } catch (e) { setVillageError(errText(e)); } };
  const rfIn = (v: string) => Math.max(0, Math.floor(Number(v.replace(/[,_\s]/g, "")) || 0));
  function doPlantFlag() {
    const w = world.current!; setVillageError("");
    const pos = api.current?.position(); if (!pos) return;
    const p = tileAt(w, Math.floor(pos.x), Math.floor(pos.y), pos.z)?.plot ?? null;
    if (!p || !p.mine) { setVillageError(`Walk #${lead} onto one of your docked islands first: the flag goes where your lead stands.`); return; }
    if (!onChain.current.has(p.id)) { setVillageError(`Save ${p.name} on chain first (Arrange → Save): flags go on saved, docked islands.`); return; }
    const o = w.origin.get(p)!, at = { x: pos.x - o.x, y: pos.y - o.y };
    const why = flagProblem(w, p, at) ?? (flagName.trim() ? null : "Name your flag.");
    if (why) { setVillageError(why); return; }
    act(() => {
      const v = VX.plant(w, econ.current, p, flagName, at, rfIn(firstLock)); setFlagName(""); setMenu(null);
      const f = FF.spawn(flagFriends.current, v); void f;
      say(`🚩 ${v.name}'s flag is up on ${p.name} (simulated): ${fmt(v.locked)} of ${fmt(v.target)} RF locked. Anyone can lock RF into it for ${VX.FLAG_DAYS} days; full, it's founded.`);
    });
  }
  function doLock(v: Village) {
    act(() => { const n = VX.lock(world.current!, econ.current, v, rfIn(lockAmt[v.id] ?? "10000"));
      say(`You locked ${fmt(n)} RF into ${v.name}'s flag (simulated) · ${VX.pct(v)}% full. Your founder mark grew.`); });
  }
  function doFound(v: Village) {
    act(() => { VX.found(world.current!, v); const loot = WR.onFounded(book.current, v), ff = FF.onFounded(flagFriends.current, v); setMenu(null); lookAtFlag(v);
      say(`🏛 ${v.name} is founded! ${fmt(v.liquidity)} RF into permanent RF/ETH liquidity, ${fmt(v.locked / 2)} RF as founders' allowances to build with, ${fmt(loot)} RF into its loot vault, ${fmt(ff.n)} RF to upgrade ${FF.spawn(flagFriends.current, v).name}, its flag Friend (simulated). Nobody can pull it. ${WR.WAR.SHIELD_DAYS} days of shield to get battle ready.`); });
  }
  function doRefund(v: Village) { act(() => { const n = VX.refund(world.current!, econ.current, v); say(`${fmt(n)} RF came back from ${v.name}'s flag.`); }); }
  function doHarvest(v: Village) {
    act(() => { const r = VX.harvest(v, econ.current, VX.YOU, WR.WAR.LOOT_FROM_FEES_BPS); book.current.loot.set(v, WR.lootOf(book.current, v) + r.loot);
      say(`Harvested ${v.name} (simulated): ${fmt(r.rf)} RF + ${r.eth.toFixed(3)} ETH in fees → bought ${fmt(r.bought)} RF · ${fmt(r.toPool)} back into the pool · ${fmt(r.kept)} shared by Friends as allowances · ${fmt(r.loot)} into the loot vault.`); });
  }
  function doPropose(v: Village) {
    act(() => { const p = VX.proposePoolShare(v, VX.YOU, Math.round(Math.min(100, Math.max(0, Number(burnPct) || 0)) * 100));
      say(`Proposal #${p.id + 1} is up for ${v.name} (${VX.VOTE_DAYS}-day vote; every Friend is a vote).`); });
  }
  const stanceWord = (st: "war" | "peace") => st === "war" ? "⚔️ a war island (fights, boards ships, defends the flag)" : "🕊 a peace island (makes goods and trades)";
  function doBring(v: Village, p: Plot, st: "war" | "peace") {
    act(() => { VX.bring(world.current!, v, p, st); say(`${p.name} is in ${v.name} as ${stanceWord(st)}: your ${p.friends.length.toLocaleString()} Friends vote ×${VX.multiplier(v, VX.YOU).toFixed(2)} (founder, simulated).`); });
  }
  function doEnroll(v: Village, p: Plot, st: "war" | "peace") {
    act(() => { const n = VX.enroll(world.current!, econ.current, v, p, st); afterEnroll(v, n); say(`${p.name} enrolled in ${v.name} as ${stanceWord(st)} for ${fmt(n)} RF (simulated): ${fmt(n / 2)} to liquidity, ${fmt(n / 2)} your allowance. Its ${p.friends.length.toLocaleString()} Friends vote.`); });
  }
  function doStance(v: Village, p: Plot, st: "war" | "peace") {
    act(() => { const other = VX.setStance(world.current!, v, p, st); say(`${p.name} is now ${stanceWord(st)} in ${v.name}.${other ? ` ${other.name} swapped to ${st === "war" ? "peace" : "war"}: one of each.` : ""}${st === "war" ? " Outsiders can't dock straight against it." : " Anyone can dock next to it and trade."}`); });
  }
  function doSettle(v: Village, p: Proposal) {
    act(() => { const msg = VX.settle(v, p);
      if (p.kind === "war" && p.winner === 1) { const t = world.current!.villages[p.options[0]]; if (t) { const war = WR.declareWar(book.current, v, t); say(`⚔️ ${msg} For ${WR.WAR.WAR_DAYS} days: raids on ${t.name} skip the cooldown and pay a double bounty (until ${new Date(war.until).toLocaleDateString()}).`); return; } }
      say(msg); });
  }
  /* ── war (simulated): raids between founded flags of a similar tier ── */
  const myFlag = () => myPlots(world.current!).map(p => villageOf(world.current!, p)).find((v): v is Village => Boolean(v)) ?? null;
  function reportBattle(b: WR.Battle) {
    setLastBattle(b);
    const you = b.shares.get(VX.YOU) ?? 0, a = b.attacker, d = b.defender;
    const res = b.attackerWon === null ? "drew" : b.attackerWon ? "won" : "lost";
    say(`${b.attackerWon === null ? "🤝" : b.attackerWon ? "🏆" : "💥"} ${a.name} ${res} the raid on ${d.name} (duels ${b.duels.map(x => x.won === null ? "–" : x.won ? "✓" : "✗").join(" ")}, simulated)${b.attackerWon === null ? ": no loot moved" : `: ${fmt(b.loot + b.bounty)} RF of loot to ${b.attackerWon ? a.name : d.name}`}${you ? `, ${fmt(Math.floor(you))} RF earned by your island (claim it in ⚔️ War)` : ""}.${b.attackerWon === false ? ` The ${WR.SHIPS[b.ships[0].kind].name} sank; it comes back in ${WR.WAR.SHIP_REGEN_HOURS} h.` : ""}`);
  }
  function doDeploy(a: Village, d: Village) {
    act(() => {
      const w = world.current!, me = a.members.find(p => p.mine); if (!me) throw new Error(`Bring an island into ${a.name} first.`);
      if (tourShip === null) throw new Error("Pick a ship to send.");
      const t = WR.deployTour(w, book.current, a, d, tourShip, me, autoSail); setTourShip(null);
      const s = WR.SHIPS[t.ship.kind];
      if (t.autoSail && WR.full(t)) { reportBattle(WR.sail(w, book.current, econ.current, t, WR.autoDefenders(d))); return; }
      say(`${s.icon} ${s.name} on tour to ${d.name} (simulated): ${t.crew.length}/${s.seats} aboard. ${t.autoSail ? "It sails when full." : "Sail when you're ready."}`);
    });
  }
  function doSail(t: WR.Tour) { act(() => reportBattle(WR.sail(world.current!, book.current, econ.current, t, WR.autoDefenders(t.target)))); }
  function doRequestRemoval(v: Village, p: Plot) {
    act(() => { const at = VX.requestRemoval(world.current!, v, p); say(`${p.name} leaves ${v.name} at the next epoch, ${new Date(at).toLocaleDateString()} (simulated). No RF back; your unspent allowance stays with the flag and its items there go to a raffle.`); });
  }
  /** Where the lead stands on its island (island-local tiles), to build or plant there. */
  function leadSpot() {
    const w = world.current!, pos = api.current?.position(); if (!pos) return null;
    const p = tileAt(w, Math.floor(pos.x), Math.floor(pos.y), pos.z)?.plot ?? null; if (!p) return null;
    const o = w.origin.get(p)!; return { p, ...VX.cellAt({ x: pos.x - o.x, y: pos.y - o.y }) };
  }
  function doBuild(v: Village | null) {
    const w = world.current!, at = leadSpot();
    act(() => {
      if (!at || !at.p.mine) throw new Error(`Walk #${lead} onto the spot on your island where it should go.`);
      const it = v ? (() => { if (!VX.islandsOf(v, VX.YOU).includes(at.p)) throw new Error(`Stand on one of your ${v.name} islands (${VX.islandsOf(v, VX.YOU).map(p => p.name).join(", ") || "bring or enroll one first"}).`); return VX.buyForVillage(w, v, VX.YOU, buildKind, at.cx, at.cy, at.p); })()
        : VX.buyOwn(w, econ.current, VX.YOU, buildKind, at.p, at.cx, at.cy);
      const c = VX.CATALOG[it.kind]; setMenu(null);
      say(`${c.icon} ${c.name} is being built on ${at.p.name} (simulated): ready in ${dur(it.readyAt - Date.now())}. ${v ? `Paid from your ${v.name} allowance; it belongs to the flag.` : "Paid with your RF; it's yours."} Boost it with RF to finish sooner.`);
    });
  }
  function doBoost(it: Item, rf: number) {
    act(() => { VX.boost(world.current!, econ.current, it, rf); say(Date.now() >= it.readyAt ? `${VX.CATALOG[it.kind].icon} ${VX.CATALOG[it.kind].name} is built.` : `Boosted: ready in ${dur(it.readyAt - Date.now())}.`); });
  }
  function doPlaceOwn(it: Item) {
    const w = world.current!, at = leadSpot();
    act(() => { if (!at || !at.p.mine) throw new Error(`Walk #${lead} onto the spot on your island where it should go.`); VX.placeOwn(w, it, VX.YOU, at.p, at.cx, at.cy); setMenu(null); say(`${VX.CATALOG[it.kind].icon} placed on ${at.p.name}.`); });
  }
  function lookAtFlag(v: Village) {
    const t = flagTile(world.current!, v); setMenu(null); if (t) api.current?.focusOn(t.x, t.y, zOf(v.seat.berth));
  }
  // the simulated world around your flags: sample lockers, trading fees, sample votes, sample islands joining
  useEffect(() => {
    if (!ready) return;
    const t = window.setInterval(() => {
      const w = world.current; if (!w || paused) return;
      const samples = w.plots.filter(p => !p.mine && p.friends.length);
      let msg = "";
      for (const v of w.villages) {
        if (VX.rising(v) && Math.random() < 0.35 && samples.length) {
          const who = samples[Math.floor(Math.random() * samples.length)].name;
          const n = VX.lock(w, null, v, Math.min(v.target - v.locked, 20_000 + Math.floor(Math.random() * 60) * 1000), who);
          if (v.seat.mine) msg = `${who} (sample) locked ${fmt(n)} RF into ${v.name}'s flag · ${VX.pct(v)}%.`;
        }
        VX.accrueFees(v);
        if (v.founded && Math.random() < 0.15) for (const m of v.members) if (!m.mine && VX.allowanceOf(v, walletOf(m)) >= 1000 && VX.itemsOn(w, m).length < 3) {
          const pl = m.friends[Math.floor(Math.random() * m.friends.length)];
          try { VX.buyForVillage(w, v, walletOf(m), 0, pl.x, pl.y); } catch { /* spot taken */ }
          break;
        }
        for (const r of v.raffles) if (Date.now() < r.ends && Math.random() < 0.3) {
          const m = v.members.find(x => !x.mine && Math.random() < 0.5); if (m) VX.buyTickets(w, null, v, r, walletOf(m), 1 + Math.floor(Math.random() * 3));
        }
        for (const p of v.proposals) for (const m of v.members) {
          const who = walletOf(m);
          if (who !== VX.YOU && !p.voters.has(who) && Date.now() < p.ends && Math.random() < 0.5)
            VX.vote(v, p, who, p.tally.length === 2 ? (Math.random() < 0.75 ? 1 : 0) : Math.floor(Math.random() * p.tally.length));
        }
        for (const p of v.proposals) if (!p.settled && Date.now() >= p.ends && !v.seat.mine && !VX.islandOf(v, VX.YOU)) VX.settle(v, p);
        if (VX.enrollPrice(v) && v.seat.mine && Math.random() < 0.3) {
          const q = w.plots.find(p => !p.mine && !asked.current.has(p.id) && !joinProblem(w, v, p));
          if (q) { asked.current.add(q.id);
            if (q.policy === "decline") msg = `${q.name} (sample) passed on enrolling in ${v.name}.`;
            else { afterEnroll(v, VX.enroll(w, null, v, q)); msg = `${q.name} (sample) enrolled in ${v.name} for ${fmt(v.enrollPrice)} RF: ${q.friends.length} more Friends. 🚩`; } }
        }
      }
      for (const line of VX.processRemovals(w)) msg = line;
      // the market: sample islands that can reach your listings buy some; samples restock theirs
      for (const l of [...market.current.listings]) if (l.seller === VX.YOU && Math.random() < 0.35) {
        const buyer = samples.find(q => !PC.tradeProblem(w, q, l.from));
        if (buyer) { const r = PC.buy(w, market.current, null, l, 1 + Math.floor(Math.random() * l.qty), buyer, walletOf(buyer), econ.current); afterSale(r.village, r.tax);
          msg = `🧺 ${buyer.name} (sample) bought ${l.good !== null ? PC.GOODS[l.good].name : VX.CATALOG[l.item!.kind].name} from you for ${fmt(r.total)} RF${r.tax ? ` (${fmt(r.tax)} RF tax to ${r.flag})` : ""}.`; }
      }
      if (Math.random() < 0.2) PC.sampleListings(w, market.current);
      // the simulated Docks keep moving: residents trade, flags raid now and then
      const others = w.plots.filter(p => !p.mine && p.friends.length && PC.peaceful(w, p));
      for (let k = 0; k < 3; k++) {
        const ls = market.current.listings.filter(l => l.seller !== VX.YOU); if (!ls.length || !others.length) break;
        const l = ls[Math.floor(Math.random() * ls.length)];
        const fl = villageOf(w, l.from), pool = fl ? fl.members.filter(p => p !== l.from && PC.peaceful(w, p)) : others;
        const buyer = [0, 1, 2, 3, 4].map(() => pool[Math.floor(Math.random() * pool.length)]).find(q => q && !PC.tradeProblem(w, q, l.from));
        if (buyer) { try { const r = PC.buy(w, market.current, null, l, 1 + Math.floor(Math.random() * Math.min(5, l.qty)), buyer, walletOf(buyer)); afterSale(r.village, r.tax); } catch { /* sold out */ } }
      }
      if (Math.random() < 0.06 && sim.current) {
        const fs = w.villages.filter(v => v.founded && !WR.shielded(v));
        const a = sim.current.flags[Math.floor(Math.random() * sim.current.flags.length)], d = fs.filter(x => x !== a)[Math.floor(Math.random() * (fs.length - 1))];
        const ship = a && WR.readyShips(book.current, a)[0], warIsl = a?.members.filter(p => WR.atWarStance(a, p) && WR.islandTier(w, p) <= WR.SHIPS[ship?.kind ?? 0].maxTier) ?? [];
        if (a && d && ship && warIsl.length) {
          try {
            const t = WR.deployTour(w, book.current, a, d, ship.id, warIsl[0], false);
            for (const p of warIsl.slice(1)) { if (WR.full(t)) break; if (!WR.boardProblem(w, book.current, t, p)) WR.board(w, book.current, t, p); }
            const b = WR.sail(w, book.current, econ.current, t, WR.autoDefenders(d));
            const line = `⚔️ ${a.name} raided ${d.name}: ${b.attackerWon === null ? "a draw" : b.attackerWon ? `won, ${fmt(b.loot + b.bounty)} RF of loot` : `beaten off, ${fmt(b.loot + b.bounty)} RF to ${d.name}`}.`;
            if (d.members.some(p => p.mine)) { setLastBattle(b); msg = ""; say(`${line} Your flag was hit: check ⚔️ War.`); } else msg = line;
          } catch { /* not this time */ }
        }
      }
      if (msg) sayAmbient(msg);
      bump();
    }, 4000);
    return () => window.clearInterval(t);
  }, [ready, paused]); // eslint-disable-line react-hooks/exhaustive-deps
  // arrange with arrow keys
  useEffect(() => {
    if (!arranging) return;
    const k = (e: KeyboardEvent) => {
      if (menu) return;
      const m: Record<string, [number, number]> = { arrowup: [-1, 0], w: [-1, 0], arrowright: [0, -1], d: [0, -1], arrowdown: [1, 0], s: [1, 0], arrowleft: [0, 1], a: [0, 1] };
      const d = m[e.key.toLowerCase()]; if (d) { e.preventDefault(); nudge(d[0], d[1]); }
      if (e.key === "Escape" || e.key === "Enter") finishArranging();
    };
    window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k);
  });
  const canVisit = (p: Plot, host: Plot) => {
    if (p === host) return true;
    if (p.mine) return canEnter(world.current!, host);
    return canEnterFrom(world.current!, p, host);
  };
  function doLaunch() {
    const w = world.current!, h = home(); setLaunchError("");
    if (!onChain.current.has(h.id) || savedRef.current.get(friendId)?.plot !== h.id) { setLaunchError("Save your island on chain first (Arrange → Save): launches come from a Friend on a saved island."); return; }
    const n = (v: string) => Number(v.replace(/[,_\s]/g, "")) || 0;
    try {
      const l = launch(econ.current, w, { name: form.name, symbol: form.symbol, supply: n(form.supply), creator: h, creatorFriend: friendId,
        airdropScope: form.airdropScope, airdropEach: n(form.airdropEach), claimScope: form.claimScope, claimPool: n(form.claimPool), claimEach: n(form.claimEach), claimPrice: n(form.claimPrice) }, canVisit);
      setForm(f => ({ ...f, name: "", symbol: "" })); bump();
      say(`$${l.symbol} launched (simulated): ${LAUNCH_FEE.toLocaleString()} RF into ${poolName(w, h)}.`);
    } catch (e) { setLaunchError(errText(e)); }
  }
  function doClaimAll(l: Launch) {
    const w = world.current!;
    const n = claimAll(econ.current, w, l, myPlots(w).flatMap(p => p.friends.map(pl => pl.m.id)), canVisit);
    bump(); say(n ? `${n.toLocaleString()} of your Friends claimed ${fmt(l.claimEach)} $${l.symbol} each (simulated) · ${fmt(n * l.claimPrice)} RF into ${poolName(w, l.creator)}.` : `Nothing to claim for $${l.symbol}.`);
  }

  /* ── render ── */
  if (fatal) return <div className="docks-loading" role="alert"><div className="docks-mark">⚓</div>{fatal}
    <button type="button" onClick={() => setRetry(r => r + 1)}>Try again</button></div>;
  if (!ready || !world.current) return <div className="docks-loading" role="status"><div className="docks-mark">⚓</div>Reading Friends from chain…</div>;

  const w = world.current, mine = myPlots(w), isl = island(), h = home(), homeRank = rankOf(h);
  const allMine = mine.flatMap(p => p.friends);
  const saved = savedRef.current;
  const pending = pendingChanges(w, saved), dirty = pending.moved.length > 0 || pending.gone.length > 0;
  const uiBlocked = Boolean(menu) || naming !== null || chatWith !== null || paused;
  const leadSprites = lead === friendId ? sprites : crewSprites.get(lead) ?? null;
  const label = leadSprites ? `${leadSprites.familyName} #${lead}` : `Friend #${lead}`;
  const following = [...crewModes].filter(([, m]) => m === "follow").length, parked = crewModes.size - following;
  const visit = gate ? w.visits.get(gate.id) ?? "none" : "none";
  const crew: CrewMember[] = drawnCrew().map(id => ({ id, sprites: crewSprites.get(id) ?? null, mode: crewModes.get(id)!, leader: crewLeader.get(id) ?? primary }));
  const myLine = lineOf(lead).length, quickPlot = quick ? plotOf(w, quick.id) : null, quickLeader = quick ? leaderOf(quick.id) : null;
  const defaultOf = (p: Plot) => defaults.current.get(p.id);
  const offLand = new Set<bigint>([lead, ...crewModes.keys()]);
  const byGen = [1, 2, 3, 4, 5, 6].map(g => [g, isl.friends.filter(p => p.m.gen === g).length] as const).filter(([, n]) => n);
  const rosterNote = roster.state === "loading" ? (roster.total ? `finding your Friends ${roster.done.toLocaleString()} / ${roster.total.toLocaleString()}` : "finding your Friends…")
    : roster.state === "error" ? "couldn't list your Friends" : "";
  const nftOf = (p: Plot) => onChain.current.get(p.id);
  const zones = menu === "docks" ? loadingZones(w, isl) : [];
  const islandTabs = mine.length > 1 && <div className="docks-plots" role="tablist" aria-label="Your islands">
    {mine.map(p => <button type="button" key={p.id} role="tab" aria-pressed={p === isl} onClick={() => setIslandId(p.id)}>
       {p.name} · {p.friends.length.toLocaleString()}{p.berth ? "" : " · floating"}</button>)}</div>;

  return <section className="docks" aria-label={definition.name}>
    <DocksView lookOverride={lookOverride} flagFriendArt={v => { const f = flagFriends.current.get(v); return f ? FF.art(f, v.color) : null; }} world={w} version={w.version} sprites={leadSprites} walkerId={lead} offLand={offLand} zoom={zoom} paused={uiBlocked} reducedMotion={reducedMotion}
      arranging={arranging} selected={selected} crew={crew} crewSel={crewSel} onWalkerTap={onWalkerTap} onFriendTap={onFriendTap} onIslandTap={onIslandTap} apiRef={api} onVisible={onVisible} onZoom={z => setZoom(clampZoom(z))}
      onPick={pl => { const p = plotOf(w, pl.m.id); if (!p) return;
        if (pickMany && selected[0] && plotOf(w, selected[0].m.id) === p) setSelected(s => s.includes(pl) ? s.filter(x => x !== pl) : [...s, pl]);
        else { setIslandId(p.id); setSelected([pl]); } }}
      onBlocked={p => { setGate(p); if (!menu) say(`${p.name} is invite-only.`); }} onEnterPlot={p => { setHere(p); if (p && p !== gate) setGate(null); }} />

    <div className="docks-hud" inert={uiBlocked || undefined}>
      <div className="docks-card">
        <strong>{label}</strong>
        <small>{h.name}{nftOf(h) ? ` · Island #${nftOf(h)} on chain` : " · not on chain yet"}{dirty ? ` · ${pending.moved.length.toLocaleString()} unsaved move${pending.moved.length === 1 ? "" : "s"}` : nftOf(h) ? " · saved" : ""}</small>
        <small>{h.friends.length.toLocaleString()} Friend{h.friends.length === 1 ? "" : "s"} · {homeRank.rank} · weight {fmtW(homeRank.weight)}{mine.length > 1 ? ` · ${mine.length} islands` : ""}</small>
        {(() => { const v = villageOf(w, h); if (!v) return <small className="docks-look-note">⚫ Black &amp; white: join a flag to add colour</small>;
          const t = SK.tierOfFlag(v), pop = VX.population(v); return <small className="docks-look-note" style={{ ["--flag" as string]: v.color }}>🎨 {LK.LOOK_NAMES[Math.min(5, t)]} · {v.name} Lv {t} · {(SK.nextMilestone(pop) - pop).toLocaleString()} more Friends to Lv {t + 1}</small>; })()}
        <small>{h.berth ? `Docked · ${neighboursOf(w, h).length} connected` : "Floating free"} · {villageOf(w, h) ? `🚩 ${villageOf(w, h)!.name}` : "no flag yet"}{here && exploring(w, here) ? ` · exploring ${here.name} (visitor)` : ""}{rosterNote ? ` · ${rosterNote}` : ""}</small>
      </div>
      <div className="docks-card docks-where">
        <small>Standing on</small><strong>{here ? (here.mine ? here.name : here.name) : "the water"}</strong>
        {here && !here.mine && <small>sample neighbour · {rankOf(here).rank}</small>}
      </div>
    </div>

    {(arranging || crewBar) && <p className="docks-toast" role="status" aria-live="polite">{toast}</p>}

    {arranging ? <div className="docks-arrange" role="toolbar" aria-label="Arrange your Friends">
      <div className="docks-arrange-info"><strong>{selected.length === 0 ? "Tap a Friend" : selected.length === 1 ? `Moving #${selected[0].m.id}` : selected.length === isl.friends.length ? `Moving all ${selected.length.toLocaleString()}` : `Moving ${selected.length.toLocaleString()} Friends`}</strong>
        <small>{isl.name} · tap your Friends to pick one</small></div>
      <div className="docks-pad">
        <button type="button" aria-label="Move up-left" onClick={() => nudge(-1, 0)}>↖</button>
        <button type="button" aria-label="Move up-right" onClick={() => nudge(0, -1)}>↗</button>
        <button type="button" aria-label="Move down-left" onClick={() => nudge(0, 1)}>↙</button>
        <button type="button" aria-label="Move down-right" onClick={() => nudge(1, 0)}>↘</button>
      </div>
      <div className="docks-chips">
        {isl.friends.length > 1 && <button type="button" aria-label="Next Friend" onClick={() => {
          const i = selected.length ? isl.friends.indexOf(selected[selected.length - 1]) : -1, next = isl.friends[(i + 1) % isl.friends.length];
          setSelected(pickMany && !selected.includes(next) ? [...selected, next] : [next]); }}>Next ▸</button>}
        {isl.friends.length > 1 && <button type="button" aria-pressed={pickMany} onClick={() => setPickMany(v => !v)}>Pick several</button>}
        {isl.friends.length > 1 && <button type="button" onClick={() => { setSelected([...isl.friends]); setPickMany(true); }}>All</button>}
        {isl.friends.length > 1 && <button type="button" onClick={reArrange}>Auto-arrange</button>}
      </div>
      <div className="docks-save">
        <small>{dirty ? `${pending.moved.length.toLocaleString()} moved · ${fmt(pending.rf)} RF + gas` : "Matches the chain"}</small>
        <div className="docks-row tight">
          <button type="button" onClick={finishArranging}>Done</button>
          <button type="button" className="rf-frame-primary" disabled={!dirty || saving} onClick={() => void saveOnChain()}>{saving ? "Saving…" : nftOf(isl) ? "⛓ Save on chain" : "⛓ Save on chain"}</button>
        </div>
      </div>
    </div> : crewBar ? <div className="docks-crewbar" role="toolbar" aria-label="Your crew">
      <div className="docks-arrange-info"><strong>Controlling {who(lead)}{lead === primary ? " · primary leader" : ""}</strong>
        <small>{lead === primary ? `${myLine.toLocaleString()} in line behind you` : `primary leader #${primary}${myLine ? ` · ${myLine} behind you` : " · walking solo"}`} · {parked.toLocaleString()} waiting around · {defaultOf(h) !== undefined ? `captain ${who(defaultOf(h)!)}` : "no captain yet"}{mayorOf(h) !== undefined ? ` · mayor ${who(mayorOf(h)!)}` : ""} · tap any Friend for options{crewSel.size ? ` · ${crewSel.size} picked` : ""}</small></div>
      <button type="button" onClick={() => { setQuick(null); setMenu("control"); }}>🔄 Change Friend</button>
      <button type="button" className="rf-frame-primary" onClick={callAll}>📣 Call all to #{String(primary)}</button>
      {lead !== primary && <button type="button" onClick={promote}>⭐ Make #{String(lead)} primary leader</button>}
      {myLine > 0 && <button type="button" onClick={walkSolo}>🚶 Walk solo</button>}
      <button type="button" disabled={!crewSel.size} onClick={() => { setModes(crewSel, "follow"); say(`${crewSel.size} Friend${crewSel.size === 1 ? "" : "s"} called to #${primary}.`); setCrewSel(new Set()); }}>Call picked</button>
      <button type="button" disabled={!crewSel.size} onClick={() => { setModes(crewSel, "park"); say(`${crewSel.size} Friend${crewSel.size === 1 ? "" : "s"} left here.`); setCrewSel(new Set()); }}>Leave picked here</button>
      <button type="button" disabled={!following} onClick={() => { setModes([...crewModes].filter(([, m]) => m === "follow").map(([id]) => id), "park"); say("Everyone waits here."); }}>Everyone wait</button>
      <button type="button" disabled={!crewModes.size} onClick={() => { setModes([...crewModes.keys()], "home"); setCrewSel(new Set()); say("Everyone went back to their own land."); }}>All go home</button>
      <button type="button" onClick={() => { setCrewBar(false); setCrewSel(new Set()); }}>Done</button>
    </div> : <div className="docks-bar" inert={uiBlocked || undefined}>
      <p className="docks-toast in-bar" role="status" aria-live="polite">{toast}</p>
      {gate && !canEnter(w, gate) ? <span className="docks-hint">🚩 {gate.name}: {villageOf(w, gate) ? `only ${villageOf(w, gate)!.name}'s islands walk here; bridge to it to explore` : "only islands under a flag can be visited for now"}</span>
        : dirty ? <div className="docks-row tight docks-unsaved">
          <button type="button" className="docks-act" disabled={saving} onClick={() => void saveOnChain()}>{saving ? "Saving…" : `⛓ ${[...pending.plots].some(p => !nftOf(p)) ? "Save" : "Save"} · ${pending.moved.length.toLocaleString()} moved · ${fmt(pending.rf)} RF`}</button>
          {saved.size > 0 && <button type="button" onClick={discardChanges}>Undo</button>}</div>
        : <span className="docks-hint">WASD / arrows or tap to walk · gangways (⇄) join docked islands</span>}
      <div className="docks-nav">
        <button type="button" className="docks-arrange-btn" onClick={startArranging} disabled={uiBlocked}>✥<span>Arrange</span></button>
        <button type="button" onClick={() => setCrewBar(true)} disabled={uiBlocked}>👥<span>Crew</span></button>
        <button type="button" onClick={() => { setPage(1); setMenu("plot"); }} disabled={uiBlocked}>🏝<span>Islands</span></button>
        <button type="button" onClick={() => setMenu("docks")} disabled={uiBlocked}>⚓<span>Docks</span></button>
        {chatNeighbours().length > 0 && <button type="button" onClick={() => openChat()} disabled={uiBlocked}>💬<span>Chat</span></button>}
        <button type="button" onClick={() => { setVillageError(""); setMenu("village"); }} disabled={uiBlocked}>🚩<span>Flags</span></button>
        <button type="button" onClick={() => { setVillageError(""); setMenu("war"); }} disabled={uiBlocked}>⚔️<span>War</span></button>
        <button type="button" onClick={() => { setVillageError(""); for (const p of myPlots(w)) PC.track(market.current, p); setMenu("market"); }} disabled={uiBlocked}>🧺<span>Market</span></button>
        <button type="button" onClick={() => setMenu("tokens")} disabled={uiBlocked}>🚀<span>Tokens</span></button>
        <button type="button" onClick={() => void checkChain(true)} disabled={uiBlocked || checking}>{checking ? "⏳" : "🔄"}<span>Check</span></button>
        <button type="button" onClick={() => setZoom(z => clampZoom(z * 1.4))} disabled={uiBlocked} aria-label="Zoom in">＋</button>
        <button type="button" onClick={() => setZoom(z => clampZoom(z / 1.4))} disabled={uiBlocked} aria-label="Zoom out">－</button>
        <button type="button" onClick={() => api.current?.fitAll()} disabled={uiBlocked} aria-label="Fit all islands">⤢</button>
        <button type="button" onClick={() => api.current?.recenter()} disabled={uiBlocked} aria-label="Center on lead">⌖</button>
        <button type="button" onClick={() => setMenu("settings")} disabled={uiBlocked}>⚙️<span>More</span></button>
      </div>
    </div>}

    {quick && !menu && (() => { const id = quick.id, mode = id === lead ? "you" : crewModes.get(id) ?? "home", fr = allMine.find(x => x.m.id === id);
      const r = (document.querySelector(".docks") as HTMLElement | null)?.getBoundingClientRect();
      const left = Math.max(8, Math.min((quick.x - (r?.left ?? 0)), (r?.width ?? 400) - 230)), top = Math.max(8, Math.min(quick.y - (r?.top ?? 0) + 12, (r?.height ?? 400) - 250));
      return <div className="docks-quick" role="menu" aria-label={`#${id} options`} style={{ left, top }}>
        <strong>{who(id)}{fr ? ` · Gen ${fr.m.gen}` : ""}{quickPlot && defaultOf(quickPlot) === id ? " · ⭐ captain" : ""}{quickPlot && mayorOf(quickPlot) === id ? " · 🏛 mayor" : ""}{isOg(id) ? " · 👑 OG" : ""}</strong>
        <small>{mode === "home" ? `on its land${quickPlot ? ` · ${quickPlot.name}` : ""}` : mode === "follow" ? `in #${quickLeader}'s line` : mode === "park" ? "waiting around" : "you control it"}</small>
        {id !== lead && <button type="button" role="menuitem" className="rf-frame-primary" onClick={() => control(id)}>🎮 Control #{String(id)}</button>}
        {mode === "follow" && lineOf(quickLeader!).indexOf(id) < lineOf(quickLeader!).length - 1 && <button type="button" role="menuitem" onClick={() => breakOffCrew(id)}>✂ Break off crew from #{String(id)}</button>}
        {mode === "home" && <button type="button" role="menuitem" onClick={() => { setModes([id], "follow"); setQuick(null); say(`#${id} is on its way to #${primary}.`); }}>📣 Call to #{String(primary)}</button>}
        {mode === "park" && <button type="button" role="menuitem" onClick={() => { setModes([id], "follow"); setQuick(null); say(`#${id} joined #${primary}'s line.`); }}>📣 Join #{String(primary)}'s line</button>}
        {(mode === "follow" || mode === "park") && <button type="button" role="menuitem" onClick={() => { setModes([id], "home"); setQuick(null); say(`#${id} went home.`); }}>🏠 Send home</button>}
        {(mode === "follow" || mode === "park") && <button type="button" role="menuitem" onClick={() => { setCrewBar(true); setCrewSel(s0 => { const n = new Set(s0); if (n.has(id)) n.delete(id); else n.add(id); return n; }); setQuick(null); }}>{crewSel.has(id) ? "☐ Unpick" : "☑ Pick"}</button>}
        {quickPlot?.mine && defaultOf(quickPlot) !== id && <button type="button" role="menuitem" onClick={() => setCaptain(quickPlot, id)}>⭐ Make captain of {quickPlot.name}</button>}
        {quickPlot?.mine && defaultOf(quickPlot) !== id && mayorOf(quickPlot) !== id && <button type="button" role="menuitem" onClick={() => setMayor(quickPlot, id)}>🏛 Make mayor of {quickPlot.name}</button>}
        {fr && <button type="button" role="menuitem" onClick={() => { setNameDraft(nameOf(id)); setNaming(id); setQuick(null); }}>✏️ {nameOf(id) ? "Rename" : "Name"} #{String(id)}</button>}
        <button type="button" role="menuitem" onClick={() => setQuick(null)}>Close</button>
      </div>; })()}
    {islandPop && !menu && !quick && (() => { const p = w.plots.find(q => q.id === islandPop.id); if (!p || p.mine) return null;
      const me = isl, conn = connected(w, me, p), next = zonesNextTo(w, me, p), fl = villageOf(w, p) ?? risingFlagOf(w, p), r = rankOf(p);
      const rc = (document.querySelector(".docks") as HTMLElement | null)?.getBoundingClientRect();
      const left = Math.max(8, Math.min((islandPop.x - (rc?.left ?? 0)), (rc?.width ?? 400) - 240)), top = Math.max(8, Math.min(islandPop.y - (rc?.top ?? 0) + 12, (rc?.height ?? 400) * 0.45));
      return <div className="docks-quick" role="menu" aria-label={`${p.name} options`} style={{ left, top, maxHeight: `calc(100% - ${Math.round(top) + 72}px)`, overflowY: "auto" }}>
        <strong>{p.name}</strong>
        <small>{zOf(p.berth) ? `${levelName(zOf(p.berth))} · ` : ""}{p.friends.length.toLocaleString()} Friend{p.friends.length === 1 ? "" : "s"} · {r.rank} · {fl ? `🚩 ${fl.name}${fl.founded ? "" : " (rising)"}${stanceOf(w, p) ? ` · ${stanceOf(w, p) === "war" ? "⚔️ war" : "🕊 peace"}` : ""}` : "no flag: trades, chats and docks, never at war"}{conn ? ` · docked with ${me.name}` : ""}</small>
        {canChat(p) && PC.peaceful(w, p) && <button type="button" role="menuitem" onClick={() => { setIslandPop(null); setMenu("market"); }}>🧺 Trade with {p.name}</button>}
        {!conn && next.some(b => zOf(b) === zOf(p.berth)) && <button type="button" role="menuitem" className="rf-frame-primary" onClick={() => dockNextTo(p)}>⚓ Dock {me.name} beside it · {DOCKING_FEE} RF</button>}
        {!conn && next.some(b => zOf(b) > zOf(p.berth)) && <button type="button" role="menuitem" onClick={() => dockNextTo(p, "above")}>⬆ Dock on the deck above · {DOCKING_FEE} RF</button>}
        {!conn && next.some(b => zOf(b) < zOf(p.berth)) && <button type="button" role="menuitem" onClick={() => dockNextTo(p, "below")}>⬇ Dock on the deck below · {DOCKING_FEE} RF</button>}
        {!conn && fl?.founded && stanceOf(w, p) === "war" && harborOf(fl).length > 0 && <button type="button" role="menuitem" className="rf-frame-primary" onClick={() => dockAtHarbor(fl)}>⚓ Dock at {fl.name}'s harbor · {DOCKING_FEE} RF</button>}
        {fl?.founded && <button type="button" role="menuitem" onClick={() => { setIslandPop(null); setMarketAt(fl.id); setMenu("market"); }}>🧺 {fl.name} market</button>}
        {!conn && hostileBorder(w, me, p) && <small>⚔️ {p.name} is {villageOf(w, p)?.name}'s war island: dock next to one of its peace islands instead.</small>}
        {!conn && !next.length && !hostileBorder(w, me, p) && <button type="button" role="menuitem" onClick={() => buildBridge(p)} disabled={!me.berth || !p.berth}>🌉 Bridge from {me.name} · {DOCKING_FEE} RF</button>}
        {canChat(p) && <button type="button" role="menuitem" onClick={() => openChat(p)}>💬 Chat with {p.name}</button>}
        <button type="button" role="menuitem" onClick={() => setIslandPop(null)}>Close</button>
      </div>; })()}
    {chatWith !== null && !menu && (() => { const n = chatNeighbours(), p = chatWith === "*" ? null : n.find(q => q.id === chatWith) ?? null;
      return <GameMenu onClose={() => setChatWith(null)} title={p ? `Chat with ${p.name}` : "Chat with neighbours"}>
        {!p ? <><p>Pick a docked neighbour to chat with.</p>
          <div className="docks-row">{n.map(q => <button type="button" key={q.id} onClick={() => setChatWith(q.id)}>💬 {q.name}</button>)}</div></> : <>
          <p className="docks-note">Chat is open while your islands are docked or bridged together. Simulated here: sample islands answer on their own; chat between real players needs a message relay (next phase).</p>
          <div className="docks-chat" role="log" aria-label={`Messages with ${p.name}`}>{(chats.current.get(p.id) ?? []).length ? (chats.current.get(p.id) ?? []).map((m, i) =>
            <p key={i} className={m.from === "You" ? "me" : ""}><strong>{m.from}</strong> {m.text}</p>) : <p className="docks-note">Say hi to {p.name}.</p>}</div>
          <div className="docks-row">
            <input aria-label={`Message to ${p.name}`} maxLength={280} placeholder="Message" value={chatDraft} onChange={e => setChatDraft(e.target.value)} onKeyDown={e => { e.stopPropagation(); if (e.key === "Enter") { e.preventDefault(); sendChat(p); } }} autoFocus />
            <button type="button" className="rf-frame-primary" onClick={() => sendChat(p)}>Send</button>
            {n.length > 1 && <button type="button" onClick={() => setChatWith("*")}>Others</button>}
          </div></>}
      </GameMenu>; })()}
    {naming !== null && !menu && <GameMenu onClose={() => setNaming(null)} title={`Name #${naming}`}>
      <p>Give #{String(naming)} a name everyone sees. Saved on chain (simulated, gas only); only the Friend's holder can name it, and a new holder names it again.</p>
      <div className="docks-row">
        <input aria-label={`Name for #${naming}`} maxLength={24} placeholder="Up to 24 characters" value={nameDraft} onChange={e => setNameDraft(e.target.value)} onKeyDown={e => { e.stopPropagation(); if (e.key === "Enter") { e.preventDefault(); saveName(naming, nameDraft); } }} autoFocus />
        <button type="button" className="rf-frame-primary" onClick={() => saveName(naming, nameDraft)}>Save name</button>
        {nameOf(naming) && <button type="button" onClick={() => saveName(naming, "")}>Clear</button>}
      </div>
    </GameMenu>}
    {menu && <GameMenu onClose={() => setMenu(null)} title={menu === "control" ? "Change Friend" : menu === "plot" ? "My islands" : menu === "docks" ? "The Docks" : menu === "village" ? "Flags" : menu === "war" ? "War" : menu === "market" ? "Market" : menu === "tokens" ? "Tokens" : menu === "help" ? "How it works" : "Settings"}>
      {menu === "control" ? <>
        <p>Control any of your Friends: tap one on the map, or pick it here. A Friend in a line breaks off when you take it over; make it the primary leader to call the others to it.</p>
        <div className="docks-list">{[lead, ...[...crewModes.keys()], ...allMine.map(x => x.m.id).filter(id => id !== lead && !crewModes.has(id))].slice(0, 150).map(id => { const pl = allMine.find(x => x.m.id === id), m = id === lead ? "you" : crewModes.get(id) ?? "home";
          return <div className="docks-friend" key={String(id)}>
            <div className="crop">{pl?.m.friend ? <img src={pl.m.friend.art} alt={`Friend #${id} on-chain artwork`} loading="lazy" /> : <span className="docks-note">#{String(id)}</span>}</div>
            <span><strong>{who(id)}{id === primary ? " · primary" : ""}{pl && defaultOf(plotOf(w, id)!) === id ? " · captain" : ""}{pl && mayorOf(plotOf(w, id)!) === id ? " · mayor" : ""}{isOg(id) ? " · 👑 OG" : ""}</strong>
              <small>{m === "you" ? "you control it" : m === "follow" ? `in #${leaderOf(id)}'s line` : m === "park" ? "waiting around" : `on its land${pl ? ` · Gen ${pl.m.gen}` : ""}`}</small></span>
            <button type="button" aria-label={`Name #${id}`} onClick={() => { setMenu(null); setNameDraft(nameOf(id)); setNaming(id); }}>✏️</button>
            {id !== lead && <button type="button" onClick={() => { setMenu(null); control(id); }}>Control</button>}</div>; })}</div>
      </> : menu === "plot" ? <>
        <p>Every activated Friend is a small floating island; joined together they make one big island. Every activated Friend in your wallet is here automatically, exactly as it renders on chain. Keep them together, or deploy them to other islands. Islands belong to your wallet and can't be sold: the only NFTs are your Friends.</p>
        {islandTabs}
        <div className="docks-item"><span><strong>{isl.name} · {isl.friends.length.toLocaleString()} Friends · {rankOf(isl).rank}</strong>
          <small>Reward weight {fmtW(rankOf(isl).weight)}{rankOf(isl).next ? ` · ${fmtW(rankOf(isl).next)} to ${RANKS[rankOf(isl).index + 1].name}` : ""}{byGen.length ? ` · ${byGen.map(([g, n]) => `${n.toLocaleString()}× Gen ${g}`).join(" · ")}` : ""}</small>
          {rosterNote && <small>{rosterNote}{roster.error ? `: ${roster.error}` : ""}</small>}</span></div>
        <div className="docks-item"><span><strong>⛓ {nftOf(isl) ? `Island #${nftOf(isl)} · saved on chain to your wallet` : "Not on chain yet"}</strong>
          <small>{dirty ? `${pending.moved.length.toLocaleString()} Friend${pending.moved.length === 1 ? "" : "s"} moved since the last save · saving costs ${fmt(pending.rf)} RF + gas` : "Your islands match the chain."}</small>
          <small>Saving costs RF for each Friend whose spot on its island changed: {Object.entries(ARRANGE_FEE).map(([g, f]) => `Gen ${g} ${f}`).join(" · ")} RF, paid into {poolName(w, isl)} (nothing is burned: pools earn trading fees that buy RF to build with). Docking and moving islands cost only gas.<span className="docks-sim">SIMULATED</span></small></span>
          <button type="button" className="rf-frame-primary" disabled={!dirty || saving} onClick={() => { setMenu(null); void saveOnChain(); }}>Save</button></div>
        <div className="docks-row">
          <button type="button" onClick={startArranging} disabled={!isl.friends.length}>✥ Arrange</button>
          {isl.friends.length > 1 && <button type="button" onClick={reArrange}>▦ Auto-arrange</button>}
          <button type="button" onClick={newIsland}>＋ New island</button>
        </div>
        <div className="docks-item"><span><strong>⭐ Captain: {defaultOf(isl) !== undefined ? who(defaultOf(isl)!) : "not set"}</strong>
          <small>The Friend you control whenever you board {isl.name}. Saved on chain (simulated, gas only).</small></span>
          <select aria-label={`Captain of ${isl.name}`} value={defaultOf(isl) !== undefined ? String(defaultOf(isl)) : ""} onChange={e => { if (e.target.value) setCaptain(isl, BigInt(e.target.value)); }}>
            <option value="">Pick…</option>{isl.friends.slice(0, 300).map(x => <option key={String(x.m.id)} value={String(x.m.id)}>{who(x.m.id)} · Gen {x.m.gen}</option>)}</select></div>
        <div className="docks-item"><span><strong>🏛 Mayor: {mayorOf(isl) !== undefined ? who(mayorOf(isl)!) : "not set"}</strong>
          <small>A second Friend that stays home on {isl.name} and greets visitors while your captain is out (Call all leaves it home). Can't be the captain. Saved on chain (simulated, gas only).</small></span>
          <select aria-label={`Mayor of ${isl.name}`} value={mayorOf(isl) !== undefined ? String(mayorOf(isl)) : ""} onChange={e => setMayor(isl, e.target.value ? BigInt(e.target.value) : null)}>
            <option value="">None</option>{isl.friends.filter(x => x.m.id !== defaultOf(isl)).slice(0, 300).map(x => <option key={String(x.m.id)} value={String(x.m.id)}>{who(x.m.id)} · Gen {x.m.gen}</option>)}</select></div>
        {(isl.holes ?? []).length > 0 && <><h3>Holes on {isl.name}</h3>
          <p className="docks-note">A saved Friend left your wallet or was deactivated, so its spot is a hole. It heals for free if that Friend comes back; or fill it with another activated Friend of the same generation (normal arrange fee).</p>
          {(isl.holes ?? []).map(hl => { const same = mine.flatMap(q => q.friends).filter(x => x.m.gen === hl.gen);
            return <div className="docks-item docks-hole" key={String(hl.id)}><span><strong>Hole where #{String(hl.id)} was · Gen {hl.gen}</strong>
              <small>{same.length ? `${same.length} Gen ${hl.gen} Friend${same.length === 1 ? "" : "s"} could fill it` : `No Gen ${hl.gen} Friend to fill it right now`}</small></span>
              {same.length > 0 && <select aria-label={`Fill hole of #${hl.id}`} value="" onChange={e => { if (e.target.value) doFillHole(isl, hl, BigInt(e.target.value)); }}>
                <option value="">Fill with…</option>{same.slice(0, 200).map(x => <option key={String(x.m.id)} value={String(x.m.id)}>#{String(x.m.id)} · {x.m.id === hl.id ? "free" : `${feeOf(x.m)} RF`}</option>)}</select>}</div>; })}</>}
        <h3>Friends on {isl.name} <small className="docks-note">· leading #{String(lead)} · {following.toLocaleString()} with you · {parked.toLocaleString()} left around</small></h3>
        <div className="docks-row"><button type="button" onClick={() => { setMenu(null); callAll(); }}>📣 Call all to #{String(lead)}</button>
          <button type="button" disabled={!crewModes.size} onClick={() => { setModes([...crewModes.keys()], "home"); say("Everyone went back to their own land."); }}>All go home</button></div>
        {!isl.friends.length && <p className="docks-note">No Friends here yet. Deploy some from another island's list.</p>}
        <div className="docks-list">
          {isl.friends.slice(0, page * PAGE).map(p => { const id = p.m.id, f: Friend | null = p.m.friend, mode = id === lead ? "lead" : crewModes.get(id) ?? "home";
            return <div className="docks-friend" key={String(id)}>
              <div className="crop">{f ? <img src={f.art} alt={`Friend #${id} on-chain artwork`} loading="lazy" /> : <span className="docks-note">#{String(id)}</span>}</div>
              <span><strong>#{String(id)}{id === lead ? " · leading" : ""}</strong>
                <small>Gen {p.m.gen} · Tier {p.m.tier}{f ? ` · ${f.traits.Scenery}` : ""} · weight {fmtW(weightOf(p.m))}</small></span>
              <span className="docks-row tight">
                {mine.length > 1 && <select aria-label={`Deploy #${id} to`} value={isl.id} onChange={e => deployTo(id, e.target.value)}>
                  {mine.map(q => <option key={q.id} value={q.id}>{q === isl ? "On this island" : `→ ${q.name}`}</option>)}</select>}
                {id !== lead && <select aria-label={`#${id} does`} value={mode} onChange={e => setModes([id], e.target.value as "follow" | "park" | "home")}>
                  <option value="home">On its land</option><option value="follow">With #{String(lead)}</option>{mode === "park" && <option value="park">Left around</option>}</select>}
                {id !== lead && <button type="button" onClick={() => { setMenu(null); takeOver(id); }}>Control</button>}</span>
            </div>; })}
          {isl.friends.length > page * PAGE && <div className="docks-row"><button type="button" onClick={() => setPage(n => n + 1)}>Show {Math.min(PAGE, isl.friends.length - page * PAGE)} more of {(isl.friends.length - page * PAGE).toLocaleString()}</button></div>}
        </div>
        <div className="docks-add">
          <label htmlFor="add-id">Missing one? Add by number</label>
          <div className="docks-row"><input id="add-id" inputMode="numeric" placeholder="Friend number, e.g. 1234" value={addId} onChange={e => setAddId(e.target.value)} onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); void addFriend(); } }} disabled={adding} />
            <button type="button" className="rf-frame-primary" disabled={adding || !addId.trim()} onClick={() => void addFriend()}>{adding ? "Checking…" : "Add"}</button></div>
          {addError && <p role="alert" className="docks-note">{addError}</p>}
          <p className="docks-note">Friends are found from your wallet's on-chain history and re-checked every minute. It must be held by the same wallet as #{String(friendId)} and be activated.</p>
        </div>
      </> : menu === "docks" ? <>
        {islandTabs}
        <p>{isl.berth ? `${isl.name} is docked${neighboursOf(w, isl).length ? ` next to ${neighboursOf(w, isl).map(p => p.name).join(", ")}` : ""}. Pick another loading zone to move it, or build a bridge.` : `${isl.name} is floating free. Pick a loading zone next to another island to dock.`} Every island takes one berth, whatever its size, so the docks grow with the number of islands. Docking next to an island or bridging to it costs a {DOCKING_FEE} RF docking fee, into The Docks fund; once connected, your Friends can walk onto that island (free for now). Tip: tap any island on the map and hit ⚓ Dock.</p>
        <ChainMap world={w} island={isl} zones={zones} onDock={dockIsland} onBridge={buildBridge} />
        {isl.berth && <div className="docks-row"><button type="button" onClick={() => { undock(w, isl); setMenu(null); goTo(isl); bump(); say(`${isl.name} is floating free.`); }}>Undock</button>
          <span className="docks-note">Bridges cost a {DOCKING_FEE} RF docking fee (to The Docks fund) and last until either island moves.</span></div>}
        {sim.current && <p className="docks-note">🌊 The simulated Docks: {sim.current.flags.length} flags ({sim.current.flags.map(v => v.name).join(", ")}), {sim.current.wanderers.length} independent wanderers, {sim.current.islands.toLocaleString()} islands and {sim.current.friends.toLocaleString()} simulated residents. Residents aren't NFTs: they borrow real Friends' on-chain artwork so every land looks real. They trade and raid on their own.</p>}
        <h3>🏝 Islands</h3>
        {(() => { const others = w.plots.filter(p => p.friends.length && p !== isl); return others.length > 30 ? <p className="docks-note">{others.length.toLocaleString()} islands on the docks: the 30 closest to {isl.name} are here; the rest are on the map.</p> : null; })()}
        <div className="docks-isles">{[...w.plots].filter(p => p.friends.length && p !== isl).sort((a, b) => { const d = (q: Plot) => isl.berth && q.berth ? Math.abs(q.berth.x - isl.berth.x) + Math.abs(q.berth.y - isl.berth.y) : q.berth ? Math.abs(q.berth.x) + Math.abs(q.berth.y) : 99; return d(a) - d(b) || rankOf(b).weight - rankOf(a).weight; }).slice(0, 30).map(p => { const r = rankOf(p), fl = villageOf(w, p) ?? risingFlagOf(w, p), art = p.friends.find(x => x.m.friend)?.m.friend?.art;
          const conn = connected(w, isl, p), next = !p.mine && !conn ? zonesNextTo(w, isl, p) : [];
          return <div className="docks-isle" key={p.id}>
            <div className="crop">{art && p.friends.length === 1 ? <img src={art} alt={`${p.name} on-chain artwork`} loading="lazy" /> : <IslandThumb p={p} color={fl?.color} />}</div>
            <span><strong>{p.name}{p.mine ? " (yours)" : ""}</strong>
              <small>{zOf(p.berth) ? `${levelName(zOf(p.berth))} · ` : ""}{p.friends.length.toLocaleString()} Friend{p.friends.length === 1 ? "" : "s"} · {r.rank}{fl ? ` · 🚩 ${fl.name}` : ""}{stanceOf(w, p) ? ` · ${stanceOf(w, p) === "war" ? "⚔️ war" : "🕊 peace"}` : ""}{conn ? ` · next to ${isl.name}` : ""}</small></span>
            <div className="docks-row tight">
              {!p.mine && !conn && next.some(b => zOf(b) === zOf(p.berth)) && <button type="button" className="rf-frame-primary" onClick={() => dockNextTo(p)}>⚓ Dock</button>}
              {!p.mine && !conn && !next.some(b => zOf(b) === zOf(p.berth)) && next.length > 0 && <button type="button" className="rf-frame-primary" onClick={() => dockNextTo(p, next.some(b => zOf(b) > zOf(p.berth)) ? "above" : "below")}>⚓ Dock {next.some(b => zOf(b) > zOf(p.berth)) ? "above" : "below"}</button>}
              {!p.mine && !conn && !next.length && isl.berth && p.berth && <button type="button" onClick={() => buildBridge(p)}>🌉 Bridge</button>}
              {canChat(p) && <button type="button" onClick={() => { setMenu(null); openChat(p); }}>💬</button>}
              <button type="button" onClick={() => { setMenu(null);
                if (canEnter(w, p)) { goTo(p); say(p.mine ? `On ${p.name}.` : `You and your crew walked over to ${p.name}.`); }
                else { const b = w.box.get(p); if (b) api.current?.focusOn((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, zOf(p.berth)); say(villageOf(w, p) ? `${p.name} is under ${villageOf(w, p)!.name}'s flag: join it, or bridge to one of its islands to explore. Here's the view.` : `${p.name} has no flag, so it's closed to visitors for now. Here's the view.`); } }}>{canEnter(w, p) ? "Go" : "Look"}</button>
            </div></div>; })}</div>
        <h3>🚩 Flags</h3>
        {w.villages.filter(v => !v.failed).length ? <div className="docks-flags">{[...w.villages].filter(v => !v.failed).sort((a, b) => VX.population(b) - VX.population(a)).map(v => {
          const isles = v.founded ? v.members : [v.seat], pop = VX.population(v), tier = SK.tierOfFlag(v), nextAt = SK.nextMilestone(pop), prevAt = SK.tierStart(tier);
          const here = isles.some(m => connected(w, isl, m) && stanceOf(w, m) !== "war"), harbor = v.founded && !here ? harborOf(v) : [], peace = v.members.filter(m => stanceOf(w, m) !== "war").length;
          const shown = [...isles].sort((a, b) => (stanceOf(w, a) === "war" ? 1 : 0) - (stanceOf(w, b) === "war" ? 1 : 0) || zOf(b.berth) - zOf(a.berth)).slice(0, 12);
          return <div className="docks-flagcard" key={v.id} style={{ ["--flag" as string]: v.color }}>
            <div className="docks-flaghead">
              <span className="docks-flag-emblem" style={{ background: v.color }} aria-hidden="true">{v.founded && tier ? SK.skinIcon(tier) : "🚩"}</span>
              <span><strong>{v.name}</strong>
                <small className="docks-flag-level">{v.founded ? `Level ${tier} · ${SK.skinName(tier)}` : "Rising flag"}</small></span>
              <span className="docks-flag-pop"><b>{pop.toLocaleString()}</b><small>Friends</small></span>
            </div>
            {v.founded && <div className="docks-meter" role="progressbar" aria-label={`${v.name} population toward level ${tier + 1}`} aria-valuemin={prevAt} aria-valuemax={nextAt} aria-valuenow={pop}><i style={{ width: `${Math.min(100, Math.max(3, (pop - prevAt) / (nextAt - prevAt) * 100))}%` }} /><small>{(nextAt - pop).toLocaleString()} more Friends to level {tier + 1} ({SK.skinName(tier + 1)})</small></div>}
            <small>{v.founded ? `${v.members.length} islands (${peace} 🕊 peace · ${v.members.length - peace} ⚔️ war)${new Set(v.members.map(m => zOf(m.berth))).size > 1 ? ` on ${new Set(v.members.map(m => zOf(m.berth))).size} levels` : ""}` : `${fmt(v.locked)} / ${fmt(v.target)} RF raised`}</small>
            <small className={`docks-founding ${v.founded ? "closed" : "open"}`}>{v.founded ? `Founding closed (${v.lockers.size} founders, the OGs) · ${v.enrollOpen ? `open to join: ${fmt(v.enrollPrice)} RF per island` : "not taking new islands"}` : `Founding open: lock RF by ${new Date(v.deadline).toLocaleDateString()} to become a founder (OG)`}</small>
            <div className="docks-row tight">
              {v.founded && here && <span className="docks-note">⚓ You're at its harbor</span>}
              {v.founded && !here && harbor.length > 0 && <button type="button" className="rf-frame-primary" onClick={() => dockAtHarbor(v)}>⚓ Dock at harbor · {DOCKING_FEE} RF</button>}
              {v.founded && !here && !harbor.length && <span className="docks-note">Harbor full</span>}
              {v.founded && <button type="button" onClick={() => { setMarketAt(v.id); setMenu("market"); }}>🧺 Market</button>}
              <button type="button" onClick={() => lookAtFlag(v)}>👁 Look</button>
              {!v.founded && <button type="button" onClick={() => setMenu("village")}>🔒 Lock RF</button>}
            </div>
            <div className="docks-flag-isles">{shown.map(p => { const conn = connected(w, isl, p), next = !p.mine && !conn ? zonesNextTo(w, isl, p) : [];
              return <div key={p.id} className="docks-flag-isle">
                <div className="crop small"><IslandThumb p={p} color={v.color} /></div>
                <small>{stanceOf(w, p) === "war" ? "⚔️" : "🕊"}{zOf(p.berth) ? (zOf(p.berth) > 0 ? `▲${zOf(p.berth)}` : `▼${-zOf(p.berth)}`) : ""} {p.name}{p.mine ? " (yours)" : ""} · {p.friends.length}</small>
                <span className="docks-row tight">{next.some(b => zOf(b) === zOf(p.berth)) && <button type="button" onClick={() => dockNextTo(p)}>⚓ Dock</button>}
                  {stanceOf(w, p) !== "war" && next.some(b => zOf(b) > zOf(p.berth)) && <button type="button" title={`Dock on the deck above ${p.name}`} aria-label={`Dock above ${p.name}`} onClick={() => dockNextTo(p, "above")}>⬆</button>}
                  {stanceOf(w, p) !== "war" && next.some(b => zOf(b) < zOf(p.berth)) && <button type="button" title={`Dock on the deck below ${p.name}`} aria-label={`Dock below ${p.name}`} onClick={() => dockNextTo(p, "below")}>⬇</button>}</span>
                {conn && !p.mine && <small>docked</small>}
              </div>; })}
              {isles.length > shown.length && <small className="docks-note">+{isles.length - shown.length} more islands on the map</small>}</div>
          </div>; })}</div> : <p className="docks-note">No flags yet. Plant one in 🚩 Flags.</p>}
        <p className="docks-note">Rank follows the official Rare Friends reward weight (Generation × Activation tier), summed over an island's Friends. Neighbours are other people's public Friends shown as samples; their answers to visit requests are simulated.</p>
      </> : menu === "village" ? <>
        <div className="docks-ladder"><strong>🎨 How to get colour</strong>
          <p className="docks-note">On your own, an island is black and white. Join a flag (or plant one) and its islands take the flag's colour; the more Friends in the flag, the richer the colour and the bigger the walls. Grow it with more islands and Friends. Inside a flag each island has its own shade, and an upgraded island shines a level brighter than its flag (★): grow it to a City (reward weight) and build 2+ items on it.</p>
          <ol>{[["Lv 0", "under 100", "a hint of colour"], ["Lv 1", "100+", "wooden palisade, first colour"], ["Lv 2", "1,000+", "stone walls, painted"], ["Lv 3", "10,000+", "medieval citadel: towers, banners, rich colour"], ["Lv 4", "100,000+", "sci-fi fortress: energy walls and a shield dome, full colour"], ["Lv 5+", "every 100,000 more", "neon"]].map(([a, b, c]) => <li key={a}><b>{a}</b> {b} Friends: {c}</li>)}</ol>
          <label className="docks-row tight">Preview every flag at <select aria-label="Preview flag looks" value={lookOverride ?? ""} onChange={e => setLookOverride(e.target.value === "" ? null : Number(e.target.value))}>
            <option value="">their real level</option>{[0, 1, 2, 3, 4, 5].map(n => <option key={n} value={n}>Lv {n} ({LK.LOOK_NAMES[n]})</option>)}</select></label>
          {lookOverride !== null && <p className="docks-note">Previewing looks only: levels, walls' defense and everything else stay real.</p>}
        </div>
        <p>Plant a flag and raise it together. Anyone can lock RF into it until it reaches its target; then it's founded. Targets follow a bonding curve: the next flag needs {fmt(VX.flagPrice(w))} RF ({fmt(VX.FLAG_BASE)} RF × {VX.FLAG_CURVE} per flag already up, at most {fmt(VX.FLAG_TARGET)}), so early flags are cheap and joining makes more sense later. Locked RF never comes back once it's founded (no rug): half becomes permanent RF/ETH liquidity whose trading fees buy RF (half back into the pool, half shared as allowances), half each founder's allowance to build flag items on their island. Everyone who locked holds a soulbound founder mark. Not full in {VX.FLAG_DAYS} days? Everyone takes their RF back. Once founded, each wallet brings up to two islands, one at war and one at peace: a founder's first is free, the other enrolls ({fmt(VX.ENROLL_PRICE)} RF: half liquidity, half the owner's allowance). Each island joins at ⚔️ war (fights, boards ships, forms the border: outsiders can't dock straight against it) or at 🕊 peace (makes goods, trades; outsiders dock next to it). Best layout: war islands around the edge, peace in the middle. Every Friend votes; founders' votes are multiplied. Population unlocks skins (100, 1,000, 10,000, 100,000 Friends, then every 100,000 more): bigger walls and better defenses for every island in the flag. Founders are the flag's 👑 OGs: up to 1,000 of its Friends carry an OG mark, shared by what each founder locked. Every flag gets its own generated flag Friend when it's planted: it levels up from part of the founding RF, part of every enrollment and its own revenue (half the flag's trade tax), and boosts the flag's peace output and war defense.</p>
        <div className="docks-rf"><span>Your RF <b>{fmt(econ.current.rf)}</b><span className="docks-sim">SIMULATED</span></span><span>Into pools <b>{fmt(econ.current.pooled)}</b></span>
          <button type="button" onClick={() => { econ.current.rf += 250_000; bump(); }}>＋250k preview RF</button></div>
        {(() => { const mv = mine.map(p => villageOf(w, p) ?? risingFlagOf(w, p)).find(Boolean);
          return mv ? <p className="docks-note">Your islands fly {mv.name}'s flag.</p> : <>
            <h3>🚩 Plant a flag</h3>
            <div className="docks-form"><label>Flag name<input value={flagName} maxLength={32} placeholder="Dock Town" onChange={e => setFlagName(e.target.value)} /></label>
              <label>Your first lock (RF)<input inputMode="numeric" value={firstLock} onChange={e => setFirstLock(e.target.value)} /></label></div>
            <div className="docks-row"><button type="button" className="rf-frame-primary" onClick={doPlantFlag}>🚩 Plant flag where #{String(lead)} stands</button></div>
            <p className="docks-note">The flag goes on the spot your lead stands, on a saved, docked island of yours. Smallest lock {fmt(VX.MIN_LOCK)} RF.</p></>; })()}
        {villageError && <p role="alert" className="docks-note">{villageError}</p>}
        {islandTabs}
        <h3>Flags on the docks</h3>
        {w.villages.length === 0 && <p className="docks-note">No flags yet.</p>}
        {w.villages.map(v => { const mineW = VX.weightOf(v, VX.YOU), full = v.locked >= v.target, open = VX.rising(v);
          const inIt = v.members.includes(isl) && v.founded, why = inIt ? null : joinProblem(w, v, isl);
          return <div className="docks-village" key={v.id}>
            <div className="docks-row tight"><strong><i className="docks-pennant" style={{ background: v.color }} />{v.name}</strong>
              <small>{v.founded ? `founded · ${v.members.length} island${v.members.length === 1 ? "" : "s"}` : v.failed ? "flag failed · refunds" : full ? "flag full" : `rising · ${VX.daysLeft(v)} days left`} · flag on {v.seat.name}{v.seat.mine ? " (yours)" : " (sample)"}</small>
              <button type="button" onClick={() => lookAtFlag(v)}>Look</button></div>
            <div className="docks-meter" role="progressbar" aria-label={`${v.name} flag`} aria-valuenow={VX.pct(v)} aria-valuemin={0} aria-valuemax={100}><i style={{ width: `${VX.pct(v)}%`, background: v.color }} /></div>
            <small>{fmt(v.locked)} / {fmt(v.target)} RF locked · {v.lockers.size} founder{v.lockers.size === 1 ? "" : "s"}{mineW ? ` · 🔒 your mark: ${fmt(mineW)} RF (${Math.round(mineW / Math.max(1, v.locked) * 100)}% of the flag, soulbound)` : ""}</small>
            {(() => { const f = flagFriends.current.get(v); if (!f) return null; const next = FF.nextCost(f);
              return <div className="docks-flagfriend"><img src={FF.art(f, v.color)} alt={`${f.name}, ${v.name}'s flag Friend`} />
                <span><strong>{f.name} · {v.name}'s flag Friend · level {f.level} {FF.title(f)}</strong>
                  <small>{next !== null ? `upgrade fund ${fmt(f.fund)} / ${fmt(next)} RF to level ${f.level + 1}` : `top level: its fund overflows into the loot vault`} · earned {fmt(f.earned)} RF running the market</small>
                  <small>peace output +{Math.round((FF.peaceBoost(f) - 1) * 100)}% · war defense +{Math.round((FF.defenseBoost(f) - 1) * 100)}% · fed by {FF.FLAG_FRIEND.FROM_FOUNDING_BPS / 100}% of the founding RF, {FF.FLAG_FRIEND.FROM_ENROLL_BPS / 100}% of each enrollment and {FF.FLAG_FRIEND.TAX_SHARE_BPS / 100}% of the flag's trade tax</small>
                  {next !== null && <div className="docks-meter" role="progressbar" aria-label={`${f.name} upgrade`} aria-valuenow={Math.floor(f.fund / next * 100)} aria-valuemin={0} aria-valuemax={100}><i style={{ width: `${Math.min(100, f.fund / next * 100)}%`, background: v.color }} /></div>}</span></div>; })()}
            {v.founded && (() => { const pop = VX.population(v), t = SK.skinTier(pop), next = SK.nextMilestone(pop), allot = SK.ogAllotment(v), mineOg = allot.get(VX.YOU) ?? 0, ogs = [...allot.values()].reduce((a, b) => a + b, 0);
              return <div className={`docks-skin skin-${Math.min(5, t)}`} style={{ ["--flag" as string]: v.color }}>
                <strong>{SK.skinIcon(t)} Skin: {SK.skinName(t)} · tier {t}</strong>
                <small>{pop.toLocaleString()} Friends · next skin at {next.toLocaleString()} · walls and defenses give every island in {v.name} +{Math.round((SK.defenseBoost(t) - 1) * 100)}% defense</small>
                <small>👑 OGs: {v.lockers.size} founder{v.lockers.size === 1 ? "" : "s"} · {ogs.toLocaleString()} of up to {SK.SKIN.OG_CAP.toLocaleString()} Friends carry an OG mark, shared by what each locked{mineOg ? ` · yours: ${mineOg.toLocaleString()}` : ""}</small>
                {VX.weightOf(v, VX.YOU) > 0 && <button type="button" disabled title="Coming later">👑 OG council: peace deals, mergers, large trades (coming)</button>}
              </div>; })()}
            {open && <div className="docks-row tight"><input aria-label={`Lock RF into ${v.name}`} inputMode="numeric" value={lockAmt[v.id] ?? "10000"} onChange={e => setLockAmt({ ...lockAmt, [v.id]: e.target.value })} />
              <button type="button" className="rf-frame-primary" onClick={() => doLock(v)}>Lock RF</button>
              <button type="button" title="Preview only" onClick={() => act(() => { const who = w.plots.find(p => !p.mine && p !== v.seat && p.friends.length)?.name ?? "A sample"; VX.lock(w, null, v, v.target - v.locked, who); })}>⏩ Samples fill it</button>
              <button type="button" title="Preview only" onClick={() => act(() => { v.deadline = Date.now() - 1; w.version++; })}>⏩ Skip to deadline</button></div>}
            {!v.founded && full && <div className="docks-row tight"><button type="button" className="rf-frame-primary" onClick={() => doFound(v)}>🏛 Found {v.name}</button><small>Anyone can found a full flag.</small></div>}
            {!v.founded && !open && !full && mineW > 0 && <div className="docks-row tight"><button type="button" onClick={() => doRefund(v)}>Take my {fmt(mineW)} RF back</button></div>}
            {v.founded && (() => { const mine1 = VX.islandOf(v, VX.YOU), price = VX.enrollPrice(v), pop = VX.population(v), myPower = VX.powerOf(v, VX.YOU), total = VX.totalPower(v);
              const why = mine1 ? null : joinProblem(w, v, isl);
              return <>
              <small>Liquidity <b>{fmt(v.liquidity)} RF</b>{v.pendingLiquidity ? ` (+${fmt(v.pendingLiquidity)} queued)` : ""} one-sided RF/ETH · fees waiting {fmt(v.fees.rf)} RF + {v.fees.eth.toFixed(3)} ETH · {v.poolBps / 100}% of buybacks back into the pool · {fmt(v.compounded)} compounded so far</small>
              <small>Population <b>{pop.toLocaleString()} Friends</b> on {v.members.length} island{v.members.length === 1 ? "" : "s"} · pool {fmt(v.pool)} RF · enrollment {price ? `open · ${fmt(price)} RF${VX.inWindow(v) ? ` (first week: ${Math.max(0, Math.ceil((v.foundedAt + VX.ENROLL_WINDOW_DAYS * VX.DAY - Date.now()) / VX.DAY))} days left)` : ""}${v.enrollCap ? ` until ${v.enrollCap.toLocaleString()} Friends` : ""}` : "closed"}</small>
              {(mine1 || mineW > 0) && <small>🧱 Your allowance <b>{fmt(Math.floor(VX.allowanceOf(v, VX.YOU)))} RF</b> to build flag items on your island here</small>}
              {mine1 ? <small>🗳 {mine1.name}: {mine1.friends.length.toLocaleString()} Friends × {VX.multiplier(v, VX.YOU).toFixed(2)} = <b>{myPower.toFixed(1)} votes</b> ({Math.round(myPower / Math.max(1e-9, total) * 100)}% of {total.toFixed(1)})</small>
                : mineW > 0 ? <small>Bring one island of yours to vote: your Friends × {VX.multiplier(v, VX.YOU).toFixed(2)}.</small> : null}
              <div className="docks-row tight">
                {mine1 && <button type="button" onClick={() => doHarvest(v)}>🌾 Harvest fees</button>}
                {v.pendingLiquidity > 0 && <button type="button" onClick={() => act(() => { VX.provideLiquidity(v); say(`Queued enrollment RF added to ${v.name}'s liquidity.`); })}>Add queued liquidity</button>}
                {!v.members.includes(isl) && (VX.bringsFree(v, VX.YOU)
                  ? <>{(["peace", "war"] as const).filter(st => !VX.islandAt(v, VX.YOU, st)).map(st => <button type="button" key={st} className={st === "peace" ? "rf-frame-primary" : ""} disabled={Boolean(why)} onClick={() => doBring(v, isl, st)}>{st === "peace" ? "🕊" : "⚔️"} Bring {isl.name} at {st} (founder, free)</button>)}</>
                  : <>{(["peace", "war"] as const).filter(st => !VX.islandAt(v, VX.YOU, st)).map(st => <button type="button" key={st} className={st === "peace" ? "rf-frame-primary" : ""} disabled={Boolean(why) || !price} onClick={() => doEnroll(v, isl, st)}>{price ? `${st === "peace" ? "🕊" : "⚔️"} Enroll ${isl.name} at ${st} · ${fmt(price)} RF` : "Enrollment closed"}</button>)}</>)}
                {VX.inWindow(v) && <button type="button" title="Preview only" onClick={() => { v.foundedAt -= VX.ENROLL_WINDOW_DAYS * VX.DAY; if (v.enrollVote) v.enrollVote.ends = Date.now() - 1; bump(); }}>⏩ Skip the first week</button>}</div>
              {[...v.removals.keys()].length > 0 && <button type="button" title="Preview only" onClick={() => act(() => { VX.skipEpoch(w); for (const line of VX.processRemovals(w)) say(line); })}>⏩ Skip to the next epoch</button>}
              {!v.members.includes(isl) && why && <small>{why}</small>}
              {VX.islandsOf(v, VX.YOU).map(p => { const st = v.stance.get(p) ?? "peace";
                return <div className="docks-item" key={p.id}><span><strong>{st === "war" ? "⚔️" : "🕊"} {p.name} · {st}</strong><small>{st === "war" ? "boards ships and defends; outsiders can't dock straight against it" : "makes goods and trades; anyone can dock next to it (2 RF docking fee)"}</small></span>
                  <span className="docks-row tight"><button type="button" onClick={() => doStance(v, p, st === "war" ? "peace" : "war")}>{st === "war" ? "🕊 Make it peace" : "⚔️ Make it war"}</button>
                    {p !== v.seat && (v.removals.has(p) ? <small>leaves {new Date(v.removals.get(p)!).toLocaleDateString()}</small> : <button type="button" onClick={() => doRequestRemoval(v, p)}>Request removal</button>)}</span></div>; })}
              {mine1 && <>
                <h4>🧱 Build on {mine1.name}</h4>
                <div className="docks-row tight"><select aria-label="Item to build" value={buildKind} onChange={e => setBuildKind(Number(e.target.value))}>
                  {VX.CATALOG.map((c, i) => <option key={i} value={i}>{c.icon} {c.name} · {fmt(c.price)} RF · {dur(c.build)}</option>)}</select>
                  <button type="button" className="rf-frame-primary" onClick={() => doBuild(v)}>Build where #{String(lead)} stands · allowance</button></div>
                {VX.itemsOn(w, mine1).map(it => { const c = VX.CATALOG[it.kind], left = it.readyAt - Date.now();
                  return <div className="docks-item" key={it.id}><span><strong>{c.icon} {c.name}</strong><small>{it.village ? "flag item: stays with the flag" : "yours"} · {left > 0 ? `🔨 ready in ${dur(left)}` : "built ✓"}</small></span>
                    {left > 0 && <span className="docks-row tight"><button type="button" onClick={() => doBoost(it, 1000)}>⚡ Boost · 1k RF</button><button type="button" onClick={() => doBoost(it, Math.ceil(left / 1000 / VX.BOOST_SECONDS_PER_RF))}>Finish · {fmt(Math.ceil(left / 1000 / VX.BOOST_SECONDS_PER_RF))} RF</button></span>}</div>; })}
              </>}
              {v.raffles.length > 0 && <h4>🎟 Raffles (items left behind)</h4>}
              {v.raffles.map((r, i) => { const c = VX.CATALOG[r.item.kind], ended = Date.now() >= r.ends, total = [...r.tickets.values()].reduce((a, b) => a + b, 0), mineT = r.tickets.get(VX.YOU) ?? 0;
                return <div className="docks-item" key={i}><span><strong>{c.icon} {c.name}</strong><small>{total} ticket{total === 1 ? "" : "s"}{mineT ? ` · ${mineT} yours` : ""} · {ended ? "ended" : `ends in ${dur(r.ends - Date.now())}`} · {VX.TICKET_PRICE} RF a ticket, to liquidity</small></span>
                  <span className="docks-row tight">
                    {!ended && mine1 && <button type="button" onClick={() => act(() => { VX.buyTickets(w, econ.current, v, r, VX.YOU, 1); say(`1 ticket for the ${c.name} (${VX.TICKET_PRICE} RF, simulated).`); })}>🎟 Buy a ticket</button>}
                    {!ended && <button type="button" title="Preview only" onClick={() => { r.ends = Date.now() - 1; bump(); }}>⏩ End raffle</button>}
                    {ended && <button type="button" className="rf-frame-primary" onClick={() => act(() => say(VX.draw(w, v, r)))}>Draw</button>}</span></div>; })}
              {v.proposals.length > 0 && <h4>Votes</h4>}
              {v.proposals.slice().reverse().slice(0, 6).map(p => { const ended = Date.now() >= p.ends, labels = p.kind === "enrollment" ? VX.ENROLL_CHOICES
                  : p.kind === "enrollPrice" ? p.options.map(o => `${fmt(o)} RF`) : p.kind === "enrollCap" ? p.options.map(o => `${o.toLocaleString()} Friends`) : ["No", "Yes"];
                const title = p.kind === "war" ? `⚔️ Declare war on ${p.memo} (${WR.WAR.WAR_DAYS} days)` : p.kind === "poolShare" ? `Put ${p.options[0] / 100}% of buybacks back into the pool`
                  : p.kind === "enrollment" ? "Enrollment after the vote" : p.kind === "enrollPrice" ? "New enrollment price (24h)" : "Close enrollment at (24h)";
                const mineChoice = p.voters.get(VX.YOU);
                return <div className="docks-item" key={p.id}><span><strong>#{p.id + 1} {title}</strong>
                  <small>{labels.map((l, i) => `${l} ${p.tally[i].toFixed(1)}`).join(" · ")} · {p.settled ? `settled: ${labels[p.winner]}` : ended ? "vote ended" : "vote open"}</small></span>
                  <span className="docks-row tight">
                    {!ended && myPower > 0 && mineChoice === undefined && labels.map((l, i) => <button type="button" key={i} onClick={() => act(() => VX.vote(v, p, VX.YOU, i))}>{l}</button>)}
                    {!ended && mineChoice !== undefined && <small>you: {labels[mineChoice]}</small>}
                    {!ended && <button type="button" title="Preview only" onClick={() => { p.ends = Date.now() - 1; bump(); }}>⏩ End vote</button>}
                    {ended && !p.settled && <button type="button" className="rf-frame-primary" onClick={() => doSettle(v, p)}>Settle</button>}</span></div>; })}
              {mine1 && <div className="docks-form">
                <label>% of each buyback back into the pool<input inputMode="numeric" value={burnPct} onChange={e => setBurnPct(e.target.value)} /></label>
                <button type="button" onClick={() => doPropose(v)}>Put the pool share to a vote</button>
                {!v.enrollVote && <button type="button" onClick={() => act(() => { VX.proposeEnrollment(v, VX.YOU); say(`Enrollment vote started for ${v.name} (${VX.VOTE_DAYS} days).`); })}>Start an enrollment vote</button>}</div>}
            </>; })()}
          </div>; })}
        <p className="docks-note">Every Friend on a member's island is a vote; founders multiply theirs by 1 + their share of the pool, and every enrollment fee grows the pool, so newcomers dilute founders. The pool share passes after {VX.VOTE_DAYS} days with more yes than no and {VX.QUORUM * 100}% of all votes cast. Enrollment: open for the first {VX.ENROLL_WINDOW_DAYS} days at {fmt(VX.ENROLL_PRICE)} RF, then whatever the flag votes (keep open, a new price, close, or close at a population; a new price or population is picked in a 24-hour vote between three). Leaving: request removal and your island leaves at the next epoch (every {VX.EPOCH_DAYS} days), no RF back. A Friend that leaves a flagged island stays bound to that flag until the next epoch; it can come back to its spot if the population allows. Items bought with your allowance belong to the flag; if you leave they're raffled to those who stayed. More flag options are coming. ⏩ buttons only exist in the preview.</p>
        <h3>🧱 Your own items</h3>
        <p className="docks-note">Buy with your own RF and they're always yours: build them on any of your islands (the RF goes to that island's flag pool, or the shared Docks pool), take them off and put them back.</p>
        <div className="docks-row tight"><select aria-label="Own item to build" value={buildKind} onChange={e => setBuildKind(Number(e.target.value))}>
          {VX.CATALOG.map((c, i) => <option key={i} value={i}>{c.icon} {c.name} · {fmt(c.price)} RF · {dur(c.build)}</option>)}</select>
          <button type="button" onClick={() => doBuild(null)}>Buy where #{String(lead)} stands · my RF</button></div>
        {w.items.filter(it => it.owner === VX.YOU).map(it => { const c = VX.CATALOG[it.kind];
          return <div className="docks-item" key={it.id}><span><strong>{c.icon} {c.name}</strong><small>{it.plot ? `on ${it.plot.name}` : "not placed"}{it.plot && it.readyAt > Date.now() ? ` · 🔨 ${dur(it.readyAt - Date.now())}` : ""}</small></span>
            <span className="docks-row tight">{it.plot ? <button type="button" onClick={() => act(() => VX.takeOff(w, it, VX.YOU))}>Take off</button> : <button type="button" onClick={() => doPlaceOwn(it)}>Place where #{String(lead)} stands</button>}</span></div>; })}
      </> : menu === "war" ? (() => { const bk = book.current, v = myFlag(), e = econ.current;
        const earned = Math.floor(bk.earned.get(VX.YOU) ?? 0);
        return <div className="docks-war">
        <p>Only founded flags go to war. Send a ship on tour to another flag: islands board first come, first served (or auto-join), and it sails when full or when you say. Each island aboard duels a defending island of its own tier, one above or one below, never more; a dinghy is a solo, one-on-one tour. Each duel is best of 3 rounds: ⛵ Broadside (ships + attack items), 🤺 Boarding (raw strength), 🏰 Siege (defense items). Win more duels and you take part of the loser's <b>loot vault</b> plus a bounty from the Docks rewards reserve: half to the islands that fought (by level, claimable to your Friend's wallet), half into your vault. Lose and your ship sinks for {WR.WAR.SHIP_REGEN_HOURS} h and your vault pays. Only a flag's loot vault is ever at risk: never your wallet or allowance.</p>
        <div className="docks-rf"><span>Your RF <b>{fmt(e.rf)}</b><span className="docks-sim">SIMULATED</span></span><span>Docks rewards reserve <b>{fmt(e.docksFund)}</b></span>
          <span>Your earned loot <b>{fmt(earned)}</b></span>
          <button type="button" className="rf-frame-primary" disabled={!earned} onClick={() => act(() => { const n = WR.claim(bk, e); say(`Claimed ${fmt(n)} RF of loot to #${friendId}'s wallet (simulated). It's yours now: never at risk.`); })}>Claim to #{String(friendId)}'s wallet</button></div>
        {villageError && <p role="alert" className="docks-note">{villageError}</p>}
        {!v ? <p className="docks-note">Your islands fly no flag, so they can't go to war or raid, and nobody can raid them: an island in no flag trades, chats, docks, buys and sells (🧺 Market). To fight, join or found a flag in 🚩 Flags and set an island there to ⚔️ war.</p> : (() => {
          const tier = WR.tierOf(w, v), shield = WR.shielded(v), ready = WR.readiness(w, bk, v), ships = WR.shipsOf(bk, v), rs = WR.readyShips(bk, v);
          return <>
          <h3><i className="docks-pennant" style={{ background: v.color }} />{v.name} · {WR.tierName(tier)}</h3>
          <small>Battle power <b>{fmt(Math.round(WR.flagPower(w, v)))}</b> · {v.members.length} island{v.members.length === 1 ? "" : "s"} · loot vault <b>{fmt(WR.lootOf(bk, v))} RF</b> (loses {WR.lossBps(tier) / 100}% per lost battle) · {shield ? `🛡 shield: ${Math.ceil((WR.shieldEnds(v) - Date.now()) / VX.DAY)} days to build up, no raids either way` : "open to raids"}</small>
          {shield && <div className="docks-item"><span><strong>🛠 Battle readiness {ready.pct}%</strong><small>{ready.checks.map(c => `${c.ok ? "✅" : "⬜"} ${c.label}`).join(" · ")}</small></span>
            <button type="button" title="Preview only" onClick={() => { v.foundedAt -= WR.WAR.SHIELD_DAYS * VX.DAY; bump(); }}>⏩ End shield</button></div>}
          <div className="docks-row tight"><input aria-label={`Add RF to ${v.name}'s loot vault`} inputMode="numeric" value={vaultAdd} onChange={e2 => setVaultAdd(e2.target.value)} />
            <button type="button" onClick={() => act(() => { const n = rfIn(vaultAdd); WR.fund(bk, e, v, n); say(`${fmt(n)} RF into ${v.name}'s loot vault (simulated): a bigger target, and a bigger buffer.`); })}>Add to loot vault</button></div>
          {(() => { const me = v.members.find(p => p.mine); return me ? <div className="docks-item"><span><strong>{me.name} · island {WR.islandTierName(WR.islandTier(w, me))} · power {fmt(Math.round(WR.islandPower(w, me)))}</strong>
            <small>Your island fights islands of its tier or one above or below, always.</small></span>
            <label className="docks-ship"><input type="checkbox" checked={bk.autoJoin.has(me)} onChange={() => { if (bk.autoJoin.has(me)) bk.autoJoin.delete(me); else bk.autoJoin.add(me); bump(); }} />Auto-join {v.name}'s tours</label></div> : null; })()}
          <h4>⛵ Ships</h4>
          <div className="docks-row tight">{ships.map(sh => { const c = WR.SHIPS[sh.kind], left = sh.readyAt - Date.now(), gone = WR.sunk(sh), touring = WR.onTour(bk, sh), ok = rs.includes(sh);
            return <label key={sh.id} className="docks-ship"><input type="radio" name="tour-ship" disabled={!ok} checked={tourShip === sh.id} onChange={() => setTourShip(sh.id)} />{c.icon} {c.name} · {c.seats} seat{c.seats === 1 ? "" : "s"} · up to {WR.islandTierName(c.maxTier)}{left > 0 ? ` · 🔨 ${dur(left)}` : gone ? ` · 🌊 sunk, back in ${dur(sh.sunkUntil! - Date.now())}` : touring ? " · on tour" : ""}</label>; })}</div>
          <div className="docks-row tight"><select aria-label="Ship to build" value={shipKind} onChange={e2 => setShipKind(Number(e2.target.value))}>
            {WR.SHIPS.map((c, i) => <option key={i} value={i}>{c.icon} {c.name} · {c.seats} seat{c.seats === 1 ? "" : "s"} · up to {WR.islandTierName(c.maxTier)} · +{c.attack * 100}% attack · {fmt(c.price)} RF · {dur(c.build)}</option>)}</select>
            <button type="button" onClick={() => act(() => { const sh = WR.buildShip(bk, e, v, shipKind, "allowance"); say(`${WR.SHIPS[sh.kind].icon} ${WR.SHIPS[sh.kind].name} on the slipway for ${v.name} (allowance, simulated): ready in ${dur(WR.SHIPS[sh.kind].build)}.`); })}>Build · allowance</button>
            <button type="button" onClick={() => act(() => { const sh = WR.buildShip(bk, e, v, shipKind, "rf"); say(`${WR.SHIPS[sh.kind].icon} ${WR.SHIPS[sh.kind].name} on the slipway for ${v.name} (your RF, simulated): ready in ${dur(WR.SHIPS[sh.kind].build)}.`); })}>Build · my RF</button>
            {ships.some(sh => sh.readyAt > Date.now() || WR.sunk(sh)) && <button type="button" title="Preview only" onClick={() => { WR.finishShips(bk, v); bump(); }}>⏩ Finish ships</button>}</div>
          <label className="docks-ship"><input type="checkbox" checked={autoSail} onChange={() => setAutoSail(x => !x)} />Auto-sail when full</label>
          <small>War items on your islands count in battle: {Object.entries(WR.ITEM_WAR).map(([n, x]) => `${n} ${x.attack ? `+${x.attack * 100}% attack` : ""}${x.attack && x.defense ? " " : ""}${x.defense ? `+${x.defense * 100}% defense` : ""}`).join(" · ")} (build them in 🚩 Flags; at most +{WR.WAR.ITEM_BONUS_CAP * 100}% per island and side).</small>
          {bk.tours.filter(t => t.from === v).length > 0 && <h4>🧭 Tours</h4>}
          {bk.tours.filter(t => t.from === v).map(t => { const c = WR.SHIPS[t.ship.kind], me = v.members.find(p => p.mine), why = me ? WR.boardProblem(w, bk, t, me) : "no island";
            return <div className="docks-item" key={t.id}><span><strong>{c.icon} {c.name} → {t.target.name}</strong><small>{t.crew.length}/{c.seats} aboard: {t.crew.map(p => p.name).join(", ")} · {t.autoSail ? "sails when full" : "sails on the deployer's word"}</small></span>
              <span className="docks-row tight">
                {!why && <button type="button" onClick={() => act(() => { WR.board(w, bk, t, me!); if (t.autoSail && WR.full(t)) reportBattle(WR.sail(w, bk, e, t, WR.autoDefenders(t.target))); })}>Board</button>}
                {t.deployer === VX.YOU && <button type="button" className="rf-frame-primary" onClick={() => doSail(t)}>⛵ Sail now</button>}
                {t.deployer === VX.YOU && <button type="button" onClick={() => { WR.cancelTour(bk, t); bump(); }}>Call off</button>}</span></div>; })}
          <h4>🎯 Targets</h4>
          {WR.targets(w, bk, v).map(d => { const why = WR.raidProblem(w, bk, v, d), td = WR.tierOf(w, d), war = WR.atWar(bk, v, d);
            const voting = v.proposals.some(p => p.kind === "war" && !p.settled && w.villages[p.options[0]] === d);
            return <div className="docks-item" key={d.id}><span><strong><i className="docks-pennant" style={{ background: d.color }} />{d.name} · {WR.tierName(td)}{war ? " · ⚔️ at war" : ""}</strong>
              <small>power {fmt(Math.round(WR.flagPower(w, d)))} · islands {d.members.map(p => WR.islandTierName(WR.islandTier(w, p))).join(", ")} · {VX.population(d).toLocaleString()} Friends · loot vault {fmt(WR.lootOf(bk, d))} RF{why ? ` · ${why}` : ""}</small></span>
              <span className="docks-row tight">
                <button type="button" className="rf-frame-primary" disabled={Boolean(why) || tourShip === null} onClick={() => doDeploy(v, d)}>⛵ Send on tour</button>
                {!war && !voting && <button type="button" onClick={() => act(() => { VX.proposeWar(w, v, VX.YOU, d); say(`🗳 ${v.name} votes on war with ${d.name} (1 day). See the votes in 🚩 Flags.`); })}>🗳 Vote for war</button>}
                {voting && <small>war vote open</small>}</span></div>; })}
          </>; })()}
        {lastBattle && <div className="docks-item docks-battle"><span><strong>{lastBattle.attackerWon === null ? "🤝" : lastBattle.attackerWon ? "🏆" : "💥"} {lastBattle.attacker.name} → {lastBattle.defender.name}: {lastBattle.attackerWon === null ? "a draw" : lastBattle.attackerWon ? "raid won" : "raid beaten off"}</strong>
          {lastBattle.duels.map((x, i) => <small key={i}>{x.attacker.name} ({WR.islandTierName(WR.islandTier(w, x.attacker))}) vs {x.defender ? `${x.defender.name} (${WR.islandTierName(WR.islandTier(w, x.defender))}): ${["⛵ Broadside", "🤺 Boarding", "🏰 Siege"].slice(0, x.rounds.length).map((n, k) => `${n} ${x.rounds[k] ? "✓" : "✗"}`).join(" · ")} → ${x.won ? "won" : "lost"}` : "no match within one tier: sat it out"}</small>)}
          <small>loot {fmt(lastBattle.loot)} + bounty {fmt(lastBattle.bounty)} RF{lastBattle.war ? " (war: double bounty)" : ""}{lastBattle.shares.size ? ` · ${[...lastBattle.shares].map(([who, n]) => `${who === VX.YOU ? "you" : who} ${fmt(Math.floor(n))}`).join(" · ")}` : ""}</small></span></div>}
        {book.current.battles.length > 0 && <><h4>📜 Recent battles on the docks</h4>
          {book.current.battles.slice(-6).reverse().map(b => <small key={b.id}>{b.attackerWon === null ? "🤝" : b.attackerWon ? "🏆" : "💥"} {b.attacker.name} → {b.defender.name}: {b.attackerWon === null ? "draw" : b.attackerWon ? "raid won" : "beaten off"} · duels {b.duels.map(x => x.won === null ? "–" : x.won ? "✓" : "✗").join("")} · {fmt(b.loot + b.bounty)} RF · {dur(Math.max(0, Date.now() - b.at))} ago</small>)}
          <small>{book.current.battles.length} battles fought on the docks so far.</small></>}
        <details><summary>War rules (all settings, tunable)</summary>
          <p className="docks-note">Shield {WR.WAR.SHIELD_DAYS} days after founding · loot vault starts with {WR.WAR.LOOT_FROM_FOUNDING_BPS / 100}% of the flag's RF and gets {WR.WAR.LOOT_FROM_FEES_BPS / 100}% of every harvest of its AMM fees; anyone can add to it · bounty {WR.WAR.DOCKS_BOUNTY_BPS / 100}% of the Docks rewards reserve per win (double in a declared war) · {WR.WAR.TO_FIGHTERS_BPS / 100}% of loot to the fighters by level, the rest to the winner's vault · loss per battle {WR.WAR.TIER_NAMES.map((n, t) => `${n} ${WR.lossBps(t) / 100}%`).join(", ")} · home advantage {WR.WAR.HOME_ADVANTAGE * 100}% · every island aboard duels a defender within one island tier ({WR.WAR.ISLAND_TIERS.map((m, t) => `tier ${t + 1} ${fmt(m)}+`).join(", ")}); no match, it sits out · a sunk ship comes back after {WR.WAR.SHIP_REGEN_HOURS} h · raid cooldown {WR.WAR.RAID_COOLDOWN_HOURS} h per target outside a war · war lasts {WR.WAR.WAR_DAYS} days · {WR.WAR.INTRO_DINGHIES} free dinghies per new flag · flag tiers by battle power: {WR.WAR.TIERS.map((m, t) => `${WR.WAR.TIER_NAMES[t]} ${fmt(m)}+`).join(", ")} (tier skins later). Island level = rank (reward weight) + log₂(Friends); strength = level × √Friends. On chain, each round is one Dice roll.</p></details>
      </div>; })() : menu === "market" ? (() => { const mk = market.current, e = econ.current, inv = PC.invOf(mk, VX.YOU), mineP = myPlots(w);
        const peaceMine = mineP.filter(p => PC.peaceful(w, p)), sellFrom = peaceMine.includes(isl) ? isl : peaceMine[0];
        const own = w.items.filter(it => it.owner === VX.YOU && !mk.listings.some(l => l.item === it));
        return <div className="docks-war">
        <p>Peace land makes goods and trades them: build 🌾 Farms, 🎣 Fisheries, 🔨 Workshops, 🧵 Looms and 🏺 Kilns on a peace island (or any island in no flag), collect what they make, and sell it, or your own items, at your price. You can buy from islands docked or bridged to yours and from your flag-mates; war islands don't trade. A sale from a flag's peace island pays {PC.PEACE.TRADE_TAX_BPS / 100}% tax to that flag's treasury; islands in no flag trade tax-free.</p>
        <div className="docks-rf"><span>Your RF <b>{fmt(e.rf)}</b><span className="docks-sim">SIMULATED</span></span>{PC.GOODS.map((g, i) => <span key={i}>{g.icon} {g.name} <b>{inv[i]}</b></span>)}</div>
        {villageError && <p role="alert" className="docks-note">{villageError}</p>}
        {(() => { const fv = w.villages.find(v => v.id === marketAt && v.founded); if (!fv) return null;
          const ls = mk.listings.filter(l => l.seller !== VX.YOU && fv.members.includes(l.from)), buyer = ls.length ? PC.buyerFor(w, mineP, ls[0].from) : mineP.find(m => fv.members.some(q => PC.peaceful(w, q) && connected(w, m, q))) ?? null;
          return <div className="docks-citymarket" style={{ ["--flag" as string]: fv.color }}>
            <h4>🏙 {fv.name} market <small>Level {SK.tierOfFlag(fv)} · 👥 {VX.population(fv).toLocaleString()} · {PC.PEACE.TRADE_TAX_BPS / 100}% tax to the flag</small></h4>
            {!buyer && <div className="docks-row tight"><span className="docks-note">Dock at its harbor to buy here.</span>{harborOf(fv).length > 0 && <button type="button" className="rf-frame-primary" onClick={() => dockAtHarbor(fv)}>⚓ Dock at harbor · {DOCKING_FEE} RF</button>}</div>}
            {ls.length ? ls.slice(0, 20).map(l => <div className="docks-item" key={l.id}><span><strong>{l.qty} {l.good !== null ? `${PC.GOODS[l.good].icon} ${PC.GOODS[l.good].name}` : `${VX.CATALOG[l.item!.kind].icon} ${VX.CATALOG[l.item!.kind].name}`} · {fmt(l.price)} RF each</strong><small>from {l.from.name}</small></span>
              {buyer && <button type="button" onClick={() => act(() => { const r = PC.buy(w, mk, e, l, 1, buyer); afterSale(r.village, r.tax); say(`🛒 Bought 1 at ${fv.name}'s market for ${fmt(r.total)} RF (simulated), ${fmt(r.tax)} RF of it tax to the flag.`); })}>Buy 1</button>}</div>)
              : <p className="docks-note">Nothing listed right now; residents post goods every few minutes.</p>}
            {ls.length > 20 && <small>{ls.length - 20} more listings.</small>}
            <button type="button" onClick={() => setMarketAt(null)}>Show all markets near me</button>
          </div>; })()}
        <h4>🌾 Your land</h4>
        {mineP.map(p => { const out = PC.outputOf(w, p), wait = PC.waiting(w, mk, p), any = out.some(x => x > 0), st = stanceOf(w, p);
          return <div className="docks-item" key={p.id}><span><strong>{st === "war" ? "⚔️" : "🕊"} {p.name}{st ? ` · ${st}` : " · no flag"}</strong>
            <small>{st === "war" ? "a war island: it doesn't produce" : any ? `makes ${out.map((r, i) => r ? `${r.toFixed(1)} ${PC.GOODS[i].icon}/h` : "").filter(Boolean).join(" · ")} · waiting ${wait.map((n, i) => n ? `${n} ${PC.GOODS[i].icon}` : "").filter(Boolean).join(" ") || "nothing yet"}` : "no producers yet: build a Farm, Fishery, Workshop, Loom or Kiln here (🚩 Flags → your own items)"}</small></span>
            <span className="docks-row tight">{any && <button type="button" onClick={() => act(() => { const got = PC.collect(w, mk, p); say(`Collected from ${p.name} (simulated): ${got.map((n, i) => n ? `${n} ${PC.GOODS[i].name}` : "").filter(Boolean).join(", ") || "nothing yet"}.`); })}>Collect</button>}
              {any && <button type="button" title="Preview only" onClick={() => { mk.lastCollect.set(p, Date.now() - 12 * VX.HOUR); bump(); }}>⏩ 12 h</button>}</span></div>; })}
        <h4>🏷 Sell {sellFrom ? `from ${sellFrom.name}` : ""}</h4>
        {!sellFrom ? <p className="docks-note">All your islands are at war: make one peace to trade.</p> : <div className="docks-row tight">
          <select aria-label="What to sell" value={sellWhat} onChange={e2 => setSellWhat(e2.target.value)}>
            {PC.GOODS.map((g, i) => <option key={`g${i}`} value={`g${i}`}>{g.icon} {g.name} ({inv[i]})</option>)}
            {own.map(it => <option key={`i${it.id}`} value={`i${it.id}`}>{VX.CATALOG[it.kind].icon} {VX.CATALOG[it.kind].name} (your item)</option>)}</select>
          {sellWhat.startsWith("g") && <input aria-label="Quantity" inputMode="numeric" value={sellQty} onChange={e2 => setSellQty(e2.target.value)} />}
          <input aria-label="Price each (RF)" inputMode="numeric" value={sellPrice} onChange={e2 => setSellPrice(e2.target.value)} />
          <button type="button" className="rf-frame-primary" onClick={() => act(() => { const id = Number(sellWhat.slice(1)), what = sellWhat.startsWith("g") ? { good: id } : { item: w.items.find(it => it.id === id)! };
            const l = PC.list(w, mk, sellFrom, what, rfIn(sellQty), rfIn(sellPrice)); say(`🏷 Listed ${l.qty} ${l.good !== null ? PC.GOODS[l.good].name : VX.CATALOG[l.item!.kind].name} at ${fmt(l.price)} RF each from ${sellFrom.name} (simulated).`); })}>List for sale</button></div>}
        {mk.listings.filter(l => l.seller === VX.YOU).map(l => <div className="docks-item" key={l.id}><span><strong>🏷 {l.qty} {l.good !== null ? `${PC.GOODS[l.good].icon} ${PC.GOODS[l.good].name}` : `${VX.CATALOG[l.item!.kind].icon} ${VX.CATALOG[l.item!.kind].name}`} · {fmt(l.price)} RF each</strong><small>yours, from {l.from.name}</small></span>
          <button type="button" onClick={() => act(() => PC.unlist(w, mk, l))}>Take down</button></div>)}
        <h4>🛒 For sale near you</h4>
        {(() => { const near = mk.listings.filter(l => l.seller !== VX.YOU).map(l => ({ l, buyer: PC.buyerFor(w, mineP, l.from) }));
          const reach = near.filter(x => x.buyer), far = near.length - reach.length;
          return <>{reach.length ? reach.map(({ l, buyer }) => <div className="docks-item" key={l.id}><span><strong>{l.qty} {l.good !== null ? `${PC.GOODS[l.good].icon} ${PC.GOODS[l.good].name}` : `${VX.CATALOG[l.item!.kind].icon} ${VX.CATALOG[l.item!.kind].name}`} · {fmt(l.price)} RF each</strong>
            <small>from {l.from.name}{villageOf(w, l.from) ? ` (🚩 ${villageOf(w, l.from)!.name}: ${PC.PEACE.TRADE_TAX_BPS / 100}% tax to it)` : " (no flag: no tax)"}</small></span>
            <span className="docks-row tight">
              <button type="button" onClick={() => act(() => { const r = PC.buy(w, mk, e, l, 1, buyer!); afterSale(r.village, r.tax); say(`🛒 Bought 1 from ${l.from.name} for ${fmt(r.total)} RF (simulated)${r.tax ? `, ${fmt(r.tax)} RF of it tax to ${r.flag}` : ""}.`); })}>Buy 1</button>
              {l.qty > 1 && <button type="button" onClick={() => act(() => { const r = PC.buy(w, mk, e, l, l.qty, buyer!); afterSale(r.village, r.tax); say(`🛒 Bought all from ${l.from.name} for ${fmt(r.total)} RF (simulated)${r.tax ? `, ${fmt(r.tax)} RF of it tax to ${r.flag}` : ""}.`); })}>Buy all · {fmt(l.qty * l.price)} RF</button>}</span></div>)
            : <p className="docks-note">Nothing you can reach: dock next to a peace island (or an island in no flag) to trade with it.</p>}
            {far > 0 && <small>{far} more listing{far === 1 ? "" : "s"} on islands you aren't docked or bridged to.</small>}</>; })()}
        {mk.sales.length > 0 && <><h4>📈 The Docks market</h4>
          <small>{PC.GOODS.map(g => { const ss = mk.sales.filter(x => x.good === g.name); const q = ss.reduce((n, x) => n + x.qty, 0); return `${g.icon} ${q ? `${(ss.reduce((n, x) => n + x.total, 0) / q).toFixed(1)} RF` : "–"}`; }).join(" · ")} (average price paid)</small>
          {mk.sales.slice(-6).reverse().map((x, i) => <small key={i}>{x.buyer === VX.YOU ? "You" : x.buyer} bought {x.qty} {x.good} from {x.seller === VX.YOU ? "you" : x.seller} for {fmt(x.total)} RF{x.tax ? ` (${fmt(x.tax)} RF tax)` : ""}</small>)}
          <small>{mk.sales.length.toLocaleString()} sale{mk.sales.length === 1 ? "" : "s"} · {fmt(mk.sales.reduce((n, x) => n + x.total, 0))} RF traded · {fmt(mk.sales.reduce((n, x) => n + x.tax, 0))} RF paid in tax to flags.</small></>}
      </div>; })() : menu === "tokens" ? <>
        <div className="docks-rf"><span>Your RF <b>{fmt(econ.current.rf)}</b><span className="docks-sim">SIMULATED</span></span><span>Into pools <b>{fmt(econ.current.pooled)}</b></span><span>Docks pool <b>{fmt(econ.current.docksPool)}</b></span><span>Platform fee <b>{PLATFORM_FEE_BPS / 100}%</b></span></div>
        <p className="docks-note">Launch a token from your island for {LAUNCH_FEE.toLocaleString()} RF. Airdrops and claims land in each Friend's own wallet; every claim costs RF. Launch fees and claim prices go into {poolName(w, h)} (the launching island's flag pool, or the shared Docks pool): nothing is burned. In this preview it's all simulated; the contracts are in the submission.</p>
        <h3>Launch a token from {h.name}</h3>
        <div className="docks-form">
          <label>Name<input value={form.name} maxLength={32} placeholder="Market Coin" onChange={e => setForm({ ...form, name: e.target.value })} /></label>
          <label>Ticker<input value={form.symbol} maxLength={8} placeholder="MKT" onChange={e => setForm({ ...form, symbol: e.target.value.toUpperCase() })} /></label>
          <label>Total supply<input inputMode="numeric" value={form.supply} onChange={e => setForm({ ...form, supply: e.target.value })} /></label>
          <label>Airdrop to<select value={form.airdropScope} onChange={e => setForm({ ...form, airdropScope: e.target.value as Scope | "none" })}>
            <option value="none">No airdrop</option>{SCOPES.map(sc => <option key={sc.id} value={sc.id}>{sc.label}</option>)}</select></label>
          <label>Airdrop per Friend<input inputMode="numeric" value={form.airdropEach} disabled={form.airdropScope === "none"} onChange={e => setForm({ ...form, airdropEach: e.target.value })} /></label>
          <label>Who can claim<select value={form.claimScope} onChange={e => setForm({ ...form, claimScope: e.target.value as Scope })}>
            {SCOPES.map(sc => <option key={sc.id} value={sc.id}>{sc.label}</option>)}</select></label>
          <label>Claim pool<input inputMode="numeric" value={form.claimPool} onChange={e => setForm({ ...form, claimPool: e.target.value })} /></label>
          <label>Per claim<input inputMode="numeric" value={form.claimEach} onChange={e => setForm({ ...form, claimEach: e.target.value })} /></label>
          <label>Claim price (RF, into the pool)<input inputMode="numeric" value={form.claimPrice} onChange={e => setForm({ ...form, claimPrice: e.target.value })} /></label>
        </div>
        <p className="docks-note">{form.airdropScope === "none" ? "No airdrop." : `Airdrop reaches ${eligibleFriends(w, { scope: form.airdropScope, creator: h }, canVisit).length.toLocaleString()} Friend wallet(s) right now (${SCOPES.find(x => x.id === form.airdropScope)!.hint}).`} The rest of the supply goes to #{String(friendId)}'s wallet.</p>
        {launchError && <p role="alert" className="docks-note">{launchError}</p>}
        <div className="docks-row"><button type="button" className="rf-frame-primary" disabled={!h.berth} onClick={doLaunch}>🚀 Launch for {LAUNCH_FEE.toLocaleString()} RF</button>
          {!h.berth && <span className="docks-note">Dock {h.name} first.</span>}</div>
        <h3>Tokens on the docks</h3>
        {econ.current.launches.length === 0 && <p className="docks-note">None yet.</p>}
        {[...econ.current.launches].reverse().map(l => {
          const mineIds = new Set(allMine.map(p => p.m.id));
          const can = eligibleFriends(w, l, canVisit).filter(x => mineIds.has(x.id) && !l.claimed.has(x.id)).length;
          const n = Math.min(can, l.claimEach ? Math.floor(l.claimRemaining / l.claimEach) : 0, l.claimPrice ? Math.floor(econ.current.rf / l.claimPrice) : can);
          const claimedAny = [...mineIds].some(id => l.claimed.has(id));
          return <div className="docks-token" key={l.id}><strong>${l.symbol} · {l.name}</strong>
            <small>by {l.creator.mine ? "you" : `${l.creator.name} (sample)`} · supply {fmt(l.supply)} · claim {fmt(l.claimEach)} for {l.claimPrice} RF · {fmt(l.claimRemaining)} left · {SCOPES.find(x => x.id === l.scope)!.label}</small>
            <div className="docks-row"><button type="button" disabled={n < 1} onClick={() => doClaimAll(l)}>
              {n < 1 ? (claimedAny ? "Claimed ✓" : "Not eligible · dock your island") : `Claim for ${n.toLocaleString()} Friend${n === 1 ? "" : "s"} · ${fmt(n * l.claimPrice)} RF`}</button></div></div>; })}
        <h3>Your Friends' wallets</h3>
        {(() => { const totals = new Map<string, { sum: number; holders: number }>();
          for (const p of allMine) for (const [sym, a] of econ.current.wallets.get(p.m.id) ?? []) { const t = totals.get(sym) ?? { sum: 0, holders: 0 }; t.sum += a; t.holders++; totals.set(sym, t); }
          return totals.size ? [...totals].map(([sym, t]) => <div className="docks-item" key={sym}><span><strong>{fmt(t.sum)} ${sym}</strong><small>across {t.holders.toLocaleString()} Friend wallet{t.holders === 1 ? "" : "s"}</small></span></div>)
            : <p className="docks-note">Empty so far.</p>; })()}
      </> : menu === "help" ? <ul className="docks-help">
        <li><strong>Islands:</strong> every activated Friend is a small floating island; joined, they make one big island. Every activated Friend in your wallet joins automatically, from 1 to 10,000+. Keep them together or deploy them to more islands (＋ New island). Islands are saved to your wallet and can't be sold; the only NFTs are your Friends.</li>
        <li><strong>Holes:</strong> if a saved Friend leaves your wallet (sending it clears its activation) or is deactivated, its spot becomes a hole in the island. The hole stays until that Friend comes back (it heals for free) or you fill it with another activated Friend of the same generation (normal arrange fee).</li>
        <li><strong>Arranging is the game:</strong> Arrange → tap a Friend and move it, or <em>Pick several</em> / <em>All</em> to move a group together; each Friend must touch another along part of a side. Save on chain pays RF for every Friend whose spot changed ({Object.entries(ARRANGE_FEE).map(([g, f]) => `Gen ${g}: ${f}`).join(", ")}), plus gas, into a pool (your flag's, or the shared Docks pool). Unmoved Friends are free; Undo returns to your last save.</li>
        <li><strong>No burning:</strong> every fee in The Docks goes into a permanent RF/ETH pool: your flag's, or the shared Docks pool. A flag pool's trading fees buy RF: half back into the pool, half shared as members' allowances. The shared Docks pool keeps everything from islands in no flag as liquidity; its trading fees are saved as earned, in ETH and RF, in the Docks rewards reserve for leaders and games later. The platform fee is {PLATFORM_FEE_BPS / 100}% for now (never above 5%).</li>
        <li><strong>Which one is you:</strong> the Friend you control has a <b>YOU ▼</b> marker over it; Friends of yours walking with you have a small ▾.</li>
        <li><strong>Colour:</strong> islands on their own are black and white. Join (or plant) a flag and its islands take the flag's colour, richer with every population level (100, 1,000, 10,000, 100,000 Friends…), with bigger walls: palisade, stone, a medieval citadel, then a sci-fi fortress. Gardens and gardeners grow with it too. Inside a flag every island has its own shade, and upgraded islands shine a level brighter (★ on their label): one ★ for a City or Capital by reward weight, one ★ for 2+ items built. 🚩 Flags shows the ladder and can preview every level.</li>
        <li><strong>Dock:</strong> tap any island on the map and hit ⚓ Dock ({DOCKING_FEE} RF docking fee, to The Docks fund), or Docks → pick a loading zone next to another island. Docked (or bridged) to someone? 💬 Chat with them. Every island takes one berth whatever its size, so how far you can roam depends on how many islands there are. Docking and moving cost only gas. Neighbours are joined by a gangway.</li>
        <li><strong>Bridges:</strong> can't dock next to an island? Build a bridge to it: a {DOCKING_FEE} RF docking fee, like docking. It lasts until either island moves. Connected islands can be walked onto (a toll to the owner may come later).</li>
        <li><strong>Visit:</strong> for now only islands under a flag can be walked onto: every island of your flag, and, just to explore, a flag's islands your island is docked next to or bridged to.</li>
        <li><strong>Control any Friend:</strong> tap (or click) one of your Friends on its land or walking in a line: <em>Control</em> it (taken out of a line, it breaks off), <em>Break off crew</em> (it and those behind it follow it), <em>Call</em> it, <em>Send home</em>, <em>Pick</em>, make it the island's <em>captain</em> (the Friend you pick when you connect becomes captain; saved on chain once, you board as it every time) or <em>mayor</em> (a second Friend that stays home and greets visitors), or <em>Name</em> it (a public name, saved on chain). 👥 Crew → <em>Change Friend</em>, <em>Call all</em> to the primary leader, <em>Make primary leader</em>, <em>Walk solo</em>, <em>All go home</em>.</li>
        <li><strong>Flags:</strong> 🚩 Flags → plant a flag where your lead stands and lock RF. Anyone can lock more until it hits {fmt(VX.FLAG_TARGET)} RF; then it's founded: half permanent RF/ETH liquidity whose trading fees buy RF (half back into the pool, half shared), half the founders' allowances for building. Lockers hold soulbound founder marks. Everyone brings one island: founders free, others enroll ({fmt(VX.ENROLL_PRICE)} RF, open the first {VX.ENROLL_WINDOW_DAYS} days, then as voted). Every Friend is a vote, founders' multiplied by 1 + their share of the pool; vote on the pool share and enrollment. Spend your allowance on items for your flagged island (build timers, boost with RF); leaving takes a removal request and an epoch (~21 days), and the flag's items on your island are raffled to those who stayed. Not full in {VX.FLAG_DAYS} days? Refunds. Launch tokens to your flag.</li>
        <li><strong>Tokens:</strong> launch a token for 1,000 RF, airdrop it into Friend wallets and open a claim pool; claims cost RF, into the pool.</li>
        <li><strong>Always on-chain:</strong> every Friend is its real on-chain artwork, loaded as you get near it. Re-checked every minute (or tap Check): new Friends join, upgrades update, sold or deactivated Friends leave.</li>
        <li>This preview doesn't save: reloading starts fresh. RF, saves, docking, bridges, launches and claims are simulated.</li>
      </ul> : <>
        <div className="docks-row"><button type="button" onClick={() => setMenu("help")}>❓ How it works</button></div>
        <label><input type="checkbox" checked={reducedMotion} onChange={e => setReducedMotion(e.target.checked)} /> Reduce motion</label>
        <h3>Preview: a Friend leaves your wallet</h3>
        <p className="docks-note">See what happens when a saved Friend is sent to another wallet (which also clears its activation). Nothing is sent: this only changes the preview.</p>
        <div className="docks-row"><select aria-label="Friend to send away" value={sendId} onChange={e => setSendId(e.target.value)}>
          <option value="">Pick a Friend…</option>{allMine.filter(x => x.m.id !== friendId).slice(0, 200).map(x => <option key={String(x.m.id)} value={String(x.m.id)}>#{String(x.m.id)}{saved.has(x.m.id) ? " · saved" : " · not saved"}</option>)}</select>
          <button type="button" disabled={!sendId} onClick={() => { previewSend(BigInt(sendId)); setSendId(""); setMenu(null); }}>Send away</button></div>
        {simGone.current.size > 0 && <div className="docks-row">{[...simGone.current].map(id => <button type="button" key={String(id)} onClick={() => { previewReturn(id); setMenu(null); }}>Bring #{String(id)} back</button>)}</div>}
        <p className="docks-note">Last on-chain check: {lastCheck ? lastCheck.toLocaleTimeString() : "—"}. Wallet connection and ownership of #{String(friendId)} are verified by FriendSDK. Docks: {w.berths.size} islands on {w.cols.length} × {w.rows.length} berths.</p>
      </>}
    </GameMenu>}
  </section>;
}
