/* Modelo presidencial local. Não acessa rede nem DOM. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.EleicoesModelo = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const UFS = ['ac','al','am','ap','ba','ce','df','es','go','ma','mg','ms','mt','pa','pb','pe','pi','pr','rj','rn','ro','rr','rs','sc','se','sp','to','zz'];
  const clamp = x => Math.max(0, Math.min(1, x));
  const valid = x => typeof x === 'number' && Number.isFinite(x);
  const candidate = (row, n) => row && Array.isArray(row.cands) && row.cands.find(c => String(c.n) === n);

  function normal(random) {
    let u = 0, v = 0;
    while (!u) u = random();
    while (!v) v = random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  function simulate(model, snapshot, options = {}) {
    const count = options.simulations === undefined ? 5000 : options.simulations;
    const random = options.random || Math.random;
    if (!model || !snapshot || !snapshot.pres || !snapshot.pres.r1 || !snapshot.pres.r2 || !model.abrangencias || !model.nacional || !Number.isInteger(count) || count < 1 || !valid(model.nacional.sd_nac) || model.nacional.sd_nac < 0) return unavailable('parâmetros ou dados ausentes');
    const rows = [];
    for (const uf of UFS) {
      const hist = model.abrangencias[uf], first = snapshot.pres.r1[uf], second = snapshot.pres.r2[uf];
      const pt1 = candidate(first, '13'), fl1 = candidate(first, '22');
      if (!hist || !first || !valid(first.vv) || first.vv <= 0 || !pt1 || !fl1 || !valid(pt1.v) || !valid(fl1.v) || pt1.v + fl1.v <= 0 || !valid(hist.sd_uf) || hist.sd_uf < 0) return unavailable(`base insuficiente em ${uf.toUpperCase()}`);
      const base = pt1.v / (pt1.v + fl1.v), E = first.vv;
      const pt2 = candidate(second, '13'), fl2 = candidate(second, '22');
      const q = second && valid(second.pst) ? clamp(second.pst / 100) : 0;
      const observed = q > 0 && pt2 && fl2 && valid(pt2.v) && valid(fl2.v) && pt2.v + fl2.v > 0;
      rows.push({ uf, base, E, sd: hist.sd_uf, q: observed ? q : 0, observed,
        fixedPT: observed ? pt2.v : 0, fixedFl: observed ? fl2.v : 0,
        observedShare: observed ? pt2.v / (pt2.v + fl2.v) : 0 });
    }

    // O choque nacional durante a apuração acompanha o swing observado ponderado por votos válidos.
    let swingWeight = 0, swingTotal = 0;
    for (const r of rows) if (r.observed) { swingWeight += r.E; swingTotal += r.E * (r.observedShare - r.base); }
    const center = swingWeight ? swingTotal / swingWeight : 0;

    // Quando todas as abrangências estão em 100%, os votos observados são o resultado final.
    if (rows.every(r => r.observed && r.q === 1)) {
      const pt = rows.reduce((s, r) => s + r.fixedPT, 0), fl = rows.reduce((s, r) => s + r.fixedFl, 0);
      if (pt === fl) return { available: true, pt: 50, opositor: 50, tie: true, simulations: 0, reason: 'empate no resultado final' };
      return { available: true, pt: pt > fl ? 100 : 0, opositor: fl > pt ? 100 : 0, tie: false, simulations: 0, reason: 'resultado nacional final' };
    }

    let ptWins = 0, flWins = 0, ties = 0;
    for (let i = 0; i < count; i++) {
      const nationalShock = normal(random) * model.nacional.sd_nac;
      let ptVotes = 0, flVotes = 0;
      for (const r of rows) {
        if (r.observed && r.q === 1) { ptVotes += r.fixedPT; flVotes += r.fixedFl; continue; }
        const remaining = r.E * (1 - r.q);
        const share = r.observed
          ? clamp(r.observedShare + normal(random) * r.sd * Math.sqrt(1 - r.q))
          : clamp(r.base + center + nationalShock + normal(random) * r.sd);
        ptVotes += r.fixedPT + remaining * share;
        flVotes += r.fixedFl + remaining * (1 - share);
      }
      if (ptVotes > flVotes) ptWins++;
      else if (flVotes > ptVotes) flWins++;
      else ties++;
    }
    const pt = (ptWins + ties / 2) * 100 / count;
    return { available: true, pt, opositor: 100 - pt, tie: ptWins === 0 && flWins === 0, simulations: count, nationalSwingCenter: center };
  }

  function unavailable(reason) { return { available: false, pt: null, opositor: null, reason }; }
  return { UFS: UFS.slice(), simulate };
});
