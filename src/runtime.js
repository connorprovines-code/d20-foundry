// Module-wide singletons, set up on `ready`.

import { KEYS, store } from './settings.js';

export const runtime = {
  adapter: null,
  api: null,
  engine: null,
  /** True while this browser stores a new pairing, so its own setting change is not re-read. */
  pairing: false,
};

/** Starts or stops this browser's sync to match SyncEngine#canSync. */
export function updateSyncClient() {
  const { engine } = runtime;
  if (!engine || runtime.pairing) return;
  if (engine.canSync()) {
    if (!engine.running) engine.start();
  } else if (engine.running) {
    engine.stop();
  }
}

const newClientKey = () => globalThis.foundry?.utils?.randomID?.(16)
  ?? Math.random().toString(36).slice(2, 18);

/** Stores a newly approved connection and (re)starts the sync in this browser. */
export async function completePairing({ token, connection }) {
  runtime.pairing = true;
  try {
    const prev = store.get(KEYS.connection);
    if (!prev || prev.campaignId !== connection?.campaignId || prev.id !== connection?.id) {
      // A different campaign or connection: nothing from the old one carries over.
      await store.set(KEYS.cursor, '');
      await store.set(KEYS.queue, []);
      if (prev?.campaignId !== connection?.campaignId) {
        await store.set(KEYS.known, { groups: {}, purses: {} });
        await store.set(KEYS.links, {});
        await store.set(KEYS.firstLink, {});
      }
    }
    // The pairing browser becomes the one that syncs; any other browser that synced
    // before stops when it sees the new clientKey.
    const clientKey = newClientKey();
    await store.set(KEYS.token, token);
    await store.set(KEYS.clientKey, clientKey);
    await store.set(KEYS.connection, {
      id: connection?.id ?? null,
      campaignId: connection?.campaignId ?? null,
      campaignName: connection?.campaignName ?? '',
      gameSystem: connection?.gameSystem ?? '',
      clientKey,
      pairedBy: globalThis.game?.user?.id ?? null,
    });
  } finally {
    runtime.pairing = false;
  }
  const { engine } = runtime;
  if (engine) {
    engine.stop();
    await engine.start();
  }
}
