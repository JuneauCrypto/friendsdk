# The Docks

A place for all Rare Friends. Every activated Friend appears exactly as its
fully on-chain artwork renders, and Friends **dock side by side**, edge to edge.
The **seam** where two plots touch is the walkway between them. Walking across a
seam into someone else's plot needs **their approval**, unless they keep it
**open**. Holders can put **any number of their activated Friends together** into
one plot and arrange them however they like (gaps are fine). The game keeps
re-checking the chain, so **upgrades show up** and deactivated or transferred
Friends leave.

**Your Friends appear automatically.** Every activated Friend in the same wallet as the
Friend you pick joins your plot, auto-arranged as one connected block, from 1 Friend to
10,000+. Arrange them however you like; each Friend just has to touch another along part of
a side.

Every Friend is its own wallet (its canonical token-bound account), so a holder's
plot is really a **crew**: your other Friends walk behind you and any of them can
**stay behind** to hold a spot. Holders can **launch a token from their plot** for
1,000 RF, airdrop it into Friend wallets and open an RF-burning claim pool.

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
| **Docking** | Your plot starts adrift. Docks → the map shows up to 8 spots where your whole plot fits flush against docked plots; pick one. |
| **Seams & access** | Where tiles of two plots touch, a seam is drawn: green ⇄ when you may cross, red 🔒 when you may not. Invite-only plots need approval (walk to the seam → **Ask to visit**). Your plot: toggle **Open / Invite only** in My plot; incoming requests appear there. |
| **Your whole wallet** | `roster.ts` reads the wallet that holds your Friend (`ownerOf`), its owner-filtered `Transfer` history (the same account-filtered method the SDK runtime's picker uses; no collection scan) and then generation + activation tier for every held Friend through Multicall3, 250 per call. Inactive Friends are left out. Re-run every minute, so bought, sold, activated or upgraded Friends join, leave or update. Adding by number stays as a fallback. |
| **Arrange** | Auto-arrange packs the plot into one connected block (biggest Friends first, rows flush). Arrange → tap any of your Friends on the map and step it one cell (↖ ↗ ↙ ↘ or arrow keys), or **All together**. Stepping onto a same-size neighbour swaps them, so packed plots can be reshuffled. **Done** refuses a plot where a Friend doesn't touch another along part of a side. A docked plot that stops touching its neighbours slides to the nearest spot. |
| **Scale** | Layout needs no artwork: footprints come from generation. Occupancy is per 4 × 4-tile cell. Only Friends near the camera are drawn; their on-chain art loads lazily (6 at a time, 500 kept in memory). The crew shows up to 24 walkers. Tested with 10,002 Friends on desktop and phone. |
| **Chain checks** | Every 60 s and on **Check**: re-read every Friend's tokenURI; if its art or traits changed (e.g. tier upgrade) the art, footprint and rank update. Deactivated Friends leave the docks; Friends no longer held by your wallet leave your plot. |
| **Grid** | Lands sit on the same 4 × 4-tile cell grid as the on-chain registry, at true size (Gen 1 = 30 tiles … Gen 6 = 4). Rounding up to whole cells becomes **boardwalk**, so neighbours always meet edge to edge. |
| **Crew** | Your other Friends walk behind you (canonical on-chain sprites): 8 by default, pick up to 24 in My plot (**Walking with you** / **Stays on plot**). |
| **Tokens** *(simulated)* | 🚀 Tokens → launch: name, ticker, supply; airdrop scope and amount; claim pool, per-claim amount, claim price. Costs **1,000 RF** (500 burned, 500 treasury). Airdrops and claims land in each Friend's own wallet. Every claim burns the launch's RF price. A sample plot's `$MKT` is there to claim. |
| **Rank** | Sum of the official reward weight (Generation × Activation tier, per rarefriends.com/docs/generations) of a plot's Friends: Speck 0+ · Hamlet 5+ · Village 50+ · Town 500+ · City 5,000+ · Capital 50,000+. |

Controls: WASD / arrow keys or tap to walk; ＋/－ zoom; reduced-motion in More.

## Preview limits (what needs a server next)

- **No saving.** The SDK sandbox has no storage and no save API; plots, positions,
  access settings and approvals reset on reload.
- **RF, launches and claims are simulated** (see Economy).
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
| Launch a token | 1,000 RF | 500 burned (`0x…dEaD`), 500 to the treasury |
| Claim from a launch | launch's claim price (set by launcher) | 100 % burned |

Claim eligibility (launcher's choice, for airdrops and claims): my plot · my plot +
docked neighbours · visitors (open plot or approved) · everyone docked. Tokens have
a fixed supply, no owner and no mint after launch; the remainder goes to the
launching Friend's wallet. No RF payout is promised, so nothing needs backing.

**On-chain phase (written and tested, not deployed)** in `contracts/src/docks/`:

- `DocksRegistry.sol` — shared world grid. `place` (batch, so a crew moves in one
  transaction) checks `ownerOf` and activation through the live activation manager
  (`positions(generations, id)`); true-size footprints by generation; `adjacent`
  = docked; open / invite-only plots with approved visitors; stale placements
  (sold or deactivated) can be cleared by anyone; `placedPage` for discovery.
- `DocksLaunchpad.sol` — `LAUNCH_FEE = 1000 RF` split burn/treasury; `DocksToken`
  fixed-supply ERC-20; an airdrop pool sent in batches by the creator (`airdrop`,
  `endAirdrop`) and a claim pool claimed per Friend or in batches (`claimMany`, RF
  charged only for claims made); everything paid to `tokenBoundAccount`; one airdrop
  and one claim per Friend per launch; claim price burned; scopes as above. Batches
  keep 10,000-Friend plots practical (a client sends ~100 placements or claims per
  transaction).
- Tests: `forge test --match-contract DocksTest` (20 unit tests, incl. 300 Friends placed and claimed in one transaction each) and
  `FRIENDSDK_FORK_RPC=https://rpc.mainnet.chain.robinhood.com forge test --match-contract DocksForkTest`
  (real Generations, activation manager and RF on a local fork: places #67111 and
  #7153 edge to edge, launches, claims).

Deployment, funding and production publication wait for Rare Friends review. The
SDK's chance-game definition in `game.json` (Treat Bag) is required by the
runtime but is **not used** by the game.

## Assets

All Friend artwork is the Friends' own on-chain SVG from the Generations
contract. The walking Friend uses the canonical on-chain sprite via the SDK
sprite reader. `fixtures/tokens.json` holds recorded public tokenURIs/owners used
only by the offline browser test.
