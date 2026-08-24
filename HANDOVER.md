# cratenav — handover

Status as of this handover. Written for whoever picks the work up next.

- **Stack**: TypeScript + Vite, no UI framework, **zero runtime dependencies**. Dev deps only: `typescript`, `vite`, `vite-plugin-pwa`, `vitest`, `fake-indexeddb`, `@types/node`.
- **Size**: 63 TypeScript source modules. Build is 61.19 KB gzipped JS, 261.21 KiB precache.
- **Tests**: 341 passing across 23 files. `npm test`, `npm run typecheck` and `npm run build` are clean, with no build warnings.
- **Hosting**: GitHub Pages project page. `base: '/cratenav/'` in `vite.config.ts`; `.github/workflows/deploy.yml` gates deploy on typecheck + tests.
- **Git**: repo is `git init`'d. **No commit has been made** — the original Claude handover is staged and the 2026-08-24 stabilisation changes are currently unstaged.

Read `CLAUDE.md` before changing anything. It holds the invariants and the gotchas that cost time to discover.

---

## Build 1.0 — foundation, Discogs, crates, planning

### Discogs import (spec §3, §24)

Two deliberately separate operations, because they cost very different amounts of time:

| Action | Cost | Brings in |
|---|---|---|
| **Sync collection** | ~6 requests, seconds | Release IDs, artist, title, label, cat no, year, formats, genres, styles, cover art, rating, date added, folders; conditions/notes with a token |
| **Fetch metadata** | 1 request per release, ~9 min with token / ~22 min without | Tracklists with vinyl positions and durations, country, identifiers (barcode + runout etchings), credits, video refs, full artwork |

Key facts established by testing, not assumption:

- **Authenticated metadata needs a proxy.** Discogs permits some anonymous browser calls but rejects an `Authorization` CORS preflight on release metadata requests. `npm run preview` now runs a loopback-only `/api/discogs` proxy; a public deployment needs an equivalent server/edge route. GitHub Pages alone cannot provide the complete token-backed flow.
- Rate limits are **60/min authenticated, 25/min anonymous**. `DiscogsClient` reads the limit back from `x-discogs-ratelimit` and paces itself rather than hardcoding.
- `basic_information` on the collection endpoint carries **no tracklist**. That is the entire reason hydration is a second pass.
- Media/sleeve condition and collection notes are **private custom fields** — token required. Field IDs are matched by name because users rename them.
- **Test connection verifies the token.** It calls authenticated `/oauth/identity`, then reports the rate tier Discogs actually returns; testing a public profile alone was not sufficient.

**The hydration queue is not a table.** It *is* every release whose `hydrationState === 'stub'`, which makes it inherently resumable with nothing to drift. Verified live: killed the tab at 119/546, resumed at exactly 427 remaining, nothing lost.

Verified against the real collection (`MarkJAnderson`, public): 549 owned copies → 546 distinct releases (3 doubles), 909 tracks, **0 hydration failures**.

### Domain and data

Full model in `src/domain/types.ts`: `CollectionItem`, `Release`, `Track`, `Recording`, `TrackAnalysis`, `Bag`, `SetPlan`, `Transition`, `PlayHistory`, `TrackPlayState`, `Settings`. Every syncable row carries `id/createdAt/updatedAt/version/updatedByDevice/deletedAt` for the incremental sync in §26.

Two rules hold the design together:

1. **External shapes never leak inward.** Discogs JSON lives only in `src/discogs/`; past `mapper.ts` everything speaks the domain model.
2. **Discogs owns catalogue identity; cratenav owns DJ knowledge.** BPM, key, confidence, verification, notes, transitions, bags, plans, history are ours and a sync never overwrites them.

**Provenance, never bare numbers** (§10). `sourceBpm`, `canonicalBpm`, `nativeBpm`, source, confidence, verification and a reason string are all stored. Accepting a doubled suggestion keeps 87 as the source and 174 as canonical.

**Re-hydration preserves track IDs** (§24) — matched by vinyl position then title — so attached analysis survives a metadata refresh. See `src/data/track-reconcile.ts`.

### Features

- Collection browsing: cover grid, dense list, horizontal crate; search across artist/title/label/catno/track titles
- Release detail: pressing data, tracklist by vinyl position, runout etchings, video refs marked "not an audio source" (§33)
- Track detail: BPM/key with full provenance, manual entry, halve/double, verification
- Camelot ↔ musical conversion, interactive key wheel, compatibility engine (§38)
- Genre-aware BPM canonicalisation — the half-time D&B problem (§11)
- Bags/crates: create, rename, duplicate, archive, activate; add from any release page (§18)
- Bag coverage: counts, tempo histogram, key-spread wheel, style mix, plain-language gaps (§19)
- Set plans: freeform / shortlist / ordered, transition per join, bridge finder (§20)
- Analysis queue: prioritised by active bag and by gaps-per-record (§32)
- Sticker Run: giant native key + BPM with Camelot colour convention (§23)
- Dashboard folded into Library's resting state (§31)
- Play state per bag (§22); export **and** import JSON, merged by version (§27)
- Dark/light themes, all contrast AA, no state signalled by colour alone (§42, §43)

---

## Build 1.1 — vinyl pitch-aware harmonic mixing

Implemented in §37's priority order. Lives in `src/pitch/`.

| File | Contents |
|---|---|
| `calculations.ts` | `playbackBpm`, `pitchShiftSemitones/Cents`, `requiredPitchPercent`, `describePlayback`, pitch-class geometry with wraparound (§29) |
| `deck.ts` | `DeckProfile`, `PitchTolerance`, `CompatibilityClass`, `DEFAULT_SCORING` — all thresholds central, never in components (§12) |
| `matching.ts` | `matchAtPitch` — the effective-key scoring engine (§9, §10, §23) |
| `native.ts` | Native-value accessors with fallback, so native fields cannot drift from canonical |

Three things the model gets right that a naive one would not:

1. **A semitone is seven Camelot steps, not one.** The wheel is the circle of fifths. `continuousCamelotNumber` maps fractional pitch shifts correctly; the wheel's needle sits *between* segments and is never snapped (§4, §17).
2. **Two records both pitched sharp are still in tune with each other.** Compatibility scores the *interval between* the two effective centres, not each record's own deviation, with residual detuning penalised in cents.
3. **BPM canonicalisation is not a pitch change.** 87 → 174 changes representation; the record still spins at nominal speed. Pinned by explicit tests (§19, §28).

Surfaced in the UI at: suggestion rows (required pitch, native → playback BPM, compatibility class), set-plan joins ("play at −3.4%", resulting BPM, semitone shift), the pitch simulator, the key-wheel needle, and deck settings.

**Verified live:**

- Every reference value in §3 — at +4%: `181.0 BPM, +0.68 semitone, effective 2A · D# minor, −32 cents off`
- Deck range is decisive: at a 152 BPM target, **0 reachable on a Technics vs 42 on a ±16% deck**
- Scoring changed real answers: a suggestion went 96% (native) → **75%** (playback) because reaching the tempo detunes it; a join labelled "−2 Camelot" downgraded to "Tempo only" once pitching moved its effective key into a clash

All five §36 acceptance questions are answerable, entirely offline.

---

## Stabilisation — 2026-08-24

A persistence-focused review was completed before starting the next product phase:

- Full JSON backup now includes recordings, transitions, play history and per-bag play state as well as the original catalogue, analysis, bags and plans.
- Import restores portable settings but deliberately preserves the destination device ID and its device-local Discogs token, MusicBrainz contact and GetSongBPM key.
- Import plans all version-aware row changes before committing them in one IndexedDB transaction.
- Metadata reconciliation now removes an obsolete track and its empty placeholder analysis atomically; meaningful analysis still retains its track.
- **Clear local library** now clears every library-owned store, including bags, plans and history, while retaining account/device preferences.
- Added `fake-indexeddb` regression coverage for full export, version-aware import, credential isolation, unsupported formats, full clear and reconciliation cleanup.
- Corrected stale Settings copy that said crates and set plans were not built.
- Replaced the broken direct-browser authenticated Discogs route with a same-origin local preview proxy, including absolute pagination URLs. 429 responses now pause hydration without marking all remaining releases failed. Settings labels now correctly target their inputs.
- Added default-off **Vinyl-only mode**. It derives CD tracks narrowly from Discogs positions (`CD1`, `CD-1`, `CD 1`, etc.), hides them from all DJ-facing flows, and retains the raw track rows for an instant reversible switch back to All media.
- Added per-physical-copy replacement sleeve colours. Settings provides built-in Black/White/Teal/Purple plus custom named hex colours; assignments live on `CollectionItem`, survive Discogs sync/export, and render as labelled solid borders in both collection layouts.
- Added per-copy missing-disc state for incomplete multi-record releases. Standard A/B, C/D sides, explicit numbered-disc positions and A/AA conventions are mapped conservatively; unknown positions stay available. Missing-disc tracks remain visible as unavailable on release detail but are removed from collection/bag analysis, coverage, set plans, stickers and recommendation pools. A complete duplicate copy makes them available again.
- Discogs video references are deduplicated by normalized YouTube video identity both during import and at render time. The render-time pass immediately cleans older duplicated references already stored in IndexedDB. Real captured API fixtures contain exact duplicates even when the Discogs release page renders only one link.
- Collection sync now previews and confirms records missing from Discogs before soft-removing them. Release detail also offers a confirmed manual removal. Departed rows retain all catalogue/analysis history but are excluded from Collection, bags, DJ queues and metadata hydration; declining a sync removal leaves the copy owned and prompts again next time.
- Analyse enrichment moved from the Analyse view lifecycle into the app Store. Navigating away no longer aborts it. The shell renders every active Analyse/Discogs batch in a sticky progress strip on all routes, with a route-back action and global Pause/Stop control; reopening Settings also correctly reflects an already-running Discogs job.
- Library now has an **Unconfirmed analysis** release filter. It includes selected BPM/key data and retained provider candidates only where the supplied dimension remains unverified, excluding empty placeholders and fully confirmed evidence.
- Every rendered `input`/`select` now has a stable `id` and `name` (including dynamic provider credentials and the programmatic backup picker), removing Chrome's recurring form-field Issues warning across Collection, Analyse, Settings, Bag and Track controls.

---

## Build 1.2 — Phase 3 enrichment complete

Phase 3 is complete at a provider-independent boundary:

- `src/enrichment/matching.ts` centrally scores provider identities. Fixed weights ensure artist + title alone cannot become a high-confidence result merely because other evidence is missing.
- Version/remix, duration, ISRC, label, catalogue, exact release and resolved recording evidence are scored explicitly; contradictory version/ISRC/recording evidence is penalised.
- `src/enrichment/resolution.ts` classifies ranked provider claims as READY / VERIFY / ANALYSE / CONFLICT and retains every usable claim with its match score.
- `src/enrichment/runner.ts` queries every available adapter, applies central scoring, combines the claims, isolates an individual provider failure and propagates cancellation correctly.
- `src/enrichment/registry.ts` is the only composition root for concrete adapters. Views discover capabilities through the registry and never import a provider directly.
- Half-time source notation does not create a false conflict when canonical BPMs agree.
- Applying a resolution guards verified BPM and key independently. Verifying BPM cannot hide an unresolved key conflict, or vice versa.
- Track provenance now renders retained source candidates and lets the user choose supplied values; choosing a claim marks only the dimensions it supplies as verified.
- `src/enrichment/open-analysis-provider.ts` is the first live zero-key adapter: MusicBrainz resolves a recording MBID, then AcousticBrainz supplies historic Essentia BPM/key observations. MusicBrainz is paced at one request per second.
- `src/enrichment/getsongbpm-provider.ts` adds an optional GetSongBPM catalogue lookup. Its key is device-local and header-only, searches are paced at 1.25 seconds (under the published 3,000/hour limit), and the required attribution link is rendered in Analyse.
- Analyse runs every relevant registered adapter as a sequential, pauseable batch. Found/none/error attempts are checkpointed independently per provider in IndexedDB; adding a provider automatically requeues tracks it has not checked. Three consecutive total service outages stop the run without consuming the remaining queue.
- Normal enrichment now skips providers that already returned found/none for a track. Analyse exposes a source-specific catch-up action (including **Try GetSongBPM**) for tracks checked only by older sources, while explicit Recheck deliberately reruns completed sources.
- AcousticBrainz and GetSongBPM claims carry `verificationRequired`, so even excellent identity evidence cannot promote them directly to READY. Weak matches remain retained candidates for manual inspection.
- Persisted candidates retain provider/recording IDs, review URL, matched artist/title/version/duration, identity rationale and separate BPM/key confidence. Rechecks replace the same claim; different providers merge across runs, agreements raise confidence, and disagreements become CONFLICT without overwriting the current value.
- A hosted build only enables enrichment when `VITE_METADATA_PROXY_BASE` supplies compliant read-only MusicBrainz/AcousticBrainz/GetSongBPM routes. The Analyse UI stores a device-local maintainer contact and GetSongBPM key; the proxy uses the former for MusicBrainz request identification and forwards the latter only as `X-API-KEY`. `CRATENAV_CONTACT` is only a server fallback. AcousticBrainz uses its bulk endpoint so absent historic submissions are silent, and local preview retries transient 429/502/503/504 responses. No misleading direct-browser fallback remains.
- The public GitHub Pages deployment currently has no metadata proxy and must be described as static/offline for those operations. Use `npm run build && npm run preview` for metadata work until a restricted Cloudflare Worker is deployed. The Pages workflow accepts its future origin through the `VITE_METADATA_PROXY_BASE` repository variable; never put API keys in the build environment.
- More → About and the public README permanently credit and backlink GetSongBPM, including a direct API-access link. `index.html` contains a visible boot-screen backlink, while `public/getsongbpm.html` provides a dedicated static acknowledgement for registration crawlers that do not run JavaScript; preserve all four when changing settings or deployment copy. For registration, use `https://mja1337.github.io/cratenav/` as the website and `https://mja1337.github.io/cratenav/getsongbpm.html` as the backlink URL, never the client-only `#/settings` fragment.
- 34 enrichment/provider tests cover conservative identity matching, digital-version rejection, conflicting sources across runs, corroboration, canonical BPM agreement, provider failure/cancellation, both live adapter mappings, configuration gating, credential isolation and pacing, required request identification, user-verification precedence and application of native/provenance fields.

Additional legal metadata adapters remain optional and can be registered without changing the Analyse view or resolution rules.

---

## Build 1.3 — Phase 4 microphone analysis

Phase 4 is implemented at the browser microphone boundary:

- Every track has a **Listen & analyse** card with explicit microphone start/stop, a 20–60 second workflow, rolling BPM/key readouts, confidence bands, a separate LOCKED stability state, **Analyse longer**, **Accept values** and **Correct manually**.
- `src/analysis/audio.ts` now contains the replaceable `AudioSource` / `Analyser` boundary, an AudioWorklet-backed microphone source, bounded sample ring, onset-envelope BPM detector, FFT chroma/key-profile detector and pure rolling aggregation.
- Capture disables browser voice processing where supported, batches mono PCM in the worklet and routes through zero gain. Samples remain memory-only: nothing is recorded, persisted or uploaded. Navigating away stops the media tracks and closes the AudioContext.
- Analysis starts after six seconds and runs every two seconds over at most the latest 16 seconds. Four agreeing rolling observations are required for stability; confident but changing keys remain UNSTABLE, and alternating half/double BPMs are flagged.
- Accepting is an explicit human verification step. The app preserves raw detected BPM, applies the existing release-aware canonicalisation, stores native/canonical values with `local-analysis` provenance and keeps BPM/key confidence separate.
- Six deterministic DSP/stability tests cover 120/174 BPM pulse trains, A minor chroma, multi-window lock, key oscillation and half/double ambiguity.
- Production UI was browser-checked with an imported test track: the analysis card renders cleanly, and **Correct manually** scrolls to and focuses the BPM field. Automated QA deliberately did not grant microphone permission; a real turntable/phone capture remains the hardware smoke test.

The planned next phase is Phase 5 Live / B2B mode. File and USB audio sources remain future adapters behind the same interface.

---

## Outstanding

### Large — next phases

| Item | Spec | Notes for whoever takes it |
|---|---|---|
| **Live / B2B mode** | §16, §17, phase 5 | Placeholder screen. **Blocks v1.1 §13** (live required-pitch readout) and **§20/§21** (pitch inference from a known track, fingerprint hook). The recommendation engine already accepts a playback target, so Live mainly needs the detector plus a large-format UI. |
| **Google Drive sync** | §25, §26, phase 6 | Interface ready at `src/sync/provider.ts`. `ChangeRecord`/`MergeConflict` shapes defined; every row already carries `version` and `deletedAt`. Conflicts must be surfaced, not auto-resolved — a user-verified BPM losing to a stale remote row is real data loss. |

### Smaller / known gaps

- **Service worker never exercised.** This build environment's browser blocks SW registration — it fails identically for a valid plain JS file and a nonexistent path, so it is the environment, not the build. Artefacts verified statically: 11 precache entries, CacheFirst for artwork, NetworkOnly for the API, correct `/cratenav/` scope, maskable icon. **Offline behaviour needs one real-browser pass before it is trusted.**
- **CSV import** (§3 fallback) not built — deliberately dropped once API-only was confirmed to give full parity with a token.
- **Transition memory** (§21) — `Transition` entity exists and is exported; no UI, and it does not yet feed recommendation scoring. `DEFAULT_WEIGHTS` has room for it.
- **Recording entity** (§4) is modelled but unused. It is the mechanism for sharing one analysis across multiple pressings; nothing populates `recordingId` yet.
- **Capacitor** (§40) — abstractions exist in `src/storage/platform.ts` (`device`, `wakeLock`, `files`, `share`). No native implementations, and no Capacitor project.
- **Printable sticker sheets** (§23 future) not built.
- **Additional enrichment sources** are optional. Register only legal APIs in `src/enrichment/registry.ts`; do not turn Phase 3 into protected-storefront scraping.

### Test data warning

The browser I verified in contains **~53 seeded BPM/key values** marked `normalisationReason: 'Seeded test value'`, plus a test bag and set plan. They exist only in that throwaway IndexedDB, not in any real user's browser. If you see suspiciously tidy BPMs clustered at 168–176 and 134–142, that is why. The owner runs their own Discogs import from scratch.

Hydration in that browser reached ~244/546 before a hot-reload replaced the tab. Nothing was lost; pressing **Fetch metadata** resumes.

---

## Where things live

```
src/
  app/         bootstrap, store, hash router, shell, service worker
  components/  cover art, badges, key wheel, pitch simulator, coverage panel, suggestions
  views/       library, release, track, bags, setplan, analyse, sticker, settings, placeholder
  domain/      types.ts — the authoritative model
  data/        schema, repositories, track-reconcile
  discogs/     client (rate limiting), api-types, mapper, sync
  harmonic/    camelot conversion, compatibility scoring
  bpm/         canonicalisation
  pitch/       v1.1 — calculations, deck profiles, matching, native accessors
  bags/        lifecycle, coverage analysis
  sets/        set plans, ordered transitions
  recommend/   scoring, native and playback modes
  enrichment/  provider registry, central matching/resolution, MusicBrainz/AcousticBrainz and GetSongBPM adapters
  analysis/    queue prioritisation; microphone capture, rolling DSP and stability
  storage/     IndexedDB wrapper, platform capability abstractions
  sync/        cloud sync interface (stub)
  utils/       dom helpers, ids
```

Tests mirror the logic worth protecting: `pitch` (63), `bags` (33), `recommend` (30), `mapper` (27 — against **real captured API responses** in `tests/fixtures/`), `enrichment` (25), `client` (21), `coverage` (20), `bpm` (18), `compatibility` (15), `reconcile` (12), `queue` (12), track positions (11), `camelot` (9), IndexedDB-backed `repositories` (7), audio analysis/stability (6), physical-record inference/availability (6), GetSongBPM provider (5), app-level background operations (5), public analysis provider (4), analysis verification (4), sleeve palettes (3), reference deduplication (3), and confirmed Discogs departures (2).

The mapper fixtures pin down what breaks naive mapping: `A`/`AA` white-label sides, nested brackets in mix names (`Re-Rewind ... (Bump 'N' Flex (Sweet 'N' Low Mix))`), per-track artists differing from the release artist, Discogs' `(2)` duplicate-name suffixes, missing durations, and `heading`/`index` rows that are not real tracks.
