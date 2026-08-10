/* @mpd-version render-web 1
   mpd-render-web — deterministic browser render for MPD video shells.

   The shell's export loop was already deterministic: it paints from a frame
   index, never the wall clock. What broke the 9m24s export was MediaRecorder,
   which stamps frames as they arrive, so 190ms-per-frame rasterisation became
   a 53-minute file. WebCodecs takes the timestamp as an argument instead, so
   frame n is stamped n/fps no matter how long it took to draw.
*/

const $ = id => document.getElementById(id);
const S = {
  win: null, doc: null, live: null, html: null,
  audioBuf: null, audioName: '', htmlName: '',
  cancel: false, running: false,
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

  const ms = await benchRaster(8);
  const fps = +$('fps').value;
  const frames = Math.round(B.TOTAL * fps);
  log(`Raster ${ms.toFixed(0)}ms/frame → ${frames} frames ≈ ${fmt(frames * ms / 1000)} to render`);
  setProg(0, 'Inspect done');
}

async function benchRaster(n) {
  const B = bridge();
  const cv = document.createElement('canvas'); cv.width = 1920; cv.height = 1080;
  const cx = cv.getContext('2d', { alpha: false });
  const t0 = performance.now();
  for (let i = 0; i < n; i++) await rasterAt(B.TOTAL * (i + 0.5) / n, cx, 1);
  return (performance.now() - t0) / n;
}

/* ------------------------------------------------------------ rasterising */

/* Uses the shell's own serializeFrame(), so the pixels are the ones the shell
   would have produced. Fonts are inlined into every frame, which roughly
   doubles decode cost, but an SVG loaded as an image cannot fetch anything and
   without them every glyph falls back to a serif. */
function rasterAt(t, ctx, opacity) {
  S.win.paint(t);
  S.live.style.opacity = opacity;
  const svg = S.win.serializeFrame();
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
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error(`frame decode failed at t=${t.toFixed(2)}s`)); };
    img.src = url;
  });
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
    const pick = chooseContainer(caps, $('fmtsel').value);
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

    const Muxer = pick.container === 'mp4' ? Mp4Muxer : WebMMuxer;
    const target = new Muxer.ArrayBufferTarget();
    const muxCfg = {
      target,
      video: { codec: pick.container === 'mp4' ? 'avc' : 'V_VP9', width: 1920, height: 1080, frameRate: fps },
    };
    if (pick.container === 'mp4') muxCfg.fastStart = 'in-memory';
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
    venc.configure({
      codec: pick.vcodec, width: 1920, height: 1080,
      bitrate, framerate: fps,
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

    for (let f = 0; f < totalFrames; f++) {
      if (S.cancel) throw new Error('cancelled');
      if (encErr) throw encErr;
      const t = f / fps;
      const op = fadeV > 0 ? (0.06 + 0.94 * env(t, fadeV)) : 1;
      await rasterAt(t, cx, op);

      /* The whole point: the timestamp is computed, not observed. A frame that
         took 800ms to draw is still stamped at exactly f/fps. */
      const vf = new VideoFrame(cv, {
        timestamp: Math.round(f * usPerFrame),
        duration: Math.round(usPerFrame),
      });
      venc.encode(vf, { keyFrame: f % gopSize === 0 });
      vf.close();

      if (venc.encodeQueueSize > 8) {
        while (venc.encodeQueueSize > 4) await new Promise(r => setTimeout(r, 4));
      }
      if (f % 10 === 0 || f === totalFrames - 1) {
        const el = (performance.now() - started) / 1000;
        const per = el / (f + 1);
        const left = (totalFrames - f - 1) * per;
        setProg(f / totalFrames, `frame ${f + 1}/${totalFrames} · ${(per * 1000).toFixed(0)}ms/frame · ${fmt(left)} left`);
        await new Promise(r => setTimeout(r, 0));
      }
    }

    setProg(1, 'Finalising…');
    await venc.flush(); venc.close();
    if (encErr) throw encErr;
    muxer.finalize();

    const blob = new Blob([target.buffer], { type: pick.container === 'mp4' ? 'video/mp4' : 'video/webm' });
    const base = (B.EPISODE.id || 'EP') + '_Master';
    download(blob, `${base}.${pick.ext}`);
    const mins = (performance.now() - started) / 60000;
    log(`Done — ${(blob.size / 1048576).toFixed(1)} MB in ${mins.toFixed(1)} min`, 'ok');
    setProg(1, 'Done');
  } catch (e) {
    log('FAILED: ' + (e.message || e), 'err');
    setProg(0, 'Failed');
  } finally {
    S.running = false;
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
        await rasterAt(t, cx, 1);
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
