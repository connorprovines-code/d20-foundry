# D20 Loot Tracker for Foundry VTT

Track every coin, item and treasure your party finds without juggling spreadsheets or notes. D20 Loot Tracker is a web and Android app built for D&D 5e, Pathfinder 2e and Pathfinder 1e campaigns, and this module ties it directly to your Foundry world so changes flow both ways in real time.

**What it does**
- Treasure the GM awards in Foundry lands in the app's Unprocessed Loot, waiting to be claimed.
- Once a player claims something in the app, it appears on their Foundry character sheet automatically.
- Selling, splitting or paying out in the app adjusts everyone's coins in Foundry, and editing coins on a sheet adjusts them in the app.
- Using consumables, spending ammunition or removing items in Foundry gets recorded in the app's ledger.
- Items the GM marks as unidentified remain secret in both Foundry and the app until revealed.

## Requirements

- Foundry VTT v13 or v14.
- One of these game systems:
  - Pathfinder 1e (pf1 11.11 or later, Foundry v13)
  - Pathfinder 2e (pf2e 8.x, Foundry v14)
  - D&D 5e (dnd5e 6.x, Foundry v14)
- A D20 Loot Tracker account that owns or DMs the campaign.

## Install

In Foundry's setup screen, open **Add-on Modules**, choose **Install Module**, and paste this manifest URL:

```
https://app.d20-loot-tracker.com/foundry/module.json
```

Then enable **D20 Loot Tracker** in the world's module settings.

## Connect a world

1. Log in to the world as a GM.
2. Open **Settings**, then **Configure Settings**, find **D20 Loot Tracker**, and click **Connect and link actors**.
3. Click **Connect**. Foundry shows an eight-letter code, such as `ABCD-EFGH`.
4. Open [app.d20-loot-tracker.com/foundry](https://app.d20-loot-tracker.com/foundry), sign in, enter the code, and pick the campaign.
5. Back in Foundry, link each D20 character to the actor that holds their items. Actors whose names match are suggested.
6. Pick the **Party** actor (the pf2e party, the dnd5e primary party group, or any actor in pf1).
7. Pick an **Unprocessed Loot** actor, or click **Create** to make one:
   - pf2e: a loot actor.
   - dnd5e: a group actor with no members.
   - pf1: an NPC actor shown with the pf1 NPC loot sheet. pf1 marks items created on an NPC as unidentified (it only starts items identified on player characters), so loot you create bare on this actor arrives in D20 Loot Tracker unidentified too. Drag items from a compendium, or tick Identified on the item, and they sync identified.
8. Click **Save links**.

The code is good for 10 minutes. Only the GM connects; players need nothing.

### The first sync of each actor

The first time an actor syncs, its items are paired with the character's D20 items by name. For each newly linked actor, choose which side to keep:

- **Keep both** (the default): paired items take D20's values, D20 items the actor does not have are added to it, and the actor's other items are added to D20. Coins stay as D20 has them, unless D20's purse is empty; then the actor's coins go to D20.
- **D20 wins**: the actor's inventory and coins become what D20 holds. Items D20 does not have are removed from the actor.
- **Foundry wins**: D20 takes the actor's inventory and coins. D20 items the actor does not have are marked Discarded.

D20 wins and Foundry wins ask for confirmation before the links are saved. After the first sync, the latest change on either side wins.

## What syncs

| In Foundry | In D20 |
|---|---|
| An item on a linked actor | One stack of that item for the character, Party or Unprocessed Loot |
| Name, value, weight (pf1, dnd5e) or bulk (pf2e) | The same fields |
| Quantity | The number of copies. Fewer copies of a consumable are marked used up; fewer of anything else, discarded |
| Ammunition quantity | The ammunition's count |
| Charges or uses | Charges |
| Identified or not, and the unidentified name | Unidentified flag and name |
| Equipped | Equipped (D20 picks the slot) |
| Attuned (dnd5e) and rarity (pf2e, dnd5e) | The same fields |
| Dragging an item to another linked actor | A transfer between characters |
| Deleting an item | Discarded, with the ledger entry "Removed in Foundry" |
| Coins on a character | That character's purse |
| Coins on the Party actor | The Party Fund |
| Coins in the pf2e Unprocessed Loot actor | Coin loot |

Not synced: item descriptions (an item D20 adds to Foundry gets D20's notes as its description, but Foundry descriptions are never sent to D20), spells, features, character stats, DM hoards, actors that are not linked, pf1's weightless coins, and coins on the dnd5e or pf1 Unprocessed Loot actor (add coin loot in D20 instead). Items inside Foundry containers sync as the owner's items; D20's own container assignments are not changed from Foundry.

## Coins: platinum and electrum

D20 purses hold gold, silver and copper. When coins change in Foundry, D20 counts each platinum piece as 10 gold and each electrum piece as 5 silver. The module then rewrites the Foundry actor with the same total, as 0 pp and 0 ep. For example, 2 pp, 3 gp and 1 ep become 23 gp and 5 sp.

pf1 and pf2e store whole coins only, so a D20 purse of 12.5 gp shows in Foundry as 12 gp 5 sp.

## Who runs the sync

The sync runs in the browser of the GM who connected the world, while that browser has the world open. Changes made in the meantime, in Foundry or in D20, sync the next time it does. To sync from another browser or GM account instead, open the module settings there and click **Connect here**; the previous browser stops syncing.

## Privacy

Data leaves the world only for actors the GM links, and only to D20 Loot Tracker (`app.d20-loot-tracker.com`) over HTTPS:

- For each item on a linked actor: its name, value, weight or bulk, quantity, charges, rarity, identification state and unidentified name, equipped and attuned state, item type, and the compendium it came from.
- The coin totals of linked characters and the Party actor.
- The IDs of the linked actors and of their items.
- When connecting: the world's ID and title, the game system and its version, and the Foundry and module versions.

Nothing is sent about other actors, scenes, journals, chat, or user accounts.

The connection token is kept only in the connecting GM's browser (a client setting) and is never stored in the world. **Disconnect** in the module settings revokes it in D20 Loot Tracker; a campaign owner can also revoke it from D20's settings.

## Troubleshooting

- **"The connection was revoked"**: the token was revoked in D20 Loot Tracker. Open the module settings and connect again; actor links are kept.
- **A character's items do not appear**: check that the character is linked to an actor in the module settings.
- **Sync now** in the module settings reloads the whole campaign from D20 and applies it.

## Development

```
npm install
npm test        # vitest
npm run build   # dist/module.js, module.json, lang/, templates/, styles/
npm run build:release   # the same without a source map, as shipped
```

`dist/` is the module folder Foundry loads.
