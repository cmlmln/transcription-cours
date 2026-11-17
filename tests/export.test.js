import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGlossary, compileGlossary, applyGlossary, cleanText, buildExport, formatDuration, withMarkers, countWords } from '../js/export.js';

test('glossaire : parse et remplace mots entiers, accents compris, insensible à la casse', () => {
  const rules = parseGlossary('en tropie → entropie\nbolt sman -> Boltzmann\nligne invalide\n é => e');
  assert.equal(rules.length, 3);
  const c = compileGlossary(rules);
  assert.equal(applyGlossary("L'En tropie de bolt  sman", c), "L'entropie de Boltzmann");
  assert.equal(applyGlossary('centropie', compileGlossary([['tropie', 'X']])), 'centropie');
  assert.equal(applyGlossary('été é', c), 'été e');
});

test('nettoyage : majuscule après un point, doubles espaces', () => {
  assert.equal(cleanText('bonjour.  il fait beau ! oui'), 'Bonjour. Il fait beau ! Oui');
});

test('durées', () => {
  assert.equal(formatDuration(72_000), '1 min 12 s');
  assert.equal(formatDuration(9_000), '9 s');
  assert.equal(formatDuration(2.5 * 3600_000), '2 h 30 min');
});

const T0 = new Date(2026, 10, 17, 10, 14, 0).getTime();
const session = {
  title: 'Thermo', startedAt: T0, endedAt: T0 + 12 * 60_000,
  segments: [
    { t: T0 + 1000, text: 'en tropie du système', kind: 'final' },
    { t: T0 + 2000, text: 'est croissante.  donc', kind: 'final', edit: 'est croissante. donc voilà' },
    { t: T0 + 3000, text: '', kind: 'gap', durationMs: 72_000 },
    { t: T0 + 7 * 60_000, text: 'suite', kind: 'final' },
  ],
};

test('repères toutes les 5 minutes', () => {
  assert.deepEqual(withMarkers(session.segments).filter((x) => x.marker).map((x) => x.marker), ['10:10', '10:20']);
});

test('export txt / md / texte nu, glossaire non destructif', () => {
  const g = [['en tropie', 'entropie']];
  const txt = buildExport(session, { format: 'txt', glossary: g });
  assert.match(txt, /^Thermo\nDate : 17\/11\/2026 10:14\nDurée : 12 min 00 s/);
  assert.match(txt, /— 10:10 —\n\nEntropie du système est croissante\. Donc voilà\n\n\[— coupure de 1 min 12 s —\]\n\n— 10:20 —\n\nSuite/);
  const md = buildExport(session, { format: 'md', glossary: g });
  assert.match(md, /^# Thermo/);
  assert.match(md, /\*\*— 10:10 —\*\*/);
  const plain = buildExport(session, { format: 'plain', glossary: g });
  assert.equal(plain, 'Entropie du système est croissante. Donc voilà […] suite\n');
  assert.equal(session.segments[0].text, 'en tropie du système'); // brut intact
});

test('compteur de mots (édition prise en compte, coupures ignorées)', () => {
  assert.equal(countWords(session.segments), 4 + 4 + 1);
});
