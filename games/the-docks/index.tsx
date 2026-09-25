"use client";

import { useEffect, useRef, useState } from "react";
import type { GameComponentProps } from "@rarefriends/friendsdk/runtime";
import { GameMenu } from "@rarefriends/friendsdk/frame";
import { formatGameAmount } from "@rarefriends/friendsdk/ui";
import { maximumPrize, type GamePlay, type GameSnapshot } from "@rarefriends/friendsdk/game";
import { createFriendReader, type GenerationSprites } from "@rarefriends/friendsdk/sprites";
import { createFriendSoundKit, type FriendSoundCue, type FriendSoundKit } from "@rarefriends/friendsdk/sounds";
import { createEngine, type Engine } from "./engine.js";
import { ChainMap } from "./chainmap.js";
import { readChainLand, sampleLand, type Land } from "./land.js";
import {
  ADJ_BONUS, BURN_SHARE_DOCK, BURN_SHARE_PURCHASE, CREDITS_PER_RF, ITEMS, MARKET_FEE, STATUS_TIERS,
  attach, attachSlots, buyCredits, buyFromStall, createWorld, gainXp, landOrigin, setLand, statusOf, touching,
  sellProduce, spotLabel, step, useSpot, xpForLevel, you, type ItemId, type Slot, type Spot, type World,
} from "./model.js";
import "@rarefriends/friendsdk/frame.css";
import "./style.css";

type Menu = "home" | "reveal" | "stall" | "market" | "bag" | "map" | "settings" | "help" | null;
const rf = (v: bigint) => `${formatGameAmount(v, 18)} RF`;
const CHARM_ICON = ["🍀", "🌙", "⭐"];
const CHARM_XP = [0.1, 0.2, 0.5];
const TREAT = [{ snack: "Kibble Crumble", boost: 20 }, { snack: "Berry Moon Tart", boost: 35 }, { snack: "Golden Honeycake", boost: 60 }];
const CREDIT_PACKS = [{ credits: 500, label: "$4.99" }, { credits: 1200, label: "$9.99" }];
const KIBBLE_COOLDOWN = 30_000;

export default function TheDocks({ friendId, client, paused }: GameComponentProps) {
  const definition = client.definition;
  const [snapshot, setSnapshot] = useState<GameSnapshot | null>(null);
  const [sprites, setSprites] = useState<GenerationSprites | null>(null);
  const [spriteError, setSpriteError] = useState(false);
  const [webglError, setWebglError] = useState(false);
  const [menu, setMenu] = useState<Menu>(null);
  const [stallPlot, setStallPlot] = useState<string>("you");
  const [near, setNear] = useState<Spot | null>(null);
  const [result, setResult] = useState<GamePlay | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [toast, setToast] = useState("Walk with WASD / arrows or tap the ground.");
  const [muted, setMuted] = useState(true), [reducedMotion, setReducedMotion] = useState(false);
  const [, setTick] = useState(0);
  const fallbackLand = () => sampleLand(Number(friendId % 100000n) + 7, "Garden", "Plain", 6, 5);
  const world = useRef<World>(createWorld(friendId, fallbackLand()));
  const [landState, setLandState] = useState<"loading" | "chain" | "failed">("loading");
  const [landError, setLandError] = useState("");
  const engine = useRef<Engine | null>(null);
  const stage = useRef<HTMLDivElement>(null);
  const sound = useRef<FriendSoundKit | null>(null), locked = useRef(false), epoch = useRef(0), acc = useRef(0), level = useRef(1), tier = useRef(-1);
  const inventory = snapshot?.inventory ?? [0n, 0n, 0n];
  const uiBlocked = Boolean(menu) || paused;

  /* session reset per verified Friend */
  useEffect(() => {
    const version = ++epoch.current;
    world.current = createWorld(friendId, fallbackLand()); level.current = 1;
    setLandState("loading"); setLandError("");
    sound.current = createFriendSoundKit({ muted: true });
    setSnapshot(null); setMenu(null); setResult(null); setError(""); setBusy(false); setMuted(true); setSprites(null); setSpriteError(false);
    locked.current = false;
    void client.read().then(v => { if (version === epoch.current) setSnapshot(v); })
      .catch(c => { if (version === epoch.current) setError(c instanceof Error ? c.message : "Could not load the preview."); });
    loadSprites(version);
    importLand(version);
    const pref = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReducedMotion(pref.matches); update(); pref.addEventListener("change", update);
    return () => { epoch.current++; sound.current?.dispose(); sound.current = null; pref.removeEventListener("change", update); };
  }, [client, friendId]); // eslint-disable-line react-hooks/exhaustive-deps

  function importLand(version = epoch.current) {
    setLandState("loading"); setLandError("");
    void readChainLand(friendId).then((land: Land) => {
      if (version !== epoch.current) return;
      setLand(world.current, land); engine.current?.rebuild(true);
      setLandState("chain"); setToast("Your Friend's on-chain land has been imported.");
    }).catch(cause => {
      if (version !== epoch.current) return;
      setToast("Couldn't read your on-chain land, so a stand-in is shown. Retry from Home."); setLandState("failed"); setLandError(cause instanceof Error ? cause.message.split("\n")[0] : "Could not read your land.");
    });
  }

  function loadSprites(version = epoch.current) {
    setSpriteError(false);
    void createFriendReader().read(friendId).then(s => { if (version === epoch.current) setSprites(s); })
      .catch(() => { if (version === epoch.current) setSpriteError(true); });
  }

  /* 3D engine lifecycle */
  const ready = snapshot !== null && landState !== "loading";
  useEffect(() => {
    if (!ready || !stage.current) return;
    let e: Engine;
    try {
      e = createEngine(stage.current, world.current, {
        onNear: s => setNear(s),
        onTapSpot: s => activateRef.current(s),
        onTick: dt => {
          step(world.current, dt);
          acc.current += dt;
          if (acc.current > 0.25) {
            acc.current = 0;
            const w = world.current;
            if (w.log.length) setToast(w.log.splice(0).at(0)!);
            if (w.level > level.current) { level.current = w.level; setToast(`Level up! Dock rep ${w.level}.`); cue("reveal-rare"); }
            const st = statusOf(w, you(w));
            if (st.tier !== tier.current) {
              const up = st.tier > tier.current; tier.current = st.tier; engine.current?.rebuild();
              if (up) { setToast(`Status up: ${st.name}! Your flag grows.`); cue("reveal-legendary"); }
            }
            setTick(x => x + 1);
          }
        },
      });
    } catch { setWebglError(true); return; }
    engine.current = e;
    return () => { e.dispose(); engine.current = null; };
  }, [ready, friendId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { engine.current?.setSprites(sprites); }, [sprites, ready]);
  useEffect(() => { engine.current?.setPaused(uiBlocked); }, [uiBlocked, ready]);
  useEffect(() => { engine.current?.setReducedMotion(reducedMotion); }, [reducedMotion, ready]);
  useEffect(() => { world.current.charmBoost = inventory.reduce((s, n, i) => s + Number(n) * (CHARM_XP[i] ?? 0), 0); }, [inventory]);

  const cue = (c: FriendSoundCue) => { sound.current?.play(c); };
  const say = (text: string, c: FriendSoundCue = "select") => { if (text) { setToast(text); cue(c); } setTick(x => x + 1); };

  const activateRef = useRef<(s: Spot | null) => void>(() => {});
  activateRef.current = activate;
  function activate(s: Spot | null) {
    if (!s || paused || menu) return;
    void sound.current?.unlock();
    const w = world.current;
    if (s.kind === "sign") { setMenu("map"); return; }
    if (s.kind === "stall") { setStallPlot(s.plot.id); setMenu("stall"); return; }
    say(useSpot(w, s), s.plot.owner === "you" ? "select" : "reward");
  }

  /* E / Enter to interact; shortcuts for menus */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (menu || paused || e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === "e") { e.preventDefault(); activate(engine.current?.near ?? null); }
      else if (k === "m") setMenu("market"); else if (k === "b") setMenu("bag"); else if (k === "h") setMenu("home");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  async function act(work: () => Promise<void>, sfx?: FriendSoundCue, after?: () => void) {
    if (locked.current || paused) return;
    const version = epoch.current; locked.current = true; setBusy(true); setError(""); void sound.current?.unlock();
    try { await work(); const v = await client.read(); if (version === epoch.current) { setSnapshot(v); if (sfx) cue(sfx); after?.(); } }
    catch (c) { if (version === epoch.current) setError(c instanceof Error ? c.message : "The preview action failed."); }
    finally { if (version === epoch.current) { locked.current = false; setBusy(false); } }
  }

  if (!snapshot || landState === "loading") return <div className="docks-loading" role={error ? "alert" : "status"}>
    <div className="docks-boat" aria-hidden="true">⛵</div>{error || (landState === "loading" && snapshot ? "Importing your Friend's land from chain…" : "Sailing into the harbor…")}
    {error && <button type="button" disabled={busy || paused} onClick={() => void act(async () => {})}>Retry</button>}
  </div>;
  if (snapshot.friendId !== friendId) return <p role="alert">This game session does not match the selected Friend.</p>;

  const w = world.current, me = you(w);
  const maxPrize = maximumPrize(definition);
  const canBuy = snapshot.rfBalance >= definition.price && snapshot.freeStake >= maxPrize && snapshot.freeStake + definition.price >= maxPrize;
  const pending = snapshot.plays.find(p => p.outcomeId === null);
  const outcome = result?.outcomeId ? definition.outcomes[result.outcomeId - 1] : null;
  const neighbours = touching(w, me);
  const status = statusOf(w, me);
  const label = sprites ? `${sprites.familyName} #${friendId}` : `Friend #${friendId}`;
  const kibbleWait = Math.max(0, Math.ceil((w.pet.kibbleAt - Date.now()) / 1000));
  const stall = w.plots.find(p => p.id === stallPlot) ?? me;
  const openBag = () => act(async () => {
    const version = epoch.current;
    const played = pending ?? (await client.play(1n))[0];
    const settled = await client.settle(played.id);
    if (version === epoch.current && settled.outcomeId) {
      const fx = TREAT[settled.outcomeId - 1];
      w.pet.hunger = Math.min(100, w.pet.hunger + fx.boost); w.pet.joy = Math.min(100, w.pet.joy + fx.boost); gainXp(w, fx.boost);
      setResult(settled); setMenu("reveal");
    }
  }, "reveal-common");
  const Meter = ({ name, value, tone }: { name: string; value: number; tone: string }) =>
    <div className="docks-meter"><span>{name}</span><div role="meter" aria-label={name} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(value)}>
      <i className={tone} style={{ width: `${value}%` }} /></div></div>;

  return <section className={`docks ${reducedMotion ? "reduced" : ""}`} aria-label={definition.name} aria-busy={busy}>
    <div className="docks-stage" ref={stage} inert={uiBlocked || undefined} />
    {webglError && <div className="docks-loading docks-overlay" role="alert">3D graphics aren't available in this browser. Try another browser or enable hardware acceleration.</div>}

    <div className="docks-hud" inert={uiBlocked || undefined}>
      <div className="docks-card docks-id">
        <strong>{label}{me.attached ? "" : " · adrift"}</strong>
        <span className="docks-status" style={{ background: `#${status.color.toString(16).padStart(6, "0")}` }}>{status.name}</span>
        <div className="docks-xp"><span>Rep {w.level}</span><div><i style={{ width: `${(w.xp / xpForLevel(w.level)) * 100}%` }} /></div></div>
        <Meter name="Food" value={w.pet.hunger} tone="t-food" /><Meter name="Joy" value={w.pet.joy} tone="t-joy" />
      </div>
      <div className="docks-card docks-wallet">
        <span className="docks-credits" title="Credits (simulated)">🪙 {Math.floor(w.credits)}</span>
        <span title="RF burned by player activity (simulated)">🔥 {w.burnedRf.toFixed(2)} RF burned</span>
        <span className="docks-sim">Simulated · {rf(snapshot.rfBalance)}</span>
      </div>
    </div>

    <p className="docks-toast" role="status" aria-live="polite">{error || toast}</p>
    {spriteError && <button type="button" className="docks-retry" onClick={() => loadSprites()}>Retry Friend artwork</button>}

    <div className="docks-bar" inert={uiBlocked || undefined}>
      <button type="button" className={`docks-act ${near ? "ready" : ""}`} disabled={!near || uiBlocked} onClick={() => activate(near)}>
        {near ? <>{spotLabel(w, near)} <kbd>E</kbd></> : "Walk up to something"}</button>
      <div className="docks-nav">
        <button type="button" onClick={() => setMenu("home")} disabled={uiBlocked}>🏠<span>Home</span></button>
        <button type="button" onClick={() => setMenu("map")} disabled={uiBlocked}>🗺️<span>Chain</span></button>
        <button type="button" onClick={() => setMenu("market")} disabled={uiBlocked}>🛒<span>Market</span></button>
        <button type="button" onClick={() => setMenu("bag")} disabled={uiBlocked}>🎒<span>Bag</span></button>
        <button type="button" onClick={() => setMenu("settings")} disabled={uiBlocked}>⚙️<span>More</span></button>
      </div>
    </div>

    {menu && <GameMenu onClose={busy ? undefined : () => { setMenu(null); setError(""); }}
      title={menu === "home" ? "Home" : menu === "reveal" ? "Treat time!" : menu === "stall" ? (stall.owner === "you" ? "Your stall" : `${stall.name} stall`)
        : menu === "market" ? "Market" : menu === "bag" ? "Bag" : menu === "map" ? "The Chain" : menu === "help" ? "How to play" : "Settings"}>

      {menu === "home" ? <>
        <div className="docks-landcard">
          {me.land.image && <div className="crop"><img src={me.land.image} alt={`${label}'s on-chain land`} /></div>}
          <div><strong>{landState === "chain" ? "Imported from chain" : "Stand-in land"}</strong>
            {landState === "chain" ? <small>{["Generation", "Character", "Scenery", "Floor", "Activation tier"].filter(k => me.land.traits[k] !== undefined).map(k => `${k}: ${me.land.traits[k]}`).join(" · ")}
              <br />{me.land.props.length} object{me.land.props.length === 1 ? "" : "s"} placed as they appear on your Friend.</small>
              : <small>{landError || "Your land couldn't be read."} <button type="button" onClick={() => importLand()}>Retry import</button></small>}</div>
        </div>
        <p>Look after your Friend. A fed, happy Friend earns more rep from everything you do.</p>
        <div className="docks-row">
          <button type="button" disabled={kibbleWait > 0} onClick={() => { w.pet.hunger = Math.min(100, w.pet.hunger + 25); w.pet.kibbleAt = Date.now() + KIBBLE_COOLDOWN; gainXp(w, 2); say("Nom. Free kibble served."); }}>
            🍖 Free kibble{kibbleWait ? ` ${kibbleWait}s` : ""}</button>
          <button type="button" disabled={!w.bag.berry} onClick={() => { w.bag.berry--; w.pet.hunger = Math.min(100, w.pet.hunger + 20); w.pet.joy = Math.min(100, w.pet.joy + 10); gainXp(w, 3); say("Your Friend loved the berries."); }}>🫐 Feed berry ({w.bag.berry})</button>
          <button type="button" onClick={() => { w.pet.joy = Math.min(100, w.pet.joy + 8); gainXp(w, 1); say("Happy wiggles. 💛"); }}>🤲 Pet</button>
        </div>
        <h3>Treat Bags · {rf(definition.price)} each (simulated RF)</h3>
        <p>A surprise snack for your Friend plus a Charm. Keep Charms for a permanent rep boost, or redeem them.</p>
        <table><thead><tr><th>Charm</th><th>Chance</th><th>Value</th><th>Kept</th></tr></thead><tbody>
          {definition.outcomes.map((o, i) => <tr key={o.name}><td>{CHARM_ICON[i]} {o.name}</td><td>{o.chanceBps / 100}%</td><td>{rf(o.reward)}</td><td>+{CHARM_XP[i] * 100}% rep</td></tr>)}</tbody></table>
        <div className="docks-row">
          <button type="button" disabled={!canBuy || busy || paused} onClick={() => void act(() => client.buy(1n), "purchase", () => setToast("Treat Bag added."))}>Buy 1 · {rf(definition.price)}</button>
          <button type="button" className="rf-frame-primary" disabled={busy || paused || (!pending && snapshot.consumables === 0n)} onClick={() => void openBag()}>
            {pending ? "Finish opening" : `Open (${snapshot.consumables.toString()})`}</button>
        </div>
        {!canBuy && <p className="docks-note">{snapshot.rfBalance < definition.price ? "Not enough simulated RF." : "Purchases paused until there is enough free backing."}</p>}
        <h3>Charms</h3>
        {definition.outcomes.map((o, i) => <div className="docks-item" key={o.name}>
          <span><strong>{CHARM_ICON[i]} {o.name}</strong><small>{inventory[i].toString()} kept · {rf(o.reward)} each</small></span>
          <button type="button" disabled={busy || paused || inventory[i] === 0n} onClick={() => void act(() => client.redeem(i + 1, 1n), "reward")}>Redeem one</button></div>)}
        <p className="docks-note">Each bag reserves {rf(maxPrize)} of prize backing. RF balances and outcomes are simulated.</p>
      </> : menu === "reveal" && outcome && result?.outcomeId ? <div className="docks-reveal">
        <span aria-hidden="true">{CHARM_ICON[result.outcomeId - 1]}</span>
        <p>Your Friend gobbled a <strong>{TREAT[result.outcomeId - 1].snack}</strong> (+{TREAT[result.outcomeId - 1].boost} food &amp; joy)</p>
        <h3>…and found a {outcome.name}!</h3>
        <p>{outcome.chanceBps / 100}% chance · worth {rf(outcome.reward)}. Keep it for +{CHARM_XP[result.outcomeId - 1] * 100}% rep, or redeem it.</p>
        <div className="docks-row">
          <button type="button" className="rf-frame-primary" disabled={busy} onClick={() => setMenu(null)}>Keep charm</button>
          <button type="button" disabled={busy || paused} onClick={() => void act(() => client.redeem(result.outcomeId!, 1n), "reward", () => setMenu("home"))}>Redeem · {rf(outcome.reward)}</button>
        </div>
      </div> : menu === "stall" ? (stall.owner === "you" ? <>
        <p>Sell what your land produces. A {MARKET_FEE * 100}% market fee is burned as RF (simulated).</p>
        {(["berry", "egg"] as const).map(id => <div className="docks-item" key={id}>
          <span><strong>{ITEMS[id].icon} {ITEMS[id].name}</strong><small>{w.bag[id]} in bag · 🪙 {ITEMS[id].price} each</small></span>
          <span className="docks-row tight">
            <button type="button" disabled={!w.bag[id]} onClick={() => say(sellProduce(w, id, 1), "purchase")}>Sell 1</button>
            <button type="button" disabled={!w.bag[id]} onClick={() => say(sellProduce(w, id, w.bag[id]), "purchase")}>Sell all</button></span></div>)}
      </> : <>
        <p>A sample neighbour's stall. Sales go to the owner; the {MARKET_FEE * 100}% fee is burned (simulated).</p>
        {stall.stall.map(id => <div className="docks-item" key={id}>
          <span><strong>{ITEMS[id].icon} {ITEMS[id].name}</strong><small>{ITEMS[id].blurb}</small></span>
          <button type="button" disabled={w.credits < ITEMS[id].price} onClick={() => say(buyFromStall(w, id), "purchase")}>🪙 {ITEMS[id].price}</button></div>)}
        <p className="docks-note">You've helped {stall.name} {stall.thanks} time{stall.thanks === 1 ? "" : "s"}.</p>
      </>) : menu === "market" ? <>
        <h3>Credits</h3>
        <p>In the live app, credits are bought by card. Half of every purchase buys $RAREFRIENDS on the market and burns it. Here it's simulated: no payment is taken.</p>
        <div className="docks-row">{CREDIT_PACKS.map(p => <button type="button" key={p.credits} className="rf-frame-primary"
          onClick={() => { buyCredits(w, p.credits); say(`+${p.credits} credits · ${((p.credits / CREDITS_PER_RF) * BURN_SHARE_PURCHASE).toFixed(1)} RF burned (simulated)`, "purchase"); }}>
          🪙 {p.credits} · {p.label} <small>(simulated)</small></button>)}</div>
        <h3>Trading board</h3>
        <p>Listings from neighbours' stalls across the chain (sample data).</p>
        {w.plots.filter(p => p.owner === "neighbour").flatMap(p => p.stall.map(id => <div className="docks-item" key={`${p.id}-${id}`}>
          <span><strong>{ITEMS[id].icon} {ITEMS[id].name}</strong><small>Sold by {p.name} · {ITEMS[id].blurb}</small></span>
          <button type="button" disabled={w.credits < ITEMS[id].price} onClick={() => say(buyFromStall(w, id), "purchase")}>🪙 {ITEMS[id].price}</button></div>))}
        <p className="docks-note">🔥 {w.burnedRf.toFixed(2)} RF burned this session (simulated) · {CREDITS_PER_RF} credits = 1 RF of value.</p>
      </> : menu === "bag" ? <>
        {(Object.keys(ITEMS) as ItemId[]).filter(id => w.bag[id] > 0).length === 0 && <p>Your bag is empty.</p>}
        {(Object.keys(ITEMS) as ItemId[]).filter(id => w.bag[id] > 0).map(id => <div className="docks-item" key={id}>
          <span><strong>{ITEMS[id].icon} {ITEMS[id].name} × {w.bag[id]}</strong><small>{ITEMS[id].blurb}</small></span>
          {ITEMS[id].kind === "hat" ? <button type="button" onClick={() => { w.hat = w.hat === id ? null : id; engine.current?.refreshHat(); say(w.hat ? `Wearing the ${ITEMS[id].name}.` : "Hat off."); }}>{w.hat === id ? "Take off" : "Wear"}</button>
            : id === "fert" ? <button type="button" onClick={() => {
              const plant = me.plants.filter(p => p.stage < 3).sort((a, b) => a.stage - b.stage)[0];
              if (!plant) { say("Your plants are all ripe."); return; }
              w.bag.fert--; plant.stage++; plant.growth = 0; say("Fertilized: a plant grew one stage 🌱");
            }}>Use on garden</button> : null}</div>)}
      </> : menu === "map" ? <>
        <p>{me.attached ? `Attached. Touching ${neighbours.length} land${neighbours.length === 1 ? "" : "s"}: +${neighbours.length * ADJ_BONUS * 100}% produce & rep.`
          : "Your land is adrift. Lands keep their true on-chain size and attach edge to edge, so the chain keeps growing. Pick a glowing spot to attach."}</p>
        <ChainMap world={w} slots={me.attached ? [] : attachSlots(w, me)} onPick={(slot: Slot) => {
          const from = landOrigin(me); const msg = attach(w, slot);
          if (me.attached) { engine.current?.relocate(from, landOrigin(me)); setMenu(null); }
          say(msg, "reveal-rare");
        }} credits={w.credits} />
        <h3>Status</h3>
        <p>Status = <strong>weight</strong> (your land's true on-chain size) + <strong>development</strong> (rep level, tools and hats, lands you touch, RF burned). Each tier adds +10% produce &amp; rep.</p>
        <div className="docks-item"><span><strong>{status.name}</strong><small>Weight {status.weight} + development {status.development} = {status.score}{status.next ? ` · ${status.next} to ${STATUS_TIERS[status.tier + 1].name}` : " · top tier"}</small></span></div>
        <h3>Chain leaderboard</h3>
        {[...w.plots].map(p => ({ p, st: statusOf(w, p) })).sort((a, b) => b.st.score - a.st.score).map(({ p, st }, i) =>
          <div className="docks-item" key={p.id}><span><strong>{i + 1}. {p.owner === "you" ? "You" : p.name}</strong>
            <small>{st.name} · weight {st.weight} · development {st.development}{p.owner === "you" ? "" : " · sample"}</small></span></div>)}
        <p className="docks-note">Attach fees are simulated; {BURN_SHARE_DOCK * 100}% is burned as RF. Spots touching more lands cost more. Other lands are sample data in this preview.</p>
      </> : menu === "help" ? <ul className="docks-help">
        <li><strong>Move:</strong> WASD / arrows, or tap the ground. <strong>Interact:</strong> E or the action button (or tap the thing again when you're next to it).</li>
        <li><strong>Grow:</strong> water your 3 plants; ripe bushes give berries. Well-fed chickens lay eggs.</li>
        <li><strong>Attach:</strong> use your sign (or Chain) to attach your land edge-to-edge onto the chain. Every land you touch adds +25% produce and rep.</li>
        <li><strong>Status:</strong> bigger lands (weight) and more development climb the tiers: Drifter → Settler → Merchant → Harbor Master → Admiral. Your flag grows with it.</li>
        <li><strong>Help neighbours:</strong> walk straight across onto their land, water their plants and feed their chickens for rep and tips.</li>
        <li><strong>Trade:</strong> sell produce at your stall, buy tools, feed and hats at neighbours' stalls or the Market.</li>
        <li><strong>Home:</strong> feed and pet your Friend, open Treat Bags (simulated RF) for Charms.</li>
        <li>Everything is simulated and resets when you reload.</li>
      </ul> : menu === "settings" ? <>
        <div className="docks-row">
          <button type="button" aria-pressed={!muted} onClick={() => { const next = !muted; setMuted(next); sound.current?.setMuted(next); if (!next) void sound.current?.unlock(); }}>{muted ? "🔇 Sound off" : "🔊 Sound on"}</button>
          <button type="button" onClick={() => setMenu("help")}>❓ How to play</button>
        </div>
        <label><input type="checkbox" checked={reducedMotion} onChange={e => setReducedMotion(e.target.checked)} /> Reduce motion</label>
        <p className="docks-note">All credits, RF, burns, trades and neighbours are simulated for this preview. Wallet connection and NFT ownership checks are handled by FriendSDK.</p>
      </> : null}
      {error && <p role="alert" className="docks-note">{error}</p>}
      {busy && <p role="status" className="docks-note">Waiting for preview confirmation…</p>}
    </GameMenu>}
  </section>;
}
