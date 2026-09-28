import { isAddress, parseAbi, type Address, type PublicClient } from "viem";
import { GENERATION_SPRITE_MANIFEST } from "./generation-sprites.js";
import type { GenerationDeployment } from "./identity.js";

/**
 * Display-only details for the Friend picker: activation tier, Rare Friends reward rate and
 * on-chain artwork. These never gate play (eligibility stays generation ≥ 1, checked fresh by
 * the runtime); they only help a player recognize and order their Friends.
 */
export type FriendRank = Readonly<{ id: bigint; tier: number | null; rate: number }>;
export type FriendRanksClient = Pick<PublicClient, "readContract">;

/** Rare Friends reward weight by generation (1–6) and activation tier (0–4). */
export const FRIEND_REWARD_RATE: Readonly<Record<number, readonly number[]>> = Object.freeze({
  1: [175000, 270000, 416250, 641250, 987187.5],
  2: [16000, 24375, 37125, 56531.25, 86062.5],
  3: [1450, 2212.5, 3375, 5146.875, 7846.875],
  4: [130, 198.75, 303.75, 464.0625, 708.75],
  5: [12, 18.375, 28.125, 43.03125, 65.8125],
  6: [1.1, 1.6875, 2.5875, 3.965625, 6.075],
});

export function friendRewardRate(generation: number, tier: number | null) {
  if (tier === null) return 0;
  return FRIEND_REWARD_RATE[generation]?.[Math.max(0, Math.min(4, tier))] ?? 0;
}

const GEN_ABI = parseAbi([
  "function activationManager() view returns (address)",
  "function tokenURI(uint256 tokenId) view returns (string)",
]);
const ACT_ABI = parseAbi(["function positions(address collection, uint256 tokenId) view returns (uint8 tier, uint256 amount)"]);

/**
 * Activation tier and reward rate for each Friend (null tier: not activated or unreadable).
 * Best effort: a failed read ranks that Friend as unactivated instead of failing discovery.
 */
export async function readFriendRanks(
  client: FriendRanksClient, friends: readonly Readonly<{ id: bigint; generation: number }>[],
  options: Readonly<{ deployment?: GenerationDeployment; blockNumber?: bigint; signal?: AbortSignal }> = {},
): Promise<readonly FriendRank[]> {
  const generations = (options.deployment ?? GENERATION_SPRITE_MANIFEST).generations;
  const at = options.blockNumber === undefined ? {} : { blockNumber: options.blockNumber };
  let manager: Address | null = null;
  try {
    manager = await client.readContract({ address: generations, abi: GEN_ABI, functionName: "activationManager", ...at }) as Address;
    if (!isAddress(manager) || /^0x0{40}$/i.test(manager)) manager = null;
  } catch { /* no activation data: everyone ranks by generation */ }
  const out: FriendRank[] = [];
  for (let i = 0; i < friends.length; i += 16) {
    options.signal?.throwIfAborted();
    out.push(...await Promise.all(friends.slice(i, i + 16).map(async ({ id, generation }) => {
      let tier: number | null = null;
      if (manager) {
        try {
          const [t, amount] = await client.readContract({ address: manager, abi: ACT_ABI, functionName: "positions", args: [generations, id], ...at }) as readonly [number, bigint];
          if (amount > 0n && Number.isInteger(Number(t))) tier = Math.max(0, Math.min(4, Number(t)));
        } catch { /* unreadable: unactivated */ }
      }
      return Object.freeze({ id, tier, rate: friendRewardRate(generation, tier) });
    })));
  }
  return Object.freeze(out);
}

/** Highest reward rate first; then earlier generation, then lower ID. */
export function compareFriendRank(
  a: Readonly<{ id: bigint; generation?: number; rate?: number }>, b: Readonly<{ id: bigint; generation?: number; rate?: number }>,
) {
  const r = (b.rate ?? 0) - (a.rate ?? 0);
  if (r) return r;
  const g = (a.generation ?? 99) - (b.generation ?? 99);
  if (g) return g;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

const MAX_URI = 3_000_000;
const b64 = (s: string) => new TextDecoder().decode(Uint8Array.from(atob(s), c => c.charCodeAt(0)));

/**
 * The Friend's on-chain artwork (tokenURI image) as an image data URL, or null. Shown in an
 * <img>, so scripts inside the SVG never run.
 */
export async function readFriendArt(client: FriendRanksClient, id: bigint, deployment?: GenerationDeployment): Promise<string | null> {
  try {
    const uri = await client.readContract({ address: (deployment ?? GENERATION_SPRITE_MANIFEST).generations, abi: GEN_ABI, functionName: "tokenURI", args: [id] }) as string;
    if (typeof uri !== "string" || uri.length > MAX_URI) return null;
    const comma = uri.indexOf(",");
    const json = uri.startsWith("data:application/json;base64,") ? b64(uri.slice(comma + 1))
      : uri.startsWith("data:application/json") ? decodeURIComponent(uri.slice(comma + 1)) : null;
    if (!json) return null;
    const image = (JSON.parse(json) as { image?: unknown }).image;
    if (typeof image !== "string" || !/^data:image\/(svg\+xml|png|webp|gif|jpeg)[;,]/.test(image)) return null;
    return image;
  } catch {
    return null;
  }
}
