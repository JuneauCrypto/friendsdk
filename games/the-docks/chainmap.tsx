/* The berth map: one square per island, whatever its size. Glowing squares are loading
 * zones where the chosen island can dock. Tap an island to build a bridge to it. */
import { useState } from "react";
import { connected, DOCKING_FEE, hostileBorder, levelName, zOf, type Berth, type Plot, type World } from "./world.js";

/** Where a berth's square goes: the water level fills the cell; decks above sit small in its
 *  top-right corner, decks below in its bottom-left, stepping further out per level. */
const sq = (b: Berth, big: number) => { const z = zOf(b); if (!z) return { x: b.x + (1 - big) / 2, y: b.y + (1 - big) / 2, s: big };
  const s = 0.3, o = Math.min(3, Math.abs(z)) * 0.1; return z > 0 ? { x: b.x + 1 - s - 0.02 - (o - 0.1), y: b.y + 0.02 + (o - 0.1), s } : { x: b.x + 0.02 + (o - 0.1), y: b.y + 1 - s - 0.02 - (o - 0.1), s }; };

export function ChainMap({ world, island, zones, onDock, onBridge }: {
  world: World; island: Plot; zones: Berth[];
  onDock: (b: Berth) => void; onBridge: (to: Plot) => void;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const docked = world.plots.filter(p => p.berth && p.friends.length);
  const all = [...docked.map(p => p.berth!), ...zones];
  const xs = all.map(b => b.x), ys = all.map(b => b.y);
  const x0 = Math.min(0, ...xs) - 1, x1 = Math.max(0, ...xs) + 2, y0 = Math.min(0, ...ys) - 1, y1 = Math.max(0, ...ys) + 2;
  const bridgeable = (p: Plot) => !p.mine && island.berth && p.berth && !connected(world, island, p) && !hostileBorder(world, island, p);
  return <div className="docks-chainmap">
    <svg viewBox={`${x0} ${y0} ${x1 - x0} ${y1 - y0}`} role="img" aria-label={`Map: ${docked.length} docked islands, ${zones.length} loading zones`}>
      {world.bridges.map((b, i) => <line key={i} x1={b.a.berth!.x + 0.5} y1={b.a.berth!.y + 0.5} x2={b.b.berth!.x + 0.5} y2={b.b.berth!.y + 0.5} className="bridge-line" />)}
      {docked.map(p => <g key={p.id} className={`isle ${p === island ? "mine" : p.mine ? "mine-other" : p.access === "open" ? "open" : "invite"} ${bridgeable(p) ? "can-bridge" : ""}`}
        onClick={() => bridgeable(p) && onBridge(p)}>
        {(() => { const q = sq(p.berth!, 0.84); return <rect x={q.x} y={q.y} width={q.s} height={q.s} rx={q.s * 0.2} className={zOf(p.berth) ? "deck" : ""} />; })()}
        {!zOf(p.berth) && <text x={p.berth!.x + 0.5} y={p.berth!.y + 0.56} textAnchor="middle" dominantBaseline="middle">{p.friends.length > 999 ? `${Math.round(p.friends.length / 1000)}k` : p.friends.length}</text>}
      </g>)}
      {zones.map((b, i) => <g key={`z${i}`} className={`slot ${hover === i ? "hot" : ""}`} onPointerEnter={() => setHover(i)} onPointerLeave={() => setHover(null)} onClick={() => onDock(b)}>
        {(() => { const q = sq(b, 0.7); return <rect x={q.x} y={q.y} width={q.s} height={q.s} rx={q.s * 0.2} />; })()}
        {!zOf(b) && <text x={b.x + 0.5} y={b.y + 0.56} textAnchor="middle" dominantBaseline="middle" className="slot-num">{i + 1}</text>}
      </g>)}
    </svg>
    <p className="docks-note">Each square is an island (number = Friends on it). Green: {island.name} · white: open · grey: invite only · glowing: loading zones. Small squares in a corner are decks: top-right above the water level, bottom-left below it. Tap an island you're not next to for a bridge.</p>
    {zones.length > 0 && <div className="docks-slots">
      {zones.map((b, i) => [b, i] as const).sort(([a], [b]) => { const c = island.berth ?? { x: 0, y: 0 }; return Math.abs(zOf(a)) - Math.abs(zOf(b)) || Math.abs(a.x - c.x) + Math.abs(a.y - c.y) - Math.abs(b.x - c.x) - Math.abs(b.y - c.y); }).slice(0, 24).map(([b, i]) => { const next = docked.filter(p => p !== island && Math.abs(p.berth!.x - b.x) + Math.abs(p.berth!.y - b.y) + Math.abs(zOf(p.berth) - zOf(b)) === 1);
        return <button type="button" key={i} onPointerEnter={() => setHover(i)} onPointerLeave={() => setHover(null)} onFocus={() => setHover(i)} onClick={() => onDock(b)}>
          Zone {i + 1}{zOf(b) ? ` · ${levelName(zOf(b))}` : ""}<small>{next.map(p => `${zOf(p.berth) > zOf(b) ? "under" : zOf(p.berth) < zOf(b) ? "over" : "next to"} ${p.name}`).join(", ") || "open water"}</small></button>; })}
    </div>}
    {island.berth && <div className="docks-slots">{docked.filter(bridgeable).sort((a, b) => Math.abs(a.berth!.x - island.berth!.x) + Math.abs(a.berth!.y - island.berth!.y) - Math.abs(b.berth!.x - island.berth!.x) - Math.abs(b.berth!.y - island.berth!.y)).slice(0, 12).map(p => <button type="button" key={p.id} onClick={() => onBridge(p)}>
      Bridge to {p.name}<small>{DOCKING_FEE} RF</small></button>)}</div>}
  </div>;
}
