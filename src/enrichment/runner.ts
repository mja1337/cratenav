import { scoreIdentity } from './matching';
import {
  type EnrichmentProvider,
  type EnrichmentLookupOptions,
  type MatchContext,
  type ProviderMatch,
} from './provider';
import { availableProviders } from './registry';
import type { EnrichmentAttempt } from '@/domain/types';
import { resolveMatches, type EnrichmentResolution } from './resolution';

export interface ProviderFailure {
  providerId: string;
  providerName: string;
  message: string;
}

export interface EnrichmentRun {
  consulted: string[];
  providers: Array<{ id: string; name: string }>;
  matches: ProviderMatch[];
  failures: ProviderFailure[];
  resolution: EnrichmentResolution;
}

/**
 * Query every available adapter, score all returned identities centrally, then
 * resolve the combined claims. One failing provider does not discard the rest.
 */
export async function runEnrichment(
  context: MatchContext,
  adapters: readonly EnrichmentProvider[] | undefined = undefined,
  options: EnrichmentLookupOptions = {},
): Promise<EnrichmentRun> {
  const active = (adapters ?? availableProviders(options))
    .filter((provider) => provider.available && (provider.configured?.(options) ?? true));
  const failures: ProviderFailure[] = [];

  const groups = await Promise.all(
    active.map(async (provider): Promise<ProviderMatch[]> => {
      try {
        const results = await provider.lookup(context, options);
        return results.map((result) => {
          const identity = scoreIdentity(context, result.identity);
          return {
            providerId: provider.id,
            providerName: provider.name,
            score: identity.score,
            evidence: identity.evidence,
            identity: result.identity,
            rationale: identity.rationale,
            candidate: result.candidate,
            externalId: result.externalId,
            externalUrl: result.externalUrl,
            verificationRequired: result.verificationRequired,
          };
        });
      } catch (error) {
        if (options.signal?.aborted || (error as Error)?.name === 'AbortError') throw error;
        failures.push({
          providerId: provider.id,
          providerName: provider.name,
          message: error instanceof Error ? error.message : String(error),
        });
        return [];
      }
    }),
  );

  const matches = groups.flat().sort((a, b) => b.score - a.score);
  return {
    consulted: active.map((provider) => provider.id),
    providers: active.map((provider) => ({ id: provider.id, name: provider.name })),
    matches,
    failures,
    resolution: resolveMatches(matches),
  };
}

/** Convert a combined run into one durable checkpoint per consulted adapter. */
export function attemptsForRun(
  run: EnrichmentRun,
  attemptedAt: string,
): EnrichmentAttempt[] {
  const failures = new Map(run.failures.map((failure) => [failure.providerId, failure]));
  return run.providers.map((provider) => {
    const failure = failures.get(provider.id);
    if (failure) {
      return {
        provider: provider.id,
        attemptedAt,
        outcome: 'error' as const,
        message: failure.message,
      };
    }
    return {
      provider: provider.id,
      attemptedAt,
      outcome: run.matches.some((match) => match.providerId === provider.id)
        ? 'found' as const
        : 'none' as const,
    };
  });
}
