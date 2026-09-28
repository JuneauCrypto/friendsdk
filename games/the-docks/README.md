# The Docks

A place for all Rare Friends, built from **floating islands**. Every activated Friend is
a small floating island, exactly as its fully on-chain artwork renders. Join Friends
together and they make one big island; a holder's Friends can move as one island or be
**deployed to different islands**. **The only NFTs are the activated Friends**: an island
is a saved layout that belongs to the wallet that built it, and it can't be sold.

- **Arranging is the game.** Move your Friends around your island as a draft, then
  **Save on chain**: every Friend whose spot changed costs RF (Gen 1: 100 · Gen 2: 50 ·
  Gen 3: 20 · Gen 4: 10 · Gen 5: 5 · Gen 6: 1 RF) plus gas, paid into a pool. Unmoved Friends are free;
  **Undo** returns to the last save. Each Friend must touch another along part of a side.
- **Holes.** If a saved Friend leaves the wallet (sending it clears its activation) or is
  deactivated, its spot becomes a **hole** in the island. The hole stays, reserved, until
  that Friend comes back (it heals for free) or the owner fills it with another activated
  Friend **of the same generation** (normal arrange fee).
- **Docking.** Islands float on one shared berth grid: **one island per berth whatever its
  size**, so the docks grow with the number of islands, not their size. Dock at a free
  **loading zone** next to another island; neighbours are joined by a **gangway**. Docking
  and moving an island cost only gas.
- **Bridges.** Can't dock next to an island you want? Build a **bridge** to it for
  **10 RF per berth** of distance, into a pool. It lasts until either island moves.
- **Access (flags only, for now).** You walk across every island of your flag; visitors
  can bridge over to a flag's islands just to explore.
- **Your whole wallet, automatically.** Every activated Friend in the same wallet joins,
  from 1 to 10,000+. The game keeps re-checking the chain, so **upgrades show up** and
  sold or deactivated Friends leave.
- **Control any Friend.** Tap a Friend to control it, break it (and those behind it) off a
  line, promote it to primary leader and call everyone to it, or walk solo. Each island's
  **captain** (the Friend you pick in "Choose your captain" when you first connect) is set once on chain and is who you board as.
  The SDK picker ("Choose your captain") lists your Friends in one column with artwork, generation, activation tier and Rare Friends reward rate, highest rate first; it remembers your choice for that wallet, so returning players go straight in.
- **Tokens.** Every Friend is its own wallet (its canonical token-bound account): launch a token from your island for 1,000 RF
  with airdrops and an RF-priced claim pool.
- **No burning.** Every fee goes into a permanent RF/ETH pool (your village's, or the shared
  Docks pool). Trading through the pools earns fees that buy RF: half back into the pool,
  half to build with. Platform fee: 0% to start, never above 5%.

Everything economic is **simulated** in this preview; the contracts are below.

Built with **FriendSDK v0.1.2** (CLI game layout) and viem (read-only contract
reads). No renderer library: the on-chain SVGs are the scene.

## Run it

From the FriendSDK root:

```sh
npm ci && npm run build
npm run dev:game -- games/the-docks            # http://localhost:4173
npx friendsdk build games/the-docks            # static site in games/the-docks/.friendsdk/
npx friendsdk check games/the-docks
node games/the-docks/browser-test.mjs desktop  # or: phone · desktop --fail-import
```

Requires a browser wallet on **Robinhood mainnet (chain 4663)** holding an
activated Rare Friends Generations NFT. On phones, open the preview in a wallet
app's built-in browser (the SDK has no WalletConnect).

## How it works

| Piece | Behaviour |
| --- | --- |
| **Art** | `tokenURI(id)` on Generations (`0x14C4…181D`) → metadata → the on-chain isometric SVG, shown through `<img>` unchanged apart from removing its black backdrop (so lands sit side by side) and, for the Friend you walk as, the standing figure (it walks instead). |
| **Footprint** | Parsed from the same SVG: the land outline (`fill="url(#rf-floor)"`) and objects (`data-prop`), unprojected with the renderer's projection (a = 0.866, b = 0.28) onto a tile grid at true size (2 renderer units per tile). Solid objects block walking. |
| **Holes** | When the minute check finds a saved Friend gone from the wallet (or deactivated), its spot turns into a hole (drawn dark with a red dashed edge). 🏝 Islands lists holes with a **Fill with…** picker (same generation only; the Friend that left fills its own hole for free). It heals by itself if that Friend returns. ⚙️ More → *Preview: a Friend leaves your wallet* shows the flow without sending anything. |
| **Islands** | Each island has its own grid of 4 × 4-tile cells; Friends cover whole cells at true size (Gen 1 = 30 tiles … Gen 6 = 4), and rounding becomes boardwalk. 🏝 Islands → switch islands, **＋ New island**, and deploy any Friend to another island from its row. |
| **Docking** | ⚓ Docks → the berth map: one square per island, glowing loading zones next to docked islands. Pick one to dock or move (gas only). Islands are drawn centred in their berth with water between; neighbours are joined by a gangway you can walk. |
| **Bridges** | On the berth map, tap an island you aren't next to (or **Bridge to …**): 10 RF per berth of distance, into a pool. The bridge is a walkway over the water and lasts until either island moves. |
| **Access** | For now only islands under a flag can be walked onto: every island of your flag, plus, as a visitor who can only explore, a flag's islands once your island is docked next to or bridged to one of them. Islands with no flag are closed to visitors. |
| **Your whole wallet** | `roster.ts` reads the wallet that holds your Friend (`ownerOf`), its owner-filtered `Transfer` history (the same account-filtered method the SDK runtime's picker uses; no collection scan) and then generation + activation tier for every held Friend through Multicall3, 250 per call. Inactive Friends are left out. Re-run every minute, so bought, sold, activated or upgraded Friends join, leave or update. Adding by number stays as a fallback. |
| **Arrange** | ✥ Arrange → tap any Friend on the island (or **Next ▸**) and step it one cell (↖ ↗ ↙ ↘ or arrow keys); **Pick several** to move a group together, **All** for the whole island shape (moving the whole shape together costs nothing). Stepping onto a same-size neighbour swaps them, so packed islands can be reshuffled. **Auto-arrange** packs the island into one connected block. **Done** / **Save** refuse an island where a Friend doesn't touch another along part of a side. The bar shows how many Friends moved and the RF that saving burns. |
| **Scale** | Layout needs no artwork: footprints come from generation. Occupancy is per 4 × 4-tile cell. Only Friends near the camera are drawn; their on-chain art loads lazily (6 at a time, 500 kept in memory). The crew shows up to 24 walkers. Tested with 10,002 Friends on desktop and phone. |
| **Chain checks** | Every 60 s and on **Check**: re-read every Friend's tokenURI; if its art or traits changed (e.g. tier upgrade) the art, footprint and rank update. Deactivated Friends leave the docks; Friends no longer held by your wallet leave your plot. |
| **Control & crew** | You control one Friend; the rest stand on their land. **Tap (or click) any of your Friends** on its land or walking in a line for quick options: **🎮 Control** it (a Friend taken out of a line breaks off from its leader), **✂ Break off crew** (it and everyone behind it in the line go with it), **📣 Call** it to the primary leader, **🏠 Send home**, **☑ Pick**, **⭐ Captain**. 👥 Crew → **🔄 Change Friend** (list), **📣 Call all** (to the primary leader), **⭐ Make primary leader** (for a Friend you control on its own), **🚶 Walk solo**, Call / Leave picked, Everyone wait, All go home. **Captain:** each island has one (`DocksIslands.setDefaultLeader`, on chain; simulated here): you pick it the first time you board and control it every time after; change it in 🏝 Islands. |
| **Flags** *(simulated)* | 🚩 Flags → name it, set your first lock and **Plant flag** where your lead stands on a saved, docked island. The flag rises as RF is locked in: **anyone** can **Lock RF** until **1,000,000 RF** (a contract setting); each locker holds a **soulbound founder mark**. Not full in 30 days → refunds. Full → **Found** (anyone). **Every RF in** (flag, enrollment): half permanent one-sided RF/ETH liquidity, half the payer's **allowance** (founders: half their lock; enrollees: half their fee), spent only on items for their village island. Nothing can be withdrawn, so a village can't be rugged. **People:** everyone brings **one island** (the seat; founders free; others **enroll** for 10,000 RF). Open enrollment for 7 days, then by vote (keep open · new price · close · cap the population; a new price or cap is picked in a 24-hour vote between three). A population cap also stops new Friends being added. **Votes:** every Friend on a member's island is a vote, founders' × (1 + their share of the pool); enrollment fees dilute founders. **Staying:** a Friend that leaves a village island (moved, or sent to another wallet: its spot is burned and the population drops by one) stays **bound** to that village until the next **epoch** (21 days): it can't be used in another village, and an island it lands on can't join one, until then; the same Friend can come back to its spot if the population allows. Leaving takes a **removal request**, carried out at the next epoch, no RF back; unspent allowance goes to the liquidity. **Items:** 🏮 Lantern 1k · 🏪 Market stall 10k · ⛲ Fountain 25k · 🗼 Watchtower 50k RF, built where your lead stands, with build times (1 h to 7 days) you can **boost** with RF (36 s per RF). Village items (from your allowance) belong to the village; when their island leaves they're **raffled** (100 RF tickets, members who stayed; winner keeps it). Your own items (your RF) are always yours to place and take off. Every RF from items, tickets and boosts goes to the village's liquidity (or the shared Docks pool if the island has no village). **Harvest** (members): trading fees buy RF: half back into the pool, the rest shared by Friend count as allowances. ⏩ buttons skip time in the preview. Rare Friends marketplace items plug in here once their team confirms how items can be placed. |
| **Tokens** *(simulated)* | 🚀 Tokens → launch: name, ticker, supply; airdrop scope and amount; claim pool, per-claim amount, claim price. Costs **1,000 RF**, into the island's village pool, or the shared Docks pool. Airdrops and claims land in each Friend's own wallet. Every claim pays the launch's RF price into the same pool. A sample plot's `$MKT` is there to claim. |
| **Rank** | Sum of the official reward weight (Generation × Activation tier, per rarefriends.com/docs/generations) of a plot's Friends: Speck 0+ · Hamlet 5+ · Village 50+ · Town 500+ · City 5,000+ · Capital 50,000+. |

Controls: WASD / arrow keys or tap to walk; zoom with ＋/－, the mouse wheel, pinch, or the +/- keys; drag to pan; ⤢ fits every island on screen and ⌖ returns to your lead (zoomed far out, lands are drawn as outlines so 10,000 Friends stay fast); reduced-motion in More.

## Preview limits (what needs a server next)

- **No saving.** The SDK sandbox has no storage and no save API; islands, positions,
  berths, bridges, access settings and approvals reset on reload.
- **RF, saves, holes, docking, bridges, launches and claims are simulated** (see Economy).
- **Neighbours are samples.** Until players share one world, the other plots are
  other holders' public, activated Friends read live from chain (#7153, #7174,
  #7843, #7096, #7333, #7834), labelled "sample". Their answers to visit requests,
  and requests to visit you, are **simulated**.
- **Friend discovery inside the game (for review).** The SDK asks games not to do NFT
  discovery; its runtime passes only the selected Friend into the sandbox. Building a
  plot from a whole wallet needs the list, so `roster.ts` reads it with the same
  owner-filtered, read-only method the runtime uses (no collection scan, no wallet
  access). The cleaner production path is for the host to pass the owned-Friend list
  it already has into the game.

Production plan: a shared world service that stores plot layouts, seams and
access lists; signed wallet messages to prove ownership when saving; an indexer
that watches Generations events (activation, tier upgrades, transfers) and
pushes changes to connected players instead of polling.

## Economy (RF integration)

**Simulated in this preview** (starting balance 5,000 RF, labelled SIMULATED):

| Action | Cost | Where the RF goes |
| --- | --- | --- |
| Save an island arrangement (the core loop) | per Friend moved or deployed: Gen 1 100 · Gen 2 50 · Gen 3 20 · Gen 4 10 · Gen 5 5 · Gen 6 1 RF, plus gas | the island's village pool, or the shared Docks pool |
| Create an island on chain | gas only (happens on an island's first save; islands are not tokens) | — |
| Fill a hole | the filling Friend's arrange fee (free if the Friend that left comes back) | the island's village pool, or the shared Docks pool |
| Dock / move an island | gas only | — |
| Build a bridge | 10 RF per berth of distance, plus gas | the island's village pool, or the shared Docks pool |
| Launch a token | 1,000 RF | the launching island's village pool, or the Docks pool |
| Claim from a launch | launch's claim price (set by launcher) | the launching island's village pool, or the Docks pool |
| Own items, boosts, raffle tickets | item price · RF per boost · 100 RF a ticket | the island's village pool, or the shared Docks pool |
| Platform fee | a share of every fee (not of flag locks) | 0% to start, at most 5% (`setPlatformFee`, platform address) |

Nothing is burned by The Docks. A pool's trading fees buy RF (`harvest`): half goes back into
the pool (a village can vote the share), half is shared by Friend count as allowances (the Docks
pool's half goes to the Docks build fund for the shared space). Rare Friends' own shop still
burns half of what's spent there.

Claim eligibility (launcher's choice, for airdrops and claims): my island · my island +
the islands docked next to it or bridged to it · visitors (open island or approved) ·
everyone docked. Tokens have a fixed supply, no owner and no mint after launch; the
remainder goes to the launching Friend's wallet. No RF payout is promised, so nothing
needs backing.

**On-chain phase (written and tested, not deployed)** in `contracts/src/docks/`:

- `DocksIslands.sol` — islands are **not tokens**: `create(name)` records an island owned by
  the calling wallet, with no transfer, approval or sale functions; the only NFTs are the
  activated Friends.
  - *Islands:* `arrange(islandId, ids, xs, ys)` saves positions on the island's own cell grid
    for Friends you hold on an island you own (also deploys a Friend from another of your
    islands) and **pays RF per Friend moved, by generation, into a pool** (`IDocksFeeSink`: the treasury) (`FEE_GEN1…6` =
    100/50/20/10/5/1 RF; unchanged Friends free; batched); `arrangeCost` previews it;
    `remove` is free. True-size footprints by generation; `adjacent` = two Friends of an
    island sharing part of an edge.
  - *Holes:* a Friend counts only while activated and held by the island's owner. If it
    leaves (a Rare Friends transfer also clears activation) or is deactivated, `isHole`
    reports its spot as a hole and its cells stay reserved. When the new holder places it
    anywhere, the spot is **burned in** (`HoleBurned`, `holeOf`). The owner can
    `fillHole(islandId, oldFriend, newFriend)` with an activated Friend of the **same
    generation** (its arrange fee; free when the Friend that left fills its own hole). If
    the Friend comes back before being placed elsewhere, the hole simply heals.
  - *Docking (gas only):* one berth per island whatever its size; `dock(islandId, x, y)` at
    a free berth next to a docked island (`isLoadingZone`), also to move; `undock`;
    `islandAtBerth`; `connected(a, b)` = neighbouring berths or a live bridge.
  - *Bridges:* `buildBridge(from, to)` pays `BRIDGE_FEE_PER_BERTH` (10 RF) × berth
    distance; a bridge records both islands' berth epochs and ends when either moves.
  - *Access:* open / invite-only islands with approved visitors, set by the island's owner.
    Ownership and activation are checked through the live activation manager
    (`positions(generations, id)`).
- `DocksLaunchpad.sol` — launches come from a Friend on a saved, docked island; `LAUNCH_FEE = 1000 RF` into the launching island's pool; `DocksToken`
  fixed-supply ERC-20; an airdrop pool sent in batches by the creator (`airdrop`,
  `endAirdrop`) and a claim pool claimed per Friend or in batches (`claimMany`, RF
  charged only for claims made); everything paid to `tokenBoundAccount`; one airdrop
  and one claim per Friend per launch; claim price into the same pool; scopes as above. Batches
  keep 10,000-Friend plots practical (a client sends ~100 placements or claims per
  transaction).
- `DocksVillages.sol` — flags: `plant`, `lock` (anyone, until `flagTarget`), `found` (anyone),
  `refund` after `flagDuration` (+7 days for a full flag nobody could found). People: one island
  per wallet per village: the seat, `bring` (founders, free) or `enroll` (the enrollment price).
  Staying: DocksIslands tells it about every Friend placed or taken off (`onPlace` / `onLeave`):
  population is tracked; a Friend that leaves a village island is bound to it until the next
  epoch (`EPOCH` = 21 days from deployment), so it can't be placed in another village and an
  island it lands on can't join one until then (`cooldownUntil`); a population cap blocks new
  Friends and joins. `requestRemoval` → `processRemoval` (anyone, after the next epoch): the
  owner's unspent allowance goes to liquidity and the village's items there go to a raffle.
  Votes: power = Friends × (1 + locked / pool); `proposePoolShare` (3 days, yes > no, 20%
  quorum); enrollment votes (keep · change price · close · cap, plurality; a new price or cap is
  picked in a 1-day vote between three). No owner or withdraw.
- `DocksFounderMarks.sol` — soulbound ERC-721 (ERC-5192 `locked`): one mark per wallet per
  flag, holding the RF it locked; every transfer and approval reverts; burned only on refund.
- `DocksVillageTreasury.sol` — every RF in: half liquidity, half the payer's allowance
  (`allowanceOf` = half the founder lock + credits − spent). `payFromAllowance` (items only;
  the RF goes to liquidity), `forfeit` (on removal), `provideLiquidity` (anyone), `harvest`
  (members; anyone for the Docks pool, village 0: fees → buy back RF, `poolBpsOf` back into
  the pool, the rest shared by Friend count or to `docksFund`). Every fee arrives through
  `onFee(islandId, amount)` (islands, launchpad, items only) and goes to the island's village
  pool or the Docks pool; `setPlatformFee` (≤ 5%, starts at 0) takes a share of fees for the
  `platform` address.
- `DocksItems.sol` — RF-priced catalog (price and build time per kind) of items built on
  island cells. `buyForVillage` (allowance; the village owns it; stays on the island),
  `buy` (your RF; yours: `move`, `takeOff`), `boost` (RF cuts build time). All RF → the
  island's village pool, or the Docks pool. `onIslandLeft` → raffle: `buyTickets` (members
  who stayed), `draw` (Dice entropy V2, anyone pays the fee; nobody entered → runs again),
  `claim` (winner keeps it as their own). At most 64 items per island.
- `DocksUniV3Liquidity.sol` — the village's liquidity on Uniswap v3 (live on Robinhood Chain:
  factory `0x1f7d…2EfA`, positions `0x7399…E0D3`, SwapRouter02 `0xCaf6…5cb2`, WETH
  `0x0Bd7…AD73`). RF goes in one-sided (from just past the price to the end of the curve), so
  no ETH is needed up front; buyers fill it with ETH over time. The position NFT stays in the
  contract, which has no remove-liquidity function; `collect` takes fees only. `buyRf` is the
  buyback swap. There is no RF/WETH v3 pool on chain yet, so one must be created first.
- Tests: `forge test --match-contract DocksTest` (51 unit tests, including the on-chain captain, flags, soulbound marks, refunds, founding into liquidity and allowances, one island per wallet with nobody joining free, removal only at the next epoch with the allowance forfeited, a departed Friend burning a spot and staying bound (blocked from another village, then free after the epoch), cooldown on the island a moved Friend lands on, a Friend reclaiming its spot only while the population cap allows, power = Friends × founder share, enrollment votes, harvest half back into the pool and half shared by Friend count, the pool share vote, the platform fee (0 to start, capped at 5%), the Docks pool build fund, nothing ever burned, village items from allowances with build times and boosts, own items, raffles of items left behind (members who stayed, Dice draw, winner keeps it; nobody entered → runs again), the village launch scope, islands are not tokens, per-generation fees into the Docks pool, only moved Friends charged, deploying between islands, holes (reserved, healed on return, burned in when placed elsewhere, filled by same-size Friends), loading zones, size-independent berths, bridge pricing and expiry, launch scopes over gangways and bridges, 300 Friends arranged and claimed in one transaction each) and
  `FRIENDSDK_FORK_RPC=https://rpc.mainnet.chain.robinhood.com forge test --match-contract DocksForkTest`
  (real Generations, activation manager and RF on a local fork: creates two islands, arranges
  #67111 (50 RF into the Docks pool) and #7153, docks them side by side, launches, claims; and a village on the
  real Uniswap v3: creates the RF/WETH pool on the fork, fills and founds a flag, checks the
  one-sided position, trades 50 WETH through it, harvests (buyback: half back into the pool, half shared)).

Deployment, funding and production publication wait for Rare Friends review. The
SDK's chance-game definition in `game.json` (Treat Bag) is required by the
runtime but is **not used** by the game.

## Assets

All Friend artwork is the Friends' own on-chain SVG from the Generations
contract. The walking Friend uses the canonical on-chain sprite via the SDK
sprite reader. `fixtures/tokens.json` holds recorded public tokenURIs/owners used
only by the offline browser test.
