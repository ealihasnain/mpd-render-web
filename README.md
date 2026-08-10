# mpd-render-web

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

Measured on a real 7-chapter assembly: ~28ms per frame, of which serialisation
is 2ms and SVG decode is the rest. Inlining the 156 KB of base64 fonts roughly
doubles decode cost (36ms vs 18ms without), but an SVG loaded as an image cannot
fetch anything — drop the fonts and every glyph falls back to a serif. All six
faces are genuinely used, so there is no subsetting win available.

`createImageBitmap()` cannot decode SVG blobs in Chromium; `Image` + object URL
is the only working path.

Heavier episodes cost more per frame. **Inspect** measures yours.

## Build

`index.html` is generated. Edit `src/`, then:

```
node src/build.js
```

Muxers are vendored, MIT licensed — see THIRD-PARTY.md.
