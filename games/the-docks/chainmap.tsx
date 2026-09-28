/* The berth map: one square per island, whatever its size. Glowing squares are loading
 * zones where the chosen island can dock. Tap an island to build a bridge to it. */
import { useState } from "react";
import { connected, type Berth, type Plot, type World } from "./world.js";

export function ChainMap({ world, island, zones, onDock, onBridge }: {
  world: World; island: Plot; zones: Berth[];
  onDock: (b: Berth) => void; onBridge: (to: Plot) => void;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const docked = world.plots.filter(p => p.berth && p.friends.length);
  const all = [...docked.map(p => p.berth!), ...zones];
  const xs = all.map(b => b.x), ys = all.map(b => b.y);
  const x0 = Math.min(0, ...xs) - 1, x1 = Math.max(0, ...xs) + 2, y0 = Math.min(0, ...ys) - 1, y1 = Math.max(0, ...ys) + 2;
  const bridgeable = (p: Plot) => !p.mine && island.berth && p.berth && !connected(world, island, p);
  return <div className="docks-chainmap">
    <svg viewBox={`${x0} ${y0} ${x1 - x0} ${y1 - y0}`} role="img" aria-label={`Map: ${docked.length} docked islands, ${zones.length} loading zones`}>
      {world.bridges.map((b, i) => <line key={i} x1={b.a.berth!.x + 0.5} y1={b.a.berth!.y + 0.5} x2={b.b.berth!.x + 0.5} y2={b.b.berth!.y + 0.5} className="bridge-line" />)}
      {docked.map(p => <g key={p.id} className={`isle ${p === island ? "mine" : p.mine ? "mine-other" : p.access === "open" ? "open" : "invite"} ${bridgeable(p) ? "can-bridge" : ""}`}
        onClick={() => bridgeable(p) && onBridge(p)}>
        <rect x={p.berth!.x + 0.08} y={p.berth!.y + 0.08} width={0.84} height={0.84} rx={0.18} />
        <text x={p.berth!.x + 0.5} y={p.berth!.y + 0.56} textAnchor="middle" dominantBaseline="middle">{p.friends.length > 999 ? `${Math.round(p.friends.length / 1000)}k` : p.friends.length}</text>
      </g>)}
      {zones.map((b, i) => <g key={`z${i}`} className={`slot ${hover === i ? "hot" : ""}`} onPointerEnter={() => setHover(i)} onPointerLeave={() => setHover(null)} onClick={() => onDock(b)}>
        <rect x={b.x + 0.15} y={b.y + 0.15} width={0.7} height={0.7} rx={0.14} />
        <text x={b.x + 0.5} y={b.y + 0.56} textAnchor="middle" dominantBaseline="middle" className="slot-num">{i + 1}</text>
      </g>)}
    </svg>
    <p className="docks-note">Each square is an island (number = Friends on it). Green: {island.name} · white: open · grey: invite only · glowing: loading zones. Tap an island you're not next to for a bridge.</p>
    {zones.length > 0 && <div className="docks-slots">
      {zones.map((b, i) => { const next = docked.filter(p => p !== island && Math.abs(p.berth!.x - b.x) + Math.abs(p.berth!.y - b.y) === 1);
        return <button type="button" key={i} onPointerEnter={() => setHover(i)} onPointerLeave={() => setHover(null)} onFocus={() => setHover(i)} onClick={() => onDock(b)}>
          Zone {i + 1}<small>next to {next.map(p => p.name).join(", ") || "open water"}</small></button>; })}
    </div>}
    {island.berth && <div className="docks-slots">{docked.filter(bridgeable).map(p => <button type="button" key={p.id} onClick={() => onBridge(p)}>
      Bridge to {p.name}<small>free</small></button>)}</div>}
  </div>;
}
