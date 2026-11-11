import { test } from 'node:test';
import assert from 'node:assert/strict';
import { huecosCaf, detectarFoliosExternos, existenciaDesdeCodigo, RECIBIDO, AUTORIZADO, NO_AUTORIZADO } from '../lib/sii/foliosExternos.js';
import { cuadrar } from '../lib/cuadratura/motor.js';

test('huecos entre CAF, con CAF intercalados y tramo final abierto', () => {
  const h = huecosCaf([
    { desde: 1, hasta: 100, sucursal: 'A' },
    { desde: 301, hasta: 400, sucursal: 'B' },
    { desde: 101, hasta: 200, sucursal: 'B' },
  ]);
  assert.deepEqual(h, [
    { desde: 201, hasta: 300, antes: 'B', despues: 'B' },
    { desde: 401, hasta: null, antes: 'B', despues: null },
  ]);
});

test('códigos de la API de boletas', () => {
  assert.equal(existenciaDesdeCodigo('DNK'), RECIBIDO);
  assert.equal(existenciaDesdeCodigo('DOK'), RECIBIDO);
  assert.equal(existenciaDesdeCodigo('FAU'), AUTORIZADO);
  assert.equal(existenciaDesdeCodigo('FNA'), NO_AUTORIZADO);
  assert.equal(existenciaDesdeCodigo('XYZ'), null);
});

// SII simulado: folios recibidos = conjunto de intervalos; autorizados hasta `maxAutorizado`
const siiSimulado = (recibidos, maxAutorizado) => async (f) =>
  recibidos.some(([a, b]) => f >= a && f <= b) ? RECIBIDO : f <= maxAutorizado ? AUTORIZADO : NO_AUTORIZADO;

test('detecta un CAF ajeno en uso e ignora uno antiguo agotado', async () => {
  const huecos = [
    { desde: 201, hasta: 300, antes: 'A', despues: 'B' },  // agotado entero (meses anteriores)
    { desde: 501, hasta: 600, antes: 'B', despues: 'C' },  // en uso hasta 537
    { desde: 801, hasta: null, antes: 'C', despues: null }, // sobre el último CAF: nada
  ];
  const b = await detectarFoliosExternos(huecos, siiSimulado([[201, 300], [501, 537]], 900));
  assert.deepEqual(b, [{ desde: 501, ultimo: 537, cantidad: 37, antes: 'B', despues: 'C' }]);
});

test('detecta folios recibidos sobre el último CAF conocido', async () => {
  const b = await detectarFoliosExternos([{ desde: 1001, hasta: null, antes: 'C', despues: null }], siiSimulado([[1001, 1450]], 2000));
  assert.deepEqual(b, [{ desde: 1001, ultimo: 1450, cantidad: 450, antes: 'C', despues: null }]);
});

test('el motor alerta boletas emitidas fuera de Sisgen cuando el SII tiene más', () => {
  const docs = [1, 2, 3].map((f) => ({ tipo_sii: 39, tipo_sisgen: 'BE', folio: f, total: 1000, sucursal: 'A', fecha: '2026-10-01' }));
  const r = cuadrar(docs, [], {
    resumenSii: [{ tipo_sii: 39, tipo_ingreso: 'RESUMEN', tot_doc: 5, monto_total: 5000, nombre: 'Boleta' }],
    foliosExternos: [{ tipo_sii: 39, desde: 501, ultimo: 537, cantidad: 37, caf_antes: 'A', caf_despues: 'B' }],
  });
  const a = r.alertas.find((x) => x.codigo === 'FOLIOS_FUERA_DE_SISGEN');
  assert.ok(a);
  assert.equal(a.folio, 501);
  assert.equal(a.folioHasta, 537);
  assert.match(a.motivo, /entre los CAF de A y B/);
  assert.equal(r.cuadreTipos.find((t) => t.tipoSii === 39).foliosExternos, 37);
});
