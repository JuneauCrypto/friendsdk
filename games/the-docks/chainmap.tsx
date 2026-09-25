/* Isometric mini-map of the chain, drawn to match the 3D view (screen x = x − y). */
import { useState } from "react";
import { SURF, statusOf, you, type PlotState, type Slot, type World } from "./model.js";

function runs(p: PlotState, x0: number, y0: number) {
  // merge each row of tiles into horizontal runs to keep the SVG small
  const out: { x: number; y: number; w: number; s: number }[] = [];
  for (let y = 0; y < p.piece.h; y++) {
    let start = -1, kind = 0;
    for (let x = 0; x <= p.piece.w; x++) {
      const v = x < p.piece.w ? p.piece.surface[y * p.piece.w + x] : 0;
      if (v !== kind || x === p.piece.w) {
        if (start >= 0 && kind) out.push({ x: x0 + start, y: y0 + y, w: x - start, s: kind });
        start = v ? x : -1; kind = v;
      }
    }
  }
  return out;
}
const hex = (c: number) => `#${c.toString(16).padStart(6, "0")}`;

export function ChainMap({ world, slots, onPick, credits }: { world: World; slots: Slot[]; onPick: (s: Slot) => void; credits: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const me = you(world);
  const shown = world.plots.filter(p => p.attached);
  // bounds in iso space
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  const extend = (x: number, y: number, w: number, h: number) => {
    for (const [cx, cy] of [[x, y], [x + w, y], [x, y + h], [x + w, y + h]]) {
      const ix = cx - cy, iy = (cx + cy) / 2;
      minX = Math.min(minX, ix); maxX = Math.max(maxX, ix); minY = Math.min(minY, iy); maxY = Math.max(maxY, iy);
    }
  };
  shown.forEach(p => extend(p.pos.x, p.pos.y, p.piece.w, p.piece.h));
  slots.forEach(s => extend(s.x, s.y, me.piece.w, me.piece.h));
  const pad = 2, vb = `${minX - pad} ${minY - pad} ${maxX - minX + pad * 2} ${maxY - minY + pad * 2}`;
  return <div className="docks-chainmap">
    <svg viewBox={vb} role="img" aria-label={`Map of the chain: ${shown.length} lands${slots.length ? `, ${slots.length} open spots` : ""}`}>
      <g transform="matrix(1 0.5 -1 0.5 0 0)">
        {shown.map(p => {
          const st = statusOf(world, p), mine = p === me;
          return <g key={p.id}>
            {runs(p, p.pos.x, p.pos.y).map((r, i) => <rect key={i} x={r.x} y={r.y} width={r.w} height={1.02}
              fill={r.s === SURF.land ? (mine ? "#ccff00" : "#fff") : r.s === SURF.deck ? "#c0894f" : "#b9844f"} />)}
            <rect x={p.pos.x + p.piece.land.x + p.land.w / 2 - 0.9} y={p.pos.y + p.piece.land.y + p.land.h / 2 - 0.9} width={1.8} height={1.8} fill={hex(st.color)} stroke="#000" strokeWidth={0.3} />
          </g>;
        })}
        {slots.map((s, i) => <g key={i} className={`slot ${hover === i ? "hot" : ""}`} onPointerEnter={() => setHover(i)} onPointerLeave={() => setHover(null)}
          onClick={() => credits >= s.price && onPick(s)}>
          {runs(me, s.x, s.y).map((r, j) => <rect key={j} x={r.x} y={r.y} width={r.w} height={1.02} />)}
        </g>)}
      </g>
      {slots.map((s, i) => { const cx = s.x + me.piece.w / 2, cy = s.y + me.piece.h / 2;
        return <text key={i} x={cx - cy} y={(cx + cy) / 2} className="slot-num" textAnchor="middle" dominantBaseline="middle">{i + 1}</text>; })}
    </svg>
    {slots.length > 0 && <div className="docks-slots">
      {slots.map((s, i) => <button type="button" key={i} disabled={credits < s.price} onPointerEnter={() => setHover(i)} onPointerLeave={() => setHover(null)} onFocus={() => setHover(i)} onClick={() => onPick(s)}>
        Spot {i + 1}<small>touches {s.touches.length} land{s.touches.length === 1 ? "" : "s"} · 🪙 {s.price}</small></button>)}
    </div>}
  </div>;
}
