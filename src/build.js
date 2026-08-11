/* @mpd-version render-web 5
   Bundles src/ into the single-file index.html at the repo root.
   Run from anywhere: node src/build.js */
const fs = require('fs');
const path = require('path');
const SRC = __dirname;
const ROOT = path.resolve(SRC, '..');

let html = fs.readFileSync(path.join(SRC, 'shell.html'), 'utf8');

/* Replacement values contain `$` sequences that String.replace would treat as
   special patterns and silently corrupt. Function replacers are mandatory. */
const sub = (needle, file) => {
  if (!html.includes(needle)) { console.error('missing placeholder ' + needle); process.exit(1); }
  html = html.replace(needle, () => fs.readFileSync(path.join(SRC, file), 'utf8'));
};

sub('/*__MP4MUXER__*/', 'vendor_mp4.js');
sub('/*__WEBMMUXER__*/', 'vendor_webm.js');
sub('/*__APP__*/', 'app.js');

const out = path.join(ROOT, 'index.html');
fs.writeFileSync(out, html);
console.log('built ' + out + ' — ' + (html.length / 1024).toFixed(0) + ' KB');
