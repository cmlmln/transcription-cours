// ⚠️ ZÉRO AUDIO. Cette app n'enregistre ni ne stocke jamais de son.
// Seule API de capture autorisée : SpeechRecognition / webkitSpeechRecognition.
// Interdits : enregistreur de médias, getUserMedia, contexte audio d'enregistrement.
// Un test (tests/no-audio.test.js) échoue si l'un d'eux apparaît dans le code.

// Superviseur de reconnaissance vocale : enveloppe robuste autour du Web Speech API,
// instable en session longue sur Safari iOS. Module isolé, sans DOM : la fabrique
// d'instance et l'horloge sont injectées (tests avec MockRecognition + FakeClock).

export const TRANSITIONS = {
  'idle':              ['starting', 'stopped'],
  'starting':          ['listening', 'restarting', 'error', 'stopped', 'paused-background'],
  'listening':         ['restarting', 'error', 'stopped', 'paused-background'],
  'restarting':        ['starting', 'error', 'stopped', 'paused-background'],
  'error':             ['restarting', 'stopped', 'paused-background'],
  'stopped':           ['starting'],
  'paused-background': ['starting', 'stopped'],
};

export const BACKOFF = [500, 1000, 2000, 4000, 8000];
export const backoffDelay = (attempt) => BACKOFF[Math.min(attempt, BACKOFF.length - 1)];

const FATAL = new Set(['not-allowed', 'service-not-allowed']);
const BENIGN = new Set(['no-speech', 'aborted']);
const HANDLERS = ['onstart', 'onaudiostart', 'onsoundstart', 'onspeechstart', 'onspeechend',
  'onsoundend', 'onaudioend', 'onresult', 'onnomatch', 'onerror', 'onend'];

const WORD_RE = /[\p{L}\p{N}]+/gu;
export const normalizeText = (s) => (String(s).toLowerCase().match(WORD_RE) || []).join(' ');

// Retire de `next` le début qui répète la fin de `prev` (comparaison normalisée :
// minuscules, sans ponctuation ni espaces multiples). Un chevauchement d'un seul mot
// n'est retenu que si ce mot fait au moins 4 lettres (« le », « de »… sont trop fréquents).
export function dedupeOverlap(prev, next, maxWords = 15) {
  const a = String(prev).toLowerCase().match(WORD_RE) || [];
  const b = [...String(next).matchAll(WORD_RE)];
  for (let k = Math.min(a.length, b.length, maxWords); k >= 1; k--) {
    let same = true;
    for (let i = 0; i < k; i++) if (a[a.length - k + i] !== b[i][0].toLowerCase()) { same = false; break; }
    if (!same) continue;
    if (k === 1 && a[a.length - 1].length < 4) return next;
    const cut = b[k - 1].index + b[k - 1][0].length;
    return next.slice(cut).replace(/^[\s\p{P}]+/u, '');
  }
  return next;
}

const realClock = {
  now: () => Date.now(),
  setTimeout: (f, ms) => setTimeout(f, ms),
  clearTimeout: (id) => clearTimeout(id),
};

export class RecognitionSupervisor {
  constructor(opts = {}) {
    this.factory = opts.factory;
    this.clock = opts.clock || realClock;
    this.lang = opts.lang || 'fr-FR';
    this.continuous = !!opts.continuous;
    this.watchdogMs = opts.watchdogMs ?? 12000;
    this.startTimeoutMs = opts.startTimeoutMs ?? 5000;
    this.abortTimeoutMs = opts.abortTimeoutMs ?? 2000;
    this.stallMs = opts.stallMs ?? 20000;
    this.dedupeWindowMs = opts.dedupeWindowMs ?? 30000;
    this.cb = {
      final: opts.onFinal, interim: opts.onInterim, state: opts.onState,
      log: opts.onLog, alert: opts.onAlert,
    };
    this.state = 'idle';
    this.stateSince = this.clock.now();
    this.wanted = false;      // l'utilisateur veut qu'on écoute
    this.inst = null;         // instance courante (une seule à la fois)
    this.timers = {};
    this.attempt = 0;         // rang dans le backoff, remis à 0 au premier résultat
    this.instances = 0;
    this.restarts = 0;
    this.finals = 0;
    this.fatal = null;
    this.everListened = false;
    this.lastEventAt = 0;
    this.lastResultAt = 0;
    this.tail = '';           // fin du texte déjà validé (pour la déduplication)
    this.promotedAt = -Infinity; // dernière promotion intermédiaire → final
    this.dedupePending = false;  // une promotion attend d'être dédupliquée par l'instance suivante
    this.gesture = false;
  }

  // ---------- API publique ----------

  // iOS : doit être appelé de façon synchrone dans le gestionnaire du tap (aucun await avant).
  start({ gesture = false } = {}) {
    if (this.wanted && this.state !== 'stopped' && this.state !== 'paused-background') return;
    this.wanted = true;
    this.gesture = gesture;
    this.attempt = 0;
    this.fatal = null;
    this._clearAll();
    this._teardown();
    this._spawn();
    this.startInstanceId = this.instances; // instance née directement du tap
    if (this.wanted) this._heartbeat(); // (wanted retombe si l'API est absente)
  }

  stop() {
    this.wanted = false;
    this._clearAll();
    this._teardown();
    this._setState('stopped');
  }

  // Onglet masqué : iOS coupe le micro de toute façon ; on s'arrête proprement.
  pauseBackground() {
    if (!this.wanted) return;
    this.wanted = false;
    this._clearAll();
    this._teardown();
    this._setState('paused-background');
  }

  // Retour réseau : relance tout de suite au lieu d'attendre la fin du backoff.
  kick() {
    if (!this.wanted) return;
    this.attempt = 0;
    if (!this.inst && (this.state === 'restarting' || this.state === 'error')) this._spawn();
  }

  activeTimers() { return Object.keys(this.timers).length; }

  // ---------- interne ----------

  _now() { return this.clock.now(); }

  _emit(name, ...args) {
    const f = this.cb[name];
    if (!f) return;
    try { f(...args); } catch (e) {
      if (name !== 'log') this._log('callback-erreur', { cb: name, message: String(e && e.message || e) });
    }
  }

  _log(type, data) { this._emit('log', { t: this._now(), type, ...data }); }

  _setState(to, info) {
    if (to === this.state) return true;
    if (!TRANSITIONS[this.state].includes(to)) {
      this._log('transition-refusee', { from: this.state, to });
      return false;
    }
    this._log('transition', { from: this.state, to, ...info });
    this.state = to;
    this.stateSince = this._now();
    this._emit('state', to, info || {});
    return true;
  }

  _timer(name, ms, fn) {
    this._clear(name);
    this.timers[name] = this.clock.setTimeout(() => { delete this.timers[name]; fn(); }, ms);
  }
  _clear(name) {
    if (name in this.timers) { this.clock.clearTimeout(this.timers[name]); delete this.timers[name]; }
  }
  _clearAll() { for (const n of Object.keys(this.timers)) this._clear(n); }

  _nextBackoff() { return backoffDelay(this.attempt++); }

  _spawn() {
    this._clear('spawn');
    if (!this.wanted) return;
    if (this.state === 'error') this._setState('restarting');
    if (!this._setState('starting')) return;

    let rec;
    try {
      rec = this.factory();
    } catch (e) {
      // API absente : seul cas d'arrêt sans action possible de notre part.
      this.wanted = false;
      this.fatal = { code: 'unsupported', message: String(e && e.message || e) };
      this._clearAll();
      this._setState('error', { code: 'unsupported' });
      this._setState('stopped', { fatal: this.fatal });
      return;
    }
    this.instances++;
    if (this.instances > 1) this.restarts++;
    const inst = {
      rec, id: this.instances, startedAt: this._now(), gotResult: false,
      committed: new Set(), interim: '', ending: false, delay: 0, reason: '',
      // Après une promotion, le premier texte validé de l'instance suivante est
      // dédupliqué contre la fin du texte déjà écrit — une seule fois, quelle que soit
      // la durée de son intermédiaire (sur iOS il peut traîner bien plus de 10 s).
      dedupe: this.dedupePending ? this.tail : '',
    };
    this.inst = inst;
    try {
      rec.lang = this.lang;
      rec.continuous = this.continuous;
      rec.interimResults = true;
      rec.maxAlternatives = 1;
    } catch { /* propriétés en lecture seule sur un mock : sans importance */ }

    // Chaque handler vérifie qu'il appartient à l'instance courante : un événement
    // tardif d'une ancienne instance (fréquent sur iOS) est ignoré.
    const touch = () => this._touch(inst);
    for (const h of ['onstart', 'onaudiostart', 'onsoundstart', 'onspeechstart',
      'onspeechend', 'onsoundend', 'onaudioend', 'onnomatch']) rec[h] = touch;
    rec.onresult = (e) => this._onResult(inst, e);
    rec.onerror = (e) => this._onError(inst, e);
    rec.onend = () => this._onEnd(inst);

    this._timer('start', this.startTimeoutMs, () => {
      if (this.inst === inst && this.state === 'starting') {
        this._log('start-timeout', { instance: inst.id });
        this._endInstance(inst, 'start-timeout', this._nextBackoff());
      }
    });
    this._log('instance-start', { instance: inst.id, continuous: this.continuous });
    try {
      rec.start();
    } catch (e) {
      // InvalidStateError & co : on jette l'instance et on réessaie avec backoff.
      this._log('start-exception', { instance: inst.id, message: String(e && e.message || e) });
      this._clear('start');
      this._teardown();
      this._setState('restarting');
      this._timer('spawn', this._nextBackoff(), () => this._spawn());
    }
  }

  _touch(inst) {
    if (this.inst !== inst || inst.ending) return;
    this.lastEventAt = this._now();
    if (this.state === 'starting') {
      this._clear('start');
      this.everListened = true;
      this._setState('listening', { instance: inst.id });
    }
    if (this.state === 'listening') {
      this._timer('watchdog', this.watchdogMs, () => {
        this._log('watchdog', { instance: inst.id, silenceMs: this._now() - this.lastEventAt });
        this._endInstance(inst, 'watchdog', 0);
      });
    }
  }

  _onResult(inst, e) {
    // Une instance en cours de fermeture peut encore livrer un final tardif : on le garde.
    if (this.inst !== inst) return;
    this._touch(inst);
    // Premier son entendu longtemps après la promotion : une répétition serait voulue
    // par le prof, pas un artefact de relance → on ne déduplique pas.
    if (!inst.gotResult && inst.dedupe && this._now() - this.promotedAt > this.dedupeWindowMs) inst.dedupe = '';
    inst.gotResult = true;
    this.attempt = 0;
    this.lastResultAt = this._now();
    const results = (e && e.results) || [];
    let interim = '';
    // On parcourt tout : iOS renvoie parfois des finals déjà livrés ; l'index les filtre.
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const txt = String((r && r[0] && r[0].transcript) || '').trim();
      if (r.isFinal) {
        if (!inst.committed.has(i)) { inst.committed.add(i); this._commit(inst, txt, false); }
      } else if (txt) {
        interim += (interim ? ' ' : '') + txt;
      }
    }
    inst.interim = interim;
    this._emit('interim', inst.dedupe ? dedupeOverlap(inst.dedupe, interim) : interim);
  }

  _commit(inst, text, promoted) {
    let t = String(text).trim();
    if (inst.dedupe) { t = dedupeOverlap(inst.dedupe, t); inst.dedupe = ''; }
    // Variante WebKit signalée : un final qui reprend en entier le final précédent de la
    // même instance (transcription cumulée). On ne garde que la partie nouvelle.
    const prev = normalizeText(inst.lastFinal || '');
    if (!promoted && prev.includes(' ') && (normalizeText(t) + ' ').startsWith(prev + ' ')) t = dedupeOverlap(inst.lastFinal, t);
    if (!promoted) inst.lastFinal = t || inst.lastFinal;
    this.dedupePending = promoted;
    if (!t) return;
    this.tail = (this.tail + ' ' + t).slice(-300);
    if (promoted) this.promotedAt = this._now();
    this.finals++;
    this._emit('final', t, { promoted });
  }

  _onError(inst, e) {
    if (this.inst !== inst) return;
    const code = (e && e.error) || 'unknown';
    this.lastEventAt = this._now();
    if (inst.ending && code === 'aborted') return; // c'est nous qui avons appelé abort()
    this._log('error', { instance: inst.id, code, message: e && e.message });

    if (FATAL.has(code)) {
      this.wanted = false;
      // fromGesture : refus dès l'instance lancée par le tap → vrai problème d'autorisation.
      // Sinon iOS a refusé une relance automatique : un simple tap sur Démarrer suffit.
      this.fatal = { code, fromGesture: this.gesture && inst.id === this.startInstanceId, everListened: this.everListened };
      this._setState('error', { code, fatal: true });
      this._endInstance(inst, 'fatal:' + code, 0);
      return;
    }
    let delay = 0;
    if (!BENIGN.has(code)) {
      delay = this._nextBackoff();
      if (code === 'audio-capture') this._emit('alert', 'audio-capture');
      this._setState('error', { code, delay });
    }
    this._endInstance(inst, 'error:' + code, delay);
  }

  _onEnd(inst) {
    if (this.inst !== inst) return;
    if (!inst.ending) { inst.ending = true; inst.reason = 'end'; inst.delay = 0; }
    this._finish(inst);
  }

  // Ferme une instance : abort(), puis on attend onend… au plus abortTimeoutMs
  // (bug iOS : onend ne vient parfois jamais après abort()).
  _endInstance(inst, reason, delay) {
    if (this.inst !== inst) return;
    if (inst.ending) { inst.delay = Math.max(inst.delay, delay); return; }
    inst.ending = true;
    inst.reason = reason;
    inst.delay = delay;
    this._clear('watchdog');
    this._clear('start');
    if (this.state === 'starting' || this.state === 'listening') this._setState('restarting');
    try { inst.rec.abort(); } catch { /* déjà mort */ }
    this._timer('abort', this.abortTimeoutMs, () => {
      this._log('onend-manquant', { instance: inst.id });
      this._finish(inst);
    });
  }

  _finish(inst) {
    if (this.inst !== inst) return;
    this._clear('abort');
    this._clear('watchdog');
    this._clear('start');
    this._log('instance-fin', { instance: inst.id, reason: inst.reason, dureeMs: this._now() - inst.startedAt });
    this._teardown();
    // Instance morte en moins d'1 s sans rien produire (fin naturelle, no-speech ou
    // aborted instantanés) : backoff, sinon on boucle à vide et on vide la batterie.
    if (inst.delay === 0 && this._now() - inst.startedAt < 1000 && !inst.gotResult) inst.delay = this._nextBackoff();
    if (!this.wanted) {
      this._clearAll();
      this._setState('stopped', this.fatal ? { fatal: this.fatal } : undefined);
      return;
    }
    this._setState('restarting', { delay: inst.delay });
    this._timer('spawn', inst.delay, () => this._spawn());
  }

  // Détache tous les handlers, abort(), et promeut l'intermédiaire non finalisé
  // en final : sinon la fin de phrase en cours serait perdue.
  _teardown() {
    const inst = this.inst;
    if (!inst) return;
    this.inst = null;
    for (const h of HANDLERS) { try { inst.rec[h] = null; } catch { /* ignore */ } }
    try { inst.rec.abort(); } catch { /* ignore */ }
    if (inst.interim.trim()) this._commit(inst, inst.interim, true);
    inst.interim = '';
    this._emit('interim', '');
  }

  // Filet de sécurité : si malgré tout l'état reste coincé, on relance.
  _heartbeat() {
    this._timer('heartbeat', 2000, () => {
      if (!this.wanted) return;
      this._checkStall();
      this._heartbeat();
    });
  }

  _checkStall() {
    const now = this._now();
    const age = now - this.stateSince;
    const stuck =
      ((this.state === 'restarting' || this.state === 'error') && age > this.stallMs && !this.timers.spawn && !this.timers.abort) ||
      (this.state === 'listening' && now - this.lastEventAt > this.watchdogMs * 2) ||
      (this.state === 'starting' && age > this.startTimeoutMs * 2) ||
      (this.state === 'stopped' || this.state === 'idle');
    if (!stuck) return;
    this._log('blocage-detecte', { state: this.state, ageMs: age });
    if (this.inst && !this.inst.ending) this._endInstance(this.inst, 'blocage', 0);
    else if (this.inst) this._finish(this.inst);
    else this._spawn();
  }
}
