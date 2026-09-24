import { describe, expect, it } from 'vitest';
import { diffInventory, diffPurses } from '../src/sync/diff.js';

const fields = (over = {}) => ({
  name: 'Potion', value: 50, weight: 0.5, charges: null, itemIcon: 'consumable', consumable: true,
  isTreasure: false, isUnidentified: false, unidentifiedName: null, isAmmunition: false, equipped: undefined, ...over,
});
const entry = (over = {}) => ({
  uuid: 'Actor.a.Item.1', owner: 'p1', syncGroup: 'g1', quantity: 3, fields: fields(), consumable: true, ...over,
});
const known = (groups = {}) => ({ groups, purses: {} });
const k = (over = {}) => ({ owner: 'p1', quantity: 3, fields: fields(), itemUuid: 'Actor.a.Item.1', ...over });
const owners = new Set(['p1', 'p2', 'party', 'incoming']);
const ops = (r) => r.ops.map((o) => o.op);

describe('diffInventory', () => {
  it('produces nothing when Foundry matches known', () => {
    const r = diffInventory({ entries: [entry()], known: known({ g1: k() }), activeOwners: owners });
    expect(r.ops).toEqual([]);
  });

  it('creates unflagged items with their fields and quantity', () => {
    const e = entry({ syncGroup: null, uuid: 'Actor.a.Item.9', fields: fields({ name: 'Rope', consumable: false, equipped: true }) });
    const r = diffInventory({ entries: [e], known: known(), activeOwners: owners });
    expect(ops(r)).toEqual([{
      type: 'create', clientId: 'Actor.a.Item.9', owner: 'p1', quantity: 3,
      item: { name: 'Rope', value: 50, weight: 0.5, charges: null, itemIcon: 'consumable', consumable: false, isTreasure: false, isUnidentified: false, unidentifiedName: null, isAmmunition: false },
    }]);
    // equipped is not part of create: known starts at false so a later diff sends it.
    expect(r.ops[0].meta.fields.equipped).toBe(false);
  });

  it('treats an item whose flag names an unknown group as new', () => {
    const r = diffInventory({ entries: [entry({ syncGroup: 'stale' })], known: known(), activeOwners: owners });
    expect(ops(r)[0].type).toBe('create');
  });

  it('deletes a group whose item is gone from a linked actor', () => {
    const r = diffInventory({ entries: [], known: known({ g1: k() }), activeOwners: owners });
    expect(ops(r)).toEqual([{ type: 'delete', syncGroup: 'g1' }]);
  });

  it('never deletes a group whose owner has no linked actor right now', () => {
    const r = diffInventory({ entries: [], known: known({ g1: k({ owner: 'p9' }) }), activeOwners: owners });
    expect(r.ops).toEqual([]);
  });

  it('sends a consumed quantity for consumables and removed for others', () => {
    let r = diffInventory({ entries: [entry({ quantity: 1 })], known: known({ g1: k() }), activeOwners: owners });
    expect(ops(r)).toEqual([{ type: 'quantity', syncGroup: 'g1', quantity: 1, reason: 'consumed' }]);
    r = diffInventory({ entries: [entry({ quantity: 1, consumable: false })], known: known({ g1: k() }), activeOwners: owners });
    expect(ops(r)[0].reason).toBe('removed');
    r = diffInventory({ entries: [entry({ quantity: 5 })], known: known({ g1: k() }), activeOwners: owners });
    expect(ops(r)[0]).toMatchObject({ quantity: 5, reason: 'added' });
  });

  it('sends only the changed fields as an update', () => {
    const e = entry({ fields: fields({ name: 'Greater Potion', value: 150 }) });
    const r = diffInventory({ entries: [e], known: known({ g1: k() }), activeOwners: owners });
    expect(ops(r)).toEqual([{ type: 'update', syncGroup: 'g1', fields: { name: 'Greater Potion', value: 150 } }]);
  });

  it('detects a move: the group now sits only on another actor', () => {
    const e = entry({ owner: 'p2', uuid: 'Actor.b.Item.1' });
    const r = diffInventory({ entries: [e], known: known({ g1: k() }), activeOwners: owners });
    expect(ops(r)).toEqual([{ type: 'move', syncGroup: 'g1', to: 'p2' }]);
    expect(r.ops[0].meta.uuids).toEqual(['Actor.b.Item.1']);
  });

  it('detects a split across actors as a partial move of the copies that left', () => {
    const home = entry({ quantity: 2 });
    const away = entry({ owner: 'p2', uuid: 'Actor.b.Item.7', quantity: 1 });
    const r = diffInventory({ entries: [home, away], known: known({ g1: k() }), activeOwners: owners });
    expect(ops(r)).toEqual([{ type: 'move', syncGroup: 'g1', to: 'p2', quantity: 1 }]);
    expect(r.ops[0].meta).toMatchObject({ kind: 'split', uuids: ['Actor.b.Item.7'] });
  });

  it('adds copies before moving when a stack was duplicated onto another actor', () => {
    const home = entry({ quantity: 3 });
    const away = entry({ owner: 'p2', uuid: 'Actor.b.Item.7', quantity: 3 });
    const r = diffInventory({ entries: [home, away], known: known({ g1: k() }), activeOwners: owners, now: 10000 });
    expect(ops(r)).toEqual([
      { type: 'quantity', syncGroup: 'g1', quantity: 6, reason: 'added' },
      { type: 'move', syncGroup: 'g1', to: 'p2', quantity: 3 },
    ]);
  });

  it('waits for a fresh copy on another actor to settle (a move whose delete has not arrived)', () => {
    const home = entry();
    const away = entry({ owner: 'p2', uuid: 'Actor.b.Item.7', createdAt: 9500 });
    const r = diffInventory({ entries: [home, away], known: known({ g1: k() }), activeOwners: owners, now: 10000, settleMs: 1500 });
    expect(r.ops).toEqual([]);
    expect(r.deferred).toBe(true);
  });

  it('counts a split within one actor as the same group (no op when the total is unchanged)', () => {
    const a = entry({ quantity: 2 });
    const b = entry({ uuid: 'Actor.a.Item.2', quantity: 1 });
    const r = diffInventory({ entries: [a, b], known: known({ g1: k() }), activeOwners: owners });
    expect(r.ops).toEqual([]);
  });

  it('splits off a same-actor copy whose fields diverged', () => {
    const a = entry({ quantity: 2 });
    const b = entry({ uuid: 'Actor.a.Item.2', quantity: 1, fields: fields({ name: 'Labeled Potion' }) });
    const r = diffInventory({ entries: [a, b], known: known({ g1: k() }), activeOwners: owners });
    expect(ops(r)).toEqual([{ type: 'move', syncGroup: 'g1', to: 'p1', quantity: 1 }]);
    expect(r.ops[0].meta.uuids).toEqual(['Actor.a.Item.2']);
  });

  it('maps ammunition quantity to charges on one row', () => {
    const ammoFields = fields({ name: 'Arrows', isAmmunition: true, consumable: false, charges: 20 });
    const e = entry({ quantity: 17, fields: { ...ammoFields, charges: 17 } });
    const r = diffInventory({ entries: [e], known: known({ g1: k({ quantity: 20, fields: ammoFields }) }), activeOwners: owners });
    expect(ops(r)).toEqual([{ type: 'update', syncGroup: 'g1', fields: { charges: 17 } }]);

    const fresh = entry({ syncGroup: null, quantity: 40, fields: { ...ammoFields, charges: 40 } });
    const c = diffInventory({ entries: [fresh], known: known(), activeOwners: owners });
    expect(ops(c)[0]).toMatchObject({ type: 'create', quantity: 1, item: { isAmmunition: true, charges: 40 } });
  });
});

describe('diffPurses', () => {
  it('sends a purse op with the raw coins when the folded total changed', () => {
    const r = diffPurses([{ owner: 'p1', coins: { pp: 1, gp: 5, ep: 2, sp: 0, cp: 3 } }], { p1: { gold: 5, silver: 0, copper: 3 } });
    expect(r).toEqual([{
      op: { type: 'purse', owner: 'p1', coins: { pp: 1, gp: 5, ep: 2, sp: 0, cp: 3 } },
      meta: { kind: 'purse', owner: 'p1', folded: { gold: 15, silver: 10, copper: 3 } },
    }]);
  });

  it('only folds locally when pp/ep appear but the totals match D20', () => {
    const r = diffPurses([{ owner: 'party', coins: { pp: 1, gp: 0, ep: 0, sp: 0, cp: 0 } }], { party: { gold: 10, silver: 0, copper: 0 } });
    expect(r).toEqual([{ op: null, meta: { kind: 'fold', owner: 'party', folded: { gold: 10, silver: 0, copper: 0 } } }]);
  });

  it('is quiet when nothing changed', () => {
    expect(diffPurses([{ owner: 'p1', coins: { pp: 0, gp: 5, ep: 0, sp: 0, cp: 0 } }], { p1: { gold: 5, silver: 0, copper: 0 } })).toEqual([]);
  });
});
