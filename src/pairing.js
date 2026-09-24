// Device-code pairing: POST pair/start, show the code, poll pair/poll every `interval`
// seconds until it is approved, expires, or the GM cancels.

import { MODULE_VERSION, VERIFY_URL } from './constants.js';

export function worldInfo() {
  const g = globalThis.game;
  return {
    worldId: g?.world?.id ?? '',
    worldTitle: g?.world?.title ?? '',
    systemId: g?.system?.id ?? '',
    systemVersion: g?.system?.version ?? '',
    foundryVersion: g?.version ?? g?.release?.version ?? '',
    moduleVersion: MODULE_VERSION,
  };
}

/**
 * @param {import('./api.js').D20Api} api
 * @param {object} opts
 * @param {(state: object) => void} opts.onUpdate  called with { status, userCode, verifyUrl, expiresAt, error }
 * @param {typeof setTimeout} [opts.setTimeout]
 * @param {() => number} [opts.now]
 * @returns {{ promise: Promise<object|null>, cancel: () => void }}
 *   resolves with { token, connection } once approved, or null when expired/cancelled.
 */
export function startPairing(api, { onUpdate, setTimeout: st = setTimeout, now = () => Date.now() } = {}) {
  let cancelled = false;
  let timer = null;
  const update = (s) => onUpdate?.(s);

  const cancel = () => {
    cancelled = true;
    if (timer) clearTimeout(timer);
  };

  const promise = (async () => {
    update({ status: 'starting' });
    const start = await api.pairStart(worldInfo());
    const intervalMs = Math.max(1, Number(start.interval) || 3) * 1000;
    const expiresAt = now() + (Number(start.expiresIn) || 600) * 1000;
    const base = { userCode: start.userCode, verifyUrl: start.verifyUrl || VERIFY_URL, expiresAt };
    update({ ...base, status: 'pending' });

    while (!cancelled) {
      await new Promise((resolve) => { timer = st(resolve, intervalMs); });
      if (cancelled) return null;
      let res;
      try {
        res = await api.pairPoll(start.deviceCode);
      } catch (err) {
        // A dropped connection while waiting is not fatal: keep polling until expiry.
        if (err?.isTransient && now() < expiresAt) continue;
        throw err;
      }
      if (res?.status === 'approved') {
        update({ ...base, status: 'approved', connection: res.connection });
        return { token: res.token, connection: res.connection };
      }
      if (res?.status === 'expired' || now() >= expiresAt) {
        update({ ...base, status: 'expired' });
        return null;
      }
    }
    return null;
  })();

  return { promise, cancel };
}
