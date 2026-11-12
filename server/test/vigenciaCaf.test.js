import { test } from 'node:test';
import assert from 'node:assert/strict';
import { vencimientoCaf, mesesACuadrar, alertasVencimiento } from '../lib/sii/vigenciaCaf.js';

const hoy = new Date('2026-11-12T10:00:00');

test('solo facturas y notas (33, 56, 61) vencen a los 180 días', () => {
  assert.equal(vencimientoCaf(33, '2026-06-01'), '2026-11-28');
  assert.equal(vencimientoCaf(61, '2026-06-01'), '2026-11-28');
  assert.equal(vencimientoCaf(39, '2026-06-01'), null);
  assert.equal(vencimientoCaf(52, '2026-06-01'), null);
  assert.equal(vencimientoCaf(33, null), null);
});

test('meses a cuadrar: desde la autorización del CAF vigente más antiguo (mínimo 2, máximo 7)', () => {
  const cafs = [
    { tipo_sii: 33, fecha_autorizacion: '2026-06-20' }, // vigente hasta 2026-12-17
    { tipo_sii: 33, fecha_autorizacion: '2026-02-01' }, // vencido: no cuenta
    { tipo_sii: 39, fecha_autorizacion: '2025-01-01' }, // boletas: no vencen, no cuentan
  ];
  assert.deepEqual(mesesACuadrar(cafs, hoy), ['2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11']);
  assert.deepEqual(mesesACuadrar([], hoy), ['2026-10', '2026-11']);
  assert.deepEqual(mesesACuadrar([{ tipo_sii: 61, fecha_autorizacion: '2026-11-01' }], hoy), ['2026-10', '2026-11']);
});

test('alerta de folios por vencer con folios sin usar, y de vencidos', () => {
  const cafs = [
    { tipo_sii: 33, desde: 1201, hasta: 1500, fecha_autorizacion: '2026-06-01', sucursal: 'Casa' },  // vence 28-11: 16 días
    { tipo_sii: 61, desde: 1, hasta: 100, fecha_autorizacion: '2026-06-01', sucursal: 'Casa' },      // todo usado
    { tipo_sii: 56, desde: 1, hasta: 50, fecha_autorizacion: '2026-05-01', sucursal: 'Casa' },       // venció 28-10
    { tipo_sii: 33, desde: 1501, hasta: 1800, fecha_autorizacion: '2026-10-01', sucursal: 'Casa' },  // lejos de vencer
  ];
  const usado = { '33-1201': 1320, '61-1': 100, '56-1': 10 };
  const a = alertasVencimiento(cafs, (t, d) => usado[`${t}-${d}`] ?? null, { 33: 'Factura', 56: 'Nota de débito' }, hoy);
  assert.equal(a.length, 2);
  assert.equal(a[0].codigo, 'FOLIOS_POR_VENCER');
  assert.equal(a[0].sinUsar, 180);
  assert.equal(a[0].diasRestantes, 16);
  assert.equal(a[1].codigo, 'FOLIOS_VENCIDOS');
  assert.equal(a[1].sinUsar, 40);
});

test('factura no recibida con CAF vencido: "Folio vencido: anular en el SII"', async () => {
  const { marcarFoliosVencidos } = await import('../lib/sii/vigenciaCaf.js');
  const cafs = [
    { tipo_sii: 33, desde: 1, hasta: 100, fecha_autorizacion: '2026-01-10' },  // venció el 09-07-2026
    { tipo_sii: 33, desde: 101, hasta: 200, fecha_autorizacion: '2026-10-01' }, // vigente
    { tipo_sii: 39, desde: 1, hasta: 500, fecha_autorizacion: '2025-01-01' },   // boletas: no vencen
  ];
  const alertas = [
    { codigo: 'FALTA_EN_SII', tipoSii: 33, folio: 50, titulo: 'No está en el SII', motivo: 'No aparece en el RCV' },
    { codigo: 'FALTA_EN_SII', tipoSii: 33, folio: 150, titulo: 'No está en el SII' },
    { codigo: 'FALTA_EN_SII', tipoSii: 39, folio: 10, titulo: 'No está en el SII' },
    { codigo: 'SALTO_FOLIO', tipoSii: 33, folio: 60, folioHasta: 62, titulo: 'Folios sin emitir', motivo: 'Faltan 3 folios' },
    { codigo: 'MONTO_DISTINTO', tipoSii: 33, folio: 51, titulo: 'Monto no coincide' },
  ];
  marcarFoliosVencidos(alertas, cafs, hoy);
  assert.equal(alertas[0].titulo, 'Folio vencido: anular en el SII');
  assert.match(alertas[0].motivo, /venció el 09-07-2026.*anular el folio en el SII/);
  assert.equal(alertas[1].titulo, 'No está en el SII'); // CAF vigente: se puede reenviar
  assert.equal(alertas[2].titulo, 'No está en el SII'); // boleta: no vence
  assert.equal(alertas[3].titulo, 'Folios vencidos sin emitir: anular en el SII');
  assert.equal(alertas[4].titulo, 'Monto no coincide');
});
