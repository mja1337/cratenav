# cratenav

A mobile-first PWA for vinyl DJs: collection, crate planning, harmonic mixing and (later) live B2B assistance. Hosted as a static site on GitHub Pages, local-first, offline-capable, and structured so it can be wrapped with Capacitor later without a rewrite.

**Current status: Discogs import, collection browsing, online enrichment, microphone BPM/key analysis, crates, set planning, and pitch-aware harmonic mixing (spec v1.1).**

> **Hosted metadata status:** the GitHub Pages site is a static PWA and currently has no server-side metadata proxy. Use the local production preview for Discogs import and online BPM/key enrichment for now. A narrowly scoped Cloudflare Worker (or equivalent edge proxy) is the intended hosted solution.

Public app: [https://mja1337.github.io/cratenav/](https://mja1337.github.io/cratenav/)

## What works today

- Installable PWA with a service worker, offline app shell and runtime artwork caching
- IndexedDB storage layer behind a swappable interface
- Full domain model (releases, tracks, recordings, analysis provenance, bags, set plans, transitions, play history)
- **Discogs import**: collection sync plus a resumable per-release metadata queue
- Per-copy missing-disc tracking for incomplete multi-record releases, excluded from DJ-facing pools without deleting catalogue data
- Collection browsing in three modes — cover grid, dense list, horizontal crate
- Release detail: pressing data, tracklist by vinyl position, runout/barcode identifiers, video references
- Track detail: BPM and key with full provenance, manual entry, halve/double, verification
- Camelot ↔ musical key conversion and an interactive key wheel with compatibility highlighting
- Genre-aware BPM canonicalisation (the half-time D&B problem)
- **Bags/crates**: build, name, duplicate, archive, set active; add records from any release page
- **Bag coverage**: counts, tempo histogram, key-spread wheel, style mix, and plain-language gaps
- **Set plans**: freeform, shortlist and ordered modes, with the transition shown at each join and a bridge-track finder
- **Pitch-aware mixing (v1.1)**: required pitch per record, deck profiles, effective-key scoring, compatibility classes, and a pitch simulator
- **Online enrichment**: MusicBrainz → AcousticBrainz plus optional GetSongBPM BPM/key lookup, navigable background batch progress, conservative identity scoring and retained source candidates without overwriting verified work
- **Microphone analysis**: private on-device rolling BPM/key detection with confidence, multi-window stability, half/double ambiguity warnings and explicit user acceptance
- **Analysis queue**: what to analyse next, prioritised by active bag and by how many gaps a record has
- **Sticker Run**: giant native key + BPM for copying onto physical labels, with Camelot colour convention
- **Dashboard**: collection and bag summary with quick actions, on the library's resting state
- Library filters: style, needs metadata, needs analysis, verified, active-bag membership, tempo band
- **Library import**: restore a JSON backup, merged by version so it never overwrites newer local work
- Play state per bag: packed / played / favourite / put aside
- Dark and light themes, keyboard accessible, no state signalled by colour alone

## Not built yet

Additional corroborating providers, local-file/USB analysis, live/B2B mode and Google Drive sync are modelled in the data layer but not yet implemented.

## Vinyl pitch awareness (spec v1.1)

On a turntable without key lock, changing the platter speed changes tempo **and** musical pitch — they are the same physical fact. So a record's stored key is only its key at nominal speed, and the question that actually matters mid-set is not "is this record's key compatible" but "once I have pitched it to match, is the key it will then be in compatible".

The app answers four questions, all offline:

| Question | Where |
|---|---|
| What pitch do I need on this record to reach that tempo? | Suggestion rows, set-plan joins |
| Once pitched, how far has its musical pitch moved? | Pitch simulator, set-plan joins |
| Is the resulting effective key still compatible? | Compatibility class on every suggestion |
| Is it playable within my deck's range? | `OUT OF RANGE`, per deck profile |

Three details worth knowing:

**A semitone is seven steps on the Camelot wheel, not one.** The wheel is the circle of fifths, so pitching a record even a fraction of a semitone moves it a long way around. The wheel's effective-pitch needle reflects that, and sits *between* segments rather than snapping to one.

**Two records both pitched sharp are still in tune with each other.** Compatibility is scored on the interval between the two effective centres, not on each record's own deviation, so a matched pair scores clean while a mismatched one is penalised in cents of residual detuning.

**BPM canonicalisation is not a pitch change.** Rewriting a half-time `87` as `174` changes the *representation* of the tempo; the record still spins at nominal speed and nothing moves musically. `sourceBpm`, `canonicalBpm` and `nativeBpm` are kept distinct precisely so these cannot be confused, and there are tests pinning it down.

Deck profiles live in **More → Decks and pitch**: Technics-style ±8% (the default, no key lock), a ±16% wide-range deck, and a digital deck with key lock, where tempo moves without pitch. A separate *preferred maximum pitch* sets what counts as comfortable — inside it there is no penalty, beyond it suggestions rank lower but are still offered, past the deck's hard range they are unavailable.

## Local development

```bash
npm install
```

```bash
npm run dev
```

The dev server prints a URL; the app is served under the `/cratenav/` base path.

Other scripts:

```bash
npm test
```

```bash
npm run typecheck
```

```bash
npm run build && npm run preview
```

For the complete metadata workflow, this is currently the recommended way to run cratenav. Open the loopback URL printed by `npm run preview`; its local-only server supplies the read-only Discogs, MusicBrainz, AcousticBrainz and GetSongBPM proxy routes that a static GitHub Pages site cannot provide. `npm run dev` also proxies these services for development, but the production preview is the closest match to the deployed PWA.

## Connecting Discogs

1. Open **More → Discogs**.
2. Enter your Discogs username and press **Test connection**.
3. Press **Import collection**.
4. Press **Fetch metadata** to pull tracklists.

### About the token

A personal access token is **optional**:

| | Without token | With token |
|---|---|---|
| Rate limit | 25 requests/min | 60 requests/min |
| Public collection | readable | readable |
| Private collection | not readable | readable |
| Media/sleeve condition | unavailable | imported |
| Collection notes | unavailable | imported |

Media condition, sleeve condition and collection notes are private custom fields, so they only arrive when authenticated. Generate a token at **Discogs → Settings → Developers**.

The token is stored only in this browser's IndexedDB. It is never committed, never included in an export, and cratenav only ever issues `GET` requests. Note that a Discogs personal access token carries full account access, so revoke it from the same page if you stop using it.

### Vinyl-only mode

**More → Settings → Library mode → Vinyl only** is off by default. When enabled, Discogs track positions such as `CD1` and `CD-1` are hidden from release tracklists and excluded from bags, analysis, stickers and set planning. The original import stays untouched, so switching back to **All media** restores them immediately.

### Replacement sleeve colours

**More → Settings → Replacement sleeves** starts with Black, White, Teal and Purple, and accepts additional named colours. On a release page, assign a colour to each physical copy. The library shows a solid colour border plus a text label, while the assignment and custom palette remain in the local database and JSON backup. Removing an assignment restores the normal release display; no Discogs metadata is changed.

Discogs API responses occasionally repeat the same YouTube video even when the Discogs webpage shows it once. References are deduplicated during import by YouTube video ID, including alternate watch, short, embed and shorts URLs.

For local testing, `npm run preview` starts a loopback-only proxy for authenticated Discogs requests and public analysis lookups. This is required because Discogs rejects the browser CORS preflight for some release-metadata calls. **Test connection** verifies a token using Discogs' authenticated identity endpoint and displays the rate tier Discogs actually reports.

### Online BPM and key lookup

The **Analyse** screen has two independent sources. MusicBrainz can resolve a recording ID and request historic BPM/key observations from AcousticBrainz; missing analyses are omitted cleanly rather than producing expected 404 errors. GetSongBPM can search its song catalogue directly when you add a free API key. Both sources retain their own checkpoints, so adding GetSongBPM later automatically queues tracks it has never checked without repeating completed work unnecessarily. Analyse also shows a dedicated **Try GetSongBPM** catch-up action for tracks previously checked by another source; the general action likewise skips completed providers unless you explicitly choose Recheck.

MusicBrainz is paced to one request per second. GetSongBPM is paced to one request per 1.25 seconds, below its published 3,000-request hourly limit. The local preview retries temporary upstream failures, while the batch saves a durable checkpoint per provider after every track, can be paused, and stops after three unrecovered service outages. Analyse and Discogs batches belong to the app rather than their starting screens: navigation does not cancel them, and a persistent shell progress strip with View and Pause/Stop controls remains visible everywhere.

Library's **Unconfirmed analysis** filter shows releases with BPM/key evidence or retained online candidates that still need human confirmation. Fully confirmed values and empty placeholder analysis rows are excluded.

AcousticBrainz data is historic automated audio analysis, and GetSongBPM is third-party catalogue metadata; neither is treated as ground truth. Results are therefore always saved as **VERIFY**, never silently promoted to READY, even when the recording identity is strong. Weak identity matches remain as source candidates rather than overwriting the track. Candidate history is merged across providers and runs, with matched identity, external ID, rationale, and separate identity/BPM/key confidence retained. Half-time BPMs are normalised using the release's Discogs genre/style, so a Jungle result of 87 can be shown as canonical 174 while retaining 87 as the source value.

MusicBrainz asks clients to identify a maintainer as well as respecting its one-call-per-second limit. Enter an email or public project URL in the **MusicBrainz contact** field on Analyse and save it before starting. It stays in this browser's IndexedDB, is excluded from exports, and the same-origin proxy uses it only in cratenav's request identification. `CRATENAV_CONTACT` remains available as an optional server-side fallback, but is no longer required for normal local use.

For GetSongBPM, obtain a key from [the official API page](https://getsongbpm.com/api), enter it in **GetSongBPM API key**, and save it. GetSongBPM requires attribution, so cratenav links to and warmly credits the [GetSongBPM service](https://getsongbpm.com/) in the public **More → About** section as well as linking from Analyse. The key stays in this browser's IndexedDB, is excluded from exports, is sent to the local proxy only in the `X-API-KEY` header, and is never placed in a request URL.

When requesting GetSongBPM API access for the public cratenav deployment, use these values:

- **Website URL:** `https://mja1337.github.io/cratenav/`
- **Backlink URL:** `https://mja1337.github.io/cratenav/getsongbpm.html`

Do not submit `https://mja1337.github.io/cratenav/#/settings`. Everything after `#` is a browser-only route and is never sent to the web server or a backlink checker. The backlink URL above is a dedicated static HTML acknowledgement with no JavaScript dependency. The project root also contains the backlink directly in its source HTML, and the full acknowledgement remains visible in **More → About** after the app starts.

### Microphone BPM and key analysis

Open any track and use **Listen & analyse**. Set the turntable pitch to 0%, allow microphone access, then play a clear 20–60 second section. The first observation appears after roughly six seconds; overlapping observations vote on BPM and key until the reading is stable. Per-window confidence alone never creates a lock, and alternating half/double-tempo readings are called out as ambiguous.

Capture uses a Web Audio `MediaStreamAudioSourceNode` and an `AudioWorklet`. Samples remain in a bounded in-memory rolling buffer, feed the local onset/chroma detectors, and are never recorded, persisted or uploaded. The capture graph is muted, so cratenav does not play the microphone back through the speakers. Leaving the track screen stops the media tracks and closes the audio context.

When the result locks, **Accept values** stores it as `local-analysis` with source/native/canonical values, separate BPM/key confidence and the accepted-by-user provenance. BPM still passes through the release-aware half/double normaliser. **Analyse longer** discards the rolling vote and listens to a fresh section; **Correct manually** focuses the existing manual controls.

### Why two separate sync actions

They cost very different amounts of time, so the app never hides one behind the other:

| Action | Requests | Time (549 records) | Brings in |
|---|---|---|---|
| **Sync collection** | ~6 | seconds | Release IDs, artist, title, label, cat no, year, formats, genres, styles, cover art, rating, date added, folders, conditions/notes (with token) |
| **Fetch metadata** | 1 per release | ~9 min with token, ~22 min without | Tracklists with vinyl positions and durations, country, identifiers (barcode + runout etchings), credits, video references, full artwork |

The collection endpoint's `basic_information` does not include tracklists, which is why the second pass exists.

**The metadata queue is resumable.** It is not a separate table that can drift — the queue *is* every release still marked `stub`, so closing the tab at record 340 of 549 leaves 340 done and 209 queued. Press **Fetch metadata** again to carry on. Failures are recorded per release and retried on demand.

Re-running **Fetch metadata** (or **Refresh all metadata**) takes Discogs' improved catalogue data without destroying your own work: tracks are matched to the incoming tracklist by vinyl position and keep their IDs, so attached BPM/key analysis stays attached. When collection sync finds copies no longer listed by Discogs, it names them and asks before marking them no longer owned. A release page also has a confirmed **Remove from collection** action. Both paths hide departed records from Collection, bags, analysis and metadata queues while retaining their metadata and BPM/key history locally.

For multi-record releases, **Records in this release** on the release page identifies the physical discs from Discogs positions (for example A/B and C/D). Marking Record 2 missing is stored per owned copy. Its tracks remain visible on the release as unavailable, but are excluded from Analyse, bag coverage, set plans, Sticker Run and recommendation candidates. If another owned or packed copy contains that disc, the tracks remain available through that complete copy.

## Deploying to GitHub Pages

### Current limitation: use local preview for metadata

GitHub Pages serves static files only. It cannot safely add MusicBrainz's required application identification, forward the GetSongBPM API-key header, or work around Discogs' authenticated CORS restrictions. The hosted app therefore remains useful for an already-synced local library, offline browsing, manual entry, microphone analysis and mixing calculations, but **Discogs import and online metadata enrichment should be run locally for now**:

```bash
npm run build
npm run preview
```

Do not place API keys in GitHub Actions variables or bake them into the JavaScript bundle. GetSongBPM and Discogs credentials stay in the user's browser and should pass through a proxy only as request headers.

The app is configured for the project page at `https://mja1337.github.io/cratenav/`. The base path is set in `vite.config.ts`:

```ts
const BASE = '/cratenav/';
```

If you deploy somewhere else, change that constant and the `href` values in `index.html`.

### Automatic deployment

`.github/workflows/deploy.yml` builds and publishes on every push to `main`. Enable it once:

1. Push the repository to GitHub as `cratenav`.
2. Go to **Settings → Pages** and set **Source** to **GitHub Actions**.
3. Push to `main`.

### Manual deployment

```bash
npm run build
```

Then publish the `dist/` directory to the `gh-pages` branch by whatever means you prefer.

### Discogs proxy required for authenticated deployment

Discogs permits some anonymous browser calls but rejects the `Authorization` CORS preflight for release metadata on a static browser origin. The local `npm run preview` server supplies a loopback-only `/api/discogs` proxy; do not expose it to a network interface. A public deployment needs an equivalent server or edge route, which forwards only `GET` requests to Discogs and never logs the personal token. GitHub Pages alone is therefore suitable only for the non-authenticated static shell, not a complete token-backed import workflow.

### Metadata proxy for a hosted enrichment build

The production bundle deliberately does not call these metadata services directly: a browser cannot provide MusicBrainz with the required application User-Agent, and API credentials should not be sent cross-origin. A Cloudflare Worker is a good fit, but it is **not deployed yet**.

The future Worker should expose only read-only `GET` routes matching the local proxy:

| Route | Upstream | Special handling |
|---|---|---|
| `/musicbrainz/*` | `https://musicbrainz.org` | Set cratenav's identifying `User-Agent`; accept the sanitised contact header |
| `/acousticbrainz/*` | `https://acousticbrainz.org` | Public read-only forwarding |
| `/getsongbpm/*` | `https://api.getsong.co` | Forward `X-API-KEY` only to this upstream; never log it |

It should reject non-GET methods, allow CORS only from the cratenav Pages origin, restrict paths and upstream hosts, strip unrelated credentials, preserve rate-limit responses and avoid caching personalised requests. Discogs can be added as a separately reviewed route if hosted authenticated imports are required.

Once deployed:

1. Add the Worker origin, with no trailing slash, as the GitHub repository variable `VITE_METADATA_PROXY_BASE`.
2. Re-run the Pages workflow. The workflow already passes that variable into `npm run build`.
3. Verify `/musicbrainz`, `/acousticbrainz` and `/getsongbpm` from the hosted Analyse screen before treating public enrichment as supported.

Without that variable, the app now explicitly advises running locally while the cached library, manual entry, microphone analysis and all mixing calculations continue to work offline.

## Acknowledgements

Online BPM and key enrichment can use [GetSongBPM](https://getsongbpm.com/). Huge thanks to their team for providing an awesome music-data service and API for projects like cratenav. [Request GetSongBPM API access](https://getsongbpm.com/api).

## Architecture

```
src/
  app/         bootstrap, store, router, shell, service worker
  components/  reusable UI (cover art, badges, key wheel, progress)
  views/       screens
  domain/      the authoritative internal data model
  data/        schema and repositories
  discogs/     API client, response types, mapper, sync orchestration
  harmonic/    Camelot conversion and compatibility scoring
  bpm/         BPM canonicalisation
  pitch/       vinyl pitch maths, deck profiles, playback matching
  bags/        bag lifecycle and coverage analysis
  sets/        set plans and ordered-mode transitions
  recommend/   next-track scoring, native and playback modes
  storage/     IndexedDB wrapper, platform capability abstractions
  enrichment/  matching, resolution, provider runner and public metadata adapters
  analysis/    queue prioritisation; microphone capture, rolling DSP and stability aggregation
  sync/        cloud sync interface (not yet implemented)
```

Two rules hold the design together:

**External shapes never leak inward.** Discogs JSON is confined to `src/discogs/`; everything past the mapper speaks the domain model in `src/domain/types.ts`. Swapping or adding a metadata provider touches one directory.

**Discogs owns catalogue identity; cratenav owns DJ knowledge.** Discogs answers "what do I own?" Everything else — BPM, key, Camelot, confidence, verification, mix notes, transitions, bags, set plans, play history — is ours and is never overwritten by a sync.

Browser APIs are reached through the abstractions in `src/storage/platform.ts` (`device`, `wakeLock`, `files`, `share`) so Capacitor implementations can replace them without touching business logic.

### Provenance, not bare numbers

A BPM is never stored as just `174`. Every value records what the source said, what it was normalised to, why, the confidence, and whether a human has confirmed it. Verification always outranks automation.

Discogs carries no BPM or key data at all, so every imported track legitimately starts in the `ANALYSE` state. You can enter values by hand, run MusicBrainz → AcousticBrainz or optional GetSongBPM lookups, or analyse a nominal-speed record through the microphone. Public results start unverified; a stable microphone result becomes verified only after you explicitly accept it.

### BPM canonicalisation

Metadata sources routinely list drum & bass at half-time (87 instead of 174). The fix is not "double anything under 100" — that would wreck 92 BPM hip-hop. Instead an expected tempo band is derived from the Discogs genre/style, and whichever of `{bpm, bpm×2, bpm÷2}` lands in that band wins. With no usable genre information the value is passed through untouched and flagged low-confidence.

## Testing

```bash
npm test
```

341 tests across 23 files cover the logic that is expensive to get wrong: rolling BPM/key detection and stability policy, Camelot conversion (all 24 wheel positions round-trip), key parsing across the notations providers actually emit, BPM canonicalisation including the restraint cases, multi-record side inference and per-copy availability, conservative enrichment identity matching, confirmed collection departures, background-operation lifetime and pause behavior, source-specific catch-up/recheck behavior, unconfirmed-analysis classification, cross-run provenance/conflict/corroboration, the MusicBrainz → AcousticBrainz and GetSongBPM adapters, credential isolation, provider pacing and failure handling, compatibility scoring, bag coverage and gap detection, set-plan transitions, queue prioritisation, track reconciliation, version-aware backup/restore and every pitch calculation in spec v1.1 §27 — including the reference table, negative pitch, out-of-range detection, custom deck profiles, and the explicit guarantee that canonicalising `87` to `174` produces zero semitones of pitch shift.

Mapper tests run against **real API responses** captured from a working collection, in `tests/fixtures/`. They pin down the cases that break naive mapping: `A`/`AA` white-label sides, nested brackets in mix names (`Re-Rewind ... (Bump 'N' Flex (Sweet 'N' Low Mix))`), per-track artists that differ from the release artist, Discogs' `(2)` duplicate-name suffixes, missing durations, and `heading`/`index` tracklist rows that are not real tracks.

## Your data

Everything lives in this browser. **More → Your data** exports a full JSON backup and imports one back, including replacement sleeves and per-copy missing-disc state. An import **merges by version**: a row is only overwritten when the incoming copy has a higher `version`, so restoring an old backup can never silently destroy newer BPM or key work. The Discogs token, MusicBrainz contact and GetSongBPM key are never included in an export.

Cloud sync, when it arrives, will be for convenience rather than a dependency.
