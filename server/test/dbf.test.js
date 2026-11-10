import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { leerRegistros, leerRegistrosDesdeElFinal } from '../lib/sisgen/dbf.js';

/** Crea un DBF mínimo con un campo C(5) y los registros dados (byte0 + texto). */
function crearDbf(registros) {
  const campos = 1, largoReg = 1 + 5, largoEnc = 32 + 32 * campos + 1;
  const h = Buffer.alloc(largoEnc);
  h[0] = 0x03; h.writeUInt32LE(registros.length, 4); h.writeUInt16LE(largoEnc, 8); h.writeUInt16LE(largoReg, 10); h[29] = 0x03;
  h.write('NUM', 32, 'latin1'); h[32 + 11] = 'C'.charCodeAt(0); h[32 + 16] = 5; h[largoEnc - 1] = 0x0d;
  const cuerpo = Buffer.concat(registros.map(([b0, txt]) => Buffer.concat([Buffer.from([b0]), Buffer.from(txt.padEnd(5).slice(0, 5), 'latin1')])));
  const ruta = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dbf-')), 'T.DBF');
  fs.writeFileSync(ruta, Buffer.concat([h, cuerpo, Buffer.from([0x1a])]));
  return ruta;
}

const DANADO = [[0x20, '1'], [0x20, '2'], [0x1a, ''], [0x00, ''], [0x2a, '3'], [0x20, '4']];

test('salta registros dañados (0x1A / 0x00 en medio del archivo) y sigue leyendo', () => {
  const ruta = crearDbf(DANADO);
  assert.deepEqual([...leerRegistros(ruta)].map((r) => r.NUM), ['1', '2', '4']);
  assert.deepEqual([...leerRegistros(ruta, { incluirBorrados: true })].map((r) => r.NUM), ['1', '2', '3', '4']);
});

test('lectura desde el final entrega los mismos registros en orden inverso', () => {
  const ruta = crearDbf(DANADO);
  assert.deepEqual([...leerRegistrosDesdeElFinal(ruta)].map((r) => r.NUM), ['4', '2', '1']);
});
