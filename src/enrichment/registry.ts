import type { EnrichmentLookupOptions, EnrichmentProvider } from './provider';
import type { Settings } from '@/domain/types';
import { getSongBpmProvider } from './getsongbpm-provider';
import { openAnalysisProvider } from './open-analysis-provider';

/** Composition root: concrete adapters are registered here, never in views or interfaces. */
export const providers: readonly EnrichmentProvider[] = [
  openAnalysisProvider,
  getSongBpmProvider,
];

export function availableProviders(options: EnrichmentLookupOptions = {}): EnrichmentProvider[] {
  return providers.filter(
    (provider) => provider.available && (provider.configured?.(options) ?? true),
  );
}

/** Keep provider-specific settings knowledge out of views and batch orchestration. */
export function lookupOptionsForSettings(settings: Settings): EnrichmentLookupOptions {
  return {
    contact: settings.metadataContact?.trim(),
    getSongBpmApiKey: settings.getSongBpmApiKey?.trim(),
  };
}
