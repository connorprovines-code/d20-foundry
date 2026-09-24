// Helpers shared by the system adapters.

import { MODULE_ID } from '../constants.js';
import { roundCoin } from '../sync/coins.js';

/** D20 item_icon values (the app's Add Item form). */
export const ICONS = Object.freeze({
  weapon: 'weapon',
  armor: 'armor',
  consumable: 'consumable',
  treasure: 'treasure',
  tools: 'tools',
  wondrous: 'wondrous',
  runestone: 'runestone',
  coins: 'coins',
});

/**
 * The item fields the module compares to decide an outbound `update`. Every adapter
 * returns a subset of these from itemToFields (undefined = the system has no such field,
 * so it is never compared or sent). `equipped` is the op's boolean, not a slot id.
 */
export const COMPARED_FIELDS = Object.freeze([
  'name', 'value', 'weight', 'bulk', 'charges', 'itemIcon', 'consumable', 'isTreasure',
  'rarity', 'isUnidentified', 'unidentifiedName', 'isAttuned', 'isAmmunition', 'equipped',
]);

export const num = (v, fallback = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

export const round = (v) => roundCoin(v);

/** Equal for sync purposes: numbers to 4 places, null == undefined == ''. */
export function sameValue(a, b) {
  const blank = (v) => v === null || v === undefined || v === '';
  if (blank(a) && blank(b)) return true;
  if (typeof a === 'number' || typeof b === 'number') {
    if (blank(a) || blank(b)) return false;
    return round(a) === round(b);
  }
  return a === b;
}

/** The fields in `next` that differ from `prev` (both itemToFields shapes). */
export function changedFields(prev = {}, next = {}) {
  const out = {};
  for (const key of COMPARED_FIELDS) {
    if (next[key] === undefined) continue;
    if (!sameValue(prev[key], next[key])) out[key] = next[key];
  }
  return out;
}

/** Keep only defined values, so an adapter's fields never carry `undefined`. */
export function compact(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out;
}

export const moduleFlags = (doc) => doc?.flags?.[MODULE_ID] ?? {};
export const syncGroupOf = (item) => moduleFlags(item).syncGroup ?? null;

/** Item name as stored, not the unidentified name systems swap in during data prep. */
export const realName = (item) => item?._source?.name ?? item?.name ?? '';

export const compendiumSourceOf = (item) =>
  item?._stats?.compendiumSource ?? item?._source?._stats?.compendiumSource ?? null;

/**
 * A creation payload taken from the compendium entry D20 remembers, if it still resolves.
 * Returns null when there is no source or the pack is not installed.
 */
export async function compendiumData(uuid) {
  if (!uuid || typeof uuid !== 'string' || !uuid.startsWith('Compendium.')) return null;
  try {
    const doc = await globalThis.fromUuid?.(uuid);
    if (!doc) return null;
    const data = doc.toObject();
    delete data._id;
    data._stats = { ...(data._stats || {}), compendiumSource: uuid };
    return data;
  } catch {
    return null;
  }
}

/** Notes are plain text in D20; a new Foundry item gets them as its description. */
export function notesToHtml(notes) {
  if (!notes) return '';
  const esc = String(notes).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return esc.split(/\n{2,}/).map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('');
}

/** D20 rarity strings are lowercase words ("very rare"). */
export const normalizeRarity = (r) => (r ? String(r).trim().toLowerCase() : null);

/** Items the actor holds directly (Foundry Collection or array). */
export const actorItems = (actor) => {
  const items = actor?.items;
  if (!items) return [];
  return Array.isArray(items) ? items : Array.from(items.contents ?? items.values?.() ?? items);
};
