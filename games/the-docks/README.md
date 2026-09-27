# The Docks

A place for all Rare Friends, built from **floating islands**. Every activated Friend is
a small floating island, exactly as its fully on-chain artwork renders. Join Friends
together and they make one big island; a holder's Friends can move as one island or be
**deployed to different islands**. **Every island is an NFT.**

- **Arranging is the game.** Move your Friends around your island as a draft, then
  **Save on chain**: every Friend whose spot changed burns RF (Gen 1: 100 · Gen 2: 50 ·
  Gen 3: 20 · Gen 4: 10 · Gen 5: 5 · Gen 6: 1 RF) plus gas. Unmoved Friends are free;
  **Undo** returns to the last save. Each Friend must touch another along part of a side.
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
- **Crew and tokens.** Every Friend is its own wallet (its canonical token-bound
  account): pick who walks behind you, and launch a token from your island for 1,000 RF
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
| **Islands** | Each island has its own grid of 4 × 4-tile cells; Friends cover whole cells at true size (Gen 1 = 30 tiles … Gen 6 = 4), and rounding becomes boardwalk. 🏝 Islands → switch islands, **＋ New island**, and deploy any Friend to another island from its row. |
| **Docking** | ⚓ Docks → the berth map: one square per island, glowing loading zones next to docked islands. Pick one to dock or move (gas only). Islands are drawn centred in their berth with water between; neighbours are joined by a gangway you can walk. |
| **Bridges** | On the berth map, tap an island you aren't next to (or **Bridge to …**): 10 RF per berth of distance, burned. The bridge is a walkway over the water and lasts until either island moves. |
| **Access** | Gangways and bridges are open water; stepping onto an invite-only island (🔒) needs approval: **Ask to visit**. Your islands: **Open / Invite only** in Islands; incoming requests appear there. |
| **Your whole wallet** | `roster.ts` reads the wallet that holds your Friend (`ownerOf`), its owner-filtered `Transfer` history (the same account-filtered method the SDK runtime's picker uses; no collection scan) and then generation + activation tier for every held Friend through Multicall3, 250 per call. Inactive Friends are left out. Re-run every minute, so bought, sold, activated or upgraded Friends join, leave or update. Adding by number stays as a fallback. |
| **Arrange** | ✥ Arrange → tap any Friend on the island and step it one cell (↖ ↗ ↙ ↘ or arrow keys). Stepping onto a same-size neighbour swaps them, so packed islands can be reshuffled. **Auto-arrange** packs the island into one connected block. **Done** / **Save** refuse an island where a Friend doesn't touch another along part of a side. The bar shows how many Friends moved and the RF that saving burns. |
| **Scale** | Layout needs no artwork: footprints come from generation. Occupancy is per 4 × 4-tile cell. Only Friends near the camera are drawn; their on-chain art loads lazily (6 at a time, 500 kept in memory). The crew shows up to 24 walkers. Tested with 10,002 Friends on desktop and phone. |
| **Chain checks** | Every 60 s and on **Check**: re-read every Friend's tokenURI; if its art or traits changed (e.g. tier upgrade) the art, footprint and rank update. Deactivated Friends leave the docks; Friends no longer held by your wallet leave your plot. |
| **Crew** | Your other Friends walk behind you (canonical on-chain sprites): 8 by default, pick up to 24 in Islands (**Walking with you** / **Stays on island**). |
| **Tokens** *(simulated)* | 🚀 Tokens → launch: name, ticker, supply; airdrop scope and amount; claim pool, per-claim amount, claim price. Costs **1,000 RF** (500 burned, 500 treasury). Airdrops and claims land in each Friend's own wallet. Every claim burns the launch's RF price. A sample plot's `$MKT` is there to claim. |
| **Rank** | Sum of the official reward weight (Generation × Activation tier, per rarefriends.com/docs/generations) of a plot's Friends: Speck 0+ · Hamlet 5+ · Village 50+ · Town 500+ · City 5,000+ · Capital 50,000+. |

Controls: WASD / arrow keys or tap to walk; ＋/－ zoom; reduced-motion in More.

## Preview limits (what needs a server next)

- **No saving.** The SDK sandbox has no storage and no save API; islands, positions,
  berths, bridges, access settings and approvals reset on reload.
- **RF, saves, plot NFTs, docking, bridges, launches and claims are simulated** (see Economy).
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
| Mint a plot (island) NFT | gas only (happens on an island's first save) | — |
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

- `DocksPlots.sol` — **every island is an ERC-721** ("The Docks Plot", `PLOT`) with fully
  on-chain metadata (a map of its Friends).
  - *Islands:* `mint(name)`; `arrange(plotId, ids, xs, ys)` saves positions on the island's
    own cell grid for Friends you hold on an island you own (also deploys a Friend from
    another of your islands) and **burns RF per Friend moved, by generation** (`FEE_GEN1…6`
    = 100/50/20/10/5/1 RF; unchanged Friends free; batched); `arrangeCost` previews it;
    `remove` is free. True-size footprints by generation; `adjacent` = two Friends of an
    island sharing part of an edge.
  - *Docking (gas only):* one berth per island whatever its size; `dock(plotId, x, y)` at a
    free berth next to a docked island (`isLoadingZone`), also to move; `undock`;
    `plotAtBerth`; `connected(a, b)` = neighbouring berths or a live bridge.
  - *Bridges:* `buildBridge(from, to)` burns `BRIDGE_FEE_PER_BERTH` (10 RF) × berth
    distance; a bridge records both islands' berth epochs and ends when either moves.
  - *Access & validity:* open / invite-only islands with approved visitors, set by the
    NFT's owner. Ownership and activation are checked through the live activation
    manager (`positions(generations, id)`); a Friend counts only while activated and held
    by the island NFT's owner, so a sold Friend (or a deed sold alone) leaves a stale spot
    anyone can `clear`. Friends are never escrowed: in Rare Friends a transfer clears
    activation, so an island NFT can't carry its Friends with it.
- `DocksLaunchpad.sol` — launches come from a Friend on a saved, docked island; `LAUNCH_FEE = 1000 RF` split burn/treasury; `DocksToken`
  fixed-supply ERC-20; an airdrop pool sent in batches by the creator (`airdrop`,
  `endAirdrop`) and a claim pool claimed per Friend or in batches (`claimMany`, RF
  charged only for claims made); everything paid to `tokenBoundAccount`; one airdrop
  and one claim per Friend per launch; claim price burned; scopes as above. Batches
  keep 10,000-Friend plots practical (a client sends ~100 placements or claims per
  transaction).
- Tests: `forge test --match-contract DocksTest` (30 unit tests: island NFTs, per-generation burn, only moved Friends charged, deploying between islands, loading zones, size-independent berths, bridge pricing and expiry, launch scopes over gangways and bridges, deed transfer, 300 Friends arranged and claimed in one transaction each) and
  `FRIENDSDK_FORK_RPC=https://rpc.mainnet.chain.robinhood.com forge test --match-contract DocksForkTest`
  (real Generations, activation manager and RF on a local fork: mints two islands, arranges
  #67111 (burns 50 RF) and #7153, docks them side by side, launches, claims).

Deployment, funding and production publication wait for Rare Friends review. The
SDK's chance-game definition in `game.json` (Treat Bag) is required by the
runtime but is **not used** by the game.

## Assets

All Friend artwork is the Friends' own on-chain SVG from the Generations
contract. The walking Friend uses the canonical on-chain sprite via the SDK
sprite reader. `fixtures/tokens.json` holds recorded public tokenURIs/owners used
only by the offline browser test.
