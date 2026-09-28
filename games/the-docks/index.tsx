"use client";

import { useEffect, useRef, useState } from "react";
import type { GameComponentProps } from "@rarefriends/friendsdk/runtime";
import { GameMenu } from "@rarefriends/friendsdk/frame";
import { createFriendReader, type GenerationSprites } from "@rarefriends/friendsdk/sprites";
import { readFriend, readOwner, type Friend } from "./land.js";
import { readOwnedLands } from "./roster.js";
import {
  ARRANGE_FEE, BRIDGE_FEE_PER_BERTH, RANKS, addBridge, addToPlot, autoArrange, bridgeCost, canEnter, createWorld, deploy, disconnected,
  dockAt, loadingZones, member, memberOf, moveGroup, myPlots, neighboursOf, pendingChanges, plotOf, rankOf, rebuild,
  refreshMember, removeFromPlot, swapInto, undock, weightOf, burnHole, fillHole, holesOf, feeOf,
  type Access, type Berth, type Hole, type Member, type Placed, type Plot, type World,
} from "./world.js";
import { DocksView, clampZoom, spawnOn, type CrewMember, type ViewApi } from "./view.js";
import { ChainMap } from "./chainmap.js";
import { LAUNCH_FEE, SCOPES, claimAll, createEconomy, eligibleFriends, fmt, launch, seedLaunch, type Economy, type Launch, type Scope } from "./launch.js";
import "@rarefriends/friendsdk/frame.css";
import "./style.css";

type Menu = "plot" | "docks" | "tokens" | "help" | "settings" | null;
const CHECK_EVERY_MS = 60_000;
const MAX_DRAWN = 40;                             // crew sprites drawn at once (the rest are counted)
const ART_CONCURRENCY = 6, ART_CACHE = 500;       // lazy on-chain art: parallel reads, Friends kept in memory
const PAGE = 50;

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
  // On chain (simulated in this preview): islands created on chain and their last saved layouts.
  // Islands are not tokens: the only NFTs are the activated Friends.
  const onChain = useRef<Map<string, number>>(new Map());
  const savedRef = useRef<Map<bigint, { plot: string; x: number; y: number }>>(new Map());
  const simGone = useRef<Set<bigint>>(new Set());               // preview: Friends "sent to another wallet"
  const [sendId, setSendId] = useState("");
  const [saving, setSaving] = useState(false);
  const world = useRef<World | null>(null);
  const econ = useRef<Economy>(createEconomy());
  const owner = useRef("");
  const api = useRef<ViewApi | null>(null);
  const epoch = useRef(0);
  const plotSeq = useRef(1);
  const art = useRef({ queue: [] as Member[], inflight: new Set<bigint>(), loaded: new Map<bigint, Member>(), seen: new Map<bigint, number>(), tick: 0 });
  const bump = () => setTick(x => x + 1);
  const say = (s: string) => setToast(s);

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
          const got = await Promise.allSettled(s.tokens.map(readFriend));
          const friends = autoArrange(got.flatMap(r => r.status === "fulfilled" ? [memberOf(r.value)] : []));
          return { id: s.id, name: s.name, mine: false, access: s.access, policy: s.policy, friends, berth: s.berth } as Plot;
        }));
        if (v !== epoch.current) return;
        const walker = memberOf(me);
        art.current.loaded.set(walker.id, walker);
        const home: Plot = { id: "me-1", name: "Your island", mine: true, access: "invite", friends: [{ m: walker, x: 0, y: 0 }], berth: null };
        plotSeq.current = 1;
        world.current = createWorld(samples.filter(s => s.friends.length), [home]);
        econ.current = createEconomy(); setLead(friendId); setCrewModes(new Map()); setCrewSel(new Set()); setCrewBar(false); setApprovedVisitors([]); setRequests([]); onChain.current = new Map(); savedRef.current = new Map(); simGone.current = new Set(); setIslandId("me-1");
        const market = world.current.plots.find(p => p.id === "s4" && p.friends.length);
        if (market) seedLaunch(econ.current, { name: "Market Coin", symbol: "MKT", supply: 1_000_000, creator: market, creatorFriend: market.friends[0].m.id,
          scope: "anyDocked", claimEach: 500, claimPrice: 5, claimRemaining: 50_000 });
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

  const home = () => plotOf(world.current!, friendId) ?? myPlots(world.current!)[0];
  const island = () => world.current!.plots.find(p => p.id === islandId && p.mine) ?? home();

  /** Every activated Friend in the same wallet joins your island, arranged as one connected block. */
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
        const sp = spawnOn(w, h.friends.find(p => p.m.id === friendId)!); api.current?.teleport(sp.x, sp.y);
        say(members.length > 1 ? `All ${members.length.toLocaleString()} of your activated Friends joined into one floating island. Open Docks to find a loading zone.`
          : "Your Friend is a floating island. Open Docks to find a loading zone next to the others.");
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
      if (first) say(`Couldn't list your other Friends automatically (${errText(e)}). Add them by number in My islands.`);
      return [];
    }
  }

  /** A Friend left the wallet (or was deactivated). Saved on an island: its spot burns into a hole. */
  function friendLeft(id: bigint) {
    const w = world.current!, s = savedRef.current.get(id);
    setCrewModes(c => { const n = new Map(c); n.delete(id); return n; });
    if (id === lead) setLead(friendId);
    if (s) {
      const r = burnHole(w, id); savedRef.current.delete(id);
      return r ? `#${id} left your wallet: a hole opened on ${r.plot.name}` : `#${id} left your wallet`;
    }
    removeFromPlot(w, id); return `#${id} left your wallet`;
  }
  /** A Friend arrived. If it left a hole on one of my islands, it heals that hole for free. */
  function friendArrived(m: Member) {
    const w = world.current!, found = holesOf(w).find(x => x.plot.mine && x.hole.id === m.id);
    if (found) {
      fillHole(w, found.plot, found.hole, m);
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
    if (econ.current.rf < cost) { say(`Filling this hole burns ${cost} RF; you have ${fmt(econ.current.rf)}.`); return; }
    if (!fillHole(w, p, h, pl.m)) { say("Holes can only be filled by a Friend of the same generation."); return; }
    econ.current.rf -= cost; econ.current.burned += cost;
    savedRef.current.set(id, { plot: p.id, x: h.x, y: h.y });
    bump(); say(`Hole on ${p.name} filled with #${id} (simulated)${cost ? `: ${cost} RF burned` : ": free"} + gas.`);
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
    const a = art.current, t = ++a.tick;
    for (const pl of pls) {
      a.seen.set(pl.m.id, t);
      if (!pl.m.friend && !a.inflight.has(pl.m.id) && !a.queue.includes(pl.m)) a.queue.push(pl.m);
    }
    pump();
  }
  function pump() {
    const a = art.current, v = epoch.current;
    while (a.inflight.size < ART_CONCURRENCY && a.queue.length) {
      const m = a.queue.shift()!;
      if (m.friend) continue;
      a.inflight.add(m.id);
      readFriend(m.id).then(f => {
        if (v !== epoch.current) return;
        m.friend = f; m.tier = Number(f.traits["Activation tier"] ?? m.tier); a.loaded.set(m.id, m);
        if (a.loaded.size > ART_CACHE) {                  // forget art for Friends far from the camera
          const old = [...a.loaded.values()].filter(x => x.id !== friendId).sort((x, y) => (a.seen.get(x.id) ?? 0) - (a.seen.get(y.id) ?? 0));
          for (const x of old.slice(0, a.loaded.size - ART_CACHE)) { x.friend = null; a.loaded.delete(x.id); }
        }
        if (world.current) world.current.version++;
        bump();
      }).catch(e => {
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

  /* ── the crew: call, break off, leave, take over ── */
  const setModes = (ids: Iterable<bigint>, mode: "follow" | "park" | "home") => setCrewModes(c => {
    const n = new Map(c); for (const id of ids) { if (id === lead) continue; if (mode === "home") n.delete(id); else n.set(id, mode); } return n;
  });
  function callAll() {
    const ids = myPlots(world.current!).flatMap(p => p.friends.map(x => x.m.id)).filter(id => id !== lead);
    setModes(ids, "follow");
    say(ids.length ? `#${lead} called all ${ids.length.toLocaleString()} Friends over. They're on their way${ids.length > MAX_DRAWN ? ` (${MAX_DRAWN} shown walking, the rest counted)` : ""}.` : "No other Friends to call.");
  }
  function takeOver(id: bigint) {
    if (id === lead) return;
    const old = lead;
    setCrewModes(c => { const n = new Map(c); n.delete(id); n.set(old, "park"); return n; });
    setLead(id); setCrewSel(new Set());
    say(`You're leading #${id} now. #${old} stays where it was; call it back any time.`);
  }
  function onWalkerTap(id: bigint) {
    setCrewBar(true);
    setCrewSel(s => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  }

  /* ── simulated visit requests to my islands (until real players exist) ── */
  useEffect(() => {
    const w = world.current; if (!ready || !w) return;
    const mineDocked = myPlots(w).filter(p => p.berth && p.access === "invite");
    if (!mineDocked.length) return;
    const t = window.setTimeout(() => {
      const n = mineDocked.flatMap(p => neighboursOf(w, p)).find(p => !p.mine && !requests.includes(p.id) && !approvedVisitors.includes(p.id));
      if (n) { setRequests(r => [...r, n.id]); say(`${n.name} (sample) asks to visit your island. Answer in My islands.`); }
    }, 20_000);
    return () => window.clearTimeout(t);
  }, [ready, world.current?.version, requests.length]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ── actions ── */
  function goTo(p: Plot) {
    const w = world.current!, pl = p.friends.find(x => x.m.id === lead) ?? p.friends[0];
    if (pl) { const sp = spawnOn(w, pl); api.current?.teleport(sp.x, sp.y); }
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
    deploy(w, id, target);
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
  /** Save every changed island on chain (simulated): create islands as needed, burn RF per Friend moved. */
  async function saveOnChain() {
    const w = world.current!;
    for (const p of myPlots(w)) {
      const loose = disconnected(w, p);
      if (loose.length) { setIslandId(p.id); setArranging(true); setSelected([loose[0]]); say(`Can't save yet: on ${p.name}, ${loose.length.toLocaleString()} Friend${loose.length === 1 ? " doesn't" : "s don't"} touch the rest.`); return; }
    }
    const c = pendingChanges(w, savedRef.current);
    if (!c.moved.length && !c.gone.length) { say("Nothing to save: your islands match the chain."); return; }
    if (econ.current.rf < c.rf) { say(`Saving burns ${fmt(c.rf)} RF; you have ${fmt(econ.current.rf)}.`); return; }
    setSaving(true);
    await new Promise(r => setTimeout(r, 900));               // stands in for wallet confirmation + receipt
    const minted: number[] = [];
    for (const p of myPlots(w)) if (p.friends.length && !onChain.current.has(p.id)) { const n = 1 + Math.floor(Math.random() * 900); onChain.current.set(p.id, n); minted.push(n); }
    econ.current.rf -= c.rf; econ.current.burned += c.rf;
    savedRef.current = new Map(myPlots(w).flatMap(p => p.friends.map(pl => [pl.m.id, { plot: p.id, x: pl.x, y: pl.y }] as const)));
    setSaving(false); setArranging(false); setSelected([]);
    const txs = Math.max(1, c.plots.length, Math.ceil(c.moved.length / 100));
    say(`Saved on chain (simulated)${minted.length ? `: created Island #${minted.join(", #")} on chain` : ""} · ${c.moved.length.toLocaleString()} Friend${c.moved.length === 1 ? "" : "s"} moved · ${fmt(c.rf)} RF burned · ${txs} transaction${txs === 1 ? "" : "s"} + gas.`);
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
    if (!dockAt(w, p, b)) { say("That loading zone was just taken."); return; }
    setMenu(null); goTo(p); bump();
    const n = neighboursOf(w, p).map(q => q.name);
    say(`${p.name} docked${n.length ? ` next to ${n.join(", ")}` : ""} (gas only, simulated). A gangway joins you.`);
  }
  function buildBridge(to: Plot) {
    const w = world.current!, p = island(), cost = bridgeCost(p, to);
    if (econ.current.rf < cost) { say(`That bridge burns ${cost} RF; you have ${fmt(econ.current.rf)}.`); return; }
    if (!addBridge(w, p, to)) { say("You're already connected to that island."); return; }
    econ.current.rf -= cost; econ.current.burned += cost; setMenu(null); bump();
    say(`Bridge built from ${p.name} to ${to.name} (simulated): ${cost} RF burned + gas. It lasts until either island moves.`);
  }
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
    if (host.mine) return host.access === "open" || approvedVisitors.includes(p.id);
    return host.access === "open";
  };
  function doLaunch() {
    const w = world.current!, h = home(); setLaunchError("");
    if (!onChain.current.has(h.id) || savedRef.current.get(friendId)?.plot !== h.id) { setLaunchError("Save your island on chain first (Arrange → Save): launches come from a Friend on a saved island."); return; }
    const n = (v: string) => Number(v.replace(/[,_\s]/g, "")) || 0;
    try {
      const l = launch(econ.current, w, { name: form.name, symbol: form.symbol, supply: n(form.supply), creator: h, creatorFriend: friendId,
        airdropScope: form.airdropScope, airdropEach: n(form.airdropEach), claimScope: form.claimScope, claimPool: n(form.claimPool), claimEach: n(form.claimEach), claimPrice: n(form.claimPrice) }, canVisit);
      setForm(f => ({ ...f, name: "", symbol: "" })); bump();
      say(`$${l.symbol} launched (simulated): ${LAUNCH_FEE.toLocaleString()} RF paid, ${LAUNCH_FEE / 2} burned.`);
    } catch (e) { setLaunchError(errText(e)); }
  }
  function doClaimAll(l: Launch) {
    const w = world.current!;
    const n = claimAll(econ.current, w, l, myPlots(w).flatMap(p => p.friends.map(pl => pl.m.id)), canVisit);
    bump(); say(n ? `${n.toLocaleString()} of your Friends claimed ${fmt(l.claimEach)} $${l.symbol} each (simulated) · ${fmt(n * l.claimPrice)} RF burned.` : `Nothing to claim for $${l.symbol}.`);
  }

  /* ── render ── */
  if (fatal) return <div className="docks-loading" role="alert"><div className="docks-mark">⚓</div>{fatal}
    <button type="button" onClick={() => setRetry(r => r + 1)}>Try again</button></div>;
  if (!ready || !world.current) return <div className="docks-loading" role="status"><div className="docks-mark">⚓</div>Reading Friends from chain…</div>;

  const w = world.current, mine = myPlots(w), isl = island(), h = home(), homeRank = rankOf(h);
  const allMine = mine.flatMap(p => p.friends);
  const saved = savedRef.current;
  const pending = pendingChanges(w, saved), dirty = pending.moved.length > 0 || pending.gone.length > 0;
  const uiBlocked = Boolean(menu) || paused;
  const leadSprites = lead === friendId ? sprites : crewSprites.get(lead) ?? null;
  const label = leadSprites ? `${leadSprites.familyName} #${lead}` : `Friend #${lead}`;
  const following = [...crewModes].filter(([, m]) => m === "follow").length, parked = crewModes.size - following;
  const visit = gate ? w.visits.get(gate.id) ?? "none" : "none";
  const crew: CrewMember[] = drawnCrew().map(id => ({ id, sprites: crewSprites.get(id) ?? null, mode: crewModes.get(id)! }));
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
    <DocksView world={w} version={w.version} sprites={leadSprites} walkerId={lead} offLand={offLand} zoom={zoom} paused={uiBlocked} reducedMotion={reducedMotion}
      arranging={arranging} selected={selected} crew={crew} crewSel={crewSel} onWalkerTap={onWalkerTap} apiRef={api} onVisible={onVisible} onZoom={z => setZoom(clampZoom(z))}
      onPick={pl => { const p = plotOf(w, pl.m.id); if (!p) return;
        if (pickMany && selected[0] && plotOf(w, selected[0].m.id) === p) setSelected(s => s.includes(pl) ? s.filter(x => x !== pl) : [...s, pl]);
        else { setIslandId(p.id); setSelected([pl]); } }}
      onBlocked={p => { setGate(p); if (!menu) say(`${p.name} is invite-only.`); }} onEnterPlot={p => { setHere(p); if (p && p !== gate) setGate(null); }} />

    <div className="docks-hud" inert={uiBlocked || undefined}>
      <div className="docks-card">
        <strong>{label}</strong>
        <small>{h.name}{nftOf(h) ? ` · Island #${nftOf(h)} on chain` : " · not on chain yet"}{dirty ? ` · ${pending.moved.length.toLocaleString()} unsaved move${pending.moved.length === 1 ? "" : "s"}` : nftOf(h) ? " · saved" : ""}</small>
        <small>{h.friends.length.toLocaleString()} Friend{h.friends.length === 1 ? "" : "s"} · {homeRank.rank} · weight {fmtW(homeRank.weight)}{mine.length > 1 ? ` · ${mine.length} islands` : ""}</small>
        <small>{h.berth ? `Docked · ${neighboursOf(w, h).length} connected` : "Floating free"} · {h.access === "open" ? "Open to visitors" : "Invite only"}{rosterNote ? ` · ${rosterNote}` : ""}</small>
      </div>
      <div className="docks-card docks-where">
        <small>Standing on</small><strong>{here ? (here.mine ? here.name : here.name) : "the water"}</strong>
        {here && !here.mine && <small>sample neighbour · {rankOf(here).rank}</small>}
      </div>
    </div>

    <p className="docks-toast" role="status" aria-live="polite">{toast}</p>

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
        <small>{dirty ? `${pending.moved.length.toLocaleString()} moved · burns ${fmt(pending.rf)} RF + gas` : "Matches the chain"}</small>
        <div className="docks-row tight">
          <button type="button" onClick={finishArranging}>Done</button>
          <button type="button" className="rf-frame-primary" disabled={!dirty || saving} onClick={() => void saveOnChain()}>{saving ? "Saving…" : nftOf(isl) ? "⛓ Save on chain" : "⛓ Save on chain"}</button>
        </div>
      </div>
    </div> : crewBar ? <div className="docks-crewbar" role="toolbar" aria-label="Your crew">
      <div className="docks-arrange-info"><strong>Leading #{String(lead)}</strong>
        <small>{following.toLocaleString()} with you · {parked.toLocaleString()} left around · tap Friends to pick ({crewSel.size})</small></div>
      <button type="button" className="rf-frame-primary" onClick={callAll}>📣 Call all</button>
      <button type="button" disabled={!crewSel.size} onClick={() => { setModes(crewSel, "follow"); say(`${crewSel.size} Friend${crewSel.size === 1 ? "" : "s"} walking with you.`); setCrewSel(new Set()); }}>Bring picked</button>
      <button type="button" disabled={!crewSel.size} onClick={() => { setModes(crewSel, "park"); say(`${crewSel.size} Friend${crewSel.size === 1 ? "" : "s"} left here.`); setCrewSel(new Set()); }}>Leave picked here</button>
      <button type="button" disabled={crewSel.size !== 1} onClick={() => takeOver([...crewSel][0])}>Take over</button>
      <button type="button" disabled={!following} onClick={() => { setModes([...crewModes].filter(([, m]) => m === "follow").map(([id]) => id), "park"); say("Your crew waits here."); }}>Everyone wait</button>
      <button type="button" disabled={!crewModes.size} onClick={() => { setModes([...crewModes.keys()], "home"); setCrewSel(new Set()); say("Everyone went back to their own land."); }}>All go home</button>
      <button type="button" onClick={() => { setCrewBar(false); setCrewSel(new Set()); }}>Done</button>
    </div> : <div className="docks-bar" inert={uiBlocked || undefined}>
      {gate && !canEnter(w, gate) ? <button type="button" className="docks-act ready" disabled={visit === "pending"} onClick={() => askToVisit(gate)}>
        {visit === "pending" ? `Waiting for ${gate.name}…` : visit === "declined" ? `${gate.name} declined · ask again` : `Ask to visit ${gate.name}`}</button>
        : dirty ? <div className="docks-row tight docks-unsaved">
          <button type="button" className="docks-act" disabled={saving} onClick={() => void saveOnChain()}>{saving ? "Saving…" : `⛓ ${[...pending.plots].some(p => !nftOf(p)) ? "Save" : "Save"} · ${pending.moved.length.toLocaleString()} moved · ${fmt(pending.rf)} RF`}</button>
          {saved.size > 0 && <button type="button" onClick={discardChanges}>Undo</button>}</div>
        : <span className="docks-hint">WASD / arrows or tap to walk · gangways (⇄) join docked islands</span>}
      <div className="docks-nav">
        <button type="button" className="docks-arrange-btn" onClick={startArranging} disabled={uiBlocked}>✥<span>Arrange</span></button>
        <button type="button" onClick={() => setCrewBar(true)} disabled={uiBlocked}>👥<span>Crew</span></button>
        <button type="button" onClick={() => { setPage(1); setMenu("plot"); }} disabled={uiBlocked}>🏝<span>Islands</span></button>
        <button type="button" onClick={() => setMenu("docks")} disabled={uiBlocked}>⚓<span>Docks</span></button>
        <button type="button" onClick={() => setMenu("tokens")} disabled={uiBlocked}>🚀<span>Tokens</span></button>
        <button type="button" onClick={() => void checkChain(true)} disabled={uiBlocked || checking}>{checking ? "⏳" : "🔄"}<span>Check</span></button>
        <button type="button" onClick={() => setZoom(z => clampZoom(z * 1.4))} disabled={uiBlocked} aria-label="Zoom in">＋</button>
        <button type="button" onClick={() => setZoom(z => clampZoom(z / 1.4))} disabled={uiBlocked} aria-label="Zoom out">－</button>
        <button type="button" onClick={() => api.current?.fitAll()} disabled={uiBlocked} aria-label="Fit all islands">⤢</button>
        <button type="button" onClick={() => api.current?.recenter()} disabled={uiBlocked} aria-label="Center on lead">⌖</button>
        <button type="button" onClick={() => setMenu("settings")} disabled={uiBlocked}>⚙️<span>More</span></button>
      </div>
    </div>}

    {menu && <GameMenu onClose={() => setMenu(null)} title={menu === "plot" ? "My islands" : menu === "docks" ? "The Docks" : menu === "tokens" ? "Tokens" : menu === "help" ? "How it works" : "Settings"}>
      {menu === "plot" ? <>
        <p>Every activated Friend is a small floating island; joined together they make one big island. Every activated Friend in your wallet is here automatically, exactly as it renders on chain. Keep them together, or deploy them to other islands. Islands belong to your wallet and can't be sold: the only NFTs are your Friends.</p>
        {islandTabs}
        <div className="docks-item"><span><strong>{isl.name} · {isl.friends.length.toLocaleString()} Friends · {rankOf(isl).rank}</strong>
          <small>Reward weight {fmtW(rankOf(isl).weight)}{rankOf(isl).next ? ` · ${fmtW(rankOf(isl).next)} to ${RANKS[rankOf(isl).index + 1].name}` : ""}{byGen.length ? ` · ${byGen.map(([g, n]) => `${n.toLocaleString()}× Gen ${g}`).join(" · ")}` : ""}</small>
          {rosterNote && <small>{rosterNote}{roster.error ? `: ${roster.error}` : ""}</small>}</span></div>
        <div className="docks-item"><span><strong>⛓ {nftOf(isl) ? `Island #${nftOf(isl)} · saved on chain to your wallet` : "Not on chain yet"}</strong>
          <small>{dirty ? `${pending.moved.length.toLocaleString()} Friend${pending.moved.length === 1 ? "" : "s"} moved since the last save · saving burns ${fmt(pending.rf)} RF + gas` : "Your islands match the chain."}</small>
          <small>Saving burns RF for each Friend whose spot on its island changed: {Object.entries(ARRANGE_FEE).map(([g, f]) => `Gen ${g} ${f}`).join(" · ")} RF. Docking and moving islands cost only gas.<span className="docks-sim">SIMULATED</span></small></span>
          <button type="button" className="rf-frame-primary" disabled={!dirty || saving} onClick={() => { setMenu(null); void saveOnChain(); }}>Save</button></div>
        <div className="docks-row">
          <button type="button" onClick={startArranging} disabled={!isl.friends.length}>✥ Arrange</button>
          {isl.friends.length > 1 && <button type="button" onClick={reArrange}>▦ Auto-arrange</button>}
          <button type="button" aria-pressed={isl.access === "open"} onClick={() => { isl.access = isl.access === "open" ? "invite" : "open"; w.version++; bump(); }}>
            {isl.access === "open" ? "🔓 Open to visitors" : "🔒 Invite only"}</button>
          <button type="button" onClick={newIsland}>＋ New island</button>
        </div>
        {requests.length > 0 && <><h3>Visit requests</h3>{requests.map(id => { const p = w.plots.find(q => q.id === id); if (!p) return null;
          return <div className="docks-item" key={id}><span><strong>{p.name}</strong><small>sample neighbour · simulated request</small></span>
            <span className="docks-row tight"><button type="button" onClick={() => { setRequests(r => r.filter(x => x !== id)); setApprovedVisitors(a => [...a, id]); say(`You let ${p.name} in.`); }}>Approve</button>
              <button type="button" onClick={() => { setRequests(r => r.filter(x => x !== id)); say(`You declined ${p.name}.`); }}>Decline</button></span></div>; })}</>}
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
                {id !== lead && <button type="button" onClick={() => { setMenu(null); takeOver(id); }}>Lead</button>}</span>
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
        <p>{isl.berth ? `${isl.name} is docked${neighboursOf(w, isl).length ? ` next to ${neighboursOf(w, isl).map(p => p.name).join(", ")}` : ""}. Pick another loading zone to move it, or build a bridge.` : `${isl.name} is floating free. Pick a loading zone next to another island to dock.`} Every island takes one berth, whatever its size, so the docks grow with the number of islands. Docking and moving cost only gas.</p>
        <ChainMap world={w} island={isl} zones={zones} onDock={dockIsland} onBridge={buildBridge} />
        {isl.berth && <div className="docks-row"><button type="button" onClick={() => { undock(w, isl); setMenu(null); goTo(isl); bump(); say(`${isl.name} is floating free.`); }}>Undock</button>
          <span className="docks-note">Bridges burn {BRIDGE_FEE_PER_BERTH} RF per berth of distance and last until either island moves.</span></div>}
        <h3>Everyone here</h3>
        {[...w.plots].filter(p => p.friends.length).sort((a, b) => rankOf(b).weight - rankOf(a).weight).map((p, i) => { const r = rankOf(p);
          return <div className="docks-item" key={p.id}><span><strong>{i + 1}. {p.name}{p.mine ? " (yours)" : ""} · {r.rank}</strong>
            <small>{p.friends.length.toLocaleString()} Friend{p.friends.length === 1 ? "" : "s"} · weight {fmtW(r.weight)} · {p.berth ? `berth ${p.berth.x},${p.berth.y}` : "floating"}{p.mine ? "" : ` · ${p.access === "open" ? "open" : "invite only"} · sample`}</small></span>
            <button type="button" onClick={() => { setMenu(null);
              if (canEnter(w, p)) { goTo(p); say(p.mine ? `On ${p.name}.` : `You and your crew walked over to ${p.name}.`); }
              else { const b = w.box.get(p); if (b) api.current?.focusOn((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2); say(`${p.name} is invite-only: here's the view. Walk up its gangway and ask to visit.`); } }}>{canEnter(w, p) ? "Go" : "Look"}</button></div>; })}
        <p className="docks-note">Rank follows the official Rare Friends reward weight (Generation × Activation tier), summed over an island's Friends. Neighbours are other people's public Friends shown as samples; their answers to visit requests are simulated.</p>
      </> : menu === "tokens" ? <>
        <div className="docks-rf"><span>Your RF <b>{fmt(econ.current.rf)}</b><span className="docks-sim">SIMULATED</span></span><span>Burned <b>{fmt(econ.current.burned)}</b></span><span>Treasury <b>{fmt(econ.current.treasury)}</b></span></div>
        <p className="docks-note">Launch a token from your island for {LAUNCH_FEE.toLocaleString()} RF (half burned, half to the treasury). Airdrops and claims land in each Friend's own wallet; every claim costs RF, which is burned. In this preview it's all simulated; the contracts are in the submission.</p>
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
          <label>Claim price (RF, burned)<input inputMode="numeric" value={form.claimPrice} onChange={e => setForm({ ...form, claimPrice: e.target.value })} /></label>
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
        <li><strong>Arranging is the game:</strong> Arrange → tap a Friend and move it, or <em>Pick several</em> / <em>All</em> to move a group together; each Friend must touch another along part of a side. Save on chain burns RF for every Friend whose spot changed ({Object.entries(ARRANGE_FEE).map(([g, f]) => `Gen ${g}: ${f}`).join(", ")}), plus gas. Unmoved Friends are free; Undo returns to your last save.</li>
        <li><strong>Dock:</strong> Docks → pick a loading zone next to another island. Every island takes one berth whatever its size, so how far you can roam depends on how many islands there are. Docking and moving cost only gas. Neighbours are joined by a gangway.</li>
        <li><strong>Bridges:</strong> can't dock next to an island? Build a bridge to it: {BRIDGE_FEE_PER_BERTH} RF per berth of distance, burned. It lasts until either island moves.</li>
        <li><strong>Visit:</strong> open islands (⇄) let you walk straight in. Invite-only islands (🔒) need approval: walk up the gangway and choose Ask to visit.</li>
        <li><strong>Your crew:</strong> you lead one Friend; everyone else stands on their own land. 👥 Crew → <em>Call all</em> brings every Friend to your lead. Tap Friends on the map to pick them, then <em>Bring picked</em>, <em>Leave picked here</em> (break off and walk on without them) or <em>Take over</em> to lead that Friend instead. <em>All go home</em> sends everyone back to their land.</li>
        <li><strong>Tokens:</strong> launch a token for 1,000 RF, airdrop it into Friend wallets and open a claim pool; claims burn RF.</li>
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
