// A small fake of the Foundry globals the module touches: game, Hooks, CONFIG,
// foundry.utils, fromUuid/fromUuidSync, Actor, and Item/Actor documents with
// update/create/delete that fire the same hooks Foundry does (on this one "client").

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export const deepClone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

export function expandObject(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj ?? {})) {
    const value = isObj(v) ? expandObject(v) : v;
    const parts = k.split('.');
    let cur = out;
    for (let i = 0; i < parts.length - 1; i++) {
      cur[parts[i]] = isObj(cur[parts[i]]) ? cur[parts[i]] : {};
      cur = cur[parts[i]];
    }
    const last = parts[parts.length - 1];
    if (isObj(value) && isObj(cur[last])) mergeInto(cur[last], value);
    else cur[last] = value;
  }
  return out;
}

/** Deep merge with Foundry's "-=key" deletion; arrays and scalars replace. */
export function mergeInto(target, source) {
  for (const [k, v] of Object.entries(source)) {
    if (k.startsWith('-=')) {
      delete target[k.slice(2)];
      continue;
    }
    if (isObj(v)) {
      if (!isObj(target[k])) target[k] = {};
      mergeInto(target[k], v);
    } else {
      target[k] = deepClone(v);
    }
  }
  return target;
}

export function getProperty(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

export function setProperty(obj, path, value) {
  const parts = path.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!isObj(cur[parts[i]])) cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

let idCounter = 0;
export const randomID = () => `id${String(++idCounter).padStart(14, '0')}`;

export class FakeCollection extends Map {
  get contents() { return [...this.values()]; }
  find(fn) { return this.contents.find(fn); }
  filter(fn) { return this.contents.filter(fn); }
  map(fn) { return this.contents.map(fn); }
  some(fn) { return this.contents.some(fn); }
  [Symbol.iterator]() { return this.values(); }
}

export class FakeHooks {
  constructor() { this.handlers = new Map(); this.nextId = 1; this.calls = []; }
  on(name, fn) {
    const id = this.nextId++;
    if (!this.handlers.has(name)) this.handlers.set(name, new Map());
    this.handlers.get(name).set(id, fn);
    return id;
  }
  once(name, fn) { return this.on(name, fn); }
  off(name, id) { this.handlers.get(name)?.delete(id); }
  callAll(name, ...args) {
    this.calls.push([name, ...args]);
    for (const fn of this.handlers.get(name)?.values() ?? []) fn(...args);
    return true;
  }
  call(name, ...args) { return this.callAll(name, ...args); }
}

class FakeDocument {
  constructor(data) {
    this._source = deepClone(data);
    this._source._id ??= randomID();
    this._source.flags ??= {};
    this._source.system ??= {};
    this._source._stats ??= {};
    this.#sync();
  }

  #sync() {
    const s = deepClone(this._source);
    this.id = s._id;
    this._id = s._id;
    this.name = s.name;
    this.type = s.type;
    this.img = s.img;
    this.system = s.system;
    this.flags = s.flags;
    this._stats = s._stats;
    this.prepare?.();
  }

  _applyUpdate(changes) {
    mergeInto(this._source, changes);
    this.#sync();
  }

  getFlag(scope, key) { return this.flags?.[scope]?.[key]; }

  toObject() { return deepClone(this._source); }
}

export class FakeItem extends FakeDocument {
  constructor(data, { parent = null, parentItem = null } = {}) {
    super(data);
    this.parent = parent;
    this.parentItem = parentItem;
    this.prepare();
  }

  get actor() { return this.parent; }

  get uuid() {
    if (this.parentItem) return `${this.parentItem.uuid}.Item.${this.id}`;
    return this.parent ? `${this.parent.uuid}.Item.${this.id}` : `Item.${this.id}`;
  }

  /** pf1 containers: contents from system.items, rebuilt on every change. */
  prepare() {
    if (this.type !== 'container' || globalThis.game?.system?.id !== 'pf1') return;
    const prev = this.items ?? new FakeCollection();
    const next = new FakeCollection();
    for (const [id, data] of Object.entries(this._source.system.items ?? {})) {
      let item = prev.get(id);
      if (item) item._replaceSource({ ...data, _id: id });
      else item = new FakeItem({ ...data, _id: id }, { parent: this.parent, parentItem: this });
      item.parent = this.parent;
      next.set(id, item);
    }
    this.items = next;
  }

  _replaceSource(data) {
    this._source = deepClone(data);
    this._applyUpdate({});
  }

  async update(data, options = {}) {
    const changes = expandObject(data);
    if (this.parentItem) {
      // pf1: a contained item updates through its container, forwarding the context.
      await this.parentItem.update({ system: { items: { [this.id]: changes } } }, options);
      return this;
    }
    this._applyUpdate(changes);
    globalThis.Hooks.callAll('updateItem', this, changes, options, globalThis.game.user.id);
    return this;
  }

  async delete(options = {}) {
    if (this.parent) await this.parent.deleteEmbeddedDocuments('Item', [this.id], options);
    return this;
  }

  // pf1 container API (item-container.mjs). Like pf1, these do not forward options.
  async createContainerContent(itemsData) {
    const items = {};
    for (const d of [].concat(itemsData)) {
      const id = d._id ?? randomID();
      items[id] = { ...deepClone(d), _id: id };
    }
    await this.update({ system: { items } }, { pf1: { createContained: Object.keys(items) } });
    return Object.keys(items).map((id) => this.items.get(id));
  }

  async deleteContainerContent(ids) {
    const items = {};
    for (const id of [].concat(ids)) items[`-=${id}`] = null;
    await this.update({ system: { items } }, { pf1: { removeContained: [].concat(ids) } });
  }
}

export class FakeActor extends FakeDocument {
  constructor(data) {
    const { items = [], ...rest } = data;
    super(rest);
    this.items = new FakeCollection();
    for (const i of items) {
      const item = new FakeItem(i, { parent: this });
      this.items.set(item.id, item);
    }
  }

  get uuid() { return `Actor.${this.id}`; }

  async update(data, options = {}) {
    const changes = expandObject(data);
    this._applyUpdate(changes);
    globalThis.Hooks.callAll('updateActor', this, changes, options, globalThis.game.user.id);
    return this;
  }

  async setFlag(scope, key, value) { return this.update({ [`flags.${scope}.${key}`]: value }); }
  async unsetFlag(scope, key) { return this.update({ [`flags.${scope}.-=${key}`]: null }); }

  async createEmbeddedDocuments(type, data, options = {}) {
    const created = [];
    for (const d of data) {
      const item = new FakeItem(d, { parent: this });
      this.items.set(item.id, item);
      created.push(item);
      globalThis.Hooks.callAll('createItem', item, options, globalThis.game.user.id);
    }
    return created;
  }

  async deleteEmbeddedDocuments(type, ids, options = {}) {
    const deleted = [];
    for (const id of ids) {
      const item = this.items.get(id);
      if (!item) continue;
      this.items.delete(id);
      deleted.push(item);
      globalThis.Hooks.callAll('deleteItem', item, options, globalThis.game.user.id);
    }
    return deleted;
  }
}

/** pf2e-style actor: coins are treasure items; inventory helpers take no options. */
export class FakePf2eActor extends FakeActor {
  constructor(data) {
    super(data);
    const actor = this;
    const rates = { pp: 1000, gp: 100, sp: 10, cp: 1 };
    const coinItem = (d) => actor.items.find((i) => i.type === 'treasure' && i.system.category === 'coin' && i.system.price?.value?.[d]);
    this.inventory = {
      get currency() {
        const out = { pp: 0, gp: 0, sp: 0, cp: 0 };
        for (const i of actor.items.contents) {
          if (i.type !== 'treasure' || i.system.category !== 'coin') continue;
          for (const d of Object.keys(rates)) if (i.system.price?.value?.[d]) out[d] += i.system.quantity;
        }
        return out;
      },
      async addCurrency(coins) {
        for (const [d, q] of Object.entries(coins)) {
          if (!q) continue;
          const item = coinItem(d);
          if (item) await item.update({ 'system.quantity': item.system.quantity + q });
          else {
            await actor.createEmbeddedDocuments('Item', [{
              name: `${d} coins`, type: 'treasure', system: { category: 'coin', quantity: q, price: { value: { [d]: 1 } } },
            }]);
          }
        }
      },
      async removeCurrency(coins) {
        for (const [d, q] of Object.entries(coins)) {
          if (!q) continue;
          const item = coinItem(d);
          if (!item || item.system.quantity < q) return false;
          await item.update({ 'system.quantity': item.system.quantity - q });
        }
        return true;
      },
    };
  }
}

export class FakeSettings {
  constructor() { this.defs = new Map(); this.values = new Map(); this.menus = new Map(); }
  register(ns, key, def) { this.defs.set(`${ns}.${key}`, def); }
  registerMenu(ns, key, def) { this.menus.set(`${ns}.${key}`, def); }
  get(ns, key) {
    const k = `${ns}.${key}`;
    if (this.values.has(k)) return deepClone(this.values.get(k));
    const def = this.defs.get(k);
    if (!def) throw new Error(`Setting ${k} not registered`);
    return deepClone(def.default);
  }
  async set(ns, key, value) { this.values.set(`${ns}.${key}`, deepClone(value)); return value; }
}

/** Installs fresh globals. Returns handles for the test. */
export function installFoundry({ systemId = 'dnd5e', compendium = {} } = {}) {
  const Hooks = new FakeHooks();
  const actors = new FakeCollection();
  const user = { id: 'gm1', isGM: true, name: 'GM' };
  const game = {
    system: { id: systemId, version: '1.0.0' },
    version: '14.360',
    world: { id: 'test-world', title: 'Test World' },
    user,
    users: { activeGM: user },
    actors,
    settings: new FakeSettings(),
    modules: new Map([['d20-loot-tracker', { id: 'd20-loot-tracker' }]]),
    i18n: { localize: (k) => k, format: (k) => k, lang: 'en' },
  };
  const resolve = (uuid) => {
    if (!uuid) return null;
    const parts = uuid.split('.');
    if (parts[0] !== 'Actor') return compendium[uuid] ?? null;
    let doc = actors.get(parts[1]);
    for (let i = 2; doc && i < parts.length; i += 2) doc = doc.items?.get(parts[i + 1]);
    return doc ?? null;
  };
  const ActorClass = systemId === 'pf2e' ? FakePf2eActor : FakeActor;
  Object.assign(globalThis, {
    Hooks,
    game,
    CONFIG: {
      DND5E: {
        currencies: { pp: { conversion: 0.1 }, gp: { conversion: 1 }, ep: { conversion: 2 }, sp: { conversion: 10 }, cp: { conversion: 100 } },
        weightUnits: { lb: { conversion: 1 }, kg: { conversion: 2.5 } },
      },
      Actor: { typeLabels: {} },
    },
    foundry: { utils: { expandObject, getProperty, setProperty, mergeObject: (a, b) => mergeInto(a, b), deepClone, randomID } },
    fromUuidSync: resolve,
    fromUuid: async (uuid) => resolve(uuid),
    ui: { notifications: { info() {}, warn() {}, error() {} } },
    Actor: {
      create: async (data) => {
        const a = new ActorClass(data);
        actors.set(a.id, a);
        return a;
      },
    },
  });
  return {
    Hooks,
    game,
    actors,
    addActor(data) {
      const a = new ActorClass(data);
      actors.set(a.id, a);
      return a;
    },
  };
}
