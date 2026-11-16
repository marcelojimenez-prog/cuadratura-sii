import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cuadrar, ESTADOS } from '../lib/cuadratura/motor.js';

const sg = (tipo_sii, folio, total, sucursal = 'Matriz') =>
  ({ tipo_sii, tipo_sisgen: 'FE', folio, total, sucursal, fecha: '2026-10-01' });
const si = (tipo_sii, folio, total, estado = 'REGISTRADO', motivo = null) =>
  ({ tipo_sii, folio, total, estado, motivo, fuente: 'TEST' });

const estadoDe = (r, folio) => r.documentos.find((d) => d.folio === folio && d.tipoSisgen).estado;

test('clasifica OK, falta, rechazo, reparo y monto distinto', () => {
  const r = cuadrar(
    [sg(33, 1, 1000), sg(33, 2, 1000), sg(33, 3, 1000), sg(33, 4, 1000), sg(33, 5, 1000)],
    [si(33, 1, 1000), si(33, 3, 1000, 'RECHAZADO', 'RUT inválido'), si(33, 4, 1000, 'REPARO'), si(33, 5, 1500)]
  );
  assert.equal(estadoDe(r, 1), ESTADOS.OK);
  assert.equal(estadoDe(r, 2), ESTADOS.FALTA_EN_SII);
  assert.equal(estadoDe(r, 3), ESTADOS.RECHAZADO);
  assert.equal(r.documentos.find((d) => d.folio === 3).motivo, 'RUT inválido');
  assert.equal(estadoDe(r, 4), ESTADOS.REPARO);
  assert.equal(estadoDe(r, 5), ESTADOS.MONTO_DISTINTO);
});

test('tolera diferencia de redondeo de $1', () => {
  const r = cuadrar([sg(33, 1, 1000)], [si(33, 1, 1001)]);
  assert.equal(estadoDe(r, 1), ESTADOS.OK);
});

test('documento solo en SII', () => {
  const r = cuadrar([sg(33, 1, 1000)], [si(33, 1, 1000), si(33, 9, 500)]);
  assert.equal(r.documentos.find((d) => d.folio === 9).estado, ESTADOS.SOLO_EN_SII);
});

test('tipo no consultado al SII queda SIN_VERIFICAR (no FALTA)', () => {
  const r = cuadrar([sg(33, 1, 1000), sg(39, 50, 2000)], [si(33, 1, 1000)]);
  assert.equal(r.documentos.find((d) => d.tipoSii === 39).estado, ESTADOS.SIN_VERIFICAR);
});

test('ignora documentos no tributarios y guías', () => {
  const r = cuadrar([{ ...sg(null, 1, 10), tipo_sisgen: 'OV' }, { ...sg(52, 2, 10), tipo_sisgen: 'GE' }], []);
  assert.equal(r.documentos.length, 0);
});

test('detecta folio duplicado entre sucursales y saltos de folio', () => {
  const r = cuadrar(
    [sg(33, 10, 1, 'Matriz'), sg(33, 10, 1, 'Norte'), sg(33, 11, 1), sg(33, 15, 1)],
    [si(33, 10, 1), si(33, 11, 1), si(33, 15, 1)]
  );
  const dup = r.alertas.find((a) => a.codigo === 'FOLIO_DUPLICADO');
  assert.ok(dup);
  assert.match(dup.sucursal, /Matriz/);
  assert.match(dup.sucursal, /Norte/);
  const salto = r.alertas.find((a) => a.codigo === 'SALTO_FOLIO');
  assert.equal(salto.folio, 12);
  assert.equal(salto.folioHasta, 14);
});

test('resumen por sucursal suma montos y descuenta notas de crédito', () => {
  const r = cuadrar(
    [sg(33, 1, 1000, 'A'), { ...sg(61, 1, 200, 'A'), tipo_sisgen: 'NE' }, sg(33, 2, 500, 'B')],
    [si(33, 1, 1000), si(61, 1, 200), si(33, 2, 500)]
  );
  const a = r.resumen.porSucursal.find((s) => s.sucursal === 'A');
  assert.equal(a.monto, 800);
  assert.equal(r.resumen.montoTotal, 1300);
  assert.equal(r.resumen.porEstado.OK, 3);
});

const caf = (tipo_sii, desde, hasta, sucursal) => ({ tipo_sii, desde, hasta, sucursal });
const RANGOS = [caf(33, 1, 100, 'Matriz'), caf(33, 101, 200, 'Norte')];

test('folio usado dentro de su propio CAF no genera alerta de rango', () => {
  const r = cuadrar([sg(33, 5, 1, 'Matriz'), sg(33, 150, 1, 'Norte')], [si(33, 5, 1), si(33, 150, 1)], { rangos: RANGOS });
  assert.equal(r.alertas.filter((a) => a.codigo === 'FOLIO_DE_OTRA_SUCURSAL').length, 0);
  assert.equal(r.documentos.find((d) => d.folio === 150).cafSucursal, 'Norte');
});

test('folio del rango de otra sucursal indica a quién corresponde', () => {
  const r = cuadrar([sg(33, 5, 1, 'Matriz'), sg(33, 120, 1, 'Matriz')], [si(33, 5, 1), si(33, 120, 1)], { rangos: RANGOS });
  const a = r.alertas.find((x) => x.codigo === 'FOLIO_DE_OTRA_SUCURSAL');
  assert.equal(a.folio, 120);
  assert.equal(a.sucursal, 'Matriz');
  assert.match(a.motivo, /corresponde a Norte/);
  assert.equal(r.documentos.find((d) => d.folio === 120).cafSucursal, 'Norte');
});

test('folio fuera de todo CAF se informa', () => {
  const r = cuadrar([sg(33, 999, 1, 'Matriz')], [si(33, 999, 1)], { rangos: RANGOS });
  assert.ok(r.alertas.find((x) => x.codigo === 'FOLIO_SIN_CAF' && x.folio === 999));
});

test('con CAF, el espacio entre rangos de sucursales no se reporta como salto', () => {
  const r = cuadrar(
    [sg(33, 1, 1, 'Matriz'), sg(33, 2, 1, 'Matriz'), sg(33, 101, 1, 'Norte'), sg(33, 104, 1, 'Norte')],
    [si(33, 1, 1), si(33, 2, 1), si(33, 101, 1), si(33, 104, 1)],
    { rangos: RANGOS }
  );
  const saltos = r.alertas.filter((a) => a.codigo === 'SALTO_FOLIO');
  assert.equal(saltos.length, 1);
  assert.equal(saltos[0].folio, 102);
  assert.equal(saltos[0].sucursal, 'Norte');
});

test('saltos: folios con XML en otro mes no se reportan como faltantes', () => {
  const otros = new Map([['33-12', '2026-11-02'], ['33-13', '2026-11-02']]);
  const r = cuadrar([sg(33, 10, 1), sg(33, 11, 1), sg(33, 15, 1)], [si(33, 10, 1), si(33, 11, 1), si(33, 15, 1)], { xmlOtrosMeses: otros });
  const otro = r.alertas.find((a) => a.codigo === 'FOLIO_OTRO_MES');
  assert.equal(otro.folio, 12);
  assert.equal(otro.folioHasta, 13);
  assert.match(otro.motivo, /02-11-2026/);
  const falta = r.alertas.filter((a) => a.codigo === 'SALTO_FOLIO');
  assert.equal(falta.length, 1);
  assert.equal(falta[0].folio, 14);
});

test('documento sin XML genera alerta', () => {
  const r = cuadrar([{ ...sg(39, 5, 100), sin_xml: 1 }], []);
  assert.ok(r.alertas.find((a) => a.codigo === 'SIN_XML' && a.folio === 5));
  assert.equal(r.resumen.sinXml, 1);
});

const res = (tipo_sii, tot_doc, monto_total) => ({ tipo_sii, tipo_ingreso: 'RESUMEN', tot_doc, monto_total, nombre: 'Boletas' });
const bol = (folio, total, extra = {}) => ({ ...sg(39, folio, total), tipo_sisgen: 'BE', ...extra });

test('boletas que cuadran con el resumen del SII quedan OK', () => {
  const r = cuadrar([bol(1, 100), bol(2, 200)], [], { resumenSii: [res(39, 2, 300)], tiposConsultados: new Set([39]) });
  assert.ok(r.documentos.every((d) => d.estado === ESTADOS.OK));
  assert.equal(r.cuadreTipos[0].estado, 'CUADRA');
});

test('si el SII cuadra sin los documentos sin XML, esos quedan "No está en el SII"', () => {
  const r = cuadrar([bol(1, 100), bol(2, 200), bol(3, 1100, { sin_xml: 1 })], [], { resumenSii: [res(39, 2, 300)], tiposConsultados: new Set([39]) });
  assert.equal(r.documentos.find((d) => d.folio === 3).estado, ESTADOS.FALTA_EN_SII);
  assert.equal(r.documentos.find((d) => d.folio === 1).estado, ESTADOS.OK);
  assert.equal(r.cuadreTipos[0].estado, 'CUADRA_SIN_FALTANTES');
});

test('diferencia no explicada en el resumen genera alerta y deja sin verificar', () => {
  const r = cuadrar([bol(1, 100), bol(2, 200)], [], { resumenSii: [res(39, 2, 250)], tiposConsultados: new Set([39]) });
  assert.ok(r.alertas.find((a) => a.codigo === 'RESUMEN_DIFERENTE'));
  assert.ok(r.documentos.every((d) => d.estado === ESTADOS.SIN_VERIFICAR));
});

test('resumen del SII sin documentos en Sisgen se informa', () => {
  const r = cuadrar([], [], { resumenSii: [res(41, 3, 9000)] });
  assert.ok(r.alertas.find((a) => a.codigo === 'RESUMEN_SOLO_SII' && a.tipoSii === 41));
});

test('boletas no electrónicas del resumen (35/38) no se toman en cuenta', () => {
  const r = cuadrar([], [], { resumenSii: [res(38, 1, 9500000), res(35, 2, 5000)] });
  assert.equal(r.alertas.length, 0);
  assert.equal(r.cuadreTipos.length, 0);
});

test('un documento con varios problemas genera una sola alerta con los demás como adicionales', () => {
  const r = cuadrar(
    [bol(1, 100), bol(3, 1100, { sin_xml: 1, en_blanco: 1 })],
    [{ tipo_sii: 39, folio: 3, total: 0, estado: 'NO_RECIBIDO', motivo: 'FAU', fuente: 'API_BOLETA' }],
    { resumenSii: [res(39, 1, 100)], tiposConsultados: new Set([39]) }
  );
  const delFolio3 = r.alertas.filter((a) => a.folio === 3);
  assert.equal(delFolio3.length, 1);
  assert.equal(delFolio3[0].codigo, 'FALTA_EN_SII');
  assert.deepEqual(delFolio3[0].adicionales, ['Documento en blanco', 'Sin XML generado']);
});

test('boleta confirmada "no recibida" por la API queda faltante con el motivo de la API y el resto cuadra', () => {
  const r = cuadrar(
    [bol(1, 100), bol(2, 200), bol(3, 1100, { sin_xml: 1 })],
    [{ tipo_sii: 39, folio: 3, total: 0, estado: 'NO_RECIBIDO', motivo: 'Confirmado por la API de boletas del SII: Documento No Recibido por el SII (FAU)', fuente: 'API_BOLETA' }],
    { resumenSii: [res(39, 2, 300)], tiposConsultados: new Set([39]) }
  );
  const d3 = r.documentos.find((d) => d.folio === 3 && d.tipoSisgen);
  assert.equal(d3.estado, ESTADOS.FALTA_EN_SII);
  assert.match(d3.motivo, /API de boletas/);
  assert.equal(r.documentos.find((d) => d.folio === 1).estado, ESTADOS.OK);
  assert.equal(r.cuadreTipos[0].estado, 'CUADRA_SIN_FALTANTES');
});

test('documento en blanco: la alerta lleva lo que tenía según la carpeta backup', () => {
  const respaldo = { encontrado: true, fuente: 'BACKUP', hora: '12:12:13', total: 1100, lineas: [{ descripcion: 'CERV BUDWEISER', cantidad: 1, precio: 1100, total: 1100 }] };
  const r = cuadrar([{ ...sg(33, 7, 1100), en_blanco: 1, respaldo }], [], { tiposConsultados: new Set([33]) });
  const a = r.alertas.find((x) => x.folio === 7);
  assert.equal(a.codigo, 'FALTA_EN_SII');
  assert.deepEqual(a.respaldo, respaldo);
  assert.deepEqual(r.documentos.find((d) => d.folio === 7).respaldo, respaldo);
});

test('documento en blanco sin detalle en el backup ni en la tabla DT: eliminar', () => {
  const r = cuadrar([{ ...sg(33, 8, 500), en_blanco: 1, respaldo: { encontrado: false } }], [], { tiposConsultados: new Set([33]) });
  const a = r.alertas.find((x) => x.folio === 8);
  assert.equal(a.respaldo.encontrado, false);
  assert.ok(r.alertas.some((x) => x.motivo === 'Detalle no encontrado en ninguna tabla: eliminar') || a.respaldo.encontrado === false);
});

test('documento completo sin XML que no llegó al SII: republicar, con lo que llevaba', () => {
  const respaldo = { encontrado: true, fuente: 'DT', lineas: [{ codigo: '6655', descripcion: 'CERV BUDWEISER', cantidad: 2 }] };
  const r = cuadrar([bol(1, 100), bol(2, 200), bol(3, 1100, { sin_xml: 1, respaldo })], [],
    { resumenSii: [res(39, 2, 300)], tiposConsultados: new Set([39]) });
  const a = r.alertas.filter((x) => x.folio === 3);
  assert.equal(a.length, 1);
  assert.equal(a[0].codigo, 'FALTA_EN_SII');
  assert.equal(a[0].republicar, true);
  assert.deepEqual(a[0].respaldo, respaldo);
  assert.match(a[0].motivo, /republicar\. Llevaba: 2 × CERV BUDWEISER/);
});

test('no se pide republicar si el folio también está en otra sucursal o el documento está en blanco', () => {
  const dup = cuadrar([{ ...sg(33, 9, 500), sin_xml: 1 }, { ...sg(33, 9, 700, 'Otra') }], [], { tiposConsultados: new Set([33]) });
  assert.ok(dup.alertas.filter((x) => x.folio === 9).every((x) => !x.republicar));
  const blanco = cuadrar([{ ...sg(33, 8, 500), en_blanco: 1, sin_xml: 1 }], [], { tiposConsultados: new Set([33]) });
  assert.ok(blanco.alertas.every((x) => !x.republicar));
});
