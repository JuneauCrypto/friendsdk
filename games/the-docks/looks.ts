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
