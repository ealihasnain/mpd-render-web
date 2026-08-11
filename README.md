# mpd-render-web 6

Deterministic master render for MoneyPatternsDecoded video shells. Runs entirely
in the browser — no Python, no admin rights, no install, nothing uploaded.

**Live:** https://ealihasnain.github.io/mpd-render-web/

## Why this exists

The shell's own EXPORT button paints deterministically — `paint(from + f/fps)`,
time from the frame index, never the wall clock. That part was always right.
What broke a 9m24s export into a 53-minute file was `MediaRecorder`, which
stamps frames as they *arrive*. At ~190ms per frame that reads as ~5.6fps, and
the captured stream carries no audio track.

WebCodecs takes the timestamp as an argument instead. Frame *n* is stamped
`n/fps` whether it took 8ms or 800ms to draw, so the duration is correct by
construction rather than by luck. Audio is muxed in the same pass.

The rasteriser calls the shell's own `serializeFrame()`, so the pixels are the
ones the shell would have produced. Verified byte-identical to the shell's
`rasterFrame()` at six sample points across a real episode: zero differing
pixels, max channel difference 0.

## What version 3 fixes

Version 2 rendered EP002 in 30.1 minutes after projecting 2:39. Both numbers
were honest and the gap between them was the whole problem: the projection was
built on the rasteriser (9ms/frame, measured) while the run was governed by the
encoder (106ms/frame, observed). 17,073 frames in 30.1 minutes is 9.4fps, which
is what Chrome's *software* H.264 encoder does at 1080p. `configure()` never
named an acceleration preference, so the browser picked, and it picked software
while the machine's hardware encoder sat idle.

There is no clean way to ask whether a hardware encoder is really in play.
`hardwareAcceleration` is a hint the browser may decline, and
`'require-hardware'` is not a value the spec defines. So version 3 measures:

- **Encoder benchmark.** Eight configurations — MP4 and WebM, each at
  hardware / hardware-realtime / software-realtime / browser-default — each run
  through 48 real frames from your episode. Observed fps and projected episode
  runtime are reported for every one *before* the master starts. Inspect runs
  this automatically; the **Encoder** dropdown pins a specific one.
- **Honest projection.** Rasterising and encoding overlap, so the estimate is
  now `max(raster, encode)` rather than the rasteriser alone, and the log says
  which of the two is governing.
- **Deeper queue.** The old 8/4 backpressure pair meant a fast encoder spent
  its time waiting on a 4ms poll. Now 30/15, and the progress line reports the
  share of elapsed time spent waiting on the encoder, so a stall is visible
  while it happens rather than afterwards.

Expect single-digit minutes where a hardware encoder exists. Where none does,
software VP9 in `realtime` mode multithreads and generally beats OpenH264 — the
benchmark will find it.

## What version 4 fixes

Version 3 halved the EP002 render, 30.1 min to 15.0 — and then reported
`0% of it waiting on the encoder`. The codec was no longer the constraint. The
projection said 3:47 and the run took 15:00, so for the second time a model
built from measured parts was wrong about the whole: the rasteriser benched at
13ms and the loop ran at 53ms, with 40ms/frame belonging to neither the
rasteriser nor the encoder.

Rather than guess a third time, version 4 measures the loop that does the work:

- **`trialRun()`** runs the real pipeline — compose, decode, `VideoFrame`,
  encode — for 24 frames against a throwaway encoder, and reports the per-phase
  split. Whatever the expensive step is, it is inside the measurement by
  construction. The estimate is labelled a floor, because a sustained run
  carries GC and compositing overhead a 24-frame sample does not.
- **Per-phase totals after every render**, including an explicit *unaccounted*
  line when the phases fail to add up to the wall clock. A future change gets
  aimed at whichever phase is actually large.
- **Prefetch pipeline.** `rasterAt()` is split into a synchronous
  `composeFrame()` and an asynchronous `decodeToCanvas()`, across two canvases,
  so frame *n+1* decodes while frame *n* is encoded. The snapshot is a string,
  so painting *n+1* cannot disturb a decode already in flight.
- **Elapsed time and projected finish clock** alongside time remaining.

### The preview shows the output, not the shell

Version 5's transport drove the shell's live DOM and set `#live.style.opacity`
directly. It worked against a fixture and came out blank against a real
episode — and it was blank in a way rendering would never have revealed,
because the render path serialises the DOM to a string and never looks at the
iframe at all. A preview whose failure modes are disjoint from the output's is
not a preview of anything.

Version 6 draws the preview with `composeFrame()` + `decodeToCanvas()`, the same
pair the render loop uses, onto a canvas over the stage. Measured: zero pixels
differ between a previewed frame and the frame the renderer writes for the same
timestamp. Consequences worth knowing:

- The fade blends toward canvas cream, because that is what the master does.
  The shell's own preview dips to dark. The master was always right; only the
  preview disagreed.
- Rasterising costs tens of milliseconds, so at 8x the picture drops frames.
  The audio clock is never held back for it, so sync stays true and only
  smoothness suffers.

### Stopping a render

**Stop render** breaks the frame loop rather than throwing, so the muxer is
still finalised and the encoder still flushed. The file on disk is a shorter
valid video, not a truncated one — verified by cancelling at frame 47 of 90 and
probing the result: 47 packets, `avg_frame_rate 30/1`, plays. Nine minutes into
a render, a playable first half is worth considerably more than nothing. The
log says how many frames were written, and warns that the audio track is full
length while the picture stops early.

Stop is also checked inside the encoder-queue wait, so it takes effect
immediately rather than after the queue drains.

### Preview transport

Play/pause, stop, skip (2/3/5/10/15/20/30s), numbered chapter buttons, speed
(0.5/1/2/4/8x), volume, a click-to-seek scrub bar, and keyboard control —
space to play, arrows to skip, up/down for chapter. It drives the shell's
`paint(t)` directly; the shell's own transport stays hidden.

Two things it does that the shell's preview cannot:

- **It shows the fade you configured here**, picture and audio, including
  asymmetric in/out durations the shell's symmetric `envelope()` has no way to
  express. Both are read from the same curve the master uses, so preview and
  output cannot disagree. The fields apply live — change one mid-scrub and the
  frame updates.
- **It stays in sync above 1x**, because when audio is loaded the
  `AudioContext` clock drives the paint rather than accumulated
  requestAnimationFrame deltas. Drift over a nine-minute preview is exactly what
  makes a preview useless for checking sync.

Audio ends before the picture on episodes with an outro card; the clock hands
back to the wall clock before the source runs out rather than after.

### Fade and duck durations

Picture fade and audio duck each take separate **in** and **out** durations,
defaulting to 1.0s, where the shell's `envelope()` has one symmetric value.
Equal values reproduce the shell exactly and `verifyEnvelope()` proves it at
1,200 sample points. Unequal values are something the shell's preview cannot
display, and the log says so plainly rather than reporting it as a fault: for
asymmetric fades the master is the reference for how the fade looks, the
preview only for when it happens.

## Requirements

- Desktop **Chrome** or **Edge**. Firefox and Safari lack the encoders.
- Must be **served over http(s)** — the Pages URL is fine. Opening `index.html`
  from disk gives the page origin `null`, which can never reach inside the
  frame where the episode runs. The app says so if you try.

## Use

1. Open the Pages URL.
2. **Episode video HTML** — your `EP###.6_VideoHTML_v#.html`. Timeline,
   chapters and beats are read out of it; no `episode.json` needed.
3. **Voice mix** — optional. Omit it for a silent render.
4. **Inspect** first. Two seconds, and it reports the shell version, validator
   result, which codecs your browser will encode, and measured ms/frame with a
   projected total. Do this before committing an hour.
5. **Contact sheets** or **Render master**.

Keep the tab focused. A background tab is throttled and the render crawls.

## Containers

Chosen by what your browser can encode, never by preference:

| Container | Video | Audio |
|---|---|---|
| MP4 | H.264 | AAC |
| WebM | VP9 | Opus |

VP9 is never written into MP4. That pairing is legal, barely supported, and is
what VLC refused from the old browser merge step. Chrome ships H.264 and AAC;
plain Chromium does not, and falls back to WebM. WebM VP9+Opus is a perfectly
good YouTube master.

`Auto` prefers MP4 and falls back. Forcing a container your browser cannot
encode fails loudly instead of writing something unplayable.

## Fades

Both checkboxes are on by default and both use the shell's own `envelope()`
curve, verified against it at 1,200 sample points before each render — if the
two ever disagree the log says so.

- **Picture fade** dips the frame to flat canvas at each chapter boundary.
- **Audio duck** applies the identical curve as gain. This replaces the ffmpeg
  `-af` string the shell's `⧉ AF` button used to hand over, and comes from the
  same source of truth rather than a second implementation that can drift.

The audio fade-out lands at `EPISODE.audioDur` rather than `TOTAL`, so a mix
that ends before the outro card still fades instead of cutting.

## Contact sheets

Shoots every beat at 85% of its duration and tiles per chapter, plus an index
mapping each cell to its design id and timestamps. Downloads one PNG per
chapter. This is the check nothing else in the pipeline performs: whether text
fits its box and whether a frame reads as full.

## Two bugs this surfaced in shell 6

**1. Export can bake in a 6% opacity wash.** `applyEnvelope()` guards with
`EXPORTING ? 1 : ...`, but `runExport()` sets `EXPORTING = true` and never calls
it again, so `#live` keeps whatever opacity the playhead last left. Park on a
chapter boundary, hit EXPORT, and every frame serialises with
`style="opacity: 0.06"`. Confirmed by inspection of the serialised root tag.

Fix — one line at the top of `runExport()`, after `EXPORTING = true`:

```js
document.getElementById('live').style.opacity = 1;
```

This app sets opacity explicitly on every frame, so it is unaffected.

**2. The picture fade never reached the output at all.** Same cause: with the
guard pinning opacity to 1, chapter dips were preview-only while the `-af`
filter ducked the audio in the mux. Picture and voice disagreed. Here they are
driven from one curve.

## Performance

The shell's `serializeFrame()` writes every mounted beat into every frame,
hidden or not, plus all 156 KB of base64 fonts. On a 115-beat episode that is
304 KB of markup per frame. This app instead serialises only the groups that
are visible at time *t*, and only the font faces that frame's markup actually
names — typically one of six.

Measured on a 115-beat assembly:

| path | per frame |
|---|---|
| shell `serializeFrame()` | 83 ms |
| visible groups only | 36 ms |
| visible groups + font subset | **19 ms** |

4.4x, and **pixel-identical** — 0 differing pixels, max channel difference 0.

That claim is re-proven at runtime, not trusted. Before every render the app
renders sample frames both ways and compares them pixel by pixel. Any
disagreement and it falls back to the shell's own path for the whole run and
says so in the log. A silent serif fallback would cost far more than the time
it saves.

`createImageBitmap()` cannot decode SVG blobs in Chromium; `Image` + object URL
is the only working path.

## Memory

A 9-minute 1080p master is over a gigabyte. Buffered in an ArrayBuffer that
gets the tab suspended by Chrome mid-render. So the output streams to disk
through the File System Access API: Chrome asks where to save *before*
rendering starts and writes as it goes, keeping memory flat.

The MP4 moov atom therefore lands at the end of the file rather than the front.
Fine for a YouTube master and for local playback; it only matters for
progressive streaming off a web server.

Without the File System Access API the app falls back to buffering in RAM and
warns. Chrome and Edge have it; that is the same requirement as the encoders.

A screen wake lock is held during the render.

## Build

`index.html` is generated. Edit `src/`, then:

```
node src/build.js
```

Muxers are vendored, MIT licensed — see THIRD-PARTY.md.
