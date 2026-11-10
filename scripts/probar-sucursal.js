// Prueba de acceso de solo lectura a la carpeta Sisgen de una sucursal.
// Uso: node scripts/probar-sucursal.js <\\host\sisgen> [YYYY-MM]
import fs from 'node:fs';
import path from 'node:path';
import { leerEmpresa, leerCafs, carpetaMes } from '../server/lib/sisgen/importar.js';
import { buscarArchivo } from '../server/lib/sisgen/dbf.js';

const [raiz, periodo = '2026-10'] = process.argv.slice(2);
const r = { raiz };
try {
  const datos = fs.readdirSync(raiz, { withFileTypes: true }).filter((d) => d.isDirectory() && /^datos/i.test(d.name)).map((d) => d.name);
  r.carpetasDatos = datos;
  const dDatos = path.join(raiz, datos.find((d) => d.toLowerCase() === 'datos') ?? datos[0]);
  const emp = leerEmpresa(dDatos);
  Object.assign(r, { rut: emp.rut, razonSocial: emp.razonSocial, nombreSisgen: emp.nombreSistema });
  const [a, m] = periodo.split('-');
  r.tablas = Object.fromEntries(
    [`F1${m}${a}.dbf`, `F2${m}${a}.dbf`, 'clidocto.dbf', 'clipagos.dbf'].map((n) => {
      const f = buscarArchivo(dDatos, n);
      return [n, f ? `${Math.round(fs.statSync(f).size / 1024)} KB` : 'NO EXISTE'];
    })
  );
  const proc = path.join(raiz, 'procesos');
  const cafs = leerCafs(proc);
  r.cafPorTipo = cafs ? cafs.reduce((acc, c) => ((acc[c.tipoSii] = (acc[c.tipoSii] || 0) + 1), acc), {}) : 'sin procesos\\Folios';
  r.xmlMes = fs.existsSync(path.join(proc, 'DTE', carpetaMes(periodo))) ? 'sí' : 'no';
} catch (e) {
  r.error = e.message;
}
console.log(JSON.stringify(r));
