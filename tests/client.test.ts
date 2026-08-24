import { describe, expect, it, vi } from 'vitest';
import { DiscogsClient, DiscogsError } from '@/discogs/client';

/**
 * Rate-limit behaviour is the difference between a 549-release import that
 * completes and one that dies at record 60, so it is tested directly.
 * Sleeping is stubbed out so the suite stays fast.
 */

function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

function harness(responses: (() => Response)[] | ((url: string, attempt: number) => Response)) {
  const sleeps: number[] = [];
  let attempt = 0;
  const calls: string[] = [];

  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    const headers = init?.headers as Record<string, string> | undefined;
    lastHeaders = headers ?? {};
    // Built fresh each call: a Response body can only be read once.
    const response = Array.isArray(responses)
      ? responses[Math.min(attempt, responses.length - 1)]!()
      : responses(url, attempt);
    attempt += 1;
    return response;
  }) as unknown as typeof fetch;

  let lastHeaders: Record<string, string> = {};

  const client = new DiscogsClient({
    fetchImpl,
    sleepImpl: async (ms) => {
      sleeps.push(ms);
    },
  });

  return { client, sleeps, calls, fetchImpl, getHeaders: () => lastHeaders };
}

describe('pacing', () => {
  it('paces for 25 requests/minute without a token', () => {
    const { client } = harness([() => jsonResponse({})]);
    expect(client.rateLimit.limit).toBe(25);
    // 60000/25 = 2400ms, plus a safety margin.
    expect(client.rateLimit.intervalMs).toBeGreaterThanOrEqual(2400);
    expect(client.rateLimit.intervalMs).toBeLessThan(2700);
  });

  it('paces for 60 requests/minute with a token', () => {
    const { client } = harness([() => jsonResponse({})]);
    client.setToken('secret');
    expect(client.rateLimit.limit).toBe(60);
    expect(client.rateLimit.intervalMs).toBeGreaterThanOrEqual(1000);
    expect(client.rateLimit.intervalMs).toBeLessThan(1300);
  });

  it('adopts the limit Discogs actually reports', async () => {
    const { client } = harness([
      () => jsonResponse({ ok: true }, { headers: { 'x-discogs-ratelimit': '100', 'x-discogs-ratelimit-remaining': '99' } }),
    ]);
    await client.get('/releases/1');
    expect(client.rateLimit.limit).toBe(100);
    expect(client.rateLimit.remaining).toBe(99);
  });

  it('estimates import duration from the current pacing', () => {
    const { client } = harness([() => jsonResponse({})]);
    client.setToken('secret');
    // 549 releases at ~1.1s each lands around nine to ten minutes.
    const seconds = client.estimateSeconds(549);
    expect(seconds).toBeGreaterThan(540);
    expect(seconds).toBeLessThan(700);
  });

  it('sends the token as a Discogs authorization header', async () => {
    const { client, getHeaders } = harness([() => jsonResponse({})]);
    client.setToken('abc123');
    await client.get('/releases/1');
    expect(getHeaders()['Authorization']).toBe('Discogs token=abc123');
  });

  it('uses the authenticated identity endpoint to validate a supplied token', async () => {
    const { client, calls } = harness([() => jsonResponse({ username: 'crate-dj' })]);
    client.setToken('abc123');
    await expect(client.identity()).resolves.toMatchObject({ username: 'crate-dj' });
    expect(calls[0]).toBe('https://api.discogs.com/oauth/identity');
  });

  it('sends no authorization header when there is no token', async () => {
    const { client, getHeaders } = harness([() => jsonResponse({})]);
    await client.get('/releases/1');
    expect(getHeaders()['Authorization']).toBeUndefined();
  });
});

describe('error handling', () => {
  it('retries a 429 and then succeeds', async () => {
    const { client, sleeps } = harness((_url, attempt) =>
      attempt === 0
        ? jsonResponse({ message: 'slow down' }, { status: 429, headers: { 'retry-after': '2' } })
        : jsonResponse({ id: 1 }),
    );
    const result = await client.get<{ id: number }>('/releases/1');
    expect(result.id).toBe(1);
    // Honoured the Retry-After header.
    expect(sleeps).toContain(2000);
  });

  it('widens its own pacing after being rate limited', async () => {
    const { client } = harness((_url, attempt) =>
      attempt === 0 ? jsonResponse({}, { status: 429 }) : jsonResponse({ id: 1 }),
    );
    const before = client.rateLimit.intervalMs;
    await client.get('/releases/1');
    expect(client.rateLimit.intervalMs).toBeGreaterThan(before);
  });

  it('retries 5xx responses', async () => {
    const { client, fetchImpl } = harness((_url, attempt) =>
      attempt < 2 ? jsonResponse({}, { status: 503 }) : jsonResponse({ id: 7 }),
    );
    const result = await client.get<{ id: number }>('/releases/7');
    expect(result.id).toBe(7);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('gives up after exhausting retries and marks the error retryable', async () => {
    const { client } = harness([() => jsonResponse({}, { status: 503 })]);
    await expect(client.get('/releases/1')).rejects.toMatchObject({
      name: 'DiscogsError',
      status: 503,
      retryable: true,
    });
  });

  it('does not retry a 404 and reports it as terminal', async () => {
    const { client, fetchImpl } = harness([() => jsonResponse({ message: 'Release not found.' }, { status: 404 })]);
    await expect(client.get('/releases/999999999')).rejects.toBeInstanceOf(DiscogsError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('explains a bad token rather than leaking the status code', async () => {
    const { client } = harness([() => jsonResponse({}, { status: 401 })]);
    await expect(client.get('/oauth/identity')).rejects.toThrow(/token/i);
  });

  it('explains a private collection as needing a token', async () => {
    const { client } = harness([() => jsonResponse({}, { status: 403 })]);
    await expect(client.get('/users/x/collection/folders/0/releases')).rejects.toThrow(/private|token/i);
  });

  it('retries network failures', async () => {
    let attempt = 0;
    const client = new DiscogsClient({
      fetchImpl: (async () => {
        attempt += 1;
        if (attempt < 3) throw new TypeError('Failed to fetch');
        return jsonResponse({ id: 5 });
      }) as unknown as typeof fetch,
      sleepImpl: async () => undefined,
    });
    const result = await client.get<{ id: number }>('/releases/5');
    expect(result.id).toBe(5);
    expect(attempt).toBe(3);
  });
});

describe('request construction', () => {
  it('builds a paginated, date-sorted collection URL', async () => {
    const { client, calls } = harness([() => jsonResponse({ pagination: {}, releases: [] })]);
    await client.collectionPage('MarkJAnderson', { page: 3 });
    const url = calls[0]!;
    expect(url).toContain('/users/MarkJAnderson/collection/folders/0/releases');
    expect(url).toContain('per_page=100');
    expect(url).toContain('page=3');
    // Sorted newest-first so an incremental pass can bail out early.
    expect(url).toContain('sort=added');
    expect(url).toContain('sort_order=desc');
  });

  it('escapes usernames', async () => {
    const { client, calls } = harness([() => jsonResponse({})]);
    await client.profile('odd name/../x');
    expect(calls[0]).toContain('odd%20name%2F..%2Fx');
  });

  it('follows absolute pagination URLs unchanged', async () => {
    const { client, calls } = harness([() => jsonResponse({})]);
    await client.get('https://api.discogs.com/users/x/collection?page=2');
    expect(calls[0]).toBe('https://api.discogs.com/users/x/collection?page=2');
  });

  it('routes Discogs pagination links through a configured same-origin proxy', async () => {
    const calls: string[] = [];
    const proxied = new DiscogsClient({
      apiBaseUrl: '/api/discogs',
      fetchImpl: (async (input: RequestInfo | URL) => {
        calls.push(String(input));
        return jsonResponse({});
      }) as typeof fetch,
      sleepImpl: async () => undefined,
    });
    await proxied.get('https://api.discogs.com/users/x/collection?page=2');
    expect(calls[0]).toBe('/api/discogs/users/x/collection?page=2');
  });

  it('serialises concurrent callers through one pacing gate', async () => {
    const { client, fetchImpl } = harness([() => jsonResponse({ ok: true })]);
    await Promise.all([client.get('/a'), client.get('/b'), client.get('/c')]);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('aborts in flight when signalled', async () => {
    const controller = new AbortController();
    const client = new DiscogsClient({
      fetchImpl: (async () => jsonResponse({})) as unknown as typeof fetch,
      sleepImpl: async () => undefined,
    });
    controller.abort();
    await expect(client.get('/releases/1', { signal: controller.signal })).rejects.toThrow();
  });
});
