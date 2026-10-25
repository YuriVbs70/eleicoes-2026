(function () {
  'use strict';

  const UF_NAMES = {
    ac: 'Acre', al: 'Alagoas', ap: 'Amapá', am: 'Amazonas', ba: 'Bahia', ce: 'Ceará', df: 'Distrito Federal',
    es: 'Espírito Santo', go: 'Goiás', ma: 'Maranhão', mt: 'Mato Grosso', ms: 'Mato Grosso do Sul', mg: 'Minas Gerais',
    pa: 'Pará', pb: 'Paraíba', pr: 'Paraná', pe: 'Pernambuco', pi: 'Piauí', rj: 'Rio de Janeiro', rn: 'Rio Grande do Norte',
    rs: 'Rio Grande do Sul', ro: 'Rondônia', rr: 'Roraima', sc: 'Santa Catarina', sp: 'São Paulo', se: 'Sergipe', to: 'Tocantins', zz: 'Exterior'
  };
  const fmtNumber = new Intl.NumberFormat('pt-BR');
  const fmtPercent = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const $ = (id) => document.getElementById(id);
  const LIVE_BASE = 'https://resultados.tse.jus.br/oficial/ele2026/';
  const PRESIDENT_UFS = ['br','ac','al','ap','am','ba','ce','df','es','go','ma','mt','ms','mg','pa','pb','pr','pe','pi','rj','rn','rs','ro','rr','sc','sp','se','to','zz'];
  const GOVERNOR_UFS = ['ac','am','df','es','rn','to'];
  const REFRESH_MS = 30000;
  const COUNTING_START = Date.parse('2026-10-25T17:00:00-03:00');
  const REGION_UFS = { Norte:['ac','am','ap','pa','ro','rr','to'], Nordeste:['al','ba','ce','ma','pb','pe','pi','rn','se'], 'Centro-Oeste':['df','go','ms','mt'], Sudeste:['es','mg','rj','sp'], Sul:['pr','rs','sc'], Exterior:['zz'] };
  const HISTORY_KEY = 'eleicoes-2026-apuracao-v1';
  const seenMilestones = new Set();
  let electionModel = null;
  let chanceVersion = 0;
  let lastChance = null;

  function chanceMarkup(result, timestamp, stale) {
    if (!result || !result.available || !Number.isFinite(result.pt) || !Number.isFinite(result.opositor)) {
      return '<section class="data-panel chance-panel" aria-live="polite"><div class="section-heading compact"><div><p class="eyebrow">MONTE CARLO</p><h2>Chance de vitória</h2></div></div><p class="muted">' + safeText(result && result.reason || 'Carregando parâmetros estatísticos locais…') + '</p></section>';
    }
    const pt = Math.max(0, Math.min(100, result.pt));
    const flavio = 100 - pt;
    const ptRounded = Math.round(pt);
    const flavioRounded = 100 - ptRounded;
    const when = timestamp ? new Date(timestamp).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';
    return '<section class="data-panel chance-panel" aria-live="polite"><div class="section-heading compact"><div><p class="eyebrow">MONTE CARLO · 5.000 SIMULAÇÕES</p><h2>Chance de vitória</h2></div><span class="chance-status">' + (stale ? 'desatualizada' : 'atualizada') + '</span></div>' +
      '<p class="chance-label">estimativa estatística, não oficial</p><div class="chance-values"><span class="chance-flavio"><b>Flávio</b><strong>' + flavioRounded + '%</strong></span><span class="chance-lula"><b>Lula</b><strong>' + ptRounded + '%</strong></span></div>' +
      '<div class="chance-bar" role="group" aria-label="Chance de vitória: Flávio ' + flavioRounded + ' por cento, Lula ' + ptRounded + ' por cento"><span class="chance-bar-flavio" role="meter" aria-label="Chance de vitória de Flávio Bolsonaro" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + flavioRounded + '" style="width:' + flavio + '%"></span><span class="chance-bar-lula" role="meter" aria-label="Chance de vitória de Lula" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + ptRounded + '" style="width:' + pt + '%"></span></div>' +
      '<p class="chance-time">' + (result.tie ? 'Empate nas simulações' : 'Probabilidade de vitória · não é percentual de votos') + ' · atualizado às ' + when + (stale ? ' · último cálculo válido' : '') + '</p>' +
      '<details class="chance-method"><summary>Como calculamos</summary><p>Executamos 5.000 simulações com a base bilateral e os votos válidos do 1º turno de 2026. A dispersão vem da mudança entre turnos de 2022; cada simulação aplica um choque nacional comum e choques estaduais. Votos já contados ficam fixos e a incerteza diminui conforme a apuração avança, usando % de seções como aproximação.</p><p>Há somente três eleições no histórico usado, os pesos vêm do 1º turno e % de seções aproxima a fração dos votos contados. <strong>Não há dados históricos de ordem de apuração</strong>, portanto o modelo não corrige esse viés. Probabilidade não é resultado oficial nem garantia.</p><p><a href="data/historico.json">Histórico</a> · <a href="data/modelo.json">Parâmetros</a> · <a href="https://resultados.tse.jus.br/oficial/ele2026/" target="_blank" rel="noopener noreferrer">Fontes TSE</a></p></details></section>';
  }
  function updateChance(snapshot, stale) {
    const target = typeof document !== 'undefined' ? $('pres-chance') : null;
    if (!target || !electionModel || !globalThis.EleicoesModelo) return;
    const version = ++chanceVersion;
    target.innerHTML = chanceMarkup(lastChance && lastChance.result, lastChance && lastChance.timestamp, true);
    setTimeout(() => {
      if (version !== chanceVersion) return;
      try {
        const result = globalThis.EleicoesModelo.simulate(electionModel, snapshot, { simulations: 5000 });
        if (version !== chanceVersion) return;
        if (result && result.available) lastChance = { result, timestamp: Date.now() };
        target.innerHTML = chanceMarkup(lastChance && lastChance.result || result, lastChance && lastChance.timestamp, !!stale || !result || !result.available);
      } catch (_) {
        target.innerHTML = chanceMarkup(lastChance && lastChance.result, lastChance && lastChance.timestamp, true);
      }
    }, 0);
  }

  // Normaliza o formato oficial do TSE para o contrato de snapshot.json.
  function num(value) {
    const parsed = Number.parseFloat(String(value == null ? '' : value).replace(',', '.'));
    return Number.isFinite(parsed) ? parsed : 0;
  }
  function parseResult(data) {
    if (!data || !Array.isArray(data.carg) || !data.carg[0] || typeof data.carg[0] !== 'object') {
      throw new TypeError('JSON TSE sem carg[0]');
    }
    const s = data.s || {}, e = data.e || {}, v = data.v || {};
    const cands = [];
    const groups = data.carg[0].agr;
    if (groups != null && !Array.isArray(groups)) throw new TypeError('agr inválido');
    (groups || []).forEach((a) => {
      if (!a || (a.par != null && !Array.isArray(a.par))) throw new TypeError('par inválido');
      (a.par || []).forEach((p) => {
        if (!p || (p.cand != null && !Array.isArray(p.cand))) throw new TypeError('cand inválido');
        (p.cand || []).forEach((c) => {
          if (!c || c.n == null) throw new TypeError('candidato sem número');
          cands.push({ n: c.n, nm: c.nmu || c.nm || null, sg: p.sg == null ? null : p.sg, sq: c.sqcand == null ? null : c.sqcand,
            v: Number.parseInt(c.vap || 0, 10) || 0, p: num(c.pvapn), st: c.st || '' });
        });
      });
    });
    cands.sort((a, b) => b.v - a.v);
    return { pst: num(s.pstn), st: Number.parseInt(s.st || 0, 10) || 0,
      ts: Number.parseInt(s.ts || 0, 10) || 0, te: Number.parseInt(e.te || 0, 10) || 0,
      comp: Number.parseInt(e.c || 0, 10) || 0, pc: num(e.pcn), vv: Number.parseInt(v.vv || 0, 10) || 0,
      vb: Number.parseInt(v.vb || 0, 10) || 0, vn: Number.parseInt(v.tvn || 0, 10) || 0,
      dg: data.dg == null ? null : data.dg, hg: data.hg == null ? null : data.hg,
      tf: data.tf == null ? null : data.tf, cands };
  }

  function safeText(value) {
    return String(value == null ? '—' : value).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
  }
  function pct(value) { return Number.isFinite(Number(value)) ? fmtPercent.format(Number(value)) + '%' : '—'; }
  function candidateCard(candidate, turn) {
    const name = candidate.nm || 'Candidatura';
    const party = candidate.sg || 'Partido não informado';
    return '<article class="candidate-card"><div class="candidate-top"><span class="candidate-number">' + safeText(candidate.n || '—') + '</span><span class="candidate-party">' + safeText(party) + '</span></div>' +
      '<h3>' + safeText(name) + '</h3><p class="candidate-percent">' + pct(candidate.p) + '</p><p class="muted">' + fmtNumber.format(Number(candidate.v) || 0) + ' votos · ' + safeText(turn) + '</p></article>';
  }
  const PRESIDENT_CANDIDATES = [
    { n: '22', name: 'Flávio Bolsonaro', color: 'blue' },
    { n: '13', name: 'Lula', color: 'red' }
  ];
  function candidateByNumber(result, number) {
    return result && Array.isArray(result.cands) ? result.cands.find((candidate) => String(candidate.n) === number) || null : null;
  }
  function comparisonData(first, opponent, second) {
    if (!first || !opponent || !second || !Number.isFinite(Number(first.p)) || !Number.isFinite(Number(opponent.p)) || !Number.isFinite(Number(second.p))) return null;
    const denominator = Number(first.p) + Number(opponent.p);
    const bilateral = denominator > 0 ? Number(first.p) * 100 / denominator : null;
    return {
      bilateral,
      other: denominator > 0 ? 100 - denominator : null,
      delta: bilateral == null ? null : Number(second.p) - bilateral,
      rawDelta: Number(second.p) - Number(first.p),
      votesDelta: Number.isFinite(Number(first.v)) && Number.isFinite(Number(second.v)) ? Number(second.v) - Number(first.v) : null
    };
  }
  function displayOrDash(value, formatter) { return value != null && Number.isFinite(Number(value)) ? formatter(Number(value)) : 'Indisponível'; }
  function presidentialCard(config, first, second, firstResult, secondResult) {
    const awaiting = isAwaiting({ pres: { r2: { br: secondResult } } });
    const opponent = candidateByNumber(firstResult, config.n === '22' ? '13' : '22');
    const stats = comparisonData(first, opponent, second);
    const firstPct = first ? Number(first.p) : NaN;
    const secondPct = second ? Number(second.p) : NaN;
    const progress = Math.max(0, Math.min(100, Number(secondResult && secondResult.pst) || 0));
    const photo = (second && second.sq) || (first && first.sq);
    const v1 = first && Number.isFinite(Number(first.v)) ? Number(first.v) : NaN;
    const v2 = second && Number.isFinite(Number(second.v)) ? Number(second.v) : NaN;
    const difference = stats && stats.votesDelta != null ? fmtNumber.format(Math.abs(stats.votesDelta)) : 'Indisponível';
    const sign = stats && stats.votesDelta != null ? (stats.votesDelta > 0 ? '+' : stats.votesDelta < 0 ? '−' : '') : '';
    const barA = Number.isFinite(secondPct) ? Math.max(0, Math.min(100, secondPct)) : 0;
    const barB = Number.isFinite(secondPct) ? 100 - barA : 0;
    const c1 = candidateByNumber(firstResult, config.n);
    const c2 = candidateByNumber(secondResult, config.n);
    return '<article class="pres-comparison candidate-' + config.color + '">' +
      '<div class="comparison-head">' + (photo ? '<img class="candidate-photo" src="https://resultados.tse.jus.br/oficial/ele2026/6258/fotos/br/' + safeText(photo) + '.jpeg" alt="" loading="lazy" onerror="this.hidden=true">' : '<span class="candidate-photo photo-empty" aria-hidden="true">' + config.n + '</span>') +
      '<div><p class="candidate-id">' + config.n + ' · ' + safeText((c2 && c2.sg) || (c1 && c1.sg) || '—') + '</p><h3>' + config.name + '</h3></div><div class="progress-ring" style="--progress:' + progress + '%" role="img" aria-label="' + pct(progress) + ' das seções totalizadas"><span>' + pct(progress) + '</span><small>apurado</small></div></div>' +
      '<div class="comparison-now"><strong>' + (awaiting ? pct(firstPct) : pct(secondPct)) + '</strong><span>' + (awaiting ? '1º turno' : displayOrDash(v2, (n) => fmtNumber.format(n)) + ' votos agora') + '</span></div>' +
      '<div class="comparison-turns"><div><span>1º turno</span><strong>' + pct(firstPct) + '</strong><small>' + displayOrDash(v1, (n) => fmtNumber.format(n)) + ' votos</small></div><div><span>2º turno</span><strong>' + (awaiting ? 'aguardando' : pct(secondPct)) + '</strong><small>' + (awaiting ? '—' : displayOrDash(v2, (n) => fmtNumber.format(n)) + ' votos') + '</small></div></div>' +
      (awaiting ? '' : '<p class="comparison-delta">Variação vs. base bilateral: <strong>' + displayOrDash(stats && stats.delta, (n) => (n > 0 ? '+' : '') + fmtPercent.format(n) + ' p.p.') + '</strong><br><span>vs. percentual bruto do 1º turno: ' + displayOrDash(stats && stats.rawDelta, (n) => (n > 0 ? '+' : '') + fmtPercent.format(n) + ' p.p.') + '</span> · votos: <strong>' + (stats && stats.votesDelta != null ? sign + difference : 'Indisponível') + '</strong></p>') +
      '<div class="turn-bars" aria-label="Percentuais de votos válidos: primeiro e segundo turno"><div class="turn-bar-row"><span>1º</span><div class="turn-bar"><i style="width:' + (Number.isFinite(firstPct) ? Math.max(0, Math.min(100, firstPct)) : 0) + '%"></i></div><b>' + pct(firstPct) + '</b></div><div class="turn-bar-row"><span>2º</span><div class="turn-bar"><i style="width:' + barA + '%"></i></div><b>' + (awaiting ? 'aguardando' : pct(secondPct)) + '</b></div></div>' +
      '<p class="bilateral-base">Base bilateral no 1º turno: <strong>' + displayOrDash(stats && stats.bilateral, pct) + '</strong><br><span>entre os dois finalistas; outros candidatos: ' + displayOrDash(stats && stats.other, pct) + '</span></p>' +
      '</article>';
  }
  function presidentialComparison(firstResult, secondResult) {
    const awaiting = isAwaiting({ pres: { r2: { br: secondResult } } });
    const candidates = PRESIDENT_CANDIDATES.map((candidate) => presidentialCard(candidate, candidateByNumber(firstResult, candidate.n), candidateByNumber(secondResult, candidate.n), firstResult, secondResult)).join('');
    const a = candidateByNumber(secondResult, '22'), b = candidateByNumber(secondResult, '13');
    const difference = a && b && Number.isFinite(Number(a.v)) && Number.isFinite(Number(b.v)) ? Number(a.v) - Number(b.v) : NaN;
    const denominator = (Number(a && a.p) || 0) + (Number(b && b.p) || 0);
    const width = denominator > 0 ? Math.max(0, Math.min(100, Number(a.p) * 100 / denominator)) : 50;
    const margin = Number.isFinite(difference) ? Math.abs(difference) : NaN;
    const firstA = candidateByNumber(firstResult, '22'), firstB = candidateByNumber(firstResult, '13');
    const other = firstA && firstB && firstA.p != null && firstB.p != null && Number.isFinite(Number(firstA.p)) && Number.isFinite(Number(firstB.p)) ? 100 - Number(firstA.p) - Number(firstB.p) : NaN;
    const pointMargin = a && b && Number.isFinite(Number(a.p)) && Number.isFinite(Number(b.p)) ? Math.abs(Number(a.p) - Number(b.p)) : NaN;
    return '<div class="pres-candidates">' + candidates + '</div><section class="national-difference" aria-label="Diferença nacional"><h3>' + (awaiting ? 'Placar do 1º turno' : 'Diferença') + '</h3>' + (awaiting ? '' : '<div class="split-bar" role="img" aria-label="Distribuição dos votos válidos no segundo turno"><span class="split-red" style="width:' + (100 - width) + '%"></span><span class="split-blue" style="width:' + width + '%"></span><i aria-hidden="true"></i></div><p>' + (Number.isFinite(pointMargin) ? fmtPercent.format(pointMargin) + ' pontos · ' : '') + (Number.isFinite(margin) ? fmtNumber.format(margin) + ' votos entre os candidatos' : 'Diferença de votos indisponível') + '</p>') + '<div class="valid-footer"><span>Votos válidos <strong>' + (awaiting ? displayOrDash(firstResult && firstResult.vv, (n) => fmtNumber.format(n)) : displayOrDash(secondResult && secondResult.vv, (n) => fmtNumber.format(n))) + '</strong></span><span>Comparecimento <strong>' + (awaiting ? displayOrDash(firstResult && firstResult.comp, (n) => fmtNumber.format(n)) : displayOrDash(secondResult && secondResult.comp, (n) => fmtNumber.format(n))) + '</strong></span><span>Brancos e nulos <strong>' + (awaiting ? (firstResult && Number.isFinite(Number(firstResult.vb)) && Number.isFinite(Number(firstResult.vn)) ? fmtNumber.format(Number(firstResult.vb) + Number(firstResult.vn)) : '—') : secondResult && Number.isFinite(Number(secondResult.vb)) && Number.isFinite(Number(secondResult.vn)) ? fmtNumber.format(Number(secondResult.vb) + Number(secondResult.vn)) : 'Indisponível') + '</strong></span></div><p class="turn-one-base">No 1º turno, outros candidatos somaram ' + displayOrDash(other, pct) + ' dos votos válidos; a comparação proporcional usa apenas os dois finalistas.</p></section>';
  }
  function regionCard(uf, result, turn) {
    const candidates = Array.isArray(result && result.cands) ? result.cands.slice(0, 2) : [];
    const progress = Number.isFinite(Number(result && result.pst)) ? pct(result.pst) : '—';
    const names = candidates.map((c) => safeText(c.nm || 'Candidato') + ' <strong>' + pct(c.p) + '</strong>').join('<br>');
    return '<article class="region-card"><div class="region-heading"><h3>' + safeText(UF_NAMES[uf] || uf.toUpperCase()) + '</h3><span>' + progress + ' apurado</span></div><p>' + (names || '<span class="muted">Dados indisponíveis</span>') + '</p><small>' + safeText(turn) + '</small></article>';
  }
  function governorCard(uf, firstResult, secondResult, waitingState) {
    const national = typeof window !== 'undefined' && window.currentElectionSnapshot && window.currentElectionSnapshot.pres.r2.br;
    const awaiting = waitingState == null ? isAwaiting({ pres: { r2: { br: national } } }) : !!waitingState;
    const title = UF_NAMES[uf] || uf.toUpperCase();
    if (!secondResult || secondResult.erro) {
      const reason = secondResult && secondResult.erro ? String(secondResult.erro) : 'Resultado indisponível';
      return '<article class="region-card governor-card"><div class="region-heading"><h3>' + safeText(title) + '</h3><span>indisponível</span></div><p class="muted governor-unavailable">' + safeText(reason) + '</p><small>2º turno</small></article>';
    }
    const finalists = Array.isArray(secondResult.cands) ? secondResult.cands.slice(0, 2) : [];
    if (finalists.length !== 2) return '<article class="region-card governor-card"><div class="region-heading"><h3>' + safeText(title) + '</h3><span>' + pct(secondResult.pst) + ' apurado</span></div><p class="muted governor-unavailable">Finalistas do 2º turno indisponíveis</p><small>2º turno</small></article>';
    const firstCandidates = firstResult && Array.isArray(firstResult.cands) ? firstResult.cands : [];
    const cards = finalists.map((candidate) => {
      const first = firstCandidates.find((item) => String(item.n) === String(candidate.n)) || null;
      const opponent = firstCandidates.find((item) => String(item.n) !== String(candidate.n) && finalists.some((finalist) => String(finalist.n) === String(item.n))) || null;
      const stats = comparisonData(first, opponent, candidate);
      const firstPct = first && Number.isFinite(Number(first.p)) ? Number(first.p) : NaN;
      const currentPct = Number.isFinite(Number(candidate.p)) ? Number(candidate.p) : NaN;
      const progress = Math.max(0, Math.min(100, Number(secondResult.pst) || 0));
      return '<section class="gov-finalist"><div class="gov-finalist-heading"><span class="candidate-number">' + safeText(candidate.n || '—') + '</span><div><h4>' + safeText(candidate.nm || 'Candidato') + '</h4><small>' + safeText(candidate.sg || 'Partido não informado') + '</small></div><span class="progress-ring" style="--progress:' + progress + '%" aria-label="' + pct(progress) + ' das seções totalizadas"><span>' + pct(progress) + '</span><small>apurado</small></span></div>' +
        '<p class="gov-now">' + (awaiting ? pct(firstPct) : pct(currentPct)) + ' <small>' + (awaiting ? '· 1º turno' : '· ' + displayOrDash(candidate.v, (n) => fmtNumber.format(n)) + ' votos') + '</small></p>' +
        '<div class="comparison-turns"><div><span>1º turno</span><strong>' + pct(firstPct) + '</strong><small>' + displayOrDash(first && first.v, (n) => fmtNumber.format(n)) + ' votos</small></div><div><span>2º turno</span><strong>' + (awaiting ? 'aguardando' : pct(currentPct)) + '</strong><small>' + (awaiting ? '—' : displayOrDash(candidate.v, (n) => fmtNumber.format(n)) + ' votos') + '</small></div></div>' +
        (awaiting ? '' : '<p class="comparison-delta">Variação vs. base bilateral: <strong>' + displayOrDash(stats && stats.delta, (n) => (n > 0 ? '+' : '') + fmtPercent.format(n) + ' p.p.') + '</strong><br><span>vs. percentual bruto do 1º turno: ' + displayOrDash(stats && stats.rawDelta, (n) => (n > 0 ? '+' : '') + fmtPercent.format(n) + ' p.p.') + '</span> · votos: <strong>' + displayOrDash(stats && stats.votesDelta, (n) => (n > 0 ? '+' : '') + fmtNumber.format(n)) + '</strong></p>') +
        '<div class="turn-bars"><div class="turn-bar-row"><span>1º</span><div class="turn-bar"><i style="width:' + (Number.isFinite(firstPct) ? Math.max(0, Math.min(100, firstPct)) : 0) + '%"></i></div><b>' + pct(firstPct) + '</b></div><div class="turn-bar-row"><span>2º</span><div class="turn-bar"><i style="width:' + (Number.isFinite(currentPct) ? Math.max(0, Math.min(100, currentPct)) : 0) + '%"></i></div><b>' + pct(currentPct) + '</b></div></div></section>';
    }).join('');
    return '<article class="region-card governor-card"><div class="region-heading"><h3>' + safeText(title) + '</h3><span>' + pct(secondResult.pst) + ' apurado</span></div><div class="gov-finalists">' + cards + '</div><small>Comparação de cada finalista com o 1º turno</small></article>';
  }
  function projection(snapshot) {
    const br = snapshot && snapshot.pres && snapshot.pres.r2 && snapshot.pres.r2.br;
    if (!br || Number(br.pst) === 0) return { available: false, reason: 'A estimativa aparece quando começar a apuração nacional.' };
    const firstTurn = snapshot.pres.r1 || {}, secondTurn = snapshot.pres.r2 || {};
    const areas = PRESIDENT_UFS.filter((uf) => uf !== 'br');
    const usable = (r) => r && !r.erro && Number.isFinite(Number(r.vv)) && Number(r.vv) > 0;
    let swingTotal = 0, swingWeight = 0;
    for (const uf of areas) {
      const one = firstTurn[uf], two = secondTurn[uf];
      const a1 = candidateByNumber(one, '22'), b1 = candidateByNumber(one, '13'), a2 = candidateByNumber(two, '22');
      if (Number(two && two.pst) > 0 && usable(one) && usable(two) && a1 && b1 && a2 && Number(a1.p) + Number(b1.p) > 0 && Number.isFinite(Number(a2.p))) {
        const base = Number(a1.p) * 100 / (Number(a1.p) + Number(b1.p));
        swingTotal += (Number(a2.p) - base) * Number(one.vv);
        swingWeight += Number(one.vv);
      }
    }
    if (swingWeight <= 0) return { available: false, reason: 'Sem abrangências apuradas com votos válidos suficientes para calcular o swing nacional.' };
    const nationalSwing = swingTotal / swingWeight;
    let votesTotal = 0, weightedA = 0;
    for (const uf of areas) {
      const one = firstTurn[uf], two = secondTurn[uf];
      const a1 = candidateByNumber(one, '22'), b1 = candidateByNumber(one, '13');
      if (!usable(one) || !a1 || !b1 || Number(a1.p) + Number(b1.p) <= 0) return { available: false, reason: 'Dados incompletos no 1º turno para ' + (UF_NAMES[uf] || uf.toUpperCase()) + '.' };
      const base = Number(a1.p) * 100 / (Number(a1.p) + Number(b1.p));
      const a2 = candidateByNumber(two, '22');
      const observed = Number(two && two.pst) > 0 && usable(two) && a2 && Number.isFinite(Number(a2.p));
      const estimateA = Math.max(0, Math.min(100, observed ? Number(a2.p) : base + nationalSwing));
      const weight = Number(one.vv);
      weightedA += estimateA * weight;
      votesTotal += weight;
    }
    if (!Number.isFinite(votesTotal) || votesTotal <= 0) return { available: false, reason: 'Não há pesos de votos válidos suficientes no 1º turno.' };
    const a = weightedA / votesTotal;
    return { available: true, a, b: 100 - a, swing: nationalSwing, weight: votesTotal };
  }
  function projectionMarkup(snapshot) {
    const estimate = projection(snapshot);
    return '<section class="data-panel projection-panel" aria-live="polite"><div class="section-heading compact"><div><p class="eyebrow">CENÁRIO NACIONAL</p><h2>Estimativa simples, não oficial</h2></div></div>' +
      (estimate.available ? '<p class="projection-values"><span class="projection-a">Flávio ' + pct(estimate.a) + '</span><span class="projection-b">Lula ' + pct(estimate.b) + '</span></p><p class="muted">Estimativa por UF ponderada pelos votos válidos do 1º turno. Abrangências apuradas usam o resultado atual; as demais aplicam o swing médio observado de ' + (estimate.swing > 0 ? '+' : '') + fmtPercent.format(estimate.swing) + ' p.p. à base bilateral.</p>' : '<p class="muted">' + safeText(estimate.reason) + '</p>') + '</section>';
  }
  function isAwaiting(snapshot) {
    const br = snapshot && snapshot.pres && snapshot.pres.r2 && snapshot.pres.r2.br;
    return !!br && Number(br.pst) === 0 && Array.isArray(br.cands) && br.cands.reduce((sum, c) => sum + (Number(c.v) || 0), 0) === 0;
  }
  function countdownText(now) {
    const remaining = Math.max(0, Math.ceil((COUNTING_START - now) / 1000));
    if (remaining === 0) return 'Urnas fechadas · aguardando os primeiros números do TSE';
    const days = Math.floor(remaining / 86400);
    const hours = Math.floor((remaining % 86400) / 3600);
    const minutes = Math.floor((remaining % 3600) / 60);
    const seconds = remaining % 60;
    return 'Início previsto em ' + (days ? days + 'd ' : '') + hours + 'h ' + minutes + 'min ' + seconds + 's.';
  }
  const UF_ORDER = ['ac','al','am','ap','ba','ce','df','es','go','ma','mt','ms','mg','pa','pb','pr','pe','pi','rj','rn','rs','ro','rr','sc','sp','se','to','zz'];
  const ufSort = { key: 'uf', direction: 1 };
  let mapMode = 'leader';
  let mapSvgPromise = null;
  let selectedUf = null;
  function ufRows(snapshot) {
    const oneTurn = snapshot && snapshot.pres && snapshot.pres.r1 || {};
    const twoTurn = snapshot && snapshot.pres && snapshot.pres.r2 || {};
    const waiting = isAwaiting(snapshot);
    return UF_ORDER.map((uf) => {
      const first = oneTurn[uf], nowResult = twoTurn[uf];
      const firstA = candidateByNumber(first, '22'), firstB = candidateByNumber(first, '13');
      const nowA = candidateByNumber(nowResult, '22'), nowB = candidateByNumber(nowResult, '13');
      const baseSum = Number(firstA && firstA.p) + Number(firstB && firstB.p);
      let leader = null, swing = null;
      if (waiting && firstA && firstB && baseSum > 0) {
        leader = Number(firstA.p) === Number(firstB.p) ? null : (Number(firstA.p) > Number(firstB.p) ? '22' : '13');
      } else if (Number(nowResult && nowResult.pst) > 0 && nowA && nowB && Number.isFinite(Number(nowA.p)) && Number.isFinite(Number(nowB.p))) {
        if (Number(nowA.p) !== Number(nowB.p)) leader = Number(nowA.p) > Number(nowB.p) ? '22' : '13';
        if (firstA && firstB && baseSum > 0) {
          const bilateralA = Number(firstA.p) * 100 / baseSum;
          swing = Number(nowA.p) - bilateralA;
        }
      }
      return { uf, name: UF_NAMES[uf], pst: Number(nowResult && nowResult.pst), waiting, firstA: firstA ? Number(firstA.p) : null, firstB: firstB ? Number(firstB.p) : null,
        nowA: nowA ? Number(nowA.p) : null, nowB: nowB ? Number(nowB.p) : null, swing, leader, bilateralA: firstA && firstB && baseSum > 0 ? Number(firstA.p) * 100 / baseSum : null };
    });
  }
  function sortUfRows(rows, key, direction) {
    const dir = direction == null ? 1 : direction;
    return rows.slice().sort((a, b) => {
      const av = a[key], bv = b[key];
      if (key === 'uf') return String(av).localeCompare(String(bv)) * dir;
      if (av == null || !Number.isFinite(Number(av))) return bv == null || !Number.isFinite(Number(bv)) ? a.uf.localeCompare(b.uf) : 1;
      if (bv == null || !Number.isFinite(Number(bv))) return -1;
      return (Number(av) - Number(bv)) * dir;
    });
  }
  function swingClass(row) {
    if (row.waiting || row.pst <= 0 || row.swing == null) return 'neutral';
    return row.swing < -0.01 ? 'negative' : row.swing > 0.01 ? 'positive' : 'near-zero';
  }
  function ufDetail(row) {
    const swing = row.waiting || row.pst <= 0 || row.swing == null ? '—' : (row.swing > 0 ? '+' : '') + fmtPercent.format(row.swing) + ' p.p. de Flávio';
    const leader = row.leader === '22' ? 'Flávio' : row.leader === '13' ? 'Lula' : row.pst > 0 ? 'empate' : row.waiting ? '1º turno' : 'sem apuração';
    return '<div class="uf-detail-heading"><div><p class="eyebrow">DETALHE DA ABRANGÊNCIA</p><h3>' + safeText(row.name) + ' <span>(' + row.uf.toUpperCase() + ')</span></h3></div><button type="button" id="uf-detail-close" aria-label="Fechar detalhe">×</button></div>' +
      '<p class="uf-detail-leader">' + safeText(leader) + (row.waiting ? ' · placar do 1º turno' : row.pst > 0 ? ' lidera' : '') + '</p>' +
      '<div class="uf-detail-grid"><div><h4>Presidente</h4><p>Apurado <strong>' + pct(row.pst) + '</strong></p><p>1º turno bruto <strong>Flávio ' + pct(row.firstA) + ' · Lula ' + pct(row.firstB) + '</strong></p><p>1º turno bilateral <strong>Flávio ' + pct(row.bilateralA) + ' · Lula ' + pct(row.bilateralA == null ? null : 100 - row.bilateralA) + '</strong></p><p>Agora <strong>' + (row.waiting || row.pst <= 0 ? 'aguardando · —' : 'Flávio ' + pct(row.nowA) + ' · Lula ' + pct(row.nowB)) + '</strong></p><p>Swing <strong>' + swing + '</strong></p></div><div class="uf-governor-detail" data-governor-uf="' + safeText(row.uf) + '"></div></div>';
  }
  function ufTooltip(row, snapshot) {
    const color = mapColor(row, mapMode);
    const basis = row.waiting || Number(row.pst) === 0 ? 'base: 1º turno' : 'base: 2º turno';
    const value = color.value == null ? (row.waiting ? 'aguardando' : '—') : mapMode === 'swing' ? (color.value > 0 ? '+' : '') + fmtPercent.format(color.value) + ' p.p.' : pct(color.value);
    return row.name + ' · ' + color.state + ' · ' + basis + ' · ' + value;
  }
  function governorDetail(uf, snapshot) {
    if (!GOVERNOR_UFS.includes(uf)) return '';
    const first = snapshot.gov && snapshot.gov.r1 && snapshot.gov.r1[uf];
    const second = snapshot.gov && snapshot.gov.r2 && snapshot.gov.r2[uf];
    if (!second || second.erro) return '<h4>Governador</h4><p>Dados indisponíveis.</p>';
    const finals = Array.isArray(second.cands) ? second.cands.slice(0, 2) : [];
    if (finals.length !== 2) return '<h4>Governador</h4><p>Finalistas indisponíveis.</p>';
    const waiting = isAwaiting(snapshot);
    const fc = first && Array.isArray(first.cands) ? first.cands : [];
    return '<h4>Governador · ' + pct(second.pst) + ' apurado</h4>' + finals.map((candidate) => {
      const base = fc.find((item) => String(item.n) === String(candidate.n));
      const opponent = fc.find((item) => String(item.n) !== String(candidate.n) && finals.some((f) => String(f.n) === String(item.n)));
      const stats = comparisonData(base, opponent, candidate);
      return '<article class="uf-gov-finalist"><strong>' + safeText(candidate.nm || 'Candidato') + ' (' + safeText(candidate.sg || '—') + ')</strong><p>1º turno bruto ' + pct(base && base.p) + ' · base bilateral ' + displayOrDash(stats && stats.bilateral, pct) + '</p><p>Agora ' + (waiting || Number(second.pst) <= 0 ? 'aguardando · —' : pct(candidate.p)) + ' · swing ' + (waiting || Number(second.pst) <= 0 ? '—' : displayOrDash(stats && stats.delta, (n) => (n > 0 ? '+' : '') + fmtPercent.format(n) + ' p.p.')) + '</p></article>';
    }).join('');
  }
  function showUfDetail(uf, trigger, snapshotArg) {
    const snapshot = snapshotArg || (typeof window !== 'undefined' ? window.currentElectionSnapshot : null);
    const row = ufRows(snapshot || {}).find((item) => item.uf === uf);
    if (!row) return;
    selectedUf = uf;
    const panel = $('uf-detail');
    panel.innerHTML = ufDetail(row);
    const governor = panel.querySelector('.uf-governor-detail');
    if (governor) governor.innerHTML = governorDetail(uf, snapshot);
    panel.dataset.open = 'true';
    panel.dataset.uf = uf;
    const selector = $('uf-select'); if (selector) selector.value = uf;
    const close = $('uf-detail-close');
    if (close) close.addEventListener('click', () => closeUfDetail(true));
    panel.dataset.trigger = uf === 'zz' ? 'uf-exterior' : trigger && trigger.id ? trigger.id : '';
  }
  function closeUfDetail(returnFocus) {
    const panel = $('uf-detail'); if (!panel) return;
    const triggerId = panel.dataset.trigger;
    panel.dataset.open = 'false'; panel.dataset.uf = '';
    selectedUf = null;
    panel.innerHTML = '<p>Selecione uma UF para ver os detalhes.</p>';
    const selector = $('uf-select'); if (selector) selector.value = '';
    if (returnFocus && triggerId) {
      const trigger = triggerId === 'uf-exterior' ? $('uf-exterior').querySelector('[data-uf="zz"]') : document.getElementById(triggerId);
      if (trigger && trigger.focus) trigger.focus();
    }
  }
  function ufsMarkup(snapshot) {
    const rows = ufRows(snapshot);
    const byUf = Object.fromEntries(rows.map((row) => [row.uf, row]));
    const ordered = sortUfRows(rows, ufSort.key, ufSort.direction);
    const cell = (value) => value == null || !Number.isFinite(Number(value)) ? '—' : pct(value);
    const table = ordered.map((r) => '<tr data-uf="' + r.uf + '"><th scope="row">' + r.uf.toUpperCase() + '</th><td>' + cell(r.pst) + '</td><td>' + cell(r.firstA) + '</td><td>' + cell(r.firstB) + '</td><td>' + (r.waiting ? '—' : cell(r.nowA)) + '</td><td>' + (r.waiting ? '—' : cell(r.nowB)) + '</td><td title="Base bilateral: ' + cell(r.bilateralA) + '">' + (r.waiting || r.swing == null ? '—' : (r.swing > 0 ? '+' : '') + fmtPercent.format(r.swing) + ' p.p.') + '</td></tr>').join('');
    return { rows: byUf, table };
  }
  function mapColor(row, mode) {
    if (!row) return { fill: '#454963', value: null, state: 'sem dados' };
    const hasCount = Number.isFinite(row.pst) && row.pst > 0;
    const hasNow = !row.waiting && hasCount && row.nowA != null && row.nowB != null;
    if (mode === 'swing' && (!hasNow || row.swing == null)) return { fill: '#454963', value: null, state: row.pst === 0 ? 'aguardando' : 'sem dados' };
    if (mode === 'swing') {
      const value = row.swing;
      if (Math.abs(value) <= 0.01) return { fill: '#77718d', value, state: 'perto de zero' };
      const strength = Math.min(0.78, 0.28 + Math.abs(value) / 35);
      return { fill: value > 0 ? 'rgba(49, 193, 232, ' + strength + ')' : 'rgba(255, 108, 126, ' + strength + ')', value, state: value > 0 ? 'a favor de Flávio' : 'a favor de Lula' };
    }
    const useFirstTurn = row.waiting || row.pst === 0;
    if (!hasNow && !useFirstTurn) return { fill: '#454963', value: null, state: 'sem dados' };
    let leader = row.leader;
    if (useFirstTurn && row.bilateralA != null) leader = Math.abs(row.bilateralA - 50) < 0.000001 ? null : row.bilateralA > 50 ? '22' : '13';
    if (!leader) return { fill: '#454963', value: null, state: useFirstTurn && row.bilateralA != null ? 'empate no 1º turno' : row.pst > 0 ? 'empate' : 'sem dados' };
    const share = useFirstTurn ? (leader === '22' ? row.bilateralA : 100 - row.bilateralA) : (leader === '22' ? row.nowA : row.nowB);
    if (share == null) return { fill: '#454963', value: null, state: 'sem dados' };
    const margin = useFirstTurn ? Math.abs(2 * share - 100) : Math.abs(Number(row.nowA) - Number(row.nowB));
    const alpha = Math.min(0.86, 0.36 + margin / 35);
    return { fill: leader === '22' ? 'rgba(49, 193, 232, ' + alpha + ')' : 'rgba(255, 108, 126, ' + alpha + ')', value: share, state: (leader === '22' ? 'Flávio lidera' : 'Lula lidera') + (useFirstTurn ? ' no 1º turno' : '') };
  }
  function paintMap(snapshot) {
    const host = $('uf-map');
    if (!host || !host.querySelectorAll) return Promise.resolve(false);
    if (!host.querySelector('svg')) {
      if (!mapSvgPromise) mapSvgPromise = fetch('data/brasil-ufs.svg').then((response) => { if (!response.ok) throw new Error('SVG do mapa indisponível'); return response.text(); }).then((source) => {
        const parsed = new DOMParser().parseFromString(source, 'image/svg+xml').documentElement;
        if (parsed.getAttribute('viewBox') !== '0 0 800 787') throw new Error('viewBox do mapa inválido');
        host.replaceChildren(document.importNode(parsed, true));
        return true;
      }).catch((error) => { mapSvgPromise = null; host.textContent = 'Mapa local indisponível.'; return false; });
    }
    return (mapSvgPromise || Promise.resolve(true)).then((loaded) => {
      if (!loaded) return false;
      const rows = ufRows(snapshot);
      host.querySelectorAll('path[id]').forEach((path) => {
        const uf = path.id.toLowerCase();
        const row = rows.find((item) => item.uf === uf);
        if (!row) return;
        const color = mapColor(row, mapMode);
        path.setAttribute('class', 'uf-region ' + (mapMode === 'swing' ? swingClass(row) : 'leader-' + (row.leader || 'neutral')));
        path.style.setProperty('--uf-fill', color.fill);
        path.setAttribute('aria-label', UF_NAMES[uf] + ', ' + color.state + (color.value == null ? '' : ', ' + (mapMode === 'swing' ? (color.value > 0 ? '+' : '') + fmtPercent.format(color.value) + ' pontos percentuais' : pct(color.value))));
        path.setAttribute('role', 'button');
        path.setAttribute('tabindex', '0');
        path.setAttribute('aria-label', ufTooltip(row, snapshot));
        path.setAttribute('title', ufTooltip(row, snapshot));
        path.setAttribute('aria-pressed', String(selectedUf === uf));
        path.classList.toggle('is-selected', selectedUf === uf);
        path.dataset.uf = uf;
      });
      return true;
    });
  }
  function mapLegend(mode, waiting) {
    return mode === 'leader'
      ? '<span><i class="legend-lula"></i>Lula lidera</span><span><i class="legend-flavio"></i>Flávio lidera</span><span><i class="swing-neutral"></i>empate</span><span><i class="swing-neutral"></i>sem dados</span>' + (waiting ? '<span class="legend-note">Base: 1º turno bilateral</span>' : '<span class="legend-note">Intensidade = margem</span>')
      : '<span><i class="swing-neg"></i>− a favor de Lula</span><span><i class="swing-mid"></i>perto de zero</span><span><i class="swing-pos"></i>+ a favor de Flávio</span><span><i class="swing-neutral"></i>aguardando</span><span><i class="swing-neutral"></i>empate</span>';
  }
  function renderUfs(snapshot) {
    const markup = ufsMarkup(snapshot);
    paintMap(snapshot);
    const exterior = markup.rows.zz;
    const ext = $('uf-exterior');
    if (ext && exterior) {
      const color = mapColor(exterior, mapMode);
      ext.innerHTML = '<button type="button" id="uf-exterior-trigger" class="uf-exterior-button ' + (mapMode === 'swing' ? swingClass(exterior) : 'leader-' + (exterior.leader || 'neutral')) + '" data-uf="zz" aria-pressed="' + (selectedUf === 'zz') + '" style="--uf-fill:' + color.fill + '"><strong>ZZ</strong><span>' + (color.value == null ? (color.state === 'sem dados' ? 'Sem dados' : 'Aguardando') : mapMode === 'swing' ? (color.value > 0 ? '+' : '') + fmtPercent.format(color.value) + ' p.p.' : pct(color.value)) + '</span></button>';
    }
    if ($('uf-table-body')) $('uf-table-body').innerHTML = markup.table;
    const legend = $('swing-legend');
    if (legend) {
      const waiting = isAwaiting(snapshot);
      legend.setAttribute('aria-label', mapMode === 'leader' ? (waiting ? 'Legenda da liderança no primeiro turno' : 'Legenda de quem lidera') : 'Legenda do swing do Flávio contra a base bilateral do primeiro turno');
      legend.innerHTML = mapLegend(mapMode, waiting);
    }
    const selector = $('uf-select');
    if (selector && selector.options.length <= 1) selector.innerHTML = '<option value="">Selecione…</option>' + UF_ORDER.filter((uf) => uf !== 'zz').map((uf) => '<option value="' + uf + '">' + UF_NAMES[uf] + ' (' + uf.toUpperCase() + ')</option>').join('') + '<option value="zz">Exterior (ZZ)</option>';
    if (selectedUf) {
      const mapHost = $('uf-map');
      const trigger = selectedUf === 'zz' ? (ext && ext.querySelector('[data-uf="zz"]')) : (mapHost && mapHost.querySelector ? mapHost.querySelector('#' + selectedUf.toUpperCase()) : null);
      showUfDetail(selectedUf, trigger, snapshot);
    }
  }
  function setupUfControls() {
    if (!$('uf-map')) return;
    $('uf-map').addEventListener('click', (event) => {
      const tile = event.target.closest('[data-uf]');
      if (!tile) return;
      const row = ufRows(window.currentElectionSnapshot || {}).find((item) => item.uf === tile.dataset.uf);
      if (row) showUfDetail(row.uf, tile);
    });
    if ($('uf-exterior')) $('uf-exterior').addEventListener('click', (event) => {
      const button = event.target.closest('[data-uf="zz"]');
      const row = button && ufRows(window.currentElectionSnapshot || {}).find((item) => item.uf === 'zz');
      if (row) { button.id = 'uf-exterior-trigger'; showUfDetail(row.uf, button); }
    });
    $('uf-map').addEventListener('keydown', (event) => {
      const path = event.target.closest('[data-uf]');
      if (!path) return;
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); showUfDetail(path.dataset.uf, path); }
    });
    const tooltip = $('uf-tooltip');
    const showTooltip = (event) => {
      const path = event.target.closest('[data-uf]'); if (!path || !tooltip) return;
      const row = ufRows(window.currentElectionSnapshot || {}).find((item) => item.uf === path.dataset.uf);
      if (!row) return;
      tooltip.textContent = ufTooltip(row, window.currentElectionSnapshot);
      tooltip.hidden = false;
      const rect = path.getBoundingClientRect();
      tooltip.style.left = Math.max(8, Math.min(window.innerWidth - 310, rect.left + rect.width / 2)) + 'px';
      tooltip.style.top = Math.max(8, rect.top - 42) + 'px';
    };
    const hideTooltip = (event) => { if (event.relatedTarget && event.relatedTarget.closest && event.relatedTarget.closest('[data-uf]')) return; if (tooltip) tooltip.hidden = true; };
    $('uf-map').addEventListener('focusin', showTooltip); $('uf-map').addEventListener('mouseover', showTooltip);
    $('uf-map').addEventListener('focusout', hideTooltip); $('uf-map').addEventListener('mouseout', hideTooltip);
    if ($('uf-exterior')) { $('uf-exterior').addEventListener('focusin', showTooltip); $('uf-exterior').addEventListener('mouseover', showTooltip); $('uf-exterior').addEventListener('focusout', hideTooltip); $('uf-exterior').addEventListener('mouseout', hideTooltip); }
    if ($('uf-select')) $('uf-select').addEventListener('change', (event) => { if (event.target.value) showUfDetail(event.target.value, event.target.value === 'zz' ? $('uf-exterior').querySelector('[data-uf="zz"]') : $('uf-map').querySelector('#' + event.target.value.toUpperCase())); });
    document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && $('uf-detail').dataset.open === 'true') closeUfDetail(true); });
    (document.querySelectorAll ? document.querySelectorAll('.uf-table [data-sort]') : []).forEach((button) => button.addEventListener('click', () => {
      const key = button.dataset.sort;
      ufSort.direction = ufSort.key === key ? -ufSort.direction : 1;
      ufSort.key = key;
      renderUfs(window.currentElectionSnapshot || {});
    }));
    (document.querySelectorAll ? document.querySelectorAll('[data-map-mode]') : []).forEach((button) => button.addEventListener('click', () => {
      mapMode = button.dataset.mapMode;
      (document.querySelectorAll ? document.querySelectorAll('[data-map-mode]') : []).forEach((item) => { item.classList.toggle('is-active', item === button); item.setAttribute('aria-pressed', String(item === button)); });
      renderUfs(window.currentElectionSnapshot || {});
    }));
  }
  function updateWaiting(snapshot, now) {
    const notice = $('waiting-notice');
    if (!notice) return;
    const waiting = isAwaiting(snapshot);
    notice.hidden = !waiting;
    if (waiting) {
      const remaining = Math.max(0, Math.ceil((COUNTING_START - (now == null ? Date.now() : now)) / 1000));
      const title = $('waiting-title');
      const countdown = $('waiting-countdown');
      if (title) title.textContent = remaining ? 'Aguardando apuração do 2º turno' : 'Urnas fechadas · aguardando os primeiros números do TSE';
      if (countdown) countdown.innerHTML = remaining ? '<span class="clock-live-dot" aria-hidden="true"></span>' + [Math.floor(remaining / 3600), Math.floor((remaining % 3600) / 60), remaining % 60].map((n, i) => '<span class="clock-unit"><strong>' + String(n).padStart(2, '0') + '</strong><small>' + ['horas','minutos','segundos'][i] + '</small></span>').join('<i>:</i>') : '<span class="clock-live-dot" aria-hidden="true"></span>';
    }
  }
  function render(snapshot, chanceStale) {
    if (!snapshot || !snapshot.pres || !snapshot.pres.r1 || !snapshot.pres.r2 || !snapshot.gov || !snapshot.gov.r2) throw new Error('Formato de resultados inválido');
    if (typeof window !== 'undefined') window.currentElectionSnapshot = snapshot;
    const pres1 = snapshot.pres.r1.br;
    const pres2 = snapshot.pres.r2.br;
    $('pres-cards').innerHTML = presidentialComparison(pres1, pres2);
    updateChance(snapshot, !!chanceStale);
    $('pres-projection').innerHTML = projectionMarkup(snapshot);
    renderUfs(snapshot);
    $('pres-regions').innerHTML = Object.entries(REGION_UFS).map(([name, ufs]) => regionalCard(name, ufs, snapshot)).join('');
    renderHistory();
    $('gov-regions').innerHTML = GOVERNOR_UFS.map((uf) => governorCard(uf, snapshot.gov.r1 && snapshot.gov.r1[uf], snapshot.gov.r2[uf], isAwaiting(snapshot))).join('');
    const generated = snapshot.gerado ? new Date(snapshot.gerado) : null;
    $('pres-update').textContent = generated && !Number.isNaN(generated.getTime()) ? 'Snapshot atualizado em ' + generated.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : 'Snapshot oficial';
    $('turn-summary').hidden = false;
    $('turn-summary').innerHTML = '<span>1º turno</span><strong>' + pct(pres1 && pres1.pst) + ' das seções totalizadas</strong><span class="summary-divider">·</span><span>2º turno</span><strong>' + pct(pres2 && pres2.pst) + ' das seções totalizadas</strong>';
    $('source-status').textContent = 'Fonte: snapshot TSE';
    $('load-error').hidden = true;
    updateWaiting(snapshot);
  }
  function endpoint(kind, uf, stamp) {
    const id = kind === 'pres' ? '6258/dados/' + uf + '/' + uf + '-c0001-e006258-u.json' : '6260/dados/' + uf + '/' + uf + '-c0003-e006260-u.json';
    return LIVE_BASE + id + '?t=' + encodeURIComponent(stamp);
  }
  function validResult(r) {
    return !!r && typeof r === 'object' && !r.erro && Number.isFinite(Number(r.pst)) && Array.isArray(r.cands) && r.cands.every((c) => c && c.n != null && Number.isFinite(Number(c.v)) && Number.isFinite(Number(c.p)));
  }
  function resultTime(r) {
    if (!r || !r.dg || !r.hg) return 0;
    const m = String(r.dg).match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    const t = String(r.hg).match(/^(\d{2}):(\d{2}):(\d{2})$/);
    return m && t ? Date.UTC(+m[3], +m[2] - 1, +m[1], +t[1], +t[2], +t[3]) : 0;
  }
  function withTimeout(promise, ms, timers) {
    return new Promise((resolve, reject) => {
      const id = timers.setTimeout(() => reject(new Error('timeout')), ms);
      promise.then((value) => { timers.clearTimeout(id); resolve(value); }, (error) => { timers.clearTimeout(id); reject(error); });
    });
  }
  function startPolling(initial, options) {
    const opts = options || {};
    const fetcher = opts.fetch || fetch;
    const now = opts.now || Date.now;
    const timers = opts.timers || { setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (id) => clearTimeout(id), setInterval: (f, ms) => typeof setInterval === 'function' ? setInterval(f, ms) : null, clearInterval: (id) => { if (typeof clearInterval === 'function' && id != null) clearInterval(id); } };
    const timeoutMs = opts.timeoutMs || 10000;
    const cadenceMs = opts.cadenceMs || REFRESH_MS;
    const state = { snapshot: initial, busy: false, source: 'reserva', failures: new Set(), lastUpdated: 0, liveKeys: new Set() };
    function status() {
      if (typeof document === 'undefined' || !$('source-status')) return;
      const failed = Array.from(state.failures).sort();
      $('source-status').textContent = (state.source === 'live' ? 'Fonte: TSE ao vivo' : 'Fonte: reserva') +
        (failed.length ? ' · desatualizada: ' + failed.join(', ') : '');
      const br = state.snapshot.pres.r2.br;
      const time = br && br.dg && br.hg ? br.dg + ' ' + br.hg + ' (Brasília)' : 'horário indisponível';
      $('pres-update').textContent = 'Última atualização TSE: ' + time + ' · atualiza em ' + Math.max(0, Math.ceil((cadenceMs - (now() - state.lastUpdated)) / 1000)) + 's';
    }
    async function get(url) {
      const response = await withTimeout(Promise.resolve().then(() => fetcher(url, { cache: 'no-store' })), timeoutMs, timers);
      if (!response || !response.ok) throw new Error('HTTP ' + (response && response.status));
      const result = parseResult(await withTimeout(response.json(), timeoutMs, timers));
      if (!validResult(result)) throw new Error('resultado inválido');
      return result;
    }
    async function refresh() {
      if (state.busy) return;
      state.busy = true;
      const jobs = [];
      PRESIDENT_UFS.forEach((uf) => jobs.push({ kind: 'pres', uf }));
      GOVERNOR_UFS.forEach((uf) => jobs.push({ kind: 'gov', uf }));
      const stamp = now();
      const settled = await Promise.all(jobs.map(async (job) => {
        try { return { job, result: await get(endpoint(job.kind, job.uf, stamp)) }; }
        catch (error) { return { job, error }; }
      }));
      let reserve = null;
      if (settled.some((x) => x.error)) {
        try {
          const response = await withTimeout(fetcher('data/snapshot.json?t=' + encodeURIComponent(stamp), { cache: 'no-store' }), timeoutMs, timers);
          if (response && response.ok) reserve = await withTimeout(response.json(), timeoutMs, timers);
          if (!reserve || !reserve.pres || !reserve.pres.r2 || !reserve.gov || !reserve.gov.r2) reserve = null;
        } catch (_) { reserve = null; }
      }
      const failures = new Set();
      const oldBrProgress = Number(state.snapshot.pres.r2.br && state.snapshot.pres.r2.br.pst) || 0;
      settled.forEach(({ job, result, error }) => {
        const key = job.kind === 'pres' ? 'pres' : 'gov';
        const current = state.snapshot[key].r2[job.uf];
        if (!error && validResult(result)) {
          state.snapshot[key].r2[job.uf] = result;
          state.liveKeys.add(key + ':' + job.uf);
          return;
        }
        const fallback = reserve && reserve[key] && reserve[key].r2 && reserve[key].r2[job.uf];
        if (validResult(fallback) && !state.liveKeys.has(key + ':' + job.uf) && (!current || resultTime(fallback) > resultTime(current))) {
          state.snapshot[key].r2[job.uf] = fallback;
        } else {
          failures.add(job.uf.toUpperCase());
        }
      });
      state.failures = failures;
      state.source = failures.size === 0 && settled.every((x) => !x.error) ? 'live' : 'reserva';
      state.lastUpdated = now();
      if (settled.some((x) => x.job.kind === 'pres' && x.job.uf === 'br' && !x.error)) recordLiveSnapshot(state.snapshot, oldBrProgress);
      try { render(state.snapshot, failures.size > 0); } catch (err) { console.error("render falhou", err && err.stack || err); }
      const toast = typeof document !== 'undefined' ? $('tse-toast') : null;
      if (toast) { toast.hidden = failures.size === 0; }
      status();
      state.busy = false;
      return state;
    }
    const initialRefresh = refresh();
    const interval = timers.setInterval(refresh, cadenceMs);
    return { state, refresh, initialRefresh, stop: () => timers.clearInterval(interval) };
  }
  function regionalCard(name, ufs, snapshot) {
    const waiting = isAwaiting(snapshot);
    let a = 0, b = 0, total = 0, progressWeight = 0, seen = 0;
    for (const uf of ufs) {
      const result = waiting ? snapshot.pres.r1[uf] : snapshot.pres.r2[uf];
      if (!result || result.erro) continue;
      const ca = candidateByNumber(result, '22'), cb = candidateByNumber(result, '13');
      if (ca && cb && Number.isFinite(Number(ca.v)) && Number.isFinite(Number(cb.v))) { a += Number(ca.v); b += Number(cb.v); seen++; }
      const weight = Number(result.ts) || 1;
      progressWeight += Number(result.pst || 0) * weight;
      total += weight;
    }
    const sum = a + b, pa = sum ? a * 100 / sum : NaN, pb = sum ? b * 100 / sum : NaN;
    let firstA = 0, firstB = 0;
    for (const uf of ufs) {
      const result = snapshot.pres.r1[uf];
      if (!result || result.erro) continue;
      const ca = candidateByNumber(result, '22'), cb = candidateByNumber(result, '13');
      if (ca && cb) { firstA += Number(ca.v) || 0; firstB += Number(cb.v) || 0; }
    }
    const firstSum = firstA + firstB;
    const firstBilateralA = firstSum ? firstA * 100 / firstSum : NaN;
    const delta = Number.isFinite(pa) && Number.isFinite(firstBilateralA) ? pa - firstBilateralA : NaN;
    const progress = total ? progressWeight / total : NaN;
    return '<article class="region-card"><div class="region-heading"><h3>' + name + '</h3><span>' + (waiting ? '1º turno' : pct(progress) + ' apurado') + '</span></div><p>Flávio<strong>' + pct(pa) + '</strong><br>Lula<strong>' + pct(pb) + '</strong></p>' + (waiting ? '' : '<small>Base bilateral 1º turno: Flávio ' + pct(firstBilateralA) + ' · Lula ' + pct(firstSum ? firstB * 100 / firstSum : NaN) + ' · Swing Flávio ' + displayOrDash(delta, (n) => (n > 0 ? '+' : '') + fmtPercent.format(n) + ' p.p.') + '</small><br>') + '<small>' + (seen ? fmtNumber.format(sum) + ' votos válidos · ' + (waiting ? '1º turno' : ufs.length + ' abrangência(s)') : 'Aguardando dados') + '</small></article>';
  }
  function readHistory() {
    try { const value = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); return Array.isArray(value) ? value.filter((x) => x && Number.isFinite(x.pst) && Number.isFinite(x.a) && Number.isFinite(x.b)).slice(-120) : []; }
    catch (_) { return []; }
  }
  function recordLiveSnapshot(snapshot, previousPst) {
    const br = snapshot.pres.r2.br, a = candidateByNumber(br, '22'), b = candidateByNumber(br, '13');
    if (!br || !a || !b || Number(br.vv) <= 0 || Number(br.pst) <= 0) return;
    const points = readHistory(), point = { at: Date.now(), pst: Number(br.pst), a: Number(a.p), b: Number(b.p), dg: br.dg || '', hg: br.hg || '' };
    const last = points[points.length - 1];
    if (!last || last.pst !== point.pst || last.a !== point.a || last.b !== point.b) points.push(point);
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(points.slice(-120))); } catch (_) { /* storage opcional */ }
    const crossed = [25, 50, 75, 100].filter((mark) => previousPst < mark && point.pst >= mark && !seenMilestones.has(mark));
    crossed.forEach((mark) => seenMilestones.add(mark));
    if (last && crossed.length && shouldAnimateMilestone(prefersReducedMotion())) showMilestone();
    if (last && (!last.pst || last.pst !== point.pst || last.a !== point.a || last.b !== point.b)) {
      const feed = readFeed();
      feed.unshift({ at: point.at, pst: point.pst, a: point.a, b: point.b, dg: point.dg, hg: point.hg });
      try { localStorage.setItem(HISTORY_KEY + '-feed', JSON.stringify(feed.slice(0, 8))); } catch (_) {}
    }
  }
  function readFeed() { try { const data = JSON.parse(localStorage.getItem(HISTORY_KEY + '-feed') || '[]'); return Array.isArray(data) ? data.slice(0, 8) : []; } catch (_) { return []; } }
  function renderHistory() {
    const points = readHistory(), feed = readFeed();
    const chart = $('timeline-chart');
    if (chart) {
      if (points.length < 2) chart.innerHTML = '<p class="history-empty">O gráfico será preenchido conforme chegarem atualizações do TSE.</p>';
      else {
        const coords = (key) => points.map((p, i) => ((i / (points.length - 1)) * 600) + ',' + (110 - Math.max(0, Math.min(100, p[key]))));
        chart.innerHTML = '<svg class="timeline-svg" viewBox="0 0 600 130" role="img" aria-label="Percentuais dos candidatos ao longo da apuração"><path d="M0 10H600M0 60H600M0 110H600" class="chart-grid"/><polyline points="' + coords('a').join(' ') + '" class="chart-flavio"/><polyline points="' + coords('b').join(' ') + '" class="chart-lula"/>' + points.map((p, i) => '<circle cx="' + (i / (points.length - 1) * 600) + '" cy="' + (110 - p.a) + '" r="2.5" class="dot-flavio"/><circle cx="' + (i / (points.length - 1) * 600) + '" cy="' + (110 - p.b) + '" r="2.5" class="dot-lula"/>').join('') + '</svg><div class="chart-legend"><span>Flávio</span><span>Lula</span><span>Diferença: ' + fmtPercent.format(points[points.length - 1].a - points[points.length - 1].b) + ' p.p.</span></div>';
      }
    }
    const feedNode = $('updates-feed');
    if (feedNode) feedNode.innerHTML = feed.length ? feed.map((p) => '<li><time>' + safeText(p.hg || new Date(p.at).toLocaleTimeString('pt-BR', { hour:'2-digit', minute:'2-digit', timeZone:'America/Sao_Paulo' })) + '</time><span>+' + fmtPercent.format(p.pst) + '% seções</span><small>Flávio ' + pct(p.a) + ' · Lula ' + pct(p.b) + '</small></li>').join('') : '<li class="history-empty">As atualizações recebidas aparecerão aqui.</li>';
  }
  function crossesMilestone(previous, current) { return [25, 50, 75, 100].some((mark) => previous < mark && current >= mark); }
  function shouldAnimateMilestone(reducedMotion) { return !reducedMotion; }
  function prefersReducedMotion() { return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches; }
  function showMilestone() {
    const node = $('milestone-confetti'); if (!node) return;
    node.innerHTML = Array.from({ length: 18 }, (_, i) => '<i style="--i:' + i + '"></i>').join('');
    node.classList.remove('burst'); void node.offsetWidth; node.classList.add('burst');
    setTimeout(() => { node.classList.remove('burst'); node.replaceChildren(); }, 1100);
  }
  async function loadInitial() {
    try {
      const [response, modelResponse] = await Promise.all([
        fetch('data/snapshot.json', { cache: 'no-store' }),
        fetch('data/modelo.json', { cache: 'no-store' })
      ]);
      if (!response.ok) throw new Error('HTTP snapshot ' + response.status);
      if (!modelResponse.ok) throw new Error('HTTP modelo ' + modelResponse.status);
      const [snapshot, model] = await Promise.all([response.json(), modelResponse.json()]);
      if (!model || !model.abrangencias || !model.nacional) throw new Error('Parâmetros estatísticos inválidos');
      electionModel = model;
      render(snapshot);
      const poller = startPolling(snapshot);
      const timer = typeof setInterval === 'function' ? setInterval(() => {
        if (typeof document !== 'undefined' && $('pres-update')) {
          updateWaiting(poller.state.snapshot);
          const elapsed = Date.now() - poller.state.lastUpdated;
          $('pres-update').textContent = 'Última atualização TSE: ' + (poller.state.snapshot.pres.r2.br.dg || '—') + ' ' + (poller.state.snapshot.pres.r2.br.hg || '') + ' (Brasília) · atualiza em ' + Math.max(0, Math.ceil((30000 - elapsed) / 1000)) + 's';
        }
      }, 1000) : null;
      void timer;
    } catch (error) {
      console.error('Falha ao carregar/renderizar:', error);
      $('source-status').textContent = 'Resultados indisponíveis';
      $('load-error').hidden = false;
      $('pres-cards').innerHTML = '';
      $('pres-regions').innerHTML = '';
      $('gov-regions').innerHTML = '';
    }
  }
  function setupTabs() {
    const tabs = [['tab-presidente', 'panel-presidente'], ['tab-governadores', 'panel-governadores']];
    tabs.forEach(([tabId, panelId]) => $(tabId).addEventListener('click', () => {
      tabs.forEach(([otherTab, otherPanel]) => {
        const active = otherTab === tabId;
        $(otherTab).classList.toggle('is-active', active);
        $(otherTab).setAttribute('aria-selected', String(active));
        $(otherPanel).hidden = !active;
      });
    }));
  }
  function setupDepthEffects() {
    if (typeof document === 'undefined' || typeof matchMedia !== 'function' || typeof requestAnimationFrame !== 'function') return;
    const desktop = matchMedia('(pointer: fine) and (min-width: 701px)');
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    if (!desktop.matches || reduced.matches) return;
    let frame = 0, pointerX = 0, pointerY = 0, scrollY = window.scrollY || 0;
    const hero = document.querySelector('.intro');
    const cards = '.candidate-card,.pres-comparison,.data-panel,.region-card,.national-difference';
    const paint = () => {
      frame = 0;
      if (hero) hero.style.setProperty('--hero-parallax', Math.max(-12, Math.min(12, (scrollY * .035) + pointerY * 5)) + 'px');
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(paint); };
    document.addEventListener('pointermove', (event) => {
      pointerX = (event.clientX / Math.max(1, window.innerWidth) - .5) * 2;
      pointerY = (event.clientY / Math.max(1, window.innerHeight) - .5) * 2;
      const card = event.target.closest && event.target.closest(cards);
      if (card) {
        const bounds = card.getBoundingClientRect();
        const x = (event.clientX - bounds.left) / Math.max(1, bounds.width) - .5;
        const y = (event.clientY - bounds.top) / Math.max(1, bounds.height) - .5;
        card.style.setProperty('--tilt-x', (-y * 2.4).toFixed(2) + 'deg');
        card.style.setProperty('--tilt-y', (x * 2.4).toFixed(2) + 'deg');
        card.style.setProperty('--lift', '-2px');
      }
      schedule();
    }, { passive: true });
    document.addEventListener('pointerout', (event) => {
      const card = event.target.closest && event.target.closest(cards);
      if (card && (!event.relatedTarget || !card.contains(event.relatedTarget))) {
        card.style.setProperty('--tilt-x', '0deg'); card.style.setProperty('--tilt-y', '0deg'); card.style.setProperty('--lift', '0px');
      }
    }, { passive: true });
    window.addEventListener('scroll', () => { scrollY = window.scrollY || 0; schedule(); }, { passive: true });
    schedule();
  }
  if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', () => { setupTabs(); setupUfControls(); setupDepthEffects(); loadInitial(); });
  if (typeof module !== 'undefined' && module.exports) module.exports = { render, UF_NAMES, num, parseResult, startPolling, endpoint, validResult, PRESIDENT_UFS, GOVERNOR_UFS, isAwaiting, countdownText, updateWaiting, COUNTING_START, candidateByNumber, comparisonData, presidentialComparison, governorCard, projection, projectionMarkup, UF_ORDER, ufRows, sortUfRows, swingClass, ufDetail, ufTooltip, governorDetail, ufsMarkup, mapColor, mapLegend, crossesMilestone, shouldAnimateMilestone, chanceMarkup };
}());
