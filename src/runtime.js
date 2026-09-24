// Module-wide singletons, set up on `ready`.

import { KEYS, store } from './settings.js';

export const runtime = {
  adapter: null,
  api: null,
  engine: null,
};

/** Stores a newly approved connection and (re)starts the sync. */
export async function completePairing({ token, connection }) {
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
  await store.set(KEYS.token, token);
  await store.set(KEYS.connection, {
    id: connection?.id ?? null,
    campaignId: connection?.campaignId ?? null,
    campaignName: connection?.campaignName ?? '',
    gameSystem: connection?.gameSystem ?? '',
  });
  const { engine } = runtime;
  if (engine) {
    engine.stop();
    await engine.start();
  }
}
