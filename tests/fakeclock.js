// Horloge factice : le temps n'avance que via advance(). Permet de simuler 2 h 30 en quelques secondes.
export class FakeClock {
  constructor(t = 1_700_000_000_000) { this.t = t; this.q = new Map(); this.seq = 0; }
  now = () => this.t;
  setTimeout = (fn, ms) => { const id = ++this.seq; this.q.set(id, { at: this.t + Math.max(0, ms || 0), fn, id }); return id; };
  clearTimeout = (id) => { this.q.delete(id); };
  get pending() { return this.q.size; }
  advance(ms) {
    const end = this.t + ms;
    for (;;) {
      let next = null;
      for (const x of this.q.values()) if (x.at <= end && (!next || x.at < next.at || (x.at === next.at && x.id < next.id))) next = x;
      if (!next) break;
      this.q.delete(next.id);
      this.t = next.at;
      next.fn();
    }
    this.t = end;
  }
}
