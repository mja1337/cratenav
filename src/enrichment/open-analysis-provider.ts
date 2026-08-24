import type { MusicalKey } from '@/domain/types';
import { normaliseBpm } from '@/bpm/normalise';
import { extractMixVersion } from '@/discogs/mapper';
import { musicalKeyToCamelot, parseKey } from '@/harmonic/camelot';
import { pitchClassNumber } from '@/pitch/calculations';
import { nowIso } from '@/utils/ids';
import type {
  EnrichmentProvider,
  EnrichmentLookupOptions,
  MatchContext,
  ProviderIdentity,
  ProviderResult,
} from './provider';

interface MusicBrainzArtistCredit {
  name?: string;
  joinphrase?: string;
  artist?: { name?: string };
}

interface MusicBrainzRecording {
  id: string;
  score?: number | string;
  title: string;
  length?: number;
  isrcs?: string[];
  'artist-credit'?: MusicBrainzArtistCredit[];
}

interface MusicBrainzSearchResponse {
  recordings?: MusicBrainzRecording[];
}

interface AcousticBrainzLowLevel {
  rhythm?: {
    bpm?: number;
    bpm_confidence?: number;
  };
  tonal?: {
    key_key?: string;
    key_scale?: string;
    key_strength?: number;
  };
}

type AcousticBrainzBulkResponse = Record<string, unknown>;

export interface OpenAnalysisProviderOptions {
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number, signal?: AbortSignal) => Promise<void>;
  musicBrainzBaseUrl?: string;
  acousticBrainzBaseUrl?: string;
}

function metadataBase(service: 'musicbrainz' | 'acousticbrainz'): string | undefined {
  const proxyRoot = import.meta.env.VITE_METADATA_PROXY_BASE?.trim().replace(/\/$/, '');
  const loopback = typeof window !== 'undefined' &&
    ['127.0.0.1', 'localhost'].includes(window.location.hostname);
  if (loopback) return `/api/${service}`;
  return proxyRoot ? `${proxyRoot}/${service}` : undefined;
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

function lucenePhrase(value: string): string {
  return value.replace(/([\\"])/g, '\\$1');
}

function creditedArtist(credits: readonly MusicBrainzArtistCredit[] | undefined): string {
  return (credits ?? [])
    .map((credit) => `${credit.name ?? credit.artist?.name ?? ''}${credit.joinphrase ?? ''}`)
    .join('')
    .trim();
}

function finite01(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value)
    ? Math.max(0, Math.min(1, value))
    : undefined;
}

function cleanContact(value: string | undefined): string | undefined {
  const cleaned = value?.replace(/[\r\n]/g, ' ').trim().slice(0, 200);
  return cleaned || undefined;
}

function requestHeaders(contact: string): HeadersInit {
  return {
    Accept: 'application/json',
    // Same-origin proxy turns this into the application User-Agent. Keeping
    // contact out of the URL prevents it appearing in history and access logs.
    'X-Cratenav-Contact': contact,
  };
}

function isLowLevel(value: unknown): value is AcousticBrainzLowLevel {
  return typeof value === 'object' && value !== null &&
    ('rhythm' in value || 'tonal' in value);
}

function extractBulkAnalysis(value: unknown): AcousticBrainzLowLevel | null {
  if (isLowLevel(value)) return value;
  if (typeof value !== 'object' || value === null) return null;
  for (const candidate of Object.values(value)) {
    if (isLowLevel(candidate)) return candidate;
  }
  return null;
}

/**
 * Zero-key public enrichment: MusicBrainz resolves recording identity, then
 * AcousticBrainz supplies its historic Essentia BPM/key observation.
 */
export class OpenAnalysisProvider implements EnrichmentProvider {
  readonly id = 'musicbrainz-acousticbrainz';
  readonly name = 'MusicBrainz + AcousticBrainz';
  readonly available: boolean;
  readonly unavailableReason?: string;
  readonly supplies = { bpm: true, key: true } as const;
  readonly configuration = {
    setting: 'metadataContact',
    label: 'MusicBrainz contact',
    inputType: 'text',
    placeholder: 'email or public project URL',
    saveLabel: 'Save contact',
    savedMessage: 'MusicBrainz contact saved on this device.',
    clearedMessage: 'MusicBrainz contact cleared.',
    helpText: 'Required only for MusicBrainz + AcousticBrainz. It stays on this device and is used in cratenav’s request identification.',
    sanitize: (value: string) => value.replace(/[\r\n]/g, ' ').trim(),
    value: (settings: import('@/domain/types').Settings) => settings.metadataContact?.trim() ?? '',
  } as const;

  private readonly fetchImpl: typeof fetch;
  private readonly sleepImpl: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly musicBrainzBaseUrl: string;
  private readonly acousticBrainzBaseUrl: string;
  private nextMusicBrainzAt = 0;
  private readonly acousticCache = new Map<string, AcousticBrainzLowLevel | null>();

  constructor(options: OpenAnalysisProviderOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.sleepImpl = options.sleepImpl ?? sleepWithAbort;
    const musicBrainzBaseUrl = options.musicBrainzBaseUrl ?? metadataBase('musicbrainz');
    const acousticBrainzBaseUrl = options.acousticBrainzBaseUrl ?? metadataBase('acousticbrainz');
    this.available = Boolean(musicBrainzBaseUrl && acousticBrainzBaseUrl);
    if (!this.available) {
      this.unavailableReason = 'A compliant metadata proxy is not configured for this deployment.';
    }
    this.musicBrainzBaseUrl = (musicBrainzBaseUrl ?? '').replace(/\/$/, '');
    this.acousticBrainzBaseUrl = (acousticBrainzBaseUrl ?? '').replace(/\/$/, '');
  }

  async lookup(
    context: MatchContext,
    options: EnrichmentLookupOptions = {},
  ): Promise<ProviderResult[]> {
    if (!this.available) throw new Error(this.unavailableReason);
    const contact = cleanContact(options.contact);
    if (!contact) {
      throw new Error('Add a contact email or project URL before using MusicBrainz.');
    }
    const recordings = (await this.search(context, contact, options.signal))
      .filter((candidate) => Number(candidate.score ?? 0) >= 75)
      .slice(0, 3);
    await this.acoustic(recordings.map((recording) => recording.id), options.signal);
    const results: ProviderResult[] = [];

    // MusicBrainz's own search score is used only to cap network work. Final
    // identity confidence is always computed by cratenav's central matcher.
    for (const recording of recordings) {
      const analysis = this.acousticCache.get(recording.id.toLowerCase());
      if (!analysis) continue;
      const result = this.mapResult(context, recording, analysis);
      if (result) results.push(result);
    }
    return results;
  }

  private async search(
    context: MatchContext,
    contact: string,
    signal?: AbortSignal,
  ): Promise<MusicBrainzRecording[]> {
    const wait = this.nextMusicBrainzAt - Date.now();
    if (wait > 0) await this.sleepImpl(wait, signal);
    this.nextMusicBrainzAt = Date.now() + 1_100;

    const query = `artist:"${lucenePhrase(context.track.artist)}" AND recording:"${lucenePhrase(context.track.title)}"`;
    const params = new URLSearchParams({ query, fmt: 'json', limit: '5' });
    const response = await this.fetchImpl(
      `${this.musicBrainzBaseUrl}/ws/2/recording/?${params}`,
      { headers: requestHeaders(contact), signal },
    );
    if (!response.ok) throw new Error(`MusicBrainz lookup failed (${response.status}).`);
    return ((await response.json()) as MusicBrainzSearchResponse).recordings ?? [];
  }

  private async acoustic(
    recordingIds: readonly string[],
    signal?: AbortSignal,
  ): Promise<void> {
    const missing = [...new Set(recordingIds.map((id) => id.toLowerCase()))]
      .filter((id) => !this.acousticCache.has(id));
    if (!missing.length) return;
    const params = new URLSearchParams({
      recording_ids: missing.join(';'),
      features: 'rhythm.bpm;tonal.key_key;tonal.key_scale;tonal.key_strength',
    });
    const response = await this.fetchImpl(
      `${this.acousticBrainzBaseUrl}/api/v1/low-level?${params}`,
      { headers: { Accept: 'application/json' }, signal },
    );
    if (!response.ok) throw new Error(`AcousticBrainz lookup failed (${response.status}).`);
    const payload = (await response.json()) as AcousticBrainzBulkResponse;
    for (const id of missing) this.acousticCache.set(id, extractBulkAnalysis(payload[id]));
  }

  private mapResult(
    context: MatchContext,
    recording: MusicBrainzRecording,
    analysis: AcousticBrainzLowLevel,
  ): ProviderResult | undefined {
    const rawBpm = analysis.rhythm?.bpm;
    const bpm = rawBpm !== undefined && Number.isFinite(rawBpm) && rawBpm > 0
      ? normaliseBpm({
          bpm: rawBpm,
          genres: context.release.genres,
          styles: context.release.styles,
        })
      : undefined;
    const rawKey = [analysis.tonal?.key_key, analysis.tonal?.key_scale]
      .filter(Boolean)
      .join(' ');
    const key: MusicalKey | null = parseKey(rawKey);
    if (!bpm && !key) return undefined;

    const bpmConfidence = finite01(
      analysis.rhythm?.bpm_confidence,
    );
    const keyConfidence = finite01(analysis.tonal?.key_strength);
    const resolvedBpmConfidence = bpm ? Math.max(0.35, Math.min(0.8, bpmConfidence ?? 0.55)) : undefined;
    const resolvedKeyConfidence = key ? Math.max(0.35, Math.min(0.8, keyConfidence ?? 0.55)) : undefined;
    const confidence = Math.max(resolvedBpmConfidence ?? 0, resolvedKeyConfidence ?? 0);
    const parsedTitle = extractMixVersion(recording.title);
    const identity: ProviderIdentity = {
      artist: creditedArtist(recording['artist-credit']) || context.track.artist,
      title: parsedTitle.title,
      version: parsedTitle.mixVersion,
      duration: recording.length ? recording.length / 1000 : undefined,
      isrc: recording.isrcs?.[0],
    };

    return {
      identity,
      externalId: recording.id,
      externalUrl: `https://musicbrainz.org/recording/${encodeURIComponent(recording.id)}`,
      // Historic third-party audio analysis is useful evidence, never an
      // automatic truth. The user explicitly verifies it or later local DSP
      // corroborates it.
      verificationRequired: true,
      candidate: {
        source: 'acousticbrainz',
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
        bpmConfidence: resolvedBpmConfidence,
        keyConfidence: resolvedKeyConfidence,
        confidence,
        observedAt: nowIso(),
      },
    };
  }
}

export const openAnalysisProvider = new OpenAnalysisProvider();
