// Muestra la estructura y algunos registros de una tabla DBF de Sisgen.
// Uso: npm run dbf -- <ruta.dbf> [cantidad]
import { leerEstructura, leerRegistros } from '../server/lib/sisgen/dbf.js';

const [ruta, cant = '3'] = process.argv.slice(2);
if (!ruta) {
  console.error('Uso: npm run dbf -- <ruta.dbf> [cantidad]');
  process.exit(1);
}
const est = leerEstructura(ruta);
console.log(`${ruta}\nregistros=${est.registros} campos=${est.campos.length} codificación=${est.codificacion}`);
console.log(est.campos.map((c) => `${c.nombre}:${c.tipo}${c.largo}${c.decimales ? '.' + c.decimales : ''}`).join('  '));
let i = 0;
for (const r of leerRegistros(ruta, { incluirBorrados: true })) {
  const util = Object.fromEntries(Object.entries(r).filter(([, v]) => v !== '' && v !== null && v !== 0 && v !== undefined));
  console.log(JSON.stringify(util));
  if (++i >= Number(cant)) break;
}
