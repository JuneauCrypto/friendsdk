/* How a flag looks, by its population level (its skin tier). Islands on their own stay the
 * default black and white; a flag's islands take on its colour, faint for a small flag and
 * richer with every level, and bigger flags get bigger walls: a wooden palisade, stone walls,
 * a medieval citadel with towers and banners, then glowing sci-fi fortress cities. Joining a
 * flag and growing it is how an island gets colour. */
export const LOOK_NAMES = ["Black & white", "First colour", "Painted", "Rich colour", "Full colour", "Neon"];

/** Hue (degrees) of a #rrggbb colour. */
export function hueOf(hex: string) {
  const n = parseInt(hex.slice(1), 16), r = (n >> 16 & 255) / 255, g = (n >> 8 & 255) / 255, b = (n & 255) / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn; if (!d) return 0;
  const h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}
/** `level` −1: an island in no flag (black and white). 0: a flag under 100 Friends. 1–5+: skin tiers. */
export function landFilter(level: number, color: string) {
  if (level < 0) return undefined;
  const L = Math.min(5, level), hue = Math.round(hueOf(color) - 60);           // sepia then saturate lands about 60° round the wheel
  const bright = [0.94, 0.88, 0.84, 0.8, 0.78, 0.8][L], sat = [0.9, 1.6, 2.6, 3.8, 4.6, 5.2][L], sepia = [0.55, 1, 1, 1, 1, 1][L];
  const glow = L >= 4 ? ` drop-shadow(0 0 ${L === 4 ? 1.5 : 2.5}px ${color})` : "";
  return `brightness(${bright}) sepia(${sepia}) hue-rotate(${hue}deg) saturate(${sat})${glow}`;
}
/** Flowers in the gardens: grey on your own, the flag's colour and friends with every level. */
export function flowerColors(level: number, color: string) {
  if (level < 0) return ["#bdbdbd", "#8a8a8a", "#e0e0e0"];
  const extra = ["#ff5c8a", "#ffd23f", "#7ae582", "#5ec8ff", "#c77dff", "#ff8c42"];
  return [color, ...extra.slice(0, Math.min(extra.length, 1 + level))];
}
/** Gardens per Friend on an island: a few on your own, more in bigger flags. */
export const gardenOdds = (level: number) => level < 0 ? 0.18 : Math.min(0.75, 0.3 + level * 0.1);
/** Small deterministic hash. */
export const hash = (s: string) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };

/* Tinted artwork, baked into the SVG itself (a colour matrix on the whole land, gardens on top)
 * and cached per look, instead of a CSS filter on every land every frame. */
const tinted = new Map<string, string>();
const TINT_MAX = 400;
const hexRgb = (hex: string) => { const n = parseInt(hex.slice(1), 16); return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255]; };
/** How strongly a level colours its lands (0..1) and whether dark parts glow in the colour. */
const STRENGTH = [0.2, 0.38, 0.55, 0.72, 0.85, 0.95];
function tintMatrix(level: number, color: string) {
  const L = Math.min(5, level), s = STRENGTH[L], c = hexRgb(color), rows: string[] = [];
  for (let i = 0; i < 3; i++) {
    const hi = 1 + (c[i] - 1) * s, lo = L >= 4 ? c[i] * (L === 4 ? 0.2 : 0.32) : 0, k = hi - lo;
    rows.push(`${(k * 0.2126).toFixed(4)} ${(k * 0.7152).toFixed(4)} ${(k * 0.0722).toFixed(4)} 0 ${lo.toFixed(4)}`);
  }
  return `${rows.join(" ")} 0 0 0 1 0`;
}
export type GardenSpot = { x: number; y: number; colors: string[]; seed: number; gardener: boolean; motion: boolean };
/** A 2 × 2-tile flower bed at (x, y) in the artwork's pixels, with an optional gardener at work. */
function gardenSvg(g: GardenSpot, P: (x: number, y: number) => { x: number; y: number }) {
  const at = (x: number, y: number) => { const s = P(x, y); return `${(g.x + s.x * 1.5).toFixed(1)} ${(g.y + s.y * 1.5).toFixed(1)}`; };
  let out = `<path d="M${at(-1, -1)}L${at(1, -1)}L${at(1, 1)}L${at(-1, 1)}Z" fill="#3b2a1e" stroke="#000" stroke-width=".7"/>`;
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    const s = P(-0.6 + i * 0.6, -0.6 + j * 0.6), x = g.x + s.x * 1.5, y = g.y + s.y * 1.5 - 1.8, col = g.colors[(g.seed * 7 + i * 5 + j * 3) % g.colors.length];
    out += `<rect x="${(x - 0.7).toFixed(1)}" y="${y.toFixed(1)}" width="1.4" height="2.4" fill="#2e7d32"/><rect x="${(x - 1.6).toFixed(1)}" y="${(y - 2.1).toFixed(1)}" width="3.2" height="2.7" fill="${col}"/>`;
  }
  if (g.gardener) {
    const gx = g.x + (g.seed % 2 ? 19 : -22), gy = g.y - 9, hoe = `${gx + 2.7} ${gy - 7.5}`;
    out += `<g><rect x="${gx - 2.2}" y="${gy - 10.5}" width="4.4" height="1.8" fill="${g.colors[0]}" stroke="#000" stroke-width=".4"/><rect x="${gx - 1.5}" y="${gy - 8.7}" width="3" height="3" fill="#fff" stroke="#000" stroke-width=".4"/>` +
      `<rect x="${gx - 2.2}" y="${gy - 5.7}" width="4.4" height="6" fill="#000"/><rect x="${gx - 2.2}" y="${gy + 0.3}" width="1.5" height="3" fill="#000"/><rect x="${gx + 0.7}" y="${gy + 0.3}" width="1.5" height="3" fill="#000"/>` +
      `<g><rect x="${gx + 2.2}" y="${gy - 7.5}" width="1" height="10.5" fill="#000"/><rect x="${gx + 0.3}" y="${gy + 2.4}" width="3.6" height="1.2" fill="#000"/>` +
      (g.motion ? `<animateTransform attributeName="transform" type="rotate" values="0 ${hoe};-28 ${hoe};0 ${hoe}" dur="1.2s" repeatCount="indefinite"/>` : "") + `</g></g>`;
  }
  return out;
}
/** The artwork for a land at a look: `level` −1 and no garden gives the original back. */
export function lookArt(src: string, key: string, level: number, color: string, garden: GardenSpot | null, P: (x: number, y: number) => { x: number; y: number }) {
  if (level < 0 && !garden) return src;
  const k = `${key}|${level}|${color}|${garden ? `${garden.x.toFixed(0)},${garden.y.toFixed(0)},${garden.seed},${garden.gardener},${garden.motion},${garden.colors.join("")}` : ""}`;
  const hit = tinted.get(k); if (hit) { tinted.delete(k); tinted.set(k, hit); return hit; }
  const comma = src.indexOf(","), head = src.slice(0, comma);
  let svg: string;
  try { svg = head.endsWith(";base64") ? decodeURIComponent(escape(atob(src.slice(comma + 1)))) : decodeURIComponent(src.slice(comma + 1)); } catch { return src; }
  const open = svg.indexOf(">", svg.indexOf("<svg")) + 1, close = svg.lastIndexOf("</svg>");
  if (open <= 0 || close < open) return src;
  const body = svg.slice(open, close);
  const tintedBody = level < 0 ? body : `<defs><filter id="rf-look" x="0" y="0" width="1" height="1" color-interpolation-filters="sRGB"><feColorMatrix type="matrix" values="${tintMatrix(level, color)}"/></filter></defs><g filter="url(#rf-look)">${body}</g>`;
  const out = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg.slice(0, open) + tintedBody + (garden ? gardenSvg(garden, P) : "") + "</svg>")))}`;
  tinted.set(k, out);
  if (tinted.size > TINT_MAX) tinted.delete(tinted.keys().next().value!);
  return out;
}

/** A colour turned `deg` degrees round the colour wheel (for each island's own accent). */
export function shiftHue(hex: string, deg: number) {
  const [r, g, b] = hexRgb(hex), mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
  if (!d) return hex;
  const s = d / (1 - Math.abs(2 * l - 1)), h = (hueOf(hex) + deg + 360) % 360;
  const C = (1 - Math.abs(2 * l - 1)) * s, X = C * (1 - Math.abs((h / 60) % 2 - 1)), m = l - C / 2;
  const [a, b2, c] = h < 60 ? [C, X, 0] : h < 120 ? [X, C, 0] : h < 180 ? [0, C, X] : h < 240 ? [0, X, C] : h < 300 ? [X, 0, C] : [C, 0, X];
  return `#${[a, b2, c].map(v => Math.round((v + m) * 255).toString(16).padStart(2, "0")).join("")}`;
}
/** An island's own look inside its flag: the flag's level, one brighter for an upgraded island
 *  (a City or Capital by reward weight, or one with 2+ items built), one more for both; and its
 *  own accent, a little round the colour wheel from the flag's colour. */
export function islandLook(flagLevel: number, flagColor: string, rankIndex: number, items: number, id: string) {
  const up = (rankIndex >= 4 ? 1 : 0) + (items >= 2 ? 1 : 0);
  return { level: Math.min(5, flagLevel + up), up, color: shiftHue(flagColor, [-30, -15, 0, 15, 30][hash(id) % 5]) };
}
