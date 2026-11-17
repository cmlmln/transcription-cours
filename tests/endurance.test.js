// Endurance accélérée : 2 h 30 simulées avec le faux moteur et des pannes aléatoires.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RecognitionSupervisor, TRANSITIONS } from '../js/supervisor.js';
import { MockWorld, MockRecognition, mulberry32 } from '../js/mock.js';
import { FakeClock } from './fakeclock.js';

const DURATION = 2.5 * 3600 * 1000;
const word = (i) => 'mot' + i; // mots uniques : permet de vérifier pertes et doublons

function run(seed, continuous) {
  const clock = new FakeClock();
  const rand = mulberry32(seed);
  const world = new MockWorld({ clock, rand, word });
  const finals = [], logs = [];
  const sup = new RecognitionSupervisor({
    clock, continuous,
    factory: () => new MockRecognition(world),
    onFinal: (t) => finals.push(t),
    onLog: (e) => logs.push(e),
  });
  sup.start({ gesture: true });
  let maxPending = 0, maxAttached = 0;
  for (let t = 0; t < DURATION; t += 60000) {
    clock.advance(60000);
    maxPending = Math.max(maxPending, clock.pending);
    maxAttached = Math.max(maxAttached, world.attachedCount());
  }
  return { clock, world, sup, finals, logs, maxPending, maxAttached };
}

const SEEDS = process.env.SEEDS ? Array.from({ length: +process.env.SEEDS }, (_, i) => [100 + i, i % 2 === 1]) : [[1, false], [2, false], [3, false], [4, true], [5, true], [42, false]];
for (const [seed, continuous] of SEEDS) {
  test(`2 h 30 simulées, graine ${seed}, continuous=${continuous}`, () => {
    const r = run(seed, continuous);

    // toujours en écoute (ou en train de relancer, ce qui doit aboutir vite)
    assert.equal(r.sup.wanted, true);
    let waited = 0;
    while (r.sup.state !== 'listening' && waited < 30000) { r.clock.advance(100); waited += 100; }
    assert.equal(r.sup.state, 'listening', 'doit écouter à la fin');

    // aucun doublon : les indices de mots sont strictement croissants
    const idx = r.finals.join(' ').split(/\s+/).filter(Boolean).map((w) => Number(w.slice(3)));
    for (let i = 1; i < idx.length; i++) assert.ok(idx[i] > idx[i - 1], `doublon/désordre autour de mot${idx[i]}`);

    // aucune perte : chaque mot livré (final ou intermédiaire promu) est présent
    const out = new Set(idx);
    const lost = [...r.world.delivered].filter((w) => !out.has(Number(w.slice(3))));
    assert.deepEqual(lost, [], 'mots livrés perdus');

    // machine à états propre
    assert.equal(r.logs.filter((l) => l.type === 'transition-refusee').length, 0);
    for (const l of r.logs.filter((l) => l.type === 'transition')) assert.ok(TRANSITIONS[l.from].includes(l.to));

    // mémoire stable : pas de handlers ni timers qui s'accumulent
    assert.ok(r.maxAttached <= 1, `instances attachées : ${r.maxAttached}`);
    assert.ok(r.maxPending <= 8, `timers en attente : ${r.maxPending}`);
    assert.ok(r.sup.activeTimers() <= 3);

    r.sup.stop();
    r.clock.advance(5000);
    assert.equal(r.sup.activeTimers(), 0);
    assert.equal(r.clock.pending, 0);
    assert.equal(r.world.attachedCount(), 0);

    // couverture : la simulation a bien produit des pannes de chaque sorte
    const kinds = new Set(r.logs.map((l) => l.type === 'error' ? 'error:' + l.code : l.type));
    for (const k of ['onend-manquant', 'start-timeout', 'error:network']) assert.ok(kinds.has(k), `jamais vu : ${k}`);
    const spoken = r.world.spoken.length;
    console.log(`  graine ${seed} : ${r.sup.restarts} relances, ${idx.length}/${spoken} mots transcrits, ` +
      `${r.world.delivered.size} livrés, ${r.logs.filter((l) => l.type === 'watchdog').length} watchdogs`);
  });
}
