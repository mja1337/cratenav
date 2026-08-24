import type { MusicalKey } from '@/domain/types';
import { normaliseBpm } from '@/bpm/normalise';
import { extractMixVersion } from '@/discogs/mapper';
import { musicalKeyToCamelot, parseKey } from '@/harmonic/camelot';
import { pitchClassNumber } from '@/pitch/calculations';
import { nowIso } from '@/utils/ids';
import type {
  EnrichmentLookupOptions,
  EnrichmentProvider,
  MatchContext,
  ProviderIdentity,
  ProviderResult,
} from './provider';

interface GetSongBpmArtist {
  name?: string;
  mbid?: string;
}

interface GetSongBpmAlbum {
  title?: string;
  year?: number | string;
}

interface GetSongBpmSong {
  id?: string;
  title?: string;
  uri?: string;
  tempo?: number | string;
  key_of?: string;
  open_key?: string;
  artist?: GetSongBpmArtist | GetSongBpmArtist[];
  album?: GetSongBpmAlbum | GetSongBpmAlbum[];
}

interface GetSongBpmSearchResponse {
  search?: GetSongBpmSong[];
}

export interface GetSongBpmProviderOptions {
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  sleepImpl?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

function providerBase(): string | undefined {
  const proxyRoot = import.meta.env.VITE_METADATA_PROXY_BASE?.trim().replace(/\/$/, '');
  const loopback = typeof window !== 'undefined' &&
    ['127.0.0.1', 'localhost'].includes(window.location.hostname);
  if (loopback) return '/api/getsongbpm';
  return proxyRoot ? `${proxyRoot}/getsongbpm` : undefined;
}

function cleanKey(value: string | undefined): string | undefined {
  const cleaned = value?.replace(/[\r\n]/g, '').trim().slice(0, 300);
  return cleaned || undefined;
}

function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function first<T>(value: T | T[] | undefined): T | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function finitePositive(value: number | string | undefined): number | undefined {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function reviewUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' &&
      (url.hostname === 'getsongbpm.com' || url.hostname.endsWith('.getsongbpm.com'))
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Optional metadata provider for GetSongBPM's song catalogue.
 *
 * The provider has no duration/ISRC in its search response, so the central
 * matcher remains deliberately conservative: version or release-title
 * agreement is needed before a claim reaches VERIFY.
 */
export class GetSongBpmProvider implements EnrichmentProvider {
  readonly id = 'getsongbpm';
  readonly name = 'GetSongBPM';
  readonly available: boolean;
  readonly unavailableReason?: string;
  readonly supplies = { bpm: true, key: true } as const;
  readonly configuration = {
    setting: 'getSongBpmApiKey',
    label: 'GetSongBPM API key',
    inputType: 'password',
    placeholder: 'optional GetSongBPM API key',
    saveLabel: 'Save key',
    savedMessage: 'GetSongBPM key saved on this device.',
    clearedMessage: 'GetSongBPM key cleared.',
    helpText: 'Free key; GetSongBPM requires a backlink. Results remain unverified until you accept them.',
    helpUrl: 'https://getsongbpm.com/api',
    helpLinkText: 'Get a key or review the source',
    sanitize: (value: string) => value.replace(/[\r\n]/g, '').trim(),
    value: (settings: import('@/domain/types').Settings) => settings.getSongBpmApiKey?.trim() ?? '',
  } as const;

  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly sleepImpl: (ms: number, signal?: AbortSignal) => Promise<void>;
  private nextRequestAt = 0;

  constructor(options: GetSongBpmProviderOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.sleepImpl = options.sleepImpl ?? sleepWithAbort;
    const baseUrl = options.baseUrl ?? providerBase();
    this.available = Boolean(baseUrl);
    if (!this.available) {
      this.unavailableReason = 'A GetSongBPM metadata proxy is not configured for this deployment.';
    }
    this.baseUrl = (baseUrl ?? '').replace(/\/$/, '');
  }

  configured(options: EnrichmentLookupOptions): boolean {
    return Boolean(cleanKey(options.getSongBpmApiKey));
  }

  async lookup(
    context: MatchContext,
    options: EnrichmentLookupOptions = {},
  ): Promise<ProviderResult[]> {
    if (!this.available) throw new Error(this.unavailableReason);
    const apiKey = cleanKey(options.getSongBpmApiKey);
    if (!apiKey) throw new Error('Add a GetSongBPM API key before using this source.');
    const wait = this.nextRequestAt - Date.now();
    if (wait > 0) await this.sleepImpl(wait, options.signal);
    // 1.25 seconds keeps sustained batches under the published 3,000/hour.
    this.nextRequestAt = Date.now() + 1_250;

    const lookup = `song:${context.track.title} artist:${context.track.artist}`;
    const params = new URLSearchParams({ type: 'both', lookup, limit: '5' });
    const response = await this.fetchImpl(
      `${this.baseUrl}/search/?${params}`,
      {
        headers: {
          Accept: 'application/json',
          'X-API-KEY': apiKey,
        },
        signal: options.signal,
      },
    );
    if (!response.ok) {
      throw new Error(
        response.status === 401 || response.status === 403
          ? 'GetSongBPM rejected the API key.'
          : `GetSongBPM lookup failed (${response.status}).`,
      );
    }

    const songs = ((await response.json()) as GetSongBpmSearchResponse).search ?? [];
    return songs
      .map((song) => this.mapResult(context, song))
      .filter((result): result is ProviderResult => Boolean(result));
  }

  private mapResult(
    context: MatchContext,
    song: GetSongBpmSong,
  ): ProviderResult | undefined {
    const id = song.id?.trim();
    const rawTitle = song.title?.trim();
    const artist = first(song.artist)?.name?.trim();
    if (!id || !rawTitle || !artist) return undefined;

    const rawBpm = finitePositive(song.tempo);
    const bpm = rawBpm === undefined
      ? undefined
      : normaliseBpm({
          bpm: rawBpm,
          genres: context.release.genres,
          styles: context.release.styles,
        });
    const rawKey = song.key_of?.trim() || song.open_key?.trim() || '';
    const key: MusicalKey | null = parseKey(rawKey);
    if (!bpm && !key) return undefined;

    const parsedTitle = extractMixVersion(rawTitle);
    const album = first(song.album);
    const identity: ProviderIdentity = {
      artist,
      title: parsedTitle.title,
      version: parsedTitle.mixVersion,
      releaseTitle: album?.title?.trim() || undefined,
    };
    const bpmConfidence = bpm ? 0.65 : undefined;
    const keyConfidence = key ? 0.65 : undefined;

    return {
      identity,
      externalId: id,
      externalUrl: reviewUrl(song.uri),
      // Catalogue values are evidence, not ground truth. Even an exact title
      // match remains a human review until local audio corroborates it.
      verificationRequired: true,
      candidate: {
        source: 'getsongbpm',
        sourceBpm: bpm?.sourceBpm,
        canonicalBpm: bpm?.canonicalBpm,
        nativeBpm: bpm?.canonicalBpm,
        normalisationReason: bpm?.reason,
        sourceKey: rawKey || undefined,
        canonicalKey: key ?? undefined,
        camelotKey: key ? musicalKeyToCamelot(key) ?? undefined : undefined,
        nativeKey: key ?? undefined,
        nativeCamelot: key ? musicalKeyToCamelot(key) ?? undefined : undefined,
        nativePitchClass: key ? pitchClassNumber(key.pitchClass) : undefined,
        nativeMode: key?.tonality,
        bpmConfidence,
        keyConfidence,
        confidence: Math.max(bpmConfidence ?? 0, keyConfidence ?? 0),
        observedAt: nowIso(),
      },
    };
  }
}

export const getSongBpmProvider = new GetSongBpmProvider();
