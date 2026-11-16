import { test } from 'node:test';
import assert from 'node:assert/strict';
import { abrirDb, guardarEmpresa, guardarSucursal, reemplazarDocsSisgen, guardarDocsSii } from '../db.js';

abrirDb(':memory:');
const { ajustarOtrosMeses } = await import('../lib/cuadratura/resumen.js');

test('factura de octubre con XML regenerado en noviembre: no es "sin XML" ni "en blanco" de noviembre', () => {
  guardarEmpresa({ rut: '11111111-1', razonSocial: 'Empresa A' });
  const s = guardarSucursal({ rutEmpresa: '11111111-1', codigo: 'A', nombre: 'Sucursal A' });
  const doc = (folio, extra = {}) => ({ rutEmisor: '11111111-1', tipoSisgen: 'FE', tipoSii: 33, folio, fecha: '2026-10-20', total: 1000, ...extra });
  reemplazarDocsSisgen(s, '2026-10', [doc(169501, { sinXml: true }), doc(169500)]);
  reemplazarDocsSisgen(s, '2026-11', [doc(169501, { enBlanco: true, fecha: '2026-11-11' }), doc(169600, { enBlanco: true })]);

  const fila = (folio, extra = {}) => ({ tipo_sii: 33, folio, en_blanco: 0, sin_xml: 0, ...extra });
  // octubre: el XML de 169501 está en la carpeta de noviembre
  const oct = ajustarOtrosMeses('11111111-1', '2026-10', [fila(169501, { sin_xml: 1 }), fila(169500)], new Map([['33-169501', '2026-11-11']]));
  assert.equal(oct.find((d) => d.folio === 169501).sin_xml, 0);
  // noviembre: 169501 está registrada en octubre (se quita); 169600 sigue en blanco
  const nov = ajustarOtrosMeses('11111111-1', '2026-11', [fila(169501, { en_blanco: 1 }), fila(169600, { en_blanco: 1 })], new Map());
  assert.deepEqual(nov.map((d) => d.folio), [169600]);
});

test('respuesta del SII según el Track ID que anota DTESERVICE', async () => {
  const { respuestaEnvio } = await import('../lib/cuadratura/motor.js');
  assert.equal(respuestaEnvio({ track_id: '1', estado_sii: 'EPR', detalle_sii: 'Aceptado' }), 'aceptado');
  assert.equal(respuestaEnvio({ track_id: '1', estado_sii: 'DOK', detalle_sii: 'Aceptado' }), 'aceptado');
  assert.equal(respuestaEnvio({ track_id: '1', estado_sii: 'EPR', detalle_sii: 'Rechazado' }), 'rechazado');
  assert.equal(respuestaEnvio({ track_id: '1', estado_sii: 'RCT' }), 'rechazado');
  assert.equal(respuestaEnvio({ track_id: '1', estado_sii: '' }), 'pendiente');
  assert.equal(respuestaEnvio({ track_id: '' }), null);
});

test('factura aceptada según Track ID pero aún no en el Registro de Ventas: no es alerta', async () => {
  const { cuadrar } = await import('../lib/cuadratura/motor.js');
  const doc = { tipo_sii: 33, tipo_sisgen: 'FE', folio: 15911, fecha: '2026-11-12', total: 47588, sucursal: 'Casa' };
  const r = cuadrar([doc], [], { tiposConsultados: new Set([33]),
    envios: new Map([['33-15911', { track_id: '12684144314', estado_sii: 'EPR', detalle_sii: 'Aceptado' }]]) });
  assert.equal(r.documentos[0].estado, 'OK');
  assert.ok(!r.alertas.some((a) => a.folio === 15911));
  const sinEnvio = cuadrar([doc], [], { tiposConsultados: new Set([33]) });
  assert.equal(sinEnvio.documentos[0].estado, 'FALTA_EN_SII');
});

test('factura guardada en las tablas de octubre con fecha de noviembre, y en blanco en noviembre: es de noviembre', () => {
  guardarEmpresa({ rut: '22222222-2', razonSocial: 'Empresa B' });
  const s = guardarSucursal({ rutEmpresa: '22222222-2', codigo: 'B', nombre: 'Sucursal B' });
  const doc = (folio, extra = {}) => ({ rutEmisor: '22222222-2', tipoSisgen: 'FE', tipoSii: 33, folio, fecha: '2026-11-02', total: 412480, ...extra });
  reemplazarDocsSisgen(s, '2026-10', [doc(165539, { sinXml: true }), doc(165000, { fecha: '2026-10-30' })]);
  reemplazarDocsSisgen(s, '2026-11', [doc(165539, { enBlanco: true, sinXml: true })]);

  const fila = (folio, extra = {}) => ({ tipo_sii: 33, folio, en_blanco: 0, sin_xml: 0, fecha: '2026-11-02', ...extra });
  // octubre: la copia con fecha de noviembre no se cuenta (no pide "republicar")
  const oct = ajustarOtrosMeses('22222222-2', '2026-10', [fila(165539, { sin_xml: 1 }), fila(165000, { fecha: '2026-10-30' })], new Map());
  assert.deepEqual(oct.map((d) => d.folio), [165000]);
  // noviembre: sigue como documento en blanco (no se descarta por la copia de octubre)
  const nov = ajustarOtrosMeses('22222222-2', '2026-11', [fila(165539, { en_blanco: 1, sin_xml: 1 })], new Map());
  assert.deepEqual(nov.map((d) => d.folio), [165539]);
});

test('nota de crédito de septiembre en blanco en las tablas de octubre y aceptada por el SII en septiembre: no se cuenta en octubre', () => {
  guardarEmpresa({ rut: '33333333-3', razonSocial: 'Empresa C' });
  const s = guardarSucursal({ rutEmpresa: '33333333-3', codigo: 'C', nombre: 'Sucursal C' });
  reemplazarDocsSisgen(s, '2026-10', [
    { rutEmisor: '33333333-3', tipoSisgen: 'NE', tipoSii: 61, folio: 36528, fecha: '2026-09-16', total: 853502, enBlanco: true },
    { rutEmisor: '33333333-3', tipoSisgen: 'NE', tipoSii: 61, folio: 36700, fecha: '2026-09-20', total: 100, enBlanco: true },
  ]);
  guardarDocsSii([{ rutEmisor: '33333333-3', periodo: '2026-09', tipoSii: 61, folio: 36528, fecha: '2026-09-16', total: 853502, estado: 'REGISTRADO', fuente: 'RCV' }]);
  const fila = (folio, fecha) => ({ tipo_sii: 61, folio, fecha, en_blanco: 1, sin_xml: 0 });
  const oct = ajustarOtrosMeses('33333333-3', '2026-10', [fila(36528, '2026-09-16'), fila(36700, '2026-09-20')], new Map());
  // 36528 está en el SII en septiembre: se va a septiembre. 36700 no está en el SII: sigue avisándose aquí.
  assert.deepEqual(oct.map((d) => d.folio), [36700]);
});
