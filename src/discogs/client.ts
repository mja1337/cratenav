import type {
  DiscogsCollectionPage,
  DiscogsFieldsResponse,
  DiscogsFoldersResponse,
  DiscogsIdentity,
  DiscogsProfile,
  DiscogsRelease,
} from './api-types';

/**
 * Rate-limited Discogs API client.
 *
 * Discogs permits some anonymous browser requests, but its release endpoints
 * do not consistently allow an Authorization-header CORS preflight. During
 * local development/preview we therefore use the same-origin `/api/discogs`
 * proxy. A deployed app needs the equivalent server/edge route; a static
 * origin alone cannot reliably make authenticated Discogs calls.
 *
 * Rate limits are a sliding 60-second window: 60 requests authenticated, 25
 * unauthenticated. Rather than hardcode that, we read the limit back from the
 * `x-discogs-ratelimit` response headers and pace ourselves accordingly. That
 * way an upstream change in the allowance does not silently start failing.
 */

const DISCOGS_API_URL = 'https://api.discogs.com';

function defaultApiBaseUrl(): string {
  // The local server proxies this route, avoiding Discogs' inconsistent CORS
  // preflight support for Authorization. Keep the direct URL as the fallback
  // so non-local static deployments retain anonymous read-only behaviour.
  if (typeof window !== 'undefined' && ['127.0.0.1', 'localhost'].includes(window.location.hostname)) {
    return '/api/discogs';
  }
  return DISCOGS_API_URL;
}

/** Safety margin added to the computed inter-request interval, in ms. */
const PACING_MARGIN_MS = 120;

export class DiscogsError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'DiscogsError';
  }
}

export interface RateLimitState {
  /** Requests permitted per 60-second window, as reported by Discogs. */
  limit: number;
  remaining: number;
  /** Current pacing interval between requests, in ms. */
  intervalMs: number;
}

export interface DiscogsClientOptions {
  /** Personal access token. Optional: public collections are readable without one. */
  token?: string | undefined;
  /** Injected for tests. */
  fetchImpl?: typeof fetch;
  /** Injected for tests, so pacing does not make suites slow. */
  sleepImpl?: (ms: number) => Promise<void>;
  /** Same-origin Discogs proxy, used by the local preview server and tests. */
  apiBaseUrl?: string;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class DiscogsClient {
  private token: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly sleepImpl: (ms: number) => Promise<void>;
  private readonly apiBaseUrl: string;

  /** Serialises every request so pacing is respected across concurrent callers. */
  private chain: Promise<unknown> = Promise.resolve();
  private nextAllowedAt = 0;

  private state: RateLimitState = { limit: 25, remaining: 25, intervalMs: 2500 };

  constructor(options: DiscogsClientOptions = {}) {
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.sleepImpl = options.sleepImpl ?? defaultSleep;
    this.apiBaseUrl = (options.apiBaseUrl ?? defaultApiBaseUrl()).replace(/\/$/, '');
    this.applyLimit(options.token ? 60 : 25);
  }

  setToken(token: string | undefined): void {
    this.token = token;
    this.applyLimit(token ? 60 : 25);
  }

  get hasToken(): boolean {
    return Boolean(this.token);
  }

  get rateLimit(): RateLimitState {
    return { ...this.state };
  }

  /** Estimated seconds to complete `count` sequential requests at current pacing. */
  estimateSeconds(count: number): number {
    return Math.ceil((count * this.state.intervalMs) / 1000);
  }

  private applyLimit(limit: number): void {
    const safe = Math.max(1, limit);
    this.state.limit = safe;
    this.state.intervalMs = Math.ceil(60_000 / safe) + PACING_MARGIN_MS;
  }

  /**
   * Queue a request behind the pacing gate. Requests run strictly one at a
   * time; Discogs' window is short enough that parallelism buys nothing but
   * 429s.
   */
  private enqueue<T>(run: () => Promise<T>): Promise<T> {
    const result = this.chain.then(run, run);
    // Keep the chain alive even when a request rejects.
    this.chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async pace(signal?: AbortSignal): Promise<void> {
    const wait = this.nextAllowedAt - Date.now();
    if (wait > 0) await this.sleepImpl(wait);
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    this.nextAllowedAt = Date.now() + this.state.intervalMs;
  }

  private headers(): HeadersInit {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (this.token) headers['Authorization'] = `Discogs token=${this.token}`;
    // Note: browsers forbid setting User-Agent. Discogs accepts the browser's own.
    return headers;
  }

  private readLimitHeaders(response: Response): void {
    const limit = Number(response.headers.get('x-discogs-ratelimit'));
    const remaining = Number(response.headers.get('x-discogs-ratelimit-remaining'));
    if (Number.isFinite(limit) && limit > 0 && limit !== this.state.limit) {
      this.applyLimit(limit);
    }
    if (Number.isFinite(remaining)) this.state.remaining = remaining;
  }

  /**
   * Perform a GET with pacing, 429 backoff and transient-error retry.
   * `path` may be an absolute URL (Discogs pagination returns full URLs).
   */
  async get<T>(path: string, options: { signal?: AbortSignal; retries?: number } = {}): Promise<T> {
    const { signal, retries = 4 } = options;

    return this.enqueue(async () => {
      const url = this.resolveUrl(path);
      let attempt = 0;

      for (;;) {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        await this.pace(signal);

        let response: Response;
        try {
          response = await this.fetchImpl(url, { headers: this.headers(), signal });
        } catch (error) {
          if (signal?.aborted) throw error;
          // Network failure: worth retrying, we may simply be offline briefly.
          if (attempt++ >= retries) {
            throw new DiscogsError(
              `Network error contacting Discogs: ${(error as Error).message}`,
              0,
              true,
            );
          }
          await this.sleepImpl(this.backoff(attempt));
          continue;
        }

        this.readLimitHeaders(response);

        if (response.ok) return (await response.json()) as T;

        // 429: we have out-paced the window. Back off hard and slow down.
        if (response.status === 429) {
          const retryAfter = Number(response.headers.get('retry-after'));
          const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
            ? retryAfter * 1000
            : this.backoff(attempt + 1);
          // Widen our own pacing so we stop hitting the wall.
          this.state.intervalMs = Math.min(this.state.intervalMs + 250, 10_000);
          if (attempt++ >= retries) {
            throw new DiscogsError('Discogs rate limit exceeded', 429, true);
          }
          await this.sleepImpl(waitMs);
          continue;
        }

        if (response.status >= 500) {
          if (attempt++ >= retries) {
            throw new DiscogsError(`Discogs server error (${response.status})`, response.status, true);
          }
          await this.sleepImpl(this.backoff(attempt));
          continue;
        }

        throw new DiscogsError(
          await this.describeError(response),
          response.status,
          false,
        );
      }
    });
  }

  private resolveUrl(path: string): string {
    if (!path.startsWith('http')) return `${this.apiBaseUrl}${path}`;
    // Pagination links returned by Discogs are absolute. Route those through
    // the same local proxy too, or page two would reintroduce the CORS bug.
    if (path.startsWith(DISCOGS_API_URL) && this.apiBaseUrl !== DISCOGS_API_URL) {
      return `${this.apiBaseUrl}${path.slice(DISCOGS_API_URL.length)}`;
    }
    return path;
  }

  private backoff(attempt: number): number {
    // Exponential with jitter, capped. Jitter avoids synchronised retries
    // when several tabs are syncing.
    const base = Math.min(1000 * 2 ** attempt, 30_000);
    return base + Math.random() * 500;
  }

  private async describeError(response: Response): Promise<string> {
    let detail = '';
    try {
      const body = (await response.json()) as { message?: string };
      detail = body.message ?? '';
    } catch {
      /* body was not JSON; the status alone will have to do */
    }

    switch (response.status) {
      case 401:
        return detail || 'Discogs rejected the token. Check it in Settings.';
      case 403:
        return detail || 'Discogs denied access. The collection may be private — add a token.';
      case 404:
        return detail || 'Not found on Discogs.';
      default:
        return detail || `Discogs request failed (${response.status})`;
    }
  }

  // --- endpoints -------------------------------------------------------------

  /** Verifies a token. Fails with 401 if the token is bad. */
  identity(signal?: AbortSignal): Promise<DiscogsIdentity> {
    return this.get<DiscogsIdentity>('/oauth/identity', { signal });
  }

  profile(username: string, signal?: AbortSignal): Promise<DiscogsProfile> {
    return this.get<DiscogsProfile>(`/users/${encodeURIComponent(username)}`, { signal });
  }

  folders(username: string, signal?: AbortSignal): Promise<DiscogsFoldersResponse> {
    return this.get<DiscogsFoldersResponse>(
      `/users/${encodeURIComponent(username)}/collection/folders`,
      { signal },
    );
  }

  /** Custom field definitions — how media/sleeve condition and notes are labelled. */
  fields(username: string, signal?: AbortSignal): Promise<DiscogsFieldsResponse> {
    return this.get<DiscogsFieldsResponse>(
      `/users/${encodeURIComponent(username)}/collection/fields`,
      { signal },
    );
  }

  /**
   * One page of the collection. Folder 0 is the "All" pseudo-folder.
   * Sorted by date added descending so incremental sync can stop early.
   */
  collectionPage(
    username: string,
    options: { folderId?: number; page?: number; perPage?: number; signal?: AbortSignal } = {},
  ): Promise<DiscogsCollectionPage> {
    const { folderId = 0, page = 1, perPage = 100, signal } = options;
    const query = new URLSearchParams({
      page: String(page),
      per_page: String(perPage),
      sort: 'added',
      sort_order: 'desc',
    });
    return this.get<DiscogsCollectionPage>(
      `/users/${encodeURIComponent(username)}/collection/folders/${folderId}/releases?${query}`,
      { signal },
    );
  }

  /** Full release: tracklist, identifiers, artwork, credits, video references. */
  release(releaseId: number, signal?: AbortSignal): Promise<DiscogsRelease> {
    return this.get<DiscogsRelease>(`/releases/${releaseId}`, { signal });
  }
}
