const test = require('node:test'); const assert = require('node:assert');
global.window = global.window || {}; const { sparkMarkup } = require('../app.js');
test('sparkline: um ponto vira linha plana, nunca vazia', () => {
  const h = sparkMarkup([[1792950000, 31.1, 0]]);
  assert.match(h, /chance-spark/); assert.match(h, /apuração às 17h/); assert.match(h, /M0\.0 [\d.]+L300\.0/);
});
test('sparkline: Lula e Flávio espelhados', () => {
  const h = sparkMarkup([[1792958400, 30, 1], [1792962000, 60, 20]]);
  assert.match(h, /spark-lula" d="M0\.0 28\.0L300\.0 16\.0/); assert.match(h, /spark-flavio" d="M0\.0 12\.0L300\.0 24\.0/);
  assert.match(h, /Lula 60%, Flávio 40%/);
});
test('sparkline: sem pontos não quebra', () => { assert.strictEqual(sparkMarkup([]), ''); });
