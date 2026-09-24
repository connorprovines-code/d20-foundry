// System adapters. The sync engine never reads system data directly; everything
// system-specific goes through one of these objects.
//
// Adapter interface
// -----------------
// id: string                          'pf1' | 'pf2e' | 'dnd5e'
// integerCurrency: boolean            coin fields only take whole numbers
// currencyWritesAreUntagged?: boolean coin writes cannot carry {d20Sync} (pf2e)
//
// isInventoryItem(item, opts?) -> boolean
//     A physical item that syncs. pf2e takes { coinsAsItems } (true only for the
//     Unprocessed Loot actor, where coins are loot rather than the actor's currency).
// listInventory(actor, opts?) -> Item[]
//     Every inventory item the actor holds, including pf1 container contents (which are
//     not embedded documents). Same opts as isInventoryItem.
// getQuantity(item) -> number                 whole copies, never negative
// quantityUpdate(n) -> object                 update data that sets the quantity
// isConsumable(item) -> boolean               a quantity drop is "consumed", not "removed"
// itemToFields(item) -> Fields
//     The contract item fields this system can represent: name, value (gp per copy),
//     weight (lb per copy) or bulk (pf2e), charges, itemIcon, consumable, isTreasure,
//     rarity, isUnidentified, unidentifiedName, isAttuned (dnd5e), isAmmunition,
//     equipped (boolean), foundrySource. A field the system lacks is left out.
//     For ammunition, charges is the Foundry quantity (D20 keeps one row with charges).
// fieldsToItemData(group, quantity) -> Promise<object>
//     Creation data for a D20 group, from its compendium source when that resolves.
// updateDataFor(item, group) -> object | null
//     Flat update data that makes the item match the group; null when it already does.
// createItems(actor, data[], options) / updateItem(item, data, options) /
// deleteItems(items[], options)
//     Document writes; pf1 routes contained items through their container.
// readCurrency(actor) -> { pp, gp, ep, sp, cp }
// writeCurrency(actor, { gold, silver, copper }, options)
//     Writes the purse with pp = 0 and ep = 0.
// createLootActor(name, options) -> Promise<Actor>   the Unprocessed Loot actor
// findPartyActor() -> Actor | null                   the system's own party, if it has one

import dnd5eAdapter from './dnd5e.js';
import pf1Adapter from './pf1.js';
import pf2eAdapter from './pf2e.js';

export const ADAPTERS = { pf1: pf1Adapter, pf2e: pf2eAdapter, dnd5e: dnd5eAdapter };

export function getAdapter(systemId = globalThis.game?.system?.id) {
  return ADAPTERS[systemId] ?? null;
}
