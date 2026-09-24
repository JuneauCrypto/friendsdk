# Friend Nest

A cozy virtual-pet / idle game for Rare Friends. Your verified Generations Friend
moves into a little nest. Keep it fed, rested and happy, and it produces
**✦ Sparkles** that upgrade its home. Treat Bags (simulated $RAREFRIENDS) feed it
a surprise snack and drop collectible **Charms** you can keep as a passive boost
or redeem for RF.

Built with **FriendSDK v0.1.2** using the standard CLI game layout.

## Run it

From the FriendSDK root:

```sh
npm ci
npm run build
npm run dev:game -- games/friend-nest            # http://localhost:4173
npx friendsdk build games/friend-nest            # static output in games/friend-nest/.friendsdk/
npx friendsdk check games/friend-nest
```

Requires a browser wallet on **Robinhood mainnet (chain 4663)** holding a
hardwired Rare Friends Generations NFT (generation ≥ 1). On phones, open the
preview inside a wallet app's built-in browser (the SDK has no WalletConnect).

## How to play

| Control | Action |
| --- | --- |
| Tap your Friend / Space | Pet it: +3 joy and a burst of bonus ✦ |
| 🍖 Feed / F | Free kibble, +30 hunger, 25 s cooldown |
| 🎾 Play / P | −15 energy, −5 hunger, +25 joy (more with Toy Box) |
| 🌙 Nap / N | Sleep to recover 4 energy/s (more with Cozy Bed); auto-wakes at 100 |
| 🎁 Treats / T | Buy and open Treat Bags (simulated RF) |
| 🏠 Nest / U | Spend ✦ on upgrades |
| 🍀 Charms / C | View kept charms and redeem them |

Hunger, energy and joy drop over time (0.45 / 0.3 / 0.4 points per second while
awake). Sparkle rate = 1 ✦/s × (0.2 + average mood) × level bonus (+20% per level) ×
Sparkle Lamp (+35% per tier) × kept-charm bonus; ×0.25 if hunger or joy hits 0,
×0.5 while napping. Care actions earn XP toward levels.

Nest upgrades (3 tiers each, cost ×2.5 per tier, paid in ✦ only):
Cozy Bed 120 ✦, Toy Box 200 ✦, Sparkle Lamp 320 ✦.

## Economy (simulated)

| Rule | Exact value |
| --- | --- |
| Treat Bag price | 1 RF (`1000000000000000000` base units) |
| Clover Charm | 60% / 6,000 bps · 0.5 RF · kept perk +10% ✦ · snack +20 stats, +20 XP |
| Moon Charm | 30% / 3,000 bps · 1 RF · kept perk +20% ✦ · snack +35 stats, +35 XP |
| Star Charm | 10% / 1,000 bps · 3 RF · kept perk +50% ✦ · snack +60 stats, +60 XP |
| Expected reward | 0.9 RF per bag |
| Consumable | One bag → exactly one snack + one charm |
| Backing | Each purchased or pending bag reserves 3 RF; kept charms reserve their fixed RF value |
| Redemption | Fixed value, no expiry, to the Friend's canonical wallet in a future approved integration |

All RF balances, purchases, outcomes and redemptions are simulated through the
SDK's preview client. ✦ Sparkles, levels and nest upgrades are in-game only, have
no RF value and carry no redemption promise. Progress resets on reload (the SDK
sandbox has no storage or save API).

## Accessibility

Keyboard shortcuts plus touch; mute (off by default) and reduced-motion toggle in
Settings (also follows the OS preference); loading, error and artwork-retry states;
all input stops while the runtime's `paused` flag is set. `host.css` switches the
frame to a 3:4 portrait layout on screens ≤ 640px wide.

## Future integration

- Persistent saves (needs an SDK save API or off-chain store keyed to the Friend).
- RF-priced nest cosmetics and Sparkle→RF sinks (needs upgrade / extra-currency APIs).
- Live Treat Bags via the chance-game contract (deployment + Dice RNG).

## Assets

Friend artwork is the canonical on-chain sprite loaded with the SDK's sprite
reader (see the SDK's NOTICE.md). Sounds are the SDK sound kit. The room is drawn
with CSS; icons are system emoji. No third-party assets.
