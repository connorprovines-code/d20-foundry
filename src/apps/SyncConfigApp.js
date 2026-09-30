// Settings window: connection status, actor mapping, party and Unprocessed Loot actors,
// the first-link choice per actor, and Disconnect.

import { MODULE_ID, OWNER_INCOMING, OWNER_PARTY, SYNC_OPTION, t } from '../constants.js';
import { KEYS, store } from '../settings.js';
import { runtime } from '../runtime.js';
import { SyncEngine } from '../sync/engine.js';
import { openConnectApp } from './ConnectApp.js';

let SyncConfigAppClass = null;

const sortedActors = () => Array.from(game.actors ?? []).sort((a, b) => a.name.localeCompare(b.name));

function actorOptions(selectedUuid, { preferTypes } = {}) {
  let actors = sortedActors();
  if (preferTypes) {
    const preferred = actors.filter((a) => preferTypes.includes(a.type));
    const rest = actors.filter((a) => !preferTypes.includes(a.type));
    actors = [...preferred, ...rest];
  }
  return actors.map((a) => ({
    uuid: a.uuid,
    label: `${a.name} (${game.i18n.localize(CONFIG.Actor?.typeLabels?.[a.type] ?? a.type)})`,
    selected: a.uuid === selectedUuid,
  }));
}

export function getSyncConfigAppClass() {
  if (SyncConfigAppClass) return SyncConfigAppClass;
  const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

  class SyncConfigApp extends HandlebarsApplicationMixin(ApplicationV2) {
    static DEFAULT_OPTIONS = {
      id: 'd20lt-sync-config',
      classes: ['d20lt', 'd20lt-sync-config'],
      tag: 'form',
      window: { title: 'D20LT.Config.Title', icon: 'fas fa-dice-d20', resizable: true },
      position: { width: 620, height: 'auto' },
      form: {
        handler: SyncConfigApp.#onSubmit,
        submitOnChange: false,
        closeOnSubmit: false,
      },
      actions: {
        connect: SyncConfigApp.#onConnect,
        disconnect: SyncConfigApp.#onDisconnect,
        createLoot: SyncConfigApp.#onCreateLoot,
        refresh: SyncConfigApp.#onRefresh,
      },
    };

    static PARTS = {
      main: { template: `modules/${MODULE_ID}/templates/sync-config.hbs`, scrollable: [''] },
    };

    #unsubscribe = null;
    /** The form holds choices not saved yet; the engine's updates must not re-render over them. */
    #dirty = false;

    async _prepareContext() {
      const engine = runtime.engine;
      const connection = store.get(KEYS.connection);
      const connected = store.worldConnected();
      const syncHere = !!engine?.canSync();
      const pairedBy = connection?.pairedBy ? game.users?.get?.(connection.pairedBy)?.name ?? '' : '';
      const links = store.get(KEYS.links) ?? {};
      const first = store.get(KEYS.firstLink) ?? {};
      const actors = sortedActors();
      const isNew = (target, uuid) => !uuid || !(first[target]?.done && first[target].actorUuid === uuid);

      const players = (engine?.players ?? []).map((p) => {
        const linked = links[p.id] ?? '';
        const suggestion = linked ? null : SyncEngine.suggestActor(p.name, actors.filter((a) => a.type === 'character'))
          ?? SyncEngine.suggestActor(p.name, actors);
        const selected = linked || suggestion?.uuid || '';
        return {
          id: p.id,
          name: p.name,
          selected,
          suggested: !linked && !!suggestion,
          options: actorOptions(selected, { preferTypes: ['character'] }),
          showMode: isNew(p.id, selected) && !!selected,
          mode: first[p.id]?.mode ?? 'merge',
        };
      });

      const partyLinked = links[OWNER_PARTY] ?? '';
      const partySuggestion = partyLinked ? null : runtime.adapter?.findPartyActor?.();
      const partySelected = partyLinked || partySuggestion?.uuid || '';
      const lootSelected = links[OWNER_INCOMING] ?? '';

      const status = engine?.status ?? 'disconnected';
      return {
        connected,
        syncHere,
        otherClientText: pairedBy ? t('Config.OtherClientNamed', { name: pairedBy }) : t('Config.OtherClient'),
        campaignName: connection?.campaignName ?? '',
        status,
        statusText: t(`Status.${status}`),
        lastError: engine?.lastError ?? '',
        lastSync: engine?.lastSyncAt ? new Date(engine.lastSyncAt).toLocaleTimeString() : '',
        systemSupported: !!runtime.adapter,
        players,
        party: {
          selected: partySelected,
          suggested: !partyLinked && !!partySuggestion,
          options: actorOptions(partySelected, { preferTypes: ['party', 'group'] }),
          showMode: isNew(OWNER_PARTY, partySelected) && !!partySelected,
          mode: first[OWNER_PARTY]?.mode ?? 'merge',
        },
        loot: {
          selected: lootSelected,
          options: actorOptions(lootSelected, { preferTypes: ['loot', 'group', 'npc'] }),
          showMode: isNew(OWNER_INCOMING, lootSelected) && !!lootSelected,
          mode: first[OWNER_INCOMING]?.mode ?? 'merge',
        },
      };
    }

    _onRender(context, options) {
      super._onRender?.(context, options);
      // Every render rebuilds the form from the saved settings.
      this.#dirty = false;
      if (!this.#unsubscribe && runtime.engine) {
        this.#unsubscribe = runtime.engine.onChange(() => {
          if (this.rendered && !this.#dirty && !this.element?.contains(document.activeElement)) this.render();
        });
      }
    }

    _onChangeForm(formConfig, event) {
      super._onChangeForm(formConfig, event);
      this.#dirty = true;
    }

    /**
     * Asks before saving when a new link would replace items on either side (D20 wins or
     * Foundry wins). Keep both needs no confirmation.
     */
    async #confirmFirstLinks(links, modes) {
      const first = store.get(KEYS.firstLink) ?? {};
      const names = { d20: [], foundry: [] };
      for (const [target, uuid] of Object.entries(links)) {
        if (!uuid || (first[target]?.done && first[target].actorUuid === uuid)) continue;
        const mode = modes[target] ?? 'merge';
        if (!names[mode]) continue;
        names[mode].push(foundry.utils.escapeHTML(fromUuidSync(uuid)?.name ?? uuid));
      }
      if (!names.d20.length && !names.foundry.length) return true;
      const content = [
        names.d20.length ? `<p>${t('Config.ConfirmD20', { names: names.d20.join(', ') })}</p>` : '',
        names.foundry.length ? `<p>${t('Config.ConfirmFoundry', { names: names.foundry.join(', ') })}</p>` : '',
        `<p>${t('Config.ConfirmContinue')}</p>`,
      ].join('');
      return foundry.applications.api.DialogV2.confirm({ window: { title: t('Config.ConfirmTitle') }, content });
    }

    async close(options) {
      this.#unsubscribe?.();
      this.#unsubscribe = null;
      return super.close(options);
    }

    static async #onSubmit(_event, _form, formData) {
      const engine = runtime.engine;
      if (!engine) return;
      const data = foundry.utils.expandObject(formData.object);
      const links = {};
      for (const [target, uuid] of Object.entries(data.link ?? {})) links[target] = uuid || null;
      const modes = { ...(data.mode ?? {}) };
      const twice = SyncEngine.duplicateActor(links);
      if (twice) {
        ui.notifications.error(t('Notify.DuplicateActor', { name: fromUuidSync(twice)?.name ?? twice }));
        return;
      }
      if (!(await this.#confirmFirstLinks(links, modes))) return;
      try {
        await engine.saveLinks(links, modes);
        ui.notifications.info(t('Notify.LinksSaved'));
      } catch (err) {
        ui.notifications.error(t('Notify.Error', { message: err?.message ?? String(err) }));
      }
      this.render();
    }

    static #onConnect() {
      openConnectApp({ onDone: () => this.render() });
    }

    static async #onDisconnect() {
      const confirmed = await foundry.applications.api.DialogV2.confirm({
        window: { title: t('Config.Disconnect') },
        content: `<p>${t('Config.DisconnectConfirm')}</p>`,
      });
      if (!confirmed) return;
      await runtime.engine?.disconnect();
      ui.notifications.info(t('Notify.Disconnected'));
      this.render();
    }

    static async #onCreateLoot() {
      const adapter = runtime.adapter;
      if (!adapter) return;
      const actor = await adapter.createLootActor(t('Config.LootActorName'), { [SYNC_OPTION]: true });
      if (!actor) return;
      const select = this.element.querySelector(`select[name="link.${OWNER_INCOMING}"]`);
      if (select) {
        const option = document.createElement('option');
        option.value = actor.uuid;
        option.textContent = actor.name;
        option.selected = true;
        select.append(option);
        this.#dirty = true;
      }
      ui.notifications.info(t('Notify.LootCreated', { name: actor.name }));
    }

    static async #onRefresh() {
      try {
        await runtime.engine?.loadState();
      } catch (err) {
        ui.notifications.error(t('Notify.Error', { message: err?.message ?? String(err) }));
      }
      this.render();
    }
  }

  SyncConfigAppClass = SyncConfigApp;
  return SyncConfigApp;
}

export function openSyncConfigApp() {
  const Cls = getSyncConfigAppClass();
  const existing = foundry.applications.instances?.get?.('d20lt-sync-config');
  if (existing) return existing.render({ force: true });
  return new Cls().render({ force: true });
}
