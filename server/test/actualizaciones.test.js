import { test } from 'node:test';
import assert from 'node:assert/strict';
import { actualizacionPara, compararVersiones } from '../actualizaciones.js';

const m = { version: '1.6.1', sha256: 'ab', firma: 'x', archivo: 'SisgenAgente-1.6.1.exe', agentes: [3] };

test('compara versiones por número', () => {
  assert.equal(compararVersiones('1.10.0', '1.9.9'), 1);
  assert.equal(compararVersiones('1.6', '1.6.0'), 0);
  assert.equal(compararVersiones('1.5.0', '1.6.0'), -1);
});

test('se ofrece solo al agente piloto y solo si tiene una versión más antigua', () => {
  assert.deepEqual(actualizacionPara(3, '1.6.0', m), { version: '1.6.1', sha256: 'ab', firma: 'x' });
  assert.equal(actualizacionPara(4, '1.6.0', m), null);   // no está en la lista
  assert.equal(actualizacionPara(3, '1.6.1', m), null);   // ya la tiene
  assert.equal(actualizacionPara(3, '1.5.0', m), null);   // no sabe actualizarse
  assert.ok(actualizacionPara(4, '1.6.0', { ...m, agentes: 'todos' }));
  assert.equal(actualizacionPara(3, '1.6.0', null), null);
});
