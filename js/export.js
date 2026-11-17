// Export et post-traitement local. Le glossaire ne touche jamais le texte brut
// stocké : il s'applique à l'affichage et à l'export.

const MARKER_MS = 5 * 60 * 1000;
const p2 = (n) => String(n).padStart(2, '0');
export const hhmm = (t) => { const d = new Date(t); return `${p2(d.getHours())}:${p2(d.getMinutes())}`; };

export function formatDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  if (h) return `${h} h ${p2(m)} min`;
  if (m) return `${m} min ${p2(r)} s`;
  return `${r} s`;
}

export const gapText = (seg) => `[— coupure de ${formatDuration(seg.durationMs || 0)} —]`;

// Une ligne par règle : « mal reconnu → correct » (accepte aussi -> et =>).
export function parseGlossary(text) {
  const rules = [];
  for (const line of String(text || '').split('\n')) {
    const m = line.match(/^(.+?)\s*(?:→|->|=>)\s*(.*)$/);
    if (m && m[1].trim()) rules.push([m[1].trim(), m[2].trim()]);
  }
  return rules;
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// \b ne connaît pas les lettres accentuées : on borne avec \p{L}.
export function compileGlossary(rules) {
  return rules.map(([from, to]) => [new RegExp(`(?<![\\p{L}\\p{N}])${esc(from).replace(/\s+/g, '\\s+')}(?![\\p{L}\\p{N}])`, 'giu'), to]);
}

export function applyGlossary(text, compiled) {
  let t = text;
  for (const [re, to] of compiled) t = t.replace(re, to);
  return t;
}

export function cleanText(s) {
  return s.replace(/[ \t]{2,}/g, ' ')
    .replace(/^\s*(\p{Ll})/u, (m, c) => m.slice(0, -1) + c.toUpperCase())
    .replace(/([.!?…]\s+)(\p{Ll})/gu, (m, a, c) => a + c.toUpperCase())
    .trim();
}

export const segText = (seg, compiled = []) => applyGlossary(seg.edit ?? seg.text, compiled);

// Fil avec repères horaires toutes les 5 minutes (utilisé par l'UI et l'export).
export function withMarkers(segments) {
  const out = [];
  let bucket = null;
  for (const seg of segments) {
    const b = Math.floor(seg.t / MARKER_MS);
    if (b !== bucket) { bucket = b; out.push({ marker: hhmm(b * MARKER_MS) }); }
    out.push({ seg });
  }
  return out;
}

export const countWords = (segments) =>
  segments.reduce((n, s) => n + (s.kind === 'final' ? ((s.edit ?? s.text).match(/[\p{L}\p{N}]+/gu) || []).length : 0), 0);

export function sessionDuration(s) {
  const last = s.segments.length ? s.segments[s.segments.length - 1].t : s.startedAt;
  return (s.endedAt || Math.max(last, s.updatedAt || 0)) - s.startedAt;
}

// format : 'txt' | 'md' | 'plain' (texte nu, sans horodatage, pour une IA)
export function buildExport(session, { format = 'txt', glossary = [], clean = true } = {}) {
  const compiled = compileGlossary(glossary);
  const fin = (t) => (clean ? cleanText(t) : t);
  if (format === 'plain') {
    const body = session.segments.map((s) => (s.kind === 'gap' ? '[…]' : segText(s, compiled))).join(' ');
    return fin(body) + '\n';
  }
  const d = new Date(session.startedAt);
  const date = `${p2(d.getDate())}/${p2(d.getMonth() + 1)}/${d.getFullYear()} ${hhmm(session.startedAt)}`;
  const dur = formatDuration(sessionDuration(session));
  const blocks = [];
  let para = [];
  const flush = () => { if (para.length) blocks.push(fin(para.join(' '))); para = []; };
  for (const x of withMarkers(session.segments)) {
    if (x.marker) { flush(); blocks.push(format === 'md' ? `**— ${x.marker} —**` : `— ${x.marker} —`); }
    else if (x.seg.kind === 'gap') { flush(); blocks.push(format === 'md' ? `*${gapText(x.seg)}*` : gapText(x.seg)); }
    else para.push(segText(x.seg, compiled));
  }
  flush();
  const head = format === 'md'
    ? `# ${session.title}\n\n- Date : ${date}\n- Durée : ${dur}\n`
    : `${session.title}\nDate : ${date}\nDurée : ${dur}\n`;
  return `${head}\n${blocks.join('\n\n')}\n`;
}

export const fileName = (session, ext) =>
  (session.title || 'cours').replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim() + '.' + ext;
