'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { simulate, UFS } = require('../modelo.js');

function fixture(base = 0.49) {
  const model = { versao: 'test-bu', abrangencias: {}, nacional: { sd_nac: 0.04 } };
  const snapshot = { pres: { r1: {}, r2: {} } };
  for (const uf of UFS) {
    model.abrangencias[uf] = { sd_uf: 0.02 };
    snapshot.pres.r1[uf] = { vv: 100000, cands: [
      { n: '13', v: base * 100000 }, { n: '22', v: (1 - base) * 100000 }
    ] };
  }
  return { model, snapshot };
}

test('absent and null BU preserve the original deterministic results', () => {
  const { model, snapshot } = fixture();
  const result = simulate(model, snapshot);
  assert.deepEqual(simulate(model, snapshot, { bu: undefined }), result);
  assert.deepEqual(simulate(model, snapshot, { bu: null }), result);
  // Recorded from the original implementation with this fixture and default seed.
  assert.equal(result.pt, 40.78);
  assert.equal(result.opositor, 59.22);
  assert.equal(result.nationalSwingCenter, 0);
  assert.equal(result.buWeight, 0);
  assert.equal(result.buUrnas, 0);
  assert.equal(result.buEscopo, null);
  assert.equal(result.officialK, 0);
  snapshot.pres.r2.ac = { pst: 20, cands: [{ n: '13', v: 11000 }, { n: '22', v: 9000 }] };
  assert.equal(simulate(model, snapshot).pt, 48.98);
});

test('Exterior evidence slightly increases a close chance and is deterministic', () => {
  const { model, snapshot } = fixture(0.5);
  const options = { bu: { zz: { swing: 0.01, n: 564, frac: 0.42 }, br: null } };
  const result = simulate(model, snapshot, options);
  const baseline = simulate(model, snapshot);
  assert.ok(result.pt > baseline.pt && result.pt - baseline.pt < 10);
  assert.ok(result.pt > 1 && result.pt < 99);
  assert.equal(result.buWeight, 0.5 * 0.42);
  assert.equal(result.buUrnas, 564);
  assert.equal(result.buEscopo, 'zz');
  assert.deepEqual(simulate(model, snapshot, options), result);
});

test('Exterior chance is non-decreasing with swing', () => {
  const { model, snapshot } = fixture();
  const chances = [-0.05, 0, 0.05].map(swing => simulate(model, snapshot, {
    bu: { zz: { swing, n: 564, frac: 0.42 } }
  }).pt);
  assert.ok(chances[0] <= chances[1] && chances[1] <= chances[2]);
});

test('larger Brazil sample moves a close chance more without certainty', () => {
  const { model, snapshot } = fixture();
  const baseline = simulate(model, snapshot).pt;
  const chances = [30, 1000].map(n => simulate(model, snapshot, {
    bu: { br: { swing: 0.03, se: 0.01, n, amostra: 2000 } }
  }).pt);
  assert.ok(chances[1] - baseline > chances[0] - baseline);
  chances.forEach(pt => assert.ok(pt > 0 && pt < 100));
});

test('official Exterior evidence replaces BU evidence completely', () => {
  const { model, snapshot } = fixture();
  snapshot.pres.r2.zz = { pst: 1, cands: [{ n: '13', v: 550 }, { n: '22', v: 450 }] };
  const result = simulate(model, snapshot, { bu: { zz: { swing: 0.05, n: 564, frac: 0.42 } } });
  assert.equal(result.buEscopo, null);
  assert.deepEqual(result, simulate(model, snapshot));
});

test('garbage and insufficient BU evidence leave the original path unchanged', () => {
  const { model, snapshot } = fixture();
  const baseline = simulate(model, snapshot);
  for (const bu of [false, 42, 'garbage', [], {}, { zz: { swing: 'x' } },
    { br: { swing: NaN, n: 100 } }, { br: { swing: 0.03, n: Infinity } },
    { zz: { swing: 0.01, n: 564 } }, { zz: { swing: 0.01, n: 19, frac: 0.42 } },
    { br: { swing: 0.03, n: 29 } }]) {
    assert.deepEqual(simulate(model, snapshot, { bu }), baseline);
  }
});

test('without BU the center retains the original official shrinkage formula', () => {
  const { model, snapshot } = fixture();
  snapshot.pres.r2.ac = { pst: 20, cands: [{ n: '13', v: 11000 }, { n: '22', v: 9000 }] };
  const result = simulate(model, snapshot);
  const k = (100000 * 0.2) / (100000 * UFS.length), rawCenter = 0.55 - 0.49;
  assert.equal(result.officialK, k);
  assert.ok(Math.abs(result.nationalSwingCenter - rawCenter * k / (k + 0.05)) < 1e-15);
  assert.equal(result.nationalSwingCenter, rawCenter * (k / (k + 0.05)));
});

test('combined evidence weights and bounds follow the specified formulas', () => {
  const { model, snapshot } = fixture();
  const result = simulate(model, snapshot, {
    bu: { zz: { swing: 1, n: 20, frac: 2 }, br: { swing: -1, n: 30 } }
  });
  const kZ = 0.5, kS = 0.5 * 30 / 330;
  assert.equal(result.buWeight, kZ + kS);
  assert.equal(result.buUrnas, 50);
  assert.equal(result.buEscopo, 'br+zz');
  assert.equal(result.nationalSwingCenter, (kS * -0.15 + kZ * 0.08) / (kS + kZ + 0.05));
});

test('the fully counted final branch remains unchanged with BU evidence', () => {
  const { model, snapshot } = fixture();
  for (const uf of UFS) snapshot.pres.r2[uf] = {
    pst: 100, cands: [{ n: '13', v: 49000 }, { n: '22', v: 51000 }]
  };
  const baseline = simulate(model, snapshot);
  assert.deepEqual(simulate(model, snapshot, { bu: { br: { swing: 0.03, n: 1000 } } }), baseline);
  assert.deepEqual(baseline, { available: true, pt: 0, opositor: 100, tie: false, simulations: 0, reason: 'resultado nacional final' });
});

// Parciais municipais (v3.11)
function biased() {
  // Base 50/50; parciais oficiais viesadas: os municípios pró-Lula chegaram primeiro (UF parcial 56%), swing real 0.
  const { model, snapshot } = fixture(0.5);
  for (const uf of UFS) snapshot.pres.r2[uf] = { pst: 20, cands: [{ n: '13', v: 11200 }, { n: '22', v: 8800 }] };
  const ufs = {}; for (const uf of UFS) ufs[uf] = { s: 0, cov: 0.2, n: 50, b_rest: 0.485 };
  return { model, snapshot, mun: { swing: 0, n: 1350, cov: 0.2, ufs } };
}

test('municipal partials remove composition bias from the official partial', () => {
  const { model, snapshot, mun } = biased();
  const raw = simulate(model, snapshot);
  const fixed = simulate(model, snapshot, { bu: { zz: null, br: null, mun } });
  assert.ok(raw.pt > 90, 'raw partial alone is heavily biased: ' + raw.pt);
  assert.ok(fixed.munUsado);
  assert.ok(fixed.pt > 25 && fixed.pt < 75, 'with municipal swing 0 the race stays open: ' + fixed.pt);
  assert.ok(fixed.pt < raw.pt);
});

test('municipal evidence is monotone and ignored without official count', () => {
  const { model, snapshot, mun } = biased();
  let prev = -1;
  for (const s of [-0.03, -0.01, 0, 0.01, 0.03]) {
    const ufs = {}; for (const uf of UFS) ufs[uf] = { s, cov: 0.2, n: 50, b_rest: 0.485 };
    const pt = simulate(model, snapshot, { bu: { mun: { ...mun, swing: s, ufs } } }).pt;
    assert.ok(pt >= prev, 'monotone at ' + s); prev = pt;
  }
  const { model: m2, snapshot: s2 } = fixture(0.5);
  const r = simulate(m2, s2, { bu: { mun } });
  assert.equal(r.munUsado, false);
  assert.deepEqual(r.pt, simulate(m2, s2).pt);
});

test('tiny municipal coverage never gives 100/0', () => {
  const { model, snapshot } = fixture(0.5);
  snapshot.pres.r2.sp = { pst: 1, cands: [{ n: '13', v: 900 }, { n: '22', v: 100 }] };
  const r = simulate(model, snapshot, { bu: { mun: { swing: 0.3, n: 3, cov: 0.003, ufs: { sp: { s: 0.3, cov: 0.01, n: 3 } } } } });
  assert.ok(r.pt > 1 && r.pt < 99, String(r.pt));
});
