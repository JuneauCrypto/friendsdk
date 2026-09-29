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

/** Public RPCs sometimes refuse a burst (rate limits, dropped connections): try again, slower. */
export async function withRetry<T>(fn: () => Promise<T>, delays = [700, 2_000, 5_000]): Promise<T> {
  for (let i = 0; ; i++) {
    try { return await fn(); } catch (e) { if (i >= delays.length) throw e; await new Promise(r => setTimeout(r, delays[i])); }
  }
}

export type OwnedLand = { id: bigint; gen: number; tier: number };

export async function readOwnedLands(owner: string, onProgress?: (done: number, total: number) => void): Promise<OwnedLand[]> {
  const c = client(), account = owner as Address;
  const block = await withRetry(() => c.getBlockNumber());
  // Public RPCs cap eth_getLogs block ranges (Robinhood Chain: 10,000,000), so query in windows.
  const logs = async (args: { to: Address } | { from: Address }) => {
    const W = 5_000_000n, all = [];
    for (let from = 0n; from <= block; from += W * 4n) {
      const parts = await Promise.all([0n, 1n, 2n, 3n].map(k => from + k * W).filter(f => f <= block).map(f =>
        withRetry(() => c.getLogs({ address: G, event: TRANSFER, fromBlock: f, toBlock: f + W - 1n < block ? f + W - 1n : block, strict: true, args }))));
      for (const p of parts) all.push(...p);
    }
    return all;
  };
  const inn = await logs({ to: account }), out = await logs({ from: account });   // one direction at a time: fewer requests at once
  const seen = new Map<string, (typeof inn)[number]>();
  for (const l of [...inn, ...out]) seen.set(`${l.blockNumber}:${l.logIndex}`, l);
  const held = new Set<bigint>();
  for (const l of [...seen.values()].sort((a, b) => a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1)) {
    if (l.args.to.toLowerCase() === owner.toLowerCase()) held.add(l.args.tokenId); else held.delete(l.args.tokenId);
  }
  const ids = [...held].sort((a, b) => (a < b ? -1 : 1));
  const manager = await withRetry(() => c.readContract({ address: G, abi: GEN_ABI, functionName: "activationManager", blockNumber: block }));
  const lands: OwnedLand[] = [];
  const BATCH = 250;
  for (let i = 0; i < ids.length; i += BATCH) {
    const chunk = ids.slice(i, i + BATCH);
    const res = await withRetry(() => c.multicall({ blockNumber: block, allowFailure: true, contracts: chunk.flatMap(id => [
      { address: G, abi: GEN_ABI, functionName: "generation", args: [id] } as const,
      { address: manager, abi: ACT_ABI, functionName: "positions", args: [G, id] } as const,
    ]) }));
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
