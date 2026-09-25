import { describe, expect, it } from 'vitest';
import { changedFields, COMPARED_FIELDS } from '../src/systems/common.js';
import { dnd5eAdapter } from '../src/systems/dnd5e.js';
import { getAdapter } from '../src/systems/index.js';
import { pf1Adapter } from '../src/systems/pf1.js';
import { pf2eAdapter } from '../src/systems/pf2e.js';
import { groupToFields } from '../src/sync/engine.js';
import { installFoundry } from './helpers/foundry.js';
import * as fx from './fixtures/items.js';

/** A D20 group as the server would send it for these fields. */
const groupFrom = (fields, extra = {}) => ({
  syncGroup: 'g-1', owner: 'p1', quantity: 1, containerId: null, equippedSlot: fields.equipped ? 'ring1' : null,
  notes: '', isHidden: false, itemIds: [1], ...fields, ...extra,
});

/** Foundry item -> fields -> D20 group -> creation data -> new Foundry item -> same fields. */
async function roundTrip(adapter, env, source) {
  const actor = env.addActor({ name: 'A', type: 'character', system: {} });
  const [item] = await actor.createEmbeddedDocuments('Item', [source]);
  const fields = adapter.itemToFields(item);
  const qty = adapter.getQuantity(item);
  const group = groupFrom({ ...fields, foundrySource: null }, { quantity: fields.isAmmunition ? 1 : qty });
  const data = await adapter.fieldsToItemData(group, qty);
  const [copy] = await actor.createEmbeddedDocuments('Item', [data]);
  const upd = adapter.updateDataFor(copy, group);
  if (upd) await copy.update(upd);
  return { item, copy, fields, group, copyFields: adapter.itemToFields(copy) };
}

const comparable = (f) => Object.fromEntries(COMPARED_FIELDS.filter((k) => f[k] !== undefined).map((k) => [k, f[k]]));

describe('adapter registry', () => {
  it('returns the adapter for each supported system and null otherwise', () => {
    expect(getAdapter('pf1')).toBe(pf1Adapter);
    expect(getAdapter('pf2e')).toBe(pf2eAdapter);
    expect(getAdapter('dnd5e')).toBe(dnd5eAdapter);
    expect(getAdapter('swade')).toBeNull();
  });
});

describe('pf1 adapter', () => {
  it('maps a potion stack', () => {
    const env = installFoundry({ systemId: 'pf1' });
    const actor = env.addActor(fx.pf1.character([fx.pf1.potion()]));
    const item = actor.items.contents[0];
    expect(pf1Adapter.itemToFields(item)).toMatchObject({
      name: 'Potion of Cure Light Wounds', value: 50, weight: 0.1, charges: null, itemIcon: 'consumable',
      consumable: true, isTreasure: false, isUnidentified: false, isAmmunition: false,
    });
    expect(pf1Adapter.getQuantity(item)).toBe(3);
    expect(pf1Adapter.isConsumable(item)).toBe(true);
  });

  it('keeps the real name, unidentified name, equipped state and compendium source', () => {
    const env = installFoundry({ systemId: 'pf1' });
    const actor = env.addActor(fx.pf1.character([fx.pf1.sword()]));
    const f = pf1Adapter.itemToFields(actor.items.contents[0]);
    expect(f).toMatchObject({
      name: 'Longsword +1', isUnidentified: true, unidentifiedName: 'Shiny Longsword', equipped: true,
      itemIcon: 'weapon', foundrySource: 'Compendium.pf1.weapons-and-ammo.Item.abc123',
    });
  });

  it('reads wand charges and ammunition as charges', () => {
    const env = installFoundry({ systemId: 'pf1' });
    const actor = env.addActor(fx.pf1.character([fx.pf1.wand(), fx.pf1.arrows(), fx.pf1.gems()]));
    const [wand, arrows, gems] = actor.items.contents;
    expect(pf1Adapter.itemToFields(wand).charges).toBe(37);
    expect(pf1Adapter.itemToFields(arrows)).toMatchObject({ isAmmunition: true, charges: 20, itemIcon: 'weapon' });
    expect(pf1Adapter.itemToFields(gems)).toMatchObject({ isTreasure: true, itemIcon: 'treasure' });
  });

  it('reads 11.11 ammunition (loot with subType ammo) as ammunition too', () => {
    const env = installFoundry({ systemId: 'pf1' });
    const actor = env.addActor(fx.pf1.character([fx.pf1.arrows11()]));
    const arrows = actor.items.contents[0];
    expect(pf1Adapter.itemToFields(arrows)).toMatchObject({ isAmmunition: true, charges: 20, itemIcon: 'weapon', isUnidentified: false });
    expect(pf1Adapter.isConsumable(arrows)).toBe(true);
  });

  it('creates ammunition in the shape this pf1 version has', async () => {
    installFoundry({ systemId: 'pf1' });
    const group = { name: 'Arrows', isAmmunition: true, charges: 20, quantity: 1, value: 1, weight: 0.15, notes: '' };
    // 11.11: no "ammo" item type, so a loot item with subType "ammo" and no uses block.
    const eleven = await pf1Adapter.fieldsToItemData(group, 20);
    expect(eleven).toMatchObject({ type: 'loot', system: { subType: 'ammo', quantity: 20 } });
    expect(eleven.system.uses).toBeUndefined();
    // master: an "ammo" item type exists.
    globalThis.game.documentTypes = { Item: ['weapon', 'loot', 'ammo'] };
    expect(await pf1Adapter.fieldsToItemData(group, 20)).toMatchObject({ type: 'ammo', system: { subType: 'arrow', quantity: 20 } });
    delete globalThis.game.documentTypes;
  });

  it('lists container contents, which are not embedded items', () => {
    const env = installFoundry({ systemId: 'pf1' });
    const actor = env.addActor(fx.pf1.character([
      fx.pf1.backpack({ inner1: { ...fx.pf1.potion(), _id: 'inner1' } }),
      fx.pf1.sword(),
    ]));
    const list = pf1Adapter.listInventory(actor);
    expect(list.map((i) => i.name).sort()).toEqual(['Backpack', 'Longsword +1', 'Potion of Cure Light Wounds']);
    const inner = list.find((i) => i.parentItem);
    expect(inner.uuid).toMatch(/\.Item\.inner1$/);
  });

  it('round-trips item -> fields -> item data', async () => {
    const env = installFoundry({ systemId: 'pf1' });
    for (const src of [fx.pf1.potion(), fx.pf1.sword(), fx.pf1.wand(), fx.pf1.arrows(), fx.pf1.gems()]) {
      const { fields, copyFields } = await roundTrip(pf1Adapter, env, src);
      expect(comparable(copyFields)).toEqual(comparable(fields));
    }
  });

  it('builds update data only for what changed', async () => {
    const env = installFoundry({ systemId: 'pf1' });
    const actor = env.addActor(fx.pf1.character([fx.pf1.sword()]));
    const item = actor.items.contents[0];
    const group = groupFrom(pf1Adapter.itemToFields(item));
    expect(pf1Adapter.updateDataFor(item, group)).toBeNull();
    const upd = pf1Adapter.updateDataFor(item, { ...group, isUnidentified: false, value: 2500, equippedSlot: null });
    expect(upd).toEqual({ 'system.identified': true, 'system.price': 2500, 'system.equipped': false });
  });

  it('updates a contained item through its container with the sync option', async () => {
    const env = installFoundry({ systemId: 'pf1' });
    const actor = env.addActor(fx.pf1.character([fx.pf1.backpack({ inner1: { ...fx.pf1.potion(), _id: 'inner1' } })]));
    const inner = pf1Adapter.listInventory(actor).find((i) => i.parentItem);
    await pf1Adapter.updateItem(inner, { 'system.quantity': 1 }, { d20Sync: true });
    const [, container, , options] = env.Hooks.calls.find((c) => c[0] === 'updateItem');
    expect(container.type).toBe('container');
    expect(options.d20Sync).toBe(true);
    expect(pf1Adapter.listInventory(actor).find((i) => i.parentItem).system.quantity).toBe(1);
    await pf1Adapter.deleteItems([pf1Adapter.listInventory(actor).find((i) => i.parentItem)], { d20Sync: true });
    expect(pf1Adapter.listInventory(actor).some((i) => i.parentItem)).toBe(false);
  });

  it('reads and writes integer currency with pp = 0', async () => {
    const env = installFoundry({ systemId: 'pf1' });
    const actor = env.addActor(fx.pf1.character([], { pp: 2, gp: 5, sp: 3, cp: 1 }));
    expect(pf1Adapter.readCurrency(actor)).toEqual({ pp: 2, gp: 5, ep: 0, sp: 3, cp: 1 });
    await pf1Adapter.writeCurrency(actor, { gold: 25.5, silver: 3, copper: 1 }, { d20Sync: true });
    expect(actor.system.currency).toEqual({ pp: 0, gp: 25, sp: 8, cp: 1 });
  });

  it('creates the loot actor as an NPC with the loot sheet', async () => {
    installFoundry({ systemId: 'pf1' });
    const a = await pf1Adapter.createLootActor('Unprocessed Loot');
    expect(a.type).toBe('npc');
    expect(a.flags.core.sheetClass).toBe('pf1.LootSheetPF');
    expect(pf1Adapter.findPartyActor()).toBeNull();
  });
});

describe('pf2e adapter', () => {
  it('maps price per copy from price.per, bulk, rarity and uses', () => {
    const env = installFoundry({ systemId: 'pf2e' });
    const actor = env.addActor(fx.pf2e.character([fx.pf2e.potion(), fx.pf2e.arrows()]));
    const [potion, arrows] = actor.items.contents;
    expect(pf2eAdapter.itemToFields(potion)).toMatchObject({
      name: 'Minor Healing Potion', value: 4, bulk: 0.1, rarity: 'common', consumable: true, charges: null,
      isUnidentified: false, equipped: false, foundrySource: 'Compendium.pf2e.equipment-srd.Item.x9o2d1bYXeGmGkMs',
    });
    expect(pf2eAdapter.itemToFields(arrows)).toMatchObject({ value: 0.01, isAmmunition: true, charges: 30, consumable: false });
  });

  it('reads identification from the source, not the mystified name', () => {
    const env = installFoundry({ systemId: 'pf2e' });
    const actor = env.addActor(fx.pf2e.character([fx.pf2e.cloak()]));
    const f = pf2eAdapter.itemToFields(actor.items.contents[0]);
    expect(f).toMatchObject({ name: 'Cloak of Elvenkind', isUnidentified: true, unidentifiedName: 'Strange Cloak', rarity: 'uncommon', equipped: true, itemIcon: 'wondrous' });
  });

  it('treats coins as currency, except in the loot actor', () => {
    const env = installFoundry({ systemId: 'pf2e' });
    const actor = env.addActor(fx.pf2e.character([fx.pf2e.coins('gp', 10), fx.pf2e.gem()]));
    expect(pf2eAdapter.listInventory(actor).map((i) => i.name)).toEqual(['Amethyst']);
    expect(pf2eAdapter.listInventory(actor, { coinsAsItems: true }).map((i) => i.name)).toEqual(['gp coins', 'Amethyst']);
    const coin = actor.items.contents[0];
    expect(pf2eAdapter.itemToFields(coin).itemIcon).toBe('coins');
  });

  it('round-trips item -> fields -> item data', async () => {
    const env = installFoundry({ systemId: 'pf2e' });
    for (const src of [fx.pf2e.potion(), fx.pf2e.gem()]) {
      const { fields, copyFields } = await roundTrip(pf2eAdapter, env, src);
      const { equipped, ...rest } = comparable(fields);
      const { equipped: e2, ...restCopy } = comparable(copyFields);
      expect(restCopy).toEqual(rest);
    }
  });

  it('prefers the compendium entry named by foundrySource, including a bare pf2e id', async () => {
    const compendium = {
      'Compendium.pf2e.equipment-srd.Item.x9o2d1bYXeGmGkMs': { toObject: () => ({ _id: 'orig', ...fx.pf2e.potion() }) },
    };
    installFoundry({ systemId: 'pf2e', compendium });
    const data = await pf2eAdapter.fieldsToItemData(groupFrom({ name: 'Minor Healing Potion', value: 4, foundrySource: 'x9o2d1bYXeGmGkMs' }), 5);
    expect(data._id).toBeUndefined();
    expect(data.system.quantity).toBe(5);
    expect(data._stats.compendiumSource).toBe('Compendium.pf2e.equipment-srd.Item.x9o2d1bYXeGmGkMs');
    expect(data.system.usage).toEqual({ type: 'held', hands: 1 });
  });

  it('writes equip, identification and price updates in pf2e shapes', () => {
    const env = installFoundry({ systemId: 'pf2e' });
    const actor = env.addActor(fx.pf2e.character([fx.pf2e.cloak()]));
    const item = actor.items.contents[0];
    const group = groupFrom(pf2eAdapter.itemToFields(item));
    expect(pf2eAdapter.updateDataFor(item, group)).toBeNull();
    expect(pf2eAdapter.updateDataFor(item, { ...group, isUnidentified: false, equippedSlot: null, value: 400.5 })).toEqual({
      'system.identification.status': 'identified',
      'system.equipped.inSlot': false,
      'system.price.value': { gp: 400, sp: 5 },
    });
  });

  it('reads coins and writes a purse through the inventory helpers', async () => {
    const env = installFoundry({ systemId: 'pf2e' });
    const actor = env.addActor(fx.pf2e.character([fx.pf2e.coins('pp', 2), fx.pf2e.coins('gp', 5), fx.pf2e.coins('cp', 3)]));
    expect(pf2eAdapter.readCurrency(actor)).toEqual({ pp: 2, gp: 5, ep: 0, sp: 0, cp: 3 });
    await pf2eAdapter.writeCurrency(actor, { gold: 25, silver: 4, copper: 3 });
    expect(pf2eAdapter.readCurrency(actor)).toEqual({ pp: 0, gp: 25, ep: 0, sp: 4, cp: 3 });
  });

  it('creates a loot actor and finds the party actor', async () => {
    const env = installFoundry({ systemId: 'pf2e' });
    const loot = await pf2eAdapter.createLootActor('Unprocessed Loot');
    expect(loot.type).toBe('loot');
    expect(loot.system.lootSheetType).toBe('Loot');
    const party = env.addActor({ name: 'The Party', type: 'party', system: {} });
    expect(pf2eAdapter.findPartyActor()).toBe(party);
  });
});

describe('dnd5e adapter', () => {
  it('converts price denominations and weight units to gp and lb per copy', () => {
    const env = installFoundry({ systemId: 'dnd5e' });
    const actor = env.addActor(fx.dnd5e.character([fx.dnd5e.ring(), fx.dnd5e.arrows()]));
    const [ring, arrows] = actor.items.contents;
    expect(dnd5eAdapter.itemToFields(ring)).toMatchObject({
      name: 'Ring of Protection', value: 3500, weight: 0.5, rarity: 'very rare', isUnidentified: true,
      unidentifiedName: 'Plain Ring', isAttuned: true, equipped: true, itemIcon: 'wondrous',
    });
    expect(dnd5eAdapter.itemToFields(arrows)).toMatchObject({ value: 0.05, isAmmunition: true, charges: 20, consumable: false });
  });

  it('reads uses as max - spent', () => {
    const env = installFoundry({ systemId: 'dnd5e' });
    const actor = env.addActor(fx.dnd5e.character([fx.dnd5e.wand()]));
    expect(dnd5eAdapter.itemToFields(actor.items.contents[0]).charges).toBe(5);
  });

  it('round-trips item -> fields -> item data', async () => {
    const env = installFoundry({ systemId: 'dnd5e' });
    for (const src of [fx.dnd5e.potion(), fx.dnd5e.wand(), fx.dnd5e.ring(), fx.dnd5e.arrows(), fx.dnd5e.gem()]) {
      const { fields, copyFields } = await roundTrip(dnd5eAdapter, env, src);
      const { itemIcon, ...rest } = comparable(fields);
      const { itemIcon: icon2, ...restCopy } = comparable(copyFields);
      expect(restCopy).toEqual(rest);
    }
  });

  it('writes charges back as spent, and raises max when D20 has more', () => {
    const env = installFoundry({ systemId: 'dnd5e' });
    const actor = env.addActor(fx.dnd5e.character([fx.dnd5e.wand()]));
    const item = actor.items.contents[0];
    const group = groupFrom(dnd5eAdapter.itemToFields(item));
    expect(dnd5eAdapter.updateDataFor(item, { ...group, charges: 3 })).toEqual({ 'system.uses.spent': 4 });
    expect(dnd5eAdapter.updateDataFor(item, { ...group, charges: 9 })).toEqual({ 'system.uses.max': '9', 'system.uses.spent': 0 });
  });

  it('writes weight in the item\'s own units and rarity as a dnd5e key', () => {
    const env = installFoundry({ systemId: 'dnd5e' });
    const actor = env.addActor(fx.dnd5e.character([fx.dnd5e.ring()]));
    const item = actor.items.contents[0];
    const group = groupFrom(dnd5eAdapter.itemToFields(item));
    expect(dnd5eAdapter.updateDataFor(item, { ...group, weight: 1, rarity: 'legendary' }))
      .toEqual({ 'system.weight.value': 0.4, 'system.rarities': ['legendary'] });
  });

  it('keeps fractional currency and folds nothing on read', async () => {
    const env = installFoundry({ systemId: 'dnd5e' });
    const actor = env.addActor(fx.dnd5e.character([], { pp: 1, gp: 2.5, ep: 2, sp: 0, cp: 0 }));
    expect(dnd5eAdapter.readCurrency(actor)).toEqual({ pp: 1, gp: 2.5, ep: 2, sp: 0, cp: 0 });
    await dnd5eAdapter.writeCurrency(actor, { gold: 12.5, silver: 10, copper: 0 }, { d20Sync: true });
    expect(actor.system.currency).toEqual({ pp: 0, gp: 12.5, ep: 0, sp: 10, cp: 0 });
  });

  it('creates the loot actor as a group and finds the primary party', async () => {
    const env = installFoundry({ systemId: 'dnd5e' });
    const loot = await dnd5eAdapter.createLootActor('Unprocessed Loot');
    expect(loot.type).toBe('group');
    const party = env.addActor({ name: 'Heroes', type: 'group', system: {} });
    env.actors.party = party;
    expect(dnd5eAdapter.findPartyActor()).toBe(party);
  });
});

describe('field comparison', () => {
  it('ignores fields a system does not have and float noise', () => {
    expect(changedFields({ name: 'A', value: 0.30000000000000004, weight: 3 }, { name: 'A', value: 0.3 })).toEqual({});
    expect(changedFields({ name: 'A' }, { name: 'B' })).toEqual({ name: 'B' });
  });

  it('turns a D20 group into the comparable shape', () => {
    expect(groupToFields({ name: 'X', value: '2.5', equippedSlot: 'ring1', rarity: null })).toMatchObject({ name: 'X', value: 2.5, equipped: true, rarity: null });
  });
});
