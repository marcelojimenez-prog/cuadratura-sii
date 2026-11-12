// Consulta al SII (Registro de Ventas, boletas) de un periodo con los certificados configurados en
// este equipo. Solo consulta: no envía ni modifica nada en el SII.
// Las razones sociales con agente consultan con SU certificado desde su servidor (lo hace el portal solo).
// Uso: npm run sii -- 2026-10 [rutEmpresa]
import { cargarConfig } from '../server/config.js';
import { abrirDb } from '../server/db.js';
import { sincronizarEmpresa } from '../server/lib/sii/sincronizar.js';
import { clienteLocal } from '../server/lib/sii/clientes.js';

// --rapido: sin revisar todas las boletas una por una (consulta frecuente del mes en curso)
const rapido = process.argv.includes('--rapido');
const [periodo, soloRut] = process.argv.slice(2).filter((a) => a !== '--rapido');
if (!/^\d{4}-\d{2}$/.test(periodo || '')) {
  console.error('Uso: npm run sii -- YYYY-MM [rutEmpresa]');
  process.exit(1);
}
const cfg = cargarConfig();
abrirDb(cfg.rutaBaseDatos);
const ambiente = cfg.sii?.ambiente ?? 'produccion';
let errores = 0;

for (const emp of cfg.empresas) {
  if (soloRut && emp.rut !== soloRut) continue;
  if (!emp.certificado?.rutaPfx) {
    console.log(`- ${emp.razonSocial} (${emp.rut}): sin certificado configurado, se omite`);
    continue;
  }
  console.log(`\n== ${emp.razonSocial} (${emp.rut}) periodo ${periodo}`);
  try {
    await sincronizarEmpresa(emp, periodo, clienteLocal(emp.certificado, ambiente), console.log, { barrido: !rapido });
  } catch (e) {
    errores++;
    console.error(`  ✗ ${e.message}`);
  }
}
process.exit(errores ? 1 : 0);
