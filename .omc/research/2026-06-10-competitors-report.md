# Competitor Mechanics Research Report
*Proven, shipped behaviors only. Items I could not confirm from sources are marked UNCERTAIN.*

---

## 1. Timebolt (desktop, exports XML to Premiere)

### Silence detection parameters (official help docs)
| Parameter | Default / Recommended | Range / Notes |
|---|---|---|
| **Filter Below Sound Level** (threshold) | test between **−30 dB and −45 dB** | More negative = keeps more audio as "speech". Audio below threshold shows **red** (cut), above shows **green** (keep) |
| **Remove Silences Longer Than** | **≥ 0.5 s** recommended; **0.75 s+** for fewer cuts | Below 0.5 s "creates too many cuts" — their main anti-choppiness lever |
| **Ignore Detections Shorter Than** | — | Removes mic strikes / blips; **never set above 0.75 s** or it "may cut off important connector words" |
| **Left Padding** | **0.09 s** default; can go as low as **0.01 s, never less** | Buffer before speech onset — can be aggressive because attack is well-defined |
| **Right Padding** | **0.15 s** default; **never below 0.15 s** | Catches trailing S/P sibilants — this asymmetry (right > left) is their stated key to non-choppy audio |
| Preprocessing toggles | off | Audio Normalization, Noise Reduction, Volume Increase — improve detection on quiet audio; requires app restart |

Changing values requires clicking **"Update Silence Detection"** (explicit recompute, not live).

### Anti-choppiness approach
Not crossfades — **asymmetric padding** (0.09 left / 0.15 right) plus a minimum-silence floor of 0.5 s. No crossfade parameters documented.

### Preview UX (their strongest pattern)
- **Skip-silence playback**: spacebar plays the timeline *as if cuts were applied*; color-coded waveform: **Red = Cut, Green = Keep, Orange = FastForward**.
- Review at speed: press **L** repeatedly up to 4×.
- **USOB hotkeys during playback** (review without stopping): **U** = rewind a few cuts, **S** = split at playhead, **O** = toggle a section on/off ("A/B testing" a cut without deleting), **B** = backcut (delete what you just heard, mid-playback).
- **Flip Timeline Selection** — preview *only the material being removed* (audit what you're about to lose).
- For retakes: **H (Hold)** marks the best take, **Shift+B** cuts back to it.

### Punch-in zoom
- **P key** cycles **125% → 150% → 175%** (3rd press resets); custom percentages in Settings; **Alt/Cmd + arrows** select the zoom region; right-click menu alternative.

### Other shipped mechanics
- **FastForward** instead of delete: speed-ramp silence at 0.5–4×, with automation rules "FastForward cuts longer than 10 s" / "shorter than 2 s", optional mute.
- **UMCheck** filler/retake detection via AWS Transcribe, $0.03/min, customizable filler list, "Run Retake Detection" toggle, 100+ languages.
- Exports: XML (Premiere/Resolve), FCPXML with drag handles, multicam FCPXML, Camtasia, direct MP4.

**Sources:** [Silence Detection — TimeBolt Help](https://help.timebolt.io/timebolt-basics/silence-detection), [Punch — TimeBolt Help](https://help.timebolt.io/feature-guide/punch), [TimeBolt Features](https://www.timebolt.io/features), [Timebolt review](https://ninefivetofreedom.com/timebolt-review/), [TimeBolt FAQs](https://www.timebolt.io/faqs)

---

## 2. Recut (Mac/Windows desktop)

### Parameters (official guide)
| Parameter | Default / Recommended | Notes |
|---|---|---|
| **Threshold** | "Auto" option | **0–1 normalized scale** (not dB) with an **Auto analyzer that suggests a value per recording** — notable design choice |
| **Minimum Duration** (s) | match the pause length you want to keep (e.g. 1 s) | Silence shorter than this is left in |
| **Padding** | **0.4–0.5 s "sounds pretty natural"**; 0 = "fast-talker radio ad" effect | Single padding value (not split left/right) |
| **Remove Blips** | 0 (off) | Cuts *audible* clips shorter than cutoff — inverse of silence removal; kills coughs/mic bumps between sentences |

### "Tightness single slider"
**UNCERTAIN / likely misattributed.** Neither Recut's docs nor homepage show a single "tightness" slider — Recut ships **four separate sliders** plus auto-threshold. A "Cutting Tightness" single control (Loose→Tight) **does ship in FireCut's Basic mode** (see §4), and a similar "Intensity" control (with a "Super" tightest setting) appears in third-party tools. If you want the one-slider pattern, FireCut Basic mode is the proven reference: one slider, with an "Advanced" escape hatch exposing real parameters.

### Preview UX
- **"Preview without silence" checkbox** — toggles playback between original and edited result before export. Live re-detection as sliders move.
- Exports: Premiere XML, Resolve, FCPX, ScreenFlow, CapCut, MP4/WAV/M4A. $129 one-time or $15/mo.

**Sources:** [How to Remove Silence from a Video Automatically — Recut](https://getrecut.com/remove-silence-from-video-automatically/), [Recut homepage](https://getrecut.com/), [Recut in DaVinci Resolve — Alli and Will](https://www.alliandwill.com/blog/editfasterdavinciresolverecut)

---

## 3. Descript

### Filler word list (17 words/phrases, from their blog)
`um, uh, like, you know, I mean, well, sort of, kind of, I guess, I suppose, or something, hm, mmm, right, so, but you know, you know what I mean`

### Detection & UX mechanics
- Fillers are **highlighted in light blue in the transcript** at transcription time — passive surfacing before any action.
- **One-click flow**: AI Tools panel → "Remove filler words" → sidebar lists **all detected instances with timestamps**; user can preview each one, then remove all or per-item.
- **Four per-word actions** (this granularity is the key shipped mechanic):
  1. **Delete** (removes from audio + text)
  2. **Delete with gap** (removes audio, preserves timing — silence remains)
  3. **Ignore** (strikethrough in text only, audio untouched)
  4. **Remove from transcript only**
- **"Avoid harsh cuts" option**: Descript analyzes surrounding audio and **automatically skips fillers that can't be removed without clipping into neighboring words** or leaving an awkward edit. This is their accuracy story — refusing risky cuts rather than making them.
- Context handling: "um/uh" are treated as always-safe; their own editorial guidance warns that removing "like / you know / so" wholesale "can sound unnatural" and ruins conversational/comedic timing — the product handles this by making everything reviewable rather than auto-classifying. Numeric confidence scores in the UI: **UNCERTAIN** (not documented).

### Studio Sound
- AI voice isolation: removes noise + room echo, smooths levels across speakers.
- **One parameter: Intensity slider, default 100%**. Their own guidance: dial down ~10% at a time until voice stops sounding over-processed. (Pattern: single 0–100 strength knob on a heavy DSP effect.)
- Recommended order of operations: filler removal first, Studio Sound after.

**Sources:** [Filler Word Removal — Descript](https://www.descript.com/filler-words), [How to remove filler words but know which to keep — Descript blog](https://www.descript.com/blog/article/how-to-remove-filler-words-but-know-which-to-keep), [Filler words — Descript Help](https://help.descript.com/hc/en-us/articles/10164806394509-Filler-words), [Studio Sound — Descript Help](https://help.descript.com/hc/en-us/articles/10327603613837-Studio-Sound), [Sound Good with AI Tools](https://help.descript.com/hc/en-us/articles/21908864772493-Sound-Good-Actions)

---

## 4. FireCut (CEP/Premiere — your closest competitor)

### Silence removal
| Parameter | Default | Notes |
|---|---|---|
| **Silence Threshold** | **−30 dBFS** | Auto-detection available |
| **Minimum Silence Duration** | **750 ms** | Going below "not recommended" |
| **Padding start / end** | **250 ms each** | Adjustable **per individual silence** in Advanced mode |
| **J-cut Offset** | **0 frames** | Raise above 0 to auto-create J-cuts at every silence cut — shipped audio-smoothness feature |
| **Cutting Tightness** | Loose ↔ Tight | **Basic mode's single slider** (maps onto threshold/duration/padding internally — exact mapping UNCERTAIN) |
| **Guidance audio tracks** | user-selected | Cut only where **all** guidance tracks are silent — essential for multitrack podcasts |
| **Scope** | full sequence | Or In/Out points (`I`/`O` hotkeys — consistent across all FireCut features) |

**Review-before-apply (Advanced mode), 3 steps:** detect → **review silences in a list** (click any item to highlight it on the Premiere timeline; X to remove items; adjust padding per item) → execute cuts.

**Processing time UX:** three user-selectable algorithms with explicit guidance — **Original** (<10 min / <50 silences), **Rapid** (10–30 min / 50–100), **Turbo** (30+ min / 100+ silences; recommended at 200+ because per-clip Premiere operations "slow down over time"). They expose the algorithm choice rather than hiding the perf problem — direct lesson for CEP/ExtendScript batching.

### Filler words
- Tracks-to-listen selection + scope. Review options: **(a)** show fillers in transcript context with **right-click select/deselect for deletion**, or **(b)** **only place sequence markers** at filler locations for later manual checking. The markers-only mode is the cheapest "review before apply" pattern shipped in a Premiere extension.

### Zoom cuts
- AI picks "key moments"; zooms placed on a **new track as Adjustment Layers** (non-destructive, trivially deletable — their review/undo answer).
- **Frequency**: Low ≈ 1 zoom/min, Default ≈ 2–4/min, High ≈ 7/min.
- **Scale**: 100 = none, 200 = 2×, **recommended start 120**.
- **Animated zooms** (keyframes over **0.2–0.5 s**, middle easing default) or **cut zooms** (instant).

### Chapters
- LLM analyzes transcript for topic transitions. Output: **YouTube-timestamp text block + timeline markers + optional motion-graphics title clips on a new track**.
- **Editable topic list before generation** (rename/add/delete chapters).
- Stated processing cost: **~2 min per 10 min of sequence**; recommend sequences <20 min, run near final cut.

### Repetition / bad-take removal
- Transcript-based: detects **consecutive repeated phrases only** (takes recorded back-to-back; a retake 5 minutes later is NOT found — documented limitation).
- Advanced params: **Minimum phrase size** (words), **Tolerance 0–80%** (0 = exact match; fuzzy text similarity), **Search radius**, **"Extend last occurrence"** (to end of sentence / longest take / phrase size).
- Review UX: list of take-groups → click a take to **mark its boundaries on the timeline** → verify → **tick button keeps that take and deletes the rest**.
- Accuracy preconditions they document: loud clear voice, music/SFX muted, single speaker.

### Captions
- 50+ languages; standard generate flow. (Detailed caption params not researched in depth.)

**Sources:** [Remove silences — FireCut docs](https://learn.firecut.ai/features/remove-silences), [Remove filler words — FireCut docs](https://learn.firecut.ai/features/remove-filler-words), [Add zooms — FireCut docs](https://learn.firecut.ai/features/add-zooms), [Detect chapters — FireCut docs](https://learn.firecut.ai/features/detect-chapters), [Remove repetition — FireCut docs](https://learn.firecut.ai/features/remove-repetition), [firecut.ai](https://firecut.ai/), [Premiere Gal review](https://premieregal.com/blog/2024/1/5/firecut-ai-for-premiere-pro-unmasking-the-editing-magic)

---

## 5. Gling.ai / Wisecut / AutoCut

### Gling.ai
- Pipeline: upload → **transcribe → analyze text + waveform** → color-coded timeline of silences / fillers / suspected bad takes → user **accepts/rejects each suggestion**.
- Bad takes: "speech pattern analysis" for stumbles/repeats/restarts; handles phrase-level fillers like "so as I was saying". Exact algorithm (text similarity vs. acoustic) **UNCERTAIN** — marketing only; third-party reviews describe transcript+NLP analysis. Industry consensus (FireCut docs confirm for themselves) is **fuzzy text matching over transcript with a tolerance knob** — safe to assume the same class of approach.
- Review = **transcript editing** (delete text → video follows) like Descript, plus visual timeline.
- Export: MP4/MP3, **XML to Premiere/FCP/Resolve**, SRT. No user-facing detection parameters documented (zero-knobs philosophy).

### Wisecut
- **Auto punch-in/out**: facial-recognition-driven automatic zoom alternation on cuts (their answer to jump-cut visual monotony).
- **Auto background music + ducking**: picks royalty-free track, **lowers music when speech is detected, raises it during non-speech** — fully automatic sidechain-style ducking. Specific dB/attack/release values **UNCERTAIN** (help page 404'd).
- Silence cutting is automatic; review via storyboard-style editor. Parameter details **UNCERTAIN**.

### AutoCut (Premiere/Resolve plugin — direct competitor in your host app)
| Parameter | Notes |
|---|---|
| **Noise Level (dB)** | silence threshold; **AI auto-set available**; guidance: "set just above the noise you hear between phrases" |
| **Remove silences longer than** | e.g. 0.5 s |
| **Keep talks longer than** (min speech duration) | protects breaths/short words from being treated as blips |
| **Padding before / after** (ms) | recommended total spacing **0.3–0.5 s** for natural speech |
| **Pacing presets** | **Calm / Measured / Paced** + manual — preset-bundles over raw params |
| **Silence handling modes** | **Remove / Keep (detect only) / Mute audio only / Remove but keep spaces** (cut audio, preserve clip timing) |
| **Audio transitions** | **None (default) / J-Cut / L-Cut / J&L / Constant Power** ("recommended for speech") — shipped crossfade answer to choppy cuts |

**Preview UX:** in-panel Sequence Preview with **red = will be removed, dark green = retained pauses, light green = padding**; docs insist "always preview before applying."

**Sources:** [Gling — Save time](https://www.gling.ai/save-time), [Gling Silence Remover](https://www.gling.ai/silence-remover), [Gling review — max-productive.ai](https://max-productive.ai/ai-tools/gling/), [Wisecut](https://www.wisecut.ai/), [Wisecut review — sendshort.ai](https://sendshort.ai/guides/wisecut-review/), [AutoCut silences parameters](https://www.autocut.com/en/blogs/autocut-silences-parameters/), [AutoCut Silences](https://www.autocut.com/en/autocutsilences/)

---

## 6. ETA / progress UX for long AI operations

Confirmed shipped patterns:
- **Elapsed timer, not estimate, for LLM "thinking"**: ChatGPT o-series and Claude show a live counter then collapse to **"Thought for N seconds"** with an expandable reasoning summary. Claude Code/Cursor stream named actions ("Searching…", "Reading file…") as they happen.
- **Never a percentage bar for inference**: "there is no progress to report and a fake one breaks trust the moment the user notices" ([Setproduct](https://www.setproduct.com/blog/ai-chat-interface-ui-design)). The shipped substitute = animated icon + **honest dynamic stage label** ("Thinking", "Transcribing", not "Working on it") + elapsed counter.
- **Stage-based progress** beats spinners: decompose into named stages ("Reading structure → Extracting → Generating"); "each stage resets the user's patience clock" ([Particula](https://particula.tech/blog/long-running-ai-tasks-user-interface-patterns)).
- **Time ranges over precision** when you do estimate: "Typically takes 30–60 seconds" — conservative first, refine upward; early completion delights, overrun destroys trust.
- **Escalation timeline** (Particula): 5–15 s → stage indicator + activity text; 15–30 s → offer "continue in background"; 60 s+ → proactively push background mode + notify-on-done; 2–3 min+ → a blocking wait screen is "counterproductive."
- **Anti-pattern**: static "Processing…" for 30 s reads as frozen — "silence suggests failure."
- For your case (30 s+ LLM thinking inside a CEP panel): the proven combo is **elapsed timer + rotating honest stage labels + streamed partial results where possible + "usually takes X–Y" range learned from your own telemetry**. FireCut's analogous move is exposing the Original/Rapid/Turbo algorithm choice with explicit duration guidance instead of hiding latency.

**Sources:** [Designing AI chat interfaces — Setproduct](https://www.setproduct.com/blog/ai-chat-interface-ui-design), [Long-Running AI Tasks in UIs — Particula](https://particula.tech/blog/long-running-ai-tasks-user-interface-patterns), [How AI models show their reasoning — Digestible UX](https://www.digestibleux.com/p/how-ai-models-show-their-reasoning), [Think-Time UX — UX Tigers](https://www.uxtigers.com/post/think-time-ux), [Loading UI/UX Patterns for AI Apps — Telerik](https://www.telerik.com/blogs/loading-ui-ux-patterns-ai-applications)

---

## Top 10 adoptable mechanics (ranked by impact on accuracy/speed)

1. **Asymmetric padding with hard floors** (Timebolt: left 0.09 s/min 0.01, right 0.15 s minimum to protect sibilants; FireCut: 250/250 ms; AutoCut: 0.3–0.5 s total). The single biggest determinant of "doesn't sound choppy." Ship asymmetric defaults, clamp right padding ≥ 0.15 s.
2. **Skip-silence preview playback before applying** (Timebolt spacebar + Recut "Preview without silence" checkbox). Users audit the result in real time at 1.5–4×; near-zero implementation cost in a panel that controls the Premiere playhead (play, skip playhead over cut ranges).
3. **Review list ↔ timeline linking** (FireCut Advanced mode): detected silences/fillers/takes in a panel list; clicking an item moves the Premiere playhead/markers to it; X removes it; per-item padding override; then one "Apply" button. The canonical review-before-apply pattern in your exact host environment.
4. **"Avoid harsh cuts" guard** (Descript): before deleting a filler, check transcript word-boundary gaps / audio around it and **skip removals that would clip adjacent words**. Refusing unsafe cuts is the cheapest accuracy win for filler removal.
5. **Basic/Advanced dual mode with one "Tightness" slider** (FireCut): single Loose↔Tight slider that internally drives threshold + min-duration + padding, with Advanced exposing real params. Also AutoCut's named presets (Calm/Measured/Paced). Note: the one-slider idea is FireCut's, not Recut's (Recut ships 4 sliders + auto-threshold).
6. **Markers-only output mode** (FireCut filler words; also AutoCut "Keep silences" detect-only mode): every destructive feature gets a non-destructive sibling — "just drop sequence markers where I would cut." Builds trust, costs almost nothing, and works around ExtendScript performance limits.
7. **Consecutive-take detection via fuzzy transcript matching with explicit knobs** (FireCut: min phrase size, tolerance 0–80%, search radius, "extend to end of sentence"; constraint: consecutive takes only). Honest scoping + tick-to-keep-best-take UX. Don't promise global retake detection — nobody ships it.
8. **Elapsed timer + honest stage labels for LLM thinking** (ChatGPT/Claude pattern + Particula escalation): counter from 0, stages like "Transcribing → Analyzing pauses → Building cut list", "usually 30–60 s" range from telemetry, background-mode offer after ~30 s. Never a fake percent bar.
9. **J-cut offset + Constant Power transition options on silence cuts** (FireCut J-cut offset in frames, default 0; AutoCut None/J/L/J&L/Constant Power). Audio crossfade options are the proven fix for audible cut seams in Premiere specifically.
10. **Auto-threshold from audio analysis** (Recut "Auto", FireCut auto-detect, AutoCut AI noise-level) + **zooms on adjustment layers on a separate track** (FireCut: low/default/high ≈ 1 / 2–4 / 7 zooms per min, scale start 120, animate 0.2–0.5 s). Auto-threshold removes the #1 user mistake (wrong dB floor); adjustment-layer zooms make the feature fully reversible by deleting one track.

All sources are linked inline in each section above.