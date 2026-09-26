/* Your Friends, found automatically: every activated Friend held by the same wallet as the
 * Friend you're playing. Read-only and account-filtered, the same way the SDK runtime's own
 * picker finds Friends (owner-filtered Transfer history, no collection scan), then one
 * batched read per 250 Friends for generation and activation tier. Scales to 10,000+. */
import { createPublicClient, http, parseAbi, parseAbiItem, type Address } from "viem";
import { GENERATION_SPRITE_MANIFEST } from "@rarefriends/friendsdk/sprites";

const G = GENERATION_SPRITE_MANIFEST.generations as Address;
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11" as const;
const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)");
const GEN_ABI = parseAbi([
  "function generation(uint256) view returns (uint8)",
  "function activationManager() view returns (address)",
  "function balanceOf(address) view returns (uint256)",
]);
const ACT_ABI = parseAbi(["function positions(address, uint256) view returns (uint8 tier, uint256 amount)"]);
const client = () => createPublicClient({
  chain: { id: GENERATION_SPRITE_MANIFEST.chainId, name: "Robinhood", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [GENERATION_SPRITE_MANIFEST.rpcUrl] } }, contracts: { multicall3: { address: MULTICALL3 } } },
  transport: http(GENERATION_SPRITE_MANIFEST.rpcUrl, { retryCount: 2, timeout: 30_000 }),
});

export type OwnedLand = { id: bigint; gen: number; tier: number };

export async function readOwnedLands(owner: string, onProgress?: (done: number, total: number) => void): Promise<OwnedLand[]> {
  const c = client(), account = owner as Address;
  const block = await c.getBlockNumber();
  const q = { address: G, event: TRANSFER, fromBlock: 0n, toBlock: block, strict: true } as const;
  const [inn, out] = await Promise.all([c.getLogs({ ...q, args: { to: account } }), c.getLogs({ ...q, args: { from: account } })]);
  const seen = new Map<string, (typeof inn)[number]>();
  for (const l of [...inn, ...out]) seen.set(`${l.blockNumber}:${l.logIndex}`, l);
  const held = new Set<bigint>();
  for (const l of [...seen.values()].sort((a, b) => a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1)) {
    if (l.args.to.toLowerCase() === owner.toLowerCase()) held.add(l.args.tokenId); else held.delete(l.args.tokenId);
  }
  const ids = [...held].sort((a, b) => (a < b ? -1 : 1));
  const manager = await c.readContract({ address: G, abi: GEN_ABI, functionName: "activationManager", blockNumber: block });
  const lands: OwnedLand[] = [];
  const BATCH = 250;
  for (let i = 0; i < ids.length; i += BATCH) {
    const chunk = ids.slice(i, i + BATCH);
    const res = await c.multicall({ blockNumber: block, allowFailure: true, contracts: chunk.flatMap(id => [
      { address: G, abi: GEN_ABI, functionName: "generation", args: [id] } as const,
      { address: manager, abi: ACT_ABI, functionName: "positions", args: [G, id] } as const,
    ]) });
    chunk.forEach((id, k) => {
      const g = res[k * 2], p = res[k * 2 + 1];
      if (g.status !== "success" || p.status !== "success") return;
      const gen = Number(g.result), [tier, amount] = p.result as readonly [number, bigint];
      if (gen >= 1 && amount > 0n) lands.push({ id, gen, tier: Number(tier) });
    });
    onProgress?.(Math.min(ids.length, i + BATCH), ids.length);
  }
  return lands;
}
