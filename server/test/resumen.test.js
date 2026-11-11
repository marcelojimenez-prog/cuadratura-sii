import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filaCliente, gravedadEmpresa, numeroRut } from '../lib/cuadratura/resumen.js';

test('numeroRut ordena de menor a mayor sin importar el formato', () => {
  const ruts = ['76000000-0', '9876543-2', '12345678-5'];
  assert.deepEqual(ruts.sort((a, b) => numeroRut(a) - numeroRut(b)), ['9876543-2', '12345678-5', '76000000-0']);
});

test('el estado del cliente es el de su razón social más grave', () => {
  const ok = { rut: '2-7', documentos: 10, ok: 10, alertas: 0, urgentes: 0, siiConsultadoEn: 'x', montoTotal: 100 };
  const mal = { rut: '1-9', documentos: 5, ok: 3, alertas: 2, urgentes: 1, siiConsultadoEn: 'x', montoTotal: 50, conProblemas: 2 };
  assert.equal(gravedadEmpresa(ok), 'ok');
  const f = filaCliente({ id: 1 }, [ok, mal], [
    { ultimaLectura: '2026-11-10 10:00:00', desactualizada: false },
    { ultimaLectura: '2026-11-01 10:00:00', desactualizada: true },
  ]);
  assert.equal(f.estado, 'urgente');
  assert.equal(f.rutMenor, '1-9');
  assert.equal(f.montoTotal, 150);
  assert.equal(f.sucursalesDesactualizadas, 1);
  assert.equal(f.lecturaMasAntigua, '2026-11-01 10:00:00');
});

test('una sucursal nunca leída deja la lectura más antigua en blanco', () => {
  const f = filaCliente({}, [], [{ ultimaLectura: null, desactualizada: true }]);
  assert.equal(f.lecturaMasAntigua, null);
  assert.equal(f.estado, 'sinDatos');
});
