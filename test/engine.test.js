import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, D20Api, NetworkError } from '../src/api.js';
import { MODULE_ID } from '../src/constants.js';
import { completePairing, runtime, updateSyncClient } from '../src/runtime.js';
import { KEYS, registerSettings, store } from '../src/settings.js';
import { SyncEngine } from '../src/sync/engine.js';
import { getAdapter } from '../src/systems/index.js';
import { installFoundry } from './helpers/foundry.js';
import * as fx from './fixtures/items.js';

const flagOf = (item) => item.flags?.[MODULE_ID] ?? {};

function fakeApi(overrides = {}) {
  let n = 0;
  const api = {
    stateValue: { cursor: '10', players: [], groups: [], containers: [], actorLinks: [], partyFund: null, campaign: { id: 'camp', name: 'Test' } },
    state: vi.fn(async () => structuredClone(api.stateValue)),
    changes: vi.fn(async () => ({ cursor: '11', groups: [], purses: [], containers: [] })),
    apply: vi.fn(async (ops) => ({
      results: ops.map((op) => {
        if (op.type === 'create') return { ok: true, syncGroup: `sg-new-${++n}` };
        if (op.type === 'move' && op.quantity) return { ok: true, syncGroup: `sg-split-${++n}` };
        return { ok: true };
      }),
      cursor: '999',
    })),
    putActors: vi.fn(async (links) => {
      api.stateValue.actorLinks = links;
      return { actorLinks: links };
    }),
    disconnect: vi.fn(async () => ({ ok: true })),
    ...overrides,
  };
  return api;
}

/** A connected world with one linked character (p1), a party actor and a loot actor. */
async function setup({ systemId = 'dnd5e', items = [], currency, api = fakeApi(), extraActors = [] } = {}) {
  const env = installFoundry({ systemId });
  registerSettings();
  const make = fx[systemId];
  const pc = env.addActor(systemId === 'pf2e' ? make.character(items) : make.character(items, currency));
  const party = env.addActor({ name: 'Party', type: systemId === 'pf2e' ? 'party' : 'group', system: { currency: { pp: 0, gp: 0, ep: 0, sp: 0, cp: 0 } } });
  const loot = env.addActor({ name: 'Unprocessed Loot', type: systemId === 'pf2e' ? 'loot' : 'group', system: {} });
  const others = extraActors.map((a) => env.addActor(a));
  await store.set(KEYS.token, 'tok');
  await store.set(KEYS.connection, { id: 'c1', campaignId: 'camp', campaignName: 'Test' });
  const links = { p1: pc.uuid, party: party.uuid, incoming: loot.uuid };
  others.forEach((a, i) => { links[`p${i + 2}`] = a.uuid; });
  api.stateValue.actorLinks = Object.entries(links).map(([target, actorUuid]) => ({ target, actorUuid }));
  const firstLink = Object.fromEntries(Object.entries(links).map(([t, u]) => [t, { actorUuid: u, mode: 'd20', done: true }]));
  await store.set(KEYS.links, links);
  await store.set(KEYS.firstLink, firstLink);
  const notify = vi.fn();
  const engine = new SyncEngine({
    adapter: getAdapter(systemId), api, store, notify, setTimeout: () => 0, clearTimeout: () => {},
  });
  return { env, engine, api, pc, party, loot, others, notify };
}

/** Starts the engine against an empty D20 campaign and forgets the start-up calls. */
async function started(opts) {
  const ctx = await setup(opts);
  await ctx.engine.start();
  ctx.api.apply.mockClear();
  ctx.api.state.mockClear();
  return ctx;
}

const group = (over = {}) => ({
  syncGroup: 'g1', owner: 'p1', quantity: 2, containerId: null, equippedSlot: null,
  name: 'Potion of Healing', value: 50, weight: 0.5, bulk: null, charges: 1, itemIcon: 'consumable', consumable: true,
  isTreasure: false, rarity: 'common', notes: '', isUnidentified: false, unidentifiedName: null, isHidden: false,
  isAttuned: false, isAmmunition: false, foundrySource: null, itemIds: [1, 2], ...over,
});

afterEach(() => vi.useRealTimers());

describe('echo suppression', () => {
  it('ignores hooks from writes tagged d20Sync and reacts to the rest', async () => {
    const { engine, pc } = await started();
    const spy = vi.spyOn(engine, 'markDirty');
    await pc.createEmbeddedDocuments('Item', [fx.dnd5e.potion()], { d20Sync: true });
    await pc.update({ 'system.currency.gp': 5 }, { d20Sync: true });
    expect(spy).not.toHaveBeenCalled();
    await pc.createEmbeddedDocuments('Item', [fx.dnd5e.gem()]);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('ignores actors that are not linked', async () => {
    const { engine, env } = await started();
    const spy = vi.spyOn(engine, 'markDirty');
    const npc = env.addActor({ name: 'Goblin', type: 'npc', system: {} });
    await npc.createEmbeddedDocuments('Item', [fx.dnd5e.potion()]);
    expect(spy).not.toHaveBeenCalled();
  });

  it('sends nothing back after applying inbound changes', async () => {
    const { engine, api } = await started();
    api.changes.mockResolvedValueOnce({ cursor: '12', groups: [group()], purses: [{ id: 'p1', name: 'Merric', gold: 12, silver: 3, copper: 0 }], containers: [] });
    await engine.poll();
    await engine.flush();
    expect(api.apply).not.toHaveBeenCalled();
  });

  it('debounces bursts of hooks into one flush after 500 ms', async () => {
    vi.useFakeTimers();
    const ctx = await setup();
    const engine = new SyncEngine({ adapter: getAdapter('dnd5e'), api: ctx.api, store, notify: vi.fn() });
    await engine.start();
    const flush = vi.spyOn(engine, 'flush').mockResolvedValue();
    engine.markDirty();
    engine.markDirty();
    await vi.advanceTimersByTimeAsync(400);
    engine.markDirty();
    await vi.advanceTimersByTimeAsync(499);
    expect(flush).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(flush).toHaveBeenCalledTimes(1);
    engine.stop();
  });
});

describe('outbound ops', () => {
  it('creates, then tracks quantity and deletion of an item added in Foundry', async () => {
    const { engine, api, pc } = await started();
    const [item] = await pc.createEmbeddedDocuments('Item', [fx.dnd5e.potion()]);
    await engine.flush();
    const [ops] = api.apply.mock.calls[0];
    expect(ops).toEqual([expect.objectContaining({ type: 'create', clientId: item.uuid, owner: 'p1', quantity: 3 })]);
    expect(flagOf(item)).toEqual({ syncGroup: 'sg-new-1', owner: 'p1' });
    expect(store.get(KEYS.known).groups['sg-new-1']).toMatchObject({ owner: 'p1', quantity: 3 });

    await item.update({ 'system.quantity': 2 });
    await engine.flush();
    expect(api.apply.mock.calls[1][0]).toEqual([{ type: 'quantity', syncGroup: 'sg-new-1', quantity: 2, reason: 'consumed' }]);

    await pc.deleteEmbeddedDocuments('Item', [item.id]);
    await engine.flush();
    expect(api.apply.mock.calls[2][0]).toEqual([{ type: 'delete', syncGroup: 'sg-new-1' }]);
    expect(store.get(KEYS.known).groups['sg-new-1']).toBeUndefined();
  });

  it('turns a drag to another linked actor into a move', async () => {
    const other = fx.dnd5e.character([]);
    other.name = 'Lidda';
    const { engine, api, pc, others } = await started({ extraActors: [other] });
    const [item] = await pc.createEmbeddedDocuments('Item', [fx.dnd5e.potion()]);
    await engine.flush();
    const sg = flagOf(item).syncGroup;
    api.apply.mockClear();
    // Foundry moves an item between actors as create (flags copied) + delete.
    await others[0].createEmbeddedDocuments('Item', [item.toObject()]);
    await pc.deleteEmbeddedDocuments('Item', [item.id]);
    await engine.flush();
    expect(api.apply.mock.calls[0][0]).toEqual([{ type: 'move', syncGroup: sg, to: 'p2' }]);
    expect(store.get(KEYS.known).groups[sg].owner).toBe('p2');
  });

  it('turns a partial split onto another actor into a partial move with a new syncGroup', async () => {
    const other = fx.dnd5e.character([]);
    const { engine, api, pc, others, env } = await started({ extraActors: [other] });
    const [item] = await pc.createEmbeddedDocuments('Item', [fx.dnd5e.potion()]);
    await engine.flush();
    const sg = flagOf(item).syncGroup;
    api.apply.mockClear();
    const copy = item.toObject();
    copy.system.quantity = 1;
    const [moved] = await others[0].createEmbeddedDocuments('Item', [copy]);
    await item.update({ 'system.quantity': 2 });
    engine._createdAt.clear(); // settled
    await engine.flush();
    expect(api.apply.mock.calls[0][0]).toEqual([{ type: 'move', syncGroup: sg, to: 'p2', quantity: 1 }]);
    const newSg = flagOf(env.actors.get(others[0].id).items.get(moved.id)).syncGroup;
    expect(newSg).toMatch(/^sg-split-/);
    expect(store.get(KEYS.known).groups[sg].quantity).toBe(2);
    expect(store.get(KEYS.known).groups[newSg]).toMatchObject({ owner: 'p2', quantity: 1 });
  });

  it('sends a purse op, then rewrites Foundry to pp 0 / ep 0 with the same totals', async () => {
    const { engine, api, pc } = await started({ currency: { pp: 0, gp: 0, ep: 0, sp: 0, cp: 0 } });
    await pc.update({ 'system.currency': { pp: 2, gp: 3, ep: 1, sp: 0, cp: 4 } });
    await engine.flush();
    expect(api.apply.mock.calls[0][0]).toEqual([{ type: 'purse', owner: 'p1', coins: { pp: 2, gp: 3, ep: 1, sp: 0, cp: 4 } }]);
    expect(pc.system.currency).toEqual({ pp: 0, gp: 23, ep: 0, sp: 5, cp: 4 });
    expect(store.get(KEYS.known).purses.p1).toEqual({ gold: 23, silver: 5, copper: 4 });
    api.apply.mockClear();
    await engine.flush();
    expect(api.apply).not.toHaveBeenCalled();
  });
});

describe('queue persistence', () => {
  it('keeps unsent ops in the world setting and sends them after a reload', async () => {
    const { engine, api, pc } = await started();
    api.apply.mockRejectedValueOnce(new NetworkError(new TypeError('offline')));
    const [item] = await pc.createEmbeddedDocuments('Item', [fx.dnd5e.potion()]);
    await engine.flush();
    const queued = store.get(KEYS.queue);
    expect(queued).toHaveLength(1);
    expect(queued[0].op).toMatchObject({ type: 'create', clientId: item.uuid });
    engine.stop();

    // "Reload": a new engine over the same settings.
    const api2 = fakeApi();
    api2.stateValue = api.stateValue;
    const engine2 = new SyncEngine({ adapter: getAdapter('dnd5e'), api: api2, store, notify: vi.fn(), setTimeout: () => 0, clearTimeout: () => {} });
    await engine2.start();
    expect(api2.apply.mock.calls[0][0]).toEqual([queued[0].op]);
    expect(store.get(KEYS.queue)).toEqual([]);
    expect(flagOf(item).syncGroup).toBe('sg-new-1');
  });

  it('does not diff again while earlier ops are still unsent', async () => {
    const { engine, api, pc } = await started();
    api.apply.mockRejectedValue(new NetworkError(new TypeError('offline')));
    await pc.createEmbeddedDocuments('Item', [fx.dnd5e.potion()]);
    await engine.flush();
    await engine.flush();
    expect(store.get(KEYS.queue)).toHaveLength(1);
  });

  it('drops a refused batch and reloads state on the next poll', async () => {
    const { engine, api, pc, notify } = await started();
    api.apply.mockRejectedValueOnce(new ApiError(409, { error: 'moved', message: 'The rows changed.' }));
    await pc.createEmbeddedDocuments('Item', [fx.dnd5e.potion()]);
    await engine.flush();
    expect(store.get(KEYS.queue)).toEqual([]);
    expect(engine.needsResync).toBe(true);
    expect(notify).toHaveBeenCalledWith('warn', expect.any(String));
    await engine.poll();
    expect(api.state).toHaveBeenCalledTimes(1);
    expect(api.changes).not.toHaveBeenCalled();
  });
});

describe('inbound reconcile', () => {
  it('creates, updates, sets quantity, moves and deletes from D20 groups', async () => {
    const other = fx.dnd5e.character([]);
    const { engine, api, pc, others, env } = await started({ extraActors: [other] });
    const poll = async (groups) => {
      api.changes.mockResolvedValueOnce({ cursor: String(Math.random()), groups, purses: [], containers: [] });
      await engine.poll();
    };
    const itemsOf = (actor) => env.actors.get(actor.id).items.contents;

    await poll([group()]);
    expect(itemsOf(pc)).toHaveLength(1);
    const item = itemsOf(pc)[0];
    expect(item.name).toBe('Potion of Healing');
    expect(item.system.quantity).toBe(2);
    expect(flagOf(item)).toEqual({ syncGroup: 'g1', owner: 'p1' });

    await poll([group({ name: 'Potion of Greater Healing', value: 150, quantity: 4 })]);
    expect(itemsOf(pc)).toHaveLength(1);
    expect(itemsOf(pc)[0].name).toBe('Potion of Greater Healing');
    expect(itemsOf(pc)[0].system.price).toEqual({ value: 150, denomination: 'gp' });
    expect(itemsOf(pc)[0].system.quantity).toBe(4);

    await poll([group({ owner: 'p2', name: 'Potion of Greater Healing', value: 150, quantity: 4 })]);
    expect(itemsOf(pc)).toHaveLength(0);
    expect(itemsOf(others[0])).toHaveLength(1);
    expect(flagOf(itemsOf(others[0])[0])).toEqual({ syncGroup: 'g1', owner: 'p2' });

    await poll([group({ owner: 'p2', quantity: 0 })]);
    expect(itemsOf(others[0])).toHaveLength(0);
    expect(store.get(KEYS.known).groups.g1).toBeUndefined();

    // Every write carried the sync option, and none of it echoes back out.
    const writes = env.Hooks.calls.filter(([n]) => ['createItem', 'updateItem', 'deleteItem'].includes(n));
    expect(writes.length).toBeGreaterThan(0);
    for (const [, , a, b] of writes) expect((typeof a === 'object' && a?.d20Sync) || b?.d20Sync).toBeTruthy();
    await engine.flush();
    expect(api.apply).not.toHaveBeenCalled();
  });

  it('removes items of a group that moved to a character with no linked actor', async () => {
    const { engine, api, pc } = await started();
    api.changes.mockResolvedValueOnce({ cursor: '12', groups: [group()], purses: [], containers: [] });
    await engine.poll();
    api.changes.mockResolvedValueOnce({ cursor: '13', groups: [group({ owner: 'p-unlinked' })], purses: [], containers: [] });
    await engine.poll();
    expect(pc.items.size).toBe(0);
  });

  it('shows ammunition charges as the Foundry quantity', async () => {
    const { engine, api, pc } = await started();
    api.changes.mockResolvedValueOnce({
      cursor: '12', groups: [group({ name: 'Arrows', isAmmunition: true, consumable: false, itemIcon: 'weapon', quantity: 1, charges: 37 })], purses: [], containers: [],
    });
    await engine.poll();
    const item = pc.items.contents[0];
    expect(item.system.quantity).toBe(37);
    expect(item.system.type.value).toBe('ammo');
  });

  it('writes purses and the party fund with pp = 0', async () => {
    const { engine, api, pc, party } = await started({ currency: { pp: 1, gp: 0, ep: 0, sp: 0, cp: 0 } });
    api.changes.mockResolvedValueOnce({
      cursor: '12', groups: [], purses: [{ id: 'p1', name: 'Merric', gold: 25.5, silver: 2, copper: 1 }], partyFund: { gold: 100, silver: 0, copper: 0 }, containers: [],
    });
    await engine.poll();
    expect(pc.system.currency).toEqual({ pp: 0, gp: 25.5, ep: 0, sp: 2, cp: 1 });
    expect(party.system.currency).toMatchObject({ gp: 100, pp: 0 });
  });

  it('reloads state and reconciles when changes says reset', async () => {
    const { engine, api, pc } = await started();
    api.stateValue.groups = [group({ syncGroup: 'g7', name: 'Rope', consumable: false, itemIcon: null, quantity: 1 })];
    api.stateValue.cursor = '500';
    api.changes.mockResolvedValueOnce({ reset: true });
    await engine.poll();
    expect(api.state).toHaveBeenCalledTimes(1);
    expect(store.get(KEYS.cursor)).toBe('500');
    expect(pc.items.contents.map((i) => i.name)).toEqual(['Rope']);
  });

  it('advances the cursor from changes', async () => {
    const { engine, api } = await started();
    api.changes.mockResolvedValueOnce({ cursor: '77', groups: [], purses: [], containers: [] });
    await engine.poll();
    expect(api.changes).toHaveBeenLastCalledWith('10');
    expect(store.get(KEYS.cursor)).toBe('77');
  });

  it('removes flagged items whose group D20 no longer has when state loads', async () => {
    const { engine, api, pc } = await started();
    api.changes.mockResolvedValueOnce({ cursor: '12', groups: [group()], purses: [], containers: [] });
    await engine.poll();
    expect(pc.items.size).toBe(1);
    api.stateValue.groups = [];
    await engine.loadState();
    expect(pc.items.size).toBe(0);
  });

  it('reconciles pf1 container contents in place', async () => {
    const { engine, api, pc } = await started({
      systemId: 'pf1',
      items: [fx.pf1.backpack({ inner1: { ...fx.pf1.potion(), _id: 'inner1', flags: { [MODULE_ID]: { syncGroup: 'g1', owner: 'p1' } } } })],
    });
    const adapter = getAdapter('pf1');
    api.changes.mockResolvedValueOnce({
      cursor: '12', groups: [group({ name: 'Potion of Cure Light Wounds', value: 50, weight: 0.1, quantity: 1, charges: null })], purses: [], containers: [],
    });
    await engine.poll();
    const inner = adapter.listInventory(pc).find((i) => i.parentItem);
    expect(inner.system.quantity).toBe(1);
    expect(pc.items.size).toBe(1); // still inside the backpack, not duplicated at top level
  });
});

describe('pf2e coins', () => {
  it('writes a D20 purse through the coin items without echoing it back', async () => {
    const { engine, api, pc } = await started({ systemId: 'pf2e', items: [fx.pf2e.coins('pp', 1)] });
    api.changes.mockResolvedValueOnce({ cursor: '12', groups: [], purses: [{ id: 'p1', gold: 7, silver: 3, copper: 0 }], containers: [] });
    await engine.poll();
    expect(getAdapter('pf2e').readCurrency(pc)).toEqual({ pp: 0, gp: 7, ep: 0, sp: 3, cp: 0 });
    // The coin item writes had no d20Sync (pf2e's helpers take no options): the hooks fired,
    // but the purse matches `known`, so nothing goes out.
    await engine.flush();
    expect(api.apply).not.toHaveBeenCalled();
  });
});

describe('first link', () => {
  async function firstLinkSetup(mode) {
    const ctx = await setup({ items: [fx.dnd5e.potion(), fx.dnd5e.gem()] });
    const { api, pc } = ctx;
    api.stateValue.groups = [
      group({ syncGroup: 'gp', name: 'potion of healing', quantity: 5 }),
      group({ syncGroup: 'gr', name: 'Rope', consumable: false, itemIcon: null, quantity: 1, charges: null }),
    ];
    api.stateValue.players = [{ id: 'p1', name: 'Merric', gold: 10, silver: 0, copper: 0 }];
    await store.set(KEYS.firstLink, { ...store.get(KEYS.firstLink), p1: { actorUuid: pc.uuid, mode, done: false } });
    await ctx.engine.start();
    return ctx;
  }

  it('D20 wins: pairs by name, takes D20 values, removes unpaired Foundry items', async () => {
    const { pc, api } = await firstLinkSetup('d20');
    const names = pc.items.contents.map((i) => i.name).sort();
    // D20's spelling wins too.
    expect(names).toEqual(['Rope', 'potion of healing']);
    const potion = pc.items.find((i) => i.name === 'potion of healing');
    expect(flagOf(potion).syncGroup).toBe('gp');
    expect(potion.system.quantity).toBe(5);
    expect(pc.system.currency.gp).toBe(10);
    expect(api.apply).not.toHaveBeenCalled();
    expect(store.get(KEYS.firstLink).p1.done).toBe(true);
  });

  it('Keep both: pairs by name, adds D20 groups, keeps unpaired Foundry items and sends them now', async () => {
    const { pc, api } = await firstLinkSetup('merge');
    expect(pc.items.contents.map((i) => i.name).sort()).toEqual(['Rope', 'Ruby', 'potion of healing']);
    expect(pc.items.find((i) => i.name === 'potion of healing').system.quantity).toBe(5);
    const ops = api.apply.mock.calls.flatMap(([o]) => o);
    expect(ops).toEqual([expect.objectContaining({ type: 'create', owner: 'p1', item: expect.objectContaining({ name: 'Ruby' }) })]);
    // D20's purse was not empty, so it stays.
    expect(pc.system.currency.gp).toBe(10);
  });

  it("Keep both: the actor's coins go to D20 when D20's purse is empty", async () => {
    const ctx = await setup({ currency: { pp: 0, gp: 42, ep: 0, sp: 3, cp: 0 } });
    ctx.api.stateValue.players = [{ id: 'p1', name: 'Merric', gold: 0, silver: 0, copper: 0 }];
    await store.set(KEYS.firstLink, { ...store.get(KEYS.firstLink), p1: { actorUuid: ctx.pc.uuid, mode: 'merge', done: false } });
    await ctx.engine.start();
    expect(ctx.pc.system.currency).toMatchObject({ gp: 42, sp: 3 });
    const ops = ctx.api.apply.mock.calls.flatMap(([o]) => o);
    expect(ops).toContainEqual({ type: 'purse', owner: 'p1', coins: { pp: 0, gp: 42, ep: 0, sp: 3, cp: 0 } });
  });

  it('Foundry wins: D20 takes Foundry quantities, new items and coins; missing groups are discarded', async () => {
    const { api, pc } = await firstLinkSetup('foundry');
    const ops = api.apply.mock.calls.flatMap(([o]) => o);
    expect(ops).toEqual(expect.arrayContaining([
      { type: 'quantity', syncGroup: 'gp', quantity: 3, reason: 'consumed' },
      { type: 'delete', syncGroup: 'gr' },
      expect.objectContaining({ type: 'create', owner: 'p1', item: expect.objectContaining({ name: 'Ruby' }) }),
      { type: 'purse', owner: 'p1', coins: { pp: 0, gp: 0, ep: 0, sp: 0, cp: 0 } },
    ]));
    // The name differs only in case; Foundry's spelling wins too.
    expect(ops).toEqual(expect.arrayContaining([{ type: 'update', syncGroup: 'gp', fields: { name: 'Potion of Healing' } }]));
    expect(pc.items.size).toBe(2);
  });
});

describe('connection loss', () => {
  it('a 401 stops the engine, clears the token and shows Reconnect', async () => {
    const ctx = await setup();
    const fetch = vi.fn(async (url) => {
      if (url.endsWith('/state')) return { ok: true, status: 200, text: async () => JSON.stringify(ctx.api.stateValue) };
      return { ok: false, status: 401, text: async () => JSON.stringify({ error: 'revoked', message: 'Revoked.' }) };
    });
    let engine;
    const api = new D20Api({ fetch, getToken: () => store.token(), onUnauthorized: () => engine.onUnauthorized(), retryDelayMs: 1 });
    engine = new SyncEngine({ adapter: getAdapter('dnd5e'), api, store, notify: ctx.notify, setTimeout: () => 0, clearTimeout: () => {} });
    await engine.start();
    expect(engine.running).toBe(true);
    await engine.poll();
    await Promise.resolve();
    expect(engine.running).toBe(false);
    expect(engine.status).toBe('revoked');
    expect(store.token()).toBe('');
    expect(ctx.notify).toHaveBeenCalledWith('warn', expect.any(String));
  });

  it('only the active GM starts syncing', async () => {
    const ctx = await setup();
    globalThis.game.users.activeGM = { id: 'other-gm' };
    await ctx.engine.start();
    expect(ctx.engine.running).toBe(false);
    expect(ctx.api.state).not.toHaveBeenCalled();
  });

  it('backs off after errors and returns to 3 s after a success', async () => {
    const { engine, api } = await started();
    api.changes.mockRejectedValueOnce(new NetworkError(new TypeError('offline')));
    api.changes.mockRejectedValueOnce(new ApiError(502, {}));
    await engine.poll();
    expect(engine._pollDelay).toBe(6000);
    await engine.poll();
    expect(engine._pollDelay).toBe(12000);
    expect(engine.status).toBe('error');
    await engine.poll();
    expect(engine._pollDelay).toBe(3000);
    expect(engine.status).toBe('connected');
  });
});

describe('actor mapping', () => {
  it('suggests an actor by exact, then case-insensitive name', () => {
    const actors = [{ name: 'merric' }, { name: 'Merric' }, { name: 'Lidda' }];
    expect(SyncEngine.suggestActor('Merric', actors)).toBe(actors[1]);
    expect(SyncEngine.suggestActor('LIDDA', actors)).toBe(actors[2]);
    expect(SyncEngine.suggestActor('Nobody', actors)).toBeNull();
  });

  it('saves links on the server, flags actors, and records the first-link choice', async () => {
    const { engine, api, env } = await started();
    const newPc = env.addActor(fx.dnd5e.character([]));
    const links = { ...store.get(KEYS.links), p5: newPc.uuid };
    await engine.saveLinks(links, { p5: 'foundry' });
    expect(api.putActors).toHaveBeenCalledWith(expect.arrayContaining([{ target: 'p5', actorUuid: newPc.uuid }]));
    expect(newPc.flags[MODULE_ID].target).toBe('p5');
    expect(store.get(KEYS.firstLink).p5).toMatchObject({ actorUuid: newPc.uuid, mode: 'foundry' });
  });

  it('defaults the first-link choice to Keep both', async () => {
    const { engine, env } = await started();
    const newPc = env.addActor(fx.dnd5e.character([]));
    await engine.saveLinks({ ...store.get(KEYS.links), p5: newPc.uuid });
    expect(store.get(KEYS.firstLink).p5).toMatchObject({ actorUuid: newPc.uuid, mode: 'merge', done: true });
  });

  it('refuses the same actor for two links before calling the server', async () => {
    const { engine, api, pc } = await started();
    await expect(engine.saveLinks({ ...store.get(KEYS.links), party: pc.uuid })).rejects.toThrow('Notify.DuplicateActor');
    expect(api.putActors).not.toHaveBeenCalled();
  });

  it('counts an actor linked twice once, so its items keep their quantity', async () => {
    const { engine, api, pc, loot } = await started();
    api.stateValue.actorLinks = [
      { target: 'p1', actorUuid: pc.uuid }, { target: 'party', actorUuid: pc.uuid }, { target: 'incoming', actorUuid: loot.uuid },
    ];
    api.stateValue.groups = [group({ quantity: 2 })];
    await engine.loadState();
    expect(pc.items.size).toBe(1);
    expect(pc.items.contents[0].system.quantity).toBe(2);
    await engine.flush();
    expect(api.apply).not.toHaveBeenCalled();
  });

  it('after a failed reload, runs the first link on the next poll instead of reconciling', async () => {
    const { engine, api, env } = await started();
    const newPc = env.addActor(fx.dnd5e.character([fx.dnd5e.potion()]));
    api.stateValue.groups = [group({ syncGroup: 'g5', owner: 'p5', quantity: 3 })];
    api.state.mockRejectedValueOnce(new ApiError(502, {}));
    await expect(engine.saveLinks({ ...store.get(KEYS.links), p5: newPc.uuid })).rejects.toThrow();
    expect(engine.needsResync).toBe(true);
    // A change for p5 arrives before the reload: it must not add a second potion.
    api.changes.mockResolvedValue({ cursor: '12', groups: [group({ syncGroup: 'g5', owner: 'p5', quantity: 3 })], purses: [], containers: [] });
    await engine.poll();
    expect(newPc.items.size).toBe(1);
    expect(flagOf(newPc.items.contents[0]).syncGroup).toBe('g5');
    expect(newPc.items.contents[0].system.quantity).toBe(3);
  });

  it('skips inbound changes for an actor whose first link has not run, and reloads', async () => {
    const { engine, api, env } = await started();
    const newPc = env.addActor(fx.dnd5e.character([fx.dnd5e.potion()]));
    await store.set(KEYS.links, { ...store.get(KEYS.links), p5: newPc.uuid });
    await store.set(KEYS.firstLink, { ...store.get(KEYS.firstLink), p5: { actorUuid: newPc.uuid, mode: 'merge', done: false } });
    api.changes.mockResolvedValueOnce({ cursor: '12', groups: [group({ syncGroup: 'g5', owner: 'p5', quantity: 3 })], purses: [], containers: [] });
    await engine.poll();
    expect(newPc.items.size).toBe(1);
    expect(flagOf(newPc.items.contents[0]).syncGroup).toBeUndefined();
    expect(engine.needsResync).toBe(true);
  });
});

describe('purse writes', () => {
  it.each(['pf1', 'pf2e'])('%s: a fractional D20 purse becomes whole coins and is not sent back', async (systemId) => {
    const { engine, api, pc } = await started({ systemId });
    api.changes.mockResolvedValueOnce({ cursor: '12', groups: [], purses: [{ id: 'p1', gold: 12.5, silver: 0, copper: 0 }], containers: [] });
    await engine.poll();
    expect(getAdapter(systemId).readCurrency(pc)).toMatchObject({ gp: 12, sp: 5, cp: 0 });
    await engine.flush();
    expect(api.apply).not.toHaveBeenCalled();
  });

  it('writes a D20 purse with the same total but different coins', async () => {
    const { engine, api, pc } = await started({ currency: { pp: 0, gp: 12, ep: 0, sp: 0, cp: 0 } });
    api.changes.mockResolvedValueOnce({ cursor: '12', groups: [], purses: [{ id: 'p1', gold: 11, silver: 10, copper: 0 }], containers: [] });
    await engine.poll();
    expect(pc.system.currency).toMatchObject({ gp: 11, sp: 10 });
  });
});

describe('which browser syncs', () => {
  const pairedHere = async (key = 'k1') => {
    await store.set(KEYS.clientKey, key);
    await store.set(KEYS.connection, { ...store.get(KEYS.connection), clientKey: 'k1' });
  };

  afterEach(() => { runtime.engine = null; });

  it('the browser that paired syncs even when another GM is the active GM', async () => {
    const ctx = await setup();
    await pairedHere();
    globalThis.game.users.activeGM = { id: 'other-gm' };
    await ctx.engine.start();
    expect(ctx.engine.running).toBe(true);
  });

  it('any other browser does not sync, even as the active GM', async () => {
    const ctx = await setup();
    await pairedHere('old-key');
    await ctx.engine.start();
    expect(ctx.engine.running).toBe(false);
    expect(ctx.api.state).not.toHaveBeenCalled();
  });

  it('stops when another browser pairs', async () => {
    const ctx = await setup();
    await pairedHere();
    runtime.engine = ctx.engine;
    await ctx.engine.start();
    await store.set(KEYS.connection, { ...store.get(KEYS.connection), clientKey: 'k2' });
    updateSyncClient();
    expect(ctx.engine.running).toBe(false);
  });

  it('a connection from before clientKey follows the active GM, whose browser then claims it', async () => {
    const ctx = await setup();
    expect(store.get(KEYS.connection).clientKey).toBeUndefined();
    await ctx.engine.start();
    expect(ctx.engine.running).toBe(true);
    const connection = store.get(KEYS.connection);
    expect(connection.clientKey).toBeTruthy();
    expect(store.get(KEYS.clientKey)).toBe(connection.clientKey);
    // From now on another GM becoming active does not move the sync away from this browser.
    globalThis.game.users.activeGM = { id: 'other-gm' };
    expect(ctx.engine.canSync()).toBe(true);
  });

  it('pairing records this browser and its GM, then syncs here', async () => {
    const ctx = await setup();
    runtime.engine = ctx.engine;
    await completePairing({ token: 'tok2', connection: { id: 'c1', campaignId: 'camp', campaignName: 'Test' } });
    const connection = store.get(KEYS.connection);
    expect(connection.clientKey).toBeTruthy();
    expect(store.get(KEYS.clientKey)).toBe(connection.clientKey);
    expect(connection.pairedBy).toBe('gm1');
    expect(ctx.engine.running).toBe(true);
  });
});
