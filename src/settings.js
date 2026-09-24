// Settings. The connection token lives only in the GM's own browser (client scope, never
// shown in the settings list). World settings hold non-secret sync state that must
// survive a reload: the connection id and campaign name, the poll cursor, the outbound
// queue, what each synced group looked like when last in step, and the actor links.

import { DEFAULT_BASE_URL, MODULE_ID } from './constants.js';

export const KEYS = {
  token: 'token',
  baseUrl: 'baseUrl',
  connection: 'connection',
  cursor: 'cursor',
  queue: 'queue',
  known: 'known',
  links: 'links',
  firstLink: 'firstLink',
};

const DEFAULTS = {
  [KEYS.token]: '',
  [KEYS.baseUrl]: DEFAULT_BASE_URL,
  [KEYS.connection]: null,
  [KEYS.cursor]: '',
  [KEYS.queue]: [],
  [KEYS.known]: { groups: {}, purses: {} },
  [KEYS.links]: {},
  [KEYS.firstLink]: {},
};

export function registerSettings({ menuType } = {}) {
  const s = game.settings;

  s.register(MODULE_ID, KEYS.token, {
    scope: 'client', config: false, type: String, default: '',
  });

  // Hidden: only changed for a staging server, from the console:
  // game.settings.set('d20-loot-tracker', 'baseUrl', 'https://...')
  s.register(MODULE_ID, KEYS.baseUrl, {
    scope: 'world', config: false, type: String, default: DEFAULT_BASE_URL,
  });

  for (const key of [KEYS.connection, KEYS.known, KEYS.links, KEYS.firstLink]) {
    s.register(MODULE_ID, key, { scope: 'world', config: false, type: Object, default: DEFAULTS[key] });
  }
  s.register(MODULE_ID, KEYS.cursor, { scope: 'world', config: false, type: String, default: '' });
  s.register(MODULE_ID, KEYS.queue, { scope: 'world', config: false, type: Array, default: [] });

  if (menuType) {
    s.registerMenu(MODULE_ID, 'syncConfig', {
      name: 'D20LT.Menu.Name',
      label: 'D20LT.Menu.Label',
      hint: 'D20LT.Menu.Hint',
      icon: 'fas fa-dice-d20',
      type: menuType,
      restricted: true,
    });
  }
}

const clone = (v) => (v === null || v === undefined ? v : JSON.parse(JSON.stringify(v)));

/** Typed access to the module's settings; the sync engine only talks to this. */
export const store = {
  get(key) {
    try {
      const v = game.settings.get(MODULE_ID, key);
      return v === undefined || v === null ? clone(DEFAULTS[key]) : clone(v);
    } catch {
      return clone(DEFAULTS[key]);
    }
  },
  async set(key, value) {
    return game.settings.set(MODULE_ID, key, value);
  },
  token() { return this.get(KEYS.token) || ''; },
  baseUrl() { return this.get(KEYS.baseUrl) || DEFAULT_BASE_URL; },
  isConnected() { return !!this.token() && !!this.get(KEYS.connection); },

  /** Forget everything tied to the current connection (the token included). */
  async clearConnection() {
    await this.set(KEYS.token, '');
    await this.set(KEYS.connection, null);
    await this.set(KEYS.cursor, '');
    await this.set(KEYS.queue, []);
    await this.set(KEYS.known, { groups: {}, purses: {} });
    await this.set(KEYS.links, {});
    await this.set(KEYS.firstLink, {});
  },
};
