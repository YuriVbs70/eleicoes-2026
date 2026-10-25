'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { avisoLider, avisoChance } = require('../app.js');

function sequence(fn, values) {
  let state = null;
  return values.map(value => {
    const before = state && JSON.stringify(state);
    const result = fn(state, value);
    if (state) assert.equal(JSON.stringify(state), before, 'não altera o estado recebido');
    state = result.state;
    return result.msg;
  });
}
const votes = (lula, flavio) => ({ lula, flavio });

test('o primeiro estado só inicializa, mesmo com liderança ou chance alta', () => {
  assert.equal(avisoLider(null, votes(60, 40)).msg, null);
  assert.equal(avisoChance(null, 95).msg, null);
  assert.equal(avisoChance(null, 5).msg, null);
});

test('virada exige duas atualizações e avisa uma vez, nos dois sentidos', () => {
  assert.deepEqual(sequence(avisoLider, [votes(60, 40), votes(40, 60), votes(40, 60), votes(40, 60), votes(60, 40), votes(60, 40)]),
    [null, null, 'Virada! Flávio passa à frente', null, null, 'Virada! Lula passa à frente']);
});

test('flapping de líder ou faixa nunca avisa', () => {
  assert.ok(sequence(avisoLider, Array.from({ length: 20 }, (_, i) => i % 2 ? votes(40, 60) : votes(60, 40))).every(msg => msg === null));
  assert.ok(sequence(avisoChance, [74, 91, 74, 91, 74, 91]).every(msg => msg === null));
});

test('margem abaixo de 0,1 p.p. não confirma e interrompe o debounce', () => {
  assert.deepEqual(sequence(avisoLider, [votes(60, 40), votes(49.98, 50.02), votes(49.98, 50.02), votes(40, 60), votes(49.98, 50.02), votes(40, 60)]),
    [null, null, null, null, null, null]);
  assert.deepEqual(sequence(avisoLider, [votes(60, 40), votes(4995, 5005), votes(4995, 5005)]),
    [null, null, 'Virada! Flávio passa à frente']);
});

test('zero e empate inicial não viram uma falsa virada', () => {
  assert.deepEqual(sequence(avisoLider, [votes(0, 0), votes(60, 40), votes(60, 40)]), [null, null, null]);
  assert.deepEqual(sequence(avisoLider, [votes(60, 40), votes(40, 60), votes(50, 50), votes(40, 60)]), [null, null, null, null]);
});

test('74 → 91 → 91 avisa só 90%, uma vez', () => {
  assert.deepEqual(sequence(avisoChance, [74, 91, 91, 91]), [null, null, 'Chance de Lula passa de 90%', null]);
  assert.deepEqual(sequence(avisoChance, [26, 9, 9, 9]), [null, null, 'Chance de Flávio passa de 90%', null]);
});

test('75% também precisa de duas observações, para os dois candidatos', () => {
  assert.deepEqual(sequence(avisoChance, [50, 75, 75, 75]), [null, null, 'Chance de Lula passa de 75%', null]);
  assert.deepEqual(sequence(avisoChance, [50, 25, 25, 25]), [null, null, 'Chance de Flávio passa de 75%', null]);
});

test('histerese evita novo aviso oscilando 89.5 ↔ 90.4 após entrar', () => {
  assert.deepEqual(sequence(avisoChance, [74, 91, 91, 89.5, 90.4, 89.5, 90.4, 90.4]),
    [null, null, 'Chance de Lula passa de 90%', null, null, null, null, null]);
  assert.ok(sequence(avisoChance, [95, 89.5, 90.4, 89.5, 90.4]).every(msg => msg === null));
  assert.ok(sequence(avisoChance, [80, 74.5, 75.4, 74.5, 75.4]).every(msg => msg === null));
});

test('queda não avisa e nova subida exige saída confirmada pela histerese', () => {
  assert.deepEqual(sequence(avisoChance, [95, 88, 88, 70, 70, 50, 50]), [null, null, null, null, null, null, null]);
  assert.deepEqual(sequence(avisoChance, [95, 88, 88, 91, 91]), [null, null, null, null, 'Chance de Lula passa de 90%']);
});
