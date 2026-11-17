import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RecognitionSupervisor, dedupeOverlap, normalizeText, backoffDelay, TRANSITIONS } from '../js/supervisor.js';
import { FakeClock } from './fakeclock.js';

// Instance pilotable à la main.
class Scripted {
  constructor(log) { this.log = log; this.started = false; this.aborted = false; log.push(this); }
  start() { if (this.throwOnStart) throw new Error('InvalidStateError'); this.started = true; }
  abort() { this.aborted = true; }
  fire(h, ev = {}) { if (this[h]) this[h](ev); }
  result(list) { // list: [[texte, isFinal], ...]
    this.fire('onresult', { resultIndex: 0, results: list.map(([t, f]) => Object.assign([{ transcript: t }], { isFinal: f })) });
  }
}

function setup(opts = {}) {
  const clock = new FakeClock();
  const recs = [];
  const finals = [], states = [], logs = [], alerts = [];
  let interim = '';
  const sup = new RecognitionSupervisor({
    clock, factory: () => new Scripted(recs),
    onFinal: (t, m) => finals.push({ t, ...m }), onInterim: (t) => { interim = t; },
    onState: (s) => states.push(s), onLog: (e) => logs.push(e), onAlert: (a) => alerts.push(a),
    ...opts,
  });
  return { clock, recs, finals, states, logs, alerts, sup, get interim() { return interim; }, last: () => recs[recs.length - 1] };
}

const listen = (env) => { env.sup.start({ gesture: true }); env.last().fire('onstart'); };

test('normalisation : minuscules, sans ponctuation ni espaces multiples', () => {
  assert.equal(normalizeText("  L'Entropie,   CROÎT !  "), "l entropie croît");
});

test('déduplication par chevauchement fin/début', () => {
  assert.equal(dedupeOverlap("nous parlons de l'entropie", "l'entropie croissante"), 'croissante');
  assert.equal(dedupeOverlap('Bonjour, à TOUS', 'à tous les élèves'), 'les élèves');
  assert.equal(dedupeOverlap('le second principe', 'second principe affirme'), 'affirme');
  assert.equal(dedupeOverlap('le second principe', 'le second principe'), '');
  assert.equal(dedupeOverlap('a b c', 'x y'), 'x y');
  // un seul mot court en commun : pas assez pour conclure à un doublon
  assert.equal(dedupeOverlap('on mesure le', 'le volume'), 'le volume');
  assert.equal(dedupeOverlap('on mesure  le   volume.', 'Volume, puis la pression'), 'puis la pression');
  assert.equal(dedupeOverlap('', 'texte'), 'texte');
});

test('backoff exponentiel plafonné à 8 s', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 9].map(backoffDelay), [500, 1000, 2000, 4000, 8000, 8000, 8000]);
});

test('machine à états : séquence nominale et aucune transition implicite', () => {
  const e = setup();
  listen(e);
  e.last().result([['bonjour', true]]);
  e.last().fire('onend');
  e.clock.advance(10);
  e.last().fire('onstart');
  e.sup.stop();
  assert.deepEqual(e.states, ['starting', 'listening', 'restarting', 'starting', 'listening', 'stopped']);
  for (const l of e.logs.filter((l) => l.type === 'transition')) assert.ok(TRANSITIONS[l.from].includes(l.to));
  assert.equal(e.logs.filter((l) => l.type === 'transition-refusee').length, 0);
});

test('nouvelle instance à chaque relance, anciens handlers détachés, relance < 300 ms', () => {
  const e = setup();
  listen(e);
  const first = e.last();
  first.result([['phrase complète', true]]);
  first.fire('onend');
  e.clock.advance(299);
  assert.equal(e.recs.length, 2);
  assert.notEqual(e.last(), first);
  assert.equal(first.onresult, null);
  assert.equal(first.onend, null);
  assert.ok(first.aborted);
});

test('promotion intermédiaire → final et pas de doublon à la relance', () => {
  const e = setup();
  listen(e);
  e.last().result([['le second principe', false]]);
  assert.equal(e.interim, 'le second principe');
  e.last().fire('onend');
  assert.deepEqual(e.finals, [{ t: 'le second principe', promoted: true }]);
  assert.equal(e.interim, '');
  e.clock.advance(10);
  e.last().fire('onstart');
  e.last().result([['second principe affirme', false]]);
  assert.equal(e.interim, 'affirme');
  e.last().result([['second principe affirme que', true]]);
  assert.deepEqual(e.finals[1], { t: 'affirme que', promoted: false });
  // fenêtre close : une vraie répétition plus tard est conservée
  e.last().result([['second principe affirme que', true], ['que dire', true]]);
  assert.equal(e.finals[2].t, 'que dire');
});

test('un final déjà livré (même index) ne compte pas deux fois', () => {
  const e = setup({ continuous: true });
  listen(e);
  e.last().result([['un', true]]);
  e.last().result([['un', true], ['deux', false]]);
  e.last().result([['un', true], ['deux trois', true]]);
  assert.deepEqual(e.finals.map((f) => f.t), ['un', 'deux trois']);
});

test('no-speech et aborted : relance immédiate, pas un état error', () => {
  const e = setup();
  listen(e);
  e.clock.advance(6000); // iOS : no-speech arrive après quelques secondes de silence
  e.last().fire('onerror', { error: 'no-speech' });
  e.last().fire('onend');
  assert.ok(!e.states.includes('error'));
  e.clock.advance(0);
  assert.equal(e.recs.length, 2);
});

test('network : backoff 0,5/1/2/4/8 s, remis à zéro au premier résultat', () => {
  const e = setup();
  listen(e);
  const delays = [];
  for (let i = 0; i < 6; i++) {
    e.last().fire('onerror', { error: 'network' });
    e.last().fire('onend');
    const n = e.recs.length, t0 = e.clock.now();
    while (e.recs.length === n) e.clock.advance(50);
    delays.push(Math.round((e.clock.now() - t0) / 100) * 100);
    e.last().fire('onstart');
  }
  assert.deepEqual(delays, [500, 1000, 2000, 4000, 8000, 8000]);
  e.last().result([['ok', true]]);
  assert.equal(e.sup.attempt, 0);
  assert.ok(e.states.includes('error'));
});

test('audio-capture : alerte visible + backoff', () => {
  const e = setup();
  listen(e);
  e.last().fire('onerror', { error: 'audio-capture' });
  e.last().fire('onend');
  assert.deepEqual(e.alerts, ['audio-capture']);
  e.clock.advance(400);
  assert.equal(e.recs.length, 1);
  e.clock.advance(200);
  assert.equal(e.recs.length, 2);
});

test('not-allowed : arrêt définitif avec cause', () => {
  for (const code of ['not-allowed', 'service-not-allowed']) {
    const e = setup();
    listen(e);
    e.last().fire('onerror', { error: code });
    e.last().fire('onend');
    e.clock.advance(60000);
    assert.equal(e.sup.state, 'stopped');
    assert.equal(e.sup.fatal.code, code);
    assert.equal(e.recs.length, 1);
    assert.equal(e.sup.activeTimers(), 0);
  }
});

test('erreur inconnue : relance, jamais d’arrêt silencieux', () => {
  const e = setup();
  listen(e);
  for (let i = 0; i < 20; i++) {
    e.last().fire('onerror', { error: 'bad-grammar' });
    e.last().fire('onend');
    const n = e.recs.length;
    while (e.recs.length === n) e.clock.advance(100);
    e.last().fire('onstart');
  }
  assert.equal(e.sup.state, 'listening');
  assert.equal(e.recs.length, 21);
});

test('watchdog : silence total 12 s en écoute → abort + relance', () => {
  const e = setup();
  listen(e);
  e.clock.advance(11900);
  assert.equal(e.recs.length, 1);
  e.clock.advance(200);
  assert.ok(e.recs[0].aborted);
  e.recs[0].fire('onend');
  e.clock.advance(10);
  assert.equal(e.recs.length, 2);
});

test('watchdog réglable', () => {
  const e = setup({ watchdogMs: 3000 });
  listen(e);
  e.clock.advance(3100);
  assert.ok(e.recs[0].aborted);
});

test('start() sans passage en écoute en 5 s → instance abandonnée', () => {
  const e = setup();
  e.sup.start();
  e.clock.advance(5100);
  assert.ok(e.recs[0].aborted);
});

test('bug iOS : onend absent après abort() → recréation forcée après 2 s', () => {
  const e = setup();
  listen(e);
  e.clock.advance(12100); // watchdog → abort, et l'instance ne répond plus
  assert.equal(e.recs.length, 1);
  e.clock.advance(1800);
  assert.equal(e.recs.length, 1);
  e.clock.advance(300);
  assert.equal(e.recs.length, 2);
  assert.ok(e.logs.some((l) => l.type === 'onend-manquant'));
  e.recs[0].fire('onend'); // onend tardif de l'ancienne : ignoré
  assert.equal(e.recs.length, 2);
});

test('start() qui lève une exception → nouvel essai', () => {
  const clock = new FakeClock();
  let n = 0;
  const recs = [];
  const sup = new RecognitionSupervisor({ clock, factory: () => { const r = new Scripted(recs); if (n++ === 0) r.throwOnStart = true; return r; } });
  sup.start();
  clock.advance(600);
  assert.equal(recs.length, 2);
  assert.equal(sup.state, 'starting');
});

test('API absente : arrêt avec cause « unsupported »', () => {
  const sup = new RecognitionSupervisor({ clock: new FakeClock(), factory: () => { throw new Error('absent'); } });
  sup.start();
  assert.equal(sup.state, 'stopped');
  assert.equal(sup.fatal.code, 'unsupported');
});

test('stop() : promeut l’intermédiaire, détache tout, aucun timer restant', () => {
  const e = setup();
  listen(e);
  e.last().result([['fin de phrase', false]]);
  e.sup.stop();
  assert.equal(e.finals[0].t, 'fin de phrase');
  assert.equal(e.sup.activeTimers(), 0);
  assert.equal(e.clock.pending, 0);
  assert.equal(e.recs[0].onresult, null);
});

test('pause arrière-plan puis reprise', () => {
  const e = setup();
  listen(e);
  e.sup.pauseBackground();
  assert.equal(e.sup.state, 'paused-background');
  assert.equal(e.clock.pending, 0);
  e.sup.start();
  assert.equal(e.sup.state, 'starting');
  assert.equal(e.recs.length, 2);
});

test('un callback qui plante ne casse pas le superviseur', () => {
  const e = setup({ onFinal: () => { throw new Error('disque plein'); } });
  listen(e);
  e.last().result([['x', true]]);
  assert.equal(e.sup.state, 'listening');
  assert.ok(e.logs.some((l) => l.type === 'callback-erreur'));
});

test('kick() au retour réseau : relance sans attendre le backoff', () => {
  const e = setup();
  listen(e);
  for (let i = 0; i < 4; i++) { e.last().fire('onerror', { error: 'network' }); e.last().fire('onend'); e.clock.advance(9000); e.last().fire('onstart'); }
  e.last().fire('onerror', { error: 'network' }); e.last().fire('onend');
  const n = e.recs.length;
  e.sup.kick();
  assert.equal(e.recs.length, n + 1);
});

test('régression : intermédiaire qui traîne > 10 s après une relance, toujours dédupliqué', () => {
  const e = setup();
  listen(e);
  e.last().result([['un deux trois', false]]);
  e.clock.advance(12100); // watchdog → promotion
  e.clock.advance(2100);  // onend manquant → nouvelle instance
  e.last().fire('onstart');
  e.last().result([['deux trois quatre', false]]);
  e.clock.advance(11000);
  e.last().result([['deux trois quatre cinq', false]]);
  e.clock.advance(12100 + 2100); // watchdog + onend manquant → promotion, 25 s après la 1re
  assert.deepEqual(e.finals.map((f) => f.t), ['un deux trois', 'quatre cinq']);
});

test('not-allowed sur une relance automatique : distingué d’un refus initial', () => {
  const e = setup();
  listen(e);
  e.last().fire('onend');
  e.clock.advance(600);
  e.last().fire('onerror', { error: 'not-allowed' });
  e.last().fire('onend');
  assert.equal(e.sup.fatal.fromGesture, false);
  const f = setup();
  f.sup.start({ gesture: true });
  f.last().fire('onerror', { error: 'not-allowed' });
  assert.equal(f.sup.fatal.fromGesture, true);
});

test('longue pause du prof puis vraie répétition : conservée', () => {
  const e = setup();
  listen(e);
  e.last().result([['la pression', false]]);
  e.last().fire('onend');           // promotion
  e.clock.advance(10);
  e.last().fire('onstart');
  e.clock.advance(31000);           // > 30 s de silence (pas de watchdog : on simule des événements)
  e.last().fire('onspeechstart');
  e.last().result([['la pression augmente', true]]);
  assert.equal(e.finals[1].t, 'la pression augmente');
});

test('relecture : no-speech instantané en boucle → backoff, pas de boucle serrée', () => {
  const e = setup();
  e.sup.start();
  for (let i = 0; i < 200; i++) {
    const r = e.last();
    r.fire('onerror', { error: 'no-speech' });
    r.fire('onend');
    e.clock.advance(100);
  }
  // 20 s simulées : sans backoff on aurait 200 instances
  assert.ok(e.recs.length < 15, `instances : ${e.recs.length}`);
});

test('relecture : API absente → aucun timer qui traîne', () => {
  const clock = new FakeClock();
  const sup = new RecognitionSupervisor({ clock, factory: () => { throw new Error('absent'); } });
  sup.start();
  assert.equal(clock.pending, 0);
});

test('relecture : final cumulé (reprend le précédent de la même instance)', () => {
  const e = setup({ continuous: true });
  listen(e);
  e.last().result([['le gaz parfait', true]]);
  e.last().result([['le gaz parfait', true], ['le gaz parfait occupe le volume', true]]);
  assert.deepEqual(e.finals.map((f) => f.t), ['le gaz parfait', 'occupe le volume']);
  // une phrase différente n'est pas touchée
  e.last().result([['le gaz parfait', true], ['le gaz parfait occupe le volume', true], ['le gaz chauffe', true]]);
  assert.equal(e.finals[2].t, 'le gaz chauffe');
});
