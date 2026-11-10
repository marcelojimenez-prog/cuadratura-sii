import { test } from 'node:test';
import assert from 'node:assert/strict';
import { consolidar } from '../lib/sisgen/importar.js';

const f1 = (tipoSisgen, folio, total = 1000) => ({ tipoSisgen, tipoSii: 33, folio, total, fecha: '2026-10-05' });
const buscar = (docs, tipo, folio) => docs.find((d) => d.tipoSisgen === tipo && d.folio === folio);

test('documento en F1 con detalle en F2 no queda en blanco', () => {
  const docs = consolidar({ f1: [f1('FE', 10)], detalle: new Set(['FE-10']), clidocto: [], clipagos: [] });
  assert.equal(buscar(docs, 'FE', 10).enBlanco, false);
});

test('documento en F1 sin detalle en F2 queda en blanco', () => {
  const docs = consolidar({ f1: [f1('FE', 10), f1('FE', 11)], detalle: new Set(['FE-10']), clidocto: [], clipagos: [] });
  assert.equal(buscar(docs, 'FE', 11).enBlanco, true);
});

test('no marca en blanco un tipo que nunca tiene detalle en F2 ese mes', () => {
  const docs = consolidar({ f1: [f1('FE', 10), { ...f1('BE', 500), tipoSii: 39 }], detalle: new Set(['FE-10']), clidocto: [], clipagos: [] });
  assert.equal(buscar(docs, 'BE', 500).enBlanco, false);
});

test('documento que no está en F1 pero sí en CLIDOCTO se agrega en blanco con su monto', () => {
  const docs = consolidar({
    f1: [f1('FE', 10)], detalle: new Set(['FE-10']),
    clidocto: [{ tipoSisgen: 'FE', folio: 12, fecha: '2026-10-08', rut: '76.123.456-7', nombre: 'CLIENTE', monto: 5000 }],
    clipagos: [],
  });
  const d = buscar(docs, 'FE', 12);
  assert.equal(d.enBlanco, true);
  assert.equal(d.total, 5000);
  assert.equal(d.tipoSii, 33);
  assert.equal(d.rutReceptor, '76123456-7');
});

test('CLIPAGOS agrega documentos solo dentro del rango de folios del mes', () => {
  const docs = consolidar({
    f1: [f1('FE', 10), f1('FE', 20)], detalle: new Set(['FE-10', 'FE-20']), clidocto: [],
    clipagos: [
      { tipoSisgen: 'FE', folio: 15, rut: '1-9', monto: 700 },  // dentro del rango: se agrega
      { tipoSisgen: 'FE', folio: 3, rut: '1-9', monto: 900 },   // pago de un documento antiguo: se ignora
    ],
  });
  assert.equal(buscar(docs, 'FE', 15).enBlanco, true);
  assert.equal(buscar(docs, 'FE', 3), undefined);
});

const idx = (...pares) => new Map(pares.map(([t, f, extra = {}]) => [`${t}-${f}`, { tipoSii: t, folio: f, fecha: '2026-10-15', ...extra }]));

test('registro en F1 sin XML queda marcado sinXml; con XML no', () => {
  const docs = consolidar({ f1: [f1('FE', 10), f1('FE', 11)], detalle: null, clidocto: [], clipagos: [], xml: idx([33, 10]) });
  assert.equal(buscar(docs, 'FE', 10).sinXml, false);
  assert.equal(buscar(docs, 'FE', 11).sinXml, true);
});

test('XML sin registro en Sisgen se agrega como documento en blanco con datos del XML', () => {
  const docs = consolidar({
    f1: [f1('FE', 10)], detalle: null, clidocto: [], clipagos: [],
    xml: idx([33, 10], [61, 36528, { total: 45000, rutReceptor: '76.123.456-7', nombreReceptor: 'CLIENTE' }]),
  });
  const nc = buscar(docs, 'NE', 36528);
  assert.equal(nc.enBlanco, true);
  assert.equal(nc.tipoSii, 61);
  assert.equal(nc.total, 45000);
  assert.equal(nc.rutReceptor, '76123456-7');
});

test('sin índice de XML no se marca nada como sinXml', () => {
  const docs = consolidar({ f1: [f1('FE', 10)], detalle: null, clidocto: [], clipagos: [] });
  assert.ok(!buscar(docs, 'FE', 10).sinXml);
});
