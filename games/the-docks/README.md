# The Docks

An activated Rare Friend already *is* a little plot of land, rendered fully on
chain. The Docks **imports that land at its true size, with everything already
on it**, and lets you walk it in 3D. **Attach** it edge to edge onto a growing
chain of other Friends' lands (no grid, no limit), walk straight across, water
your neighbours' plants, feed their chickens, buy from their stalls and sell what
you grow on your deck. The heavier and more developed a land, the higher its
**status**. Every credit purchase, docking fee and market sale burns
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
grid (a 4-unit chunk is always 2 × 2 tiles; lands are never scaled), and rebuild
the same footprint and props in 3D. Generation, Character,
Scenery, Floor and Activation tier come from the metadata traits; the Floor
trait picks the tile texture. The original artwork is shown on the Home screen
in an `<img>` next to the import.

If the read fails, a clearly labelled stand-in land is used and Home offers
**Retry import**. Non-activated Friends have no land (the SDK only admits
hardwired Friends anyway).

Each piece = imported land + a 10 × 6 wooden **deck** directly under it holding
the game layer (garden beds, chicken pen, stall, sign), so small lands (a gen-6
land is 4 × 4 tiles) still play the same.

## The chain

- Lands keep their real size (gen 3 ≈ 18 × 16 tiles, gen 4 12 × 12, gen 5 8 × 8,
  gen 6 4 × 4; bigger generations are bigger still).
- **Attaching:** `attachSlots()` slides your piece along every side of every land
  already in the chain until it touches without overlapping, then offers the best
  spread-out spots. The chain has no fixed grid or size: it grows as lands attach.
- Attached lands share edges, so you walk straight from one to the next.
- Every land you touch: **+25% produce and rep**. Spots touching more lands cost
  more (🪙60 + 60 per land touched + a small contact bonus); 50% of the fee burns.
- The preview seeds a chain of 8 sample lands of mixed sizes (one large
  generation-2-style land down to a 2 × 2 speck), clearly labelled as samples.

## Status and hierarchy

The chain's hierarchy follows the **Rare Friends reward system**. Each land's rank
starts from its official **reward weight**, read from its on-chain Generation and
Activation tier traits and the published table
([rarefriends.com/docs/generations](https://rarefriends.com/docs/generations)):

| Gen | Tier 0 | Tier 1 | Tier 2 | Tier 3 | Tier 4 |
| --- | --- | --- | --- | --- | --- |
| 1 | 175,000 | 270,000 | 416,250 | 641,250 | 987,187.5 |
| 2 | 16,000 | 24,375 | 37,125 | 56,531.25 | 86,062.5 |
| 3 | 1,450 | 2,212.5 | 3,375 | 5,146.875 | 7,846.875 |
| 4 | 130 | 198.75 | 303.75 | 464.0625 | 708.75 |
| 5 | 12 | 18.375 | 28.125 | 43.03125 | 65.8125 |
| 6 | 1.1 | 1.6875 | 2.5875 | 3.965625 | 6.075 |

`score = reward weight × (1 + development bonus)`, with the development bonus
capped at **+50%** (development points ÷ 1,000). Developing moves a land up
within the reward-system hierarchy but never replaces it.

Development (yours) = Docks items placed (lantern 15 · flower bed 25 · fountain 70
· windmill 110 · lighthouse 250) + 25 per rep level above 1 + 40 Golden Can +
30 per hat + 30 per land touched + up to 80 for RF burned.

| Rank | Score | Perk |
| --- | --- | --- |
| Speck | 0+ | — |
| Hamlet | 5+ | +10% produce & rep |
| Village | 50+ | +20% |
| Town | 500+ | +30% |
| City | 5,000+ | +40% |
| Capital | 50,000+ | +50% |

(Roughly: a gen-6 land is a Speck, gen-5 a Hamlet, gen-4 a Village, gen-3 a Town,
gen-2 a City, gen-1 a Capital; tier upgrades and development push lands up.)
Each land flies a flag in its rank colour, taller as it ranks up. The Chain screen
shows your breakdown and the whole chain's hierarchy.

## Docks items (our economy layer)

The land is the Rare Friend and is never modified. On top of it, The Docks sells
its own items (Market → Docks shop) that you place on your land from the Bag:
Harbor Lantern 🪙60, Flower Bed 🪙90, Fountain 🪙250, Windmill 🪙400 (+10% berry
harvests), Lighthouse 🪙900, plus tools, hats, feed and fertilizer. Items add
development. In this preview they are simulated and session-only; later they can
become on-chain Docks items (a separate collection that interacts with Friends,
not Rare Friends NFTs).

## How to play

| Control | Action |
| --- | --- |
| WASD / arrows, or tap the ground | Walk |
| E, the action button, or tap the thing again | Interact with what you're standing next to |
| 🏠 Home (H) | Feed and pet your Friend; buy/open Treat Bags; view Charms |
| 🗺️ Chain | Chain map: attach your land, see your status and the leaderboard |
| 🛒 Market (M) | Buy credits (simulated) and items from the trading board |
| 🎒 Bag (B) | Items, wear hats, use fertilizer |
| ⚙️ More | Sound, reduced motion, how to play |

- **Your land** (imported) starts adrift beside the chain. Attach it from the
  Chain screen or your deck sign.
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
| Attaching | 🪙60 + 🪙60 per land touched (+ contact bonus); **50%** burned |
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

- Shared chain server: persistent positions, real neighbours, presence, and a spatial index so the chain can grow to thousands of lands.
- Card checkout → treasury buys RF → verifiable on-chain burns shown in-game.
- Docks items as on-chain tokens (e.g. an ERC-1155 collection on Robinhood Chain) owned by the Friend's wallet and verifiable in the app.
- Player-to-player stall trading and wearable items (not in SDK v0.1.2).
- Embedded wallets so players never see a seed phrase.

## Assets

Friend artwork: canonical on-chain sprite via the SDK sprite reader (see the SDK
NOTICE.md). Your land and its objects: read from your Friend's on-chain metadata
and rebuilt in 3D. `fixtures/token-7730-uri.txt` is the recorded public tokenURI of
fixture Friend #7730, used only by the offline browser test. Sounds: SDK sound kit. All 3D scenery is generated in code from
boxes; icons are system emoji. three.js is MIT-licensed.
