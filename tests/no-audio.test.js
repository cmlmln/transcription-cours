// Garde-fou : aucun code de capture ou de stockage audio, aucune requête vers l'extérieur.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const files = ['index.html', 'sw.js', 'manifest.webmanifest', ...readdirSync(join(root, 'js')).map((f) => 'js/' + f)];
const src = (f) => readFileSync(join(root, f), 'utf8');
const code = (f) => src(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1').replace(/<!--[\s\S]*?-->/g, '');

test('MediaRecorder n’est référencé nulle part', () => {
  for (const f of files) assert.ok(!/MediaRecorder/.test(src(f).replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')), f);
  for (const f of files) assert.ok(!/MediaRecorder/.test(src(f)), `${f} (même en commentaire)`);
});

test('aucune autre API de capture audio', () => {
  for (const f of files) {
    const c = code(f);
    for (const bad of ['getUserMedia', 'AudioContext', 'webkitAudioContext', 'AudioWorklet', 'createMediaStreamSource', 'captureStream'])
      assert.ok(!c.includes(bad), `${bad} dans ${f}`);
  }
});

test('aucune URL externe ni analytics', () => {
  for (const f of files) {
    const c = code(f);
    assert.ok(!/https?:\/\//.test(c.replace(/http:\/\/www\.w3\.org\/2000\/svg/g, '')), `URL externe dans ${f}`);
    assert.ok(!/sendBeacon|XMLHttpRequest|WebSocket|EventSource/.test(c), f);
  }
  // fetch seulement dans le service worker (shell de l'app, même origine)
  for (const f of files.filter((f) => f !== 'sw.js')) assert.ok(!/\bfetch\s*\(/.test(code(f)), `fetch dans ${f}`);
});

test('CSP stricte : aucune connexion hors de l’origine', () => {
  assert.match(src('index.html'), /Content-Security-Policy[^>]*default-src 'self'/);
});

test('le commentaire d’en-tête rappelle la règle zéro audio', () => {
  assert.match(src('js/supervisor.js').split('\n')[0], /ZÉRO AUDIO/);
  assert.match(src('js/ui.js').split('\n')[0], /ZÉRO AUDIO/);
});

test('version identique dans l’app et le service worker', () => {
  const v1 = src('js/version.js').match(/VERSION = '([^']+)'/)[1];
  const v2 = src('sw.js').match(/VERSION = '([^']+)'/)[1];
  assert.equal(v1, v2);
});

test('tous les fichiers du shell mis en cache existent', () => {
  const list = src('sw.js').match(/SHELL = \[([\s\S]*?)\]/)[1].match(/'([^']+)'/g).map((s) => s.slice(1, -1));
  for (const f of list) if (f !== './') readFileSync(join(root, f));
});
