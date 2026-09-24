"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { GameComponentProps } from "@rarefriends/friendsdk/runtime";
import { GameMenu } from "@rarefriends/friendsdk/frame";
import { formatGameAmount } from "@rarefriends/friendsdk/ui";
import { maximumPrize, type GamePlay, type GameSnapshot } from "@rarefriends/friendsdk/game";
import { createFriendReader, spriteFrame, type GenerationSprites } from "@rarefriends/friendsdk/sprites";
import { createFriendSoundKit, type FriendSoundCue, type FriendSoundKit } from "@rarefriends/friendsdk/sounds";
import "@rarefriends/friendsdk/frame.css";
import "./style.css";

/* ───────────── Tuning (all simulated, session-only) ───────────── */
const TICK_MS = 250;
const DECAY = { hunger: 0.45, energy: 0.3, joy: 0.4 };          // points per second while awake
const SLEEP_DECAY = { hunger: 0.2, joy: 0 };                     // while napping
const NAP_REGEN = 4;                                             // energy per second while napping
const KIBBLE_COOLDOWN = 25;                                      // seconds
const PET_COOLDOWN_MS = 700;
const BASE_SPARKLES = 1;                                         // ✦ per second at a perfect mood, level 1
const CHARM_BOOST = [0.1, 0.2, 0.5] as const;                    // passive ✦ rate bonus per kept Clover / Moon / Star
const TREAT_EFFECT = [
  { snack: "Crunchy Kibble Crumble", stats: 20, xp: 20 },
  { snack: "Berry Moon Tart", stats: 35, xp: 35 },
  { snack: "Golden Star Honeycake", stats: 60, xp: 60 },
] as const;
type UpgradeId = "bed" | "toys" | "lamp";
const UPGRADES: Readonly<Record<UpgradeId, { name: string; icon: string; blurb: string; base: number }>> = {
  bed: { name: "Cozy Bed", icon: "🛏", blurb: "+50% nap recovery per tier", base: 120 },
  toys: { name: "Toy Box", icon: "🧸", blurb: "+40% joy from play per tier", base: 200 },
  lamp: { name: "Sparkle Lamp", icon: "💡", blurb: "+35% ✦ per second per tier", base: 320 },
};
const MAX_TIER = 3;
const upgradeCost = (id: UpgradeId, tier: number) => Math.round(UPGRADES[id].base * 2.5 ** tier);
const xpForLevel = (level: number) => 40 + level * 30;

type Pet = {
  hunger: number; energy: number; joy: number; asleep: boolean; playingUntil: number;
  sparkles: number; lifetime: number; xp: number; level: number; kibbleReadyAt: number; lastPet: number;
  tiers: Record<UpgradeId, number>;
};
const newPet = (): Pet => ({ hunger: 70, energy: 80, joy: 60, asleep: false, playingUntil: 0, sparkles: 0, lifetime: 0,
  xp: 0, level: 1, kibbleReadyAt: 0, lastPet: 0, tiers: { bed: 0, toys: 0, lamp: 0 } });
const clamp = (v: number) => Math.max(0, Math.min(100, v));

type Menu = "shop" | "reveal" | "charms" | "upgrades" | "settings" | "help" | null;
type Float = { id: number; text: string; x: number };
const rf = (value: bigint) => `${formatGameAmount(value, 18)} RF`;
const fmt = (n: number) => n >= 10_000 ? `${(n / 1000).toFixed(1)}k` : Math.floor(n).toLocaleString();

function moodOf(p: Pet) {
  if (p.asleep) return { face: "Sleeping", line: "Napping. Energy is coming back." };
  if (p.hunger < 20) return { face: "Hungry", line: "My tummy is rumbling… food please?" };
  if (p.energy < 20) return { face: "Sleepy", line: "So tired… maybe a nap?" };
  if (p.joy < 20) return { face: "Bored", line: "Play with me! Pretty please?" };
  const avg = (p.hunger + p.energy + p.joy) / 3;
  if (avg > 80) return { face: "Thrilled", line: "Best. Day. Ever. Sparkles everywhere!" };
  if (avg > 55) return { face: "Happy", line: "This nest is cozy. Thanks for looking after me." };
  return { face: "Okay", line: "I'm doing alright. A little attention would be nice." };
}

function sparkleRate(p: Pet, inventory: readonly bigint[]) {
  const avg = (p.hunger + p.energy + p.joy) / 300;
  const starving = p.hunger <= 0 || p.joy <= 0;
  const charms = inventory.reduce((sum, count, i) => sum + Number(count) * (CHARM_BOOST[i] ?? 0), 0);
  const rate = BASE_SPARKLES * (0.2 + avg) * (1 + 0.2 * (p.level - 1)) * (1 + 0.35 * p.tiers.lamp) * (1 + charms);
  return (starving ? rate * 0.25 : rate) * (p.asleep ? 0.5 : 1);
}

/* ───────────── Friend portrait (canonical 16×16 artwork, scaled up) ───────────── */
function FriendPortrait({ sprites, frame, sleeping }: { sprites: GenerationSprites; frame: number; sleeping: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const ctx = canvas.current?.getContext("2d");
    if (!ctx) return;
    const rows = spriteFrame(sprites, "down", false, frame).frame.rows;
    const S = 6, pad = 1;
    ctx.clearRect(0, 0, 108, 108);
    // one-pixel white halo, then the black mask (reference look)
    ctx.fillStyle = "#fff";
    rows.forEach((row, y) => [...row].forEach((c, x) => { if (c === "#") ctx.fillRect((x + pad) * S - S, (y + pad) * S - S, S * 3, S * 3); }));
    ctx.fillStyle = sleeping ? "#3b3456" : "#15121f";
    rows.forEach((row, y) => [...row].forEach((c, x) => { if (c === "#") ctx.fillRect((x + pad) * S, (y + pad) * S, S, S); }));
  }, [sprites, frame, sleeping]);
  return <canvas ref={canvas} width={108} height={108} className="nest-sprite" aria-hidden="true" />;
}

export default function FriendNest({ friendId, client, paused }: GameComponentProps) {
  const definition = client.definition;
  const [snapshot, setSnapshot] = useState<GameSnapshot | null>(null);
  const [sprites, setSprites] = useState<GenerationSprites | null>(null);
  const [spriteError, setSpriteError] = useState(false);
  const [menu, setMenu] = useState<Menu>(null);
  const [result, setResult] = useState<GamePlay | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [toast, setToast] = useState("");
  const [muted, setMuted] = useState(true), [reducedMotion, setReducedMotion] = useState(false);
  const [, setTick] = useState(0);
  const [floats, setFloats] = useState<Float[]>([]);
  const pet = useRef<Pet>(newPet());
  const sound = useRef<FriendSoundKit | null>(null), locked = useRef(false), epoch = useRef(0), floatId = useRef(0);
  const inventory = snapshot?.inventory ?? [0n, 0n, 0n];
  const inventoryRef = useRef(inventory); inventoryRef.current = inventory;

  /* session setup — resets whenever the verified Friend changes */
  useEffect(() => {
    const version = ++epoch.current;
    pet.current = newPet();
    sound.current = createFriendSoundKit({ muted: true });
    setSnapshot(null); setMenu(null); setResult(null); setError(""); setToast(""); setBusy(false); setMuted(true);
    setSprites(null); setSpriteError(false); locked.current = false;
    void client.read().then(v => { if (version === epoch.current) setSnapshot(v); })
      .catch(c => { if (version === epoch.current) setError(c instanceof Error ? c.message : "Could not load the preview."); });
    void createFriendReader().read(friendId).then(s => { if (version === epoch.current) setSprites(s); })
      .catch(() => { if (version === epoch.current) setSpriteError(true); });
    const pref = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReducedMotion(pref.matches); update(); pref.addEventListener("change", update);
    return () => { epoch.current++; sound.current?.dispose(); sound.current = null; pref.removeEventListener("change", update); };
  }, [client, friendId]);

  const retrySprites = () => {
    const version = epoch.current; setSpriteError(false);
    void createFriendReader().read(friendId).then(s => { if (version === epoch.current) setSprites(s); })
      .catch(() => { if (version === epoch.current) setSpriteError(true); });
  };

  /* idle simulation loop — stops while the runtime is paused or the tab is hidden */
  useEffect(() => {
    if (paused || !snapshot) return;
    let last = performance.now();
    const id = window.setInterval(() => {
      const now = performance.now();
      const dt = Math.min(1, (now - last) / 1000); last = now;
      if (document.hidden) return;
      const p = pet.current;
      if (p.asleep) {
        p.energy = clamp(p.energy + NAP_REGEN * (1 + 0.5 * p.tiers.bed) * dt);
        p.hunger = clamp(p.hunger - SLEEP_DECAY.hunger * dt);
        if (p.energy >= 100) { p.asleep = false; toastMsg("Your Friend woke up refreshed!"); }
      } else {
        p.hunger = clamp(p.hunger - DECAY.hunger * dt);
        p.energy = clamp(p.energy - DECAY.energy * dt);
        p.joy = clamp(p.joy - DECAY.joy * dt);
      }
      const gain = sparkleRate(p, inventoryRef.current) * dt;
      p.sparkles += gain; p.lifetime += gain;
      setTick(t => t + 1);
    }, TICK_MS);
    return () => window.clearInterval(id);
  }, [paused, snapshot !== null]); // eslint-disable-line react-hooks/exhaustive-deps

  /* animation frame counter for the idle sprite */
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (reducedMotion || paused) { setFrame(0); return; }
    const id = window.setInterval(() => setFrame(f => (f + 1) % 8), 160);
    return () => window.clearInterval(id);
  }, [reducedMotion, paused]);

  function toastMsg(text: string) { setToast(text); }
  const cue = (c: FriendSoundCue) => { sound.current?.play(c); };
  const addFloat = useCallback((text: string) => {
    const id = ++floatId.current;
    setFloats(f => [...f.slice(-6), { id, text, x: 30 + Math.random() * 40 }]);
    window.setTimeout(() => setFloats(f => f.filter(x => x.id !== id)), 1100);
  }, []);
  function gainXp(amount: number) {
    const p = pet.current; p.xp += amount;
    while (p.xp >= xpForLevel(p.level)) {
      p.xp -= xpForLevel(p.level); p.level += 1;
      toastMsg(`Level up! Your Friend is now level ${p.level} — sparkles +20%.`); cue("reveal-rare");
    }
  }

  /* ── care actions (local, free) ── */
  const canAct = !paused && !busy && !menu && snapshot !== null;
  const now = Date.now();
  const p = pet.current;
  const kibbleWait = Math.max(0, Math.ceil((p.kibbleReadyAt - now) / 1000));
  const playing = p.playingUntil > now;
  const feed = () => {
    if (!canAct || p.asleep || kibbleWait > 0) return;
    void sound.current?.unlock();
    p.hunger = clamp(p.hunger + 30); p.kibbleReadyAt = Date.now() + KIBBLE_COOLDOWN * 1000; gainXp(6);
    addFloat("+30 🍖"); cue("select"); toastMsg("Nom nom. Free kibble served.");
  };
  const play = () => {
    if (!canAct || p.asleep || playing) return;
    if (p.energy < 15) { toastMsg("Too tired to play. Try a nap first."); return; }
    void sound.current?.unlock();
    const joy = Math.round(25 * (1 + 0.4 * p.tiers.toys));
    p.energy = clamp(p.energy - 15); p.hunger = clamp(p.hunger - 5); p.joy = clamp(p.joy + joy);
    p.playingUntil = Date.now() + 1400; gainXp(9);
    addFloat(`+${joy} 💛`); cue("action-start"); toastMsg("Zoomies! That was fun.");
  };
  const nap = () => {
    if (!canAct) return;
    void sound.current?.unlock();
    p.asleep = !p.asleep; cue("select");
    toastMsg(p.asleep ? "Tucked in for a nap. Sparkles slow while sleeping." : "Rise and shine!");
    setTick(t => t + 1);
  };
  const petFriend = () => {
    if (!canAct) return;
    void sound.current?.unlock();
    const t = Date.now();
    if (p.asleep) { toastMsg("Shh… your Friend is napping."); return; }
    if (t - p.lastPet < PET_COOLDOWN_MS) return;
    p.lastPet = t;
    const bonus = Math.max(1, Math.round(sparkleRate(p, inventoryRef.current) * 2));
    p.joy = clamp(p.joy + 3); p.sparkles += bonus; p.lifetime += bonus; gainXp(1);
    addFloat(`+${bonus} ✦`); cue("select");
    setTick(x => x + 1);
  };
  const buyUpgrade = (id: UpgradeId) => {
    const tier = p.tiers[id]; if (tier >= MAX_TIER) return;
    const cost = upgradeCost(id, tier);
    if (p.sparkles < cost) return;
    p.sparkles -= cost; p.tiers[id] = tier + 1; cue("purchase");
    toastMsg(`${UPGRADES[id].name} upgraded to tier ${tier + 1}.`); setTick(x => x + 1);
  };

  /* keyboard shortcuts */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === "f") feed(); else if (k === "p") play(); else if (k === "n") nap();
      else if (k === " " && (e.target as HTMLElement)?.tagName !== "BUTTON") { e.preventDefault(); petFriend(); }
      else if (!menu && canAct && k === "t") setMenu("shop");
      else if (!menu && canAct && k === "u") setMenu("upgrades");
      else if (!menu && canAct && k === "c") setMenu("charms");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  /* ── RF economy via the SDK's fixed (simulated) action client ── */
  async function act(work: () => Promise<void>, sfx?: FriendSoundCue, after?: () => void) {
    if (locked.current || paused) return;
    const version = epoch.current; locked.current = true; setBusy(true); setError(""); void sound.current?.unlock();
    try {
      await work(); const v = await client.read();
      if (version === epoch.current) { setSnapshot(v); if (sfx) cue(sfx); after?.(); }
    } catch (c) { if (version === epoch.current) setError(c instanceof Error ? c.message : "The preview action failed."); }
    finally { if (version === epoch.current) { locked.current = false; setBusy(false); } }
  }

  if (!snapshot) return <div className="nest-loading" role={error ? "alert" : "status"}>
    <div className="nest-egg" aria-hidden="true">🥚</div>{error || "Warming up the nest…"}
    {error && <button type="button" disabled={busy || paused} onClick={() => void act(async () => {})}>Retry</button>}
  </div>;
  if (snapshot.friendId !== friendId) return <p role="alert">This game session does not match the selected Friend.</p>;

  const maxPrize = maximumPrize(definition);
  const canBuy = snapshot.rfBalance >= definition.price && snapshot.freeStake >= maxPrize && snapshot.freeStake + definition.price >= maxPrize;
  const pending = snapshot.plays.find(x => x.outcomeId === null);
  const bags = snapshot.consumables;
  const outcome = result?.outcomeId ? definition.outcomes[result.outcomeId - 1] : null;
  const charmCount = inventory.reduce((t, n) => t + n, 0n);
  const openBag = () => act(async () => {
    const version = epoch.current;
    const played = pending ?? (await client.play(1n))[0];
    const settled = await client.settle(played.id);
    if (version === epoch.current && settled.outcomeId) {
      const fx = TREAT_EFFECT[settled.outcomeId - 1];
      const q = pet.current;
      q.hunger = clamp(q.hunger + fx.stats); q.joy = clamp(q.joy + fx.stats); q.energy = clamp(q.energy + fx.stats / 2);
      gainXp(fx.xp); setResult(settled); setMenu("reveal");
    }
  }, "reveal-common");

  const mood = moodOf(p);
  const rate = sparkleRate(p, inventory);
  const label = sprites ? `${sprites.familyName} #${friendId}` : `Friend #${friendId}`;
  const modeTag = snapshot.mode === "preview" ? "Simulated" : "Live";
  const Bar = ({ name, icon, value, tone }: { name: string; icon: string; value: number; tone: string }) =>
    <div className="nest-stat"><span className="nest-stat-label"><span aria-hidden="true">{icon}</span> {name}</span>
      <div className="nest-bar" role="meter" aria-label={name} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(value)}>
        <div className={`nest-fill ${tone} ${value < 20 ? "low" : ""}`} style={{ width: `${value}%` }} /></div>
      <span className="nest-stat-num">{Math.round(value)}</span></div>;

  return <section className={`nest ${reducedMotion ? "reduced" : ""} ${p.asleep ? "night" : ""}`} aria-label={definition.name} aria-busy={busy}>
    <div className="nest-layout" inert={Boolean(menu) || paused || undefined}>
      <header className="nest-top">
        <div className="nest-id"><strong>{label}</strong>
          <div className="nest-level"><span>Lv {p.level}</span>
            <div className="nest-xp" aria-label={`Experience ${Math.floor(p.xp)} of ${xpForLevel(p.level)}`}><div style={{ width: `${(p.xp / xpForLevel(p.level)) * 100}%` }} /></div></div></div>
        <div className="nest-wallet">
          <span className="nest-sparkles" title="Sparkles (in-game, simulated)">✦ {fmt(p.sparkles)} <small>+{rate.toFixed(1)}/s</small></span>
          <span className="nest-rf" title="Simulated RF balance of your Friend">{modeTag} · {rf(snapshot.rfBalance)}</span>
        </div>
      </header>

      <div className="nest-scene">
        <div className="nest-room" aria-hidden="true"><div className="nest-window" /><div className="nest-rug" />
          {p.tiers.lamp > 0 && <div className="nest-lamp" />}{p.tiers.bed > 0 && <div className="nest-bed" />}{p.tiers.toys > 0 && <div className="nest-toy">🧸</div>}</div>
        <p className="nest-bubble" aria-live="polite"><strong>{mood.face}.</strong> {mood.line}</p>
        <button type="button" className={`nest-friend ${playing ? "hop" : ""} ${p.asleep ? "asleep" : ""}`} onClick={petFriend} disabled={!canAct}
          aria-label={p.asleep ? "Your Friend is napping" : "Pet your Friend to collect bonus sparkles (Space)"}>
          {sprites ? <FriendPortrait sprites={sprites} frame={frame} sleeping={p.asleep} />
            : <span className="nest-sprite-fallback">{spriteError ? "?" : "…"}</span>}
          {p.asleep && <span className="nest-zzz" aria-hidden="true">z z z</span>}
        </button>
        {spriteError && <button type="button" className="nest-retry" onClick={retrySprites}>Retry artwork</button>}
        {floats.map(f => <span key={f.id} className="nest-float" style={{ left: `${f.x}%` }} aria-hidden="true">{f.text}</span>)}
        <p className="nest-toast" role="status">{error || toast || "Tap your Friend to pet it."}</p>
      </div>

      <aside className="nest-panel">
        <Bar name="Hunger" icon="🍖" value={p.hunger} tone="t-hunger" />
        <Bar name="Energy" icon="⚡" value={p.energy} tone="t-energy" />
        <Bar name="Joy" icon="💛" value={p.joy} tone="t-joy" />
        <div className="nest-actions">
          <button type="button" onClick={feed} disabled={!canAct || p.asleep || kibbleWait > 0}>🍖 Feed{kibbleWait > 0 ? ` ${kibbleWait}s` : ""}</button>
          <button type="button" onClick={play} disabled={!canAct || p.asleep || playing}>🎾 Play</button>
          <button type="button" onClick={nap} disabled={!canAct}>{p.asleep ? "☀️ Wake" : "🌙 Nap"}</button>
          <button type="button" className="rf-frame-primary" onClick={() => setMenu("shop")} disabled={!canAct}>🎁 Treats{bags > 0n ? ` · ${bags}` : ""}</button>
          <button type="button" onClick={() => setMenu("upgrades")} disabled={!canAct}>🏠 Nest</button>
          <button type="button" onClick={() => setMenu("charms")} disabled={!canAct}>🍀 Charms · {charmCount.toString()}</button>
        </div>
        <div className="nest-links">
          <button type="button" onClick={() => setMenu("help")} disabled={!canAct}>How to play</button>
          <button type="button" onClick={() => setMenu("settings")} disabled={!canAct}>Settings</button>
        </div>
      </aside>
    </div>

    {menu && <GameMenu onClose={busy ? undefined : () => { setMenu(null); setError(""); }}
      title={menu === "shop" ? "Treat Bags" : menu === "reveal" ? "Treat time!" : menu === "charms" ? "Charm shelf" : menu === "upgrades" ? "Upgrade the nest" : menu === "help" ? "How to play" : "Settings"}>
      {menu === "shop" ? <>
        <p>A Treat Bag costs <strong>{rf(definition.price)}</strong> (simulated). Opening one feeds your Friend a surprise snack (big stat + XP boost) and leaves a <strong>Charm</strong>.</p>
        <table><thead><tr><th>Charm</th><th>Chance</th><th>Value</th><th>Kept perk</th></tr></thead><tbody>
          {definition.outcomes.map((o, i) => <tr key={o.name}><td>{o.name}</td><td>{o.chanceBps / 100}%</td><td>{rf(o.reward)}</td><td>+{CHARM_BOOST[i] * 100}% ✦</td></tr>)}</tbody></table>
        <div className="nest-row">
          <button type="button" disabled={!canBuy || busy || paused} onClick={() => void act(() => client.buy(1n), "purchase", () => setToast("Treat Bag added."))}>Buy 1 · {rf(definition.price)}</button>
          <button type="button" className="rf-frame-primary" disabled={busy || paused || (!pending && bags === 0n)} onClick={() => void openBag()}>
            {pending ? "Finish opening" : `Open a bag (${bags.toString()})`}</button>
        </div>
        {!canBuy && <p className="nest-note">{snapshot.rfBalance < definition.price ? "Not enough simulated RF." : "Purchases paused until there is enough free backing."}</p>}
        <p className="nest-note">Each bag reserves {rf(maxPrize)} of prize backing. Balances and outcomes are simulated for this preview.</p>
      </> : menu === "reveal" && outcome && result?.outcomeId ? <div className="nest-reveal">
        <span className="nest-charm" aria-hidden="true">{["🍀", "🌙", "⭐"][result.outcomeId - 1]}</span>
        <p>Your Friend gobbled a <strong>{TREAT_EFFECT[result.outcomeId - 1].snack}</strong> (+{TREAT_EFFECT[result.outcomeId - 1].stats} stats, +{TREAT_EFFECT[result.outcomeId - 1].xp} XP)</p>
        <h3>…and left a {outcome.name}!</h3>
        <p>{outcome.chanceBps / 100}% chance · worth {rf(outcome.reward)}. Keep it for +{CHARM_BOOST[result.outcomeId - 1] * 100}% sparkles, or redeem it.</p>
        <div className="nest-row">
          <button type="button" className="rf-frame-primary" disabled={busy || paused} onClick={() => setMenu(null)}>Keep charm</button>
          <button type="button" disabled={busy || paused} onClick={() => void act(() => client.redeem(result.outcomeId!, 1n), "reward", () => setMenu("charms"))}>Redeem · {rf(outcome.reward)}</button>
        </div>
      </div> : menu === "charms" ? <>
        <p>Kept charms boost sparkle production. Redeem any time for their fixed simulated RF value — no expiry.</p>
        {definition.outcomes.map((o, i) => <div className="nest-item" key={o.name}>
          <span><strong>{["🍀", "🌙", "⭐"][i]} {o.name}</strong><small>{inventory[i].toString()} kept · +{CHARM_BOOST[i] * 100}% ✦ each · {rf(o.reward)}</small></span>
          <button type="button" disabled={busy || paused || inventory[i] === 0n} onClick={() => void act(() => client.redeem(i + 1, 1n), "reward")}>Redeem one</button></div>)}
      </> : menu === "upgrades" ? <>
        <p>Spend ✦ Sparkles (in-game, session-only) to upgrade the nest. You have <strong>✦ {fmt(p.sparkles)}</strong>.</p>
        {(Object.keys(UPGRADES) as UpgradeId[]).map(id => {
          const tier = p.tiers[id], maxed = tier >= MAX_TIER, cost = upgradeCost(id, tier);
          return <div className="nest-item" key={id}>
            <span><strong>{UPGRADES[id].icon} {UPGRADES[id].name}</strong><small>Tier {tier}/{MAX_TIER} · {UPGRADES[id].blurb}</small></span>
            <button type="button" disabled={maxed || p.sparkles < cost} onClick={() => buyUpgrade(id)}>{maxed ? "Maxed" : `✦ ${fmt(cost)}`}</button></div>;
        })}
      </> : menu === "help" ? <ul className="nest-help">
        <li><strong>Keep your Friend happy.</strong> Hunger, Energy and Joy slowly drop. Happier Friends make more ✦ Sparkles.</li>
        <li><strong>Feed</strong> (F) is free every {KIBBLE_COOLDOWN}s. <strong>Play</strong> (P) costs energy, adds joy. <strong>Nap</strong> (N) restores energy.</li>
        <li><strong>Pet</strong> your Friend (tap or Space) for bonus sparkles.</li>
        <li><strong>Nest</strong> (U): spend sparkles on the bed, toy box and lamp. Levels add +20% sparkles each.</li>
        <li><strong>Treat Bags</strong> (T) cost simulated RF and drop Charms: keep them for a passive boost or redeem them for RF.</li>
        <li>Progress lasts for this session only and pauses while the tab is hidden.</li>
      </ul> : menu === "settings" ? <>
        <button type="button" aria-pressed={!muted} onClick={() => { const next = !muted; setMuted(next); sound.current?.setMuted(next); if (!next) void sound.current?.unlock(); }}>{muted ? "🔇 Sound off" : "🔊 Sound on"}</button>
        <label><input type="checkbox" checked={reducedMotion} onChange={e => setReducedMotion(e.target.checked)} /> Reduce motion</label>
        <p className="nest-note">All RF purchases, charms and redemptions are simulated. Reloading resets the nest. Wallet connection and NFT ownership checks are handled by FriendSDK.</p>
      </> : null}
      {error && <p role="alert" className="nest-note">{error}</p>}
      {busy && <p role="status" className="nest-note">Waiting for preview confirmation…</p>}
    </GameMenu>}
  </section>;
}
