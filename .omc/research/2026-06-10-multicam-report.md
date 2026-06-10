# Auto-Multicam in Shipped Products — Research Report

Research method: web search + fetching vendor docs, including full-text extraction of the official **DaVinci Resolve 20 New Features Guide PDF** (pp. 51–54) and the **Roland VR-50HD MK II Reference Manual PDF** (p. 44) — those two are primary-source parameter tables. No files in your repo were modified.

---

## 1. AutoPod (autopod.fm) — Premiere CEP, industry standard

**Mechanics (confirmed):** per-mic audio-level detection, "one mic = one angle" mapping. Marketing claims it was "based on thousands of hours of podcast footage to edit like a conventional human editor," but competitor teardowns and user complaints agree the core is volume-based per-track detection, not semantic/AV analysis.

**Multi-Camera Editor setup/settings (names as discoverable; exact defaults are NOT public — docs.autopod.fm is unreachable/not indexed):**
- Up to **10 cameras and 10 microphones**; supports **solo shots, two shots, three shots, four shots, and wide shots** (multiple speakers on one camera = you tag that video track with multiple speaker names).
- Speaker count + camera count entered explicitly; speakers named and mapped to audio tracks **starting at A1**; each video track tagged with the speaker name(s) **starting at V1**.
- **Cut method**: `Standard` (razor cuts across stacked tracks), `Multi-Cam` (Premiere multicam clip), `Enable/Disable` (razor + clip-disable — *identical to your implementation*).
- **Shot frequency** and **Multi-Shot Frequency** ("determines the frequency of using total/group shots") — relative frequency knobs, no published units.
- **Wide shot frequency / number of wide shots** — adjustable; presets saveable.
- **Jump Cut Editor** (separate tool): per-mic **decibel cutoff** (reviewers show values like −45 dB; guidance "20–60 dB" range depending on mics), removes sections below threshold.
- **Social Clip Creator**: 1920×1080 / 1080×1350 / 1080×1920, auto-resequence + auto-reframe, watermark/endpage, batch export.

**Failure modes reported by users/competitors:**
- "**Isn't smart** — cuts on volume only; switches to someone who sneezed or laughed loudly" (the #1 complaint).
- Inconsistent cuts in simple layouts (1 camera + 2 lavs); logic breaks whenever "one mic = one angle" math breaks (heavy bleed, shared mics).
- Hard-coded destructive cuts on tracks; once flattened, re-switching is limited.
- Black-box pacing — no min/max shot duration control exposed (the gap Wraith/AutoCut advertise against).
- Positive consensus: "rough cut 90% done," saves ~2h/episode.

## 2. NLE built-ins

**Premiere Pro:** **no native audio-driven auto multicam exists** (as of mid-2026). Native multicam uses audio only for *sync*; switching is manual; "Audio follows video" only switches which *audio* plays when you cut. Everything automatic is third-party (AutoPod, AutoCut, Wraith, Premiere Assistant). Your feature competes with plugins, not with Adobe.

**Final Cut Pro 11:** same — audio used for sync only ("Use Audio for Synchronization"); no audio-based auto angle switching. FCP lets you cut video and audio independently (J/L cuts via separate audio/video switching), nothing automatic.

**DaVinci Resolve 20 Studio — Multicam SmartSwitch** (the most fully documented shipped competitor; quotes from the official New Features Guide):
- Mechanism: "analyzes all multicam camera angles and automatically cut to the most appropriate angle, based on who is the active speaker... doesn't just use the audio track... but includes other video related traits, such as **lip movement in the frame, and if the shot is a wide or close up**, which it can automatically detect. Trained on thousands of hours of multicam footage."
- **Angle Switching:**
  - **Minimum Edit Duration** — "regardless of what happens in the cut, SmartSwitch won't change angles before the end of this duration." (Tutorials show **1.5 s** — same as your minHold.)
  - **Edit Change Delay** — "the amount of time **between the person speaking and the edit changing**." (Tutorials show **0.3 s**.) Note direction: the cut lands *after* speech onset, not before.
- **Wide Angle Setup:** "Just like a technical director, SmartSwitch will tend to use wide angles to cover things like **people talking over each other and silences**":
  - **Automatically detect wide angles** (checkbox) / **Wide Angle** (manual pick)
  - **Wide Angle Frequency**: Low / Medium / High
  - **Use wide angle for intro and outro** (checkbox)
  - **Use wide angle for silence** (checkbox)
- **SmartSwitch Setup:** **Switch**: Video Only vs Video+Audio; **Quality**: Faster/Better; **Use Audio Only Fast Analysis** (audio-only mode, much faster).
- Output is a cut-up multicam clip; fixes via "Switch Multicam Clip Angle" context menu.
- Reported failures (BMD forum): needs proper multicam clip with per-angle audio; analysis slow on long clips.

## 3. Other shipped tools

**AutoCut Podcast (autocut.com, Premiere + Resolve)** — best-documented parameter set among plugins (help-center pages):
- Speakers: unlimited participants, each assigned an audio track; **Speaker Priority: Normal / High / Very High**.
- Cameras: participants→video tracks; **multiple participants per camera allowed** (two-shots/wides); every participant must have ≥1 camera; "create a wide shot from close-ups" article exists.
- **Reaction Shots** toggle: "AutoCut will occasionally show participants who are not speaking, or a wide shot."
- **Shot Duration presets: Calm / Paced / Energetic / Hyperactive**, plus explicit **Minimum Duration (s)** ("prevents overly rapid switching") and **Maximum Duration (s)** ("limits single camera duration", advertised as "set a short max for dynamic cuts").
- **Unused clips: Disable (recommended) / Delete** — again your razor+disable pattern is the shipped norm.
- Output optionally grouped into a native Premiere multicam sequence (default on).
- Requires ≥2 separate mic tracks. Silence tool (separate): **Noise level (dB)** + **remove silences longer than X s** (e.g. 0.5 s).

**Wraith Multi-Cam Editor (Phantom Editor, Premiere)**:
- Up to 8 angles; map solo/two/three-shots/wides; "keep wide shots for group reactions."
- **Min/max shot duration**, **per-speaker shot-length preferences**, **Variation slider** (randomizes spacing between cuts), **Audio Sensitivity slider** with documented semantics: "High sensitivity (e.g. **−40 dB**) reacts to small audio changes... Low sensitivity (e.g. **−20 dB**) ignores background noise/pops."
- Markets itself explicitly on AutoPod's failure modes: "not just audio volume thresholds," "handles overlapping speakers more reliably."

**Descript Automatic Multicam**: transcript-driven (Descript has per-speaker tracks + transcription from its Rooms recorder). Two modes: **Automatic** (active speaker during normal exchange, **group/multibox layout during rapid back-and-forth**, **cutaways/reaction shots when someone talks for an extended period**) and **Active Speaker** (always the talker). Creates a new scene per speaker change.

**Eddie AI (heyeddie.ai)**: up to 6 cameras; waveform sync; chooses angle "based on who is speaking" using **audio + video analysis including motion detection**; exports XML to Premiere/Resolve/FCP.

**Premiere Assistant (cutback.video)**: claims **word-level speech detection** and context-aware switching that tolerates mixed/bled audio (no parameter docs found).

**vlogmi / Edit Murf**: **NOT FOUND** — no shipped products under these names discoverable; likely defunct or misremembered names.

## 4. Broadcast/live auto-switching (proven real-time heuristics)

**Roland VR-50HD MK II "Video Follows Audio"** (reference manual, exact table):
- **Threshold** per mic: range **−50…0 dB, default −16 dB** — "when audio that exceeds this threshold is detected, the video is switched."
- **Target** per mic → video input (or STILL).
- **Mix**: "the video that is output **when audio is detected in multiple mics**. If OFF, video is switched in the order in which audio is detected." → dedicated *group shot on overlap*, shipped in hardware.
- **Silent**: "the video output **when there is no audio input from any mic**. If OFF, the **last-selected video continues**." → wide-on-silence OR hold-last, user's choice.
- **Time**: range **0–30.0 s** — "the time after the video has switched **until audio detection resumes**" (a post-cut re-arm/lockout = min-hold implemented on the detector side). Default appears to be ~4.0 s (PDF extraction ambiguous — UNCERTAIN).

**LiveCUT (vMix add-on)**: per-mic **Sound Threshold (dB)**, timing chain **Pre-Attack / Attack / Pre-Release / Release**, **Min/Max Time** per camera, **Automatic Level Adjustment**, 3 main + 3 auxiliary cameras with priorities, auto-fallback to manual when operator switches. (Defaults not published.)

**Virtual Video Director (vvd.nz, vMix/ATEM/OBS)**: "Mills Level Sensor" — a **ballistic algorithm on relative differences between all mic signals** (explicitly *not* absolute thresholds, so it's robust to gain/distance), plus an on-device **neural VAD** ("distinguishes speech from background noise") gating the decision; "switching personalities" presets (slow "Grandpa" → fast "Pro"); fuzzy-logic history rules including **reaction shot when one camera has been active too long**. No concrete numbers published (UNCERTAIN).

**OBS Advanced Scene Switcher**: audio condition = volume above/below threshold, evaluated as **max peak over the whole check interval** (changed from instantaneous sampling specifically because momentary checks misfired), plus a **cooldown** ("minimum time before the next match has an effect" — matches in that window ignored).

**ATEM**: only audio-follows-video (audio ducks with the cut); no video-follows-audio — not a source of heuristics.

**Automixer gate timing (audio-domain, decades-proven analog of your leader decision):** Shure IntelliMix gating: **Gating Sensitivity** (threshold), **Off Attenuation** (−20 dB in gating mode), **Hold Time** ("channel remains open after level drops below gate threshold"; integration guides recommend **300–400 ms**), **Maximum Open Channels**, **Leave Last Mic On** (never go to "nobody"), per-channel **Priority** / **Always On**, and **Speech Gating Threshold** (speech-vs-noise classifier on the gate). These map 1:1 to: silence hangover, floor for non-speakers, NOM cap, hold-last-on-silence, host priority, VAD.

## 5. Editing craft — concrete numbers

- **Stanford "Computational Video Editing for Dialogue-Driven Scenes" (Leake/Davis/Truong/Agrawala, SIGGRAPH 2017)** — extracted from the paper PDF:
  - Idiom set distilled from film literature: *avoid jump cuts; change zoom gradually; emphasize character; intensify emotion (close-ups on emotional lines); peaks and valleys; performance fast/slow; speaker visible; start wide (establishing); zoom consistent; zoom in/out*.
  - **Cut placement inside the inter-line pause:** parameters α (fraction of available silence kept *before* the incoming line) and β (after the outgoing line). **Defaults α=0.9, β=0.1, "based on a survey of between-line spacing in dialogue-driven scenes [Salt 2011]"** → in real films the cut lands **late in the pause, ~90% through it, just before the next speaker starts**. This is the strongest published validation of your snap-to-speech-onset with a small pre-roll (≈10% of the pause).
  - Unit of editing = line of dialogue; the authors list "cannot cut away mid-line for a reaction" as a limitation, i.e., reaction-shot insertion mid-monologue is a *separate* mechanism, which is exactly what AutoCut/Descript/VVD bolt on.
- **Barry Salt, "Reaction time: how to edit movies" (2011)**: dialogue cut taxonomy straight/L/J; "even when there are cutaways to reaction shots in the middle of a speech, these tend to **follow the length of sentences** within the speech" → insert reactions at sentence/pause boundaries, never mid-clause.
- **J/L-cut overlap sizes** (multiple editing guides): typical dialogue overlap **0.5–2 s**; subtle interview J-cuts work from as little as **4 frames**; 1–3 s for scene transitions. For podcast speaker changes the shipped data point is Resolve's **Edit Change Delay 0.3 s** (video cut trails the new voice slightly = natural J-cut feel).
- **Shot lengths**: modern film ASL 4–6 s; general video guidance medium takes 5–10 s; shipped podcast tools enforce min ≈ **1.5 s** (Resolve example, your value) and expose max (AutoCut/Wraith; your 8 s max-hold is consistent with "reaction/cutaway when someone talks long" behavior in Descript/VVD).

## 6. Diarization vs per-mic RMS

- **No shipped podcast multicam tool publicly uses pyannote/whisperX-style diarization.** The shipped spectrum is: per-track level (AutoPod, AutoCut, LiveCUT, Roland), per-track level + VAD (VVD), transcript per separate track (Descript, Premiere Assistant), and audio+vision (Resolve SmartSwitch lip movement + auto wide/close-up classification; Eddie motion detection). Rationale found in the diarization literature: with separate per-speaker tracks, "speaker attribution is 100%... diarization is no longer probabilistic" — diarization solves a problem you don't have; **bleed is solved with relative comparison, VAD, and visual cues, not clustering**.
- Heavy-bleed strategies confirmed in shipped products: (a) **relative inter-mic margin** rather than absolute thresholds (VVD; your bleedMarginDb=6dB is the same idea), (b) **speech-gating/VAD** so non-speech energy can't open a channel (VVD, Shure Speech Gating Threshold), (c) **cut to wide on overlap** (Resolve, Roland Mix target), (d) **lip-movement check** (Resolve — only AV tool).

---

## Failure modes → shipped solutions

| Failure mode | Who reports it | Shipped fix |
|---|---|---|
| Cuts on laugh/sneeze/cough (volume-only) | AutoPod users | VAD/speech classifier before gate (VVD, Shure); sustained-attack requirement (LiveCUT Attack/Pre-Attack); peak-over-window not instantaneous (OBS adv-ss) |
| Crosstalk/bleed picks wrong angle | AutoPod ("one mic = one angle breaks") | Relative levels across all mics (VVD); 6 dB-style margin; wide/Mix target on overlap (Resolve, Roland) |
| Machine-gun cutting on rapid exchange | all RMS tools | Min Edit Duration ~1.5 s; post-cut re-arm (Roland Time); group layout for rapid back-and-forth (Descript) |
| Metronomic, robotic pacing | Wraith marketing vs AutoPod | Variation control randomizing shot length (Wraith); frequency knobs (AutoPod multi-shot/wide frequency) |
| Long monologue = static frame | Descript, VVD | Reaction shot/cutaway when one angle active too long (AutoCut Reaction Shots toggle; VVD fuzzy rule; Descript monologue cutaways) |
| Silence = dead air on a closeup | Resolve, Roland | "Use wide angle for silence" checkbox OR hold-last (Roland Silent=OFF) |
| Destructive edit hard to revise | AutoPod criticism | Enable/Disable method (AutoPod option, AutoCut "Disable (recommended)") — you already do this |
| Cut lands mid-word | volume tools | Cut in the pause, ~90% through (Salt/Stanford α=0.9/β=0.1); word-level boundaries (Premiere Assistant) |

## Ranked: adoptable into your RMS planner (confirmed-shipped mechanics only)

1. **Edit Change Delay (0.3 s default)** — Resolve ships a *positive* delay after new-speaker onset before the video cut (natural J-cut). You currently snap *to* the onset; expose a `cutDelayMs` (≈200–400 ms after onset, or up to −10% of the pause before it per Salt). Cheap, high realism.
2. **Speech-onset confirm window / attack** — require the new leader to be sustained ~300–400 ms (Shure gate hold, LiveCUT Attack, OBS peak-over-window) before committing the switch. Directly kills the laugh/sneeze false cut, AutoPod's worst failure. Your majority-vote smoothing partially does this; make the attack asymmetric (slow to switch *to* someone, slower to release).
3. **Reaction shots on long monologue** — at max-hold expiry, instead of always wide, occasionally cut to a *listener* closeup for 2–4 s then return (AutoCut toggle, Descript, VVD). Insert at sentence/pause boundaries within the monologue (Salt).
4. **Named pacing presets** — Calm/Paced/Energetic/Hyperactive mapping to (minHold, maxHold, wide frequency, variation) like AutoCut; plus a **Variation** jitter on shot length (Wraith) to avoid metronomic cuts.
5. **Wide-shot policy flags** — you have overlap/silence→wide; add Resolve's other two: **wide for intro/outro** and **periodic Wide Angle Frequency Low/Med/High**; plus Roland's **Silent=OFF** alternative (hold last shot through short silences instead of always cutting wide).
6. **Speaker priority** — AutoCut's Normal/High/Very High per speaker: bias the leader decision (e.g., −2/−4 dB effective handicap for non-priority speakers, or longer holds on host).
7. **Group/Mix target on overlap** — Roland: if a 2-shot containing exactly the overlapping speakers exists, prefer it over the full wide.
8. **Post-cut re-arm time** — Roland's `Time` (detection lockout after a switch, 0–30 s) as an explicit separate knob from min-hold; it suppresses *decisions*, not just cuts, so the smoother doesn't accumulate a pending switch.
9. **Per-mic auto-calibration** — LiveCUT "Automatic Level Adjustment" / VVD "zero calibration relative differences": derive per-mic silence floor and speech level from a calibration pass instead of a global −35 dBFS; keeps your 6 dB margin meaningful across unmatched mics.
10. **Cut-in-pause placement (α=0.9/β=0.1)** — when both onset-snap and a real inter-speaker pause exist, place the razor ~90% through the pause rather than exactly at onset (Stanford default, sourced from Salt's film survey).
11. UNCERTAIN (thin sources, don't copy blindly): VVD's exact ballistic constants; AutoPod's internal defaults; Roland Time default (~4 s); SmartSwitch internals beyond the published dialog.

Sources:
- [DaVinci Resolve 20 New Features Guide (official PDF, SmartSwitch pp. 51–54)](https://documents.blackmagicdesign.com/SupportNotes/DaVinci_Resolve_20_New_Features_Guide.pdf)
- [Roland VR-50HD MK II Reference Manual (Video Follows Audio, p. 44)](https://www.audiogeneral.com/roland/VR-50HD/VR-50HD-MK2_reference_eng01_W.pdf)
- [Roland: VR-50HD MK II Video Follows Audio setup](https://support.roland.com/hc/en-us/articles/360052363211-VR-50HD-MK-II-How-to-Set-Up-Video-Follows-Audio-Switching-Automation)
- [AutoPod official site](https://www.autopod.fm/) / [AutoPod DaVinci beta](https://www.autopod.fm/davinci-resolve)
- [AutoPod multicam guide (autopodcastai)](https://autopodcastai.com/autopod-multi-camera-editing/) / [AutoPod ultimate guide](https://autopodcastai.com/how-to-use-autopod-ai/)
- [Cutback: AutoPod common issues](https://cutback.video/blog/autopod-not-working-common-issues-and-fixes-for-premiere-pro-editors-2026-guide) / [AI podcast editors compared](https://cutback.video/blog/4-best-ai-podcast-editors-compared-selects-descript-autopod-and-more) / [Premiere Assistant multicam](https://cutback.video/premiere-assistant/features/multicam)
- [AutoCut Podcast settings (help center)](https://knowledge.autocut.com/en/article/how-to-set-autocut-podcast-1q8xm52/) / [AutoCut Podcast category](https://knowledge.autocut.com/en/category/autocut-podcast-9qb8uz/) / [AutoCut Podcast page](https://www.autocut.com/en/autocutpodcast/) / [AutoCut vs AutoPod](https://www.autocut.com/en/blogs/autocut-vs-autopod/) / [AutoCut silence parameters](https://www.autocut.com/en/blogs/autocut-silences-parameters/)
- [Wraith Multi-Cam Editor blog/params](https://phantomeditor.video/blog/best-autopod-alternative-2026-multicam-editing-premiere-pro) / [How to use Wraith](https://phantomeditor.video/blog/How-to-use-Wraith-Multi-Camera-Editor)
- [Descript Automatic multicam help](https://help.descript.com/hc/en-us/articles/28736507904525-Automatic-multicam) / [Descript automatic multicam feature page](https://www.descript.com/ai/automatic-multicam)
- [Eddie AI multicam help](https://help.heyeddie.ai/en/articles/10548843-multicam-podcasts-the-correct-angle-chosen-for-the-correct-speaker) / [Eddie AI multicam feature](https://www.heyeddie.ai/features/multicam) / [No Film School on Eddie](https://nofilmschool.com/ai-multicam-editing-tool)
- [Larry Jordan: AI features in Resolve 20](https://larryjordan.com/articles/ai-powered-features-in-davinci-resolve-20/) / [BMD forum: SmartSwitch not working](https://forum.blackmagicdesign.com/viewtopic.php?f=21&t=220309)
- [Adobe: multicam source sequences](https://helpx.adobe.com/premiere-pro/using/create-multi-camera-source-sequence.html) / [Apple: FCP multicam workflow](https://support.apple.com/guide/final-cut-pro/multicam-editing-workflow-ver10e087fd/mac)
- [LiveCUT for vMix](https://livecutai.com/) / [Virtual Video Director](https://www.vvd.nz/) / [vMix audio-input linking](https://www.vmix.com/knowledgebase/article.aspx/92/linking-an-audio-input-with-a-camera)
- [OBS Advanced Scene Switcher](https://obsproject.com/forum/resources/advanced-scene-switcher.395/) / [adv-ss updates (audio peak/cooldown)](https://obsproject.com/forum/resources/advanced-scene-switcher.395/updates?page=8)
- [Shure MXA920 user guide (automix settings)](https://pubs.shure.com/view/guide/MXA920/en-US.pdf) / [Biamp: Shure array gate hold 300–400 ms](https://support.biamp.com/Tesira/Miscellaneous/Using_the_Shure_MXA910_or_MXA920_microphone_array_with_Tesira)
- [Leake et al., Computational Video Editing for Dialogue-Driven Scenes (SIGGRAPH 2017, PDF)](https://graphics.stanford.edu/papers/roughcut/files/roughcut-small.pdf) / [project page](http://abedavis.com/publications/roughcut/)
- [Barry Salt, Reaction time: how to edit movies](https://www.tandfonline.com/doi/abs/10.1080/17400309.2011.585865) / [Salt, cutting dialogue (Cinemetrics)](http://www.cinemetrics.lv/dev/cutdial.php)
- [J/L-cut timing guides: SpotlightFX](https://spotlightfx.com/blog/what-are-j-cuts-and-l-cuts-professional-dialogue-editing-explained), [Partners in Post (4-frame J-cut)](https://www.partnersinpost.com/blog/2020/5/5/-j-cut), [StudioBinder editing rhythm/ASL](https://www.studiobinder.com/blog/how-does-an-editor-control-the-rhythm-of-a-film/)
- [WhisperX/pyannote multitrack attribution](https://brasstranscripts.com/blog/whisper-whisper-diarization-guide) ([guide](https://brasstranscripts.com/blog/whisper-speaker-diarization-guide))

Key takeaway for your planner: your architecture (per-mic RMS + margin + min/max hold + wide on overlap/silence + onset snap + razor/disable) matches the shipped state of the art almost exactly; the gaps confirmed in shipped products are **onset-confirm attack (~300–400 ms), Edit Change Delay (~0.3 s after onset), reaction shots at max-hold, pacing presets + variation jitter, speaker priority, and periodic/intro-outro wide policy**.