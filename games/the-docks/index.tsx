"use client";

import { useEffect, useRef, useState } from "react";
import type { GameComponentProps } from "@rarefriends/friendsdk/runtime";
import { GameMenu } from "@rarefriends/friendsdk/frame";
import { createFriendReader, type GenerationSprites } from "@rarefriends/friendsdk/sprites";
import { readFriend, readOwner, rewardWeight, type Friend } from "./land.js";
import {
  RANKS, addToPlot, canEnter, communityBounds, createWorld, dock, dockSlots, mine, moveFriend, neighboursOf,
  rankOf, rebuild, removeFromPlot, replaceFriend, undock, type Access, type Placed, type Plot, type Slot, type World,
} from "./world.js";
import { DocksView, spawnOn, type ViewApi } from "./view.js";
import { ChainMap } from "./chainmap.js";
import "@rarefriends/friendsdk/frame.css";
import "./style.css";

type Menu = "plot" | "docks" | "help" | "settings" | null;
const CHECK_EVERY_MS = 60_000;

/* Sample neighbours: other people's public, activated Friends, read live from chain and
 * clearly labelled. Their access answers are simulated until a shared server exists. */
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
  const [arranging, setArranging] = useState<Placed | null>(null);
  const [here, setHere] = useState<Plot | null>(null);
  const [gate, setGate] = useState<Plot | null>(null);
  const [addId, setAddId] = useState(""), [adding, setAdding] = useState(false), [addError, setAddError] = useState("");
  const [checking, setChecking] = useState(false), [lastCheck, setLastCheck] = useState<Date | null>(null);
  const [requests, setRequests] = useState<string[]>([]);
  const [retry, setRetry] = useState(0);
  const world = useRef<World | null>(null);
  const owner = useRef("");
  const api = useRef<ViewApi | null>(null);
  const epoch = useRef(0);
  const bump = () => setTick(x => x + 1);
  const say = (s: string) => setToast(s);

  /* ── session start: SDK read, my Friend, sample neighbours ── */
  useEffect(() => {
    const v = ++epoch.current;
    setReady(false); setFatal(""); setMenu(null); setArranging(null); setSprites(null); world.current = null;
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
          const friends = got.flatMap(r => r.status === "fulfilled" ? [r.value] : []);
          let x = 0; const placed = friends.map(f => { const p = { friend: f, x, y: 0 }; x += f.w; return p; });
          return { id: s.id, name: s.name, mine: false, access: s.access, policy: s.policy, friends: placed, docked: false } as Plot;
        }));
        if (v !== epoch.current) return;
        const myPlot: Plot = { id: "me", name: "Your plot", mine: true, access: "invite", friends: [{ friend: me, x: 0, y: 0 }], docked: false };
        world.current = createWorld(samples.filter(s => s.friends.length), myPlot);
        setReady(true); say("Your Friend is here. Open Docks to dock beside the others.");
        setLastCheck(new Date());
      } catch (e) {
        if (v !== epoch.current) return;
        const inactive = (e as { inactive?: boolean }).inactive;
        setFatal(inactive ? `${errText(e)} Reactivate it on Rare Friends to bring its land into The Docks.` : `Couldn't read your Friend from chain: ${errText(e)}`);
      }
    })();
    return () => { epoch.current++; pref.removeEventListener("change", upd); };
  }, [client, friendId, retry]);

  /* ── on-chain checks: upgrades, deactivation, transfers ── */
  async function checkChain(manual = false) {
    const w = world.current; if (!w || checking) return;
    setChecking(true);
    const changes: string[] = [];
    try {
      for (const plot of [...w.plots]) for (const pl of [...plot.friends]) {
        const id = pl.friend.tokenId;
        try {
          if (plot.mine && id !== friendId) {
            const o = await readOwner(id);
            if (o !== owner.current) { removeFromPlot(w, id); changes.push(`#${id} left your wallet and was removed`); continue; }
          }
          const fresh = await readFriend(id);
          if (fresh.signature !== pl.friend.signature) {
            const before = `G${pl.friend.traits.Generation} T${pl.friend.traits["Activation tier"]}`, after = `G${fresh.traits.Generation} T${fresh.traits["Activation tier"]}`;
            if (replaceFriend(w, fresh)) changes.push(`#${id} updated${before !== after ? ` (${before} → ${after})` : ""}`);
            else { changes.push(`#${id} grew and needs a new spot`); if (plot.mine) { removeFromPlot(w, id); addToPlot(w, fresh); } }
          }
        } catch (e) {
          if ((e as { inactive?: boolean }).inactive) {
            if (plot.mine && id === friendId) { changes.push(`#${id} was deactivated`); continue; }
            plot.friends = plot.friends.filter(p => p !== pl); rebuild(w); changes.push(`#${id} was deactivated and left the docks`);
          }
        }
      }
    } finally {
      setChecking(false); setLastCheck(new Date()); bump();
      if (changes.length) say(`On-chain check: ${changes.join(" · ")}`); else if (manual) say("On-chain check: everything matches the chain.");
    }
  }
  useEffect(() => {
    if (!ready) return;
    const id = window.setInterval(() => { if (!document.hidden) void checkChain(); }, CHECK_EVERY_MS);
    return () => window.clearInterval(id);
  }); // eslint-disable-line react-hooks/exhaustive-deps

  /* ── simulated visit requests to my plot (until real players exist) ── */
  useEffect(() => {
    const w = world.current; if (!ready || !w) return;
    const me = mine(w);
    if (!me.docked || me.access === "open") return;
    const t = window.setTimeout(() => {
      const n = neighboursOf(w, me).find(p => !requests.includes(p.id));
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
    if (w.plots.some(p => p.friends.some(pl => pl.friend.tokenId === id))) { setAddError(`Friend #${id} is already in the docks.`); return; }
    setAdding(true);
    try {
      const o = await readOwner(id);
      if (o !== owner.current) { setAddError(`Friend #${id} isn't held by the same wallet as #${friendId}.`); return; }
      const f = await readFriend(id);
      addToPlot(w, f);
      setAddId(""); bump(); say(`Friend #${id} joined your plot (G${f.traits.Generation} T${f.traits["Activation tier"]}). Use Arrange to move it.`);
    } catch (e) { setAddError(errText(e)); }
    finally { setAdding(false); }
  }
  function nudge(dx: number, dy: number) {
    const w = world.current; if (!w || !arranging) return;
    if (!moveFriend(w, arranging, dx, dy)) say("That spot overlaps another Friend.");
    bump();
  }
  // arrange with arrow keys
  useEffect(() => {
    if (!arranging) return;
    const k = (e: KeyboardEvent) => {
      const m: Record<string, [number, number]> = { arrowup: [-2, 0], w: [-2, 0], arrowright: [0, -2], d: [0, -2], arrowdown: [2, 0], s: [2, 0], arrowleft: [0, 2], a: [0, 2] };
      const d = m[e.key.toLowerCase()]; if (d && !menu) { e.preventDefault(); nudge(d[0], d[1]); }
      if (e.key === "Escape" || e.key === "Enter") finishArranging();
    };
    window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k);
  });
  function finishArranging() {
    const w = world.current!; const me = mine(w);
    setArranging(null);
    // after rearranging, keep the plot where it is if it still fits; otherwise it drifts and can re-dock
    if (me.docked && dockSlots(w, me).length === 0 && !neighboursOf(w, me).length) undock(w);
    const walker = me.friends.find(p => p.friend.tokenId === friendId) ?? me.friends[0];
    if (walker) { const s = spawnOn(w, walker); api.current?.teleport(s.x, s.y); }
    bump();
  }

  /* ── render ── */
  if (fatal) return <div className="docks-loading" role="alert"><div className="docks-mark">⚓</div>{fatal}
    <button type="button" onClick={() => setRetry(r => r + 1)}>Try again</button></div>;
  if (!ready || !world.current) return <div className="docks-loading" role="status"><div className="docks-mark">⚓</div>Reading Friends from chain…</div>;

  const w = world.current, me = mine(w), myRank = rankOf(me);
  const uiBlocked = Boolean(menu) || paused;
  const walker = me.friends.find(p => p.friend.tokenId === friendId);
  const label = sprites ? `${sprites.familyName} #${friendId}` : `Friend #${friendId}`;
  const visit = gate ? w.visits.get(gate.id) ?? "none" : "none";

  return <section className="docks" aria-label={definition.name}>
    <DocksView world={w} version={w.version} sprites={sprites} walkerId={friendId} zoom={zoom} paused={uiBlocked} reducedMotion={reducedMotion}
      selected={arranging} apiRef={api} onBlocked={p => { setGate(p); if (!menu) say(`${p.name} is invite-only.`); }} onEnterPlot={p => { setHere(p); if (p && p !== gate) setGate(null); }} />

    <div className="docks-hud" inert={uiBlocked || undefined}>
      <div className="docks-card">
        <strong>{label}</strong>
        <small>Your plot: {me.friends.length} Friend{me.friends.length === 1 ? "" : "s"} · {myRank.rank} · weight {fmtW(myRank.weight)}</small>
        <small>{me.docked ? `Docked beside ${neighboursOf(w, me).length}` : "Adrift"} · {me.access === "open" ? "Open to visitors" : "Invite only"}</small>
      </div>
      <div className="docks-card docks-where">
        <small>Standing on</small><strong>{here ? (here.mine ? "Your plot" : here.name) : "—"}</strong>
        {here && !here.mine && <small>sample neighbour · {rankOf(here).rank}</small>}
      </div>
    </div>

    <p className="docks-toast" role="status" aria-live="polite">{toast}</p>

    {arranging ? <div className="docks-arrange" role="toolbar" aria-label="Arrange your Friends">
      <div className="docks-chips">{me.friends.map(p => <button type="button" key={String(p.friend.tokenId)} aria-pressed={p === arranging} onClick={() => setArranging(p)}>#{String(p.friend.tokenId)}</button>)}</div>
      <div className="docks-pad">
        <button type="button" aria-label="Move up-left" onClick={() => nudge(-2, 0)}>↖</button>
        <button type="button" aria-label="Move up-right" onClick={() => nudge(0, -2)}>↗</button>
        <button type="button" aria-label="Move down-left" onClick={() => nudge(0, 2)}>↙</button>
        <button type="button" aria-label="Move down-right" onClick={() => nudge(2, 0)}>↘</button>
      </div>
      <button type="button" className="rf-frame-primary" onClick={finishArranging}>Done</button>
    </div> : <div className="docks-bar" inert={uiBlocked || undefined}>
      {gate && !canEnter(w, gate) ? <button type="button" className="docks-act ready" disabled={visit === "pending"} onClick={() => askToVisit(gate)}>
        {visit === "pending" ? `Waiting for ${gate.name}…` : visit === "declined" ? `${gate.name} declined · ask again` : `Ask to visit ${gate.name}`}</button>
        : <span className="docks-hint">WASD / arrows or tap to walk · seams (⇄) connect plots</span>}
      <div className="docks-nav">
        <button type="button" onClick={() => setMenu("plot")} disabled={uiBlocked}>🏡<span>My plot</span></button>
        <button type="button" onClick={() => setMenu("docks")} disabled={uiBlocked}>⚓<span>Docks</span></button>
        <button type="button" onClick={() => void checkChain(true)} disabled={uiBlocked || checking}>{checking ? "⏳" : "🔄"}<span>Check</span></button>
        <button type="button" onClick={() => setZoom(z => Math.min(4, +(z + 0.4).toFixed(1)))} disabled={uiBlocked} aria-label="Zoom in">＋</button>
        <button type="button" onClick={() => setZoom(z => Math.max(0.6, +(z - 0.4).toFixed(1)))} disabled={uiBlocked} aria-label="Zoom out">－</button>
        <button type="button" onClick={() => setMenu("settings")} disabled={uiBlocked}>⚙️<span>More</span></button>
      </div>
    </div>}

    {menu && <GameMenu onClose={() => setMenu(null)} title={menu === "plot" ? "My plot" : menu === "docks" ? "The Docks" : menu === "help" ? "How it works" : "Settings"}>
      {menu === "plot" ? <>
        <p>Your plot is your activated Friends, side by side, exactly as they render on chain. Add as many as you hold and arrange them however you like; gaps are fine.</p>
        <div className="docks-item"><span><strong>Rank: {myRank.rank}</strong><small>Total reward weight {fmtW(myRank.weight)}{myRank.next ? ` · ${fmtW(myRank.next)} to ${RANKS[myRank.index + 1].name}` : ""}</small></span></div>
        {me.friends.map(p => <div className="docks-friend" key={String(p.friend.tokenId)}>
          <div className="crop"><img src={p.friend.art} alt={`Friend #${p.friend.tokenId} on-chain artwork`} /></div>
          <span><strong>#{String(p.friend.tokenId)}{p.friend.tokenId === friendId ? " · walking" : ""}</strong>
            <small>Gen {p.friend.traits.Generation} · Tier {p.friend.traits["Activation tier"]} · {p.friend.traits.Scenery} · weight {fmtW(rewardWeight(p.friend))}</small></span>
          {p.friend.tokenId !== friendId && <button type="button" onClick={() => { removeFromPlot(w, p.friend.tokenId); bump(); }}>Remove</button>}
        </div>)}
        <div className="docks-add">
          <label htmlFor="add-id">Add another activated Friend you hold</label>
          <div className="docks-row"><input id="add-id" inputMode="numeric" placeholder="Friend number, e.g. 1234" value={addId} onChange={e => setAddId(e.target.value)} onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); void addFriend(); } }} disabled={adding} />
            <button type="button" className="rf-frame-primary" disabled={adding || !addId.trim()} onClick={() => void addFriend()}>{adding ? "Checking…" : "Add"}</button></div>
          {addError && <p role="alert" className="docks-note">{addError}</p>}
          <p className="docks-note">Checked on chain: it must be held by the same wallet as #{String(friendId)} and be activated.</p>
        </div>
        <div className="docks-row">
          <button type="button" disabled={me.friends.length < 1} onClick={() => { setMenu(null); setArranging(me.friends[me.friends.length - 1]); }}>✥ Arrange Friends</button>
          <button type="button" aria-pressed={me.access === "open"} onClick={() => { me.access = me.access === "open" ? "invite" : "open"; w.version++; bump(); }}>
            {me.access === "open" ? "🔓 Open to visitors" : "🔒 Invite only"}</button>
        </div>
        {requests.length > 0 && <><h3>Visit requests</h3>{requests.map(id => { const p = w.plots.find(q => q.id === id); if (!p) return null;
          return <div className="docks-item" key={id}><span><strong>{p.name}</strong><small>sample neighbour · simulated request</small></span>
            <span className="docks-row tight"><button type="button" onClick={() => { setRequests(r => r.filter(x => x !== id)); say(`You let ${p.name} in.`); }}>Approve</button>
              <button type="button" onClick={() => { setRequests(r => r.filter(x => x !== id)); say(`You declined ${p.name}.`); }}>Decline</button></span></div>; })}</>}
      </> : menu === "docks" ? <>
        <p>{me.docked ? `Docked beside ${neighboursOf(w, me).map(p => p.name).join(", ") || "the community"}. The seams where plots touch are the walkways.` : "Your plot is adrift. Pick a glowing spot to dock edge to edge with the others."}</p>
        <ChainMap world={w} slots={me.docked ? [] : dockSlots(w, me)} onPick={(s: Slot) => {
          dock(w, s); const pl = walker ?? me.friends[0]; if (pl) { const sp = spawnOn(w, pl); api.current?.teleport(sp.x, sp.y); }
          setMenu(null); bump(); say(`Docked! You now share seams with ${neighboursOf(w, me).map(p => p.name).join(", ")}.`);
        }} />
        {me.docked && <button type="button" onClick={() => { undock(w); const pl = walker ?? me.friends[0]; if (pl) { const sp = spawnOn(w, pl); api.current?.teleport(sp.x, sp.y); } bump(); }}>Undock and move</button>}
        <h3>Everyone here</h3>
        {[...w.plots].filter(p => p.friends.length).sort((a, b) => rankOf(b).weight - rankOf(a).weight).map((p, i) => { const r = rankOf(p);
          return <div className="docks-item" key={p.id}><span><strong>{i + 1}. {p.mine ? "You" : p.name} · {r.rank}</strong>
            <small>{p.friends.map(f => `#${f.friend.tokenId}`).join(" ")} · weight {fmtW(r.weight)}{p.mine ? "" : ` · ${p.access === "open" ? "open" : "invite only"} · sample`}</small></span></div>; })}
        <p className="docks-note">Rank follows the official Rare Friends reward weight (Generation × Activation tier), summed over a plot's Friends. Neighbours are other people's public Friends shown as samples; their answers to visit requests are simulated.</p>
      </> : menu === "help" ? <ul className="docks-help">
        <li><strong>Walk:</strong> WASD / arrows, or tap where to go.</li>
        <li><strong>Dock:</strong> Docks → pick a spot. Your plot joins edge to edge; the seam is the walkway.</li>
        <li><strong>Visit:</strong> open plots (⇄) let you walk straight in. Invite-only plots (🔒) need approval: walk to the seam and choose Ask to visit.</li>
        <li><strong>Your plot:</strong> add any activated Friends you hold and arrange them (↖ ↗ ↙ ↘ or arrow keys). Gaps are fine.</li>
        <li><strong>Always on-chain:</strong> every Friend is its real on-chain artwork. The game re-checks the chain every minute (or tap Check): upgrades update the art and rank, deactivated or transferred Friends leave.</li>
        <li>This preview doesn't save: reloading starts fresh.</li>
      </ul> : <>
        <div className="docks-row"><button type="button" onClick={() => setMenu("help")}>❓ How it works</button></div>
        <label><input type="checkbox" checked={reducedMotion} onChange={e => setReducedMotion(e.target.checked)} /> Reduce motion</label>
        <p className="docks-note">Last on-chain check: {lastCheck ? lastCheck.toLocaleTimeString() : "—"}. Wallet connection and ownership of #{String(friendId)} are verified by FriendSDK. Bounds: {(() => { const b = communityBounds(w); return `${b.x1 - b.x0} × ${b.y1 - b.y0} tiles`; })()}.</p>
      </>}
    </GameMenu>}
  </section>;
}
