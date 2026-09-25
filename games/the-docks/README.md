# The Docks

An activated Rare Friend already *is* a little plot of land, rendered fully on
chain. The Docks **imports that land, with everything already on it**, and lets
you walk it in 3D. **Dock** it into the harbor next to other Friends' lands and
planks connect them: walk across, water your neighbours' plants, feed their
chickens, buy from their stalls and sell what you grow on your deck. Every credit purchase, docking fee and market sale burns
$RAREFRIENDS (simulated in this preview).

Built with **FriendSDK v0.1.2** (CLI game layout), viem (read-only tokenURI) and
three.js 0.170 for the 3D world. Your Friend is rendered as voxels built from its
canonical on-chain sprite.

## Run it

From the FriendSDK root:

```sh
npm ci                                   # includes three.js
npm run build
npm run dev:game -- games/the-docks      # http://localhost:4173
npx friendsdk build games/the-docks      # static output in games/the-docks/.friendsdk/
npx friendsdk check games/the-docks
node games/the-docks/browser-test.mjs desktop           # or: phone, or add --fail-import
```

Requires a browser wallet on **Robinhood mainnet (chain 4663)** holding a
hardwired Rare Friends Generations NFT (generation ≥ 1). On phones, open the
preview in a wallet app's built-in browser (the SDK has no WalletConnect).
WebGL is required.

## How the land import works

`land.ts` calls `tokenURI(friendId)` on the Generations contract
(`0x14C4…181D`, Robinhood mainnet) through the SDK's public read RPC — the only
network endpoint the sandbox allows. The metadata's on-chain SVG carries the
land outline (`<path fill="url(#rf-floor)">`) and every object as
`<g data-prop="bookcase" transform="translate(x y) scale(s)">`. We parse those
strings (the SVG is never inserted into the page), unproject them with the
renderer's isometric projection (a = 0.866, b = 0.28) onto a 2-units-per-tile
grid, and rebuild the same footprint and props in 3D. Generation, Character,
Scenery, Floor and Activation tier come from the metadata traits; the Floor
trait picks the tile texture. The original artwork is shown on the Home screen
in an `<img>` next to the import.

If the read fails, a clearly labelled stand-in land is used and Home offers
**Retry import**. Non-activated Friends have no land (the SDK only admits
hardwired Friends anyway).

Each berth = imported land + gangway + a 10 × 6 wooden **deck** holding the game
layer (garden beds, chicken pen, stall, harbor sign), so small lands (a gen-6
land is 4 × 4 tiles) still play the same.

## How to play

| Control | Action |
| --- | --- |
| WASD / arrows, or tap the ground | Walk |
| E, the action button, or tap the thing again | Interact with what you're standing next to |
| 🏠 Home (H) | Feed and pet your Friend; buy/open Treat Bags; view Charms |
| 🗺️ Docks | Harbor map: dock your land at an open berth |
| 🛒 Market (M) | Buy credits (simulated) and items from the trading board |
| 🎒 Bag (B) | Items, wear hats, use fertilizer |
| ⚙️ More | Sound, reduced motion, how to play |

- **Your land** (imported) starts adrift. Docking costs 🪙100 (edge berth) or 🪙250 (centre
  berth). Each adjacent docked neighbour adds **+25% produce and rep**.
- **Garden:** 3 plants lose water over time; watered plants grow a stage every
  18 s; ripe bushes give 3 berries (× docking bonus).
- **Chickens** lose food over time; a chicken with food > 40 lays an egg every 30 s.
- **Helping neighbours:** watering their plant gives rep + 🪙3 tip; feeding their
  chicken (uses a Feed Sack or berry) gives rep + 🪙5 tip.
- **Your Friend:** Food and Joy drop slowly; a happier Friend earns more rep.
  Free kibble every 30 s, berries, petting.

### Items (credits)

| Item | Price | Effect |
| --- | --- | --- |
| 🌾 Feed Sack | 15 | Feeds a chicken (+50) |
| 🧪 Fertilizer | 25 | Grows a plant one stage |
| 🚿 Golden Can | 120 | Watering fills to 100 and waters your whole garden |
| ⚓ Sailor Cap | 150 | Hat your Friend wears |
| 🌼 Flower Crown | 220 | Hat your Friend wears |
| 🫐 Berries / 🥚 Eggs | sell 6 / 12 | Produce |

## Economy (all simulated)

| Flow | Rule |
| --- | --- |
| Credits | Bought by card in the live app (🪙500 ≈ $4.99, 🪙1,200 ≈ $9.99). 100 credits = 1 RF of value. **50%** of each purchase buys and burns RF. |
| Docking | 🪙100 / 🪙250; **50%** burned |
| Stall sales & produce | **5%** market fee burned; rest to the seller |
| Treat Bag (SDK chance game) | 1 RF (`1000000000000000000` base units) |
| · Clover Charm | 60% / 6,000 bps · 0.5 RF · kept perk +10% rep |
| · Moon Charm | 30% / 3,000 bps · 1 RF · kept perk +20% rep |
| · Star Charm | 10% / 1,000 bps · 3 RF · kept perk +50% rep |
| Expected reward | 0.9 RF per bag; each bag reserves 3 RF; kept charms keep fixed RF value, no expiry |

No payment is taken and nothing is burned on-chain in this preview. Credits,
items, hats, rep and neighbours are session-only (the SDK sandbox has no storage)
and have no RF redemption promise; only Treat Bag Charms use the SDK's backed
chance-game client. **Neighbouring lands are fictional sample data.**

## Production roadmap / capability gaps

- Shared harbor server: persistent plots, berth ownership, real neighbours, presence.
- Card checkout → treasury buys RF → verifiable on-chain burns shown in-game.
- Player-to-player stall trading and wearable items (not in SDK v0.1.2).
- Embedded wallets so players never see a seed phrase.

## Assets

Friend artwork: canonical on-chain sprite via the SDK sprite reader (see the SDK
NOTICE.md). Your land and its objects: read from your Friend's on-chain metadata
and rebuilt in 3D. `fixtures/token-7730-uri.txt` is the recorded public tokenURI of
fixture Friend #7730, used only by the offline browser test. Sounds: SDK sound kit. All 3D scenery is generated in code from
boxes; icons are system emoji. three.js is MIT-licensed.
