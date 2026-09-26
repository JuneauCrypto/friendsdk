# The Docks

A place for all Rare Friends. Every activated Friend appears exactly as its
fully on-chain artwork renders, and Friends **dock side by side**, edge to edge.
The **seam** where two plots touch is the walkway between them. Walking across a
seam into someone else's plot needs **their approval**, unless they keep it
**open**. Holders can put **any number of their activated Friends together** into
one plot and arrange them however they like (gaps are fine). The game keeps
re-checking the chain, so **upgrades show up** and deactivated or transferred
Friends leave.

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
| **Multi-Friend plots** | My plot → add a Friend number. It must be held by the same wallet as the Friend you're playing (`ownerOf` equality) and be activated. No limit. **Arrange** moves any of your Friends in chunk steps (↖ ↗ ↙ ↘ or arrow keys); overlaps are refused, gaps are allowed. |
| **Chain checks** | Every 60 s and on **Check**: re-read every Friend's tokenURI; if its art or traits changed (e.g. tier upgrade) the art, footprint and rank update. Deactivated Friends leave the docks; Friends no longer held by your wallet leave your plot. |
| **Rank** | Sum of the official reward weight (Generation × Activation tier, per rarefriends.com/docs/generations) of a plot's Friends: Speck 0+ · Hamlet 5+ · Village 50+ · Town 500+ · City 5,000+ · Capital 50,000+. |

Controls: WASD / arrow keys or tap to walk; ＋/－ zoom; reduced-motion in More.

## Preview limits (what needs a server next)

- **No saving.** The SDK sandbox has no storage and no save API; plots, positions,
  access settings and approvals reset on reload.
- **Neighbours are samples.** Until players share one world, the other plots are
  other holders' public, activated Friends read live from chain (#7153, #7174,
  #7843, #7096, #7333, #7834), labelled "sample". Their answers to visit requests,
  and requests to visit you, are **simulated**.
- **Adding Friends by number.** The SDK forbids NFT discovery inside game code,
  so extra Friends are entered by number and verified with `ownerOf`. A production
  host would pass the wallet's owned Friends into the game instead.

Production plan: a shared world service that stores plot layouts, seams and
access lists; signed wallet messages to prove ownership when saving; an indexer
that watches Generations events (activation, tier upgrades, transfers) and
pushes changes to connected players instead of polling.

## Economy

No purchases in this version. The SDK's chance-game definition in `game.json`
(Treat Bag, 1 RF, 3 charms) is required by the runtime but is **not used** by
the game. The planned economy layer (Docks items sold by the app, RF buy-and-burn
from credit sales) is described in the submission, not implemented here.

## Assets

All Friend artwork is the Friends' own on-chain SVG from the Generations
contract. The walking Friend uses the canonical on-chain sprite via the SDK
sprite reader. `fixtures/tokens.json` holds recorded public tokenURIs/owners used
only by the offline browser test.
