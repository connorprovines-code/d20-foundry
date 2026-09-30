// D20 Loot Tracker for Foundry VTT: entry point.

import { D20Api } from './api.js';
import { getConnectAppClass, openConnectApp } from './apps/ConnectApp.js';
import { getSyncConfigAppClass, openSyncConfigApp } from './apps/SyncConfigApp.js';
import { MODULE_ID, t } from './constants.js';
import { runtime, updateSyncClient } from './runtime.js';
import { registerSettings, store } from './settings.js';
import { SyncEngine } from './sync/engine.js';
import { getAdapter } from './systems/index.js';

Hooks.once('init', () => {
  registerSettings({ menuType: getSyncConfigAppClass(), onConnectionChange: updateSyncClient });
  getConnectAppClass();
});

Hooks.once('ready', async () => {
  runtime.adapter = getAdapter(game.system.id);
  runtime.api = new D20Api({
    getBaseUrl: () => store.baseUrl(),
    getToken: () => store.token(),
    onUnauthorized: () => runtime.engine?.onUnauthorized(),
  });

  const mod = game.modules.get(MODULE_ID);
  if (mod) mod.api = { runtime, openConnectApp, openSyncConfigApp };

  if (!runtime.adapter) {
    if (game.user.isGM) ui.notifications.warn(t('Notify.UnsupportedSystem'));
    return;
  }

  runtime.engine = new SyncEngine({ adapter: runtime.adapter, api: runtime.api, store });
  await runtime.engine.start();
});

// Connections made before clientKey existed follow Foundry's active GM, which changes as
// GMs join and leave; activeGM is recomputed after this hook, so check on the next tick.
Hooks.on('userConnected', () => {
  setTimeout(updateSyncClient, 0);
});
