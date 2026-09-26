/* Reading an activated Friend straight from the Generations contract.
 *
 * tokenURI() returns JSON whose `image` is the Friend's fully on-chain isometric
 * SVG. We keep that artwork exactly as rendered and only derive geometry from it:
 * the land outline (`<path fill="url(#rf-floor)">`) and each object
 * (`<g data-prop="…" transform="translate(x y)">`), unprojected onto a tile grid so
 * lands can dock edge to edge and be walked. The SVG is shown through <img>
 * (scripts never run there) and is never inserted into the page DOM. */
import { createPublicClient, http, parseAbi, type PublicClient } from "viem";
import { GENERATION_SPRITE_MANIFEST } from "@rarefriends/friendsdk/sprites";

export type LandProp = { name: string; x: number; y: number };
export type Friend = {
  tokenId: bigint;
  w: number; h: number; tiles: boolean[];      // footprint in tiles (1 tile = 2 renderer units)
  blocked: boolean[];                            // tiles holding solid objects
  props: LandProp[];
  traits: Record<string, string | number>;
  /** Screen offset of the footprint's (0,0) tile corner inside the 512 × 512 artwork. */
  anchor: { x: number; y: number };
  art: string;                                   // data:image/svg+xml URL of the on-chain artwork (background removed)
  artWithoutPortrait: string;                    // same, with the standing Friend removed (used when it walks)
  signature: string;                             // changes whenever the on-chain art or traits change
  active: boolean;
};

// The on-chain renderer's isometric projection (same shallow projection as the SDK world renderer).
export const A = 0.8660254038, B = 0.28, UNIT = 6, UNITS_PER_TILE = 2;
/** Screen pixels (artwork scale) for a ground point in tiles. */
export const toScreen = (tx: number, ty: number) => {
  const ux = tx * UNITS_PER_TILE, uy = ty * UNITS_PER_TILE;
  return { x: A * UNIT * (ux - uy), y: B * UNIT * (ux + uy) };
};
export const fromScreen = (sx: number, sy: number) => {
  const u = sx / (A * UNIT), v = sy / (B * UNIT);
  return { x: (u + v) / 2 / UNITS_PER_TILE, y: (v - u) / 2 / UNITS_PER_TILE };
};
const unprojectUnits = (X: number, Y: number): [number, number] => {
  const u = X / (A * UNIT), v = Y / (B * UNIT);
  return [(u + v) / 2, (v - u) / 2];
};
const SOLID_EXEMPT = /tiny|sprout|flower|reeds/;

function pointInRings(x: number, y: number, rings: [number, number][][]) {
  let inside = false;                           // even-odd, matching fill-rule="evenodd"
  for (const ring of rings) for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Tiny stable hash for change detection. */
function hash(s: string) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); }

const toDataUrl = (svg: string) => `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`;

/** Remove the black backdrop (so lands can sit side by side) and, optionally, the standing Friend. */
function displaySvg(svg: string, withoutPortrait: boolean) {
  let out = svg.replace(/<rect width="512" height="512" fill="#000"\/>/, "");
  if (withoutPortrait && typeof DOMParser !== "undefined") {
    const doc = new DOMParser().parseFromString(out, "image/svg+xml");
    doc.getElementById("portrait")?.remove();
    out = new XMLSerializer().serializeToString(doc);
  }
  return out;
}

/** Derive the walkable footprint and objects from the on-chain SVG. */
export function parseFriendSvg(tokenId: bigint, svg: string, traits: Record<string, string | number>): Friend {
  const floorPath = /<path d="([^"]+)"[^>]*fill="url\(#rf-floor\)"/.exec(svg)?.[1];
  if (!floorPath) throw new Error(`Friend #${tokenId} has no land in its artwork.`);
  const scene = /<g transform="translate\(([-\d.]+)[ ,]([-\d.]+)\)"><g id="scene">/.exec(svg);
  const offX = scene ? Number(scene[1]) : 6, offY = scene ? Number(scene[2]) : 6;
  const rings: [number, number][][] = [];
  for (const sub of floorPath.split(/(?=M)/)) {
    const pts = [...sub.matchAll(/([\d.]+)[ ,]([\d.]+)/g)].map(m => unprojectUnits(Number(m[1]), Number(m[2])));
    if (pts.length >= 3) rings.push(pts);
  }
  const all = rings.flat();
  const minX = Math.min(...all.map(p => p[0])), minY = Math.min(...all.map(p => p[1]));
  const spanX = Math.max(...all.map(p => p[0])) - minX, spanY = Math.max(...all.map(p => p[1])) - minY;
  const upt = UNITS_PER_TILE;
  const w = Math.max(1, Math.ceil(spanX / upt - 0.01)), h = Math.max(1, Math.ceil(spanY / upt - 0.01));
  const local = rings.map(r => r.map(([x, y]) => [x - minX, y - minY] as [number, number]));
  const tiles = Array.from({ length: w * h }, (_, i) => pointInRings(((i % w) + 0.5) * upt, (Math.floor(i / w) + 0.5) * upt, local));
  if (!tiles.some(Boolean)) tiles.fill(true);
  const blocked = new Array(w * h).fill(false);
  const props: LandProp[] = [];
  for (const m of svg.matchAll(/data-prop="([^"]+)"[^>]*?transform="translate\(([-\d.]+)[ ,]([-\d.]+)\)/g)) {
    const [gx, gy] = unprojectUnits(Number(m[2]), Number(m[3]));
    const x = (gx - minX) / upt, y = (gy - minY) / upt;
    props.push({ name: m[1], x, y });
    const tx = Math.min(w - 1, Math.max(0, Math.floor(x))), ty = Math.min(h - 1, Math.max(0, Math.floor(y)));
    if (!SOLID_EXEMPT.test(m[1])) blocked[ty * w + tx] = true;
  }
  // screen position of the footprint origin inside the artwork = projected (minX, minY) + scene translate
  const anchor = { x: A * UNIT * (minX - minY) + offX, y: B * UNIT * (minX + minY) + offY };
  const sig = hash(`${traits.Generation}|${traits["Activation tier"]}|${traits.State}|${svg.length}|${hash(svg)}`);
  return { tokenId, w, h, tiles, blocked, props, traits, anchor,
    art: toDataUrl(displaySvg(svg, false)), artWithoutPortrait: toDataUrl(displaySvg(svg, true)),
    signature: sig, active: traits.State === "Active" };
}

const ABI = parseAbi(["function tokenURI(uint256 tokenId) view returns (string)", "function ownerOf(uint256 tokenId) view returns (address)"]);
let client: Pick<PublicClient, "readContract"> | null = null;
const rpc = () => client ??= createPublicClient({ transport: http(GENERATION_SPRITE_MANIFEST.rpcUrl, { retryCount: 1, timeout: 15_000 }) });
const b64 = (s: string) => new TextDecoder().decode(Uint8Array.from(atob(s), c => c.charCodeAt(0)));

/** Read one Friend's metadata and artwork from the Generations contract (public, read-only). */
export async function readFriend(tokenId: bigint): Promise<Friend> {
  const uri = await rpc().readContract({ address: GENERATION_SPRITE_MANIFEST.generations, abi: ABI, functionName: "tokenURI", args: [tokenId] }) as string;
  const comma = uri.indexOf(",");
  const meta = JSON.parse(uri.startsWith("data:application/json;base64,") ? b64(uri.slice(comma + 1)) : decodeURIComponent(uri.slice(comma + 1)));
  const traits: Record<string, string | number> = Object.fromEntries((meta.attributes ?? []).map((a: { trait_type: string; value: string | number }) => [a.trait_type, a.value]));
  const image: string = meta.image ?? "";
  const ic = image.indexOf(",");
  const svg = image.startsWith("data:image/svg+xml;base64,") ? b64(image.slice(ic + 1)) : decodeURIComponent(image.slice(ic + 1));
  if (traits.State !== "Active") {
    // Inactive Friends render as a still character, not a land: nothing to dock.
    throw Object.assign(new Error(`Friend #${tokenId} is not activated (state: ${traits.State ?? "unknown"}).`), { inactive: true });
  }
  return parseFriendSvg(tokenId, svg, traits);
}
export async function readOwner(tokenId: bigint): Promise<string> {
  const o = await rpc().readContract({ address: GENERATION_SPRITE_MANIFEST.generations, abi: ABI, functionName: "ownerOf", args: [tokenId] }) as string;
  return o.toLowerCase();
}

/* ── Official reward weight (rarefriends.com/docs/generations) ── */
export const REWARD_WEIGHT: Readonly<Record<number, readonly number[]>> = {
  1: [175000, 270000, 416250, 641250, 987187.5],
  2: [16000, 24375, 37125, 56531.25, 86062.5],
  3: [1450, 2212.5, 3375, 5146.875, 7846.875],
  4: [130, 198.75, 303.75, 464.0625, 708.75],
  5: [12, 18.375, 28.125, 43.03125, 65.8125],
  6: [1.1, 1.6875, 2.5875, 3.965625, 6.075],
};
export function rewardWeight(f: Friend) {
  const g = Number(f.traits.Generation), t = Number(f.traits["Activation tier"] ?? 0);
  return REWARD_WEIGHT[g]?.[Math.max(0, Math.min(4, t))] ?? 0;
}
