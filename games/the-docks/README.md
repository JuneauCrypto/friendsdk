# The Docks

A place for all Rare Friends, built from **floating islands**. Every activated Friend is
a small floating island, exactly as its fully on-chain artwork renders. Join Friends
together and they make one big island; a holder's Friends can move as one island or be
**deployed to different islands**. **The only NFTs are the activated Friends**: an island
is a saved layout that belongs to the wallet that built it, and it can't be sold.

- **Arranging is the game.** Move your Friends around your island as a draft, then
  **Save on chain**: every Friend whose spot changed burns RF (Gen 1: 100 · Gen 2: 50 ·
  Gen 3: 20 · Gen 4: 10 · Gen 5: 5 · Gen 6: 1 RF) plus gas. Unmoved Friends are free;
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
  **10 RF per berth** of distance, burned. It lasts until either island moves.
- **Access.** Walking onto someone else's island needs **their approval**, unless they
  keep it **open**.
- **Your whole wallet, automatically.** Every activated Friend in the same wallet joins,
  from 1 to 10,000+. The game keeps re-checking the chain, so **upgrades show up** and
  sold or deactivated Friends leave.
- **Lead and crew.** Lead any of your Friends; call them all to you, break some off and
  leave them around, or take over another Friend as the lead.
- **Tokens.** Every Friend is its own wallet (its canonical token-bound account): launch a token from your island for 1,000 RF
  with airdrops and an RF-burning claim pool.

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
| **Bridges** | On the berth map, tap an island you aren't next to (or **Bridge to …**): 10 RF per berth of distance, burned. The bridge is a walkway over the water and lasts until either island moves. |
| **Access** | Gangways and bridges are open water; stepping onto an invite-only island (🔒) needs approval: **Ask to visit**. Your islands: **Open / Invite only** in Islands; incoming requests appear there. |
| **Your whole wallet** | `roster.ts` reads the wallet that holds your Friend (`ownerOf`), its owner-filtered `Transfer` history (the same account-filtered method the SDK runtime's picker uses; no collection scan) and then generation + activation tier for every held Friend through Multicall3, 250 per call. Inactive Friends are left out. Re-run every minute, so bought, sold, activated or upgraded Friends join, leave or update. Adding by number stays as a fallback. |
| **Arrange** | ✥ Arrange → tap any Friend on the island (or **Next ▸**) and step it one cell (↖ ↗ ↙ ↘ or arrow keys); **Pick several** to move a group together, **All** for the whole island shape (moving the whole shape together costs nothing). Stepping onto a same-size neighbour swaps them, so packed islands can be reshuffled. **Auto-arrange** packs the island into one connected block. **Done** / **Save** refuse an island where a Friend doesn't touch another along part of a side. The bar shows how many Friends moved and the RF that saving burns. |
| **Scale** | Layout needs no artwork: footprints come from generation. Occupancy is per 4 × 4-tile cell. Only Friends near the camera are drawn; their on-chain art loads lazily (6 at a time, 500 kept in memory). The crew shows up to 24 walkers. Tested with 10,002 Friends on desktop and phone. |
| **Chain checks** | Every 60 s and on **Check**: re-read every Friend's tokenURI; if its art or traits changed (e.g. tier upgrade) the art, footprint and rank update. Deactivated Friends leave the docks; Friends no longer held by your wallet leave your plot. |
| **Lead & crew** | You lead one Friend (the one you walk as); every other Friend stands on its own land, as the on-chain art shows. 👥 Crew → **Call all** brings every Friend over to the lead (40 drawn walking, the rest counted). Tap Friends on the map to pick them, then **Bring picked**, **Leave picked here** (break off and walk on without them), **Take over** (lead that Friend instead; the old lead stays where it was), **Everyone wait** or **All go home**. The Islands list has the same per Friend (*On its land / With the lead / Lead*). |
| **Villages** *(simulated)* | 🚩 Village → name it, set your first lock and **Plant flag** where your lead stands on a saved, docked island of yours. The flag rises up its pole as RF is locked in: **anyone** can **Lock RF** until it reaches **1,000,000 RF** (a contract setting). Each locker holds a **soulbound founder mark** with what they locked. Full → **Found** (anyone): half the RF becomes the village treasury (RF only), half permanent one-sided RF/ETH liquidity; nothing can be withdrawn after that, so it can't be rugged. Not full in 30 days → everyone takes their RF back. **People:** everyone brings **one island**: the planter's is the seat, founders bring theirs free, anyone else **enrolls** for 10,000 RF paid into the pool (half treasury, half liquidity). Enrollment is open for the first 7 days; after that it's what the village votes: keep open at the current price, a new price, close now, or close at a population (Friends in the village). A new price or population closes enrollment until a 24-hour vote between three options (half / double / five times the price; 1.5× / 2× / 4× the population). **Votes:** every Friend on a member's island is a vote; founders multiply theirs by 1 + their share of the pool, and every enrollment fee grows the pool, so newcomers dilute founders while adding their own Friends. Spend treasury RF on marketplace upgrades or change the burn share: 3-day vote, yes > no, 20% of all votes cast. **Harvest** (members): trading fees buy back RF, half burned, half to the treasury. Samples: *Market Town* (founded, open) and *Crystal Hollow* (rising); sample islands lock, enroll and vote over time. ⏩ buttons skip time in the preview. |
| **Tokens** *(simulated)* | 🚀 Tokens → launch: name, ticker, supply; airdrop scope and amount; claim pool, per-claim amount, claim price. Costs **1,000 RF** (500 burned, 500 treasury). Airdrops and claims land in each Friend's own wallet. Every claim burns the launch's RF price. A sample plot's `$MKT` is there to claim. |
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
| Save an island arrangement (the core loop) | per Friend moved or deployed: Gen 1 100 · Gen 2 50 · Gen 3 20 · Gen 4 10 · Gen 5 5 · Gen 6 1 RF, plus gas | 100 % burned (`0x…dEaD`) |
| Create an island on chain | gas only (happens on an island's first save; islands are not tokens) | — |
| Fill a hole | the filling Friend's arrange fee (free if the Friend that left comes back) | 100 % burned |
| Dock / move an island | gas only | — |
| Build a bridge | 10 RF per berth of distance, plus gas | 100 % burned |
| Launch a token | 1,000 RF | 500 burned (`0x…dEaD`), 500 to the treasury |
| Claim from a launch | launch's claim price (set by launcher) | 100 % burned |

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
    islands) and **burns RF per Friend moved, by generation** (`FEE_GEN1…6` =
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
  - *Bridges:* `buildBridge(from, to)` burns `BRIDGE_FEE_PER_BERTH` (10 RF) × berth
    distance; a bridge records both islands' berth epochs and ends when either moves.
  - *Access:* open / invite-only islands with approved visitors, set by the island's owner.
    Ownership and activation are checked through the live activation manager
    (`positions(generations, id)`).
- `DocksLaunchpad.sol` — launches come from a Friend on a saved, docked island; `LAUNCH_FEE = 1000 RF` split burn/treasury; `DocksToken`
  fixed-supply ERC-20; an airdrop pool sent in batches by the creator (`airdrop`,
  `endAirdrop`) and a claim pool claimed per Friend or in batches (`claimMany`, RF
  charged only for claims made); everything paid to `tokenBoundAccount`; one airdrop
  and one claim per Friend per launch; claim price burned; scopes as above. Batches
  keep 10,000-Friend plots practical (a client sends ~100 placements or claims per
  transaction).
- `DocksVillages.sol` — flags: `plant(islandId, name, x, y, amount)`, `lock` (anyone, until
  `flagTarget`, last lock trimmed, smallest `minLock`), `found` (anyone, once full: all RF to the
  treasury, half treasury / half liquidity), `refund` after `flagDuration` (plus 7 days for a
  full flag nobody could found). People: one island per wallet: the seat, `bring` (founders,
  free) or `enroll` (the enrollment price, into the pool); `leaveVillage` (free; the seat stays).
  Votes: power = Friends on your village island × (1 + locked / pool); `propose` Spend /
  BurnShare (3 days, yes > no, 20% of `totalPower`); enrollment: the first vote runs through the
  7-day open window, members can start more (`proposeEnrollment`), 4 choices (keep open, change
  price, close now, close at a population), plurality wins, ties go to the earlier choice; a new
  price or population closes enrollment until a 1-day follow-up between three options;
  `settle` (anyone) carries out a result. No owner or withdraw.
- `DocksFounderMarks.sol` — soulbound ERC-721 (ERC-5192 `locked`): one mark per wallet per
  flag, holding the RF it locked; every transfer and approval reverts; burned only on refund.
- `DocksVillageTreasury.sol` — per-village RF treasury. Enrollment fees: half treasury, half
  queued and added to liquidity by `provideLiquidity` (anyone). `harvest(villageId, minRfOut)`
  (members) collects fees, buys RF with the WETH part, burns `burnBps` (50% by default) and
  keeps the rest. `spend` and `setBurnBps` only run when a DocksVillages vote passes.
- `DocksUniV3Liquidity.sol` — the village's liquidity on Uniswap v3 (live on Robinhood Chain:
  factory `0x1f7d…2EfA`, positions `0x7399…E0D3`, SwapRouter02 `0xCaf6…5cb2`, WETH
  `0x0Bd7…AD73`). RF goes in one-sided (from just past the price to the end of the curve), so
  no ETH is needed up front; buyers fill it with ETH over time. The position NFT stays in the
  contract, which has no remove-liquidity function; `collect` takes fees only. `buyRf` is the
  buyback swap. There is no RF/WETH v3 pool on chain yet, so one must be created first.
- Tests: `forge test --match-contract DocksTest` (44 unit tests, including flags filled by many lockers with the last lock trimmed, soulbound marks, refunds after the deadline and after the grace week, founding splits, one island per wallet (bring free / enroll paid, fee split, leaving and re-enrolling), power = Friends × founder share with enrollees diluting it, the enrollment window and every enrollment vote outcome (keep, new price via the 24h vote, close, close at a population), spend votes won and lost by Friend count, harvest buyback and burn, the burn share vote, the village launch scope, islands are not tokens, per-generation burn, only moved Friends charged, deploying between islands, holes (reserved, healed on return, burned in when placed elsewhere, filled by same-size Friends), loading zones, size-independent berths, bridge pricing and expiry, launch scopes over gangways and bridges, 300 Friends arranged and claimed in one transaction each) and
  `FRIENDSDK_FORK_RPC=https://rpc.mainnet.chain.robinhood.com forge test --match-contract DocksForkTest`
  (real Generations, activation manager and RF on a local fork: creates two islands, arranges
  #67111 (burns 50 RF) and #7153, docks them side by side, launches, claims; and a village on the
  real Uniswap v3: creates the RF/WETH pool on the fork, fills and founds a flag, checks the
  one-sided position, trades 50 WETH through it, harvests (buyback, half burned)).

Deployment, funding and production publication wait for Rare Friends review. The
SDK's chance-game definition in `game.json` (Treat Bag) is required by the
runtime but is **not used** by the game.

## Assets

All Friend artwork is the Friends' own on-chain SVG from the Generations
contract. The walking Friend uses the canonical on-chain sprite via the SDK
sprite reader. `fixtures/tokens.json` holds recorded public tokenURIs/owners used
only by the offline browser test.
