"use client";

import { useEffect, useRef, useState } from "react";
import type { GameComponentProps } from "@rarefriends/friendsdk/runtime";
import { GameMenu } from "@rarefriends/friendsdk/frame";
import { createFriendReader, type GenerationSprites } from "@rarefriends/friendsdk/sprites";
import { readFriend, readOwner, type Friend } from "./land.js";
import { readOwnedLands } from "./roster.js";
import {
  CELL, RANKS, addToPlot, autoArrange, canEnter, communityBounds, createWorld, disconnected, dock, dockSlots, member, memberOf, mine,
  moveGroup, neighboursOf, swapInto, pendingChanges, feeOf, ARRANGE_FEE, placeAdrift, plotBounds, rankOf, rebuild, refreshMember, removeFromPlot, undock, weightOf,
  type Access, type Member, type Placed, type Plot, type Slot, type World,
} from "./world.js";
import { DocksView, spawnOn, type CrewMember, type ViewApi } from "./view.js";
import { ChainMap } from "./chainmap.js";
import { LAUNCH_FEE, SCOPES, claimAll, createEconomy, eligibleFriends, fmt, launch, seedLaunch, type Economy, type Launch, type Scope } from "./launch.js";
import "@rarefriends/friendsdk/frame.css";
import "./style.css";

type Menu = "plot" | "docks" | "tokens" | "help" | "settings" | null;
const CHECK_EVERY_MS = 60_000;
const MAX_FOLLOWING = 24;                         // sprites walking behind you at once
const ART_CONCURRENCY = 6, ART_CACHE = 500;       // lazy on-chain art: parallel reads, Friends kept in memory
const PAGE = 50;

/* Sample neighbours: other people's public, activated Friends, read live from chain and
 * clearly labelled. Their access answers are simulated until a shared world exists. */
const SAMPLE_PLOTS: { id: string; name: string; tokens: bigint[]; access: Access; policy?: "approve" | "decline" }[] = [
  { id: "s1", name: "Reading Row", tokens: [7153n], access: "open" },
  { id: "s2", name: "Rooftop Pair", tokens: [7174n, 7843n], access: "invite", policy: "approve" },
  { id: "s3", name: "Crystal Keep", tokens: [7096n], access: "invite", policy: "decline" },
  { id: "s4", name: "Market Cluster", tokens: [7333n, 7834n], access: "open" },
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
  const [arranging, setArranging] = useState(false), [selected, setSelected] = useState<Placed | null>(null), [moveAll, setMoveAll] = useState(false);
  const [here, setHere] = useState<Plot | null>(null);
  const [gate, setGate] = useState<Plot | null>(null);
  const [roster, setRoster] = useState<{ state: "loading" | "done" | "error"; done: number; total: number; error?: string }>({ state: "loading", done: 0, total: 0 });
  const [following, setFollowing] = useState<bigint[]>([]);
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
  // On chain (simulated in this preview): the plot NFT and the last saved arrangement.
  const [plotNft, setPlotNft] = useState<number | null>(null);
  const [saved, setSaved] = useState<Map<bigint, { x: number; y: number }>>(new Map());
  const [saving, setSaving] = useState(false);
  const world = useRef<World | null>(null);
  const econ = useRef<Economy>(createEconomy());
  const owner = useRef("");
  const api = useRef<ViewApi | null>(null);
  const epoch = useRef(0);
  const art = useRef({ queue: [] as Member[], inflight: new Set<bigint>(), loaded: new Map<bigint, Member>(), seen: new Map<bigint, number>(), tick: 0 });
  const bump = () => setTick(x => x + 1);
  const say = (s: string) => setToast(s);

  /* ── session start: my Friend, sample neighbours, then all my Friends automatically ── */
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
          return { id: s.id, name: s.name, mine: false, access: s.access, policy: s.policy, friends, docked: false } as Plot;
        }));
        if (v !== epoch.current) return;
        const walker = memberOf(me);
        art.current.loaded.set(walker.id, walker);
        const myPlot: Plot = { id: "me", name: "Your plot", mine: true, access: "invite", friends: [{ m: walker, x: 0, y: 0 }], docked: false };
        world.current = createWorld(samples.filter(s => s.friends.length), myPlot);
        econ.current = createEconomy(); setFollowing([]); setApprovedVisitors([]); setRequests([]); setPlotNft(null); setSaved(new Map());
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

  /** Every activated Friend in the same wallet joins the plot, arranged as one connected block. */
  async function loadRoster(v: number, first: boolean): Promise<string[]> {
    const w = world.current; if (!w) return [];
    setRoster(r => ({ ...r, state: "loading", done: 0, total: 0 }));
    try {
      const lands = await readOwnedLands(owner.current, (done, total) => { if (v === epoch.current) setRoster({ state: "loading", done, total }); });
      if (v !== epoch.current || !world.current) return [];
      const me = mine(w), have = new Map(me.friends.map(pl => [pl.m.id, pl]));
      const held = new Map(lands.map(l => [l.id, l]));
      const walkerPl = have.get(friendId);
      if (!held.has(friendId) && walkerPl) held.set(friendId, { id: friendId, gen: walkerPl.m.gen, tier: walkerPl.m.tier });
      const changes: string[] = [];
      if (first) {
        const members = [...held.values()].map(l => have.get(l.id)?.m ?? member(l.id, l.gen, l.tier));
        me.friends = autoArrange(members);
        placeAdrift(w);
        const walker = me.friends.find(p => p.m.id === friendId)!;
        const sp = spawnOn(walker); api.current?.teleport(sp.x, sp.y);
        setFollowing(members.filter(m => m.id !== friendId).slice(0, 8).map(m => m.id));
        say(members.length > 1 ? `All ${members.length.toLocaleString()} of your activated Friends are here, arranged as one plot. Open Docks to dock it.`
          : "Your Friend is here. Open Docks to dock beside the others.");
      } else {
        for (const id of have.keys()) if (!held.has(id)) { removeFromPlot(w, id); changes.push(`#${id} left your wallet or was deactivated`); }
        for (const l of held.values()) {
          const pl = have.get(l.id);
          if (!pl) { addToPlot(w, member(l.id, l.gen, l.tier)); changes.push(`#${l.id} joined your plot`); }
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
      if (first) say(`Couldn't list your other Friends automatically (${errText(e)}). Add them by number in My plot.`);
      return [];
    }
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
          const w = world.current;
          for (const p of w.plots) if (p.friends.some(pl => pl.m === m)) { p.friends = p.friends.filter(pl => pl.m !== m); rebuild(w); }
          say(`#${m.id} was deactivated and left the docks.`); bump();
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
      // art signatures for Friends currently loaded (mine and neighbours'): catches art changes
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
            for (const p of w.plots) if (p.friends.some(pl => pl.m === m)) { p.friends = p.friends.filter(pl => pl.m !== m); rebuild(w); }
            art.current.loaded.delete(m.id); changes.push(`#${m.id} was deactivated and left the docks`);
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

  /* ── crew sprites (only for the Friends walking behind you) ── */
  useEffect(() => {
    for (const id of following) if (!crewSprites.has(id)) {
      void createFriendReader().read(id).then(s => setCrewSprites(m => new Map(m).set(id, s))).catch(() => {});
    }
  }, [following]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ── simulated visit requests to my plot (until real players exist) ── */
  useEffect(() => {
    const w = world.current; if (!ready || !w) return;
    const me = mine(w);
    if (!me.docked || me.access === "open") return;
    const t = window.setTimeout(() => {
      const n = neighboursOf(w, me).find(p => !requests.includes(p.id) && !approvedVisitors.includes(p.id));
      if (n) { setRequests(r => [...r, n.id]); say(`${n.name} (sample) asks to visit your plot. Answer in My plot.`); }
    }, 20_000);
    return () => window.clearTimeout(t);
  }, [ready, world.current?.version, requests.length]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ── actions ── */
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
    if (w.plots.some(p => p.friends.some(pl => pl.m.id === id))) { setAddError(`Friend #${id} is already in the docks.`); return; }
    setAdding(true);
    try {
      const o = await readOwner(id);
      if (o !== owner.current) { setAddError(`Friend #${id} isn't held by the same wallet as #${friendId}.`); return; }
      const f = await readFriend(id);
      const m = memberOf(f); art.current.loaded.set(id, m);
      addToPlot(w, m);
      setAddId(""); bump(); say(`Friend #${id} joined your plot (G${m.gen} T${m.tier}).`);
    } catch (e) { setAddError(errText(e)); }
    finally { setAdding(false); }
  }
  function startArranging() {
    const me = mine(world.current!);
    setMenu(null); setArranging(true); setMoveAll(me.friends.length <= 1);
    setSelected(me.friends.find(p => p.m.id === friendId) ?? me.friends[0] ?? null);
    say("Tap any of your Friends to pick it, or choose All together. Each Friend must touch another along a side.");
  }
  function nudge(dx: number, dy: number) {
    const w = world.current; if (!w || !arranging) return;
    const me = mine(w);
    const ok = moveAll ? moveGroup(w, me.friends, dx, dy)
      : selected ? moveGroup(w, [selected], dx, dy) || swapInto(w, selected, selected.m.cw * dx, selected.m.ch * dy) : false;
    if (!ok) say(moveAll ? "Your plot would overlap another plot there." : "That spot overlaps a different-size Friend. Move that one first, or swap with a same-size neighbour.");
    bump();
  }
  /** After a rearrange, a docked plot that no longer touches anyone slides to the nearest spot where it does. */
  function keepDocked(w: World): string {
    const me = mine(w);
    if (!me.docked || neighboursOf(w, me).length) return "";
    const slot = dockSlots(w, me).sort((a, b) => Math.abs(a.dx) + Math.abs(a.dy) - Math.abs(b.dx) - Math.abs(b.dy))[0];
    if (slot) { dock(w, slot); return " It slid to the nearest spot to stay docked."; }
    undock(w); return " It no longer touches anyone, so it's adrift: dock it again from Docks.";
  }
  function reArrange() {
    const w = world.current!, me = mine(w), b = plotBounds(me);
    const placed = autoArrange(me.friends.map(p => p.m));
    for (const p of placed) { p.x += b.x0; p.y += b.y0; }
    me.friends = placed; rebuild(w);
    const note = keepDocked(w);
    setSelected(me.friends.find(p => p.m.id === friendId) ?? null);
    bump(); say(`Auto-arranged into one connected block.${note}`);
  }
  function finishArranging() {
    const w = world.current!; const me = mine(w);
    const loose = disconnected(w, me);
    if (loose.length) {
      setMoveAll(false); setSelected(loose[0]);
      say(`${loose.length.toLocaleString()} Friend${loose.length === 1 ? " doesn't" : "s don't"} touch the rest (#${loose[0].m.id} selected). Every Friend must touch another along part of a side, or tap Auto-arrange.`);
      return;
    }
    setArranging(false); setSelected(null);
    const note = keepDocked(w); if (note) say(`Arranged.${note}`);
    const walker = me.friends.find(p => p.m.id === friendId) ?? me.friends[0];
    if (walker) { const s = spawnOn(walker); api.current?.teleport(s.x, s.y); }
    bump();
  }
  /** Save the arrangement on chain (simulated): mint the plot NFT if needed, then burn RF for every Friend moved. */
  async function saveOnChain() {
    const w = world.current!, me = mine(w);
    const loose = disconnected(w, me);
    if (loose.length) { setArranging(true); setMoveAll(false); setSelected(loose[0]); say(`Can't save yet: ${loose.length.toLocaleString()} Friend${loose.length === 1 ? " doesn't" : "s don't"} touch the rest. Every Friend must touch another along part of a side.`); return; }
    const c = pendingChanges(me, saved);
    if (!c.moved.length && !c.gone.length) { say("Nothing to save: your plot matches the chain."); return; }
    if (econ.current.rf < c.rf) { say(`Saving burns ${fmt(c.rf)} RF; you have ${fmt(econ.current.rf)}.`); return; }
    setSaving(true);
    await new Promise(r => setTimeout(r, 900));               // stands in for wallet confirmation + receipt
    let nft = plotNft;
    if (nft === null) { nft = 1 + Math.floor(Math.random() * 900); setPlotNft(nft); }
    econ.current.rf -= c.rf; econ.current.burned += c.rf;
    setSaved(new Map(me.friends.map(pl => [pl.m.id, { x: pl.x, y: pl.y }])));
    setSaving(false); setArranging(false); setSelected(null);
    const txs = Math.max(1, Math.ceil(c.moved.length / 100));
    say(`Saved on chain (simulated): Plot #${nft} · ${c.moved.length.toLocaleString()} Friend${c.moved.length === 1 ? "" : "s"} moved · ${fmt(c.rf)} RF burned · ${txs} transaction${txs === 1 ? "" : "s"} + gas.`);
  }
  function discardChanges() {
    const w = world.current!, me = mine(w);
    if (!saved.size) { reArrange(); return; }
    for (const pl of me.friends) { const s = saved.get(pl.m.id); if (s) { pl.x = s.x; pl.y = s.y; } }
    rebuild(w);
    const off = me.friends.filter(pl => !saved.has(pl.m.id));
    for (const pl of off) { me.friends = me.friends.filter(p => p !== pl); rebuild(w); addToPlot(w, pl.m); }
    const walker = me.friends.find(p => p.m.id === friendId) ?? me.friends[0];
    if (walker) { const sp = spawnOn(walker); api.current?.teleport(sp.x, sp.y); }
    setArranging(false); setSelected(null); bump(); say("Back to your saved arrangement.");
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
    const w = world.current!, me = mine(w); setLaunchError("");
    if (plotNft === null || !saved.has(friendId)) { setLaunchError("Save your plot on chain first (Arrange → Save): launches come from a Friend on a saved plot."); return; }
    const n = (v: string) => Number(v.replace(/[,_\s]/g, "")) || 0;
    try {
      const l = launch(econ.current, w, { name: form.name, symbol: form.symbol, supply: n(form.supply), creator: me, creatorFriend: friendId,
        airdropScope: form.airdropScope, airdropEach: n(form.airdropEach), claimScope: form.claimScope, claimPool: n(form.claimPool), claimEach: n(form.claimEach), claimPrice: n(form.claimPrice) }, canVisit);
      setForm(f => ({ ...f, name: "", symbol: "" })); bump();
      say(`$${l.symbol} launched (simulated): ${LAUNCH_FEE.toLocaleString()} RF paid, ${LAUNCH_FEE / 2} burned.`);
    } catch (e) { setLaunchError(errText(e)); }
  }
  function doClaimAll(l: Launch) {
    const me = mine(world.current!);
    const n = claimAll(econ.current, world.current!, l, me.friends.map(p => p.m.id), canVisit);
    bump(); say(n ? `${n.toLocaleString()} of your Friends claimed ${fmt(l.claimEach)} $${l.symbol} each (simulated) · ${fmt(n * l.claimPrice)} RF burned.` : `Nothing to claim for $${l.symbol}.`);
  }

  /* ── render ── */
  if (fatal) return <div className="docks-loading" role="alert"><div className="docks-mark">⚓</div>{fatal}
    <button type="button" onClick={() => setRetry(r => r + 1)}>Try again</button></div>;
  if (!ready || !world.current) return <div className="docks-loading" role="status"><div className="docks-mark">⚓</div>Reading Friends from chain…</div>;

  const w = world.current, me = mine(w), myRank = rankOf(me);
  const pending = pendingChanges(me, saved), dirty = pending.moved.length > 0 || pending.gone.length > 0;
  const uiBlocked = Boolean(menu) || paused;
  const label = sprites ? `${sprites.familyName} #${friendId}` : `Friend #${friendId}`;
  const visit = gate ? w.visits.get(gate.id) ?? "none" : "none";
  const crew: CrewMember[] = following.filter(id => me.friends.some(p => p.m.id === id)).map(id => ({ id, sprites: crewSprites.get(id) ?? null }));
  const byGen = [1, 2, 3, 4, 5, 6].map(g => [g, me.friends.filter(p => p.m.gen === g).length] as const).filter(([, n]) => n);
  const rosterNote = roster.state === "loading" ? (roster.total ? `finding your Friends ${roster.done.toLocaleString()} / ${roster.total.toLocaleString()}` : "finding your Friends…")
    : roster.state === "error" ? "couldn't list your Friends" : "";

  return <section className="docks" aria-label={definition.name}>
    <DocksView world={w} version={w.version} sprites={sprites} walkerId={friendId} zoom={zoom} paused={uiBlocked} reducedMotion={reducedMotion}
      arranging={arranging} selected={selected} moveAll={moveAll} crew={crew} apiRef={api} onVisible={onVisible}
      onPick={pl => { setMoveAll(false); setSelected(pl); }}
      onBlocked={p => { setGate(p); if (!menu) say(`${p.name} is invite-only.`); }} onEnterPlot={p => { setHere(p); if (p && p !== gate) setGate(null); }} />

    <div className="docks-hud" inert={uiBlocked || undefined}>
      <div className="docks-card">
        <strong>{label}</strong>
        <small>{plotNft === null ? "Plot not on chain yet" : `Plot #${plotNft} (NFT)`}{pending.moved.length || pending.gone.length ? ` · ${pending.moved.length.toLocaleString()} unsaved move${pending.moved.length === 1 ? "" : "s"}` : plotNft !== null ? " · saved" : ""}</small>
        <small>Your plot: {me.friends.length.toLocaleString()} Friend{me.friends.length === 1 ? "" : "s"} · {myRank.rank} · weight {fmtW(myRank.weight)}</small>
        <small>{me.docked ? `Docked beside ${neighboursOf(w, me).length}` : "Adrift"} · {me.access === "open" ? "Open to visitors" : "Invite only"}{rosterNote ? ` · ${rosterNote}` : ""}</small>
      </div>
      <div className="docks-card docks-where">
        <small>Standing on</small><strong>{here ? (here.mine ? "Your plot" : here.name) : "—"}</strong>
        {here && !here.mine && <small>sample neighbour · {rankOf(here).rank}</small>}
      </div>
    </div>

    <p className="docks-toast" role="status" aria-live="polite">{toast}</p>

    {arranging ? <div className="docks-arrange" role="toolbar" aria-label="Arrange your Friends">
      <div className="docks-arrange-info"><strong>{moveAll ? `Moving all ${me.friends.length.toLocaleString()}` : selected ? `Moving #${selected.m.id}` : "Tap a Friend"}</strong>
        <small>Tap your Friends on the map to pick one</small></div>
      <div className="docks-pad">
        <button type="button" aria-label="Move up-left" onClick={() => nudge(-1, 0)}>↖</button>
        <button type="button" aria-label="Move up-right" onClick={() => nudge(0, -1)}>↗</button>
        <button type="button" aria-label="Move down-left" onClick={() => nudge(0, 1)}>↙</button>
        <button type="button" aria-label="Move down-right" onClick={() => nudge(1, 0)}>↘</button>
      </div>
      <div className="docks-chips">
        {me.friends.length > 1 && <button type="button" aria-pressed={moveAll} onClick={() => setMoveAll(v => !v)}>All together</button>}
        {me.friends.length > 1 && <button type="button" onClick={reArrange}>Auto-arrange</button>}
      </div>
      <div className="docks-save">
        <small>{dirty ? `${pending.moved.length.toLocaleString()} moved · burns ${fmt(pending.rf)} RF + gas` : "Matches the chain"}</small>
        <div className="docks-row tight">
          <button type="button" onClick={finishArranging}>Done</button>
          <button type="button" className="rf-frame-primary" disabled={!dirty || saving} onClick={() => void saveOnChain()}>{saving ? "Saving…" : plotNft === null ? "⛓ Mint plot + save" : "⛓ Save on chain"}</button>
        </div>
      </div>
    </div> : <div className="docks-bar" inert={uiBlocked || undefined}>
      {gate && !canEnter(w, gate) ? <button type="button" className="docks-act ready" disabled={visit === "pending"} onClick={() => askToVisit(gate)}>
        {visit === "pending" ? `Waiting for ${gate.name}…` : visit === "declined" ? `${gate.name} declined · ask again` : `Ask to visit ${gate.name}`}</button>
        : dirty ? <div className="docks-row tight docks-unsaved">
          <button type="button" className="docks-act" disabled={saving} onClick={() => void saveOnChain()}>{saving ? "Saving…" : `⛓ ${plotNft === null ? "Mint plot + save" : "Save"} · ${pending.moved.length.toLocaleString()} moved · ${fmt(pending.rf)} RF`}</button>
          {saved.size > 0 && <button type="button" onClick={discardChanges}>Undo</button>}</div>
        : <span className="docks-hint">WASD / arrows or tap to walk · seams (⇄) connect plots</span>}
      <div className="docks-nav">
        <button type="button" className="docks-arrange-btn" onClick={startArranging} disabled={uiBlocked}>✥<span>Arrange</span></button>
        <button type="button" onClick={() => { setPage(1); setMenu("plot"); }} disabled={uiBlocked}>🏡<span>My plot</span></button>
        <button type="button" onClick={() => setMenu("docks")} disabled={uiBlocked}>⚓<span>Docks</span></button>
        <button type="button" onClick={() => setMenu("tokens")} disabled={uiBlocked}>🚀<span>Tokens</span></button>
        <button type="button" onClick={() => void checkChain(true)} disabled={uiBlocked || checking}>{checking ? "⏳" : "🔄"}<span>Check</span></button>
        <button type="button" onClick={() => setZoom(z => Math.min(4, +(z + 0.4).toFixed(1)))} disabled={uiBlocked} aria-label="Zoom in">＋</button>
        <button type="button" onClick={() => setZoom(z => Math.max(0.2, +(z > 0.6 ? z - 0.4 : z - 0.1).toFixed(1)))} disabled={uiBlocked} aria-label="Zoom out">－</button>
        <button type="button" onClick={() => setMenu("settings")} disabled={uiBlocked}>⚙️<span>More</span></button>
      </div>
    </div>}

    {menu && <GameMenu onClose={() => setMenu(null)} title={menu === "plot" ? "My plot" : menu === "docks" ? "The Docks" : menu === "tokens" ? "Tokens" : menu === "help" ? "How it works" : "Settings"}>
      {menu === "plot" ? <>
        <p>Every activated Friend in your wallet is here automatically, exactly as it renders on chain, arranged as one plot. Each Friend is its own wallet, so your plot is your crew: pick who walks behind you. Arrange them however you like; every Friend just needs to touch another along part of a side.</p>
        <div className="docks-item"><span><strong>{me.friends.length.toLocaleString()} Friends · {myRank.rank}</strong>
          <small>Total reward weight {fmtW(myRank.weight)}{myRank.next ? ` · ${fmtW(myRank.next)} to ${RANKS[myRank.index + 1].name}` : ""} · {byGen.map(([g, n]) => `${n.toLocaleString()}× Gen ${g}`).join(" · ")}</small>
          {rosterNote && <small>{rosterNote}{roster.error ? `: ${roster.error}` : ""}</small>}</span></div>
        <div className="docks-item"><span><strong>⛓ {plotNft === null ? "Not on chain yet" : `Plot #${plotNft} · an NFT you own`}</strong>
          <small>{dirty ? `${pending.moved.length.toLocaleString()} Friend${pending.moved.length === 1 ? "" : "s"} moved since the last save · saving burns ${fmt(pending.rf)} RF + gas` : "Your arrangement matches the chain."}</small>
          <small>Saving burns RF for each Friend whose spot changed: {Object.entries(ARRANGE_FEE).map(([g, f]) => `Gen ${g} ${f}`).join(" · ")} RF. Unmoved Friends are free.<span className="docks-sim">SIMULATED</span></small></span>
          <button type="button" className="rf-frame-primary" disabled={!dirty || saving} onClick={() => { setMenu(null); void saveOnChain(); }}>{plotNft === null ? "Mint + save" : "Save"}</button></div>
        <div className="docks-row">
          <button type="button" onClick={startArranging}>✥ Arrange</button>
          {me.friends.length > 1 && <button type="button" onClick={reArrange}>▦ Auto-arrange</button>}
          <button type="button" aria-pressed={me.access === "open"} onClick={() => { me.access = me.access === "open" ? "invite" : "open"; w.version++; bump(); }}>
            {me.access === "open" ? "🔓 Open to visitors" : "🔒 Invite only"}</button>
        </div>
        {requests.length > 0 && <><h3>Visit requests</h3>{requests.map(id => { const p = w.plots.find(q => q.id === id); if (!p) return null;
          return <div className="docks-item" key={id}><span><strong>{p.name}</strong><small>sample neighbour · simulated request</small></span>
            <span className="docks-row tight"><button type="button" onClick={() => { setRequests(r => r.filter(x => x !== id)); setApprovedVisitors(a => [...a, id]); say(`You let ${p.name} in.`); }}>Approve</button>
              <button type="button" onClick={() => { setRequests(r => r.filter(x => x !== id)); say(`You declined ${p.name}.`); }}>Decline</button></span></div>; })}</>}
        <h3>Your Friends <small className="docks-note">· {crew.length} walking with you (up to {MAX_FOLLOWING})</small></h3>
        <div className="docks-list">
          {me.friends.slice(0, page * PAGE).map(p => { const id = p.m.id, f: Friend | null = p.m.friend, walking = following.includes(id);
            return <div className="docks-friend" key={String(id)}>
              <div className="crop">{f ? <img src={f.art} alt={`Friend #${id} on-chain artwork`} loading="lazy" /> : <span className="docks-note">#{String(id)}</span>}</div>
              <span><strong>#{String(id)}{id === friendId ? " · you" : ""}</strong>
                <small>Gen {p.m.gen} · Tier {p.m.tier}{f ? ` · ${f.traits.Scenery}` : ""} · weight {fmtW(weightOf(p.m))}</small></span>
              {id !== friendId && <button type="button" aria-pressed={walking} onClick={() => {
                if (!walking && following.length >= MAX_FOLLOWING) { say(`Up to ${MAX_FOLLOWING} Friends can walk with you at once.`); return; }
                setFollowing(fl => walking ? fl.filter(x => x !== id) : [...fl, id]);
              }}>{walking ? "Walking with you" : "Stays on plot"}</button>}
            </div>; })}
          {me.friends.length > page * PAGE && <div className="docks-row"><button type="button" onClick={() => setPage(n => n + 1)}>Show {Math.min(PAGE, me.friends.length - page * PAGE)} more of {(me.friends.length - page * PAGE).toLocaleString()}</button></div>}
        </div>
        <div className="docks-add">
          <label htmlFor="add-id">Missing one? Add by number</label>
          <div className="docks-row"><input id="add-id" inputMode="numeric" placeholder="Friend number, e.g. 1234" value={addId} onChange={e => setAddId(e.target.value)} onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); void addFriend(); } }} disabled={adding} />
            <button type="button" className="rf-frame-primary" disabled={adding || !addId.trim()} onClick={() => void addFriend()}>{adding ? "Checking…" : "Add"}</button></div>
          {addError && <p role="alert" className="docks-note">{addError}</p>}
          <p className="docks-note">Friends are found from your wallet's on-chain history and re-checked every minute. It must be held by the same wallet as #{String(friendId)} and be activated.</p>
        </div>
      </> : menu === "docks" ? <>
        <p>{me.docked ? `Docked beside ${neighboursOf(w, me).map(p => p.name).join(", ") || "the community"}. The seams where plots touch are the walkways.` : "Your plot is adrift. Pick a glowing spot to dock edge to edge with the others."}</p>
        <ChainMap world={w} slots={me.docked ? [] : dockSlots(w, me)} onPick={(s: Slot) => {
          dock(w, s); const pl = me.friends.find(p => p.m.id === friendId) ?? me.friends[0]; if (pl) { const sp = spawnOn(pl); api.current?.teleport(sp.x, sp.y); }
          setMenu(null); bump(); say(`Docked beside ${neighboursOf(w, me).map(p => p.name).join(", ")}. Save on chain to make it official.`);
        }} />
        {me.docked && <button type="button" onClick={() => { undock(w); const pl = me.friends.find(p => p.m.id === friendId) ?? me.friends[0]; if (pl) { const sp = spawnOn(pl); api.current?.teleport(sp.x, sp.y); } bump(); }}>Undock and move</button>}
        <h3>Everyone here</h3>
        {[...w.plots].filter(p => p.friends.length).sort((a, b) => rankOf(b).weight - rankOf(a).weight).map((p, i) => { const r = rankOf(p);
          return <div className="docks-item" key={p.id}><span><strong>{i + 1}. {p.mine ? "You" : p.name} · {r.rank}</strong>
            <small>{p.friends.length.toLocaleString()} Friend{p.friends.length === 1 ? "" : "s"} · weight {fmtW(r.weight)}{p.mine ? "" : ` · ${p.access === "open" ? "open" : "invite only"} · sample`}</small></span>
            <button type="button" onClick={() => { const pl = p.friends[0]; setMenu(null);
              if (canEnter(w, p) && (p.docked || p.mine)) { const sp = spawnOn(pl); api.current?.teleport(sp.x, sp.y); say(p.mine ? "Back home." : `You and your crew walked over to ${p.name}.`); }
              else { api.current?.focusOn((pl.x + pl.m.cw / 2) * CELL, (pl.y + pl.m.ch / 2) * CELL); say(`${p.name} is invite-only: here's the view. Walk up to its seam and ask to visit.`); } }}>{canEnter(w, p) ? "Go" : "Look"}</button></div>; })}
        <p className="docks-note">Rank follows the official Rare Friends reward weight (Generation × Activation tier), summed over a plot's Friends. Neighbours are other people's public Friends shown as samples; their answers to visit requests are simulated.</p>
      </> : menu === "tokens" ? <>
        <div className="docks-rf"><span>Your RF <b>{fmt(econ.current.rf)}</b><span className="docks-sim">SIMULATED</span></span><span>Burned <b>{fmt(econ.current.burned)}</b></span><span>Treasury <b>{fmt(econ.current.treasury)}</b></span></div>
        <p className="docks-note">Launch a token from your plot for {LAUNCH_FEE.toLocaleString()} RF (half burned, half to the treasury). Airdrops and claims land in each Friend's own wallet; every claim costs RF, which is burned. In this preview it's all simulated; the contracts are in the submission.</p>
        <h3>Launch a token</h3>
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
        <p className="docks-note">{form.airdropScope === "none" ? "No airdrop." : `Airdrop reaches ${eligibleFriends(w, { scope: form.airdropScope, creator: me }, canVisit).length.toLocaleString()} Friend wallet(s) right now (${SCOPES.find(x => x.id === form.airdropScope)!.hint}).`} The rest of the supply goes to #{String(friendId)}'s wallet.</p>
        {launchError && <p role="alert" className="docks-note">{launchError}</p>}
        <div className="docks-row"><button type="button" className="rf-frame-primary" disabled={!me.docked} onClick={doLaunch}>🚀 Launch for {LAUNCH_FEE.toLocaleString()} RF</button>
          {!me.docked && <span className="docks-note">Dock your plot first.</span>}</div>
        <h3>Tokens on the docks</h3>
        {econ.current.launches.length === 0 && <p className="docks-note">None yet.</p>}
        {[...econ.current.launches].reverse().map(l => {
          const mineIds = new Set(me.friends.map(p => p.m.id));
          const can = eligibleFriends(w, l, canVisit).filter(x => mineIds.has(x.id) && !l.claimed.has(x.id)).length;
          const n = Math.min(can, l.claimEach ? Math.floor(l.claimRemaining / l.claimEach) : 0, l.claimPrice ? Math.floor(econ.current.rf / l.claimPrice) : can);
          const claimedAny = [...mineIds].some(id => l.claimed.has(id));
          return <div className="docks-token" key={l.id}><strong>${l.symbol} · {l.name}</strong>
            <small>by {l.creator.mine ? "you" : `${l.creator.name} (sample)`} · supply {fmt(l.supply)} · claim {fmt(l.claimEach)} for {l.claimPrice} RF · {fmt(l.claimRemaining)} left · {SCOPES.find(x => x.id === l.scope)!.label}</small>
            <div className="docks-row"><button type="button" disabled={n < 1} onClick={() => doClaimAll(l)}>
              {n < 1 ? (claimedAny ? "Claimed ✓" : "Not eligible") : `Claim for ${n.toLocaleString()} Friend${n === 1 ? "" : "s"} · ${fmt(n * l.claimPrice)} RF`}</button></div></div>; })}
        <h3>Your Friends' wallets</h3>
        {(() => { const totals = new Map<string, { sum: number; holders: number }>();
          for (const p of me.friends) for (const [sym, a] of econ.current.wallets.get(p.m.id) ?? []) { const t = totals.get(sym) ?? { sum: 0, holders: 0 }; t.sum += a; t.holders++; totals.set(sym, t); }
          return totals.size ? [...totals].map(([sym, t]) => <div className="docks-item" key={sym}><span><strong>{fmt(t.sum)} ${sym}</strong><small>across {t.holders.toLocaleString()} Friend wallet{t.holders === 1 ? "" : "s"}</small></span></div>)
            : <p className="docks-note">Empty so far.</p>; })()}
      </> : menu === "help" ? <ul className="docks-help">
        <li><strong>Walk:</strong> WASD / arrows, or tap where to go.</li>
        <li><strong>Arranging is the game:</strong> your plot is an NFT. Move Friends freely as a draft, then Save on chain: every Friend whose spot changed burns RF ({Object.entries(ARRANGE_FEE).map(([g, f]) => `Gen ${g}: ${f}`).join(", ")}), plus gas. Unmoved Friends are free; Undo returns to your last save.</li>
        <li><strong>Your plot:</strong> every activated Friend in your wallet appears automatically as one connected plot, from 1 to 10,000+. Arrange lets you tap any Friend and move it (or All together); each Friend must touch another along part of a side. Auto-arrange packs them into a tidy block.</li>
        <li><strong>Dock:</strong> Docks → pick a spot. Your plot joins edge to edge; the seam is the walkway.</li>
        <li><strong>Visit:</strong> open plots (⇄) let you walk straight in. Invite-only plots (🔒) need approval: walk to the seam and choose Ask to visit.</li>
        <li><strong>Your crew:</strong> pick up to {MAX_FOLLOWING} Friends to walk behind you in My plot.</li>
        <li><strong>Tokens:</strong> launch a token for 1,000 RF, airdrop it into Friend wallets and open a claim pool; claims burn RF. Simulated in this preview.</li>
        <li><strong>Always on-chain:</strong> every Friend is its real on-chain artwork, loaded as you get near it. The game re-checks the chain every minute (or tap Check): new Friends join, upgrades update, sold or deactivated Friends leave.</li>
        <li>This preview doesn't save: reloading starts fresh. RF balances, launches and claims are simulated.</li>
      </ul> : <>
        <div className="docks-row"><button type="button" onClick={() => setMenu("help")}>❓ How it works</button></div>
        <label><input type="checkbox" checked={reducedMotion} onChange={e => setReducedMotion(e.target.checked)} /> Reduce motion</label>
        <p className="docks-note">Last on-chain check: {lastCheck ? lastCheck.toLocaleTimeString() : "—"}. Wallet connection and ownership of #{String(friendId)} are verified by FriendSDK. Docks: {(() => { const b = communityBounds(w); return Number.isFinite(b.x0) ? `${(b.x1 - b.x0) * CELL} × ${(b.y1 - b.y0) * CELL} tiles` : "—"; })()}.</p>
      </>}
    </GameMenu>}
  </section>;
}
