import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Storage, MemoryBackend, LocalStorageBackend, newSession, recoverSession } from '../js/storage.js';

class FakeLS { // localStorage minimal avec quota
  constructor(quota = Infinity) { this.m = new Map(); this.quota = quota; }
  get length() { return this.m.size; }
  key(i) { return [...this.m.keys()][i] ?? null; }
  getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }
  setItem(k, v) {
    const size = [...this.m].reduce((n, [kk, vv]) => n + (kk === k ? 0 : vv.length), 0) + v.length;
    if (size > this.quota) { const e = new Error('QuotaExceededError'); e.name = 'QuotaExceededError'; throw e; }
    this.m.set(k, String(v));
  }
  removeItem(k) { this.m.delete(k); }
}
class Broken { name = 'cassé'; put() { throw new Error('boom'); } async get() { throw new Error('boom'); } async list() { throw new Error('boom'); } async delete() { throw new Error('boom'); } }

test('écriture sur les deux backends, lecture fusionnée', async () => {
  const a = new MemoryBackend(), ls = new FakeLS(), b = new LocalStorageBackend(ls);
  const st = new Storage([a, b]);
  const s = newSession(1000);
  s.segments.push({ t: 1, text: 'bonjour', kind: 'final' });
  await st.save(s);
  assert.equal((await a.get(s.id)).segments.length, 1);
  assert.equal(JSON.parse(ls.getItem('tc.session.' + s.id)).segments[0].text, 'bonjour');
  assert.equal((await st.list()).length, 1);
});

test('localStorage écrit de façon synchrone (avant tout rendu UI)', () => {
  const ls = new FakeLS();
  const st = new Storage([new LocalStorageBackend(ls)]);
  const s = newSession();
  st.save(s); // pas d'await
  assert.ok(ls.getItem('tc.session.' + s.id));
});

test('un backend en panne n’empêche pas l’autre', async () => {
  const errors = [];
  const m = new MemoryBackend();
  const st = new Storage([new Broken(), m], { onError: (e) => errors.push(e) });
  const s = newSession();
  await st.save(s);
  assert.ok(await m.get(s.id));
  assert.equal((await st.get(s.id)).id, s.id);
  assert.equal((await st.list()).length, 1);
  assert.ok(errors.length >= 3);
});

test('tous les backends en panne : erreur explicite', async () => {
  const st = new Storage([new Broken()]);
  await assert.rejects(st.save(newSession()));
});

test('la version la plus récente gagne à la lecture', async () => {
  const a = new MemoryBackend(), b = new MemoryBackend();
  const s = newSession(0);
  await a.put({ ...s, updatedAt: 10, segments: [] });
  await b.put({ ...s, updatedAt: 20, segments: [{ t: 1, text: 'x', kind: 'final' }] });
  const st = new Storage([a, b]);
  assert.equal((await st.get(s.id)).segments.length, 1);
  assert.equal((await st.list())[0].updatedAt, 20);
});

test('quota localStorage : évince les vieilles sessions terminées', async () => {
  const ls = new FakeLS(3000);
  const b = new LocalStorageBackend(ls);
  const old = { ...newSession(1), endedAt: 5, updatedAt: 5, segments: [{ t: 1, text: 'a'.repeat(1500), kind: 'final' }] };
  await b.put(old);
  const cur = { ...newSession(2), updatedAt: 9, segments: [{ t: 1, text: 'b'.repeat(1500), kind: 'final' }] };
  await b.put(cur);
  assert.equal(ls.getItem('tc.session.' + old.id), null);
  assert.ok(ls.getItem('tc.session.' + cur.id));
});

test('session non terminée retrouvée, puis reprise avec coupure et intermédiaire promu', async () => {
  const st = new Storage([new MemoryBackend()], { now: () => 10_000 });
  const done = { ...newSession(0), endedAt: 1 };
  const open = newSession(5000);
  open.interim = 'fin de phrase';
  await st.save(done); await st.save(open);
  const found = await st.findUnfinished();
  assert.equal(found.id, open.id);
  recoverSession(found, 82_000);
  assert.deepEqual(found.segments.map((s) => s.kind), ['final', 'gap']);
  assert.equal(found.segments[0].text, 'fin de phrase');
  assert.equal(found.segments[1].durationMs, 72_000);
});

test('suppression sur tous les backends', async () => {
  const a = new MemoryBackend(), b = new LocalStorageBackend(new FakeLS());
  const st = new Storage([a, b]);
  const s = newSession();
  await st.save(s);
  await st.delete(s.id);
  assert.equal((await st.list()).length, 0);
});
