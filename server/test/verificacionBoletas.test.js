import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verificarBoletas, requiereBarrido } from '../lib/sii/verificacionBoletas.js';

test('verifica todas las boletas con concurrencia limitada y conserva el orden', async () => {
  let activas = 0, maxActivas = 0;
  const boletas = Array.from({ length: 23 }, (_, i) => ({ folio: i + 1 }));
  const r = await verificarBoletas(boletas, async (b) => {
    activas++; maxActivas = Math.max(maxActivas, activas);
    await new Promise((res) => setTimeout(res, 2));
    activas--;
    return { codigo: b.folio === 7 ? 'FAU' : 'DOK' };
  }, { concurrencia: 4 });
  assert.equal(r.length, 23);
  assert.ok(maxActivas <= 4);
  assert.deepEqual(r.map((x) => x.boleta.folio), boletas.map((b) => b.folio));
  assert.deepEqual(r.filter((x) => x.codigo !== 'DOK').map((x) => x.boleta.folio), [7]);
});

test('barrido solo cuando sobran boletas en Sisgen o el monto no cuadra', () => {
  const base = { sisgenDocs: 100, sisgenMonto: 100000, siiDocs: 100, siiMonto: 100000 };
  assert.equal(requiereBarrido(base), false);
  assert.equal(requiereBarrido({ ...base, sisgenDocs: 102, sisgenMonto: 104500 }), true);
  // las ya confirmadas como no recibidas explican la diferencia
  assert.equal(requiereBarrido({ ...base, sisgenDocs: 102, sisgenMonto: 104500, conocidasDocs: 2, conocidasMonto: 4500 }), false);
  // queda una por encontrar
  assert.equal(requiereBarrido({ ...base, sisgenDocs: 102, sisgenMonto: 104500, conocidasDocs: 1, conocidasMonto: 2500 }), true);
  // misma cantidad, distinto monto
  assert.equal(requiereBarrido({ ...base, sisgenMonto: 101000 }), true);
  // el SII tiene más: se busca fuera de Sisgen, no aquí
  assert.equal(requiereBarrido({ ...base, siiDocs: 105, siiMonto: 120000 }), false);
});
