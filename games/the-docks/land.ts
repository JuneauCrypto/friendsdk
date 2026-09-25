/* Importing an activated Friend's on-chain land.
 *
 * An activated Rare Friends Generations token renders its world fully on chain:
 * tokenURI() returns JSON whose `image` is an isometric SVG. That SVG carries the
 * land outline (`<path fill="url(#rf-floor)">`) and every placed object as
 * `<g data-prop="…" transform="translate(x y) scale(…)">`. We parse those — never
 * insert the SVG into the DOM — and unproject them onto a tile grid so the same
 * land, with everything already on it, can be walked in 3D. */
import { createPublicClient, http, parseAbi } from "viem";
import { GENERATION_SPRITE_MANIFEST } from "@rarefriends/friendsdk/sprites";

export type LandProp = { name: string; x: number; y: number; scale: number; flip: boolean };
export type Land = {
  w: number; h: number; tiles: boolean[]; props: LandProp[];
  floor: string; scenery: string; source: "chain" | "sample" | "fallback";
  traits: Record<string, string | number>; image?: string;
};

// Isometric projection used by the on-chain renderer (same shallow projection as the SDK world renderer).
const A = 0.8660254038, B = 0.28, UNIT = 6;
const unproject = (X: number, Y: number): [number, number] => {
  const u = X / (A * UNIT), v = Y / (B * UNIT);
  return [(u + v) / 2, (v - u) / 2];
};
export const MAX_W = 20, MAX_H = 18;          // tiles available for a land inside a berth

function pointInRings(x: number, y: number, rings: [number, number][][]) {
  let inside = false;                           // even-odd rule, matching fill-rule="evenodd"
  for (const ring of rings) for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Parse the on-chain land SVG into a tile footprint and prop list. */
export function parseLandSvg(svg: string, traits: Record<string, string | number> = {}): Land {
  const floorPath = /<path d="([^"]+)"[^>]*fill="url\(#rf-floor\)"/.exec(svg)?.[1];
  if (!floorPath) throw new Error("No land outline in this Friend's artwork.");
  const rings: [number, number][][] = [];
  for (const sub of floorPath.split(/(?=M)/)) {
    const pts = [...sub.matchAll(/([\d.]+)[ ,]([\d.]+)/g)].map(m => unproject(Number(m[1]), Number(m[2])));
    if (pts.length >= 3) rings.push(pts);
  }
  const all = rings.flat();
  const minX = Math.min(...all.map(p => p[0])), minY = Math.min(...all.map(p => p[1]));
  const spanX = Math.max(...all.map(p => p[0])) - minX, spanY = Math.max(...all.map(p => p[1])) - minY;
  // 2 renderer units per tile (a 4-unit chunk = 2 × 2 tiles); larger lands are scaled to fit a berth.
  const upt = Math.max(2, spanX / MAX_W, spanY / MAX_H);
  const w = Math.max(1, Math.round(spanX / upt)), h = Math.max(1, Math.round(spanY / upt));
  const local = rings.map(r => r.map(([x, y]) => [x - minX, y - minY] as [number, number]));
  const tiles = Array.from({ length: w * h }, (_, i) => pointInRings(((i % w) + 0.5) * upt, (Math.floor(i / w) + 0.5) * upt, local));
  if (!tiles.some(Boolean)) tiles.fill(true);
  const props: LandProp[] = [];
  for (const m of svg.matchAll(/data-prop="([^"]+)"[^>]*?transform="translate\(([-\d.]+)[ ,]([-\d.]+)\)(?: scale\(([-\d.]+)(?:[ ,]([-\d.]+))?\))?"/g)) {
    const [gx, gy] = unproject(Number(m[2]), Number(m[3]));
    const sx = Number(m[4] ?? 1);
    props.push({ name: m[1], x: Math.min(w - 0.3, Math.max(0.3, (gx - minX) / upt)), y: Math.min(h - 0.3, Math.max(0.3, (gy - minY) / upt)),
      scale: Math.abs(sx) || 1, flip: sx < 0 });
  }
  return { w, h, tiles, props, floor: String(traits.Floor ?? "Plain"), scenery: String(traits.Scenery ?? ""), source: "chain", traits };
}

const TOKEN_URI_ABI = parseAbi(["function tokenURI(uint256 tokenId) view returns (string)"]);

/** Read the selected Friend's land from the Generations contract (read-only public RPC). */
export async function readChainLand(friendId: bigint, signal?: AbortSignal): Promise<Land> {
  const client = createPublicClient({ transport: http(GENERATION_SPRITE_MANIFEST.rpcUrl, { retryCount: 1, timeout: 15_000 }) });
  const uri = await client.readContract({ address: GENERATION_SPRITE_MANIFEST.generations, abi: TOKEN_URI_ABI, functionName: "tokenURI", args: [friendId] });
  if (signal?.aborted) throw new Error("aborted");
  const b64 = (s: string) => new TextDecoder().decode(Uint8Array.from(atob(s), c => c.charCodeAt(0)));
  const comma = uri.indexOf(",");
  const meta = JSON.parse(uri.startsWith("data:application/json;base64,") ? b64(uri.slice(comma + 1)) : decodeURIComponent(uri.slice(comma + 1)));
  const traits: Record<string, string | number> = Object.fromEntries((meta.attributes ?? []).map((a: { trait_type: string; value: string | number }) => [a.trait_type, a.value]));
  const image: string = meta.image ?? "";
  const ic = image.indexOf(",");
  const svg = image.startsWith("data:image/svg+xml;base64,") ? b64(image.slice(ic + 1)) : decodeURIComponent(image.slice(ic + 1));
  if (traits.State && traits.State !== "Active") throw new Error("This Friend isn't activated yet, so it has no land.");
  const land = parseLandSvg(svg, traits);
  // Only a data: SVG from the collection contract is kept, for display in an <img> (scripts never run there).
  if (image.startsWith("data:image/svg+xml")) land.image = image;
  return land;
}

/* ── Sample lands for fictional neighbours (same chunk style as real lands) ── */
const SCENERY_PROPS: Record<string, string[]> = {
  Garden: ["tree", "tree", "sprout", "bench", "rock", "flower"],
  Coastal: ["buoy", "buoy-tiny", "reeds", "crate-tiny", "reeds"],
  Rooftop: ["tank", "vent", "vent-tiny", "antenna", "flower", "bench"],
  Mineral: ["crystal", "crystal-tiny", "rock", "crystal", "rock"],
  Reading: ["bookcase", "book-stack", "book-stack-tiny", "bench"],
  Industrial: ["tank", "terminal", "pipe", "crate-tiny"],
};
export function sampleLand(seed: number, scenery: string, floor: string, chunksW = 7, chunksH = 6): Land {
  let s = seed | 0 || 1;
  const rand = () => { s = (s * 1664525 + 1013904223) | 0; return ((s >>> 8) & 0xffffff) / 0x1000000; };
  const cw = chunksW, ch = chunksH, grid = new Array(cw * ch).fill(false);
  // grow a connected blob of 2 × 2-tile chunks from the centre
  const start = Math.floor(ch / 2) * cw + Math.floor(cw / 2); grid[start] = true;
  const target = Math.floor(cw * ch * 0.62);
  for (let n = 1, guard = 0; n < target && guard < 5000; guard++) {
    const i = Math.floor(rand() * grid.length); if (grid[i]) continue;
    const x = i % cw, y = Math.floor(i / cw);
    if ([[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => grid[(y + dy) * cw + x + dx] && x + dx >= 0 && x + dx < cw && y + dy >= 0 && y + dy < ch)) { grid[i] = true; n++; }
  }
  const w = cw * 2, h = ch * 2, tiles = Array.from({ length: w * h }, (_, i) => grid[Math.floor(Math.floor(i / w) / 2) * cw + Math.floor((i % w) / 2)]);
  const vocab = SCENERY_PROPS[scenery] ?? SCENERY_PROPS.Garden;
  const props: LandProp[] = [];
  const cells = grid.map((g, i) => g ? i : -1).filter(i => i >= 0 && i !== start);
  for (let k = 0; k < Math.min(5, cells.length); k++) {
    const c = cells.splice(Math.floor(rand() * cells.length), 1)[0];
    const name = vocab[k % vocab.length];
    props.push({ name, x: (c % cw) * 2 + 1, y: Math.floor(c / cw) * 2 + 1, scale: 0.9, flip: rand() > 0.5 });
  }
  return { w, h, tiles, props, floor, scenery, source: "sample", traits: { Scenery: scenery, Floor: floor } };
}
