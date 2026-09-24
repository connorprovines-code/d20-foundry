// The sync engine. Runs only on the active GM's client.
//
// Outbound: item and actor hooks mark the engine dirty; 500 ms later it snapshots the
// linked actors, diffs them against `known` (diff.js), stores the resulting ops in the
// world-scoped queue, and posts them to `apply`. The queue is sent again after a reload
// until the server accepts it.
//
// Inbound: while connected it polls `changes` every 3 s (backing off on errors) and
// reconciles each group onto the linked actors with {d20Sync: true}. `reset` reloads
// `state`, which is also how every session starts, and runs the first-link choice for
// newly linked actors.

import { ApiError } from '../api.js';
import {
  DEBOUNCE_MS, MAX_OPS_PER_APPLY, MAX_POLL_BACKOFF_MS, MODULE_ID, MOVE_SETTLE_MS, OWNER_INCOMING, OWNER_PARTY,
  POLL_MS, SYNC_OPTION, t,
} from '../constants.js';
import { KEYS } from '../settings.js';
import { changedFields, num, realName, syncGroupOf } from '../systems/common.js';
import { foldCoins, hasUnfoldedCoins, samePurse } from './coins.js';
import { diffInventory, diffPurses } from './diff.js';

const OPTS = Object.freeze({ [SYNC_OPTION]: true });
const opts = () => ({ ...OPTS });

/** Fields whose value in Foundry follows from the item type, never from an edit. */
const DERIVED_FIELDS = ['itemIcon', 'consumable', 'isTreasure', 'isAmmunition'];

/** A D20 group in the comparable itemToFields shape. */
export function groupToFields(group) {
  return {
    name: group.name,
    value: group.value === null || group.value === undefined ? undefined : num(group.value),
    weight: group.weight === null || group.weight === undefined ? undefined : num(group.weight),
    bulk: group.bulk === null || group.bulk === undefined ? undefined : num(group.bulk),
    charges: group.charges ?? null,
    itemIcon: group.itemIcon ?? null,
    consumable: !!group.consumable,
    isTreasure: !!group.isTreasure,
    rarity: group.rarity ?? null,
    isUnidentified: !!group.isUnidentified,
    unidentifiedName: group.unidentifiedName ?? null,
    isAttuned: !!group.isAttuned,
    isAmmunition: !!group.isAmmunition,
    equipped: !!group.equippedSlot,
  };
}

/** Foundry quantity for a group: ammunition shows its charges as the quantity. */
export const foundryQuantity = (group) =>
  (group.isAmmunition ? Math.max(0, Math.trunc(num(group.charges))) : Math.max(0, Math.trunc(num(group.quantity))));

export class SyncEngine {
  /**
   * @param {object} deps
   * @param {object} deps.adapter  a system adapter (systems/index.js)
   * @param {import('../api.js').D20Api} deps.api
   * @param {object} deps.store    settings.js store
   * @param {(level: string, message: string) => void} [deps.notify]
   * @param {() => number} [deps.now]
   * @param {typeof setTimeout} [deps.setTimeout]
   * @param {typeof clearTimeout} [deps.clearTimeout]
   */
  constructor({ adapter, api, store, notify, now, setTimeout: st, clearTimeout: ct }) {
    this.adapter = adapter;
    this.api = api;
    this.store = store;
    this.notify = notify ?? ((level, message) => globalThis.ui?.notifications?.[level]?.(message));
    this.now = now ?? (() => Date.now());
    this.setTimeout = st ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimeout = ct ?? ((h) => clearTimeout(h));

    this.running = false;
    this.status = 'disconnected';
    this.lastError = null;
    this.lastSyncAt = null;
    this.campaign = null;
    this.players = [];
    this.containers = [];
    this.needsResync = false;

    this._chain = Promise.resolve();
    this._dirtyTimer = null;
    this._pollTimer = null;
    this._pollDelay = POLL_MS;
    this._createdAt = new Map();
    this._listeners = new Set();
    this._hookIds = [];
  }

  // ---------------------------------------------------------------------------
  // Lifecycle

  static isActiveGM() {
    const game = globalThis.game;
    if (!game?.user?.isGM) return false;
    const active = game.users?.activeGM;
    return active ? active.id === game.user.id : true;
  }

  onChange(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  _emit() {
    for (const fn of this._listeners) {
      try { fn(this); } catch (err) { console.error(`${MODULE_ID} |`, err); }
    }
  }

  _setStatus(status, error = null) {
    this.status = status;
    this.lastError = error ? (error.message ?? String(error)) : null;
    this._emit();
  }

  async start() {
    if (this.running) return;
    if (!SyncEngine.isActiveGM()) return;
    if (!this.store.isConnected()) {
      this._setStatus('disconnected');
      return;
    }
    this.running = true;
    this._registerHooks();
    this._setStatus('connecting');
    try {
      await this._exclusive(async () => {
        await this._sendQueue();
        if (this._knownReady()) await this._flushInner();
        await this._loadState();
      });
      if (this.running) this._setStatus('connected');
    } catch (err) {
      this.needsResync = true;
      this._handleError(err);
    }
    this._schedulePoll(POLL_MS);
  }

  stop() {
    this.running = false;
    if (this._dirtyTimer) this.clearTimeout(this._dirtyTimer);
    if (this._pollTimer) this.clearTimeout(this._pollTimer);
    this._dirtyTimer = null;
    this._pollTimer = null;
    this._unregisterHooks();
    if (this.status !== 'revoked') this._setStatus('disconnected');
  }

  /** Called by the API client on a 401: the token is gone, show Reconnect. */
  async onUnauthorized() {
    this.stop();
    await this.store.set(KEYS.token, '');
    this._setStatus('revoked');
    this.notify('warn', t('Notify.Revoked'));
  }

  async disconnect() {
    try { await this.api.disconnect(); } catch { /* token may already be revoked */ }
    this.stop();
    await this.store.clearConnection();
    this._setStatus('disconnected');
  }

  // ---------------------------------------------------------------------------
  // Hooks

  _registerHooks() {
    if (this._hookIds.length) return;
    const Hooks = globalThis.Hooks;
    const on = (name, fn) => this._hookIds.push([name, Hooks.on(name, fn)]);
    on('createItem', (item, options) => this.onItemHook(item, options, 'create'));
    on('updateItem', (item, _changes, options) => this.onItemHook(item, options, 'update'));
    on('deleteItem', (item, options) => this.onItemHook(item, options, 'delete'));
    on('updateActor', (actor, changes, options) => this.onActorHook(actor, changes, options));
  }

  _unregisterHooks() {
    const Hooks = globalThis.Hooks;
    for (const [name, id] of this._hookIds) Hooks.off(name, id);
    this._hookIds = [];
  }

  onItemHook(item, options, kind) {
    if (!this.running || options?.[SYNC_OPTION]) return;
    const actor = item?.actor ?? item?.parent;
    if (!actor || !this._ownerOfActor(actor)) return;
    if (kind === 'create') this._createdAt.set(item.uuid, this.now());
    this.markDirty();
  }

  onActorHook(actor, changes, options) {
    if (!this.running || options?.[SYNC_OPTION]) return;
    // Only coin changes matter here (pf2e coins are items and arrive through the item hooks).
    if (changes && changes.system?.currency === undefined) return;
    if (!this._ownerOfActor(actor)) return;
    this.markDirty();
  }

  markDirty(delay = DEBOUNCE_MS) {
    this._dirty = true;
    if (this._dirtyTimer) this.clearTimeout(this._dirtyTimer);
    this._dirtyTimer = this.setTimeout(() => {
      this._dirtyTimer = null;
      this.flush().catch((err) => this._handleError(err));
    }, delay);
  }

  // ---------------------------------------------------------------------------
  // Serialization: outbound flushes, polls and state loads never interleave.

  _exclusive(fn) {
    const run = this._chain.then(() => fn());
    this._chain = run.catch(() => {});
    return run;
  }

  // ---------------------------------------------------------------------------
  // Actor links

  links() { return this.store.get(KEYS.links) ?? {}; }
  known() {
    const k = this.store.get(KEYS.known) ?? {};
    k.groups ??= {};
    k.purses ??= {};
    return k;
  }

  _knownReady() { return !!this.store.get(KEYS.known)?.ready; }

  _resolveActor(uuid) {
    if (!uuid) return null;
    const g = globalThis;
    try {
      const doc = g.fromUuidSync?.(uuid);
      if (doc) return doc;
    } catch { /* fall through */ }
    const id = String(uuid).split('.').pop();
    return g.game?.actors?.get?.(id) ?? null;
  }

  actorFor(owner) {
    return this._resolveActor(this.links()[owner]);
  }

  _ownerOfActor(actor) {
    const links = this.links();
    for (const [owner, uuid] of Object.entries(links)) {
      if (uuid === actor.uuid) return owner;
    }
    return null;
  }

  /** Linked owners whose first-link reconcile is done; only these are diffed outbound. */
  _syncedOwners() {
    const links = this.links();
    const first = this.store.get(KEYS.firstLink) ?? {};
    const out = [];
    for (const [owner, uuid] of Object.entries(links)) {
      if (first[owner]?.done && first[owner].actorUuid === uuid) {
        const actor = this._resolveActor(uuid);
        if (actor) out.push({ owner, actor });
      }
    }
    return out;
  }

  _inventory(owner, actor) {
    return this.adapter.listInventory(actor, { coinsAsItems: owner === OWNER_INCOMING });
  }

  _entry(owner, item) {
    return {
      uuid: item.uuid,
      owner,
      syncGroup: syncGroupOf(item),
      quantity: this.adapter.getQuantity(item),
      fields: this.adapter.itemToFields(item),
      consumable: this.adapter.isConsumable(item),
      createdAt: this._createdAt.get(item.uuid),
      item,
    };
  }

  _snapshot() {
    const entries = [];
    const activeOwners = new Set();
    for (const { owner, actor } of this._syncedOwners()) {
      activeOwners.add(owner);
      for (const item of this._inventory(owner, actor)) entries.push(this._entry(owner, item));
    }
    return { entries, activeOwners };
  }

  /** Items carrying a group's flag on any linked actor (indexed; any write clears the index). */
  _findGroupItems(syncGroup) {
    if (!this._index) {
      this._index = new Map();
      for (const [owner, uuid] of Object.entries(this.links())) {
        const actor = this._resolveActor(uuid);
        if (!actor) continue;
        for (const item of this._inventory(owner, actor)) {
          const sg = syncGroupOf(item);
          if (!sg) continue;
          if (!this._index.has(sg)) this._index.set(sg, []);
          this._index.get(sg).push({ item, actor, owner });
        }
      }
    }
    return [...(this._index.get(syncGroup) ?? [])];
  }

  _pruneCreatedAt() {
    const cutoff = this.now() - 60000;
    for (const [uuid, at] of this._createdAt) if (at < cutoff) this._createdAt.delete(uuid);
  }

  _findItem(uuid) {
    for (const [owner, actorUuid] of Object.entries(this.links())) {
      const actor = this._resolveActor(actorUuid);
      if (!actor) continue;
      const hit = this._inventory(owner, actor).find((i) => i.uuid === uuid);
      if (hit) return hit;
    }
    return null;
  }

  async _setFlags(item, syncGroup, owner) {
    const f = item.flags?.[MODULE_ID] ?? {};
    if (f.syncGroup === syncGroup && f.owner === owner) return;
    await this._write('updateItem', item, {
      [`flags.${MODULE_ID}.syncGroup`]: syncGroup,
      [`flags.${MODULE_ID}.owner`]: owner,
    }, opts());
  }

  // ---------------------------------------------------------------------------
  // Outbound

  async flush() {
    if (!this.running) return;
    await this._exclusive(() => this._flushInner());
  }

  async _flushInner() {
    this._dirty = false;
    if (!this.running) return;
    if (!(await this._sendQueue())) return;
    if (this.needsResync) return; // a refused batch: state reloads first, on the next poll
    this._pruneCreatedAt();

    const known = this.known();
    const { entries, activeOwners } = this._snapshot();
    const { ops, deferred } = diffInventory({ entries, known, activeOwners, now: this.now(), settleMs: MOVE_SETTLE_MS });

    const purses = [];
    for (const { owner, actor } of this._syncedOwners()) {
      if (owner === OWNER_INCOMING) continue; // coin loot there is items, not a purse
      purses.push({ owner, coins: this.adapter.readCurrency(actor) });
    }
    const purseOps = diffPurses(purses, known.purses);

    // Same totals, only platinum/electrum to fold: done locally, nothing to send.
    for (const { op, meta } of purseOps) {
      if (op) continue;
      await this._foldLocally(meta.owner, meta.folded);
    }

    const queued = [...ops, ...purseOps.filter((p) => p.op)];
    if (queued.length) {
      const queue = this.store.get(KEYS.queue) ?? [];
      queue.push(...queued.map(({ op, meta }) => ({ op, meta })));
      await this.store.set(KEYS.queue, queue);
      await this._sendQueue();
    }
    if (deferred && this.running) this.markDirty(MOVE_SETTLE_MS);
  }

  /**
   * Posts the stored queue in batches of 100. Returns true when the queue is empty afterwards.
   * Network and 5xx errors keep the queue for the next attempt. A refusal (403, 409, 400)
   * drops that batch and schedules a full reload from `state`, so Foundry goes back to what
   * D20 holds.
   */
  async _sendQueue() {
    let queue = this.store.get(KEYS.queue) ?? [];
    while (queue.length) {
      const batch = queue.slice(0, MAX_OPS_PER_APPLY);
      let res;
      try {
        res = await this.api.apply(batch.map((q) => q.op));
      } catch (err) {
        if (err instanceof ApiError && err.isAuth) return false;
        if (err.isTransient) {
          this.lastError = err.message;
          this._emit();
          return false;
        }
        this.notify('warn', t('Notify.Refused', { message: err.message }));
        queue = queue.slice(batch.length);
        await this.store.set(KEYS.queue, queue);
        this.needsResync = true;
        continue;
      }
      // CONTRACT: if the page reloads after the server applied a batch but before the queue is
      // cleared, the batch is sent again; creates carry clientId (the item uuid) so the server
      // can recognise a repeat, but the contract does not say it does.
      const known = this.known();
      const results = res?.results ?? [];
      for (let i = 0; i < batch.length; i++) {
        await this._applyResult(known, batch[i].meta, results[i] ?? {});
      }
      queue = queue.slice(batch.length);
      await this.store.set(KEYS.known, known);
      await this.store.set(KEYS.queue, queue);
      this.lastSyncAt = this.now();
      // CONTRACT: apply's `cursor` is not adopted; `changes` already leaves out this
      // connection's own writes, and jumping the cursor could skip other people's changes.
    }
    return true;
  }

  async _applyResult(known, meta, result) {
    const groups = known.groups;
    switch (meta.kind) {
      case 'create': {
        const syncGroup = result.syncGroup;
        if (!syncGroup) return; // CONTRACT: create is documented to return syncGroup
        groups[syncGroup] = { owner: meta.owner, quantity: meta.quantity, fields: meta.fields, itemUuid: meta.uuid };
        const item = this._findItem(meta.uuid);
        if (item) await this._setFlags(item, syncGroup, meta.owner);
        return;
      }
      case 'update': {
        const g = groups[meta.syncGroup];
        if (!g) return;
        g.fields = { ...g.fields, ...meta.fields };
        if (meta.quantity !== undefined) g.quantity = meta.quantity;
        if (meta.itemUuid) g.itemUuid = meta.itemUuid;
        return;
      }
      case 'quantity': {
        const g = groups[meta.syncGroup];
        if (!g) return;
        if (meta.quantity <= 0) delete groups[meta.syncGroup];
        else g.quantity = meta.quantity;
        return;
      }
      case 'move': {
        const g = groups[meta.syncGroup];
        if (!g) return;
        g.owner = meta.to;
        g.itemUuid = meta.uuids[0];
        for (const uuid of meta.uuids) {
          const item = this._findItem(uuid);
          if (item) await this._setFlags(item, meta.syncGroup, meta.to);
        }
        return;
      }
      case 'split': {
        const g = groups[meta.syncGroup];
        if (g) g.quantity = Math.max(0, g.quantity - meta.quantity);
        const syncGroup = result.syncGroup;
        if (!syncGroup) return; // CONTRACT: a partial move is documented to return the new syncGroup
        groups[syncGroup] = { owner: meta.to, quantity: meta.quantity, fields: meta.fields, itemUuid: meta.uuids[0] };
        for (const uuid of meta.uuids) {
          const item = this._findItem(uuid);
          if (item) await this._setFlags(item, syncGroup, meta.to);
        }
        return;
      }
      case 'delete':
        delete groups[meta.syncGroup];
        return;
      case 'purse':
        // CONTRACT: `changes` leaves out this connection's own writes, so the folded purse
        // never comes back from D20; the module folds pp/ep itself once D20 has accepted it.
        known.purses[meta.owner] = meta.folded;
        await this._foldLocally(meta.owner, meta.folded, known);
        return;
      default:
    }
  }

  async _foldLocally(owner, folded, known) {
    const actor = this.actorFor(owner);
    if (actor && hasUnfoldedCoins(this.adapter.readCurrency(actor))) {
      await this.adapter.writeCurrency(actor, folded, opts());
    }
    if (known) {
      known.purses[owner] = folded;
    } else {
      const k = this.known();
      k.purses[owner] = folded;
      await this.store.set(KEYS.known, k);
    }
  }

  // ---------------------------------------------------------------------------
  // Inbound

  _schedulePoll(delay) {
    if (!this.running) return;
    if (this._pollTimer) this.clearTimeout(this._pollTimer);
    this._pollTimer = this.setTimeout(() => {
      this._pollTimer = null;
      this.poll().finally(() => this._schedulePoll(this._pollDelay));
    }, delay);
  }

  /** One poll cycle. Resolves after changes are applied; errors only adjust the backoff. */
  async poll() {
    if (!this.running) return;
    try {
      await this._exclusive(async () => {
        if (this._dirty) {
          if (this._dirtyTimer) this.clearTimeout(this._dirtyTimer);
          this._dirtyTimer = null;
          await this._flushInner();
        } else {
          await this._sendQueue();
        }
        if (this.needsResync) {
          await this._loadState();
          return;
        }
        const cursor = this.store.get(KEYS.cursor) ?? '';
        const res = await this.api.changes(cursor);
        if (res?.reset) {
          await this._loadState();
          return;
        }
        await this._applyChanges(res ?? {});
        if (res?.cursor !== undefined && res.cursor !== null) await this.store.set(KEYS.cursor, String(res.cursor));
      });
      this._pollDelay = POLL_MS;
      if (this.running && this.status !== 'connected') this._setStatus('connected');
      else this._emit();
    } catch (err) {
      this._handleError(err);
      this._pollDelay = Math.min(MAX_POLL_BACKOFF_MS, Math.max(POLL_MS, this._pollDelay * 2));
    }
  }

  _handleError(err) {
    if (err instanceof ApiError && err.isAuth) return; // onUnauthorized already ran
    console.warn(`${MODULE_ID} |`, err);
    this.lastError = err?.message ?? String(err);
    if (this.running) this._setStatus('error', err);
  }

  async _applyChanges(res) {
    this._index = null;
    const known = this.known();
    for (const group of res.groups ?? []) await this._reconcile(group, known);
    // CONTRACT: `purses` are Player rows; their `id` is the owner (players.id).
    for (const player of res.purses ?? []) {
      this._rememberPlayer(player);
      await this._applyPurse(player.id, player, known);
    }
    if (res.partyFund) await this._applyPurse(OWNER_PARTY, res.partyFund, known);
    if (res.containers?.length) {
      const byId = new Map(this.containers.map((c) => [c.id, c]));
      for (const c of res.containers) byId.set(c.id, c);
      this.containers = [...byId.values()];
    }
    await this.store.set(KEYS.known, known);
    this.lastSyncAt = this.now();
  }

  _rememberPlayer(player) {
    if (!player?.id) return;
    const i = this.players.findIndex((p) => p.id === player.id);
    if (i >= 0) this.players[i] = { ...this.players[i], ...player };
    else this.players.push(player);
  }

  async _applyPurse(owner, purse, known) {
    const target = { gold: num(purse.gold), silver: num(purse.silver), copper: num(purse.copper) };
    known.purses[owner] = target;
    const actor = this.actorFor(owner);
    if (!actor || owner === OWNER_INCOMING) return;
    const coins = this.adapter.readCurrency(actor);
    if (samePurse(foldCoins(coins), target) && !hasUnfoldedCoins(coins)) return;
    await this.adapter.writeCurrency(actor, target, opts());
  }

  /**
   * Makes Foundry match one D20 group: create, update fields, set quantity, move between
   * actors, or delete (quantity 0, or an owner with no linked actor).
   */
  async _reconcile(group, known) {
    const { syncGroup } = group;
    if (!syncGroup) return;
    try {
      await this._reconcileInner(group, known);
    } finally {
      if (this._wrote) this._index = null;
      this._wrote = false;
    }
  }

  async _reconcileInner(group, known) {
    const { syncGroup } = group;
    const found = this._findGroupItems(syncGroup);
    const target = this.actorFor(group.owner);
    const qty = foundryQuantity(group);
    const terminal = num(group.quantity) <= 0;

    if (terminal || !target) {
      await this._deleteFound(found);
      delete known.groups[syncGroup];
      return;
    }

    const home = found.filter((f) => f.actor.uuid === target.uuid);
    const away = found.filter((f) => f.actor.uuid !== target.uuid);
    const flags = { [MODULE_ID]: { syncGroup, owner: group.owner } };
    let primary;

    if (!home.length) {
      let data;
      if (away.length) {
        // Moved in D20: carry the Foundry item across so system details D20 does not
        // track (runes, activities, descriptions) survive.
        data = away[0].item.toObject();
        delete data._id;
        data.system ??= {};
        if ('containerId' in data.system) data.system.containerId = null;
        if ('container' in data.system) data.system.container = null;
        Object.assign(data.system, { quantity: qty });
      } else {
        data = await this.adapter.fieldsToItemData(group, qty);
      }
      data.flags = { ...(data.flags || {}), ...flags };
      const created = await this._write('createItems', target, [data], opts());
      primary = Array.isArray(created) ? created[0] : created;
      if (away.length) await this._deleteFound(away);
      if (primary) {
        const upd = this.adapter.updateDataFor(primary, group);
        if (upd) await this._write('updateItem', primary, upd, opts());
      }
    } else {
      if (away.length) await this._deleteFound(away);
      const prevUuid = known.groups[syncGroup]?.itemUuid;
      const ordered = [...home].sort((a, b) => (b.item.uuid === prevUuid) - (a.item.uuid === prevUuid));
      primary = ordered[0].item;
      let extras = ordered.slice(1).map((f) => f.item);
      const extraQty = extras.reduce((s, i) => s + this.adapter.getQuantity(i), 0);
      let want = qty - extraQty;
      if (want < 0) {
        await this._write('deleteItems', extras, opts());
        extras = [];
        want = qty;
      }
      if (this.adapter.getQuantity(primary) !== want) {
        await this._write('updateItem', primary, this.adapter.quantityUpdate(want), opts());
      }
      for (const item of [primary, ...extras]) {
        const upd = this.adapter.updateDataFor(item, group);
        if (upd) await this._write('updateItem', item, upd, opts());
        await this._setFlags(item, syncGroup, group.owner);
      }
    }

    if (!primary) return;
    known.groups[syncGroup] = {
      owner: group.owner,
      quantity: qty,
      fields: this.adapter.itemToFields(primary),
      itemUuid: primary.uuid,
    };
  }

  /** Every item write goes through here so the group index is rebuilt afterwards. */
  async _write(method, ...args) {
    this._wrote = true;
    this._index = null;
    return this.adapter[method](...args);
  }

  async _deleteFound(found) {
    const byActor = new Map();
    for (const f of found) {
      if (!byActor.has(f.actor.uuid)) byActor.set(f.actor.uuid, []);
      byActor.get(f.actor.uuid).push(f.item);
    }
    for (const items of byActor.values()) await this._write('deleteItems', items, opts());
  }

  // ---------------------------------------------------------------------------
  // Full state

  async loadState() {
    await this._exclusive(() => this._loadState());
  }

  async _loadState() {
    const state = await this.api.state();
    this.needsResync = false;
    this._index = null;
    this.campaign = state.campaign ?? null;
    this.players = state.players ?? [];
    this.containers = state.containers ?? [];

    // The server's links are authoritative (PUT actors returns them too).
    const links = {};
    for (const l of state.actorLinks ?? []) if (l?.target && l?.actorUuid) links[l.target] = l.actorUuid;
    await this.store.set(KEYS.links, links);

    const known = this.known();
    // CONTRACT: `state.groups` is taken to be every live group of the campaign (incoming, party
    // and every player, linked or not) and no terminal ones, so a known group missing from it
    // was sold, discarded or used up.
    const groups = state.groups ?? [];
    const groupIds = new Set(groups.map((g) => g.syncGroup));
    const first = this.store.get(KEYS.firstLink) ?? {};
    const foundryWins = new Set();

    for (const [owner, actorUuid] of Object.entries(links)) {
      const rec = first[owner];
      if (rec?.done && rec.actorUuid === actorUuid) continue;
      const mode = rec?.actorUuid === actorUuid ? rec.mode : 'merge';
      await this._firstLink(owner, mode ?? 'merge', groups, groupIds, known);
      if (mode === 'foundry') foundryWins.add(owner);
      first[owner] = { actorUuid, mode: mode ?? 'merge', done: true };
    }
    for (const owner of Object.keys(first)) if (!links[owner]) delete first[owner];
    await this.store.set(KEYS.firstLink, first);

    for (const group of groups) {
      if (foundryWins.has(group.owner)) continue;
      await this._reconcile(group, known);
    }

    // Flagged items whose group D20 no longer has: sold, discarded or used up while away.
    for (const [owner, actorUuid] of Object.entries(links)) {
      if (foundryWins.has(owner)) continue;
      const actor = this._resolveActor(actorUuid);
      if (!actor) continue;
      const stale = this._inventory(owner, actor).filter((i) => {
        const sg = syncGroupOf(i);
        return sg && !groupIds.has(sg) && known.groups[sg];
      });
      if (stale.length) await this._write('deleteItems', stale, opts());
    }
    for (const sg of Object.keys(known.groups)) if (!groupIds.has(sg)) delete known.groups[sg];

    for (const player of this.players) {
      if (foundryWins.has(player.id)) known.purses[player.id] = { gold: num(player.gold), silver: num(player.silver), copper: num(player.copper) };
      else await this._applyPurse(player.id, player, known);
    }
    if (state.partyFund) {
      if (foundryWins.has(OWNER_PARTY)) known.purses[OWNER_PARTY] = { ...state.partyFund };
      else await this._applyPurse(OWNER_PARTY, state.partyFund, known);
    }

    known.ready = true;
    await this.store.set(KEYS.known, known);
    if (state.cursor !== undefined && state.cursor !== null) await this.store.set(KEYS.cursor, String(state.cursor));
    this.lastSyncAt = this.now();

    // "Foundry wins" links leave D20 behind on purpose; the diff sends Foundry's side now.
    if (foundryWins.size) await this._flushInner();
    this._emit();
  }

  /**
   * First time an actor is linked: pair its unflagged items with the owner's D20 groups by
   * name (exact, then case-insensitive), then apply the GM's choice.
   * - 'd20': D20 wins. Paired items take D20's values (in the reconcile that follows),
   *   missing groups are created, and unpaired Foundry items are removed.
   * - 'foundry': Foundry wins. Paired groups take Foundry's values, unpaired Foundry items
   *   are created in D20, and groups with no Foundry item are discarded in D20.
   * - 'merge' (links made outside this world's config, so no choice was recorded): like
   *   'd20', but unpaired Foundry items are kept and sent to D20 as new items.
   */
  async _firstLink(owner, mode, groups, groupIds, known) {
    const actor = this.actorFor(owner);
    if (!actor) return;
    const items = this._inventory(owner, actor);
    const ownerGroups = groups.filter((g) => g.owner === owner);
    const flaggedHere = new Set(items.map(syncGroupOf).filter((sg) => sg && groupIds.has(sg)));
    const pool = items.filter((i) => {
      const sg = syncGroupOf(i);
      return !sg || !groupIds.has(sg);
    });
    const pairs = new Map(); // syncGroup -> item

    const take = (pred) => {
      for (const g of ownerGroups) {
        if (pairs.has(g.syncGroup) || flaggedHere.has(g.syncGroup)) continue;
        const idx = pool.findIndex((i) => pred(realName(i), g.name ?? ''));
        if (idx >= 0) pairs.set(g.syncGroup, pool.splice(idx, 1)[0]);
      }
    };
    take((a, b) => a === b);
    take((a, b) => a.toLowerCase() === b.toLowerCase());

    for (const [syncGroup, item] of pairs) await this._setFlags(item, syncGroup, owner);

    if (mode === 'd20') {
      if (pool.length) await this._write('deleteItems', pool, opts());
      return;
    }
    if (mode === 'merge') {
      // Unpaired items keep no stale flag, so the diff sends them as new.
      for (const item of pool) {
        if (syncGroupOf(item)) await this._write('updateItem', item, { [`flags.${MODULE_ID}.syncGroup`]: null }, opts());
      }
      return;
    }

    // 'foundry': `known` takes D20's side, so the next diff pushes Foundry's values.
    for (const g of ownerGroups) {
      const item = pairs.get(g.syncGroup) ?? items.find((i) => syncGroupOf(i) === g.syncGroup);
      const fromGroup = groupToFields(g);
      let fields = fromGroup;
      if (item) {
        // Type-derived fields come from the Foundry item, so they never read as edits.
        fields = { ...fromGroup };
        const own = this.adapter.itemToFields(item);
        for (const key of DERIVED_FIELDS) if (own[key] !== undefined) fields[key] = own[key];
      }
      known.groups[g.syncGroup] = {
        owner,
        quantity: foundryQuantity(g),
        fields,
        itemUuid: item?.uuid,
      };
    }
    for (const item of pool) {
      if (syncGroupOf(item)) await this._write('updateItem', item, { [`flags.${MODULE_ID}.syncGroup`]: null }, opts());
    }
  }

  // ---------------------------------------------------------------------------
  // Actor mapping (SyncConfigApp)

  /**
   * Saves links on the server and records the first-link choice for new ones.
   * @param {Record<string, string|null>} links target -> actor uuid (null unlinks)
   * @param {Record<string, 'd20'|'foundry'>} modes first-link choice per target
   */
  async saveLinks(links, modes = {}) {
    const payload = Object.entries(links)
      .filter(([, uuid]) => !!uuid)
      .map(([target, actorUuid]) => ({ target, actorUuid }));
    const res = await this.api.putActors(payload);
    const saved = {};
    for (const l of res?.actorLinks ?? payload) saved[l.target] = l.actorUuid;

    const first = this.store.get(KEYS.firstLink) ?? {};
    for (const [target, actorUuid] of Object.entries(saved)) {
      const rec = first[target];
      if (rec?.done && rec.actorUuid === actorUuid) continue;
      first[target] = { actorUuid, mode: modes[target] ?? rec?.mode ?? 'd20', done: false };
    }
    for (const target of Object.keys(first)) if (!saved[target]) delete first[target];

    const previous = this.links();
    await this.store.set(KEYS.links, saved);
    await this.store.set(KEYS.firstLink, first);
    await this._flagActors(previous, saved);
    if (this.running) await this.loadState();
    return saved;
  }

  async _flagActors(previous, next) {
    for (const [target, uuid] of Object.entries(previous)) {
      if (next[target] === uuid) continue;
      const actor = this._resolveActor(uuid);
      if (actor?.unsetFlag) await actor.unsetFlag(MODULE_ID, 'target');
    }
    for (const [target, uuid] of Object.entries(next)) {
      const actor = this._resolveActor(uuid);
      if (actor?.setFlag && actor.flags?.[MODULE_ID]?.target !== target) await actor.setFlag(MODULE_ID, 'target', target);
    }
  }

  /** Suggested actor for a D20 player: exact name, then case-insensitive. */
  static suggestActor(name, actors) {
    if (!name) return null;
    const list = Array.from(actors ?? []);
    return list.find((a) => a.name === name)
      ?? list.find((a) => (a.name ?? '').toLowerCase() === name.toLowerCase())
      ?? null;
  }
}

export { changedFields };
