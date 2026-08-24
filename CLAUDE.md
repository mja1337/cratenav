# cratenav — working notes

Mobile-first PWA for vinyl DJs. Static-hosted on GitHub Pages, local-first, Capacitor-ready.
See README.md for setup and deployment. This file holds the things that are easy to get wrong.

## Hard-won facts

- **Authenticated Discogs needs a proxy.** Discogs permits some anonymous browser calls but rejects
  `Authorization` CORS preflight on release metadata requests. `npm run preview` provides a
  loopback-only `/api/discogs` proxy; a public deployment needs an equivalent server/edge route.
- **Rate limits are 60/min with a token, 25/min without.** Test connection verifies a token against
  `/oauth/identity`; the client reads the limit back from
  `x-discogs-ratelimit` and paces itself rather than hardcoding it.
- **`basic_information` has no tracklist.** That is the whole reason metadata hydration is a
  separate, slower pass from collection sync.
- **Media/sleeve condition and collection notes are private custom fields.** They only arrive when
  authenticated, and their field IDs are matched by name because users rename them.
- **IndexedDB cannot index booleans.** Anything queried must be a string enum or number; boolean
  domain fields are filtered in memory.

## Invariants worth protecting

- Discogs shapes never escape `src/discogs/`. Past the mapper, everything speaks `src/domain/types.ts`.
- Discogs owns catalogue identity; we own BPM, key, confidence, verification, notes, bags, plans,
  history. A sync must never overwrite our side.
- A BPM is never stored bare. `sourceBpm` and `canonicalBpm` are separate, with a reason string.
  Accepting a doubled suggestion keeps the original as the source.
- Re-hydration preserves track IDs (matched by vinyl position, then title) so attached analysis
  survives. See `src/data/track-reconcile.ts` and `tests/reconcile.test.ts`.
- Records leaving the Discogs collection require user confirmation, then are flagged
  `inCollection: false`, never deleted. Every DJ-facing collection/track queue must filter that
  flag; retained catalogue and analysis rows are history, not still-owned records.
- Replacement sleeve colour belongs to `CollectionItem` (the physical copy), not `Release`; custom
  palette entries live in Settings. Discogs sync must preserve both.
- Missing physical records also belong to `CollectionItem`, never `Release`. Infer a track's disc
  conservatively from Discogs positions; unknown positions stay available. Collection-wide pools
  include a track if any owned copy has its disc, while bag pools consider only packed copies.
- Deduplicate Discogs video references by normalized YouTube ID; real API responses repeat URLs
  that the Discogs webpage only renders once.
- Every track gets a placeholder analysis row at import. Those empty rows must NOT count as
  "has analysis" — see `hasMeaningfulAnalysis`.
- No state is signalled by colour alone; badges always carry text and a glyph.
- Every `input`, `select` and `textarea` needs an `id` or `name` (use both for normal visible
  controls), and every `<label for>` must target the matching id. Chrome reports this in Issues
  even when an `aria-label` makes the control otherwise accessible.
- A set-plan join warns on its WEAKEST known dimension, not the average: a key clash at a matching
  tempo averages to a respectable 0.5 and would hide the problem.
- Empty placeholder analysis rows must not count as "has analysis" (`hasMeaningfulAnalysis`).
- The set-plan picker updates rows in place; re-rendering on every tap loses scroll position.
- The analysis queue caps its list at 200 rows but states the true total: a silent truncation reads
  as "that is all there is".
- Long-running Discogs and enrichment work belongs to the app-level Store/DiscogsSync services,
  never a view lifecycle. Navigation must not abort it; the shell owns persistent progress and
  global Pause/Stop controls.
- "Unconfirmed analysis" means a supplied BPM/key dimension or retained candidate exists without
  human verification. Empty analysis placeholders and fully verified evidence must not match.
- Sticker Run shows NATIVE values only (spec v1.1 §18). Never print a pitched key on a label.
- `importLibrary` merges by `version` and never overwrites a newer local row. Restoring an old
  backup must not be able to destroy hand-entered analysis.
- A full backup includes every user-owned store. Portable settings restore, but the destination
  device ID and device-local credentials/contact remain local and must never be taken from an import.
- Removing an obsolete hydrated track must also remove its empty placeholder analysis in the same
  transaction. Meaningful analysis retains the track instead.
- The hydration queue is not a table. It IS every release with `hydrationState === 'stub'`,
  which is what makes it inherently resumable.
- Enrichment providers never decide acceptance. Identity evidence is scored centrally in
  `src/enrichment/matching.ts`, and only `resolveMatches` assigns READY / VERIFY / CONFLICT.
- Artist + title alone must remain below VERIFY. User verification guards BPM and key separately;
  verifying one dimension must not hide a conflict in the other.
- The MusicBrainz → AcousticBrainz adapter needs no key. Keep MusicBrainz at one request per second,
  checkpoint every batch attempt, and never let historic AcousticBrainz analysis auto-promote to
  READY: its `verificationRequired` flag is a deliberate trust boundary.
- GetSongBPM is optional and configuration-gated. Keep its API key device-local, exclude it from
  backup/import, forward it only as `X-API-KEY`, retain the required backlink, pace requests at
  1.25 seconds, and keep every result `verificationRequired`.
- Preserve the visible GetSongBPM credit/backlink in More → About and the README. The public Pages
  build has no metadata proxy until `VITE_METADATA_PROXY_BASE` points to a restricted Worker; never
  imply hosted enrichment works without it or place a user API key in the build environment.
- Concrete enrichment adapters belong only in `src/enrichment/registry.ts`. Views consume provider
  capabilities, never a named adapter. Candidate refreshes must merge with independent prior
  evidence, retain reviewable recording identity, and keep BPM/key confidence separate.
- An unconfigured provider must not be queried or create a durable attempt. This is what lets adding
  a new provider later requeue only the tracks that source has never checked.
- A normal enrichment run must skip a provider's completed found/none attempt. Source-specific
  catch-up runs query only that new provider; only an explicit Recheck may rerun completed sources.
- Direct browser MusicBrainz calls cannot supply the required application User-Agent. The Analyse UI
  collects a device-local contact which the loopback proxy places in that User-Agent;
  `CRATENAV_CONTACT` is only a fallback. A hosted enrichment build requires
  `VITE_METADATA_PROXY_BASE`. Without one, the provider must remain honestly unavailable while
  offline/manual features continue to work.

## Gotchas hit during the build

- `<img>` served from cache completes before a `load` listener attaches, so `opacity: 0` + reveal-on-load
  leaves covers invisible. `src/components/cover.ts` checks `image.complete` explicitly.
- On desktop the shell is a grid; the header needs its own named row or it auto-places into an
  implicit row below the full-height main column and scrolls off screen.
- `--text-faint` renders at 11px, so it needs full AA contrast (4.5:1), not AA-large.

## Vinyl pitch model (spec v1.1)

- **Pitch and tempo are the same physical fact on vinyl.** A record at +4% is ~0.68 semitones sharp.
  Never treat a stored key as the key heard at a non-zero pitch.
- **A semitone is SEVEN Camelot steps**, not one — the wheel is the circle of fifths. See
  `continuousCamelotNumber`; a fractional pitch shift must be mapped through it, never added to the
  wheel number.
- **Compatibility is scored on the interval between the two effective centres**, not each record's
  own deviation. Two records both pitched sharp are still in tune with each other.
- **Never snap the underlying calculation** to a discrete key. `effectivePitchClass` stays a float;
  the nearest key is display only, with `harmonicDeviationCents` alongside it.
- **`tempoKnown` gates every pitch figure in the UI.** Without both tempos, `requiredPitchPercent`
  is 0 and meaningless — printing "+0.0%" would read as "no pitch needed".
- **Half/double-time canonicalisation is NOT a pitch change.** 87 -> 174 changes representation;
  pitch stays 0 and nothing moves musically. Tested explicitly.
- **Deck range is configurable, never assumed.** ±8% is a Technics, not a universal truth. Scoring
  thresholds live in `DEFAULT_SCORING`, not in components.

## Not built yet

Local-file/USB audio analysis, live/B2B and Google Drive sync. Additional legal enrichment providers
are optional and plug into the completed Phase 3 registry. Microphone DSP is implemented behind the
replaceable `AudioSource` / `Analyser` boundary. Do not add mock data that looks live.
