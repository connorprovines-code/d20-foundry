export const MODULE_ID = 'd20-loot-tracker';
export const DEFAULT_BASE_URL = 'https://app.d20-loot-tracker.com/api/foundry';
export const VERIFY_URL = 'https://app.d20-loot-tracker.com/foundry';

/** Option set on every Foundry write the module makes; its own hooks ignore these writes. */
export const SYNC_OPTION = 'd20Sync';

export const DEBOUNCE_MS = 500;
export const POLL_MS = 3000;
export const MAX_POLL_BACKOFF_MS = 60000;
export const MAX_OPS_PER_APPLY = 100;
/** A copy that appeared on another actor this recently may still be half of a move (create, then delete). */
export const MOVE_SETTLE_MS = 1500;

/** Owners in the contract besides a players.id. */
export const OWNER_INCOMING = 'incoming';
export const OWNER_PARTY = 'party';

// eslint-disable-next-line no-undef
export const MODULE_VERSION = typeof __MODULE_VERSION__ === 'string' ? __MODULE_VERSION__ : '0.0.0';

export const t = (key, data) => {
  const i18n = globalThis.game?.i18n;
  if (!i18n) return key;
  return data ? i18n.format(`D20LT.${key}`, data) : i18n.localize(`D20LT.${key}`);
};
