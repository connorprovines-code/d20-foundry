// Pathfinder 2e adapter (pf2e 8.x on Foundry v14).
// Data paths, from the pf2e 8.5.1 source (https://github.com/foundryvtt/pf2e):
// - physical item types: ammo, armor, backpack, book, consumable, equipment, shield,
//   treasure, weapon (src/module/item/physical/values.ts PHYSICAL_ITEM_TYPES)
// - system.quantity; system.price.{value: {pp,gp,sp,cp}, per}; system.bulk.value in bulk
//   units with light = 0.1 (item/physical/bulk.ts); system.containerId;
//   system.equipped.{carryType, handsHeld, inSlot, invested}; system.identification.status
//   'identified' | 'unidentified' and .unidentified {name, img, data.description} or null
//   (item/physical/data.ts); the prepared item.name is the mystified name while
//   unidentified, so the real name is _source.name (item/physical/document.ts prepareDerivedData)
// - rarity: system.traits.rarity (item/physical/document.ts get rarity)
// - consumable uses: system.uses.{value, max, autoDestroy} (item/consumable/data.ts)
// - coins are treasure items with system.category 'coin'. In 8.5 the inventory API is
//   actor.inventory.currency / addCurrency / removeCurrency; coins / addCoins / removeCoins
//   remain as deprecated aliases (actor/inventory/index.ts). Neither takes document options,
//   so coin writes reach the hooks without d20Sync; the engine's purse comparison absorbs them.
// - actor types include loot (system.lootSheetType 'Loot' | 'Merchant', actor/loot/data.ts)
//   and party; game.actors.party is the active party (collection/actors.ts)
// - isEquipped rules (item/physical/usage.ts isEquipped): held items need handsHeld >= hands,
//   worn items with a slot need inSlot.

import { goldToPrice, priceToGold, purseToCoins } from '../sync/coins.js';
import {
  ICONS, actorItems, compact, compendiumData, compendiumSourceOf, notesToHtml, num, realName, round,
} from './common.js';

const PHYSICAL_TYPES = new Set(['ammo', 'armor', 'backpack', 'book', 'consumable', 'equipment', 'shield', 'treasure', 'weapon']);
const RARITIES = new Set(['common', 'uncommon', 'rare', 'unique']);
const EQUIPMENT_PACK = 'Compendium.pf2e.equipment-srd.Item.';

const isCoin = (item) => item?.type === 'treasure'
  && (item.isCoinage === true || item.system?.category === 'coin');

const isAmmo = (item) => item?.type === 'ammo'
  || (item?.type === 'consumable' && item.system?.category === 'ammo');

function iconFor(item) {
  switch (item.type) {
    case 'weapon':
    case 'ammo': return ICONS.weapon;
    case 'armor':
    case 'shield': return ICONS.armor;
    case 'consumable': return isAmmo(item) ? ICONS.weapon : ICONS.consumable;
    case 'treasure': return isCoin(item) ? ICONS.coins : ICONS.treasure;
    case 'equipment': return ICONS.wondrous;
    case 'book': return ICONS.tools;
    default: return null;
  }
}

function typeFor(group) {
  if (group.isAmmunition) return 'ammo';
  if (group.itemIcon === ICONS.coins || group.itemIcon === ICONS.treasure || group.isTreasure) return 'treasure';
  if (group.consumable || group.itemIcon === ICONS.consumable) return 'consumable';
  switch (group.itemIcon) {
    case ICONS.weapon: return 'weapon';
    case ICONS.armor: return 'armor';
    default: return 'equipment';
  }
}

/** Mirrors pf2e's isEquipped(usage, equipped) when the prepared getter is unavailable. */
function equippedState(item) {
  if (typeof item.isEquipped === 'boolean') return item.isEquipped;
  const usage = item.system?.usage ?? {};
  const eq = item.system?.equipped ?? {};
  if (eq.carryType === 'dropped') return false;
  if (usage.type === 'carried') return true;
  if (usage.type !== eq.carryType) return false;
  if (usage.type === 'worn' && usage.where && !eq.inSlot) return false;
  if (usage.type === 'held') return (eq.handsHeld ?? 0) >= (usage.hands ?? 1);
  return true;
}

/** Update data that equips or unequips, as far as the item's usage allows. */
function equipUpdate(item, equip) {
  const usage = item.system?.usage ?? {};
  if (equip) {
    if (usage.type === 'held') return { 'system.equipped.carryType': 'held', 'system.equipped.handsHeld': usage.hands ?? 1 };
    if (usage.type === 'worn') return { 'system.equipped.carryType': 'worn', 'system.equipped.inSlot': true };
    return null;
  }
  if (usage.type === 'held') return { 'system.equipped.carryType': 'worn', 'system.equipped.handsHeld': 0 };
  if (usage.type === 'worn' && usage.where) return { 'system.equipped.inSlot': false };
  return null;
}

const pricePer = (item) => Math.max(1, num(item.system?.price?.per, 1));

export const pf2eAdapter = {
  id: 'pf2e',
  integerCurrency: true,
  /** Coin writes go through inventory helpers that take no document options. */
  currencyWritesAreUntagged: true,

  isCurrencyItem(item) {
    return isCoin(item);
  },

  /**
   * Physical items. Coins are the actor's currency, except in the Unprocessed Loot actor,
   * where coin loot syncs as items (D20 rows with item_icon 'coins').
   */
  isInventoryItem(item, { coinsAsItems = false } = {}) {
    if (!PHYSICAL_TYPES.has(item?.type)) return false;
    return coinsAsItems || !isCoin(item);
  },

  /** Every physical item the actor holds; pf2e container contents are ordinary embedded items. */
  listInventory(actor, { coinsAsItems = false } = {}) {
    return actorItems(actor).filter((i) => this.isInventoryItem(i, { coinsAsItems }));
  },

  getQuantity(item) {
    return Math.max(0, Math.trunc(num(item.system?.quantity, 1)));
  },

  quantityUpdate(quantity) {
    return { 'system.quantity': quantity };
  },

  isConsumable(item) {
    return item.type === 'consumable' || item.type === 'ammo';
  },

  itemToFields(item) {
    const sys = item.system ?? {};
    const src = item._source?.system ?? sys;
    const ammo = isAmmo(item);
    const uses = sys.uses;
    return compact({
      name: realName(item),
      value: round(priceToGold(sys.price?.value) / pricePer(item)),
      // Bulk is sent as the item's own bulk value (light = 0.1), the number the D20 pf2e
      // picker stores; for items priced and bulked per N (arrows) it is the bulk of N.
      bulk: round(num(src.bulk?.value ?? sys.bulk?.value)),
      charges: ammo ? this.getQuantity(item) : (uses && num(uses.max) > 1 ? num(uses.value) : null),
      itemIcon: iconFor(item),
      consumable: item.type === 'consumable' && !ammo,
      isTreasure: item.type === 'treasure',
      rarity: sys.traits?.rarity ?? null,
      isUnidentified: sys.identification?.status === 'unidentified',
      unidentifiedName: src.identification?.unidentified?.name || null,
      isAmmunition: ammo,
      equipped: equippedState(item),
      foundrySource: compendiumSourceOf(item),
    });
  },

  /** A compendium UUID, or a bare pf2e equipment id as the D20 pf2e picker stores it. */
  sourceUuid(foundrySource) {
    if (!foundrySource) return null;
    const s = String(foundrySource);
    if (s.startsWith('Compendium.')) return s;
    if (/^[A-Za-z0-9]{16}$/.test(s)) return `${EQUIPMENT_PACK}${s}`;
    return null;
  },

  async fieldsToItemData(group, quantity) {
    const base = await compendiumData(this.sourceUuid(group.foundrySource));
    const type = typeFor(group);
    const data = base ?? { name: group.name, type, system: {} };
    const system = data.system ?? (data.system = {});
    system.quantity = quantity;
    if (!base) {
      system.price = { value: goldToPrice(group.value) };
      if (group.bulk !== null && group.bulk !== undefined) system.bulk = { value: num(group.bulk) };
      system.description = { value: notesToHtml(group.notes) };
      const rarity = group.rarity && RARITIES.has(group.rarity) ? group.rarity : 'common';
      system.traits = { value: [], rarity, otherTags: [] };
      if (type === 'consumable' && group.charges !== null && group.charges !== undefined) {
        system.uses = { value: num(group.charges), max: num(group.charges), autoDestroy: true };
      }
    }
    // The unidentified name needs the item's own mystified data; updateDataFor sets it after creation.
    system.identification = { ...(system.identification || {}), status: group.isUnidentified ? 'unidentified' : 'identified' };
    return data;
  },

  updateDataFor(item, group) {
    const cur = this.itemToFields(item);
    const upd = {};
    if (group.name && group.name !== cur.name) upd.name = group.name;
    if (group.value !== undefined && group.value !== null && Math.abs(round(group.value) - cur.value) >= 0.01) {
      upd['system.price.value'] = goldToPrice(num(group.value) * pricePer(item));
    }
    if (group.bulk !== undefined && group.bulk !== null && round(group.bulk) !== cur.bulk) {
      upd['system.bulk.value'] = num(group.bulk);
    }
    if (group.rarity && RARITIES.has(group.rarity) && group.rarity !== cur.rarity) {
      upd['system.traits.rarity'] = group.rarity;
    }
    if (group.isUnidentified !== undefined && !!group.isUnidentified !== cur.isUnidentified) {
      upd['system.identification.status'] = group.isUnidentified ? 'unidentified' : 'identified';
    }
    if (group.unidentifiedName && group.unidentifiedName !== cur.unidentifiedName) {
      const mystified = typeof item.getMystifiedData === 'function' ? item.getMystifiedData('unidentified') : {};
      upd['system.identification.unidentified'] = { ...mystified, name: group.unidentifiedName };
    }
    if (!group.isAmmunition && item.system?.uses && num(item.system.uses.max) > 1
      && group.charges !== null && group.charges !== undefined && num(group.charges) !== cur.charges) {
      upd['system.uses.value'] = num(group.charges);
    }
    if (group.equippedSlot !== undefined && !!group.equippedSlot !== cur.equipped) {
      Object.assign(upd, equipUpdate(item, !!group.equippedSlot) ?? {});
    }
    return Object.keys(upd).length ? upd : null;
  },

  async createItems(actor, data, options) {
    return actor.createEmbeddedDocuments('Item', data, options);
  },

  async updateItem(item, data, options) {
    return item.update(data, options);
  },

  async deleteItems(items, options) {
    if (!items.length) return;
    const actor = items[0].actor ?? items[0].parent;
    await actor.deleteEmbeddedDocuments('Item', items.map((i) => i.id), options);
  },

  readCurrency(actor) {
    const inv = actor?.inventory;
    const c = inv?.currency ?? inv?.coins ?? {};
    return { pp: num(c.pp), gp: num(c.gp), ep: 0, sp: num(c.sp), cp: num(c.cp) };
  },

  /** Sets the coin items to the purse (pp 0) with the inventory helpers, exact per denomination. */
  async writeCurrency(actor, purse) {
    const inv = actor?.inventory;
    if (!inv) return;
    const target = purseToCoins(purse, { integer: true });
    const current = this.readCurrency(actor);
    const add = {};
    const remove = {};
    for (const d of ['pp', 'gp', 'sp', 'cp']) {
      const diff = num(target[d]) - num(current[d]);
      if (diff > 0) add[d] = diff;
      if (diff < 0) remove[d] = -diff;
    }
    const removeFn = (inv.removeCurrency ?? inv.removeCoins)?.bind(inv);
    const addFn = (inv.addCurrency ?? inv.addCoins)?.bind(inv);
    if (Object.keys(remove).length) await removeFn(remove, { byValue: false });
    if (Object.keys(add).length) await addFn(add);
  },

  async createLootActor(name, options) {
    return globalThis.Actor.create({
      name,
      type: 'loot',
      img: 'icons/svg/chest.svg',
      system: { lootSheetType: 'Loot' },
    }, options);
  },

  findPartyActor() {
    const actors = globalThis.game?.actors;
    return actors?.party ?? actors?.find?.((a) => a.type === 'party') ?? null;
  },
};

export default pf2eAdapter;
