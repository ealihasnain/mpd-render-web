/* @mpd-version render-web 3
   mpd-render-web — deterministic browser render for MPD video shells.

   The shell's export loop was already deterministic: it paints from a frame
   index, never the wall clock. What broke the 9m24s export was MediaRecorder,
   which stamps frames as they arrive, so 190ms-per-frame rasterisation became
   a 53-minute file. WebCodecs takes the timestamp as an argument instead, so
   frame n is stamped n/fps no matter how long it took to draw.

   Version 3 fixes the throughput, which turned out not to be the rasteriser.
   On EP002 the fast rasteriser measured 9ms/frame and the run took 106ms/frame:
   17,073 frames in 30.1 minutes is 9.4fps, which is what Chrome's software
   H.264 encoder does at 1080p. `configure()` never named an acceleration
   preference, so the browser chose, and it chose software while the machine's
   hardware encoder sat idle.

   There is no way to ask whether a hardware encoder exists.
   `hardwareAcceleration` is a hint, `isConfigSupported` reports true for
   preferences it will silently ignore, and 'require-hardware' is not a value
   the spec defines. So this version measures instead: benchEncoders() runs real
   frames through every viable configuration and reports observed fps for each
   before a single frame of the master is written.
*/

const $ = id => document.getElementById(id);
const S = {
  win: null, doc: null, live: null, html: null,
  audioBuf: null, audioName: '', htmlName: '',
  cancel: false, running: false, fontCss: '', faces: null, mode: 'fast', wake: null,
  encBench: null,      // [{p, ok, fps, ...}] from the last benchEncoders() run
  encBenchKey: '',     // bitrate|fps the bench was measured at — invalidates on change
};

function log(msg, cls) {
  const el = $('log');
  const line = document.createElement('div');
  if (cls) line.className = cls;
  line.textContent = msg;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
}
function clearLog() { $('log').innerHTML = ''; }
function setProg(frac, text) {
  $('pfill').style.width = Math.max(0, Math.min(1, frac)) * 100 + '%';
  if (text !== undefined) $('ptext').textContent = text;
}
function fmt(s) {
  if (!isFinite(s)) return '–';
  const m = Math.floor(s / 60);
  return m + ':' + String(Math.floor(s % 60)).padStart(2, '0');
}

/* ---------------------------------------------------------------- loading */

/* A bridge <script> appended after the shell's own script. Top-level `const`
   lives in the global lexical scope, not on window, so EPISODE and friends are
   unreachable via contentWindow — but a later classic script shares that same
   scope and can hand them out. Getters keep it lazy: this runs at parse time,
   before the shell's async boot() has populated anything. */
const BRIDGE = `
<style>#bar,#panel,#ovl,#vbanner{display:none!important}
html,body{background:#151310!important}</style>
<script>
window.__MPDX__ = {
  get EPISODE(){return EPISODE}, get CHAPTERS(){return CHAPTERS},
  get TIMELINE(){return TIMELINE}, get WORDS(){return WORDS},
  get TOTAL(){return TOTAL}, get beats(){return beats},
  get FADE_V(){return FADE_V}, get FADE_A(){return FADE_A}
};
<\/script>`;

function injectBridge(htmlText) {
  const i = htmlText.lastIndexOf('</body>');
  if (i < 0) return htmlText + BRIDGE;
  return htmlText.slice(0, i) + BRIDGE + htmlText.slice(i);
}

async function loadEpisode(file) {
  S.htmlName = file.name;
  let text = await file.text();

  const stamp = text.match(/@mpd-version shell (\d+)/);
  if (!stamp) {
    log('This HTML carries no "@mpd-version shell" stamp. It is not an MPD video shell, or it predates v2.', 'err');
    return false;
  }
  const v = +stamp[1];
  log(`Shell version ${v} · ${(file.size / 1024).toFixed(0)} KB`);
  if (v < 6) log(`Note: built for shell 6. Version ${v} may lack serializeFrame or envelope; inspect will say so.`, 'warn');

  text = injectBridge(text);
  const blob = new Blob([text], { type: 'text/html' });
  const url = URL.createObjectURL(blob);

  const frame = $('stage');
  await new Promise((res, rej) => {
    frame.onload = res;
    frame.onerror = () => rej(new Error('iframe failed to load'));
    frame.src = url;
  });

  S.win = frame.contentWindow;
  S.doc = frame.contentDocument;
  if (!S.doc) {
    if (location.protocol === 'file:') {
      log('Opened from disk. A file:// page has origin "null", so it can never reach inside the frame.', 'err');
      log('Serve it instead: use the GitHub Pages URL, or run "npx serve" in this folder.', 'err');
    } else {
      log('Cannot reach the document inside the frame (origin blocked).', 'err');
    }
    return false;
  }

  const t0 = performance.now();
  const deadline = t0 + 60000;
  while (performance.now() < deadline) {
    if (S.win.__READY__ === true) break;
    await new Promise(r => setTimeout(r, 80));
  }
  if (S.win.__READY__ !== true) {
    log(`__READY__ never set after ${((performance.now() - t0) / 1000).toFixed(0)}s. Fonts may have failed to load.`, 'err');
    return false;
  }
  S.live = S.doc.getElementById('live');
  const fontEl = S.doc.getElementById('mpd-fonts');
  S.fontCss = fontEl ? fontEl.textContent : '';
  S.faces = S.fontCss ? parseFaces(S.fontCss) : null;
  log(`Ready in ${((performance.now() - t0) / 1000).toFixed(1)}s`, 'ok');
  URL.revokeObjectURL(url);
  return true;
}

function bridge() {
  const x = S.win && S.win.__MPDX__;
  if (!x) throw new Error('bridge missing — the shell script may have thrown before finishing');
  return x;
}

/* ------------------------------------------------------------ diagnostics */

const VCFG = {
  h264: t => ({ codec: 'avc1.640028', width: 1920, height: 1080, bitrate: t, framerate: 30 }),
  vp9: t => ({ codec: 'vp09.00.10.08', width: 1920, height: 1080, bitrate: t, framerate: 30 }),
};

/* ------------------------------------------------------- encoder profiles */

/* Every configuration worth trying. 'prefer-hardware' is a request the browser
   may ignore without saying so, and software libvpx multithreads in realtime
   mode where OpenH264 does not — which combination wins is a property of the
   machine, not of the codec. Hence: measure all of them, pick by stopwatch. */
const ENC_PROFILES = [
  { id: 'mp4-hw',    container: 'mp4',  acc: 'prefer-hardware', lat: 'quality',  label: 'MP4 · H.264 · hardware' },
  { id: 'mp4-hw-rt', container: 'mp4',  acc: 'prefer-hardware', lat: 'realtime', label: 'MP4 · H.264 · hardware, realtime' },
  { id: 'mp4-sw-rt', container: 'mp4',  acc: 'prefer-software', lat: 'realtime', label: 'MP4 · H.264 · software, realtime' },
  { id: 'mp4-def',   container: 'mp4',  acc: 'no-preference',   lat: 'quality',  label: 'MP4 · H.264 · browser default' },
  { id: 'webm-hw',   container: 'webm', acc: 'prefer-hardware', lat: 'quality',  label: 'WebM · VP9 · hardware' },
  { id: 'webm-hw-rt',container: 'webm', acc: 'prefer-hardware', lat: 'realtime', label: 'WebM · VP9 · hardware, realtime' },
  { id: 'webm-sw-rt',container: 'webm', acc: 'prefer-software', lat: 'realtime', label: 'WebM · VP9 · software, realtime' },
  { id: 'webm-def',  container: 'webm', acc: 'no-preference',   lat: 'quality',  label: 'WebM · VP9 · browser default' },
];

function encConfig(p, bitrate, fps) {
  const c = {
    codec: p.container === 'mp4' ? 'avc1.640028' : 'vp09.00.10.08',
    width: 1920, height: 1080, bitrate, framerate: fps,
    hardwareAcceleration: p.acc,
    latencyMode: p.lat,
  };
  if (p.container === 'mp4') c.avc = { format: 'avc' };
  return c;
}

/* Distinct frames spread across the timeline. Encoding one frame repeatedly
   would produce trivially small P-frames and flatter the encoder. */
async function grabSamples(n) {
  const B = bridge();
  const out = [];
  for (let i = 0; i < n; i++) {
    const cv = document.createElement('canvas'); cv.width = 1920; cv.height = 1080;
    const cx = cv.getContext('2d', { alpha: false });
    await rasterAt(B.TOTAL * (i + 0.5) / n, cx, 1, S.mode);
    out.push(cv);
  }
  return out;
}

const BENCH_FRAMES = 48;
const BENCH_BUDGET_MS = 2600;

async function benchOne(p, samples, bitrate, fps) {
  const cfg = encConfig(p, bitrate, fps);
  try {
    const sup = await VideoEncoder.isConfigSupported(cfg);
    if (!sup || !sup.supported) return { p, ok: false, why: 'not supported' };
  } catch (e) { return { p, ok: false, why: 'not supported' }; }

  let err = null;
  const enc = new VideoEncoder({ output: (c) => { c.close && c.close(); }, error: e => { err = e; } });
  try { enc.configure(cfg); } catch (e) { return { p, ok: false, why: 'configure rejected' }; }

  const gop = fps * 2, usPerFrame = 1e6 / fps;
  const t0 = performance.now();
  let done = 0;
  for (let f = 0; f < BENCH_FRAMES && !err; f++) {
    const vf = new VideoFrame(samples[f % samples.length], {
      timestamp: Math.round(f * usPerFrame), duration: Math.round(usPerFrame),
    });
    enc.encode(vf, { keyFrame: f % gop === 0 });
    vf.close();
    done++;
    if (enc.encodeQueueSize > QUEUE_HIGH) {
      while (enc.encodeQueueSize > QUEUE_LOW && !err) await new Promise(r => setTimeout(r, 2));
    }
    /* A configuration this slow is already disqualified; do not spend
       thirty seconds proving how slow. */
    if (performance.now() - t0 > BENCH_BUDGET_MS) break;
  }
  try { await enc.flush(); } catch (e) { err = err || e; }
  const ms = performance.now() - t0;
  try { enc.close(); } catch (e) {}
  if (err || !done) return { p, ok: false, why: 'encoder error' };
  return { p, ok: true, fps: done / (ms / 1000), msPerFrame: ms / done, frames: done };
}

/* Runs the whole matrix and logs it. `want` filters by container when the user
   has pinned one; 'auto' benches both so a fast WebM path is not hidden behind
   a slow MP4 default. */
async function benchEncoders(want, bitrate, fps, totalFrames) {
  const pool = ENC_PROFILES.filter(p => want === 'auto' || p.container === want);
  const samples = await grabSamples(6);
  const results = [];
  log('Encoder benchmark — measured, not advertised', 'hd');
  for (let i = 0; i < pool.length; i++) {
    setProg(i / pool.length, `Benchmarking ${pool[i].label}…`);
    const r = await benchOne(pool[i], samples, bitrate, fps);
    results.push(r);
    if (r.ok) {
      const est = totalFrames ? ' · ' + fmt(totalFrames / r.fps) + ' for this episode' : '';
      log(`  ${r.fps.toFixed(1)} fps · ${r.msPerFrame.toFixed(0)}ms/frame — ${r.p.label}${est}`,
          r.fps >= 25 ? 'ok' : (r.fps < 12 ? 'warn' : ''));
    } else {
      log(`  —      ${r.p.label} (${r.why})`);
    }
    await new Promise(r2 => setTimeout(r2, 0));
  }
  const ok = results.filter(r => r.ok).sort((a, b) => b.fps - a.fps);
  S.encBench = results;
  S.encBenchKey = bitrate + '|' + fps + '|' + want;
  fillEncSelect(results);
  if (!ok.length) { log('No encoder configuration completed. This browser cannot write a master.', 'err'); return null; }

  const best = ok[0], worst = ok[ok.length - 1];
  if (ok.length > 1 && best.fps / worst.fps > 1.5) {
    log(`Fastest is ${(best.fps / worst.fps).toFixed(1)}x the slowest — the encoder, not the rasteriser, sets the runtime.`, 'ok');
  }
  if (best.p.acc === 'prefer-software' || best.fps < 15) {
    log('No hardware encoder appears to be in play. Expect a long run; the machine may lack one, or Chrome may be blocking it (check chrome://gpu).', 'warn');
  }
  return best.p;
}

function fillEncSelect(results) {
  const sel = $('encsel');
  const keep = sel.value;
  sel.innerHTML = '<option value="auto">Auto · fastest measured</option>';
  for (const r of results) {
    if (!r.ok) continue;
    const o = document.createElement('option');
    o.value = r.p.id;
    o.textContent = `${r.p.label} — ${r.fps.toFixed(1)} fps`;
    sel.appendChild(o);
  }
  if ([...sel.options].some(o => o.value === keep)) sel.value = keep;
}

/* Encoder backpressure. The old 8/4 pair meant a fast hardware encoder spent
   its time waiting on a 4ms poll rather than encoding. */
const QUEUE_HIGH = 30;
const QUEUE_LOW = 15;

async function probeCodecs(bitrate) {
  const out = { h264: false, vp9: false, aac: false, opus: false };
  if (typeof VideoEncoder === 'undefined') return out;
  for (const k of ['h264', 'vp9']) {
    try { out[k] = !!(await VideoEncoder.isConfigSupported(VCFG[k](bitrate))).supported; }
    catch (e) { out[k] = false; }
  }
  if (typeof AudioEncoder !== 'undefined') {
    for (const [k, c] of Object.entries({
      aac: { codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2, bitrate: 192000 },
      opus: { codec: 'opus', sampleRate: 48000, numberOfChannels: 2, bitrate: 192000 },
    })) {
      try { out[k] = !!(await AudioEncoder.isConfigSupported(c)).supported; }
      catch (e) { out[k] = false; }
    }
  }
  return out;
}

/* MP4 gets H.264 + AAC. WebM gets VP9 + Opus. Never VP9 inside MP4: legal,
   barely supported, and exactly what VLC refused on the old merge output. */
function chooseContainer(caps, want) {
  if (want === 'mp4' || want === 'webm') {
    if (want === 'mp4' && !caps.h264) return { err: 'MP4 needs H.264, which this browser will not encode.' };
    if (want === 'webm' && !caps.vp9) return { err: 'WebM needs VP9, which this browser will not encode.' };
  } else {
    want = caps.h264 ? 'mp4' : (caps.vp9 ? 'webm' : null);
    if (!want) return { err: 'This browser encodes neither H.264 nor VP9.' };
  }
  return want === 'mp4'
    ? { container: 'mp4', vcodec: 'avc1.640028', vshort: 'avc', acodec: 'mp4a.40.2', ashort: 'aac', ext: 'mp4', audioOk: caps.aac }
    : { container: 'webm', vcodec: 'vp09.00.10.08', vshort: 'V_VP9', acodec: 'opus', ashort: 'A_OPUS', ext: 'webm', audioOk: caps.opus };
}

/* A benchmarked profile already names its container, so it decides the pairing
   rather than the caps probe. VP9 still never enters an MP4. */
function pickFromProfile(profile, caps) {
  const base = chooseContainer(caps, profile.container);
  if (base.err) return base;
  base.acc = profile.acc;
  base.lat = profile.lat;
  base.profileLabel = profile.label;
  base.profileId = profile.id;
  return base;
}

/* Which profile the render should use: the explicit override, else the fastest
   measured, else nothing (caller benches first). */
function chosenProfile() {
  const want = $('encsel').value;
  if (want !== 'auto') return ENC_PROFILES.find(p => p.id === want) || null;
  if (!S.encBench) return null;
  const ok = S.encBench.filter(r => r.ok).sort((a, b) => b.fps - a.fps);
  return ok.length ? ok[0].p : null;
}

function benchIsStale(want, bitrate, fps) {
  return S.encBenchKey !== bitrate + '|' + fps + '|' + want;
}

async function inspect() {
  clearLog();
  const B = bridge();
  const ep = B.EPISODE, ch = B.CHAPTERS, tl = B.TIMELINE;
  log(`Episode ${ep.id} — ${ep.title || ''}`);
  log(`${fmt(B.TOTAL)} total · ${tl.length} beats · ${ch.length} chapters · fps hint ${ep.fps || 30}`);
  if (typeof ep.audioDur === 'number') log(`Narrated span ${fmt(ep.audioDur)} (outro runs ${(B.TOTAL - ep.audioDur).toFixed(2)}s past it)`);

  for (const fn of ['paint', 'serializeFrame', 'envelope', 'chapterAt']) {
    log(`${typeof S.win[fn] === 'function' ? 'ok  ' : 'MISSING '} window.${fn}`, typeof S.win[fn] === 'function' ? 'ok' : 'err');
  }

  const issues = S.win.__ISSUES__;
  if (!Array.isArray(issues)) log('__ISSUES__ is not an array — validator did not run', 'err');
  else if (issues.length) { log(`Validator: ${issues.length} issue(s)`, 'err'); issues.forEach(i => log('   ' + i, 'err')); }
  else log('Validator: clean', 'ok');

  const caps = await probeCodecs(+$('br').value);
  log(`Codecs — H.264 ${caps.h264 ? 'yes' : 'no'} · AAC ${caps.aac ? 'yes' : 'no'} · VP9 ${caps.vp9 ? 'yes' : 'no'} · Opus ${caps.opus ? 'yes' : 'no'}`);
  const pick = chooseContainer(caps, $('fmtsel').value);
  if (pick.err) log(pick.err, 'err');
  else log(`Would write .${pick.ext} (${pick.vshort} + ${pick.audioOk ? pick.ashort : 'no audio codec'})`, 'ok');

  const par = await runParity(4);
  const fps = +$('fps').value;
  const bitrate = +$('br').value;
  const frames = Math.round(B.TOTAL * fps);
  S.mode = par.ok ? 'fast' : 'shell';
  if (par.ok) log(`Fast rasteriser verified pixel-identical (${par.fastMs.toFixed(0)}ms vs ${par.shellMs.toFixed(0)}ms shell)`, 'ok');
  else log(`Fast rasteriser differs (max ${par.worst}, ${par.ndiff}px) — will use the shell path`, 'warn');
  const rasterMs = par.ok ? par.fastMs : par.shellMs;

  const best = await benchEncoders($('fmtsel').value, bitrate, fps, frames);
  if (!best) { setProg(0, 'Inspect done'); return; }

  /* Rasterising and encoding overlap, so the run is governed by whichever is
     slower, not by their sum. Version 2 projected on the rasteriser alone and
     under-read a 30-minute render as 2:39. */
  const encMs = 1000 / S.encBench.filter(r => r.ok).sort((a, b) => b.fps - a.fps)[0].fps;
  const perFrame = Math.max(rasterMs, encMs);
  log(`Fastest path — ${best.label}`, 'ok');
  log(`Raster ${rasterMs.toFixed(0)}ms · encode ${encMs.toFixed(0)}ms · ${perFrame === encMs ? 'encoder-bound' : 'rasteriser-bound'}`);
  log(`${frames} frames ≈ ${fmt(frames * perFrame / 1000)} to render`, 'ok');

  if (!window.showSaveFilePicker) log('No File System Access API — output must buffer in RAM. Use Chrome or Edge.', 'warn');
  setProg(0, 'Inspect done');
}

async function benchRaster(n) {
  const B = bridge();
  const cv = document.createElement('canvas'); cv.width = 1920; cv.height = 1080;
  const cx = cv.getContext('2d', { alpha: false });
  const t0 = performance.now();
  for (let i = 0; i < n; i++) await rasterAt(B.TOTAL * (i + 0.5) / n, cx, 1, S.mode);
  return (performance.now() - t0) / n;
}

/* ------------------------------------------------------------ rasterising */

/* The shell's serializeFrame() writes out every mounted beat, hidden or not,
   plus all 156KB of base64 fonts. On a 115-beat episode that is 304KB of
   markup per frame and ~110ms to decode. Serialising only the visible groups
   and only the font faces the frame actually references cuts both. Measured
   3x faster and pixel-identical, but "measured" is not "assumed" -- runParity()
   proves it against the shell's own output before either mode is trusted. */

function parseFaces(cssText) {
  return cssText.split('@font-face').filter(x => x.trim()).map(chunk => {
    const block = '@font-face' + chunk;
    const fam = (block.match(/font-family:\s*["']?([^"';}]+)/) || [])[1];
    return { css: block, family: (fam || '').trim().toLowerCase() };
  });
}

/* Only faces whose family the markup names. Weights are not filtered: a design
   writing font-weight:bold rather than 700 would lose its face and fall back to
   a serif, and all weights of one family is still a large cut. */
function subsetFonts(markup, faces) {
  const named = new Set();
  const re = /font-family\s*[:=]\s*["']?([^"';,)>]+)/gi;
  let m;
  while ((m = re.exec(markup)) !== null) named.add(m[1].trim().toLowerCase());
  if (!named.size) return null;
  const keep = faces.filter(f => named.has(f.family));
  return keep.length ? keep.map(f => f.css).join('') : null;
}

function buildFrameSVG(opacity) {
  const NS = 'http://www.w3.org/2000/svg';
  const live = S.live;
  const doc = S.doc;
  const out = doc.createElementNS(NS, 'svg');
  out.setAttribute('xmlns', NS);
  out.setAttribute('viewBox', live.getAttribute('viewBox') || '0 0 1920 1080');
  out.setAttribute('preserveAspectRatio', live.getAttribute('preserveAspectRatio') || 'xMidYMid meet');
  out.setAttribute('width', 1920);
  out.setAttribute('height', 1080);
  if (opacity !== 1) out.setAttribute('style', 'opacity:' + opacity);

  for (const g of live.children) {
    if (g.tagName === 'style') continue;
    if (g.style && g.style.display === 'none') continue;
    out.appendChild(g.cloneNode(true));
  }
  let body = new XMLSerializer().serializeToString(out);
  const css = (S.faces && subsetFonts(body, S.faces)) || S.fontCss;
  const style = '<style>' + css + '</style>';
  return body.replace('>', '>' + style);
}

function decodeToCanvas(svg, ctx) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
    const img = new Image();
    img.onload = () => {
      ctx.fillStyle = '#E4DDD0';
      ctx.fillRect(0, 0, 1920, 1080);
      ctx.drawImage(img, 0, 0, 1920, 1080);
      URL.revokeObjectURL(url);
      res();
    };
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('frame decode failed')); };
    img.src = url;
  });
}

/* mode 'fast' = visible groups + subset fonts. mode 'shell' = the shell's own
   serializeFrame(), byte for byte what its EXPORT button would have produced. */
async function rasterAt(t, ctx, opacity, mode) {
  S.win.paint(t);
  if (mode === 'shell') {
    S.live.style.opacity = opacity;
    await decodeToCanvas(S.win.serializeFrame(), ctx);
  } else {
    S.live.style.opacity = 1;
    await decodeToCanvas(buildFrameSVG(opacity), ctx);
  }
}

/* Compare the fast path against the shell's own output on sample frames. Any
   disagreement and the fast path is abandoned for the whole run -- a silent
   serif fallback would be far more expensive than the time it saves. */
async function runParity(samples) {
  const total = bridge().TOTAL;
  const a = document.createElement('canvas'); a.width = 1920; a.height = 1080;
  const b = document.createElement('canvas'); b.width = 1920; b.height = 1080;
  const ax = a.getContext('2d', { alpha: false }), bx = b.getContext('2d', { alpha: false });
  let worst = 0, ndiff = 0, tShell = 0, tFast = 0;
  for (let i = 0; i < samples; i++) {
    const t = total * (i + 0.5) / samples;
    let s = performance.now(); await rasterAt(t, ax, 1, 'shell'); tShell += performance.now() - s;
    s = performance.now(); await rasterAt(t, bx, 1, 'fast'); tFast += performance.now() - s;
    const A = ax.getImageData(0, 0, 1920, 1080).data;
    const B = bx.getImageData(0, 0, 1920, 1080).data;
    for (let k = 0; k < A.length; k += 4) {
      const d = Math.max(Math.abs(A[k] - B[k]), Math.abs(A[k + 1] - B[k + 1]), Math.abs(A[k + 2] - B[k + 2]));
      if (d > worst) worst = d;
      if (d > 2) ndiff++;
    }
  }
  return { ok: worst === 0, worst, ndiff,
           shellMs: tShell / samples, fastMs: tFast / samples };
}

/* The shell's own curve, reimplemented here because calling across the frame
   once per audio sample would cost tens of millions of boundary crossings.
   verifyEnvelope() checks the two agree before it is trusted. */
function makeEnvelope(CHAPTERS, TOTAL) {
  return function (t, fade) {
    if (!(fade > 0)) return 1;
    let e = 1;
    for (const c of CHAPTERS) {
      if (c.start <= 0) continue;
      const d = Math.abs(t - c.start);
      if (d < fade) e = Math.min(e, d / fade);
    }
    if (t < fade) e = Math.min(e, t / fade);
    if (TOTAL - t < fade) e = Math.min(e, (TOTAL - t) / fade);
    return Math.max(0, e);
  };
}

function verifyEnvelope(local) {
  if (typeof S.win.envelope !== 'function') return { ok: false, why: 'shell has no envelope()' };
  const B = bridge();
  let worst = 0;
  for (let i = 0; i <= 400; i++) {
    const t = B.TOTAL * i / 400;
    for (const f of [0.45, 0.2, 1.0]) {
      worst = Math.max(worst, Math.abs(local(t, f) - S.win.envelope(t, f)));
    }
  }
  return { ok: worst < 1e-9, worst };
}

/* ------------------------------------------------------------------ audio */

async function decodeAudio(file) {
  const ac = new (window.AudioContext || window.webkitAudioContext)();
  const buf = await ac.decodeAudioData(await file.arrayBuffer());
  await ac.close();
  return buf;
}

/* Builds the ducked track: the shell's chapter envelope applied as gain,
   padded with silence to the full picture length. This replaces the ffmpeg
   -af string the shell used to hand over, and comes from the same curve
   rather than a second implementation that can drift from it. */
function buildAudio(srcBuf, TOTAL, audioDur, env, fadeA, gain) {
  const sr = srcBuf.sampleRate;
  const chs = Math.min(2, srcBuf.numberOfChannels);
  const outLen = Math.ceil(TOTAL * sr);
  const out = [];
  for (let c = 0; c < chs; c++) out.push(new Float32Array(outLen));
  const fadeEnd = Math.min(audioDur, TOTAL);
  for (let c = 0; c < chs; c++) {
    const src = srcBuf.getChannelData(c);
    const n = Math.min(src.length, outLen);
    const dst = out[c];
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      let g = env(t, fadeA);
      /* envelope() tapers at TOTAL, but the audio stops at audioDur; without
         this the mix would end abruptly under the outro card. */
      if (fadeA > 0 && fadeEnd - t < fadeA) g = Math.min(g, Math.max(0, (fadeEnd - t) / fadeA));
      dst[i] = src[i] * g * gain;
    }
  }
  return { channels: out, sampleRate: sr, numberOfChannels: chs, length: outLen };
}

/* ----------------------------------------------------------------- render */

async function render() {
  if (S.running) return;
  S.running = true; S.cancel = false;
  $('bRender').disabled = true; $('bCancel').disabled = false;
  clearLog();
  const started = performance.now();

  try {
    const B = bridge();
    const TOTAL = B.TOTAL;
    const CHAPTERS = B.CHAPTERS;
    const fps = +$('fps').value;
    const bitrate = +$('br').value;
    const fadeV = $('pfade').checked ? (B.FADE_V != null ? B.FADE_V : 0.45) : 0;
    const fadeA = $('afade').checked ? (B.FADE_A != null ? B.FADE_A : 0.45) : 0;

    const caps = await probeCodecs(bitrate);
    const want = $('fmtsel').value;
    const totalFramesEarly = Math.round(TOTAL * fps);

    /* Verify the fast rasteriser before benching — the bench encodes real
       frames, so it needs to know which path produces them. */
    setProg(0, 'Checking rasteriser…');
    const par0 = await runParity(3);
    S.mode = par0.ok ? 'fast' : 'shell';
    if (par0.ok) log(`Fast rasteriser verified pixel-identical — ${par0.fastMs.toFixed(0)}ms/frame (shell path ${par0.shellMs.toFixed(0)}ms)`, 'ok');
    else log(`Fast rasteriser differs (max channel ${par0.worst}) — falling back to the shell path`, 'warn');

    let profile = chosenProfile();
    if (!profile || ($('encsel').value === 'auto' && benchIsStale(want, bitrate, fps))) {
      profile = await benchEncoders(want, bitrate, fps, totalFramesEarly);
      if (!profile) throw new Error('No encoder configuration completed the benchmark.');
    } else {
      log(`Encoder — ${profile.label}${$('encsel').value === 'auto' ? ' (fastest measured)' : ' (pinned)'}`, 'ok');
    }
    const pick = pickFromProfile(profile, caps);
    if (pick.err) throw new Error(pick.err);

    const env = makeEnvelope(CHAPTERS, TOTAL);
    const chk = verifyEnvelope(env);
    if (chk.ok) log('Fade curve matches the shell exactly', 'ok');
    else log(`Fade curve differs from the shell (max ${chk.worst}) — ${chk.why || 'using local curve'}`, 'warn');

    const wantAudio = !!S.audioBuf;
    if (wantAudio && !pick.audioOk) log(`No ${pick.ashort} encoder — writing video only`, 'warn');
    const withAudio = wantAudio && pick.audioOk;

    const totalFrames = Math.round(TOTAL * fps);
    log(`Writing .${pick.ext} · ${pick.vshort}${withAudio ? ' + ' + pick.ashort : ''} · ${totalFrames} frames @ ${fps}fps · ${(bitrate / 1e6).toFixed(0)} Mbps`);

    const benchBest = S.encBench && S.encBench.filter(r => r.ok).find(r => r.p.id === profile.id);
    const rasterMs = par0.ok ? par0.fastMs : par0.shellMs;
    const encMs = benchBest ? 1000 / benchBest.fps : rasterMs;
    log(`Estimated ${fmt(totalFrames * Math.max(rasterMs, encMs) / 1000)} of rendering`);

    /* An hour of 1080p at 16 Mbps is over a gigabyte. Held in an
       ArrayBuffer that gets the tab killed, so stream it to disk. */
    const base = (B.EPISODE.id || 'EP') + '_Master.' + pick.ext;
    const Muxer = pick.container === 'mp4' ? Mp4Muxer : WebMMuxer;
    let target, fileStream = null;
    if (window.showSaveFilePicker) {
      try {
        const handle = await window.showSaveFilePicker({
          suggestedName: base,
          types: [{ description: pick.ext.toUpperCase() + ' video', accept: { ['video/' + pick.ext]: ['.' + pick.ext] } }],
        });
        fileStream = await handle.createWritable();
        target = new Muxer.FileSystemWritableFileStreamTarget(fileStream);
        log('Streaming straight to disk — memory stays flat', 'ok');
      } catch (e) {
        if (e && e.name === 'AbortError') { log('Save cancelled — nothing rendered.', 'warn'); setProg(0, 'Cancelled'); return; }
        log('Could not open a file for writing (' + e.message + ') — buffering in RAM instead.', 'warn');
        target = new Muxer.ArrayBufferTarget();
      }
    }
    if (!target) {
      target = new Muxer.ArrayBufferTarget();
      log('No File System Access API — buffering in RAM. Long episodes may exhaust the tab.', 'warn');
    }

    try { if (navigator.wakeLock) S.wake = await navigator.wakeLock.request('screen'); } catch (e) {}

    const muxCfg = {
      target,
      video: { codec: pick.container === 'mp4' ? 'avc' : 'V_VP9', width: 1920, height: 1080, frameRate: fps },
    };
    /* moov goes at the end when streaming: an in-memory fast start would
       defeat the point. Fine for a YouTube master and for local playback. */
    if (pick.container === 'mp4') muxCfg.fastStart = fileStream ? false : 'in-memory';
    if (withAudio) {
      muxCfg.audio = {
        codec: pick.container === 'mp4' ? 'aac' : 'A_OPUS',
        numberOfChannels: S.audioBuf.numberOfChannels >= 2 ? 2 : 1,
        sampleRate: S.audioBuf.sampleRate,
      };
    }
    const muxer = new Muxer.Muxer(muxCfg);

    let encErr = null;
    const venc = new VideoEncoder({
      output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
      error: e => { encErr = e; },
    });
    /* The fix. Without hardwareAcceleration the browser picked software H.264
       and delivered 9.4fps on a machine with an idle hardware encoder. */
    venc.configure({
      codec: pick.vcodec, width: 1920, height: 1080,
      bitrate, framerate: fps,
      hardwareAcceleration: pick.acc,
      latencyMode: pick.lat,
      ...(pick.container === 'mp4' ? { avc: { format: 'avc' } } : {}),
    });

    /* ---- audio first: cheap, and a failure here should not waste an hour --- */
    if (withAudio) {
      setProg(0, 'Encoding audio…');
      const audioDur = (typeof B.EPISODE.audioDur === 'number') ? B.EPISODE.audioDur : TOTAL;
      const track = buildAudio(S.audioBuf, TOTAL, audioDur, env, fadeA, +$('vol').value / 100);
      const aenc = new AudioEncoder({
        output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
        error: e => { encErr = e; },
      });
      aenc.configure({
        codec: pick.acodec, sampleRate: track.sampleRate,
        numberOfChannels: track.numberOfChannels, bitrate: 192000,
      });
      const CH = 4096;
      for (let off = 0; off < track.length; off += CH) {
        const n = Math.min(CH, track.length - off);
        const inter = new Float32Array(n * track.numberOfChannels);
        for (let c = 0; c < track.numberOfChannels; c++) {
          const src = track.channels[c];
          for (let i = 0; i < n; i++) inter[i * track.numberOfChannels + c] = src[off + i];
        }
        const ad = new AudioData({
          format: 'f32', sampleRate: track.sampleRate,
          numberOfFrames: n, numberOfChannels: track.numberOfChannels,
          timestamp: Math.round(off / track.sampleRate * 1e6),
          data: inter,
        });
        aenc.encode(ad); ad.close();
        if (off % (CH * 200) === 0) await new Promise(r => setTimeout(r, 0));
      }
      await aenc.flush(); aenc.close();
      log(`Audio encoded — ${fmt(track.length / track.sampleRate)} at ${track.sampleRate}Hz`, 'ok');
    }

    /* ---- video ---------------------------------------------------------- */
    const cv = document.createElement('canvas'); cv.width = 1920; cv.height = 1080;
    const cx = cv.getContext('2d', { alpha: false });
    const gopSize = fps * 2;
    const usPerFrame = 1e6 / fps;
    let waitMs = 0;

    for (let f = 0; f < totalFrames; f++) {
      if (S.cancel) throw new Error('cancelled');
      if (encErr) throw encErr;
      const t = f / fps;
      const op = fadeV > 0 ? (0.06 + 0.94 * env(t, fadeV)) : 1;
      await rasterAt(t, cx, op, S.mode);

      /* The whole point: the timestamp is computed, not observed. A frame that
         took 800ms to draw is still stamped at exactly f/fps. */
      const vf = new VideoFrame(cv, {
        timestamp: Math.round(f * usPerFrame),
        duration: Math.round(usPerFrame),
      });
      venc.encode(vf, { keyFrame: f % gopSize === 0 });
      vf.close();

      if (venc.encodeQueueSize > QUEUE_HIGH) {
        const w0 = performance.now();
        while (venc.encodeQueueSize > QUEUE_LOW) await new Promise(r => setTimeout(r, 2));
        waitMs += performance.now() - w0;
      }
      if (f % 10 === 0 || f === totalFrames - 1) {
        const el = (performance.now() - started) / 1000;
        const per = el / (f + 1);
        const left = (totalFrames - f - 1) * per;
        const stall = Math.round(waitMs / (el * 1000) * 100);
        setProg(f / totalFrames, `frame ${f + 1}/${totalFrames} · ${(per * 1000).toFixed(0)}ms/frame · ${stall}% waiting on encoder · ${fmt(left)} left`);
        await new Promise(r => setTimeout(r, 0));
      }
    }

    setProg(1, 'Finalising…');
    await venc.flush(); venc.close();
    if (encErr) throw encErr;
    muxer.finalize();

    const mins = (performance.now() - started) / 60000;
    if (fileStream) {
      await fileStream.close();
      log(`Done — written to ${base} in ${mins.toFixed(1)} min`, 'ok');
      log(`${(mins * 60000 / totalFrames).toFixed(0)}ms/frame · ${Math.round(waitMs / (mins * 600))}% of it waiting on the encoder`);
    } else {
      const blob = new Blob([target.buffer], { type: pick.container === 'mp4' ? 'video/mp4' : 'video/webm' });
      download(blob, base);
      log(`Done — ${(blob.size / 1048576).toFixed(1)} MB in ${mins.toFixed(1)} min`, 'ok');
    }
    setProg(1, 'Done');
  } catch (e) {
    log('FAILED: ' + (e.message || e), 'err');
    setProg(0, 'Failed');
  } finally {
    S.running = false;
    try { if (S.wake) { await S.wake.release(); S.wake = null; } } catch (e) {}
    $('bRender').disabled = false; $('bCancel').disabled = true;
  }
}

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
}

/* ---------------------------------------------------------- contact sheets */

async function sheets() {
  if (S.running) return;
  S.running = true; S.cancel = false;
  $('bSheets').disabled = true; $('bCancel').disabled = false;
  clearLog();
  try {
    const B = bridge();
    const beats = B.TIMELINE, CHAPTERS = B.CHAPTERS;
    const at = +$('fillat').value / 100;
    const cols = +$('cols').value;
    const CW = 480, CH_ = 270;

    const issues = S.win.__ISSUES__;
    if (Array.isArray(issues) && issues.length) {
      log(`Validator: ${issues.length} issue(s)`, 'err');
      issues.forEach(i => log('   ' + i, 'err'));
    } else log('Validator: clean', 'ok');

    const cv = document.createElement('canvas'); cv.width = 1920; cv.height = 1080;
    const cx = cv.getContext('2d', { alpha: false });

    const groups = new Map();
    for (const b of beats) {
      const c = (b.ch != null) ? b.ch : (S.win.chapterAt ? S.win.chapterAt(b.t).n : 1);
      if (!groups.has(c)) groups.set(c, []);
      groups.get(c).push(b);
    }

    let done = 0;
    const index = [];
    for (const [ch, list] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
      const rows = Math.ceil(list.length / cols);
      const sheet = document.createElement('canvas');
      sheet.width = cols * CW + (cols + 1) * 8;
      sheet.height = rows * CH_ + (rows + 1) * 8;
      const sx = sheet.getContext('2d');
      sx.fillStyle = '#2A2520'; sx.fillRect(0, 0, sheet.width, sheet.height);

      for (let n = 0; n < list.length; n++) {
        if (S.cancel) throw new Error('cancelled');
        const b = list[n];
        const t = b.t + b.dur * at;
        await rasterAt(t, cx, 1, S.mode);
        const r = Math.floor(n / cols), c = n % cols;
        sx.drawImage(cv, 8 + c * (CW + 8), 8 + r * (CH_ + 8), CW, CH_);
        index.push(`ch${ch} r${r + 1}c${c + 1}  ${b.design}  t=${b.t.toFixed(2)}s dur=${b.dur.toFixed(2)}s shot@${t.toFixed(2)}s`);
        done++;
        setProg(done / beats.length, `beat ${done}/${beats.length}`);
        await new Promise(r2 => setTimeout(r2, 0));
      }
      const title = (CHAPTERS.find(c => c.n === ch) || {}).title || ('ch' + ch);
      await new Promise(res => sheet.toBlob(bl => {
        download(bl, `${B.EPISODE.id}_sheet_ch${String(ch).padStart(2, '0')}.png`); res();
      }, 'image/png'));
      log(`sheet ch${ch} — ${list.length} beats — ${title}`, 'ok');
    }
    download(new Blob([index.join('\n')], { type: 'text/plain' }), `${B.EPISODE.id}_sheets_INDEX.txt`);
    setProg(1, 'Sheets done');
  } catch (e) {
    log('FAILED: ' + (e.message || e), 'err');
  } finally {
    S.running = false;
    $('bSheets').disabled = false; $('bCancel').disabled = true;
  }
}

/* -------------------------------------------------------------------- wire */

function ready(fn) {
  if (document.readyState !== 'loading') fn();
  else document.addEventListener('DOMContentLoaded', fn);
}

ready(() => {
  const enable = on => ['bInspect', 'bSheets', 'bRender'].forEach(i => $(i).disabled = !on);
  enable(false);

  $('fHtml').onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    clearLog(); enable(false);
    log(`Loading ${f.name}…`);
    if (await loadEpisode(f)) {
      try { const B = bridge(); log(`${B.EPISODE.id} · ${fmt(B.TOTAL)} · ${B.TIMELINE.length} beats`, 'ok'); enable(true); }
      catch (err) { log(err.message, 'err'); }
    }
  };
  $('fAudio').onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    try {
      S.audioBuf = await decodeAudio(f); S.audioName = f.name;
      log(`Audio ${f.name} — ${fmt(S.audioBuf.duration)} @ ${S.audioBuf.sampleRate}Hz`, 'ok');
      try {
        const B = bridge();
        const narrated = (typeof B.EPISODE.audioDur === 'number') ? B.EPISODE.audioDur : B.TOTAL;
        const drift = S.audioBuf.duration - narrated;
        if (Math.abs(drift) > 1) log(`Audio is ${drift > 0 ? '+' : ''}${drift.toFixed(2)}s against the narration — wrong mix, or captions do not match it`, 'warn');
      } catch (_) {}
    } catch (err) { log('Could not decode that audio: ' + err.message, 'err'); }
  };
  $('bInspect').onclick = () => inspect().catch(e => log(e.message, 'err'));
  $('bSheets').onclick = sheets;
  $('bRender').onclick = render;
  $('bCancel').onclick = () => { S.cancel = true; log('Cancelling…', 'warn'); };

  if (typeof VideoEncoder === 'undefined') {
    log('This browser has no WebCodecs. Use desktop Chrome or Edge.', 'err');
  }
});
