import { test } from 'node:test';
import assert from 'node:assert/strict';
import { abrirDb, guardarEmpresa, guardarSucursal, reemplazarDocsSisgen } from '../db.js';

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
