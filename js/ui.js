// ⚠️ ZÉRO AUDIO. Aucun son n'est jamais enregistré ni stocké : seule l'API
// SpeechRecognition (via le superviseur) est utilisée, et elle ne livre que du texte.

import { RecognitionSupervisor } from './supervisor.js';
import { MockWorld, MockRecognition } from './mock.js';
import { Storage, IDBBackend, LocalStorageBackend, MemoryBackend, newSession, recoverSession } from './storage.js';
import { buildExport, parseGlossary, compileGlossary, segText, gapText, formatDuration, fileName, hhmm, countWords, sessionDuration } from './export.js';
import { WakeLockManager } from './wakelock.js';
import { VERSION } from './version.js';

const $ = (s) => document.querySelector(s);
const MOCK = new URLSearchParams(location.search).get('mock') === '1';
const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const STANDALONE = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const MARKER_MS = 5 * 60 * 1000;
const STALE_MS = 30000;

// ---------- journal (200 derniers événements) ----------
const LOG = [];
let logDirty = false;
function log(type, data = {}) {
  const { t, ...rest } = data;
  LOG.push({ t: Date.now(), type, ...rest });
  if (LOG.length > 200) LOG.shift();
  if (!$('#sheet-diag').hidden && !logDirty) { logDirty = true; requestAnimationFrame(renderDiag); }
}
const fmtLog = (e) => {
  const { t, type, ...rest } = e;
  const d = new Date(t);
  const ts = d.toTimeString().slice(0, 8) + '.' + String(d.getMilliseconds()).padStart(3, '0');
  const extra = Object.entries(rest).map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' ');
  return `${ts} ${type}${extra ? ' ' + extra : ''}`;
};
addEventListener('error', (e) => log('js-erreur', { message: e.message, src: `${e.filename}:${e.lineno}` }));
addEventListener('unhandledrejection', (e) => log('promesse-rejetee', { message: String(e.reason && e.reason.message || e.reason) }));

// ---------- réglages ----------
const DEFAULTS = { font: 26, continuous: 'auto', watchdogSec: 12, glossary: 'en tropie → entropie', clean: true, video: false };
const settings = (() => {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('tc.settings') || '{}') }; } catch { return { ...DEFAULTS }; }
})();
const saveSettings = () => { try { localStorage.setItem('tc.settings', JSON.stringify(settings)); } catch { /* réglages non persistés */ } };
const continuousFor = () => (settings.continuous === 'on' ? true : settings.continuous === 'off' ? false : !IS_IOS);
let glossary = parseGlossary(settings.glossary);
let compiled = compileGlossary(glossary);

// ---------- stockage ----------
const backends = [];
try { if (window.indexedDB) backends.push(new IDBBackend()); } catch (e) { log('idb-indisponible', { message: e.message }); }
try {
  localStorage.setItem('tc.probe', '1'); localStorage.removeItem('tc.probe');
  backends.push(new LocalStorageBackend());
} catch (e) { log('localstorage-indisponible', { message: e.message }); }
if (!backends.length) backends.push(new MemoryBackend());
const storage = new Storage(backends, { onError: (m) => log('stockage-erreur', { message: m }) });

// ---------- état de l'app ----------
let current = null;        // session affichée
let pendingResume = null;  // session interrompue proposée à la reprise
let exportTarget = null;
let editing = false;
let lastTextAt = 0;
let lastListeningAt = 0;
let lastErrorCode = '';
let hiddenAt = 0;
let restartsBase = 0;
let wordCount = 0;
let lastBucket = null;
let savedInterim = '';
let follow = true;
let testSup = null;

// ---------- moteur ----------
const world = MOCK ? new MockWorld({ pauseProb: 0.01, pauseMs: [3000, 40000] }) : null;
const factory = MOCK
  ? () => new MockRecognition(world)
  : () => {
    const C = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!C) throw new Error('SpeechRecognition absent');
    return new C();
  };

const sup = new RecognitionSupervisor({
  factory,
  continuous: continuousFor(),
  watchdogMs: settings.watchdogSec * 1000,
  onFinal,
  onInterim,
  onState,
  onLog: (e) => { if (e.type === 'error') lastErrorCode = e.code; log(e.type, e); },
  onAlert: (a) => {
    if (a === 'audio-capture') banner('audio', 'Micro indisponible (audio-capture). Nouvelles tentatives en cours — vérifie qu’aucune autre app (appel, Dictaphone…) n’utilise le micro.', 'orange', { dismiss: true });
  },
});

// Persistance AVANT toute mise à jour de l'UI (localStorage est écrit de façon synchrone).
function persist() {
  if (!current) return;
  storage.save(current).then(() => clearBanner('storage'), () => {
    banner('storage', 'Échec de l’enregistrement ! Exporte ou copie le texte maintenant.', 'red');
  });
}

function onFinal(text) {
  if (!current) current = startNewSession();
  const seg = { t: Date.now(), text, kind: 'final' };
  current.segments.push(seg);
  current.interim = '';
  persist();
  lastTextAt = Date.now();
  appendSeg(seg, current.segments.length - 1);
  updateCounters();
}

function onInterim(text) {
  if (current) current.interim = text;
  if (text) lastTextAt = Date.now();
  const el = $('#interim');
  el.textContent = text ? segText({ text }, compiled) : '';
  scheduleScroll();
}

function onState(state) {
  if (state === 'listening') lastListeningAt = Date.now();
  if (state === 'stopped' && sup.fatal) {
    banner('fatal', fatalMessage(sup.fatal), 'red');
    if (!sup.wanted) wake.release();
  }
  renderStatus();
  renderButtons();
}

function fatalMessage(f) {
  if (f.code === 'unsupported') {
    return 'Reconnaissance vocale indisponible ici. Sur iPad : Safari à jour (iPadOS 17 ou plus). Si l’app est ouverte depuis l’écran d’accueil, essaie dans un onglet Safari.';
  }
  if (!f.fromGesture) return 'iOS a refusé la relance automatique. Touche « Démarrer » pour reprendre (le texte est conservé).';
  return 'Micro refusé. Sur iPad : Réglages › Safari › Microphone → « Autoriser », puis recharge la page. '
    + 'Vérifie aussi que la Dictée est activée (Réglages › Général › Clavier).';
}

// ---------- veille ----------
const wake = new WakeLockManager({
  onChange: renderWake,
  onLog: (type, d) => log(type, d),
});
function renderWake() {
  const bad = !wake.supported || (wake.wanted && !wake.active && wake.error);
  if (bad) banner('wake', 'Mets le verrouillage automatique sur « Jamais » : Réglages › Luminosité et affichage › Verrouillage automatique.', 'red');
  else clearBanner('wake');
}

// ---------- bandeaux ----------
const banners = new Map();
function banner(key, text, level = 'red', { dismiss = false, actions = [] } = {}) {
  let el = banners.get(key);
  if (!el) {
    el = document.createElement('div');
    banners.set(key, el);
    $('#banners').appendChild(el);
  }
  el.className = 'banner ' + level;
  el.textContent = '';
  const span = document.createElement('span');
  span.textContent = text;
  el.appendChild(span);
  for (const [label, fn] of actions) {
    const b = document.createElement('button');
    b.textContent = label;
    b.addEventListener('click', fn);
    el.appendChild(b);
  }
  if (dismiss) {
    const b = document.createElement('button');
    b.textContent = 'OK';
    b.addEventListener('click', () => clearBanner(key));
    el.appendChild(b);
  }
}
function clearBanner(key) {
  const el = banners.get(key);
  if (el) { el.remove(); banners.delete(key); }
}

// ---------- rendu du fil ----------
const transcript = $('#transcript');
const interimEl = $('#interim');

function renderAll() {
  transcript.textContent = '';
  transcript.appendChild(interimEl);
  lastBucket = null;
  if (current) current.segments.forEach((s, i) => appendSeg(s, i, false));
  interimEl.textContent = current && current.interim ? segText({ text: current.interim }, compiled) : '';
  $('#title').value = current ? current.title : '';
  $('#title').disabled = !current;
  $('#empty').hidden = !!current;
  if (editing) setEditable(true);
  updateCounters();
  follow = true;
  scheduleScroll();
  renderButtons();
}

function appendSeg(seg, i, scroll = true) {
  const b = Math.floor(seg.t / MARKER_MS);
  if (b !== lastBucket) {
    lastBucket = b;
    const m = document.createElement('div');
    m.className = 'marker';
    m.textContent = `— ${hhmm(b * MARKER_MS)} —`;
    transcript.insertBefore(m, interimEl);
  }
  const sp = document.createElement('span');
  if (seg.kind === 'gap') {
    sp.className = 'gap';
    sp.textContent = gapText(seg);
  } else {
    sp.className = 'seg';
    sp.dataset.i = i;
    sp.textContent = segText(seg, compiled);
    if (editing) sp.contentEditable = 'true';
  }
  transcript.insertBefore(sp, interimEl);
  transcript.insertBefore(document.createTextNode(' '), interimEl);
  $('#empty').hidden = true;
  if (scroll) scheduleScroll();
}

function updateCounters() {
  wordCount = current ? countWords(current.segments) : 0;
  $('#words').textContent = `${wordCount} mot${wordCount > 1 ? 's' : ''}`;
}

// Auto-scroll : suit le direct, sauf si l'utilisateur remonte.
const scroller = $('#scroller');
let scrollQueued = false;
function scheduleScroll() {
  if (scrollQueued || !follow) return;
  scrollQueued = true;
  requestAnimationFrame(() => { scrollQueued = false; if (follow) scroller.scrollTop = scroller.scrollHeight; });
}
scroller.addEventListener('scroll', () => {
  const atBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
  follow = atBottom;
  $('#live').hidden = atBottom;
}, { passive: true });
$('#live').addEventListener('click', () => { follow = true; $('#live').hidden = true; scheduleScroll(); });

// ---------- indicateur d'état ----------
function renderStatus() {
  const now = Date.now();
  const s = sup.state;
  if (s === 'listening') lastListeningAt = now;
  let cls, label;
  if (sup.wanted || s === 'paused-background') {
    // Sur iOS, les relances entre phrases durent < 0,5 s : on ne passe à l'orange
    // que si l'écoute est vraiment interrompue (> 1,5 s), pour éviter le clignotement.
    const effectivelyListening = s === 'listening' || (now - lastListeningAt < 1500 && s !== 'error');
    if (effectivelyListening) {
      const ago = now - lastTextAt;
      if (ago > STALE_MS) { cls = 'orange blink'; label = 'En écoute — silence'; }
      else { cls = 'green'; label = 'En écoute'; }
    } else {
      cls = 'orange';
      label = s === 'error' && lastErrorCode ? `Relance… (${lastErrorCode})` : 'Relance…';
    }
  } else if (sup.fatal) { cls = 'red'; label = 'Problème'; }
  else if (current && !current.endedAt) { cls = 'red'; label = 'En pause'; }
  else { cls = 'red'; label = 'Arrêté'; }
  const pill = $('#status');
  if (pill.className !== 'pill ' + cls) pill.className = 'pill ' + cls;
  if ($('#status-label').textContent !== label) $('#status-label').textContent = label;

  const la = $('#last-ago');
  if (sup.wanted) {
    const sec = Math.floor((now - lastTextAt) / 1000);
    la.textContent = `Dernier texte reçu il y a ${sec} s`;
    la.classList.toggle('stale', now - lastTextAt > STALE_MS);
  } else { la.textContent = '—'; la.classList.remove('stale'); }

  const dur = current ? sessionDurationLive(current, now) : 0;
  const s2 = Math.floor(dur / 1000);
  $('#chrono').textContent = [Math.floor(s2 / 3600), Math.floor(s2 / 60) % 60, s2 % 60].map((n) => String(n).padStart(2, '0')).join(':');
  const r = Math.max(0, sup.restarts - restartsBase);
  $('#restarts').textContent = `${r} relance${r > 1 ? 's' : ''}`;
}
const sessionDurationLive = (s, now) => (s.endedAt ? sessionDuration(s) : now - s.startedAt);

function renderButtons() {
  const listening = sup.wanted;
  $('#btn-start').disabled = listening || !!testSup;
  $('#btn-start').textContent = current && !current.endedAt && !listening ? 'Reprendre' : 'Démarrer';
  $('#btn-pause').disabled = !listening;
  $('#btn-stop').disabled = !current || !!current.endedAt;
  $('#btn-edit').disabled = listening || !current;
  $('#btn-edit').textContent = editing ? 'Terminer l’édition' : 'Modifier';
  $('#title').disabled = !current;
}

setInterval(renderStatus, 500);

// Sauvegarde de l'intermédiaire en cours toutes les 2 s.
setInterval(() => {
  if (current && current.interim !== savedInterim) { savedInterim = current.interim; persist(); }
}, 2000);

// ---------- sessions ----------
function startNewSession() {
  if (pendingResume) { // l'utilisateur a préféré une nouvelle session : on clôt l'ancienne
    pendingResume.endedAt = pendingResume.updatedAt || Date.now();
    storage.save(pendingResume).catch(() => {});
    pendingResume = null;
    clearBanner('resume');
  }
  const s = newSession();
  current = s;
  restartsBase = sup.restarts;
  renderAll();
  return s;
}

function beginListening() {
  // iOS : start() DOIT être appelé de façon synchrone dans le gestionnaire du tap,
  // sans aucun await avant — sinon Safari refuse l'accès au micro.
  sup.continuous = continuousFor();
  sup.watchdogMs = settings.watchdogSec * 1000;
  sup.start({ gesture: true });
  lastTextAt = Date.now();
  clearBanner('fatal');
  wake.acquire();
  if (settings.video) wake.startVideo();
}

$('#btn-start').addEventListener('click', () => {
  if (editing) setEditable(false);
  beginListening();
  if (!current || current.endedAt) startNewSession();
  persist();
  renderButtons();
  renderStatus();
});

$('#btn-pause').addEventListener('click', () => {
  sup.stop();
  wake.release();
  persist();
  log('pause');
  renderButtons();
});

$('#btn-stop').addEventListener('click', () => {
  sup.stop();
  wake.release();
  if (current) { current.endedAt = Date.now(); persist(); }
  log('arret');
  renderButtons();
  renderStatus();
});

function resumeSession(s) {
  beginListening(); // synchrone, dans le tap
  if (pendingResume && pendingResume.id !== s.id) { pendingResume.endedAt = pendingResume.updatedAt; storage.save(pendingResume).catch(() => {}); }
  pendingResume = null;
  clearBanner('resume');
  current = recoverSession(s);
  current.endedAt = null;
  restartsBase = sup.restarts;
  persist();
  renderAll();
  closeSheets();
  log('reprise-session', { id: s.id });
}

$('#title').addEventListener('input', debounce(() => {
  if (!current) return;
  current.title = $('#title').value.trim() || current.title;
  persist();
}, 400));

// ---------- édition après coup ----------
function setEditable(on) {
  editing = on;
  transcript.classList.toggle('editing', on);
  for (const sp of transcript.querySelectorAll('.seg')) sp.contentEditable = on ? 'true' : 'false';
  if (!on) persist();
  renderButtons();
}
$('#btn-edit').addEventListener('click', () => { if (!sup.wanted && current) setEditable(!editing); });
const saveEdits = debounce(persist, 600);
transcript.addEventListener('input', (e) => {
  const sp = e.target.closest && e.target.closest('.seg');
  if (!sp || !current || sup.wanted) return;
  const seg = current.segments[+sp.dataset.i];
  if (!seg) return;
  seg.edit = sp.textContent;
  updateCounters();
  saveEdits();
});

// ---------- taille du texte ----------
function applyFont() { document.documentElement.style.setProperty('--font', settings.font + 'px'); }
$('#font-minus').addEventListener('click', () => { settings.font = Math.max(16, settings.font - 2); applyFont(); saveSettings(); });
$('#font-plus').addEventListener('click', () => { settings.font = Math.min(60, settings.font + 2); applyFont(); saveSettings(); });

// ---------- premier plan / arrière-plan ----------
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    if (sup.wanted) { hiddenAt = Date.now(); sup.pauseBackground(); log('arriere-plan'); }
    if (current) persist();
  } else {
    log('premier-plan');
    if (sup.state === 'paused-background') {
      const d = Date.now() - hiddenAt;
      if (current) {
        const seg = { t: hiddenAt, text: '', kind: 'gap', durationMs: d };
        current.segments.push(seg);
        persist();
        appendSeg(seg, current.segments.length - 1);
      }
      banner('gap', `Transcription interrompue pendant ${formatDuration(d)}`, 'orange', { dismiss: true });
      sup.continuous = continuousFor();
      sup.start({ gesture: false });
      lastTextAt = Date.now();
      wake.acquire();
    }
  }
});
addEventListener('pagehide', () => { if (current) persist(); });

// ---------- réseau ----------
function offlineBanner() {
  banner('offline', 'Hors ligne : la reconnaissance vocale de Safari a besoin d’internet. Reprise automatique au retour du réseau.', 'red');
}
addEventListener('offline', () => { log('hors-ligne'); offlineBanner(); });
addEventListener('online', () => { log('en-ligne'); clearBanner('offline'); sup.kick(); });
if (!navigator.onLine) offlineBanner();

// ---------- feuilles ----------
const SHEETS = ['#sheet-export', '#sheet-history', '#sheet-settings', '#sheet-diag'];
function openSheet(id) { closeSheets(); $(id).hidden = false; $(id).scrollTop = 0; }
function closeSheets() { for (const s of SHEETS) $(s).hidden = true; }
for (const s of SHEETS) $(s).querySelector('.close').addEventListener('click', closeSheets);

// ---------- export ----------
$('#btn-export').addEventListener('click', () => { exportTarget = current; openExport(); });
function openExport() {
  const s = exportTarget;
  $('#export-target').textContent = s ? `${s.title} — ${s.segments.length} segments` : 'Aucune session ouverte.';
  $('#opt-clean').checked = settings.clean;
  for (const b of document.querySelectorAll('[data-exp]')) b.disabled = !s;
  document.querySelector('[data-exp="share"]').hidden = !navigator.share;
  openSheet('#sheet-export');
}
$('#opt-clean').addEventListener('change', (e) => { settings.clean = e.target.checked; saveSettings(); });
for (const b of document.querySelectorAll('[data-exp]')) {
  b.addEventListener('click', () => {
    const s = exportTarget;
    if (!s) return;
    const mk = (format) => buildExport(s, { format, glossary, clean: settings.clean });
    const kind = b.dataset.exp;
    // Clipboard et Share doivent partir directement du tap (exigence iOS).
    if (kind === 'copy') copyText(mk('txt'), b);
    else if (kind === 'copy-plain') copyText(mk('plain'), b);
    else if (kind === 'txt') download(fileName(s, 'txt'), mk('txt'), 'text/plain');
    else if (kind === 'md') download(fileName(s, 'md'), mk('md'), 'text/markdown');
    else if (kind === 'plain') download(fileName({ title: s.title + ' (texte nu)' }, 'txt'), mk('plain'), 'text/plain');
    else if (kind === 'share') {
      navigator.share({ title: s.title, text: mk('txt') }).catch((e) => { if (e.name !== 'AbortError') log('partage-erreur', { message: e.message }); });
    }
  });
}

function flash(btn, text) {
  const old = btn.dataset.label || btn.textContent;
  btn.dataset.label = old;
  btn.textContent = text;
  setTimeout(() => { btn.textContent = old; }, 1600);
}

function copyText(text, btn) {
  const fallback = () => {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select(); ta.setSelectionRange(0, text.length);
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    flash(btn, ok ? 'Copié ✓' : 'Échec de la copie');
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => flash(btn, 'Copié ✓'), fallback);
  } else fallback();
}

function download(name, text, mime) {
  const url = URL.createObjectURL(new Blob([text], { type: mime + ';charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

// ---------- historique ----------
$('#btn-history').addEventListener('click', async () => { openSheet('#sheet-history'); await renderHistory(); });

async function renderHistory() {
  const ul = $('#history-list');
  ul.textContent = 'Chargement…';
  let list = [];
  try { list = await storage.list(); } catch (e) { ul.textContent = 'Stockage illisible : ' + e.message; return; }
  ul.textContent = '';
  if (!list.length) { ul.textContent = 'Aucune session enregistrée.'; return; }
  for (const s of list) {
    if (current && s.id === current.id) Object.assign(s, current); // version en mémoire = la plus fraîche
    ul.appendChild(historyItem(s));
  }
}

function historyItem(s) {
  const li = document.createElement('li');
  const d = new Date(s.startedAt);
  const title = document.createElement('div');
  title.className = 'h-title';
  title.textContent = s.title;
  if (!s.endedAt) {
    const badge = document.createElement('span');
    badge.className = 'open-badge';
    badge.textContent = current && current.id === s.id ? '(en cours)' : '(interrompue)';
    title.appendChild(badge);
  }
  const meta = document.createElement('div');
  meta.className = 'muted';
  meta.textContent = `${d.toLocaleDateString('fr-FR')} ${hhmm(s.startedAt)} · ${formatDuration(sessionDuration(s))} · ${countWords(s.segments)} mots`;
  const actions = document.createElement('div');
  actions.className = 'h-actions';
  const btn = (label, fn, disabled = false) => {
    const b = document.createElement('button');
    b.textContent = label; b.disabled = disabled;
    b.addEventListener('click', fn);
    actions.appendChild(b);
    return b;
  };
  const isCurrent = current && current.id === s.id;
  if (!s.endedAt && !isCurrent) btn('Reprendre', () => resumeSession(s), sup.wanted);
  else btn('Ouvrir', () => { if (editing) setEditable(false); current = s; restartsBase = sup.restarts; renderAll(); closeSheets(); }, sup.wanted || isCurrent);
  btn('Renommer', () => {
    actions.textContent = '';
    const inp = document.createElement('input');
    inp.value = s.title;
    actions.appendChild(inp);
    const ok = document.createElement('button');
    ok.textContent = 'Enregistrer';
    ok.addEventListener('click', async () => {
      const t = inp.value.trim();
      if (t) {
        if (isCurrent) { current.title = t; $('#title').value = t; persist(); }
        else { s.title = t; await storage.save(s).catch(() => {}); }
      }
      renderHistory();
    });
    actions.appendChild(ok);
    inp.focus();
  });
  btn('Exporter', () => { exportTarget = isCurrent ? current : s; openExport(); });
  btn('Supprimer', () => {
    actions.textContent = '';
    const q = document.createElement('span');
    q.className = 'confirm';
    q.textContent = 'Supprimer définitivement cette session ?';
    const yes = document.createElement('button');
    yes.textContent = 'Oui, supprimer';
    yes.addEventListener('click', async () => {
      await storage.delete(s.id).catch((e) => log('suppression-erreur', { message: e.message }));
      if (current && current.id === s.id) { current = null; renderAll(); }
      if (pendingResume && pendingResume.id === s.id) { pendingResume = null; clearBanner('resume'); }
      renderHistory();
    });
    const no = document.createElement('button');
    no.textContent = 'Annuler';
    no.addEventListener('click', renderHistory);
    actions.append(q, yes, no);
  }, sup.wanted && isCurrent);
  li.append(title, meta, actions);
  return li;
}

// ---------- réglages ----------
$('#btn-settings').addEventListener('click', () => {
  $('#opt-glossary').value = settings.glossary;
  $('#opt-continuous').value = settings.continuous;
  $('#opt-watchdog').value = settings.watchdogSec;
  $('#opt-video').checked = settings.video;
  $('#version').textContent = VERSION + (MOCK ? ' (mode démo)' : '');
  openSheet('#sheet-settings');
});
$('#opt-glossary').addEventListener('input', debounce(() => {
  settings.glossary = $('#opt-glossary').value;
  glossary = parseGlossary(settings.glossary);
  compiled = compileGlossary(glossary);
  saveSettings();
  renderAll();
}, 500));
$('#opt-continuous').addEventListener('change', (e) => {
  settings.continuous = e.target.value; saveSettings();
  sup.continuous = continuousFor(); // pris en compte à la prochaine instance
  log('reglage', { continuous: sup.continuous });
});
$('#opt-watchdog').addEventListener('change', (e) => {
  settings.watchdogSec = Math.min(60, Math.max(5, Math.round(+e.target.value || 12)));
  e.target.value = settings.watchdogSec;
  sup.watchdogMs = settings.watchdogSec * 1000;
  saveSettings();
});
$('#opt-video').addEventListener('change', (e) => {
  settings.video = e.target.checked; saveSettings();
  if (settings.video && sup.wanted) wake.startVideo();
  if (!settings.video) wake.stopVideo();
});

// ---------- diagnostic ----------
$('#btn-diag').addEventListener('click', () => { openSheet('#sheet-diag'); renderDiag(); });
function diagRows() {
  const yes = (b) => (b ? '✓ oui' : '✗ non');
  return [
    ['Version', VERSION + (MOCK ? ' — mode démo (?mock=1)' : '')],
    ['SpeechRecognition', yes(!!(window.SpeechRecognition || window.webkitSpeechRecognition)) + (window.SpeechRecognition ? '' : window.webkitSpeechRecognition ? ' (webkit)' : '')],
    ['Wake Lock', yes(wake.supported) + (wake.active ? ' — actif' : '') + (wake.error ? ` — erreur : ${wake.error}` : '')],
    ['IndexedDB', yes(!!window.indexedDB)],
    ['Stockages actifs', backends.map((b) => b.name).join(' + ') + (storage.lastError ? ` — dernière erreur : ${storage.lastError}` : '')],
    ['Web Share', yes(!!navigator.share)],
    ['storage.persist', yes(!!(navigator.storage && navigator.storage.persist)) + (persisted === null ? '' : persisted ? ' — accordé' : ' — refusé')],
    ['Mode écran d’accueil', yes(STANDALONE)],
    ['iOS / iPadOS détecté', yes(IS_IOS)],
    ['En ligne', yes(navigator.onLine)],
    ['Mode continu', String(sup.continuous)],
    ['État', `${sup.state}${sup.wanted ? ' (écoute voulue)' : ''}${sup.fatal ? ` — ${sup.fatal.code}` : ''}`],
    ['Instances / relances', `${sup.instances} / ${sup.restarts}`],
    ['User agent', navigator.userAgent],
  ];
}
function renderDiag() {
  logDirty = false;
  const table = $('#diag-table');
  table.textContent = '';
  for (const [k, v] of diagRows()) {
    const tr = document.createElement('tr');
    const a = document.createElement('td'); a.textContent = k;
    const b = document.createElement('td'); b.textContent = v;
    if (v.startsWith('✓')) b.className = 'ok'; else if (v.startsWith('✗')) b.className = 'ko';
    tr.append(a, b); table.appendChild(tr);
  }
  $('#diag-log').textContent = LOG.map(fmtLog).reverse().join('\n');
}
$('#btn-copy-log').addEventListener('click', (e) => {
  const text = diagRows().map(([k, v]) => `${k} : ${v}`).join('\n') + '\n\n' + LOG.map(fmtLog).join('\n');
  copyText(text, e.currentTarget);
});

$('#btn-test').addEventListener('click', () => {
  if (sup.wanted || testSup) return;
  const res = { interims: 0, finals: 0 };
  const out = $('#test-result');
  testSup = new RecognitionSupervisor({
    factory, continuous: continuousFor(), watchdogMs: settings.watchdogSec * 1000,
    onFinal: () => { res.finals++; }, onInterim: (t) => { if (t) res.interims++; },
    onLog: (e) => log('test:' + e.type, e),
  });
  testSup.start({ gesture: true }); // synchrone, dans le tap
  wake.acquire();
  renderButtons();
  out.hidden = false;
  let left = 30;
  const tick = setInterval(() => {
    left--;
    out.textContent = `Test en cours : parle normalement… ${left} s (${res.interims} intermédiaires, ${res.finals} phrases)`;
    if (left > 0) return;
    clearInterval(tick);
    const t = testSup;
    t.stop();
    const mic = t.everListened ? '✓ autorisé' : t.fatal ? `✗ refusé (${t.fatal.code})` : '✗ aucune réponse du moteur';
    const wl = wake.active ? '✓ actif' : wake.supported ? `✗ inactif${wake.error ? ' (' + wake.error + ')' : ''}` : '✗ non supporté → verrouillage auto sur Jamais';
    const ok = t.everListened && res.finals + res.interims > 0;
    out.textContent = `${ok ? '✓ Tout fonctionne.' : '✗ Problème détecté.'} Micro : ${mic}. Résultats reçus : ${res.interims} intermédiaires, ${res.finals} phrases. `
      + `Relances : ${t.restarts}. Wake lock : ${wl}.`;
    log('test-30s', { ok, finals: res.finals, interims: res.interims, restarts: t.restarts, wake: wake.active });
    testSup = null;
    if (!sup.wanted) wake.release();
    renderButtons();
  }, 1000);
  out.textContent = 'Test en cours : parle normalement… 30 s';
});

// ---------- utilitaires ----------
function debounce(fn, ms) {
  let id;
  return (...a) => { clearTimeout(id); id = setTimeout(() => fn(...a), ms); };
}

// ---------- démarrage ----------
let persisted = null;
async function boot() {
  applyFont();
  renderAll();
  renderStatus();
  renderWake();
  log('demarrage', { version: VERSION, mock: MOCK, standalone: STANDALONE, ios: IS_IOS });
  if (MOCK) banner('mock', 'Mode démo : faux moteur de reconnaissance, aucun micro utilisé.', 'info');

  try {
    if (navigator.storage && navigator.storage.persist) {
      persisted = await navigator.storage.persisted();
      if (!persisted) persisted = await navigator.storage.persist();
      log('storage-persist', { accorde: persisted });
      $('#persist-status').textContent = persisted
        ? 'Stockage persistant accordé : iOS ne videra pas les transcriptions.'
        : 'Stockage persistant non accordé : installe l’app sur l’écran d’accueil et exporte après chaque cours.';
    }
  } catch (e) { log('storage-persist-erreur', { message: e.message }); }

  try {
    const s = await storage.findUnfinished();
    if (s && !current) {
      pendingResume = s;
      const d = new Date(s.startedAt);
      banner('resume', `Une session a été interrompue (${s.title}, ${countWords(s.segments)} mots).`, 'orange', {
        actions: [
          [`Reprendre la session de ${d.getHours()} h ${String(d.getMinutes()).padStart(2, '0')}`, () => resumeSession(s)],
          ['La clore', () => {
            s.endedAt = s.updatedAt || Date.now();
            storage.save(s).catch(() => {});
            pendingResume = null;
            clearBanner('resume');
          }],
        ],
      });
      log('session-interrompue-trouvee', { id: s.id });
    }
  } catch (e) {
    log('lecture-stockage-erreur', { message: e.message });
    banner('storage', 'Impossible de lire les sessions enregistrées.', 'red', { dismiss: true });
  }

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
    navigator.serviceWorker.register('sw.js').then(
      (r) => log('sw-enregistre', { scope: r.scope }),
      (e) => log('sw-erreur', { message: e.message }),
    );
  }
}
boot();

// Accès pour les tests automatisés (Playwright) : lecture seule de l'état.
window.__app = { sup, storage, get current() { return current; }, LOG, world };
