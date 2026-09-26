/* Isometric mini-map of the docks, matching the main view (screen x = x − y). */
import { useState } from "react";
import { mine, plotBounds, type Plot, type Slot, type World } from "./world.js";

/** One rect per Friend footprint, in cells. */
function rects(p: Plot, dx = 0, dy = 0) {
  return p.friends.map(pl => ({ x: pl.x + dx, y: pl.y + dy, w: pl.m.cw, h: pl.m.ch }));
}

export function ChainMap({ world, slots, onPick }: { world: World; slots: Slot[]; onPick: (s: Slot) => void }) {
  const [hover, setHover] = useState<number | null>(null);
  const me = mine(world);
  const shown = world.plots.filter(p => p.docked && p.friends.length);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  const extend = (x0: number, y0: number, x1: number, y1: number) => {
    for (const [cx, cy] of [[x0, y0], [x1, y0], [x0, y1], [x1, y1]]) {
      const ix = cx - cy, iy = (cx + cy) / 2;
      minX = Math.min(minX, ix); maxX = Math.max(maxX, ix); minY = Math.min(minY, iy); maxY = Math.max(maxY, iy);
    }
  };
  shown.forEach(p => { const b = plotBounds(p); extend(b.x0, b.y0, b.x1, b.y1); });
  const mb = me.friends.length ? plotBounds(me) : null;
  if (mb) slots.forEach(s => extend(mb.x0 + s.dx, mb.y0 + s.dy, mb.x1 + s.dx, mb.y1 + s.dy));
  if (!Number.isFinite(minX)) { minX = 0; maxX = 10; minY = 0; maxY = 10; }
  const pad = 1.5, vb = `${minX - pad} ${minY - pad} ${maxX - minX + pad * 2} ${maxY - minY + pad * 2}`;
  return <div className="docks-chainmap">
    <svg viewBox={vb} role="img" aria-label={`Map: ${shown.length} docked plots${slots.length ? `, ${slots.length} spots where your plot fits` : ""}`}>
      <g transform="matrix(1 0.5 -1 0.5 0 0)">
        {shown.map(p => <g key={p.id} className={p.mine ? "mine" : p.access === "open" ? "open" : "invite"}>
          {rects(p).map((r, i) => <rect key={i} x={r.x} y={r.y} width={r.w + 0.02} height={r.h + 0.02} />)}
        </g>)}
        {slots.map((s, i) => <g key={i} className={`slot ${hover === i ? "hot" : ""}`} onPointerEnter={() => setHover(i)} onPointerLeave={() => setHover(null)} onClick={() => onPick(s)}>
          {rects(me, s.dx, s.dy).map((r, j) => <rect key={j} x={r.x} y={r.y} width={r.w + 0.02} height={r.h + 0.02} />)}
        </g>)}
      </g>
      {mb && slots.map((s, i) => { const cx = (mb.x0 + mb.x1) / 2 + s.dx, cy = (mb.y0 + mb.y1) / 2 + s.dy;
        return <text key={i} x={cx - cy} y={(cx + cy) / 2} className="slot-num" textAnchor="middle" dominantBaseline="middle">{i + 1}</text>; })}
    </svg>
    <p className="docks-note">White: open plots · grey: invite only · green: yours{slots.length ? " · glowing: where yours fits" : ""}</p>
    {slots.length > 0 && <div className="docks-slots">
      {slots.map((s, i) => <button type="button" key={i} onPointerEnter={() => setHover(i)} onPointerLeave={() => setHover(null)} onFocus={() => setHover(i)} onClick={() => onPick(s)}>
        Spot {i + 1}<small>beside {s.touches.map(p => p.name).join(", ")}</small></button>)}
    </div>}
  </div>;
}
