// Outbound diff: compares what the linked actors hold now with what each synced group
// looked like when Foundry and D20 were last in step (`known`), and returns contract ops.
// Working from a snapshot rather than from individual hook events means a move (create on
// one actor, delete on another), a split, a pf1 container edit, or a change made while the
// module was not running all come out the same way, and the module's own writes produce
// no ops because they already match `known`.

import { changedFields, sameValue } from '../systems/common.js';
import { foldCoins, samePurse } from './coins.js';

/**
 * @typedef {object} Entry  One Foundry inventory item, as the diff sees it.
 * @property {string} uuid
 * @property {string} owner          'incoming' | 'party' | playerId (from the actor link)
 * @property {string|null} syncGroup  flag value, when it names a known group
 * @property {number} quantity        Foundry quantity
 * @property {object} fields          adapter.itemToFields(item)
 * @property {boolean} consumable     adapter.isConsumable(item)
 * @property {number} [createdAt]     ms timestamp when the item was created, if known
 *
 * @typedef {object} KnownGroup
 * @property {string} owner
 * @property {number} quantity        Foundry quantity (ammunition: the charges)
 * @property {object} fields
 * @property {string} [itemUuid]      the item that carried the group last time
 */

const CREATE_FIELDS = [
  'name', 'value', 'weight', 'bulk', 'charges', 'itemIcon', 'consumable', 'isTreasure', 'rarity',
  'isUnidentified', 'unidentifiedName', 'isAttuned', 'isAmmunition', 'foundrySource',
];

/**
 * The `item` of a create op: Group field names, no `equipped` (a later update sends it, and
 * the server picks the slot then). `notes`, `isHidden` and `containerId` are never sent from
 * Foundry: descriptions are rich HTML, Foundry has no hidden-from-players item, and Foundry
 * containers do not map to D20 containers.
 */
export function createItemFields(fields) {
  const out = {};
  for (const key of CREATE_FIELDS) if (fields[key] !== undefined) out[key] = fields[key];
  return out;
}

/** What `known` should hold for a group right after its create op succeeds. */
export function knownFieldsAfterCreate(fields) {
  const out = createItemFields(fields);
  // Equipped state is not part of create; a later diff sends it as an update when true.
  if (fields.equipped !== undefined) out.equipped = false;
  return out;
}

const sameFields = (a, b) => Object.keys(changedFields(a, b)).length === 0;

function groupByOwner(entries) {
  const map = new Map();
  for (const e of entries) {
    if (!map.has(e.owner)) map.set(e.owner, { quantity: 0, entries: [] });
    const g = map.get(e.owner);
    g.quantity += e.quantity;
    g.entries.push(e);
  }
  return map;
}

/**
 * @param {object} args
 * @param {Entry[]} args.entries
 * @param {{groups: Record<string, KnownGroup>}} args.known
 * @param {Set<string>} args.activeOwners owners whose linked actor exists; groups of any other
 *   owner are never deleted just because their items are missing
 * @param {number} [args.now]
 * @param {number} [args.settleMs]
 * @returns {{ ops: {op: object, meta: object}[], deferred: boolean }}
 */
export function diffInventory({ entries, known, activeOwners, now = Date.now(), settleMs = 1500 }) {
  const out = [];
  let deferred = false;
  const groups = known?.groups ?? {};
  const byGroup = new Map();
  const fresh = [];

  for (const e of entries) {
    if (e.syncGroup && groups[e.syncGroup]) {
      if (!byGroup.has(e.syncGroup)) byGroup.set(e.syncGroup, []);
      byGroup.get(e.syncGroup).push(e);
    } else {
      fresh.push(e);
    }
  }

  for (const [syncGroup, k] of Object.entries(groups)) {
    const es = byGroup.get(syncGroup) ?? [];

    if (!es.length) {
      if (activeOwners.has(k.owner)) {
        out.push({ op: { type: 'delete', syncGroup }, meta: { kind: 'delete', syncGroup } });
      }
      continue;
    }

    // A copy that just appeared elsewhere while the original is still home may be the first
    // half of a move whose delete has not arrived yet. Look again after it settles.
    const home = es.filter((e) => e.owner === k.owner);
    const away = es.filter((e) => e.owner !== k.owner);
    if (home.length && away.some((e) => e.createdAt && now - e.createdAt < settleMs)) {
      deferred = true;
      continue;
    }

    const byOwner = groupByOwner(es);
    let owner = k.owner;

    // Everything left the known owner: a full move to where most of it went.
    if (!byOwner.has(owner)) {
      let best = null;
      for (const [o, g] of byOwner) if (!best || g.quantity > byOwner.get(best).quantity) best = o;
      // A full move (no quantity) keeps the group's syncGroup.
      out.push({
        op: { type: 'move', syncGroup, to: best },
        meta: { kind: 'move', syncGroup, to: best, uuids: byOwner.get(best).entries.map((e) => e.uuid) },
      });
      owner = best;
    }

    const ownerEntries = byOwner.get(owner).entries;
    const primary = ownerEntries.find((e) => sameFields(k.fields, e.fields))
      ?? ownerEntries.find((e) => e.uuid === k.itemUuid)
      ?? ownerEntries[0];
    const ammo = !!(k.fields?.isAmmunition ?? primary.fields.isAmmunition);

    if (ammo) {
      // One D20 row whose charges are the count: it cannot be partly moved, so copies on
      // other actors become groups of their own.
      for (const [o, g] of byOwner) if (o !== owner) fresh.push(...g.entries);
      const fields = { ...primary.fields, charges: byOwner.get(owner).quantity };
      const changed = changedFields(k.fields, fields);
      if (Object.keys(changed).length) {
        out.push({
          op: { type: 'update', syncGroup, fields: changed },
          meta: { kind: 'update', syncGroup, fields: changed, quantity: fields.charges },
        });
      }
      continue;
    }

    const total = es.reduce((s, e) => s + e.quantity, 0);
    if (total !== k.quantity) {
      const reason = total > k.quantity ? 'added' : (primary.consumable ? 'consumed' : 'removed');
      out.push({
        op: { type: 'quantity', syncGroup, quantity: total, reason },
        meta: { kind: 'quantity', syncGroup, quantity: total },
      });
    }

    // Copies now on other actors: partial moves, each returning a new syncGroup.
    for (const [o, g] of byOwner) {
      if (o === owner) continue;
      out.push({
        op: { type: 'move', syncGroup, to: o, quantity: g.quantity },
        meta: { kind: 'split', syncGroup, to: o, quantity: g.quantity, uuids: g.entries.map((e) => e.uuid), fields: k.fields },
      });
    }

    // Copies on the same actor whose fields no longer match the stack split off as their own group.
    for (const e of ownerEntries) {
      if (e === primary || sameFields(primary.fields, e.fields) || e.quantity <= 0) continue;
      // A partial `move` to the same owner splits those rows into a new syncGroup, like any
      // partial move; the new group's field update follows in a later diff.
      out.push({
        op: { type: 'move', syncGroup, to: owner, quantity: e.quantity },
        meta: { kind: 'split', syncGroup, to: owner, quantity: e.quantity, uuids: [e.uuid], fields: k.fields },
      });
    }

    const changed = changedFields(k.fields, primary.fields);
    if (Object.keys(changed).length) {
      out.push({
        op: { type: 'update', syncGroup, fields: changed },
        meta: { kind: 'update', syncGroup, fields: changed, itemUuid: primary.uuid },
      });
    }
  }

  for (const e of fresh) {
    if (e.quantity <= 0) continue;
    const ammo = !!e.fields.isAmmunition;
    const fields = ammo ? { ...e.fields, charges: e.quantity } : e.fields;
    out.push({
      op: { type: 'create', clientId: e.uuid, owner: e.owner, item: createItemFields(fields), quantity: ammo ? 1 : e.quantity },
      meta: { kind: 'create', uuid: e.uuid, owner: e.owner, quantity: e.quantity, fields: knownFieldsAfterCreate(fields) },
    });
  }

  return { ops: out, deferred };
}

/**
 * @param {{owner: string, coins: object}[]} purses current Foundry coins per linked owner
 * @param {Record<string, {gold, silver, copper}>} knownPurses
 */
export function diffPurses(purses, knownPurses = {}) {
  const out = [];
  for (const { owner, coins } of purses) {
    const folded = foldCoins(coins);
    const prev = knownPurses[owner];
    const unfolded = !sameValue(coins.pp || 0, 0) || !sameValue(coins.ep || 0, 0);
    if (prev && samePurse(prev, folded) && !unfolded) continue;
    if (!prev && folded.gold === 0 && folded.silver === 0 && folded.copper === 0) continue;
    const raw = { pp: coins.pp || 0, gp: coins.gp || 0, ep: coins.ep || 0, sp: coins.sp || 0, cp: coins.cp || 0 };
    if (prev && samePurse(prev, folded)) {
      // Same totals, only pp/ep to fold on the Foundry side: no server call needed.
      out.push({ op: null, meta: { kind: 'fold', owner, folded } });
      continue;
    }
    out.push({ op: { type: 'purse', owner, coins: raw }, meta: { kind: 'purse', owner, folded } });
  }
  return out;
}
