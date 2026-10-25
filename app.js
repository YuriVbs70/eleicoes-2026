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
  const REFRESH_MS = 4000;
  const COUNTING_START = Date.parse('2026-10-25T17:00:00-03:00');
  const REGION_UFS = { Norte:['ac','am','ap','pa','ro','rr','to'], Nordeste:['al','ba','ce','ma','pb','pe','pi','rn','se'], 'Centro-Oeste':['df','go','ms','mt'], Sudeste:['es','mg','rj','sp'], Sul:['pr','rs','sc'], Exterior:['zz'] };
  const HISTORY_KEY = 'eleicoes-2026-apuracao-v1';
  const PREFERENCES_KEY = 'eleicoes-2026-preferencias-v3';
  const DEFAULT_PREFERENCES = Object.freeze({ mapMode: 'leader', region: 'all', showMap: true, showChance: true, showChart: true, showComparison: true, theme: 'dark' });
  function normalizePreferences(value) {
    const v = value && typeof value === 'object' ? value : {};
    return { mapMode: ['leader','swing','progress'].includes(v.mapMode) ? v.mapMode : DEFAULT_PREFERENCES.mapMode,
      region: ['all','Norte','Nordeste','Centro-Oeste','Sudeste','Sul','Exterior'].includes(v.region) ? v.region : 'all',
      showMap: typeof v.showMap === 'boolean' ? v.showMap : true, showChance: typeof v.showChance === 'boolean' ? v.showChance : true,
      showChart: typeof v.showChart === 'boolean' ? v.showChart : true, showComparison: typeof v.showComparison === 'boolean' ? v.showComparison : true,
      theme: ['dark','light'].includes(v.theme) ? v.theme : 'dark' };
  }
  function readPreferences(storage) { try { return normalizePreferences(JSON.parse((storage || localStorage).getItem(PREFERENCES_KEY) || '{}')); } catch (_) { return normalizePreferences(null); } }
  let preferences = readPreferences();
  let officialHistory = [];
  let replayIndex = null;
  let liveSnapshot = null;
  const seenMilestones = new Set();
  let mapGuideObserver = null;
  let mapGuideFrame = 0;
  let electionModel = null;
  let chanceVersion = 0;
  let lastChance = null;
  let lastChanceStale = false;

  // Estados independentes do DOM: só uma segunda observação confirma a transição.
  function avisoLider(state, { lula, flavio }) {
    const valid = Number.isFinite(lula) && Number.isFinite(flavio) && lula >= 0 && flavio >= 0;
    const total = valid ? lula + flavio : 0;
    const leader = total > 0 && lula !== flavio ? (lula > flavio ? 'Lula' : 'Flávio') : null;
    if (!state) return { state: { leader, pending: null }, msg: null };
    if (!leader || Math.abs(lula - flavio) * 100 < total * 0.1 || leader === state.leader) {
      return { state: { ...state, pending: null }, msg: null };
    }
    // Sem líder anterior (empate/zero inicial), a primeira liderança só estabelece a base.
    if (!state.leader) return { state: { leader, pending: null }, msg: null };
    if (state.pending !== leader) return { state: { ...state, pending: leader }, msg: null };
    return { state: { leader, pending: null }, msg: 'Virada! ' + leader + ' passa à frente' };
  }
  function avisoChance(state, pt) {
    if (!Number.isFinite(pt) || pt < 0 || pt > 100) {
      return { state: state ? { lula: { ...state.lula, pending: null }, flavio: { ...state.flavio, pending: null } } : state, msg: null };
    }
    const rawBand = (p) => p >= 90 ? 2 : p >= 75 ? 1 : 0;
    if (!state) return { state: { lula: { band: rawBand(pt), pending: null }, flavio: { band: rawBand(100 - pt), pending: null } }, msg: null };
    let msg = null;
    const next = (previous, p, name) => {
      // Uma faixa confirmada só é abandonada 1 p.p. abaixo do seu limite.
      const band = previous.band === 2 && p >= 89 ? 2 : previous.band >= 1 && p >= 74 ? Math.max(1, rawBand(p)) : rawBand(p);
      if (band === previous.band) return { band, pending: null };
      if (previous.pending !== band) return { ...previous, pending: band };
      if (band > previous.band) msg = 'Chance de ' + name + ' passa de ' + (band === 2 ? 90 : 75) + '%';
      return { band, pending: null };
    };
    const lula = next(state.lula, pt, 'Lula');
    const flavio = next(state.flavio, 100 - pt, 'Flávio');
    return { state: { lula, flavio }, msg };
  }

  let avisoLiderState = null, avisoChanceState = null;
  const avisoQueue = [];
  let avisoHost = null, avisoActive = false;
  function showAviso(msg) {
    if (!msg || typeof document === 'undefined') return;
    if (avisoActive) { if (avisoQueue.length < 2) avisoQueue.push(msg); return; }
    if (!avisoHost) {
      avisoHost = document.createElement('div');
      avisoHost.className = 'aviso-host';
      avisoHost.setAttribute('role', 'status');
      avisoHost.setAttribute('aria-live', 'polite');
      avisoHost.setAttribute('aria-atomic', 'true');
      document.body.appendChild(avisoHost);
    }
    const header = document.querySelector('.site-header');
    avisoHost.style.top = Math.max(8, header ? header.getBoundingClientRect().bottom + 8 : 66) + 'px';
    const toast = document.createElement('div');
    toast.className = 'aviso-toast ' + (msg.includes('Lula') ? 'aviso-lula' : 'aviso-flavio');
    const label = document.createElement('span');
    label.textContent = msg;
    const close = document.createElement('button');
    close.type = 'button'; close.textContent = '×';
    close.setAttribute('aria-label', 'Fechar aviso');
    toast.append(label, close);
    avisoActive = true;
    let closing = false;
    const dismiss = () => {
      if (closing) return;
      closing = true; clearTimeout(timer);
      toast.classList.add('is-leaving');
      setTimeout(() => {
        toast.remove(); avisoActive = false;
        if (avisoQueue.length) showAviso(avisoQueue.shift());
      }, prefersReducedMotion() ? 0 : 250);
    };
    const timer = setTimeout(dismiss, 7000);
    close.addEventListener('click', dismiss);
    avisoHost.appendChild(toast);
  }
  function observeAvisoLider(snapshot) {
    const national = officialView(snapshot).pres.r2.br;
    const lula = candidateByNumber(national, '13'), flavio = candidateByNumber(national, '22');
    const result = avisoLider(avisoLiderState, { lula: num(lula && lula.v), flavio: num(flavio && flavio.v) });
    avisoLiderState = result.state; showAviso(result.msg);
  }
  function setupAvisoTest() {
    if (new URLSearchParams(window.location.search).get('aviso') !== 'teste') return;
    setTimeout(() => showAviso('Virada! Lula passa à frente'), 2000);
    setTimeout(() => showAviso('Chance de Flávio passa de 90%'), 4000);
  }

  // Gráfico da chance ao longo da noite. Fonte: histórico do box no feed (todo visitante vê a noite inteira);
  // sem ele, o histórico desta aba. Pontos: [unix s, chance Lula %, % seções apuradas no Brasil].
  let puHist = null; const clientHist = [];
  function noteClientChance(pt) {
    if (!Number.isFinite(pt)) return;
    const t = Math.floor(Date.now() / 1000), last = clientHist[clientHist.length - 1];
    if (last && t - last[0] < 60 && Math.abs(last[1] - pt) < 0.5) return;
    clientHist.push([t, Math.round(pt * 10) / 10, 0]); if (clientHist.length > 300) clientHist.shift();
  }
  function chanceHistory(result) {
    const src = Array.isArray(puHist) && puHist.length ? puHist : clientHist;
    let pts = src.filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1])).map((p) => [p[0], Math.max(0, Math.min(100, p[1])), Number.isFinite(p[2]) ? p[2] : 0]);
    pts.sort((a, b) => a[0] - b[0]);
    // A partir das 17h (Brasília) mostra só a noite da apuração; antes disso, os poucos pontos que houver.
    const d17 = sparkStart(); const after = pts.filter((p) => p[0] >= d17);
    if (after.length >= 2) pts = after;
    const now = Math.floor(Date.now() / 1000);
    if (result && Number.isFinite(result.pt) && (!pts.length || now - pts[pts.length - 1][0] > 60)) pts.push([now, Math.round(result.pt * 10) / 10, pts.length ? pts[pts.length - 1][2] : 0]);
    return pts;
  }
  function sparkStart() {
    const now = new Date(); const ymd = now.toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
    return Math.floor(Date.parse(ymd + 'T17:00:00-03:00') / 1000);
  }
  function sparkTime(t) { return new Date(t * 1000).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' }); }
  function sparkMarkup(pts) {
    if (!pts || !pts.length) return '';
    const W = 300, H = 40, n = pts.length;
    const t0 = pts[0][0], t1 = pts[n - 1][0], span = Math.max(1, t1 - t0);
    const xy = (p, flip) => { const x = n === 1 ? 0 : (p[0] - t0) / span * W; const v = flip ? 100 - p[1] : p[1]; return [x, H - v / 100 * H]; };
    const path = (flip) => { const a = pts.map((p) => xy(p, flip)); if (n === 1) a.push([W, a[0][1]]); return a.map((q, i) => (i ? 'L' : 'M') + q[0].toFixed(1) + ' ' + q[1].toFixed(1)).join(''); };
    const last = pts[n - 1];
    const note = t1 < sparkStart() ? 'linha desde ' + sparkTime(t0) + ' · apuração às 17h' : 'desde ' + sparkTime(t0);
    const data = pts.map((p) => p[0] + ',' + p[1]).join(';');
    return '<div class="chance-spark" data-spark="' + data + '" data-t0="' + t0 + '" data-t1="' + t1 + '">' +
      '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" role="img" aria-label="Chance ao longo da noite: agora Lula ' + Math.round(last[1]) + '%, Flávio ' + Math.round(100 - last[1]) + '%">' +
      '<line class="spark-mid" x1="0" y1="' + H / 2 + '" x2="' + W + '" y2="' + H / 2 + '"/>' +
      '<path class="spark-flavio" d="' + path(true) + '"/><path class="spark-lula" d="' + path(false) + '"/>' +
      '<line class="spark-cursor" x1="0" y1="0" x2="0" y2="' + H + '" hidden/></svg>' +
      '<span class="spark-tip" aria-live="polite">' + note + '</span></div>';
  }
  function sparkPoint(el, clientX) {
    const r = el.getBoundingClientRect(); const pts = (el.dataset.spark || '').split(';').map((s) => s.split(',').map(Number)).filter((p) => p.length === 2);
    if (!pts.length || !r.width) return;
    const t0 = Number(el.dataset.t0), t1 = Number(el.dataset.t1); const frac = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    const t = t0 + frac * Math.max(1, t1 - t0); let best = pts[0];
    for (const p of pts) if (Math.abs(p[0] - t) < Math.abs(best[0] - t)) best = p;
    const tip = el.querySelector('.spark-tip'), cur = el.querySelector('.spark-cursor');
    if (tip) tip.textContent = sparkTime(best[0]) + ' · Lula ' + best[1].toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + '% · Flávio ' + (100 - best[1]).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + '%';
    if (cur) { const x = pts.length === 1 ? 0 : (best[0] - t0) / Math.max(1, t1 - t0) * 300; cur.setAttribute('x1', x); cur.setAttribute('x2', x); cur.removeAttribute('hidden'); }
  }
  if (typeof document !== 'undefined') {
    const onSpark = (e) => { const el = e.target && e.target.closest && e.target.closest('.chance-spark'); if (el) sparkPoint(el, e.clientX); };
    document.addEventListener('pointermove', onSpark); document.addEventListener('pointerdown', onSpark);
  }

  function chanceMarkup(result, timestamp, stale) {
    if (!result || !result.available || !Number.isFinite(result.pt) || !Number.isFinite(result.opositor)) {
      return '<section class="data-panel chance-panel" aria-live="polite"><div class="section-heading compact"><div><p class="eyebrow">MONTE CARLO</p><h2>Chance de vitória</h2></div></div><p class="muted">' + safeText(result && result.reason || 'Chance de vitória calculada no navegador com o modelo local.') + '</p></section>';
    }
    const pt = Math.max(0, Math.min(100, result.pt));
    const flavio = 100 - pt;
    const ptRounded = Math.round(pt);
    const flavioRounded = 100 - ptRounded;
    const officialK = Number.isFinite(result.officialK) ? result.officialK : 0;
    const urnas = Number.isFinite(result.buUrnas) && result.buUrnas > 0 ? result.buUrnas : 0;
    const pct = new Intl.NumberFormat('pt-BR', { style: 'percent', maximumFractionDigits: 1 }).format(officialK);
    const base = urnas > 0
      ? (officialK > 0 ? 'Base: oficial' + (result.munUsado ? ' por município' : '') + ' (' + pct + ' dos votos) + ' + fmtNumber.format(urnas) + ' urnas por seção' : 'Base: 1º turno + ' + fmtNumber.format(urnas) + ' urnas ' + (result.buEscopo === 'zz' ? 'do Exterior ' : '') + 'por seção')
      : (officialK > 0 ? (result.munUsado ? 'Base: oficial por município (' + pct + ' dos votos)' : 'Base: totalização oficial') : 'Base: 1º turno (sem apuração ainda)');
    const baseNote = urnas > 0 ? '<span class="chance-base-note"> · swing de cada seção vs. o 1º turno</span>' : '';
    const when = timestamp ? new Date(timestamp).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';
    return '<section class="data-panel chance-panel" aria-live="polite"><div class="section-heading compact"><div><p class="eyebrow">MONTE CARLO · 5.000 SIMULAÇÕES</p><h2>Chance de vitória</h2></div><span class="chance-status">' + (stale ? 'desatualizada' : 'atualizada') + '</span></div>' +
      '<p class="chance-label">estimativa estatística, não oficial</p><p class="chance-base">' + base + baseNote + '</p><div class="chance-values"><span class="chance-flavio"><b>Flávio</b><strong' + twAttr('ch-a', flavioRounded, 'pct0') + '>' + flavioRounded + '%</strong></span><span class="chance-lula"><b>Lula</b><strong' + twAttr('ch-b', ptRounded, 'pct0') + '>' + ptRounded + '%</strong></span></div>' +
      '<div class="chance-bar" role="group" aria-label="Chance de vitória: Flávio ' + flavioRounded + ' por cento, Lula ' + ptRounded + ' por cento"><span class="chance-bar-flavio" role="meter" aria-label="Chance de vitória de Flávio Bolsonaro" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + flavioRounded + '" data-tw-w="ch-wa" style="width:' + flavio + '%"></span><span class="chance-bar-lula" role="meter" aria-label="Chance de vitória de Lula" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + ptRounded + '" data-tw-w="ch-wb" style="width:' + pt + '%"></span></div>' +
      sparkMarkup(chanceHistory(result)) +
      '<p class="chance-time">' + (result.tie ? 'Empate nas simulações' : 'Probabilidade de vitória · não é percentual de votos') + ' · atualizado às ' + when + (stale ? ' · último cálculo válido' : '') + '</p>' +
      '<button class="chance-mobile-trigger" type="button" aria-controls="chance-method">Chance · Flávio ' + flavioRounded + '% · ' + ptRounded + '% Lula · estimativa, não oficial</button>' +
      '<div class="chance-summary"><p>Base bilateral do 1º turno; pesos pelos votos válidos.</p><p>Incerteza calibrada com dados de 2022.</p></div>' +
      '<details class="chance-method" id="chance-method"><summary>Como calculamos</summary><p>Executamos 5.000 simulações usando a base bilateral e os votos válidos do 1º turno de 2026. A dispersão entre turnos é calibrada somente com os dados de 2022; cada simulação aplica um choque nacional comum e choques estaduais. Votos já contados ficam fixos e a incerteza diminui conforme a apuração avança, usando % de seções como aproximação.</p><p>Base: votos válidos e resultado bilateral do 1º turno de 2026. Incerteza calibrada com 2022; sem histórico da ordem de apuração. Os pesos vêm do 1º turno e % de seções aproxima a fração dos votos contados. <strong>Não há dados históricos de ordem de apuração</strong>, portanto o modelo não corrige esse viés. Probabilidade não é resultado oficial nem garantia.</p><p><a href="data/historico.json">Histórico</a> · <a href="data/modelo.json">Parâmetros</a> · <a href="https://resultados.tse.jus.br/oficial/ele2026/" target="_blank" rel="noopener noreferrer">Fontes TSE</a></p></details></section>';
  }
  function updateChance(snapshot, stale) {
    const target = typeof document !== 'undefined' ? $('pres-chance') : null;
    if (!target || !electionModel || !globalThis.EleicoesModelo) return;
    const version = ++chanceVersion;
    if (!lastChance) { target.innerHTML = chanceMarkup(null, null, false); puAttach(target); }  // com cálculo anterior, mantém o painel como está até o novo ficar pronto
    setTimeout(() => {
      if (version !== chanceVersion) return;
      try {
        const result = globalThis.EleicoesModelo.simulate(electionModel, snapshot, { simulations: 5000, bu: puChanceBu ? puEvid : null });
        if (version !== chanceVersion) return;
        if (result && result.available) {
          lastChance = { result, timestamp: Date.now() }; noteClientChance(result.pt);
          const aviso = avisoChance(avisoChanceState, result.pt);
          avisoChanceState = aviso.state; showAviso(aviso.msg);
        }
        lastChanceStale = !!stale || !result || !result.available;
        target.innerHTML = chanceMarkup(lastChance && lastChance.result || result, lastChance && lastChance.timestamp, lastChanceStale); puAttach(target);
        twApply(target);
      } catch (_) {
        target.innerHTML = chanceMarkup(lastChance && lastChance.result, lastChance && lastChance.timestamp, true); puAttach(target);
        twApply(target);
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
      '<div class="comparison-turns"><div><span>1º turno</span><strong>' + pct(firstPct) + '</strong><small>' + displayOrDash(v1, (n) => fmtNumber.format(n)) + ' votos</small></div><div><span>2º turno</span><strong>' + (awaiting ? 'sem apuração ainda' : pct(secondPct)) + '</strong><small>' + (awaiting ? '0 votos' : displayOrDash(v2, (n) => fmtNumber.format(n)) + ' votos') + '</small></div></div>' +
      (awaiting ? '' : '<p class="comparison-delta">Variação vs. base bilateral: <strong>' + displayOrDash(stats && stats.delta, (n) => (n > 0 ? '+' : '') + fmtPercent.format(n) + ' p.p.') + '</strong><br><span>vs. percentual bruto do 1º turno: ' + displayOrDash(stats && stats.rawDelta, (n) => (n > 0 ? '+' : '') + fmtPercent.format(n) + ' p.p.') + '</span> · votos: <strong>' + (stats && stats.votesDelta != null ? sign + difference : 'Indisponível') + '</strong></p>') +
      '<div class="turn-bars" aria-label="Percentuais de votos válidos: primeiro e segundo turno"><div class="turn-bar-row"><span>1º</span><div class="turn-bar"><i style="width:' + (Number.isFinite(firstPct) ? Math.max(0, Math.min(100, firstPct)) : 0) + '%"></i></div><b>' + pct(firstPct) + '</b></div><div class="turn-bar-row"><span>2º</span><div class="turn-bar"><i style="width:' + barA + '%"></i></div><b>' + (awaiting ? '0 votos' : pct(secondPct)) + '</b></div></div>' +
      '<p class="bilateral-base">Base bilateral no 1º turno: <strong>' + displayOrDash(stats && stats.bilateral, pct) + '</strong><br><span>entre os dois finalistas; outros candidatos: ' + displayOrDash(stats && stats.other, pct) + '</span></p>' +
      '</article>';
  }
  // partial (opcional): { result, label, short, remaining } — melhor número real disponível enquanto o Brasil oficial está zerado
  // (antes das 17h: Exterior pelos boletins de urna). Sem partial nem apuração: zeros reais do 2º turno (nunca números do 1º turno), rotulados.
  function presidentialComparison(firstResult, secondResult, partial) {
    const awaitingBr = isAwaiting({ pres: { r2: { br: secondResult } } });
    const usePartial = awaitingBr && partial && partial.result;
    const reference = awaitingBr && !usePartial;
    const src = usePartial ? partial.result : secondResult;
    const a = candidateByNumber(src, '22'), b = candidateByNumber(src, '13');
    const value = (v) => v != null && Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : null;
    const r1a = candidateByNumber(firstResult, '22'), r1b = candidateByNumber(firstResult, '13');
    const votesA = value(a && a.v), votesB = value(b && b.v);
    const pctA = value(a && a.p), pctB = value(b && b.p);
    const progress = value(src && src.pst);
    const vv = value(src && src.vv), vb = value(src && src.vb), vn = value(src && src.vn);
    const comp = value(src && src.comp), eligible = value(src && src.te);
    const componentTotal = vv != null && vb != null && vn != null ? vv + vb + vn : null;
    const total = usePartial ? componentTotal : componentTotal != null && comp != null && componentTotal === comp ? componentTotal : null;
    const remaining = comp != null && eligible != null && eligible >= comp ? eligible - comp : null;
    const remainingMillions = remaining == null ? 'Indisponível' : (remaining < 100000 ? (remaining === 0 ? '0,0' : (remaining / 1000000).toFixed(6).replace(/0+$/, '').replace('.', ',')) : new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(remaining / 1000000)) + ' milhões';
    const splitTotal = pctA != null && pctB != null ? pctA + pctB : null;
    const lulaWidth = splitTotal > 0 ? pctB * 100 / splitTotal : 0;
    const diffVotes = votesA != null && votesB != null ? votesA - votesB : null;
    const diffPoints = pctA != null && pctB != null ? pctA - pctB : null;
    const candidate = (number, name, party, person, candidate, votes, share, color, key) => {
      const photo = (candidate && candidate.sq) || (person && person.sq);
      const pctHtml = reference ? '<span class="tw"' + twAttr('sb-v0' + key, 0, 'int') + '>0</span> <small>votos</small>' : share == null ? 'Indisponível' : '<span class="tw"' + twAttr('sb-p' + key, share, 'pct') + '>' + pct(share) + '</span>';
      const votesHtml = reference ? '2º turno · sem apuração ainda' : votes == null ? 'Indisponível' : '<span class="tw"' + twAttr('sb-v' + key, votes, 'int') + '>' + fmtNumber.format(votes) + '</span> votos';
      return '<div class="score-candidate score-' + color + '">' + (photo ? '<img class="candidate-photo" src="https://resultados.tse.jus.br/oficial/ele2026/6258/fotos/br/' + safeText(photo) + '.jpeg" alt="" onerror="this.hidden=true">' : '<span class="candidate-photo photo-empty" aria-hidden="true">' + number + '</span>') + '<div class="score-identity"><p class="candidate-id">' + number + ' · ' + party + '</p><h3>' + name + '</h3></div><strong class="score-percent">' + pctHtml + '</strong><span class="score-votes">' + votesHtml + '</span></div>';
    };
    const status = usePartial
      ? '<span class="score-source"><strong>' + safeText(partial.label) + '</strong>' + (partial.detail ? ' · ' + partial.detail : '') + '</span>'
      : reference ? '<span class="score-source"><strong>Sem apuração ainda</strong> · totalização do TSE a partir das 17h</span>'
      : '<span><strong>' + (progress == null ? 'Indisponível' : '<span class="tw"' + twAttr('sb-pst', progress, 'pct') + '>' + pct(progress) + '</span>') + ' apurado</strong></span>';
    const totalHtml = total == null ? 'Indisponível' : '<span class="tw"' + twAttr('sb-total', total, 'int') + '>' + fmtNumber.format(total) + '</span>';
    const remainingHtml = usePartial ? (partial.remaining || remainingMillions) : remainingMillions;
    const totalBlock = '<span>Total apurado <strong class="score-total" data-total="' + (total == null ? '' : total) + '">' + totalHtml + '</strong> votos</span><span>Faltam <strong>' + remainingHtml + '</strong></span>';
    const diffHtml = diffVotes == null ? 'Indisponível' : '<span class="tw"' + twAttr('sb-diff', Math.abs(diffVotes), 'int') + '>' + fmtNumber.format(Math.abs(diffVotes)) + '</span> votos · ' + (diffVotes > 0 ? 'Flávio' : diffVotes < 0 ? 'Lula' : 'empate');
    const diffSmall = diffPoints == null ? 'Percentual indisponível' : '<span class="tw"' + twAttr('sb-diffp', Math.abs(diffPoints), 'pp') + '>' + fmtPercent.format(Math.abs(diffPoints)) + '</span> p.p. nos votos válidos' + (usePartial ? ' · ' + safeText(partial.short || 'parcial') : '');
    return '<section class="pres-scoreboard' + (usePartial ? ' is-partial' : reference ? ' is-reference' : '') + '" aria-label="Placar presidencial do segundo turno"><div class="score-candidates">' + candidate('13', 'Lula', 'PT', r1b, b, votesB, pctB, 'lula', 'b') + candidate('22', 'Flávio Bolsonaro', 'PL', r1a, a, votesA, pctA, 'flavio', 'a') + '</div><div class="score-split" role="img" aria-label="Barra de votos válidos do segundo turno"><span class="score-split-lula" style="width:' + lulaWidth + '%" data-tw-w="sb-wl"></span><span class="score-split-flavio" style="width:' + (splitTotal > 0 ? 100 - lulaWidth : 0) + '%" data-tw-w="sb-wf"></span><i aria-hidden="true"></i></div><div class="score-summary">' + status + totalBlock + '</div><div class="score-difference"><span>Diferença</span><strong>' + diffHtml + '</strong><small>' + diffSmall + '</small></div></section>';
  }
  // ---- Números que mudam no lugar: tween (contagem) + flash/seta de direção. Nunca esvazia: o HTML novo já traz o valor final. ----
  const TW = { shown: Object.create(null), anims: Object.create(null), flash: Object.create(null), widths: Object.create(null), raf: 0 };
  const TW_FLASH_MS = 1400;
  function twDuration() { return typeof matchMedia === 'function' && matchMedia('(max-width: 700px)').matches ? 650 : 800; }
  function fmtShort(x) { const a = Math.abs(x); return a >= 1e6 ? new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 }).format(a / 1e6) + ' mi' : a >= 1e3 ? new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 }).format(a / 1e3) + ' mil' : fmtNumber.format(Math.round(a)); }
  function twFormat(f, v) {
    if (f === 'pct') return fmtPercent.format(v) + '%';
    if (f === 'pp') return fmtPercent.format(Math.abs(v));
    if (f === 'pct0') return Math.round(v) + '%';
    if (f === 'short') return fmtShort(v);
    return fmtNumber.format(Math.round(Math.abs(v)));
  }
  // Atributos de um número animável (key estável por significado; f = formato).
  function twAttr(key, value, f) { const v = Number(value); return Number.isFinite(v) ? ' data-tw="' + key + '" data-v="' + v + '" data-f="' + (f || 'int') + '"' : ''; }
  function tw(key, value, f, cls) { const v = Number(value); return '<span class="tw' + (cls ? ' ' + cls : '') + '"' + twAttr(key, v, f) + '>' + twFormat(f || 'int', v) + '</span>'; }
  function twNow() { return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now(); }
  function twTick(now) {
    TW.raf = 0;
    let live = false;
    for (const k of Object.keys(TW.anims)) {
      const a = TW.anims[k], r = Math.max(0, Math.min(1, (now - a.t0) / a.dur)), e = 1 - Math.pow(1 - r, 3);
      const v = r >= 1 ? a.to : a.from + (a.to - a.from) * e;
      TW.shown[k] = v;
      document.querySelectorAll('[data-tw="' + k + '"]').forEach((el) => { el.textContent = twFormat(a.f, v); });
      if (r >= 1) delete TW.anims[k]; else live = true;
    }
    if (live) TW.raf = requestAnimationFrame(twTick);
  }
  function twApply(root) {
    if (!root || !root.querySelectorAll || typeof document === 'undefined') return;
    const now = twNow(), canAnimate = typeof requestAnimationFrame === 'function' && !prefersReducedMotion();
    root.querySelectorAll('[data-tw]').forEach((el) => {
      const k = el.getAttribute('data-tw'), to = Number(el.getAttribute('data-v')), f = el.getAttribute('data-f') || 'int';
      if (!Number.isFinite(to)) return;
      const anim = TW.anims[k], from = TW.shown[k];
      if (anim && anim.to === to) { el.textContent = twFormat(f, from); }
      else {
        if (anim) delete TW.anims[k];
        if (from == null || !Number.isFinite(from)) TW.shown[k] = to;
        else if (Math.abs(from - to) > 1e-9) {
          TW.flash[k] = { dir: to > from ? 'up' : 'down', at: now };
          if (canAnimate) { TW.anims[k] = { from, to, f, t0: now, dur: twDuration() }; el.textContent = twFormat(f, from); }
          else TW.shown[k] = to;
        }
      }
      const fl = TW.flash[k];
      if (fl && now - fl.at < TW_FLASH_MS) { el.classList.add('tw-' + fl.dir); el.style.animationDelay = '-' + Math.round(now - fl.at) + 'ms'; }
    });
    // Barras: começam na largura anterior e deslizam até a nova (o CSS faz a transição).
    const pending = [];
    root.querySelectorAll('[data-tw-w]').forEach((el) => {
      const k = el.getAttribute('data-tw-w'), to = el.style.width, from = TW.widths[k];
      TW.widths[k] = to;
      if (canAnimate && from != null && from !== to) { el.style.width = from; pending.push([el, to]); }
    });
    if (pending.length) { void root.offsetWidth; requestAnimationFrame(() => pending.forEach(([el, w]) => { el.style.width = w; })); }
    if (canAnimate && !TW.raf && Object.keys(TW.anims).length) TW.raf = requestAnimationFrame(twTick);
  }
  function regionCard(uf, result, turn) {
    const candidates = Array.isArray(result && result.cands) ? result.cands.slice(0, 2) : [];
    const progress = Number.isFinite(Number(result && result.pst)) ? pct(result.pst) : '—';
    const names = candidates.map((c) => safeText(c.nm || 'Candidato') + ' <strong>' + pct(c.p) + '</strong>').join('<br>');
    return '<article class="region-card"><div class="region-heading"><h3>' + safeText(UF_NAMES[uf] || uf.toUpperCase()) + '</h3><span>' + progress + ' apurado</span></div><p>' + (names || '<span class="muted">Dados indisponíveis</span>') + '</p><small>' + safeText(turn) + '</small></article>';
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
    if (remaining === 0) return 'Urnas fechadas · primeiros números do TSE a qualquer momento';
    const days = Math.floor(remaining / 86400);
    const hours = Math.floor((remaining % 86400) / 3600);
    const minutes = Math.floor((remaining % 3600) / 60);
    const seconds = remaining % 60;
    return 'Início previsto em ' + (days ? days + 'd ' : '') + hours + 'h ' + minutes + 'min ' + seconds + 's.';
  }
  const UF_ORDER = ['ac','al','am','ap','ba','ce','df','es','go','ma','mt','ms','mg','pa','pb','pr','pe','pi','rj','rn','rs','ro','rr','sc','sp','se','to','zz'];
  const ufSort = { key: 'uf', direction: 1 };
  let mapMode = preferences.mapMode;
  let mapSvgPromise = null;
  let selectedUf = null;
  let openAnalysisPanel = null;
  function persistPreferences() { try { localStorage.setItem(PREFERENCES_KEY, JSON.stringify(preferences)); } catch (_) {} }
  function applyPreferences() {
    mapMode = preferences.mapMode;
    if (typeof document === 'undefined') return;
    document.documentElement.dataset.theme = preferences.theme;
    const color = document.querySelector('meta[name="theme-color"]'); if (color) color.content = preferences.theme === 'light' ? '#f3f5fb' : '#090d24';
    const setHidden = (id, hidden) => { const node = $(id); if (node) node.hidden = hidden; };
    setHidden('pres-chance', !preferences.showChance);
    const chart = document.querySelector('.timeline-panel'); if (chart) chart.hidden = !preferences.showChart;
    const mapPanel = document.querySelector('.ufs-panel'); if (mapPanel) mapPanel.hidden = !preferences.showMap;
    const controls = { 'region-filter':preferences.region, 'theme-select':preferences.theme, 'pref-map':preferences.showMap, 'pref-chance':preferences.showChance, 'pref-chart':preferences.showChart, 'pref-comparison':preferences.showComparison };
    Object.entries(controls).forEach(([id,value]) => { const el = $(id); if (el) { if (el.type === 'checkbox') el.checked = value; else el.value = value; } });
    document.querySelectorAll('[data-map-mode]').forEach((button) => { const active = button.dataset.mapMode === mapMode; button.classList.toggle('is-active',active); button.setAttribute('aria-pressed',String(active)); });
    document.querySelectorAll('[data-first-turn-comparison]').forEach((node) => { node.hidden = !preferences.showComparison; });
    ['analysis-swing','analysis-first'].forEach((id) => { const panel = $(id); if (panel) panel.classList.toggle('comparison-hidden', !preferences.showComparison); });
    const detail = $('uf-detail'); if (detail) detail.querySelectorAll('[data-first-turn-comparison]').forEach((node) => { node.hidden = !preferences.showComparison; });
    const rows = document.querySelectorAll('#uf-table-body tr[data-uf]');
    rows.forEach((row) => { row.hidden = preferences.region !== 'all' && !(REGION_UFS[preferences.region] || []).includes(row.dataset.uf); });
    document.querySelectorAll('.uf-region[data-uf]').forEach((path) => path.classList.toggle('region-muted', preferences.region !== 'all' && !(REGION_UFS[preferences.region] || []).includes(path.dataset.uf)));
    const ext = document.querySelector('#uf-exterior [data-uf="zz"]'); if (ext) ext.classList.toggle('region-muted', preferences.region !== 'all' && !(REGION_UFS[preferences.region] || []).includes('zz'));
    const chips = document.querySelectorAll('#uf-chips [data-uf]'); chips.forEach((chip) => chip.classList.toggle('region-muted', preferences.region !== 'all' && !(REGION_UFS[preferences.region] || []).includes(chip.dataset.uf)));
    const mapSvg = document.querySelector('#uf-map svg'); if (mapSvg) scheduleMapGuides(mapSvg);
  }
  function setupPreferences() {
    const chance = $('pres-chance');
    if (chance) chance.addEventListener('click', (event) => {
      if (!event.target.closest('.chance-mobile-trigger')) return;
      const details = $('chance-method'); if (details) details.open = !details.open;
    });
    const trigger = $('settings-trigger');
    if (trigger) trigger.addEventListener('click', () => { if (openAnalysisPanel) openAnalysisPanel('settings'); });
    document.querySelectorAll('[data-map-mode]').forEach((button) => button.addEventListener('click', () => { preferences.mapMode = button.dataset.mapMode; preferences = normalizePreferences(preferences); persistPreferences(); applyPreferences(); renderUfs(window.currentElectionSnapshot || {}); }));
    const bind = (id,key,read) => { const el = $(id); if (el) el.addEventListener('change', () => { preferences[key] = read(el); preferences = normalizePreferences(preferences); persistPreferences(); applyPreferences(); if (window.currentElectionSnapshot) renderUfs(window.currentElectionSnapshot); }); };
    bind('region-filter','region',(el) => el.value); bind('theme-select','theme',(el) => el.value);
    bind('pref-map','showMap',(el) => el.checked); bind('pref-chance','showChance',(el) => el.checked); bind('pref-chart','showChart',(el) => el.checked); bind('pref-comparison','showComparison',(el) => el.checked);
    const reset = $('reset-preferences'); if (reset) reset.addEventListener('click', () => { preferences = normalizePreferences(null); persistPreferences(); applyPreferences(); if (window.currentElectionSnapshot) render(window.currentElectionSnapshot); });
    applyPreferences();
  }
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
      const ufCounting = Number(nowResult && nowResult.pst) > 0;
      if (waiting && !ufCounting && firstA && firstB && baseSum > 0) {
        leader = Number(firstA.p) === Number(firstB.p) ? null : (Number(firstA.p) > Number(firstB.p) ? '22' : '13');
      } else if (Number(nowResult && nowResult.pst) > 0 && nowA && nowB && Number.isFinite(Number(nowA.p)) && Number.isFinite(Number(nowB.p))) {
        if (Number(nowA.p) !== Number(nowB.p)) leader = Number(nowA.p) > Number(nowB.p) ? '22' : '13';
        if (firstA && firstB && baseSum > 0) {
          const bilateralA = Number(firstA.p) * 100 / baseSum;
          swing = Number(nowA.p) - bilateralA;
        }
      }
      return { uf, name: UF_NAMES[uf], pst: Number(nowResult && nowResult.pst), waiting: waiting && !(Number(nowResult && nowResult.pst) > 0), firstA: firstA ? Number(firstA.p) : null, firstB: firstB ? Number(firstB.p) : null,
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
  function ufDetail(row, snapshot) {
    const result = snapshot && snapshot.pres && snapshot.pres.r2 && snapshot.pres.r2[row.uf];
    const urnas = validResult(result) && Number(result.st) > 0 && !(row.uf === 'zz' && result.bu) ? '<p>Urnas apuradas: ' + tw('ufd-st-' + row.uf, result.st, 'int') + '/' + fmtNumber.format(result.ts) + '</p>' : '';
    const swing = row.waiting || row.pst <= 0 || row.swing == null ? 'sem apuração ainda' : (row.swing > 0 ? '+' : '') + fmtPercent.format(row.swing) + ' p.p. de Flávio';
    const leader = row.leader === '22' ? 'Flávio' : row.leader === '13' ? 'Lula' : row.pst > 0 ? 'empate' : row.waiting ? '1º turno' : 'sem apuração';
    const president = '<div><h4>Presidente</h4><p>Apurado <strong>' + pct(row.pst) + '</strong></p>' + urnas + '<p data-first-turn-comparison>1º turno bruto <strong>Flávio ' + pct(row.firstA) + ' · Lula ' + pct(row.firstB) + '</strong></p><p data-first-turn-comparison>1º turno bilateral <strong>Flávio ' + pct(row.bilateralA) + ' · Lula ' + pct(row.bilateralA == null ? null : 100 - row.bilateralA) + '</strong></p><p>Agora <strong>' + (row.waiting || row.pst <= 0 ? 'sem apuração ainda' : 'Flávio ' + pct(row.nowA) + ' · Lula ' + pct(row.nowB)) + '</strong></p><p data-first-turn-comparison>Swing <strong>' + swing + '</strong></p></div>';
    return '<div class="uf-detail-heading"><div><p class="eyebrow">DETALHE DA ABRANGÊNCIA</p><h3>' + safeText(row.name) + ' <span>(' + row.uf.toUpperCase() + ')</span></h3></div><button type="button" id="uf-detail-close" aria-label="Fechar detalhe">×</button></div>' +
      '<p class="uf-detail-leader">' + (row.waiting || !(row.pst > 0) ? 'Sem apuração do 2º turno ainda · no 1º turno: Flávio ' + pct(row.firstA) + ' · Lula ' + pct(row.firstB) : safeText(leader) + ' lidera') + '</p>' +
      '<div class="uf-detail-grid">' + president + '</div>';
  }
  function ufTooltip(row, snapshot) {
    const result = snapshot && snapshot.pres && snapshot.pres.r2 && snapshot.pres.r2[row.uf];
    const urnas = validResult(result) && Number(result.st) > 0 && !(row.uf === 'zz' && result.bu) ? ' · Urnas apuradas: ' + fmtNumber.format(result.st) + '/' + fmtNumber.format(result.ts) : '';
    const color = mapColor(row, mapMode);
    const basis = Number(row.pst) === 0 ? 'no 1º turno: Flávio ' + pct(row.firstA) + ' · Lula ' + pct(row.firstB) : 'base: 2º turno';
    const value = color.value == null ? (Number(row.pst) === 0 || row.waiting ? 'sem apuração ainda' : 'sem dados') : mapMode === 'swing' ? (color.value > 0 ? '+' : '') + fmtPercent.format(color.value) + ' p.p.' : pct(color.value);
    return row.name + ' · ' + color.state + ' · ' + basis + ' · ' + value + urnas;
  }
  function showUfDetail(uf, trigger, snapshotArg) {
    const snapshot = snapshotArg || (typeof window !== 'undefined' ? window.currentElectionSnapshot : null);
    const row = ufRows(snapshot || {}).find((item) => item.uf === uf);
    if (!row) return;
    selectedUf = uf;
    const panel = $('uf-detail');
    if (typeof matchMedia === 'function') {
      if (!panel.__home) panel.__home = { parent: panel.parentElement, next: panel.nextSibling };
      const mobileSheet = matchMedia('(max-width: 1023px)').matches;
      if (mobileSheet && panel.parentElement !== document.body) document.body.appendChild(panel);
      else if (!mobileSheet && panel.parentElement === document.body && panel.__home.parent) panel.__home.parent.insertBefore(panel, panel.__home.next && panel.__home.next.parentElement === panel.__home.parent ? panel.__home.next : null);
    }
    panel.innerHTML = ufDetail(row, snapshot);
    if (uf === 'zz' && buZZ) { const head = panel.querySelector('.uf-detail-leader'); const html = buDetailMarkup(snapshot && snapshot.__zzOfficial); if (head) head.insertAdjacentHTML('afterend', html); else panel.insertAdjacentHTML('beforeend', html); }
    panel.querySelectorAll('[data-first-turn-comparison]').forEach((node) => { node.hidden = !preferences.showComparison; });
    twApply(panel);
    panel.dataset.open = 'true';
    panel.dataset.uf = uf;
    const selector = $('uf-select'); if (selector) selector.value = uf;
    const close = $('uf-detail-close');
    if (close) close.addEventListener('click', () => closeUfDetail(true));
    panel.dataset.trigger = uf === 'zz' ? 'uf-exterior' : trigger && trigger.id ? trigger.id : '';
    refreshTurnCompare();
  }
  function closeUfDetail(returnFocus) {
    const panel = $('uf-detail'); if (!panel) return;
    const triggerId = panel.dataset.trigger;
    panel.dataset.open = 'false'; panel.dataset.uf = '';
    selectedUf = null;
    refreshTurnCompare();
    panel.innerHTML = '<p>Selecione uma UF para ver os detalhes.</p>';
    const selector = $('uf-select'); if (selector) selector.value = '';
    if (returnFocus && triggerId) {
      const trigger = triggerId === 'uf-exterior' ? $('uf-exterior').querySelector('[data-uf="zz"]') : document.getElementById(triggerId);
      if (trigger && trigger.focus) trigger.focus();
    }
  }
  const NO_COUNT = '<span class="cell-muted">sem apuração</span>';
  function ufsMarkup(snapshot) {
    const rows = ufRows(snapshot);
    const byUf = Object.fromEntries(rows.map((row) => [row.uf, row]));
    const ordered = sortUfRows(rows, ufSort.key, ufSort.direction);
    const cell = (value) => value == null || !Number.isFinite(Number(value)) ? NO_COUNT : pct(value);
    const table = ordered.map((r) => '<tr data-uf="' + r.uf + '"><th scope="row">' + r.uf.toUpperCase() + '</th><td>' + cell(r.pst) + '</td><td data-first-turn-comparison>' + cell(r.firstA) + '</td><td data-first-turn-comparison>' + cell(r.firstB) + '</td><td>' + (r.waiting ? NO_COUNT : cell(r.nowA)) + '</td><td>' + (r.waiting ? NO_COUNT : cell(r.nowB)) + '</td><td data-first-turn-comparison title="Base bilateral: ' + cell(r.bilateralA) + '">' + (r.waiting || r.swing == null ? NO_COUNT : (r.swing > 0 ? '+' : '') + fmtPercent.format(r.swing) + ' p.p.') + '</td></tr>').join('');
    return { rows: byUf, table };
  }
  function mapColor(row, mode) {
    if (!row) return { fill: '#454963', value: null, state: 'sem dados' };
    if (mode === 'progress') {
      if (!Number.isFinite(row.pst) || row.pst < 0) return { fill:'#454963', value:null, state:'sem dados' };
      const value = Math.max(0, Math.min(100, row.pst));
      return { fill: value === 0 ? '#454963' : 'rgba(112, 151, 255, ' + (0.28 + value / 145).toFixed(3) + ')', value, state: value === 0 ? 'sem apuração ainda' : 'seções apuradas' };
    }
    const hasCount = Number.isFinite(row.pst) && row.pst > 0;
    const hasNow = !row.waiting && hasCount && row.nowA != null && row.nowB != null;
    if (mode === 'swing' && (!hasNow || row.swing == null)) return { fill: '#454963', value: null, state: row.pst === 0 ? 'sem apuração ainda' : 'sem dados' };
    if (mode === 'swing') {
      const value = row.swing;
      if (Math.abs(value) <= 0.01) return { fill: '#77718d', value, state: 'perto de zero' };
      const strength = Math.min(0.78, 0.28 + Math.abs(value) / 35);
      return { fill: value > 0 ? 'rgba(49, 193, 232, ' + strength + ')' : 'rgba(255, 108, 126, ' + strength + ')', value, state: value > 0 ? 'a favor de Flávio' : 'a favor de Lula' };
    }
    if (!hasNow) return { fill: '#454963', value: null, state: row.pst === 0 ? 'sem apuração ainda' : 'sem dados' };
    const leader = row.leader;
    if (!leader) return { fill: '#454963', value: null, state: row.pst > 0 ? 'empate' : 'sem apuração ainda' };
    const share = leader === '22' ? row.nowA : row.nowB;
    if (share == null) return { fill: '#454963', value: null, state: 'sem dados' };
    const margin = Math.abs(Number(row.nowA) - Number(row.nowB));
    const alpha = Math.min(0.86, 0.36 + margin / 35);
    return { fill: leader === '22' ? 'rgba(49, 193, 232, ' + alpha + ')' : 'rgba(255, 108, 126, ' + alpha + ')', value: share, state: leader === '22' ? 'Flávio lidera' : 'Lula lidera' };
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
        const label = ufTooltip(row, snapshot);
        path.setAttribute('aria-label', label);
        path.setAttribute('title', label);
        path.setAttribute('aria-pressed', String(selectedUf === uf));
        path.classList.toggle('is-selected', selectedUf === uf);
        path.dataset.uf = uf;
      });
      addMapLabels(host.querySelector('svg'));
      return true;
    });
  }
  function addMapLabels(svg) {
    if (!svg) return;
    let group = svg.querySelector('.uf-labels');
    if (!group) {
      const ns='http://www.w3.org/2000/svg';
      group=document.createElementNS(ns,'g'); group.setAttribute('class','uf-labels'); group.setAttribute('aria-hidden','true'); group.setAttribute('pointer-events','none');
      // Centro de maior afastamento da borda, aproximado por amostragem do interior de cada path.
      const chipOrder=['rn','pb','pe','al','se','es','rj','df'];
      svg.querySelectorAll('path[id]').forEach(path => {
        const box = path.getBBox(), point = svg.createSVGPoint();
        let best = null, bestDistance = -1;
        const edgeLength = path.getTotalLength(), edgeSamples = [];
        for (let i=0;i<72;i++) edgeSamples.push(path.getPointAtLength(edgeLength*i/72));
        for (let y=box.y+2;y<box.y+box.height;y+=7) for (let x=box.x+2;x<box.x+box.width;x+=7) {
          point.x=x; point.y=y;
          if (!path.isPointInFill(point)) continue;
          let distance=Infinity;
          for (const edge of edgeSamples) distance=Math.min(distance,Math.hypot(edge.x-x,edge.y-y));
          if (distance>bestDistance) { bestDistance=distance; best={x,y}; }
        }
        if (!best) best={x:box.x+box.width/2,y:box.y+box.height/2};
        const node=document.createElementNS(ns,'text'); node.dataset.uf=path.id.toLowerCase(); node.setAttribute('x',best.x); node.setAttribute('y',best.y); node.textContent=path.id; group.appendChild(node);
      });
      svg.appendChild(group);
    }
    updateMapGuides(svg);
    if (!mapGuideObserver && typeof ResizeObserver !== 'undefined') {
      mapGuideObserver = new ResizeObserver(() => scheduleMapGuides(svg));
      for (const target of [svg, document.querySelector('.map-layout'), document.querySelector('#uf-chips')]) if (target) mapGuideObserver.observe(target);
      svg.addEventListener('transitionend', () => scheduleMapGuides(svg));
      setTimeout(() => scheduleMapGuides(svg), 1200);
    }
  }
  function scheduleMapGuides(svg) {
    if (mapGuideFrame) cancelAnimationFrame(mapGuideFrame);
    mapGuideFrame = requestAnimationFrame(() => { mapGuideFrame=0; updateMapGuides(svg); });
  }
  function updateMapGuides(svg) {
    if (!svg || !svg.isConnected) return;
    const ns='http://www.w3.org/2000/svg', group=svg.querySelector('.uf-labels');
    if (!group) return;
    let guides=group.querySelector('.uf-guides');
    if (!guides) { guides=document.createElementNS(ns,'g'); guides.setAttribute('class','uf-guides'); group.prepend(guides); }
    const chipOrder=['rn','pb','pe','al','se','es','rj','df'];
    const chipsVisible = matchMedia('(min-width: 701px)').matches && getComputedStyle(document.querySelector('.map-chips')).display !== 'none';
    guides.replaceChildren();
    const oldLayer=svg.closest('.map-layout')?.querySelector(':scope > .uf-guide-layer');
    if (!chipsVisible) { if (oldLayer) oldLayer.replaceChildren(); return; }
    const layout=svg.closest('.map-layout');
    if (!layout) return;
    let layer=layout.querySelector(':scope > .uf-guide-layer');
    if (!layer) { layer=document.createElementNS(ns,'svg'); layer.setAttribute('class','uf-guide-layer'); layer.setAttribute('aria-hidden','true'); layout.prepend(layer); }
    layer.replaceChildren();
    const base=layout.getBoundingClientRect();
    for (const uf of chipOrder) {
      const chip=document.querySelector('#uf-chips [data-uf="'+uf+'"]'), label=group.querySelector('text[data-uf="'+uf+'"]');
      if (!chip || !label || !chip.getClientRects().length) continue;
      let anchor=group.querySelector('circle.uf-anchor[data-uf="'+uf+'"]');
      if (!anchor) { anchor=document.createElementNS(ns,'circle'); anchor.setAttribute('class','uf-anchor'); anchor.dataset.uf=uf; anchor.setAttribute('r','1'); group.appendChild(anchor); }
      anchor.setAttribute('cx',label.getAttribute('x')); anchor.setAttribute('cy',label.getAttribute('y'));
      const end=anchor.getBoundingClientRect(), rect=chip.getBoundingClientRect();
      const x1=rect.left-base.left-2, y1=rect.top+rect.height/2-base.top, x2=end.left+end.width/2-base.left, y2=end.top+end.height/2-base.top;
      const line=document.createElementNS(ns,'path');
      line.setAttribute('d','M'+x1.toFixed(1)+' '+y1.toFixed(1)+' L'+x2.toFixed(1)+' '+y2.toFixed(1)); line.setAttribute('class','uf-guide'); line.dataset.uf=uf; layer.appendChild(line);
      const dot=document.createElementNS(ns,'circle'); dot.setAttribute('cx',x2.toFixed(1)); dot.setAttribute('cy',y2.toFixed(1)); dot.setAttribute('r','2.5'); dot.setAttribute('class','uf-guide-dot'); layer.appendChild(dot);
    }
  }
  function mapLegend(mode, waiting) {
    return mode === 'progress'
      ? '<span><i class="progress-low"></i>menos apurado</span><span><i class="progress-high"></i>mais apurado</span><span><i class="swing-neutral"></i>sem dados</span>'
      : mode === 'leader'
      ? '<span><i class="legend-lula"></i>Lula lidera</span><span><i class="legend-flavio"></i>Flávio lidera</span><span><i class="swing-neutral"></i>empate</span><span><i class="swing-neutral"></i>sem apuração ainda</span><span><i class="swing-neutral"></i>sem dados</span>' + (waiting ? '<span class="legend-note">Base: 2º turno</span>' : '<span class="legend-note">Intensidade = margem</span>')
      : '<span><i class="swing-neg"></i>− a favor de Lula</span><span><i class="swing-mid"></i>perto de zero</span><span><i class="swing-pos"></i>+ a favor de Flávio</span><span><i class="swing-neutral"></i>sem apuração ainda</span><span><i class="swing-neutral"></i>empate</span>';
  }
  function renderUfs(snapshot) {
    const markup = ufsMarkup(snapshot);
    paintMap(snapshot);
    const exterior = markup.rows.zz;
    const ext = $('uf-exterior');
    if (ext && exterior) {
      const color = mapColor(exterior, mapMode);
      ext.innerHTML = '<button type="button" id="uf-exterior-trigger" class="uf-exterior-button ' + (mapMode === 'swing' ? swingClass(exterior) : 'leader-' + (exterior.leader || 'neutral')) + '" data-uf="zz" aria-pressed="' + (selectedUf === 'zz') + '" style="--uf-fill:' + color.fill + '"><strong>🌐 Exterior (ZZ)</strong><span>' + (snapshot.pres.r2.zz && snapshot.pres.r2.zz.bu ? '<i class="bu-tag">BUs ' + tw('ext-st', snapshot.pres.r2.zz.st, 'int') + '/' + fmtNumber.format(snapshot.pres.r2.zz.ts) + '</i> ' : '') + (color.value == null ? (color.state === 'sem dados' ? 'Sem dados' : color.state) : mapMode === 'swing' ? (color.value > 0 ? '+' : '') + fmtPercent.format(color.value) + ' p.p.' : tw('ext-p-' + mapMode, color.value, 'pct')) + '</span></button>';
    }
    if (ext) twApply(ext);
    const chips = $('uf-chips');
    if (chips) chips.innerHTML = ['rn','pb','pe','al','se','es','rj','df'].map((uf) => '<button type="button" id="uf-chip-' + uf + '" class="uf-chip" data-uf="' + uf + '" aria-pressed="' + (selectedUf === uf) + '" aria-label="Selecionar ' + UF_NAMES[uf] + '">' + uf.toUpperCase() + '</button>').join('');
    if ($('uf-table-body')) $('uf-table-body').innerHTML = markup.table;
    const legend = $('swing-legend');
    if (legend) {
      const waiting = isAwaiting(snapshot);
      legend.setAttribute('aria-label', mapMode === 'leader' ? (waiting ? 'Legenda da liderança no primeiro turno' : 'Legenda de quem lidera') : mapMode === 'swing' ? 'Legenda do swing do Flávio contra a base bilateral do primeiro turno' : 'Legenda de percentual de seções apuradas');
      legend.innerHTML = mapLegend(mapMode, waiting);
    }
    const selector = $('uf-select');
    if (selector && selector.options.length <= 1) selector.innerHTML = '<option value="">Selecione…</option>' + UF_ORDER.filter((uf) => uf !== 'zz').map((uf) => '<option value="' + uf + '">' + UF_NAMES[uf] + ' (' + uf.toUpperCase() + ')</option>').join('') + '<option value="zz">Exterior (ZZ)</option>';
    if (selectedUf) {
      const mapHost = $('uf-map');
      const trigger = selectedUf === 'zz' ? (ext && ext.querySelector('[data-uf="zz"]')) : (mapHost && mapHost.querySelector ? mapHost.querySelector('#' + selectedUf.toUpperCase()) : null);
      showUfDetail(selectedUf, trigger, snapshot);
    }
    applyPreferences();
  }
  function setupUfControls() {
    if (!$('uf-map')) return;
    $('uf-map').addEventListener('click', (event) => {
      const tile = event.target.closest('[data-uf]');
      if (!tile) return;
      const row = ufRows(window.currentElectionSnapshot || {}).find((item) => item.uf === tile.dataset.uf);
      if (row) showUfDetail(row.uf, tile);
    });
    if ($('uf-chips')) $('uf-chips').addEventListener('click', (event) => {
      const button = event.target.closest('[data-uf]'); if (!button) return;
      showUfDetail(button.dataset.uf, button);
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
      if (title) title.textContent = remaining ? 'Totalização oficial do TSE às 17h' : 'Urnas fechadas · primeiros números do TSE a qualquer momento';
      if (countdown) countdown.innerHTML = remaining ? '<span class="clock-live-dot" aria-hidden="true"></span>' + [Math.floor(remaining / 3600), Math.floor((remaining % 3600) / 60), remaining % 60].map((n, i) => '<span class="clock-unit"><strong>' + String(n).padStart(2, '0') + '</strong><small>' + ['horas','minutos','segundos'][i] + '</small></span>').join('<i>:</i>') : '<span class="clock-live-dot" aria-hidden="true"></span>';
    }
  }

  // ---- Exterior por boletins de urna (agregado no box por scripts/bu_exterior.py, branch "dados") ----
  const DADOS_BASE = 'https://raw.githubusercontent.com/YuriVbs70/eleicoes-2026/dados/';
  const BU_URL = DADOS_BASE + 'zz-bu.json';
  const BU_REFRESH_MS = 60000;
  let buZZ = null, buLastOk = 0, buFails = 0, buTimer = null;
  function validBu(d) {
    return !!d && typeof d === 'object' && Number.isFinite(Number(d.recebidas)) && Number(d.secoes_principais) > 0 && !!d.totais && ['lula', 'flavio', 'brancos', 'nulos'].every((k) => Number.isFinite(Number(d.totais[k])));
  }
  function buStamp(d) {
    const m = String(d && d.gerado || '').match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/);
    return m ? { dg: m[3] + '/' + m[2] + '/' + m[1], hg: m[4] + ':' + m[5] + ':' + m[6], hm: m[4] + ':' + m[5] } : null;
  }
  function buSynthetic(d, official, first) {
    const t = d.totais, a = Number(t.flavio) || 0, b = Number(t.lula) || 0, vv = a + b;
    if (!vv || !Number(d.recebidas)) return null;
    const stamp = buStamp(d) || {};
    const base = (official && Array.isArray(official.cands) && official.cands.length ? official.cands : (first && first.cands || []).filter((c) => c.n === '13' || c.n === '22'));
    const cands = base.map((c) => { const v = String(c.n) === '22' ? a : String(c.n) === '13' ? b : 0; return Object.assign({}, c, { v, p: Math.round(10000 * v / vv) / 100 }); }).sort((x, y) => y.v - x.v);
    if (!cands.length) return null;
    return { pst: Math.min(100, Math.round(10000 * Number(d.recebidas) / Number(d.secoes_principais)) / 100), st: Number(d.recebidas), ts: Number(d.secoes_principais), te: official && Number(official.te) || 0, comp: Number(t.comp) || 0, pc: 0, vv, vb: Number(t.brancos) || 0, vn: Number(t.nulos) || 0, dg: stamp.dg, hg: stamp.hg, tf: 'p', bu: true, cands };
  }
  function applyBuOverlay(snapshot) {
    const r2 = snapshot && snapshot.pres && snapshot.pres.r2; if (!r2) return;
    const cur = r2.zz;
    if (cur && !cur.bu) snapshot.__zzOfficial = cur;
    const official = snapshot.__zzOfficial || null;
    if (official && Number(official.pst) > 0) { r2.zz = official; return; }  // após a totalização oficial começar, ela manda
    let syn = null;
    try { syn = buZZ ? buSynthetic(buZZ, official, snapshot.pres.r1 && snapshot.pres.r1.zz) : null; } catch (err) { console.warn('BU zz: falha ao montar parcial', err); }
    if (syn) r2.zz = syn; else if (official) r2.zz = official;
  }
  function buDetailMarkup(official) {
    if (!buZZ) return '';
    const t = buZZ.totais, a = Number(t.flavio) || 0, b = Number(t.lula) || 0, vv = a + b, st = buStamp(buZZ);
    const officialOn = official && Number(official.pst) > 0;
    const top = (buZZ.paises || []).filter((p) => p.rec > 0).slice(0, 8).map((p) => { const s = p.lula + p.flavio; return '<li><span>' + safeText(p.pais) + ' <small>' + p.rec + '/' + p.tot + ' BUs</small></span><b class="bu-a">' + (s ? fmtPercent.format(100 * p.flavio / s) : '—') + '%</b><b class="bu-b">' + (s ? fmtPercent.format(100 * p.lula / s) : '—') + '%</b></li>'; }).join('');
    return '<section class="bu-detail" id="bu-detail"><h4>Exterior · boletins de urna (parcial)</h4>' +
      '<p class="bu-warn">Parcial por boletins de urna, não é a totalização oficial' + (officialOn ? ' · o painel já usa a totalização oficial do TSE' : '') + '.</p>' +
      '<p class="bu-count"><strong>' + tw('bu-rec', Number(buZZ.recebidas) || 0, 'int') + '</strong> de ' + fmtNumber.format(Number(buZZ.secoes_principais) || 0) + ' BUs recebidos' + (st ? ' · coletado às ' + st.hm + ' (Brasília)' : '') + '</p>' +
      (vv ? '<p class="bu-tot"><span class="bu-a">Flávio <b>' + tw('bu-a', a, 'int') + '</b> (' + fmtPercent.format(100 * a / vv) + '%)</span> <span class="bu-b">Lula <b>' + tw('bu-b', b, 'int') + '</b> (' + fmtPercent.format(100 * b / vv) + '%)</span></p><p class="bu-sub">Brancos ' + fmtNumber.format(Number(t.brancos) || 0) + ' · nulos ' + fmtNumber.format(Number(t.nulos) || 0) + '</p>' : '<p class="bu-sub">Nenhum BU com votos ainda.</p>') +
      (top ? '<ol class="bu-paises"><li class="bu-h"><span>País</span><b>Flávio</b><b>Lula</b></li>' + top + '</ol>' : '') +
      '<p class="bu-src">Fonte: arquivos públicos de BU do TSE (resultados.tse.jus.br, arquivo-urna 3221).</p></section>';
  }
  async function refreshBu() {
    try {
      const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
      const kill = ctrl ? setTimeout(() => ctrl.abort(), 8000) : null;
      const res = await fetch(BU_URL + '?t=' + Math.floor(Date.now() / 60000), { cache: 'no-store', signal: ctrl ? ctrl.signal : undefined });
      if (kill) clearTimeout(kill);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const d = await res.json();
      if (!validBu(d)) throw new Error('formato inesperado');
      const changed = !buZZ || buZZ.gerado !== d.gerado || buZZ.recebidas !== d.recebidas;
      buZZ = d; buLastOk = Date.now(); buFails = 0;
      const snap = typeof window !== 'undefined' ? window.currentElectionSnapshot : null;
      if (changed && snap) { try { render(snap, false); } catch (err) { console.error('render (BU) falhou', err); } }
    } catch (err) {
      buFails += 1; console.warn('BU zz indisponível, mantendo último dado bom', err && err.message || err);
    } finally {
      if (typeof setTimeout !== 'function') return;
      if (buTimer) clearTimeout(buTimer);
      buTimer = setTimeout(refreshBu, Math.min(BU_REFRESH_MS * Math.pow(2, Math.min(buFails, 3)), 8 * 60000));
    }
  }
  // ---- Projeção por urna (scripts/projecao_urna.py no box, branch "dados") ----
  // Aparece só quando o box marca "mostrar" (amostra do Brasil suficiente) ou com ?pu=1 (prévia).
  const PU_URL = DADOS_BASE + 'projecao-urna.json';
  let puTimer = null, puFails = 0;
  let puEvid = null, puChanceBu = true;
  function puPreview() { try { return typeof window !== 'undefined' && /[?&]pu=1\b/.test(window.location.search); } catch (e) { return false; } }
  function puBlock(d, preview) {
    if (!d || typeof d !== 'object') return null;
    const n = d.nacional;
    if (n && n.status === 'ok' && Number.isFinite(Number(n.lula)) && (d.mostrar === true || preview)) return { b: n, escopo: 'Brasil + Exterior', urnas: Number(n.observadas) || 0, det: (Number(n.urnas_br) || 0) + ' urnas da amostra do Brasil (de ' + fmtNumber.format(Number(n.amostra) || 0) + ') + ' + (Number(n.urnas_zz) || 0) + ' do Exterior' };
    const z = d.zz;
    if (preview && z && Number.isFinite(Number(z.lula))) return { b: z, escopo: 'só Exterior (prévia)', urnas: Number(z.observadas) || 0, det: (Number(z.observadas) || 0) + ' de ' + fmtNumber.format(Number(z.universo) || 0) + ' urnas do Exterior' };
    return null;
  }
  let puHtml = '';
  function puMarkup(d, preview) {
    const x = puBlock(d, preview); if (!x) return '';
    const b = x.b, f = Number(b.flavio), l = Number(b.lula), ic = Array.isArray(b.ic90) ? b.ic90.map(Number) : null;
    const st = buStamp(d), fmt1 = (v) => new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(v);
    return '<section class="data-panel urna-panel" aria-live="polite"><p class="urna-eyebrow">BOLETINS DE URNA · ' + safeText(x.escopo) + '</p><h2 class="urna-title">Projeção por urna</h2>' +
      '<div class="urna-values"><span class="urna-flavio"><b>Flávio</b><strong>' + fmt1(f) + '%</strong></span><span class="urna-lula"><b>Lula</b><strong>' + fmt1(l) + '%</strong></span></div>' +
      '<div class="urna-bar" aria-hidden="true"><span class="urna-bar-flavio" style="width:' + f + '%"></span><span class="urna-bar-lula" style="width:' + l + '%"></span></div>' +
      '<p class="urna-mobile">Projeção por urna · Flávio ' + fmt1(f) + '% · ' + fmt1(l) + '% Lula · ' + fmtNumber.format(x.urnas) + ' urnas</p>' +
      '<p class="urna-text">% dos votos válidos no fim, estimado comparando cada urna já apurada com a mesma urna no 1º turno. Não é oficial.' + (ic ? ' Faixa provável (90%) do Lula: ' + fmt1(ic[0]) + '% a ' + fmt1(ic[1]) + '%.' : '') + '</p>' +
      '<p class="urna-text">Base: <strong>' + fmtNumber.format(x.urnas) + ' urnas</strong> · ' + safeText(x.det) + (st ? ' · atualizado às ' + st.hm : '') + '</p></section>';
  }
  function puAttach(target) {
    if (!target) return;
    const old = target.querySelector('.urna-panel'); if (old) old.remove();
    target.classList.toggle('has-urna', !!puHtml);
    if (target.parentElement) target.parentElement.classList.toggle('has-urna-side', !!puHtml);
    if (puHtml) target.insertAdjacentHTML('beforeend', puHtml);
  }
  function renderPu(d) {
    // Sem card separado: a evidência por urna entra direto na barra única de chance.
    puHtml = null; void d;
    puAttach(typeof document !== 'undefined' ? $('pres-chance') : null);
  }
  async function refreshPu() {
    try {
      const res = await fetch(PU_URL + '?t=' + Math.floor(Date.now() / 60000), { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const d = await res.json();
      const previousEvid = JSON.stringify(puEvid), previousChanceBu = puChanceBu;
      const previousHist = puHist && puHist.length ? puHist[puHist.length - 1][0] + ':' + puHist.length : '';
      puHist = d && Array.isArray(d.hist) ? d.hist.slice(-300) : null;
      const histChanged = previousHist !== (puHist && puHist.length ? puHist[puHist.length - 1][0] + ':' + puHist.length : '');
      puEvid = d && d.evid || null;
      puChanceBu = !(d && d.chance_bu === false);
      renderPu(d); puFails = 0;
      if ((previousEvid !== JSON.stringify(puEvid) || previousChanceBu !== puChanceBu || histChanged) && typeof window !== 'undefined' && window.currentElectionSnapshot) {
        try { updateChance(officialView(window.currentElectionSnapshot), false); } catch (_) {}
      }
    } catch (err) { puFails += 1; console.warn('projeção por urna indisponível', err && err.message || err); }
    finally { if (typeof setTimeout === 'function') { if (puTimer) clearTimeout(puTimer); puTimer = setTimeout(refreshPu, Math.min(60000 * Math.pow(2, Math.min(puFails, 3)), 8 * 60000)); } }
  }
  function officialView(snapshot) {
    const z = snapshot && snapshot.pres && snapshot.pres.r2 && snapshot.pres.r2.zz;
    if (!z || !z.bu) return snapshot;
    const r2 = Object.assign({}, snapshot.pres.r2, { zz: snapshot.__zzOfficial || Object.assign({}, z, { pst: 0, st: 0, vv: 0, vb: 0, vn: 0, comp: 0, cands: z.cands.map((c) => Object.assign({}, c, { v: 0, p: 0 })), bu: false }) });
    return Object.assign({}, snapshot, { pres: Object.assign({}, snapshot.pres, { r2 }) });
  }
  let pollState = null;
  function latestTseRecord(snapshot) {
    const r2 = snapshot && snapshot.pres && snapshot.pres.r2 || {};
    let best = null, bestTime = -1;
    for (const uf of PRESIDENT_UFS) { const r = r2[uf] && r2[uf].bu ? (snapshot.__zzOfficial || null) : r2[uf]; const t = r ? resultTime(r) : 0; if (r && t > bestTime) { best = r; bestTime = t; } }
    return best;
  }
  function tseStamp(r) {
    const m = r && String(r.dg || '').match(/^(\d{2})\/(\d{2})/);
    return m ? m[1] + '/' + m[2] + ' ' + String(r.hg || '').slice(0, 5) : null;
  }
  function tseStripMarkup() {
    return '<div class="tse-strip" id="tse-strip"><span class="tse-gen" id="tse-gen">TSE atualizou<span class="tse-long"> pela última vez</span>: —</span><span class="tse-next" id="tse-next">Checagem a cada 4s</span><p class="tse-note" id="tse-note" hidden></p></div>';
  }
  function updateTseStrip(nowArg) {
    if (typeof document === 'undefined' || !$('tse-gen')) return;
    const snapshot = typeof window !== 'undefined' ? window.currentElectionSnapshot : null;
    if (!snapshot) return;
    const now = nowArg == null ? Date.now() : nowArg;
    $('tse-gen').innerHTML = 'TSE atualizou<span class="tse-long"> pela última vez</span>: <b>' + safeText(tseStamp(latestTseRecord(snapshot)) || '—') + '</b>';
    const next = $('tse-next');
    const stale = pollState && pollState.lastGood && now - pollState.lastGood > Math.max(3 * REFRESH_MS, 90000);
    const hm = (t) => new Date(t).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' });
    if (pollState && pollState.lastUpdated) next.textContent = pollState.busy ? 'Última checagem às ' + hm(pollState.lastUpdated) : (stale ? 'TSE instável · dados de ' + hm(pollState.lastGood) + ' · ' : '') + 'Próxima checagem em ' + Math.max(0, Math.ceil(((REFRESH_MS * (1 + (pollState.skip || 0))) - (now - pollState.lastUpdated)) / 1000)) + 's';
    else next.textContent = 'Checagem a cada 4s';
    next.classList.toggle('is-stale', !!stale);
    const note = $('tse-note'), waiting = isAwaiting(snapshot);
    note.hidden = !waiting;
    if (waiting) note.textContent = now < COUNTING_START ? 'Totalização oficial do TSE a partir das 17h (Brasília). Até lá, o placar mostra o Exterior pelos boletins de urna (parcial, não oficial).' : 'Urnas fechadas: o TSE começa a divulgar a qualquer momento. O placar segue com o Exterior pelos boletins de urna.';
  }
  function votesOf(r) { return r && Array.isArray(r.cands) ? r.cands.reduce((sum, c) => sum + (Number(c.v) || 0), 0) : 0; }
  // Melhor número real enquanto o Brasil oficial está zerado: o Exterior (boletins de urna ou ZZ oficial).
  function scoreboardPartial(snapshot) {
    const z = snapshot && snapshot.pres && snapshot.pres.r2 && snapshot.pres.r2.zz;
    if (!z || !(votesOf(z) > 0)) return null;
    if (z.bu) {
      const st = Number(z.st) || 0, ts = Number(z.ts) || 0;
      return { result: z, label: 'Parcial: Exterior por boletins de urna', detail: '<span class="tw"' + twAttr('sb-urnas', st, 'int') + '>' + fmtNumber.format(st) + '</span>/' + fmtNumber.format(ts) + ' urnas', short: 'Exterior por boletins, não oficial', remaining: ts >= st ? fmtNumber.format(ts - st) + ' urnas no Exterior' : 'Indisponível' };
    }
    return { result: z, label: 'Parcial: Exterior (TSE oficial)', detail: pct(z.pst) + ' das seções', short: 'só o Exterior' };
  }
  function turnCompareMarkup(snapshot, uf) {
    const key = uf && snapshot.pres.r1[uf] ? uf : 'br';
    let dataKey = key;
    const brCounting = (r) => !!r && Number(r.pst) > 0 && votesOf(r) > 0;
    // Sem dado oficial do Brasil: compara o Exterior (2º turno parcial × 1º turno do ZZ), rotulado. Com Brasil oficial, volta sozinho.
    if (key === 'br' && !brCounting(snapshot.pres.r2.br) && brCounting(snapshot.pres.r2.zz) && snapshot.pres.r1.zz) dataKey = 'zz';
    const r1 = snapshot.pres.r1[dataKey], r2 = snapshot.pres.r2[dataKey];
    const counting = brCounting(r2);
    const twKey = key === 'br' ? 'main' : key;
    const num = (v) => v != null && Number.isFinite(Number(v)) ? Number(v) : null;
    const votesText = (x, k) => x == null ? 'Indisponível' : '<span class="tc-full tw"' + twAttr(k + 'f', x, 'int') + '>' + fmtNumber.format(x) + '</span><span class="tc-short tw"' + twAttr(k + 's', x, 'short') + '>' + fmtShort(x) + '</span>';
    const row = (n, name, color) => {
      const c1 = candidateByNumber(r1, n), c2 = candidateByNumber(r2, n);
      const p1 = num(c1 && c1.p), v1 = num(c1 && c1.v), p2 = num(c2 && c2.p), v2 = num(c2 && c2.v);
      const delta = counting && p1 != null && p2 != null ? p2 - p1 : null;
      const k = 'tc-' + twKey + '-' + n + '-';
      return '<div class="tc-row tc-' + color + '" data-tc="' + n + '"><span class="tc-name">' + name + '</span>' +
        '<span class="tc-first"><small>1º</small> <b>' + (p1 == null ? 'Indisponível' : tw(k + 'p1', p1, 'pct')) + '</b> <em>' + votesText(v1, k + 'v1') + '</em></span>' +
        '<span class="tc-arrow" aria-hidden="true">→</span>' +
        '<span class="tc-now"><small>agora</small> ' + (counting ? '<b>' + (p2 == null ? 'Indisponível' : tw(k + 'p2', p2, 'pct')) + '</b> <em>' + votesText(v2, k + 'v2') + '</em>' : '<b class="tc-zero">0 votos</b> <em>apuração às 17h</em>') + '</span>' +
        '<span class="tc-delta' + (delta > 0 ? ' up' : delta < 0 ? ' down' : '') + '">' + (delta == null ? '<small>sem apuração ainda</small>' : (delta > 0 ? '▲ +' : delta < 0 ? '▼ −' : '= ') + tw(k + 'd', Math.abs(delta), 'pp') + ' p.p.') + '</span></div>';
    };
    const buTag = r2 && r2.bu ? ' <em class="tc-bu" title="Parcial por boletins de urna, não é a totalização oficial"><span class="tc-bu-l">parcial por BUs · não oficial</span><span class="tc-bu-s">BUs parciais</span></em>' : '';
    const scope = key === 'br'
      ? (dataKey === 'zz' ? '<span class="tc-src">' + (r2 && r2.bu ? 'Exterior (boletins)' : 'Exterior (oficial)') + '</span><span class="tc-scope-more"> · Brasil a partir das 17h</span>' + buTag : 'Brasil · % dos votos válidos')
      : safeText(UF_NAMES[key]) + buTag + ' <button type="button" class="tc-reset" data-tc-reset>Brasil ✕</button>';
    return '<div class="turn-compare" id="turn-compare" data-scope="' + key + '" data-src="' + dataKey + '"><div class="tc-head"><strong>2º turno × 1º turno</strong><span class="tc-scope">' + scope + '</span></div>' + row('13', 'Lula', 'lula') + row('22', 'Flávio', 'flavio') + '</div>';
  }
  function refreshTurnCompare() {
    const node = typeof document !== 'undefined' ? $('turn-compare') : null;
    const snapshot = typeof window !== 'undefined' ? window.currentElectionSnapshot : null;
    if (node && snapshot) { node.outerHTML = turnCompareMarkup(snapshot, selectedUf); twApply($('turn-compare')); }
  }
  function render(snapshot, chanceStale) {
    if (!snapshot || !snapshot.pres || !snapshot.pres.r1 || !snapshot.pres.r2) throw new Error('Formato de resultados inválido');
    applyBuOverlay(snapshot);
    if (typeof window !== 'undefined') window.currentElectionSnapshot = snapshot;
    liveSnapshot = snapshot;
    const pres1 = snapshot.pres.r1.br;
    const pres2 = snapshot.pres.r2.br;
    const scoreboard = presidentialComparison(pres1, pres2, scoreboardPartial(snapshot));
    // Troca no mesmo frame (sem limpar antes): o HTML novo já vem preenchido e o tween parte do último valor mostrado.
    $('pres-cards').innerHTML = tseStripMarkup() + scoreboard.replace(/<\/section>$/, turnCompareMarkup(snapshot, selectedUf) + '</section>');
    updateTseStrip();
    twApply($('pres-cards'));
    const official = officialView(snapshot);  // chance/projeção/regiões só com totalização oficial (BUs parciais ficam fora)
    updateChance(official, !!chanceStale);
    $('pres-projection').innerHTML = projectionMarkup(official);
    renderUfs(snapshot);
    $('pres-regions').innerHTML = Object.entries(REGION_UFS).map(([name, ufs]) => regionalCard(name, ufs, official)).join('');
    renderHistory();
    const firstTurn = snapshot.pres.r1.br;
    $('first-turn-details').innerHTML = '<section class="data-panel"><div class="section-heading compact"><div><p class="eyebrow">RESULTADO FINAL · 1º TURNO</p><h3>Presidência</h3></div><span>' + pct(firstTurn && firstTurn.pst) + ' das seções</span></div><div class="first-turn-candidates">' + ((firstTurn && firstTurn.cands) || []).map((candidate) => '<article><strong>' + safeText(candidate.nm || 'Candidato') + ' (' + safeText(candidate.sg || '—') + ')</strong><span>' + pct(Number(candidate.p)) + '</span><small>' + fmtNumber.format(Number(candidate.v) || 0) + ' votos</small></article>').join('') + '</div></section>';
    const fa = candidateByNumber(firstTurn, '22'), fb = candidateByNumber(firstTurn, '13');
    const na = candidateByNumber(pres2, '22'), nb = candidateByNumber(pres2, '13');
    const zzNow = scoreboardPartial(snapshot);
    const nowFallback = (n) => { const c = zzNow && candidateByNumber(zzNow.result, n); return c ? pct(Number(c.p)) + ' no Exterior (' + (zzNow.result.bu ? 'boletins, parcial' : 'oficial, parcial') + ')' : 'sem apuração ainda'; };
    $('analysis-swing-content').innerHTML = '<section class="data-panel"><div class="section-heading compact"><div><p class="eyebrow">COMPARAÇÃO PRESIDENCIAL</p><h3>1º turno × agora</h3></div></div><p>Flávio: 1º turno ' + pct(fa && Number(fa.p)) + ' · agora ' + (isAwaiting(snapshot) ? nowFallback('22') : pct(na && Number(na.p))) + '</p><p>Lula: 1º turno ' + pct(fb && Number(fb.p)) + ' · agora ' + (isAwaiting(snapshot) ? nowFallback('13') : pct(nb && Number(nb.p))) + '</p><p class="muted">A tabela por UF detalha a variação contra a base bilateral do 1º turno.</p></section>';
    const generated = snapshot.gerado ? new Date(snapshot.gerado) : null;
    $('pres-update').textContent = generated && !Number.isNaN(generated.getTime()) ? 'Snapshot atualizado em ' + generated.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : 'Snapshot oficial';
    const turnSummary = $('turn-summary');
    if (turnSummary) turnSummary.hidden = false;
    if (turnSummary) turnSummary.innerHTML = '<span>1º turno</span><strong>' + pct(pres1 && pres1.pst) + ' das seções totalizadas</strong><span class="summary-divider">·</span><span>2º turno</span><strong>' + pct(pres2 && pres2.pst) + ' das seções totalizadas</strong>';
    $('source-status').textContent = 'Fonte: snapshot TSE';
    $('load-error').hidden = true;
    updateWaiting(snapshot);
    applyPreferences();
  }
  function endpoint(kind, uf, stamp) {
    const id = '6258/dados/' + uf + '/' + uf + '-c0001-e006258-u.json';
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
      updateTseStrip();
    }
    async function get(url) {
      const response = await withTimeout(Promise.resolve().then(() => fetcher(url, { cache: 'no-store' })), timeoutMs, timers);
      if (!response || !response.ok) throw new Error('HTTP ' + (response && response.status));
      const result = parseResult(await withTimeout(response.json(), timeoutMs, timers));
      if (!validResult(result)) throw new Error('resultado inválido');
      return result;
    }
    async function refresh(force) {
      if (state.busy) return;
      // Backoff: depois de rodadas com maioria de erros (TSE lento/429/5xx), pula ciclos e mantém o último dado bom.
      if (!force && state.skip > 0) { state.skip -= 1; return; }
      state.busy = true;
      const jobs = [];
      PRESIDENT_UFS.forEach((uf) => jobs.push({ kind: 'pres', uf }));
      const stamp = now();
      const settled = await Promise.all(jobs.map(async (job) => {
        try { return { job, result: await get(endpoint(job.kind, job.uf, stamp)) }; }
        catch (error) { return { job, error }; }
      }));
      let reserve = null;
      if (settled.some((x) => x.error)) {
        try {
          // reserva 1: snapshot oficial gravado pelo vigia do box (branch dados, CDN do GitHub); reserva 2: snapshot do site
          for (const src of [DADOS_BASE + 'snapshot.json?t=' + Math.floor(stamp / 60000), 'data/snapshot.json?t=' + encodeURIComponent(stamp)]) {
            try {
              const response = await withTimeout(fetcher(src, { cache: 'no-store' }), timeoutMs, timers);
              const cand = response && response.ok ? await withTimeout(response.json(), timeoutMs, timers) : null;
              if (cand && cand.pres && cand.pres.r2 && (!reserve || (resultTime(cand.pres.r2.br) > resultTime(reserve.pres.r2.br)))) reserve = cand;
            } catch (_) { /* tenta a próxima reserva */ }
          }
          if (!reserve || !reserve.pres || !reserve.pres.r2) reserve = null;
        } catch (_) { reserve = null; }
      }
      const failures = new Set();
      const oldBrProgress = Number(state.snapshot.pres.r2.br && state.snapshot.pres.r2.br.pst) || 0;
      settled.forEach(({ job, result, error }) => {
        const key = 'pres';
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
      const errCount = settled.filter((x) => x.error).length;
      state.backoff = errCount > jobs.length / 2 ? Math.min(4, (state.backoff || 0) + 1) : 0;
      state.skip = state.backoff;
      if (errCount) { try { console.warn('TSE: ' + errCount + '/' + jobs.length + ' arquivos falharam; ' + (state.backoff ? 'próximas ' + state.backoff + ' checagens puladas' : 'mantendo último dado bom'), settled.filter((x) => x.error).slice(0, 3).map((x) => x.job.uf + ': ' + (x.error && x.error.message))); } catch (_) {} }
      if (settled.some((x) => x.job.kind === 'pres' && x.job.uf === 'br' && !x.error)) state.lastGood = now();  // idade do número principal (Brasil)
      state.failures = failures;
      state.source = failures.size === 0 && settled.every((x) => !x.error) ? 'live' : 'reserva';
      state.lastUpdated = now();
      if (settled.some((x) => x.job.kind === 'pres' && x.job.uf === 'br' && !x.error)) recordLiveSnapshot(state.snapshot, oldBrProgress);
      if (settled.some((x) => x.job.kind === 'pres' && x.job.uf === 'br' && !x.error)) observeAvisoLider(state.snapshot);
      try { render(state.snapshot, failures.size > 0); } catch (err) { console.error("render falhou", err && err.stack || err); }
      const toast = typeof document !== 'undefined' ? $('tse-toast') : null;
      if (toast) { toast.hidden = failures.size === 0; }
      status();
      state.busy = false;
      return state;
    }
    const initialRefresh = refresh(true);
    const interval = timers.setInterval(() => refresh(false), cadenceMs);
    if (typeof document !== 'undefined' && document.addEventListener) document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && now() - state.lastUpdated > cadenceMs) refresh(true); });
    return { state, refresh: () => refresh(true), initialRefresh, stop: () => timers.clearInterval(interval) };
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
    return '<article class="region-card"><div class="region-heading"><h3>' + name + '</h3><span>' + (waiting ? '1º turno' : pct(progress) + ' apurado') + '</span></div><p>Flávio<strong>' + pct(pa) + '</strong><br>Lula<strong>' + pct(pb) + '</strong></p>' + (waiting ? '' : '<small data-first-turn-comparison>Base bilateral 1º turno: Flávio ' + pct(firstBilateralA) + ' · Lula ' + pct(firstSum ? firstB * 100 / firstSum : NaN) + ' · Swing Flávio ' + displayOrDash(delta, (n) => (n > 0 ? '+' : '') + fmtPercent.format(n) + ' p.p.') + '</small><br>') + '<small>' + (seen ? fmtNumber.format(sum) + ' votos válidos · ' + (waiting ? '1º turno' : ufs.length + ' abrangência(s)') : 'Sem dados ainda') + '</small></article>';
  }
  function readHistory() {
    let local = [];
    try { const value = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); if (Array.isArray(value)) local = value; } catch (_) { /* storage opcional/corrompido */ }
    return mergeHistory(officialHistory, local).slice(-300);
  }
  function normalizeHistoryPoint(raw) {
    if (!raw || typeof raw !== 'object' || !Number.isFinite(Number(raw.pst))) return null;
    const br = raw.br && raw.br['22'] && raw.br['13'];
    const legacyA = Number(raw.a), legacyB = Number(raw.b);
    const a = br ? Number(raw.br['22'].p) : legacyA, b = br ? Number(raw.br['13'].p) : legacyB;
    const av = br && raw.br['22'].v != null ? Number(raw.br['22'].v) : NaN, bv = br && raw.br['13'].v != null ? Number(raw.br['13'].v) : NaN;
    if (!Number.isFinite(a) || !Number.isFinite(b) || a < 0 || a > 100 || b < 0 || b > 100) return null;
    const time = raw.t || raw.at || '';
    const at = Number.isFinite(Number(raw.at)) ? Number(raw.at) : (time ? Date.parse(time) : 0);
    const ufs = raw.ufs && typeof raw.ufs === 'object' && !Array.isArray(raw.ufs) ? raw.ufs : null;
    const normalizedUfs = ufs && Object.fromEntries(Object.entries(ufs).filter(([uf, v]) => /^[a-z]{2}$/.test(uf) && v && Number.isFinite(Number(v.pst)) && Number.isFinite(Number(v['22p'])) && Number.isFinite(Number(v['13p']))).map(([uf, v]) => [uf, { pst: Number(v.pst), a: Number(v['22p']), b: Number(v['13p']) }]));
    return { at, pst: Number(raw.pst), a, b, av: Number.isFinite(av) ? av : null, bv: Number.isFinite(bv) ? bv : null, t: time, dg: raw.dg || '', hg: raw.hg || '', ufs: normalizedUfs && Object.keys(normalizedUfs).length ? normalizedUfs : null, legacy: !br };
  }
  function mergeHistory(...collections) {
    const byPst = new Map();
    collections.flat().forEach((raw) => {
      const point = normalizeHistoryPoint(raw); if (!point) return;
      const old = byPst.get(point.pst);
      if (!old) { byPst.set(point.pst, point); return; }
      const newer = point.at >= old.at ? point : old, other = newer === point ? old : point;
      byPst.set(point.pst, newer.ufs || !other.ufs ? newer : Object.assign({}, newer, { ufs: other.ufs }));
    });
    return Array.from(byPst.values()).sort((a, b) => a.pst - b.pst || a.at - b.at).slice(-300);
  }
  async function loadOfficialHistory(fetcher) {
    try {
      let best = [];
      for (const src of [typeof DADOS_BASE === 'string' ? DADOS_BASE + 'serie.json?t=' + Math.floor(Date.now() / 60000) : null, 'data/serie.json']) {
        if (!src) continue;
        try {
          const response = await fetcher(src, { cache: 'no-store' });
          const data = response && response.ok ? await response.json() : null;
          if (Array.isArray(data) && data.length > best.length) best = data;
        } catch (_) { /* tenta a próxima fonte */ }
      }
      return best;
    } catch (_) { return []; }
  }
  function recordLiveSnapshot(snapshot, previousPst) {
    const br = snapshot.pres.r2.br, a = candidateByNumber(br, '22'), b = candidateByNumber(br, '13');
    if (!br || !a || !b || Number(br.vv) <= 0 || Number(br.pst) <= 0) return;
    const point = { at: Date.now(), pst: Number(br.pst), a: Number(a.p), b: Number(b.p), dg: br.dg || '', hg: br.hg || '' };
    const points = readHistory();
    const last = points[points.length - 1];
    if (!last || last.pst !== point.pst || last.a !== point.a || last.b !== point.b) points.push(point);
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(mergeHistory(points).slice(-300))); } catch (_) { /* storage opcional */ }
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
      if (!points.length) chart.innerHTML = '<p class="history-empty">O gráfico começa com a apuração.</p>';
      else {
        const coords = (key) => points.map((p) => (Math.max(0, Math.min(100, p.pst)) * 6) + ',' + (110 - Math.max(0, Math.min(100, p[key]))));
        chart.innerHTML = '<svg class="timeline-svg" viewBox="0 0 600 130" role="img" aria-label="Percentuais dos candidatos ao longo da apuração"><path d="M0 10H600M0 60H600M0 110H600" class="chart-grid"/><polyline points="' + coords('a').join(' ') + '" class="chart-flavio"/><polyline points="' + coords('b').join(' ') + '" class="chart-lula"/>' + points.map((p) => '<circle cx="' + (p.pst * 6) + '" cy="' + (110 - p.a) + '" r="2.5" class="dot-flavio"/><circle cx="' + (p.pst * 6) + '" cy="' + (110 - p.b) + '" r="2.5" class="dot-lula"/>').join('') + '</svg><div class="chart-legend"><span>Flávio</span><span>Lula</span><span>Diferença: ' + fmtPercent.format(points[points.length - 1].a - points[points.length - 1].b) + ' p.p.</span></div>';
      }
    }
    const scrubber = $('timeline-scrubber'), liveButton = $('timeline-live'), state = $('timeline-state');
    if (scrubber) { scrubber.max = String(Math.max(0, points.length - 1)); scrubber.disabled = points.length === 0; scrubber.value = String(replayIndex == null ? Math.max(0, points.length - 1) : Math.min(replayIndex, points.length - 1)); }
    if (liveButton) liveButton.disabled = replayIndex == null || !liveSnapshot;
    if (state) state.textContent = !points.length ? 'A linha do tempo começa às 17h.' : replayIndex == null ? 'Ao vivo · ' + points.length + ' pontos observados' : 'Snapshot histórico · ' + pct(points[replayIndex].pst) + ' das seções · ' + (points[replayIndex].ufs ? 'mapa histórico disponível' : 'mapa histórico indisponível');
    const score = $('timeline-score');
    if (score) {
      if (replayIndex == null || !points.length) { score.hidden = true; score.innerHTML = ''; }
      else { const p = points[Math.min(replayIndex, points.length - 1)], total = p.av != null && p.bv != null ? '<p>Votos válidos: ' + fmtNumber.format(p.av + p.bv) + '</p>' : '';
        score.hidden = false; score.innerHTML = '<strong>Placar histórico · ' + pct(p.pst) + ' apurado</strong><p>Flávio ' + (p.av == null ? 'votos indisponíveis' : fmtNumber.format(p.av) + ' votos') + ' · ' + pct(p.a) + '</p><p>Lula ' + (p.bv == null ? 'votos indisponíveis' : fmtNumber.format(p.bv) + ' votos') + ' · ' + pct(p.b) + '</p><p>Diferença: ' + (p.av != null && p.bv != null ? fmtNumber.format(Math.abs(p.av - p.bv)) + ' votos' : fmtPercent.format(Math.abs(p.a - p.b)) + ' p.p.') + '</p>' + total;
        if (p.ufs) paintHistoricalMap(p);
        else if (liveSnapshot) paintMap(liveSnapshot);
      }
    }
    const feedNode = $('updates-feed');
    if (feedNode) feedNode.innerHTML = feed.length ? feed.map((p) => '<li><time>' + safeText(p.hg || new Date(p.at).toLocaleTimeString('pt-BR', { hour:'2-digit', minute:'2-digit', timeZone:'America/Sao_Paulo' })) + '</time><span>+' + fmtPercent.format(p.pst) + '% seções</span><small>Flávio ' + pct(p.a) + ' · Lula ' + pct(p.b) + '</small></li>').join('') : '<li class="history-empty">As atualizações recebidas aparecerão aqui.</li>';
  }
  function paintHistoricalMap(point) {
    const host = $('uf-map'); if (!host || !liveSnapshot) return;
    paintMap(liveSnapshot).then(() => {
      if (replayIndex == null || !host.querySelectorAll) return;
      host.querySelectorAll('path[id]').forEach((path) => {
        const uf = path.id.toLowerCase(), record = point.ufs && point.ufs[uf];
        if (!record) { path.style.setProperty('--uf-fill', '#454963'); path.setAttribute('aria-label', UF_NAMES[uf] + ', sem dado neste snapshot histórico'); return; }
        const delta = record.a - record.b, fill = Math.abs(delta) < .05 ? '#8171bb' : delta > 0 ? 'rgba(49,193,232,.75)' : 'rgba(255,108,126,.75)';
        path.style.setProperty('--uf-fill', fill);
        path.setAttribute('aria-label', UF_NAMES[uf] + ', histórico: Flávio ' + pct(record.a) + ', Lula ' + pct(record.b) + ', ' + pct(record.pst) + ' apurado');
      });
      const ext = $('uf-exterior');
      if (ext) { const z = point.ufs && point.ufs.zz; const button = ext.querySelector('[data-uf="zz"]'); if (button) { button.style.setProperty('--uf-fill', z ? (z.a >= z.b ? 'rgba(49,193,232,.75)' : 'rgba(255,108,126,.75)') : '#454963'); button.innerHTML = '<strong>🌐 Exterior (ZZ)</strong><span>' + (z ? 'Histórico · Flávio ' + pct(z.a) + ' · Lula ' + pct(z.b) : 'Sem dado neste snapshot') + '</span>'; } }
    });
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
      const [response, modelResponse, history] = await Promise.all([
        fetch('data/snapshot.json', { cache: 'no-store' }),
        fetch('data/modelo.json', { cache: 'no-store' }),
        loadOfficialHistory(fetch)
      ]);
      if (!response.ok) throw new Error('HTTP snapshot ' + response.status);
      if (!modelResponse.ok) throw new Error('HTTP modelo ' + modelResponse.status);
      const [snapshot, model] = await Promise.all([response.json(), modelResponse.json()]);
      officialHistory = Array.isArray(history) ? history : [];
      if (!model || !model.abrangencias || !model.nacional) throw new Error('Parâmetros estatísticos inválidos');
      electionModel = model;
      render(snapshot);
      observeAvisoLider(snapshot);
      const poller = startPolling(snapshot);
      pollState = poller.state; if (typeof fetch === 'function' && typeof setTimeout === 'function' && typeof window !== 'undefined' && window.location && /^https?:/.test(window.location.protocol)) { refreshBu(); try { refreshPu(); } catch (e) { console.warn('projeção por urna', e); } }
      document.addEventListener('click', (event) => { if (event.target.closest && event.target.closest('[data-tc-reset]')) closeUfDetail(false); });
      const timer = typeof setInterval === 'function' ? setInterval(() => {
        if (typeof document !== 'undefined' && $('pres-update')) {
          updateWaiting(poller.state.snapshot);
          updateTseStrip();
          const elapsed = Date.now() - poller.state.lastUpdated;
          $('pres-update').textContent = 'Última atualização TSE: ' + (poller.state.snapshot.pres.r2.br.dg || '—') + ' ' + (poller.state.snapshot.pres.r2.br.hg || '') + ' (Brasília) · atualiza em ' + Math.max(0, Math.ceil((REFRESH_MS - elapsed) / 1000)) + 's';
        }
      }, 1000) : null;
      void timer;
    } catch (error) {
      console.error('Falha ao carregar/renderizar:', error);
      $('source-status').textContent = 'Resultados indisponíveis';
      $('load-error').hidden = false;
      $('pres-cards').innerHTML = '';
      $('pres-regions').innerHTML = '';
    }
  }
  function setupTabs() {
    const analysisTabs = Array.from(document.querySelectorAll('[role="tab"][aria-controls^="analysis-"]'));
    const showAnalysis = (name) => {
      analysisTabs.forEach((tab) => {
        const active = tab.id === 'analysis-tab-' + name;
        tab.setAttribute('aria-selected', String(active)); tab.tabIndex = active ? 0 : -1;
        const panel = $(tab.getAttribute('aria-controls')); if (panel) panel.hidden = !active;
      });
      const settings = $('analysis-settings'); if (settings) settings.hidden = name !== 'settings';
      const section = $('analyses'); if (section && name !== 'settings') section.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
    openAnalysisPanel = (name) => {
      showAnalysis(name);
      const section = $('analyses'); if (section) section.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' });
      const settings = $('analysis-settings'); if (settings && name === 'settings') settings.hidden = false;
    };
    analysisTabs.forEach((tab) => tab.addEventListener('click', () => showAnalysis(tab.id.replace('analysis-tab-', ''))));
    document.querySelectorAll('[data-mobile-view]').forEach((button) => button.addEventListener('click', () => {
      const view = button.dataset.mobileView;
      document.querySelectorAll('[data-mobile-view]').forEach((item) => item.toggleAttribute('aria-current', item === button));
      if (view === 'map') window.scrollTo({ top: 0, behavior: 'smooth' });
      else if (view === 'explore') showAnalysis('regions');
      else if (view === 'results') showAnalysis('ufs');
      else showAnalysis('settings');
    }));
    analysisTabs.forEach((tab) => tab.addEventListener('keydown', (event) => {
      if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
      event.preventDefault(); const i = analysisTabs.indexOf(tab);
      const n = event.key === 'Home' ? 0 : event.key === 'End' ? analysisTabs.length - 1 : (i + (event.key === 'ArrowRight' ? 1 : analysisTabs.length - 1)) % analysisTabs.length;
      analysisTabs[n].focus(); analysisTabs[n].click();
    }));
    const scrubber = $('timeline-scrubber'), liveButton = $('timeline-live');
    if (scrubber) scrubber.addEventListener('input', () => { replayIndex = Number(scrubber.value); renderHistory(); });
    if (liveButton) liveButton.addEventListener('click', () => { replayIndex = null; if (liveSnapshot) render(liveSnapshot); else renderHistory(); });
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
  if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', () => { setupTabs(); setupUfControls(); setupPreferences(); setupDepthEffects(); setupAvisoTest(); loadInitial(); });
  if (typeof module !== 'undefined' && module.exports) module.exports = { sparkMarkup, avisoLider, avisoChance, render, UF_NAMES, num, parseResult, startPolling, endpoint, validResult, PRESIDENT_UFS, isAwaiting, countdownText, updateWaiting, COUNTING_START, candidateByNumber, comparisonData, presidentialComparison, projection, projectionMarkup, UF_ORDER, ufRows, sortUfRows, swingClass, ufDetail, ufTooltip, ufsMarkup, mapColor, mapLegend, crossesMilestone, shouldAnimateMilestone, chanceMarkup, puMarkup, normalizeHistoryPoint, mergeHistory, normalizePreferences, readPreferences, PREFERENCES_KEY, DEFAULT_PREFERENCES };
}());
