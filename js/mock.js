// Faux moteur de reconnaissance (aucun micro, aucun son) : même interface que
// SpeechRecognition. Sert aux tests Node (avec FakeClock) et au mode ?mock=1.
// Simule : intermédiaires/finals, onend aléatoires (5–60 s), erreurs network /
// no-speech / aborted, et le bug iOS « onend ne vient jamais après abort() ».

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const realClock = {
  now: () => Date.now(),
  setTimeout: (f, ms) => setTimeout(f, ms),
  clearTimeout: (id) => clearTimeout(id),
};

const DEMO = ("aujourd'hui nous allons parler de l'entropie en thermodynamique statistique " +
  "le second principe affirme que l'entropie d'un système isolé ne peut que croître " +
  "Boltzmann relie cette grandeur au nombre de micro-états accessibles " +
  "prenons l'exemple d'un gaz parfait enfermé dans une boîte séparée en deux compartiments " +
  "quand on retire la paroi le gaz occupe tout le volume et le désordre augmente").split(' ');

// Le « prof » : prononce des mots dans le temps, qu'une instance écoute ou non.
export class MockWorld {
  constructor({ clock = realClock, rand = Math.random, wordMs = 350, pauseProb = 0.02,
    pauseMs = [2000, 40000], word = null } = {}) {
    this.clock = clock; this.rand = rand; this.wordMs = wordMs;
    this.pauseProb = pauseProb; this.pauseMs = pauseMs;
    this.word = word || ((i) => DEMO[i % DEMO.length]);
    this.spoken = [];          // {i, t, w}
    this.nextT = clock.now();
    this.lastTail = '';        // intermédiaire d'une instance morte (promotion attendue)
    this.delivered = new Set();// mots livrés au superviseur (final ou dernier intermédiaire)
    this.instances = [];
  }
  wordsBetween(t0, t1) {
    while (this.nextT <= t1) {
      const i = this.spoken.length;
      this.spoken.push({ i, t: this.nextT, w: this.word(i) });
      let gap = this.wordMs * (0.6 + this.rand() * 0.8);
      if (this.rand() < this.pauseProb) gap += this.pauseMs[0] + this.rand() * (this.pauseMs[1] - this.pauseMs[0]);
      this.nextT += gap;
    }
    const out = [];
    for (let k = this.spoken.length - 1; k >= 0 && this.spoken[k].t > t0; k--) {
      if (this.spoken[k].t <= t1) out.unshift(this.spoken[k]);
    }
    return out;
  }
  attachedCount() { return this.instances.filter((r) => r.onresult || r.onend || r.onerror).length; }
}

export const DEFAULT_FAULTS = {
  lifeMs: [5000, 60000],  // mort spontanée (onend sans final)
  pNetwork: 0.15,         // à la mort : erreur network avant onend
  pAudioCapture: 0.02,
  pNoEndAfterAbort: 0.25, // bug iOS
  pStartHang: 0.03,       // start() ne démarre jamais
  pStartThrow: 0.01,      // start() lève une exception
  pDup: 0.5,              // la nouvelle instance répète la fin de l'intermédiaire perdu
  noSpeechMs: 7000,
};

export class MockRecognition {
  constructor(world, faults = {}) {
    this.world = world;
    this.clock = world.clock;
    this.rand = world.rand;
    this.f = { ...DEFAULT_FAULTS, ...faults };
    this.lang = ''; this.continuous = false; this.interimResults = false; this.maxAlternatives = 1;
    for (const h of ['onstart', 'onaudiostart', 'onsoundstart', 'onspeechstart', 'onspeechend',
      'onsoundend', 'onaudioend', 'onresult', 'onnomatch', 'onerror', 'onend']) this[h] = null;
    this.started = false; this.dead = false; this.timers = new Set();
    this.results = []; this.cur = null; this.lastHeard = 0;
    world.instances.push(this);
  }
  _t(fn, ms) {
    const id = this.clock.setTimeout(() => { this.timers.delete(id); fn(); }, ms);
    this.timers.add(id);
  }
  _clearTimers() { for (const id of this.timers) this.clock.clearTimeout(id); this.timers.clear(); }
  _fire(name, ev = {}) { const h = this[name]; if (h) h.call(this, ev); return !!h; }

  start() {
    if (this.started) throw new Error('InvalidStateError: already started');
    if (this.rand() < this.f.pStartThrow) throw new Error('InvalidStateError: mock');
    this.started = true;
    if (this.rand() < this.f.pStartHang) return; // ne démarrera jamais
    this._t(() => {
      if (this.dead) return;
      this.t0 = this.lastHeard = this.clock.now();
      this._fire('onstart'); this._fire('onaudiostart');
      const w = this.world;
      if (w.lastTail && this.rand() < this.f.pDup) {
        const tail = w.lastTail.split(' ');
        this.prefix = tail.slice(-(1 + Math.floor(this.rand() * 3)));
      }
      w.lastTail = '';
      const life = this.f.lifeMs[0] + this.rand() * (this.f.lifeMs[1] - this.f.lifeMs[0]);
      this._t(() => this._die(), life);
      this._tick();
    }, 30 + this.rand() * 170);
  }

  _tick() {
    if (this.dead) return;
    const now = this.clock.now();
    const words = this.world.wordsBetween(this.lastT ?? this.t0, now).map((x) => x.w);
    this.lastT = now;
    if (words.length) {
      this.lastHeard = now;
      if (!this.cur) {
        // La répétition n'a lieu qu'en tout début d'instance (cas observé à la relance).
        const prefix = this.prefix && now - this.t0 < 3000 ? this.prefix : [];
        this.cur = { words: [...prefix], target: 4 + Math.floor(this.rand() * 10) };
        this.prefix = null;
        this.results.push({ isFinal: false, transcript: '' });
      }
      this.cur.words.push(...words);
      const r = this.results[this.results.length - 1];
      r.transcript = this.cur.words.join(' ');
      if (this.cur.words.length >= this.cur.target) { r.isFinal = true; this.cur = null; }
      const ok = this._emitResults();
      if (ok && r.isFinal) for (const w of r.transcript.split(' ')) this.world.delivered.add(w);
      if (r.isFinal && !this.continuous) { this._end(80); return; }
    } else if (!this.continuous && !this.results.length && now - this.lastHeard > this.f.noSpeechMs) {
      this._fire('onerror', { error: 'no-speech' });
      this._end(20); return;
    }
    this._t(() => this._tick(), 100);
  }

  _emitResults() {
    const results = this.results.map((r) => Object.assign([{ transcript: r.transcript, confidence: 0.9 }], { isFinal: r.isFinal }));
    return this._fire('onresult', { resultIndex: Math.max(0, results.length - 1), results });
  }

  _pendingInterim() {
    const r = this.results[this.results.length - 1];
    return r && !r.isFinal ? r.transcript : '';
  }

  // L'intermédiaire en cours au moment de la mort a été livré : le superviseur doit le promouvoir.
  _recordTail() {
    const tail = this._pendingInterim();
    if (tail && this.onresult) {
      for (const w of tail.split(' ')) this.world.delivered.add(w);
      this.world.lastTail = tail;
    }
  }

  _die() {
    if (this.dead) return;
    this._recordTail();
    const x = this.rand();
    if (x < this.f.pNetwork) this._fire('onerror', { error: 'network' });
    else if (x < this.f.pNetwork + this.f.pAudioCapture) this._fire('onerror', { error: 'audio-capture' });
    this._end(30);
  }

  _end(ms) {
    this.dead = true;
    this._clearTimers();
    this._t(() => { this._fire('onaudioend'); this._fire('onend'); }, ms);
  }

  stop() { this.abort(); }

  abort() {
    if (this.dead) return;
    this._recordTail();
    this.dead = true;
    this._clearTimers();
    if (!this.started) return;
    if (this.rand() < this.f.pNoEndAfterAbort) return; // bug iOS : pas d'onend
    this._t(() => { this._fire('onerror', { error: 'aborted' }); this._fire('onend'); }, 10 + this.rand() * 40);
  }
}
