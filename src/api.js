// HTTP client for the D20 Loot Tracker Foundry API (tasks/foundry.md in the app repo).
// Bearer token auth; a 401 flips the client into a disconnected state; network errors
// (no response at all) are retried with backoff, HTTP errors are not.

import { DEFAULT_BASE_URL } from './constants.js';

export class ApiError extends Error {
  constructor(status, body = {}) {
    super(body.message || body.error || `HTTP ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.code = body.error || null;
    this.body = body;
  }

  get isAuth() { return this.status === 401; }
  get isConflict() { return this.status === 409; }
  get isForbidden() { return this.status === 403; }
  /** Server-side trouble worth retrying later (not a refusal). */
  get isTransient() { return this.status >= 500 || this.status === 429; }
}

export class NetworkError extends Error {
  constructor(cause) {
    super(`Network error: ${cause?.message || cause}`);
    this.name = 'NetworkError';
    this.cause = cause;
    this.isTransient = true;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class D20Api {
  /**
   * @param {object} opts
   * @param {() => string} [opts.getBaseUrl]
   * @param {() => string} [opts.getToken]
   * @param {(err: ApiError) => void} [opts.onUnauthorized] called once per 401
   * @param {typeof fetch} [opts.fetch]
   * @param {number} [opts.retries] extra attempts after a network error
   * @param {number} [opts.retryDelayMs] first backoff delay; doubles each attempt
   */
  constructor({ getBaseUrl, getToken, onUnauthorized, fetch: fetchImpl, retries = 3, retryDelayMs = 500 } = {}) {
    this.getBaseUrl = getBaseUrl || (() => DEFAULT_BASE_URL);
    this.getToken = getToken || (() => '');
    this.onUnauthorized = onUnauthorized || (() => {});
    this.fetch = fetchImpl || ((...args) => globalThis.fetch(...args));
    this.retries = retries;
    this.retryDelayMs = retryDelayMs;
    this.disconnected = false;
  }

  url(route, query) {
    const base = String(this.getBaseUrl() || DEFAULT_BASE_URL).replace(/\/+$/, '');
    const qs = query ? `?${new URLSearchParams(query).toString()}` : '';
    return `${base}/${route}${qs}`;
  }

  async request(method, route, { body, query, auth = true, bearer } = {}) {
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (bearer) {
      // A caller-supplied credential (web-app routes): never touches the connection state.
      headers.Authorization = `Bearer ${bearer}`;
      auth = false;
    } else if (auth) {
      const token = this.getToken();
      if (!token) {
        this.disconnected = true;
        throw new ApiError(401, { error: 'invalid_token', message: 'Not connected.' });
      }
      headers.Authorization = `Bearer ${token}`;
    }
    const init = { method, headers, credentials: 'omit', mode: 'cors' };
    if (body !== undefined) init.body = JSON.stringify(body);

    let res;
    for (let attempt = 0; ; attempt++) {
      try {
        res = await this.fetch(this.url(route, query), init);
        break;
      } catch (err) {
        if (attempt >= this.retries) throw new NetworkError(err);
        await sleep(this.retryDelayMs * 2 ** attempt);
      }
    }

    let data = {};
    const text = await res.text();
    if (text) {
      try { data = JSON.parse(text); } catch { data = { error: 'bad_json', message: text.slice(0, 200) }; }
    }
    if (!res.ok) {
      const err = new ApiError(res.status, data);
      if (err.isAuth && auth) {
        const wasConnected = !this.disconnected;
        this.disconnected = true;
        if (wasConnected) this.onUnauthorized(err);
      }
      throw err;
    }
    if (auth) this.disconnected = false;
    return data;
  }

  // Pairing (no token)
  pairStart(info) { return this.request('POST', 'pair/start', { body: info, auth: false }); }
  pairPoll(deviceCode) { return this.request('POST', 'pair/poll', { body: { deviceCode }, auth: false }); }

  // Web-app routes, authorized by a Supabase session rather than the connection token.
  // The module never calls these; they are here so the client covers the whole contract.
  pairLookup(code, supabaseToken) {
    return this.request('GET', 'pair/lookup', { query: { code }, bearer: supabaseToken });
  }
  pairApprove(userCode, campaignId, supabaseToken) {
    return this.request('POST', 'pair/approve', { body: { userCode, campaignId }, bearer: supabaseToken });
  }

  // Connected routes
  state() { return this.request('GET', 'state'); }
  changes(after) { return this.request('GET', 'changes', { query: { after: after ?? '' } }); }
  apply(ops) { return this.request('POST', 'apply', { body: { ops } }); }
  putActors(links) { return this.request('PUT', 'actors', { body: { links } }); }
  disconnect() { return this.request('POST', 'disconnect', { body: {} }); }
}
