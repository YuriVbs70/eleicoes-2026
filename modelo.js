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

  function hashSeed(value) {
    const text = String(value);
    let hash = 2166136261;
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }

  function mulberry32(seed) {
    let state = seed >>> 0;
    return function () {
      state = (state + 0x6D2B79F5) | 0;
      let value = state;
      value = Math.imul(value ^ (value >>> 15), value | 1);
      value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
      return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
  }

  function snapshotSeed(snapshot, version) {
    const values = UFS.map(uf => {
      const row = snapshot && snapshot.pres && snapshot.pres.r2 && snapshot.pres.r2[uf];
      const pt = candidate(row, '13'), flavio = candidate(row, '22');
      return [uf, row && row.pst, pt && pt.v, flavio && flavio.v];
    });
    return hashSeed(JSON.stringify([version || 'modelo-v1', values]));
  }

  function normal(random) {
    let u = 0, v = 0;
    while (!u) u = random();
    while (!v) v = random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  function simulate(model, snapshot, options = {}) {
    const count = options.simulations === undefined ? 5000 : options.simulations;
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
    const rawCenter = swingWeight ? swingTotal / swingWeight : 0;
    // Encolhimento: o swing observado só pesa na proporção dos votos já contados no país (k = Σ E·q / Σ E).
    // Sem isso, poucas seções (ex.: só o Exterior) ditariam 100%/0% para o Brasil inteiro.
    const totalE = rows.reduce((s, r) => s + r.E, 0);
    const k = totalE ? rows.reduce((s, r) => s + r.E * r.q, 0) / totalE : 0;
    const bu = options.bu, zz = bu && bu.zz, br = bu && bu.br;
    const zzOfficial = snapshot.pres.r2.zz && valid(snapshot.pres.r2.zz.pst) && snapshot.pres.r2.zz.pst > 0;
    const kZ = zz && valid(zz.swing) && Number.isInteger(zz.n) && zz.n >= 20 && valid(zz.frac) && !zzOfficial ? 0.02 * clamp(zz.frac) : 0;
    const kS = br && valid(br.swing) && Number.isInteger(br.n) && br.n >= 30 ? 0.5 * br.n / (br.n + 300) * (1 - k) : 0;
    // Exterior: teto de ±3 pp no swing para nunca mover o centro nacional mais que ~0,9 pp.
    const cZ = kZ > 0 ? Math.max(-0.03, Math.min(0.03, zz.swing)) : 0;
    const cS = kS > 0 ? Math.max(-0.15, Math.min(0.15, br.swing)) : 0;
    const buWeight = kS + kZ;
    const buUrnas = (kZ > 0 ? zz.n : 0) + (kS > 0 ? br.n : 0);
    const buEscopo = kS > 0 ? (kZ > 0 ? 'br+zz' : 'br') : (kZ > 0 ? 'zz' : null);
    const center = buWeight > 0 ? (k * rawCenter + kS * cS + kZ * cZ) / (k + kS + kZ + 0.05) : rawCenter * (k / (k + 0.05));
    // Só a amostra do Brasil reduz a incerteza nacional; o Exterior move o centro, mas não estreita.
    const nationalSd = model.nacional.sd_nac * Math.sqrt(0.05 / (0.05 + kS));
    let seed = snapshotSeed(snapshot, model.versao);
    if (buWeight > 0) seed = hashSeed(JSON.stringify([seed, buUrnas, Math.round(cS * 1e6), Math.round(cZ * 1e6), kS, kZ]));
    const random = options.random || mulberry32(options.seed === undefined ? seed : hashSeed(options.seed));

    // Quando todas as abrangências estão em 100%, os votos observados são o resultado final.
    if (rows.every(r => r.observed && r.q === 1)) {
      const pt = rows.reduce((s, r) => s + r.fixedPT, 0), fl = rows.reduce((s, r) => s + r.fixedFl, 0);
      if (pt === fl) return { available: true, pt: 50, opositor: 50, tie: true, simulations: 0, reason: 'empate no resultado final' };
      return { available: true, pt: pt > fl ? 100 : 0, opositor: fl > pt ? 100 : 0, tie: false, simulations: 0, reason: 'resultado nacional final' };
    }

    let ptWins = 0, flWins = 0, ties = 0;
    for (let i = 0; i < count; i++) {
      const nationalShock = normal(random) * nationalSd;
      let ptVotes = 0, flVotes = 0;
      for (const r of rows) {
        if (r.observed && r.q === 1) { ptVotes += r.fixedPT; flVotes += r.fixedFl; continue; }
        const remaining = r.E * (1 - r.q);
        // Seções já contadas não representam o resto (ordem de apuração): o % observado só pesa aos poucos
        // (w = q/(q+0,10)) e o resto da UF continua sujeito ao choque nacional comum, encolhendo com √(1−q).
        const w = r.q / (r.q + 0.10);
        const share = r.observed
          ? clamp(w * r.observedShare + (1 - w) * (r.base + center) + (nationalShock + normal(random) * r.sd) * Math.sqrt(1 - r.q))
          : clamp(r.base + center + nationalShock + normal(random) * r.sd);
        ptVotes += r.fixedPT + remaining * share;
        flVotes += r.fixedFl + remaining * (1 - share);
      }
      if (ptVotes > flVotes) ptWins++;
      else if (flVotes > ptVotes) flWins++;
      else ties++;
    }
    const pt = (ptWins + ties / 2) * 100 / count;
    return { available: true, pt, opositor: 100 - pt, tie: ptWins === 0 && flWins === 0, simulations: count, nationalSwingCenter: center, buWeight, buUrnas, buEscopo, officialK: k };
  }

  function unavailable(reason) { return { available: false, pt: null, opositor: null, reason }; }
  return { UFS: UFS.slice(), simulate };
});
