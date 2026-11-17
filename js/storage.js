// Persistance : IndexedDB (principal) + localStorage (miroir de secours).
// Chaque écriture part vers les deux ; chaque lecture fusionne les deux et garde
// la version la plus récente. L'échec de l'un n'empêche jamais l'autre.
// Session : { id, title, startedAt, updatedAt, endedAt, segments: [{ t, text, kind, edit?, durationMs? }], interim }

const newer = (a, b) => {
  if (!a) return b;
  if (!b) return a;
  if ((a.updatedAt || 0) !== (b.updatedAt || 0)) return (a.updatedAt || 0) > (b.updatedAt || 0) ? a : b;
  return (a.segments?.length || 0) >= (b.segments?.length || 0) ? a : b;
};

export class MemoryBackend {
  constructor() { this.m = new Map(); this.name = 'memoire'; }
  async put(s) { this.m.set(s.id, structuredClone(s)); }
  async get(id) { const s = this.m.get(id); return s ? structuredClone(s) : null; }
  async delete(id) { this.m.delete(id); }
  async list() { return [...this.m.values()].map((s) => structuredClone(s)); }
}

export class LocalStorageBackend {
  constructor(ls = globalThis.localStorage, prefix = 'tc.session.') {
    this.ls = ls; this.prefix = prefix; this.name = 'localStorage';
  }
  // Écriture synchrone dans le corps de la fonction : la donnée est sur disque
  // avant même que la promesse ne soit rendue.
  async put(s) {
    const key = this.prefix + s.id;
    const json = JSON.stringify(s);
    try {
      this.ls.setItem(key, json);
    } catch (e) {
      // Quota (~5 Mo) : on libère les plus anciennes sessions terminées (elles restent dans IndexedDB).
      const olds = this._all().filter((x) => x.id !== s.id && x.endedAt).sort((a, b) => a.updatedAt - b.updatedAt);
      for (const o of olds) {
        this.ls.removeItem(this.prefix + o.id);
        try { this.ls.setItem(key, json); return; } catch { /* encore trop gros */ }
      }
      throw e;
    }
  }
  async get(id) {
    const v = this.ls.getItem(this.prefix + id);
    return v ? JSON.parse(v) : null;
  }
  async delete(id) { this.ls.removeItem(this.prefix + id); }
  _all() {
    const out = [];
    for (let i = 0; i < this.ls.length; i++) {
      const k = this.ls.key(i);
      if (!k || !k.startsWith(this.prefix)) continue;
      try { out.push(JSON.parse(this.ls.getItem(k))); } catch { /* entrée corrompue : ignorée */ }
    }
    return out;
  }
  async list() { return this._all(); }
}

export class IDBBackend {
  constructor(idb = globalThis.indexedDB, dbName = 'transcription-cours') {
    this.name = 'IndexedDB';
    this.db = new Promise((resolve, reject) => {
      const req = idb.open(dbName, 1);
      req.onupgradeneeded = () => req.result.createObjectStore('sessions', { keyPath: 'id' });
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => db.close();
        resolve(db);
      };
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('IndexedDB bloquée'));
    });
    this.db.catch(() => {}); // l'erreur remonte à chaque opération, gérée par Storage
  }
  async _tx(mode, fn) {
    const db = await this.db;
    return new Promise((resolve, reject) => {
      const tx = db.transaction('sessions', mode);
      const store = tx.objectStore('sessions');
      let result;
      const r = fn(store);
      if (r) r.onsuccess = () => { result = r.result; };
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('transaction annulée'));
    });
  }
  put(s) { const copy = structuredClone(s); return this._tx('readwrite', (st) => st.put(copy)); }
  async get(id) { return (await this._tx('readonly', (st) => st.get(id))) || null; }
  delete(id) { return this._tx('readwrite', (st) => st.delete(id)); }
  async list() { return (await this._tx('readonly', (st) => st.getAll())) || []; }
}

export class Storage {
  constructor(backends, { onError = () => {}, now = () => Date.now() } = {}) {
    this.backends = backends;
    this.onError = onError;
    this.now = now;
    this.lastError = null;
  }

  async _each(op, fn) {
    const res = await Promise.allSettled(this.backends.map((b) => {
      try { return fn(b); } catch (e) { return Promise.reject(e); }
    }));
    res.forEach((r, i) => {
      if (r.status === 'rejected') {
        this.lastError = `${this.backends[i].name} ${op} : ${r.reason && r.reason.message || r.reason}`;
        this.onError(this.lastError);
      }
    });
    if (res.every((r) => r.status === 'rejected')) throw new Error('aucun stockage disponible');
    return res.filter((r) => r.status === 'fulfilled').map((r) => r.value);
  }

  // Appelé à chaque segment final, AVANT toute mise à jour de l'UI.
  save(session) {
    session.updatedAt = this.now();
    return this._each('écriture', (b) => b.put(session));
  }

  async get(id) {
    const all = await this._each('lecture', (b) => b.get(id));
    return all.reduce(newer, null);
  }

  async list() {
    const lists = await this._each('liste', (b) => b.list());
    const byId = new Map();
    for (const l of lists) for (const s of l || []) if (s && s.id) byId.set(s.id, newer(byId.get(s.id), s));
    return [...byId.values()].sort((a, b) => b.startedAt - a.startedAt);
  }

  delete(id) { return this._each('suppression', (b) => b.delete(id)); }

  // Session restée ouverte (fermeture brutale, crash, rechargement).
  async findUnfinished() {
    return (await this.list()).find((s) => !s.endedAt) || null;
  }
}

export function newSession(now = Date.now()) {
  const d = new Date(now);
  const p = (n) => String(n).padStart(2, '0');
  return {
    id: `s${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    title: `Cours du ${p(d.getDate())}/${p(d.getMonth() + 1)} à ${p(d.getHours())} h ${p(d.getMinutes())}`,
    startedAt: now, updatedAt: now, endedAt: null, segments: [], interim: '',
  };
}

// Reprise : l'intermédiaire sauvegardé devient un final, puis on marque la coupure.
export function recoverSession(s, now = Date.now()) {
  if (s.interim && s.interim.trim()) s.segments.push({ t: s.updatedAt, text: s.interim.trim(), kind: 'final' });
  s.interim = '';
  const gap = now - (s.updatedAt || now);
  if (gap > 1000) s.segments.push({ t: now, text: '', kind: 'gap', durationMs: gap });
  return s;
}
