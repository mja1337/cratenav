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
- Every key shown while analysing carries its Camelot reference alongside the musical name, via
  `formatKeyPair` / `formatKeyNamePair`. The spec §12 notation toggle chooses which one LEADS, never
  whether the other is available: a semitone is seven Camelot steps, so converting in your head
  mid-mix is exactly the arithmetic that goes wrong. This covers the per-window captured samples,
  the diagnostics candidate scores and tonal-section votes, and the Set button — the microphone
  panel used to print musical names only, so the recorded proposal could not be read against a
  sticker or the wheel.
- The recorded result is laid OVER what is already loaded, never merged into it. "Recorded
  (proposed)" / "Saved track" / "Matching database" are three separate rows with their own agreement
  lines, and nothing is written until a Set button is pressed. The agreement comparisons run on
  musical names while the display shows both notations; keep those two concerns separate or a
  notation change silently alters what counts as a match.
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
- An incremental collection sync relies on the client asking for `sort=added&sort_order=desc`, so
  additions are at the top. It stops after the first page that contributes nothing new: once a whole
  page holds no copy we lack, everything older is older still. A count of consecutive known copies
  was tried first and is the wrong shape — the threshold must be smaller than a page to ever fire yet
  larger than any run of known copies among the additions, and those conflict for a small collection
  or a big batch of new records.
- **Only a full pass can see a departure.** An incremental read stops once the additions run out, so
  a record removed from deep in the collection was simply never read — treating its absence as a
  departure would flag most of the library as gone. `fullSyncRecommended` is the escalation signal:
  when Discogs' own item count does not equal what we hold plus what we just added, something we did
  not read has changed. The auto pass then re-reads in full, and forces a full pass weekly regardless.
- An incremental pass must not renumber `copyIndex`. A full read sees every copy so it can number
  from zero; an incremental read may see only the newest copy of a doubled release, so its counters
  are seeded from what is already stored and existing copies keep the number they have.
- An incremental pass does NOT see an edit to an old copy's rating or condition, because that copy is
  never re-read. That is the accepted cost of one request instead of six; the weekly full pass
  catches those up.
- The unattended catch-up chain never applies a departure. It passes `confirmDepartures: () => false`
  so removals are retained and reported, because a record leaving the collection is a user decision
  (see the retention invariant above). It also stands aside for a sync or enrichment the user
  started, refuses inside a 15 minute window, and reads everything the first time because there is
  nothing yet to compare against.
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
- Preserve the visible GetSongBPM credit/backlink in More → About and the README, plus the raw-HTML
  backlinks in `index.html` and `public/getsongbpm.html` for non-JavaScript registration crawlers.
  The public Pages build has no metadata proxy until `VITE_METADATA_PROXY_BASE` points to a restricted
  Worker; never imply hosted enrichment works without it or place a user API key in the build environment.
- One rule decides whether a source candidate is about the track on screen: `sameTrackTitle` in
  `src/enrichment/matching.ts`. An enrichment run stores candidates for every track on the release,
  so track detail showing them all invited a DJ to accept the neighbouring track's BPM. The rule
  compares normalised titles and retries ignoring a trailing bracketed version, because providers
  answer "Title (Original Mix)" where the sleeve says "Title" and treating that as a different track
  hides the only result there is. It is deliberately NOT containment: "Jungle" must not match
  "Jungle Fever". Both the provenance candidate list and the microphone panel's source comparison
  use it, or a source appears in one place and is invisible in the other.
- A candidate review is adjudication of ONE source's claim, so the comment is stored on the
  candidate, never as a loose analysis note: "GetSongBPM has the 12-inch at 174" only means
  something attached to the source it judges.
- Reject is the undo for Approve. Rejecting a candidate must withdraw the value that candidate
  supplied — matched on source AND value, so a hand-entered or microphone-measured figure on the
  other dimension survives. Leaving it produced an analysis reading "verified 174 BPM, source
  AcousticBrainz" directly beside that same source marked rejected. Rejection is also honoured by
  `hasUnconfirmedAnalysis` and `candidateConflicts`, so a dismissed source stops nagging from the
  Analyse queue. The rules live in `src/analysis/candidate-review.ts` as a pure patch builder
  because they are the provenance rules that are easiest to get wrong.
- Concrete enrichment adapters belong only in `src/enrichment/registry.ts`. Views consume provider
  capabilities, never a named adapter. Candidate refreshes must merge with independent prior
  evidence, retain reviewable recording identity, and keep BPM/key confidence separate.
- Every metadata request needs a timeout (`withTimeout`, 15s) and every track a watchdog (60s).
  Nothing in the enrichment layer had either, so one stalled socket left `runEnrichment` pending
  forever: the batch sat on its first row with no progress and no error, which reads as a freeze.
  A timeout must stay distinguishable from a user Stop — the first is a recorded provider failure,
  the second has to propagate and end the loop.
- The dev metadata proxy sets `timeout`/`proxyTimeout` and reports the upstream error as JSON. The
  default is an empty 500, which tells the app nothing.
- A provider response is untrusted data, never what a `as SomeResponse` cast claims. Funnel every
  list field through `asArray`. GetSongBPM answers a miss with `{"search": {"error": "no result"}}`,
  so `?? []` does not fire and the next `.map` throws — which used to stop the whole batch.
- A service saying "no result" is a `none` outcome, not an error. Only a real fault may consume the
  run's error budget, or a normal miss trips the circuit breaker.
- Every provider needs `configured()`. `availableProviders` falls back to "configured" when the
  method is absent, so an unconfigured adapter gets queried and throws on every track.
- Background-operation notices render in the shell, not per view. A `notify()` from a batch must be
  visible on whichever screen the user is standing on, or a stopped run looks like a silent crash.
- An unconfigured provider must not be queried or create a durable attempt. This is what lets adding
  a new provider later requeue only the tracks that source has never checked.
- A normal enrichment run must skip a provider's completed found/none attempt. Source-specific
  catch-up runs query only that new provider; only an explicit Recheck may rerun completed sources.
- Direct browser MusicBrainz calls cannot supply the required application User-Agent. The Analyse UI
  collects a device-local contact which the loopback proxy places in that User-Agent;
  `CRATENAV_CONTACT` is only a fallback. A hosted enrichment build requires
  `VITE_METADATA_PROXY_BASE`. Without one, the provider must remain honestly unavailable while
  offline/manual features continue to work.

## Licensing

- **Essentia.js is AGPL-3.0, and bundling it makes the shipped app AGPL-3.0.** That obligation comes
  from distributing the WASM build to browsers, not from the LICENSE file, so it applies the moment
  the PWA is deployed. `LICENSE`, `THIRD_PARTY_NOTICES.md`, the README licence section and the
  `license` field in `package.json` exist to satisfy it and must stay in step. Removing Essentia is
  the only way back to a permissive licence; UPF also sells a commercial Essentia licence.
- Essentia was the project's FIRST runtime dependency. It arrives as a ~2.5 MB WASM worker chunk and
  took the service-worker precache from 324 KiB to about 2.8 MB, which is why
  `maximumFileSizeToCacheInBytes` had to be raised. Weigh that against a phone on mobile data before
  adding anything else of that size.

## Gotchas hit during the build

- `<img>` served from cache completes before a `load` listener attaches, so `opacity: 0` + reveal-on-load
  leaves covers invisible. `src/components/cover.ts` checks `image.complete` explicitly.
- On desktop the shell is a grid; the header needs its own named row or it auto-places into an
  implicit row below the full-height main column and scrolls off screen.
- `--text-faint` renders at 11px, so it needs full AA contrast (4.5:1), not AA-large.

## Microphone DSP (src/analysis/audio.ts)

- **A chroma must be a MEAN per pitch class, never a sum.** FFT bins are linearly spaced, so bins
  per pitch class climb with frequency (22 for D, 39 for B at 4096/48k). Summing encodes bin
  density, not music: a flat spectrum correlated 0.42 with A# minor, so every key came back as 3A.
- **Whiten before binning.** Subtract a per-window median so broadband noise (cymbals, surface
  noise, room) does not fill every bin.
- **Split each bin across its two nearest semitones by fraction.** Rounding to the nearest semitone
  smears a clean note into its neighbour — C4 straddles bins 44/45 and bin 45 rounds to C#.
- **Measure the tuning, do not assume A440.** A record cut sharp or played off zero pitch puts every
  note between semitones and the chroma smears across both: an A minor chord read as C# minor at 50
  cents of detune. `detectKey` estimates the offset per window as the magnitude-weighted circular
  mean of each peak's distance to its nearest semitone, then corrects. Within ~50 cents it recovers
  the native key; beyond that it reports the nearer semitone, which IS the effective key per v1.1.
- **Harmonic leakage needs a peak-domain defence, never naive chroma subtraction.** A note's 3rd
  harmonic is a fifth above it and its 5th a major third, so one bass note can manufacture a major
  triad. Subtracting a fixed chroma fraction was tried and reverted because it inflated the spread
  statistic and leaked keys out of white noise. The current path rejects FFT skirts with a local
  peak/prominence gate, rejects spectrally flat windows, then folds likely integer harmonics mostly
  toward their lower fundamental while retaining some direct evidence for real chord tones. Keep
  the white-noise and single-bass-note regression tests whenever this changes; a future NNLS chroma
  implementation still needs validation against real source-labelled audio.
- **Never write `sin(2*pi*f(t)*t)` for a vibrato in a test fixture.** Its instantaneous frequency is
  `f(t) + t*f'(t)`, and that second term grows without bound: a "2 cent" wobble becomes a 78 Hz
  sweep by eight seconds, inventing partials the signal never had. Three separate "the detector is
  broken" findings came from that one line — a chroma read as D major, phantom peaks at 146/170/193
  Hz for a 220/262/330 chord, and a 131.6 BPM latch. Accumulate phase instead. Fixtures must also
  never clip (scale the mix, don't limit it) — clipping manufactures intermodulation products. When
  a synthetic result looks like a detector bug, suspect the generator first and verify its spectrum.
- **Tempo: the amplitude envelope cannot separate a kick from a pad.** Sustained partials
  interfering inside one analysis frame modulate total energy with no volume change at all, and a
  pad at a quarter of drum level pulled 140, 160, 174 and 186 BPM onto the same 177.2 reading. The
  `percussive` voter answers this: per-bin spectral flux (SuperFlux, max-filtered across +/-1 bin so
  vibrato and wow do not read as onsets) over a spectrum with a slow per-bin steady FLOOR subtracted.
  The floor must be a slow MINIMUM, not a mean — a mean-follower with a time constant near one beat
  tracked the kick train itself, cancelled every second kick and halved twelve fixtures.
- **Superseded, do not reinstate: replacing the amplitude envelope with spectral flux.** The
  metrical selection is tuned to how the amplitude envelope weights a loud kick against a quiet hat.
  Spectral flux with sqrt compression over-weights broadband hats and doubled 88 and 100; linear
  magnitude over-weights the kick and halved everything above 145. Flux belongs ALONGSIDE the
  amplitude bands as one more vote, never in place of them.
- **Superseded, do not reinstate: choosing the period by best-phase grid alignment.** Autocorrelation
  is phase-blind, so scoring candidates by where a grid at that period lands looks like the missing
  discriminator. It is not: on a kick-every-beat/snare-every-other pattern the two-beat grid has both
  a high hit rate AND most of the onset energy, so hit x coverage prefers it and 128, 133, 145 and
  150 all halved. The ambiguity is real in the signal and no phase statistic resolves it.
- **KNOWN LIMIT: a sustained chord with no percussion at all still reports a tempo** (an A minor pad
  alone reads 177.2 BPM). Enough interference survives into the flux envelope that the percussive
  voter cannot veto it. Left alone deliberately: a DJ analyses records that have drums, and the
  realistic case of a pad OVER a break is covered by tests.
- **Key profiles are Temperley's, not Krumhansl-Kessler.** Both name an ideal minor triad correctly;
  the difference is on ambiguous input. On a power chord with no third, Krumhansl's major wins
  outright — a confident answer to an open question — while Temperley's modes score close enough for
  the `mode` guard to refuse. Both sets stay exported so the choice is settled by test, not asserted.
- **Register evidence breaks a relative-key tie; it must not be another term in the score.** A minor
  key and its relative major share all seven notes, so they sit a whisker apart in profile
  correlation whatever the material, and the bass is what is qualified to separate them. Adding bass
  support into the score would inflate every candidate and quietly loosen the acceptance thresholds
  that stop noise, so it is a bounded decision among candidates already within 0.05 of the leader.
- **Reordering candidates without reordering the margin is what makes this go wrong.** Promoting a
  lower-scoring candidate while still computing `best.score - rival.score` yields a NEGATIVE tonic
  margin, so the guard refuses the decision the re-rank just made — a real recording reported
  "tonic -0.04 / 0.03" and declined a key it had identified. Skipping any rival the bass contradicted
  then left some voicings with no rival at all, collapsing the margin to `best.score - 0`, which
  passes trivially and disables the guard instead. Both failure modes came from one error, so:
  the re-rank fires only when register evidence is DECISIVE (0.25) and the tie is at most three-way,
  and when it fires the margin is measured from the tie group's top score against the best candidate
  OUTSIDE the group. When it does not fire, the margin is exactly what it was before register
  evidence existed. `tests/audio-dsp.test.ts` pins that the margin is never negative.
- **Register evidence must be able to CONFIRM the leader, not only promote a rival.** The decisive
  gap is between the register evidence's first and second choice, never between it and the profile
  leader: measured against the leader, a bass that already agreed produced a gap of zero, nothing was
  decided, and the near-tied rival still vetoed it — an A in the bass under a C-E-G triad refused at
  a tonic margin of 0.003.
- **A relative pair is an AGREEMENT about the notes, not a disagreement.** B major and G# minor hold
  the same seven notes and differ only over which is the tonic, so reporting "engines differ" hid
  that the two key engines agreed about the music entirely. `compareKeyEstimates` in
  `src/analysis/key-agreement.ts` classifies `same` / `relative` / `different` and counts shared
  notes, and the UI says which it is.
- **When two candidate keys differ by one note, that note IS the answer.** B major against E major
  turns entirely on A# versus A natural, so `discriminatingNotes` reports the separating notes with
  the energy each actually has in the chroma. This is the measurement that settles a three-way
  argument between two engines and an online source; everything else is inference.
- **Neither key engine gets unconditional precedence.** Essentia used to win whenever it returned
  anything, so on a real recording B major was reported on every window while the custom engine said
  G# minor at HIGHER confidence — the precedence rule was silently deciding the tonic. Order now:
  whichever engine answered if only one did; on the same key or a genuinely different note set the
  higher confidence, with `unresolved` set for the latter; and for a relative pair the BASS decides
  the tonic, because that is the only evidence qualified to separate keys that share every note.
  Confidence is a last resort throughout, since the two engines' confidence figures measure
  different things and are only loosely comparable.
- **Refuse to answer.** A near-flat chroma (spread < 0.18) or a low correlation means no key.
  Garbage at high confidence is worse than an honest absence; white noise must return nothing.
- **The beat is an integer SUBDIVISION of the dominant periodicity.** Every statistic computed only
  inside the 60-210 BPM window proved defeatable, because the strongest periodicity is the BAR and it
  usually sits outside that window. Measured on a dense 176 BPM break: bar 0.781, dotted note 0.477,
  beat 0.253. Ranking candidates on their own strength picks the dotted note; ranking on a
  floor-relative average picks two beats (the bar inflates it); a minimum across multiples collapses
  entirely once 16th hats raise the floor to ~0.21, so every candidate returns that floor and the
  RANGE BOUNDARY wins — a 176 record reported 210.3, which is just the 210 BPM search limit.
  Take the argmax over the whole computed range, divide by 1..8, keep divisors that actually
  correlate, and prefer the faster among comparable ones. A dotted note and the boundary are
  excluded by construction because they do not divide the dominant period evenly.
- The faster-reading tolerance is deliberately wide (0.9): a kick/snare alternation genuinely repeats
  every two beats, so that period is real and a strict window halves the tempo at 190-200 BPM.
- **Superseded, do not reinstate: the period whose WEAKEST multiple is supported.** Averaging multiples cannot
  separate a beat from a dotted note, and taking the strongest peak is worse: for a periodic signal
  every multiple ties, so "the dominant period" is arbitrary. Measured on a 172 BPM two-step break,
  the bar (523 frames) correlated at 0.832 while inside the 60-210 BPM range a dotted note (196,
  0.497) outranked the real beat (131, 0.329) — reporting 114.8, exactly two thirds. The minimum
  across multiples is decisive because a dotted note always has one falling between beats.
- **Compute the autocorrelation well past the slowest candidate** (4x maxLag). At 172 BPM only two
  multiples fit inside the tempo range, which is too little support to judge.
- **Probe multiples with proportional tolerance and snap the result to the true peak.** Accepting
  candidates through a tolerance without refining left every reading ~0.7% fast.
- **Guard the eighth-note case.** At slow tempos the offbeat falls inside the range (eighths of 88
  land on 176). Where doubling the period correlates clearly better, the faster reading was a
  subdivision.
- **Calibrate confidence against real material, not metronomes.** Absolute correlation near 1.0 only
  happens for a click track; a correct reading on a break sits near 0.3, and scaling straight off it
  reported right answers at 0.10.
- **The tempo is the SMALLEST strong lag, not the strongest.** Autocorrelation is ~1.0 at every
  multiple of the true period, so the global maximum is often two or four beats. A comb sum does not
  help: every sub-multiple of a periodic signal scores alike.
- **Onset envelope resolution is load-bearing.** At hop 256 the fundamental lost most of its
  correlation whenever a beat did not land near a whole frame — at 186 BPM the true lag scored 0.71
  while two beats scored 0.96, so half tempo won on arithmetic. Hop 128 plus light 3-tap smoothing
  fixes it; interpolate the autocorrelation at fractional lags.
- **Peakiness guard.** Require the chosen peak to sit ~0.15 above the median autocorrelation, or
  noise gets reported as a tempo.
- Both detectors are pinned by `tests/audio-dsp.test.ts` against synthetic signals with known
  answers, including the 168-186 BPM band and a noise-returns-nothing case.
- **Do not set detection thresholds from synthetic signals.** The first key thresholds were tuned
  against clean triads correlating above 0.78 and rejected real mic material outright, leaving the
  UI stuck on "waiting for signal". `KEY_THRESHOLDS` is now central and `detectKey` always returns
  `keyDiagnostics` (chroma, spread, best, margin, which guard rejected) so a threshold can be judged
  against reality instead of guessed at. The spread and margin checks are what stop noise, not a
  high correlation bar — noise rejection is pinned by tests at the loosened values.
- **Expose input metering separately from detection.** Because the detectors refuse to answer on a
  weak signal, the UI cannot otherwise distinguish "no audio is arriving" from "audio is fine but
  nothing is confident yet" — and both look like a hang. `Analyser.input()` reports receiving/RMS/
  peak/waveform plus seconds until the first reading, and the panel drives its own 120ms tick
  because detection frames only land every 2s.
- The captured samples are the evidence, not a diagnostic. Each analysis window's own BPM and key
  reading is listed on screen ahead of the aggregated score, so a DJ can see WHY the rolling vote
  landed where it did. It must not sit behind the "Show all data points and correlations" toggle:
  hidden, the final number is an assertion with nothing behind it. Collapsed the list shows the
  latest few and states the true total, for the same reason the analysis queue does.
- Grid cells in a captured-sample row are addressed by CLASS, never by position. A fourth cell added
  to a three-column grid auto-placed into an implicit column with no width, so a long string wrapped
  one character per line and every row became about twenty lines tall. A `> :last-child` rule had the
  same fragility. Adding a cell must not be able to do that again.
- Two key engines are compared on ALIGNED LINES, one per engine, with the timing in its own column
  and the taken answer marked "used". Run into a single string — "E 10B · D major · 69% · 37 ms · C
  6A · G minor · 78% · 261 ms · differ" — both engines were mentioned and neither could be compared,
  which is the whole point of running them side by side.
- The saving wheel spins the ring; its label must counter-rotate or the wheel spins its own text
  illegible.
- Enrichment outcomes are durable per provider per track, so a release or track can always show what
  each source said — found / no data / error, with the error text. A run that leaves no visible trace
  is indistinguishable from one that never happened.

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
