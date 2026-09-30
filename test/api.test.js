import { describe, expect, it, vi } from 'vitest';
import { ApiError, D20Api, NetworkError } from '../src/api.js';
import { DEFAULT_BASE_URL } from '../src/constants.js';

const response = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => (body === undefined ? '' : JSON.stringify(body)),
});

function makeApi(fetchImpl, extra = {}) {
  return new D20Api({ fetch: fetchImpl, getToken: () => 'tok123', retryDelayMs: 1, ...extra });
}

describe('D20Api', () => {
  it('sends the bearer token and JSON body to the default base URL', async () => {
    const fetch = vi.fn(async () => response(200, { results: [], cursor: '5' }));
    const api = makeApi(fetch);
    await api.apply([{ type: 'delete', syncGroup: 'g1' }]);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe(`${DEFAULT_BASE_URL}/apply`);
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer tok123');
    expect(init.credentials).toBe('omit');
    expect(JSON.parse(init.body)).toEqual({ ops: [{ type: 'delete', syncGroup: 'g1' }] });
  });

  it('covers every route the module calls', async () => {
    const fetch = vi.fn(async () => response(200, {}));
    const api = makeApi(fetch, { getBaseUrl: () => 'https://example.test/api/foundry/' });
    await api.pairStart({ worldId: 'w' });
    await api.pairPoll('dev');
    await api.state();
    await api.changes('42');
    await api.apply([]);
    await api.putActors([{ target: 'party', actorUuid: 'Actor.x' }]);
    await api.disconnect();
    const calls = fetch.mock.calls.map(([url, init]) => `${init.method} ${url.replace('https://example.test/api/foundry/', '')}`);
    expect(calls).toEqual([
      'POST pair/start', 'POST pair/poll',
      'GET state', 'GET changes?after=42', 'POST apply', 'PUT actors', 'POST disconnect',
    ]);
    // Pairing is unauthenticated; everything after it carries the connection token.
    expect(fetch.mock.calls[0][1].headers.Authorization).toBeUndefined();
    expect(fetch.mock.calls[1][1].headers.Authorization).toBeUndefined();
    expect(fetch.mock.calls[2][1].headers.Authorization).toBe('Bearer tok123');
  });

  it('on 401 marks itself disconnected and calls onUnauthorized once', async () => {
    const fetch = vi.fn(async () => response(401, { error: 'revoked', message: 'Connection revoked.' }));
    const onUnauthorized = vi.fn();
    const api = makeApi(fetch, { onUnauthorized });
    await expect(api.state()).rejects.toMatchObject({ status: 401, code: 'revoked', isAuth: true });
    await expect(api.changes('1')).rejects.toBeInstanceOf(ApiError);
    expect(api.disconnected).toBe(true);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(2); // 401s are never retried
  });

  it('does not call onUnauthorized for a 401 on the unauthenticated pairing routes', async () => {
    const fetch = vi.fn(async () => response(401, { error: 'invalid_token' }));
    const onUnauthorized = vi.fn();
    const api = makeApi(fetch, { onUnauthorized });
    await expect(api.pairPoll('x')).rejects.toBeInstanceOf(ApiError);
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it('retries network errors with backoff, then succeeds', async () => {
    let n = 0;
    const fetch = vi.fn(async () => {
      if (++n < 3) throw new TypeError('Failed to fetch');
      return response(200, { cursor: '1' });
    });
    const api = makeApi(fetch);
    await expect(api.changes('0')).resolves.toEqual({ cursor: '1' });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('gives up after the retry budget with a transient NetworkError', async () => {
    const fetch = vi.fn(async () => { throw new TypeError('offline'); });
    const api = makeApi(fetch, { retries: 2 });
    const err = await api.state().catch((e) => e);
    expect(err).toBeInstanceOf(NetworkError);
    expect(err.isTransient).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('does not retry HTTP errors, and reports 5xx as transient and 409/403 as refusals', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(response(503, { error: 'unavailable' }))
      .mockResolvedValueOnce(response(409, { error: 'moved', message: 'The rows changed.' }))
      .mockResolvedValueOnce(response(403, { error: 'forbidden', message: 'Only the DM can do that.' }));
    const api = makeApi(fetch);
    const e1 = await api.apply([]).catch((e) => e);
    const e2 = await api.apply([]).catch((e) => e);
    const e3 = await api.apply([]).catch((e) => e);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(e1.isTransient).toBe(true);
    expect(e2.isConflict).toBe(true);
    expect(e2.isTransient).toBe(false);
    expect(e3.isForbidden).toBe(true);
    expect(e3.message).toBe('Only the DM can do that.');
  });

  it('refuses to call a token route with no token', async () => {
    const fetch = vi.fn();
    const api = new D20Api({ fetch, getToken: () => '' });
    await expect(api.state()).rejects.toMatchObject({ status: 401 });
    expect(fetch).not.toHaveBeenCalled();
  });
});
