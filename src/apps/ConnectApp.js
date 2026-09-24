// Pairing window: shows the code large, a link to the approval page, and the status.

import { MODULE_ID, t } from '../constants.js';
import { startPairing } from '../pairing.js';
import { completePairing, runtime } from '../runtime.js';

let ConnectAppClass = null;

export function getConnectAppClass() {
  if (ConnectAppClass) return ConnectAppClass;
  const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

  class ConnectApp extends HandlebarsApplicationMixin(ApplicationV2) {
    static DEFAULT_OPTIONS = {
      id: 'd20lt-connect',
      classes: ['d20lt', 'd20lt-connect'],
      tag: 'div',
      window: { title: 'D20LT.Connect.Title', icon: 'fas fa-link' },
      position: { width: 440, height: 'auto' },
      actions: {
        cancel: ConnectApp.#onCancel,
        retry: ConnectApp.#onRetry,
        copy: ConnectApp.#onCopy,
      },
    };

    static PARTS = {
      main: { template: `modules/${MODULE_ID}/templates/connect.hbs` },
    };

    #pairing = null;
    #state = { status: 'starting' };
    #onDone = null;

    constructor(options = {}) {
      super(options);
      this.#onDone = options.onDone ?? null;
    }

    async _prepareContext() {
      const s = this.#state;
      const minutes = s.expiresAt ? Math.max(0, Math.ceil((s.expiresAt - Date.now()) / 60000)) : null;
      return {
        status: s.status,
        statusText: t(`Connect.Status.${s.status}`),
        userCode: s.userCode ?? '',
        verifyUrl: s.verifyUrl ?? '',
        minutes,
        error: s.error ?? '',
        campaignName: s.connection?.campaignName ?? '',
        showCode: s.status === 'pending',
        showRetry: s.status === 'expired' || s.status === 'error',
        showCancel: s.status === 'pending' || s.status === 'starting',
      };
    }

    async _onFirstRender(context, options) {
      await super._onFirstRender?.(context, options);
      this.#begin();
    }

    #begin() {
      this.#pairing?.cancel();
      this.#state = { status: 'starting' };
      const pairing = startPairing(runtime.api, {
        onUpdate: (s) => {
          this.#state = { ...this.#state, ...s };
          if (this.rendered) this.render();
        },
      });
      this.#pairing = pairing;
      pairing.promise.then(async (result) => {
        if (!result || this.#pairing !== pairing) return;
        await completePairing(result);
        ui.notifications.info(t('Notify.Connected', { campaign: result.connection?.campaignName ?? '' }));
        this.#onDone?.(result);
        setTimeout(() => this.close(), 1200);
      }).catch((err) => {
        if (this.#pairing !== pairing) return;
        this.#state = { ...this.#state, status: 'error', error: err?.message ?? String(err) };
        if (this.rendered) this.render();
      });
    }

    async close(options) {
      this.#pairing?.cancel();
      this.#pairing = null;
      return super.close(options);
    }

    static #onCancel() {
      this.close();
    }

    static #onRetry() {
      this.#begin();
      this.render();
    }

    static async #onCopy() {
      const code = this.#state.userCode;
      if (!code) return;
      try {
        await navigator.clipboard.writeText(code);
        ui.notifications.info(t('Connect.Copied'));
      } catch { /* clipboard unavailable: the code is on screen */ }
    }
  }

  ConnectAppClass = ConnectApp;
  return ConnectApp;
}

export function openConnectApp(options) {
  const Cls = getConnectAppClass();
  const existing = foundry.applications.instances?.get?.('d20lt-connect');
  if (existing) return existing.render({ force: true });
  return new Cls(options).render({ force: true });
}
