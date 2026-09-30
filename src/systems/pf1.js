// Pathfinder 1e adapter (pf1 11.11 on Foundry v13).
// Data paths, from the pf1 11.11 source (https://gitlab.com/foundryvtt_pathfinder1e/foundryvtt-pathfinder1):
// - physical item types: weapon, equipment, implant, consumable, loot, container
//   (public/system.json; models/item/*-model.mjs extend PhysicalItemModel). pf1 11.11 has no
//   "ammo" item type: ammunition is a "loot" item with subType "ammo" (pf1.config.lootTypes).
//   Later pf1 versions add an "ammo" type; both are handled.
// - system.quantity, system.price (gp per item), system.weight.value (lb per item),
//   system.identified (prepared default true), system.unidentified.{name,price},
//   system.equipped / system.carried (prepared defaults true)
//   (models/item/abstract/physical-item-model.mjs)
// - uses: system.uses.{value, per, maxFormula}; charged when per is set
//   (models/item/factory/common-fields.mjs, models/item/abstract/base-item-model.mjs)
// - actor currency: system.currency / system.altCurrency, integer coins, keys pp gp sp cp
//   (models/actor/base-character-model.mjs)
// - container contents live in the container's system.items.{id}; container.items is a
//   Collection of Item instances with parentItem set. Contained item.update(data, context)
//   routes to parentItem.update(..., context), so {d20Sync} reaches the updateItem hook on the
//   container. createContainerContent / deleteContainerContent do not pass options on.
//   (documents/item/item-container.mjs, documents/item/item-pf.mjs update/_transformContainerUpdateData,
//   models/item/container-model.mjs _prepareInventory)
// - no loot actor type (Actor types: character, npc, vehicle, haunt, trap); the NPC loot
//   sheet is pf1.LootSheetPF for "npc" actors (applications/actor/npc-loot-sheet.mjs,
//   registered in pf1.mjs as "pf1.<class name>")

import { purseToCoins } from '../sync/coins.js';
import {
  ICONS, actorItems, compact, compendiumData, compendiumSourceOf, notesToHtml, num, realName, round,
} from './common.js';

const INVENTORY_TYPES = new Set(['weapon', 'equipment', 'implant', 'consumable', 'loot', 'container', 'ammo']);
const EQUIPPABLE = new Set(['weapon', 'equipment', 'implant']);
const TREASURE_SUBTYPES = new Set(['treasure', 'tradeGoods']);
const ARMOR_SUBTYPES = new Set(['armor', 'shield']);

function iconFor(item) {
  const sub = item.system?.subType;
  switch (item.type) {
    case 'weapon':
    case 'ammo': return ICONS.weapon;
    case 'equipment': return ARMOR_SUBTYPES.has(sub) ? ICONS.armor : ICONS.wondrous;
    case 'implant': return ICONS.wondrous;
    case 'consumable': return ICONS.consumable;
    case 'loot':
      if (TREASURE_SUBTYPES.has(sub)) return ICONS.treasure;
      if (sub === 'tool') return ICONS.tools;
      if (sub === 'ammo') return ICONS.weapon;
      return null;
    default: return null;
  }
}

function typeFor(group) {
  if (group.isAmmunition) return hasAmmoType() ? { type: 'ammo', subType: 'arrow' } : { type: 'loot', subType: 'ammo' };
  if (group.itemIcon === ICONS.coins || group.itemIcon === ICONS.treasure || group.isTreasure) {
    return { type: 'loot', subType: 'treasure' };
  }
  if (group.consumable || group.itemIcon === ICONS.consumable) return { type: 'consumable', subType: 'potion' };
  switch (group.itemIcon) {
    case ICONS.weapon: return { type: 'weapon', subType: 'simple' };
    case ICONS.armor: return { type: 'equipment', subType: 'armor' };
    case ICONS.wondrous: return { type: 'equipment', subType: 'wondrous' };
    case ICONS.tools: return { type: 'loot', subType: 'tool' };
    default: return { type: 'loot', subType: 'gear' };
  }
}

const hasCharges = (item) => item.system?.uses?.per === 'charges';

/** Ammunition in either pf1 shape: the "ammo" item type (master) or loot with subType "ammo" (11.x). */
const isAmmoItem = (item) => item?.type === 'ammo' || (item?.type === 'loot' && item.system?.subType === 'ammo');

/** Whether this pf1 version has an "ammo" item type at all. */
function hasAmmoType() {
  const types = globalThis.game?.documentTypes?.Item ?? Object.keys(globalThis.CONFIG?.Item?.dataModels ?? {});
  return Array.isArray(types) ? types.includes('ammo') : !!types?.ammo;
}

export const pf1Adapter = {
  id: 'pf1',
  integerCurrency: true,

  isInventoryItem(item) {
    return INVENTORY_TYPES.has(item?.type);
  },

  /** Top-level inventory plus everything inside containers, recursively. */
  listInventory(actor) {
    const out = [];
    const walk = (items) => {
      for (const item of items) {
        if (!this.isInventoryItem(item)) continue;
        out.push(item);
        if (item.type === 'container' && item.items) walk(actorItems(item));
      }
    };
    walk(actorItems(actor));
    return out;
  },

  getQuantity(item) {
    return Math.max(0, Math.trunc(num(item.system?.quantity, 1)));
  },

  quantityUpdate(quantity) {
    return { 'system.quantity': quantity };
  },

  isConsumable(item) {
    return item.type === 'consumable' || isAmmoItem(item);
  },

  itemToFields(item) {
    const sys = item.system ?? {};
    const src = item._source?.system ?? sys;
    const isAmmunition = isAmmoItem(item);
    return compact({
      name: realName(item),
      value: round(num(sys.price)),
      weight: round(num(sys.weight?.value)),
      charges: isAmmunition ? this.getQuantity(item) : (hasCharges(item) ? num(sys.uses?.value, 0) : null),
      itemIcon: iconFor(item),
      consumable: item.type === 'consumable',
      isTreasure: item.type === 'loot' && TREASURE_SUBTYPES.has(sys.subType),
      isUnidentified: sys.identified === false,
      unidentifiedName: src.unidentified?.name || null,
      isAmmunition,
      equipped: EQUIPPABLE.has(item.type) ? sys.equipped !== false : undefined,
      foundrySource: compendiumSourceOf(item),
    });
  },

  async fieldsToItemData(group, quantity) {
    const base = await compendiumData(group.foundrySource);
    const { type, subType } = typeFor(group);
    const data = base ?? { name: group.name, type, system: { subType } };
    const system = data.system ?? (data.system = {});
    system.quantity = quantity;
    if (!base) {
      system.price = num(group.value);
      system.weight = { value: num(group.weight) };
      system.description = { value: notesToHtml(group.notes) };
      if (!group.isAmmunition && group.charges !== null && group.charges !== undefined) {
        system.uses = { per: 'charges', value: num(group.charges), maxFormula: String(num(group.charges)) };
      }
    }
    system.identified = !group.isUnidentified;
    if (group.unidentifiedName) system.unidentified = { ...(system.unidentified || {}), name: group.unidentifiedName };
    if (EQUIPPABLE.has(data.type)) system.equipped = !!group.equippedSlot;
    system.carried = true;
    return data;
  },

  /** Flat update data that makes `item` match `group`, or null when it already does. */
  updateDataFor(item, group) {
    const cur = this.itemToFields(item);
    const upd = {};
    if (group.name && group.name !== cur.name) upd.name = group.name;
    if (group.value !== undefined && group.value !== null && round(group.value) !== cur.value) {
      upd['system.price'] = num(group.value);
    }
    if (group.weight !== undefined && group.weight !== null && round(group.weight) !== cur.weight) {
      upd['system.weight.value'] = num(group.weight);
    }
    if (group.isUnidentified !== undefined && !!group.isUnidentified !== cur.isUnidentified) {
      upd['system.identified'] = !group.isUnidentified;
    }
    if (group.unidentifiedName && group.unidentifiedName !== cur.unidentifiedName) {
      upd['system.unidentified.name'] = group.unidentifiedName;
    }
    if (!group.isAmmunition && hasCharges(item) && group.charges !== null && group.charges !== undefined
      && num(group.charges) !== cur.charges) {
      upd['system.uses.value'] = num(group.charges);
    }
    if (EQUIPPABLE.has(item.type) && group.equippedSlot !== undefined && !!group.equippedSlot !== cur.equipped) {
      upd['system.equipped'] = !!group.equippedSlot;
    }
    return Object.keys(upd).length ? upd : null;
  },

  async createItems(actor, data, options) {
    return actor.createEmbeddedDocuments('Item', data, options);
  },

  async updateItem(item, data, options) {
    // Contained items route to their container with the same options (item-pf.mjs update).
    return item.update(data, options);
  },

  async deleteItems(items, options) {
    const top = items.filter((i) => !i.parentItem);
    const contained = items.filter((i) => i.parentItem);
    if (top.length) {
      const actor = top[0].actor ?? top[0].parent;
      await actor.deleteEmbeddedDocuments('Item', top.map((i) => i.id), options);
    }
    // deleteContainerContent does not forward options; the resulting updateItem hook on the
    // container carries no d20Sync, and the engine's diff sees nothing to send for it.
    for (const item of contained) await item.parentItem.deleteContainerContent(item.id, options);
  },

  readCurrency(actor) {
    const c = actor?.system?.currency ?? {};
    return { pp: num(c.pp), gp: num(c.gp), ep: 0, sp: num(c.sp), cp: num(c.cp) };
  },

  async writeCurrency(actor, purse, options) {
    const coins = purseToCoins(purse, { integer: true });
    return actor.update({
      'system.currency.pp': 0,
      'system.currency.gp': coins.gp,
      'system.currency.sp': coins.sp,
      'system.currency.cp': coins.cp,
    }, options);
  },

  /** pf1 has no loot actor type: an NPC shown with the system's NPC loot sheet. */
  async createLootActor(name, options) {
    return globalThis.Actor.create({
      name,
      type: 'npc',
      img: 'icons/svg/chest.svg',
      flags: { core: { sheetClass: 'pf1.LootSheetPF' } },
    }, options);
  },

  /** pf1 has no party actor; the GM picks one. */
  findPartyActor() {
    return null;
  },
};

export default pf1Adapter;
