// D&D 5e adapter (dnd5e 6.x on Foundry v14).
// Verified against dnd5e release-6.0.5, https://github.com/foundryvtt/dnd5e:
// - item types with inventory: weapon, equipment, consumable, tool, loot, container
//   (system.json documentTypes.Item; "backpack" is still declared there as a legacy type)
// - system.quantity, system.price.{value, denomination}, system.weight.{value, units},
//   system.container (item id), system.rarities (a Set; system.rarity is a getter for the
//   lowest) (module/data/item/templates/physical-item.mjs)
// - system.identified, system.unidentified.{name, description}
//   (module/data/item/templates/identifiable.mjs); the prepared name becomes the
//   unidentified name, so the real name is _source.name
// - system.equipped, system.attuned, system.attunement (equippable-item.mjs)
// - uses: system.uses.{spent, max (formula)}; value is prepared as max - spent
//   (module/data/shared/uses-field.mjs)
// - currency: system.currency.{pp,gp,ep,sp,cp}, NumberField min 0, fractional allowed
//   (module/data/shared/currency.mjs); CONFIG.DND5E.currencies[k].conversion is per gp
//   (pp 0.1, gp 1, ...)
// - weight units: CONFIG.DND5E.weightUnits[units].conversion (lb 1, kg 2.5) (config.mjs)
// - Actor types: character, npc, vehicle, group, encounter. No loot actor type. The primary
//   party is game.actors.party, from the "primaryParty" world setting {actor}
//   (module/data/collection/actors-collection.mjs)
// - ammunition: consumable with system.type.value 'ammo'; loot subtypes art, gear, gem,
//   junk, material, resource, treasure (config.mjs consumableTypes / lootTypes)

import {
  ICONS, actorItems, compact, compendiumData, compendiumSourceOf, normalizeRarity, notesToHtml, num, realName, round,
} from './common.js';

const INVENTORY_TYPES = new Set(['weapon', 'equipment', 'consumable', 'tool', 'loot', 'container', 'backpack']);
const EQUIPPABLE = new Set(['weapon', 'equipment']);
const TREASURE_LOOT = new Set(['art', 'gem', 'treasure']);
const ARMOR_TYPES = new Set(['light', 'medium', 'heavy', 'natural', 'shield']);

// dnd5e rarity keys <-> D20 rarity words
const RARITY_TO_D20 = { common: 'common', uncommon: 'uncommon', rare: 'rare', veryRare: 'very rare', legendary: 'legendary', artifact: 'artifact' };
const RARITY_FROM_D20 = Object.fromEntries(Object.entries(RARITY_TO_D20).map(([k, v]) => [v, k]));

const FALLBACK_CURRENCY_CONVERSION = { pp: 0.1, gp: 1, ep: 2, sp: 10, cp: 100 };

const currencyConversion = (denomination) =>
  num(globalThis.CONFIG?.DND5E?.currencies?.[denomination]?.conversion, FALLBACK_CURRENCY_CONVERSION[denomination] ?? 1) || 1;

const weightConversion = (units) =>
  num(globalThis.CONFIG?.DND5E?.weightUnits?.[units]?.conversion, units === 'kg' ? 2.5 : 1) || 1;

const isAmmo = (item) => item?.type === 'consumable' && item.system?.type?.value === 'ammo';

function iconFor(item) {
  const sub = item.system?.type?.value;
  switch (item.type) {
    case 'weapon': return ICONS.weapon;
    case 'equipment': return ARMOR_TYPES.has(sub) ? ICONS.armor : ICONS.wondrous;
    case 'consumable': return isAmmo(item) ? ICONS.weapon : ICONS.consumable;
    case 'tool': return ICONS.tools;
    case 'loot': return TREASURE_LOOT.has(sub) ? ICONS.treasure : null;
    default: return null;
  }
}

function typeFor(group) {
  if (group.isAmmunition) return { type: 'consumable', subtype: 'ammo' };
  if (group.itemIcon === ICONS.coins || group.itemIcon === ICONS.treasure || group.isTreasure) {
    return { type: 'loot', subtype: 'treasure' };
  }
  if (group.consumable || group.itemIcon === ICONS.consumable) return { type: 'consumable', subtype: 'potion' };
  switch (group.itemIcon) {
    case ICONS.weapon: return { type: 'weapon', subtype: 'simpleM' };
    // A new armor item gets no armor value from D20, so it is created as a trinket rather
    // than as armor that would change the wearer's AC.
    case ICONS.armor:
    case ICONS.wondrous: return { type: 'equipment', subtype: 'trinket' };
    case ICONS.tools: return { type: 'tool', subtype: '' };
    default: return { type: 'loot', subtype: 'gear' };
  }
}

function rarityOf(item) {
  const r = item.system?.rarities;
  const first = r ? (typeof r.first === 'function' ? r.first() : Array.from(r)[0]) : item.system?.rarity;
  return first ? (RARITY_TO_D20[first] ?? normalizeRarity(first)) : null;
}

function usesState(item) {
  const uses = item.system?.uses;
  if (!uses) return null;
  const max = num(uses.max, NaN);
  if (!Number.isFinite(max) || max <= 0) return null;
  const spent = num(uses.spent, 0);
  return { max, spent, value: Math.max(0, max - spent) };
}

export const dnd5eAdapter = {
  id: 'dnd5e',
  integerCurrency: false,

  isInventoryItem(item) {
    return INVENTORY_TYPES.has(item?.type);
  },

  /** Container contents are embedded items with system.container set, so all are listed here. */
  listInventory(actor) {
    return actorItems(actor).filter((i) => this.isInventoryItem(i));
  },

  getQuantity(item) {
    return Math.max(0, Math.trunc(num(item.system?.quantity, 1)));
  },

  quantityUpdate(quantity) {
    return { 'system.quantity': quantity };
  },

  isConsumable(item) {
    return item.type === 'consumable';
  },

  itemToFields(item) {
    const sys = item.system ?? {};
    const src = item._source?.system ?? sys;
    const ammo = isAmmo(item);
    const price = sys.price ?? {};
    const weight = sys.weight ?? {};
    const uses = usesState(item);
    return compact({
      name: realName(item),
      value: round(num(price.value) / currencyConversion(price.denomination || 'gp')),
      weight: round(num(weight.value) * weightConversion(weight.units || 'lb')),
      charges: ammo ? this.getQuantity(item) : (uses ? uses.value : null),
      itemIcon: iconFor(item),
      consumable: item.type === 'consumable' && !ammo,
      isTreasure: item.type === 'loot' && TREASURE_LOOT.has(sys.type?.value),
      rarity: rarityOf(item),
      isUnidentified: sys.identified === false,
      unidentifiedName: src.unidentified?.name || null,
      isAttuned: !!sys.attuned,
      isAmmunition: ammo,
      equipped: EQUIPPABLE.has(item.type) ? !!sys.equipped : undefined,
      foundrySource: compendiumSourceOf(item),
    });
  },

  async fieldsToItemData(group, quantity) {
    const base = await compendiumData(group.foundrySource);
    const { type, subtype } = typeFor(group);
    const data = base ?? { name: group.name, type, system: {} };
    const system = data.system ?? (data.system = {});
    system.quantity = quantity;
    if (!base) {
      if (subtype) system.type = { value: subtype };
      system.price = { value: num(group.value), denomination: 'gp' };
      system.weight = { value: num(group.weight), units: 'lb' };
      system.description = { value: notesToHtml(group.notes) };
      const rarity = RARITY_FROM_D20[normalizeRarity(group.rarity)];
      if (rarity) system.rarities = [rarity];
      if (!group.isAmmunition && group.charges !== null && group.charges !== undefined) {
        system.uses = { max: String(num(group.charges)), spent: 0 };
      }
    }
    system.identified = !group.isUnidentified;
    if (group.unidentifiedName) system.unidentified = { ...(system.unidentified || {}), name: group.unidentifiedName };
    if (group.isAttuned) system.attuned = true;
    if (EQUIPPABLE.has(data.type)) system.equipped = !!group.equippedSlot;
    return data;
  },

  updateDataFor(item, group) {
    const cur = this.itemToFields(item);
    const upd = {};
    if (group.name && group.name !== cur.name) upd.name = group.name;
    if (group.value !== undefined && group.value !== null && round(group.value) !== cur.value) {
      upd['system.price.value'] = num(group.value);
      upd['system.price.denomination'] = 'gp';
    }
    if (group.weight !== undefined && group.weight !== null && round(group.weight) !== cur.weight) {
      upd['system.weight.value'] = round(num(group.weight) / weightConversion(item.system?.weight?.units || 'lb'));
    }
    const rarity = RARITY_FROM_D20[normalizeRarity(group.rarity)];
    if (rarity && RARITY_TO_D20[rarity] !== cur.rarity) upd['system.rarities'] = [rarity];
    if (group.isUnidentified !== undefined && !!group.isUnidentified !== cur.isUnidentified) {
      upd['system.identified'] = !group.isUnidentified;
    }
    if (group.unidentifiedName && group.unidentifiedName !== cur.unidentifiedName) {
      upd['system.unidentified.name'] = group.unidentifiedName;
    }
    if (group.isAttuned !== undefined && !!group.isAttuned !== cur.isAttuned) upd['system.attuned'] = !!group.isAttuned;
    const uses = usesState(item);
    if (!group.isAmmunition && uses && group.charges !== null && group.charges !== undefined
      && num(group.charges) !== uses.value) {
      const charges = Math.max(0, num(group.charges));
      if (charges > uses.max) {
        upd['system.uses.max'] = String(charges);
        upd['system.uses.spent'] = 0;
      } else {
        upd['system.uses.spent'] = uses.max - charges;
      }
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
    return item.update(data, options);
  },

  async deleteItems(items, options) {
    if (!items.length) return;
    const actor = items[0].actor ?? items[0].parent;
    await actor.deleteEmbeddedDocuments('Item', items.map((i) => i.id), options);
  },

  readCurrency(actor) {
    const c = actor?.system?.currency ?? {};
    return { pp: num(c.pp), gp: num(c.gp), ep: num(c.ep), sp: num(c.sp), cp: num(c.cp) };
  },

  async writeCurrency(actor, purse, options) {
    return actor.update({
      'system.currency.pp': 0,
      'system.currency.gp': round(num(purse.gold)),
      'system.currency.ep': 0,
      'system.currency.sp': round(num(purse.silver)),
      'system.currency.cp': round(num(purse.copper)),
    }, options);
  },

  /**
   * dnd5e 6 has no loot actor type. A memberless group actor holds items and coins,
   * has no stat block, and never joins combat, so it serves as the loot pile.
   */
  async createLootActor(name, options) {
    return globalThis.Actor.create({ name, type: 'group', img: 'icons/svg/chest.svg' }, options);
  },

  findPartyActor() {
    const actors = globalThis.game?.actors;
    if (actors?.party) return actors.party;
    try {
      return globalThis.game?.settings?.get('dnd5e', 'primaryParty')?.actor ?? null;
    } catch {
      return null;
    }
  },
};

export default dnd5eAdapter;
