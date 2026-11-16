import { test } from 'node:test';
import assert from 'node:assert/strict';
import { documentoDeCodmat, armarRespaldo, armarDesdeDt } from '../lib/sisgen/respaldo.js';

test('CODMAT del respaldo: tipo + folio', () => {
  assert.deepEqual(documentoDeCodmat('BE001124718'), ['BE', 1124718]);
  assert.deepEqual(documentoDeCodmat(' bx000000123 '), ['BX', 123]);
  assert.equal(documentoDeCodmat('6655'), null);
});

test('arma lo que llevaba el documento: hora, cliente, líneas y total', () => {
  const r = armarRespaldo([
    { CODIGO: '1', DESCRI: 'CERVEZA', OBSERV: '12:12:13  99999999-9', CANTID: 2, PRECIO: 1000, DESCTO: 0, MTOTAL: 2000 },
    { CODIGO: '2', DESCRI: 'HIELO', OBSERV: '12:12:13  99999999-9', CANTID: 1, PRECIO: 500, DESCTO: 0, MTOTAL: 500 },
  ], '20261009.dbf');
  assert.equal(r.encontrado, true);
  assert.equal(r.hora, '12:12:13');
  assert.equal(r.rutCliente, '99999999-9');
  assert.equal(r.total, 2500);
  assert.equal(r.lineas.length, 2);
  assert.deepEqual(armarRespaldo([], null), { encontrado: false });
});

test('tabla DT: código, producto y cantidad (sin precio de venta)', () => {
  const r = armarDesdeDt([
    { TIPO: 'BE', NUMERO: '001700007', CODPRO: '1516', DESCRI: 'BEB COCA-COLA ORIGINAL DES  591CC X6', SALE: 1 },
    { TIPO: 'BE', NUMERO: '001700007', CODPRO: '1468', DESCRI: 'CERV HEINEKEN LATA 470CC', SALE: 2 },
  ], 'DT102026.DBF');
  assert.equal(r.encontrado, true);
  assert.equal(r.fuente, 'DT');
  assert.deepEqual(r.lineas.map((l) => [l.codigo, l.cantidad, l.precio]), [['1516', 1, null], ['1468', 2, null]]);
  assert.deepEqual(armarDesdeDt([], null), { encontrado: false });
});
