// Importa las ventas de un periodo para todas las sucursales configuradas en config.local.json.
// Uso: npm run importar -- 2025-04 [rutEmpresa] [codigoSucursal]
import { cargarConfig } from '../server/config.js';
import { abrirDb, guardarEmpresa, guardarSucursal, reemplazarDocsSisgen, reemplazarRangosCaf, reemplazarXmlOtrosMeses } from '../server/db.js';
import { leerEmpresa, leerDocumentosMes, leerCafs, normalizarRut } from '../server/lib/sisgen/importar.js';

const [periodo, soloRut, soloSucursal] = process.argv.slice(2);
if (!/^\d{4}-\d{2}$/.test(periodo || '')) {
  console.error('Uso: npm run importar -- YYYY-MM [rutEmpresa]');
  process.exit(1);
}

const cfg = cargarConfig();
if (!cfg.empresas.length) {
  console.error('No hay empresas en config/config.local.json (ver config.example.json).');
  process.exit(1);
}
abrirDb(cfg.rutaBaseDatos);

for (const emp of cfg.empresas) {
  const rut = normalizarRut(emp.rut);
  if (soloRut && normalizarRut(soloRut) !== rut) continue;
  guardarEmpresa({ rut, razonSocial: emp.razonSocial });
  console.log(`\n== ${emp.razonSocial} (${rut}) periodo ${periodo}`);

  for (const suc of emp.sucursales) {
    if (soloSucursal && suc.codigo !== soloSucursal) continue;
    const inicio = Date.now();
    try {
      const empSisgen = leerEmpresa(suc.rutaDatos);
      if (empSisgen.rut !== rut) {
        console.warn(`  ! ${suc.nombre}: empres.dbf indica RUT ${empSisgen.rut}, distinto de ${rut}. Se omite.`);
        continue;
      }
      const leido = leerDocumentosMes(suc.rutaDatos, periodo, suc.rutaProcesos);
      const docs = leido.docs.map((d) => ({ ...d, rutEmisor: rut }));
      const id = guardarSucursal({ rutEmpresa: rut, codigo: suc.codigo, nombre: suc.nombre, rutaDatos: suc.rutaDatos, rutaProcesos: suc.rutaProcesos });
      reemplazarDocsSisgen(id, periodo, docs);
      reemplazarXmlOtrosMeses(id, rut, periodo, leido.xmlOtrosMeses);
      const cafs = suc.rutaProcesos ? leerCafs(suc.rutaProcesos) : null;
      if (cafs) reemplazarRangosCaf(id, rut, cafs);
      else leido.avisos.push('Sin carpeta procesos\\Folios: no se puede validar a qué sucursal corresponde cada folio');
      const porTipo = docs.reduce((a, d) => ((a[d.tipoSisgen] = (a[d.tipoSisgen] || 0) + 1), a), {});
      const enBlanco = docs.filter((d) => d.enBlanco).length;
      const sinXml = docs.filter((d) => d.sinXml).length;
      if (sinXml) console.log(`    ${sinXml} documentos sin XML en procesos\\DTE`);
      console.log(`  ✓ ${suc.nombre}: ${docs.length} documentos (${enBlanco} en blanco), ${cafs?.length ?? 0} CAF`, porTipo);
      for (const a of leido.avisos) console.warn(`    ! ${a}`);
      console.log(`    (${Math.round((Date.now() - inicio) / 1000)} s)`);
    } catch (e) {
      console.error(`  ✗ ${suc.nombre}: ${e.message}`);
    }
  }
}
