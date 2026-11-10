// Consulta en la API oficial de boletas del SII el estado de boletas puntuales (solo lectura).
// Uso: node scripts/probar-boletas.js <rutEmpresa> <tipo>:<folio>:<YYYY-MM-DD>:<monto>[:<rutReceptor>] [...]
import { cargarConfig } from '../server/config.js';
import { cargarCertificado } from '../server/lib/sii/certificado.js';
import { obtenerTokenBoletas, consultarEstadoBoleta } from '../server/lib/sii/boletas.js';

const [rut, ...items] = process.argv.slice(2);
const cfg = cargarConfig();
const emp = cfg.empresas.find((e) => e.rut === rut);
try {
  const token = await obtenerTokenBoletas(cargarCertificado(emp.certificado), cfg.sii?.ambiente);
  console.log(`Token API boletas: OK (${token.length} caracteres)`);
  for (const it of items) {
    const [tipo, folio, fecha, monto, rutReceptor] = it.split(':');
    const r = await consultarEstadoBoleta(token, { rutEmisor: rut, tipoSii: tipo, folio, fecha, monto: Number(monto), rutReceptor }, cfg.sii?.ambiente);
    console.log(`\nTipo ${tipo} folio ${folio} -> HTTP ${r.http}`);
    console.log(typeof r.respuesta === 'string' ? r.respuesta.slice(0, 600) : JSON.stringify(r.respuesta, null, 1).slice(0, 800));
  }
} catch (e) {
  console.error(`FALLÓ: ${e.message}`);
  if (e.detalle) console.error(e.detalle);
  process.exit(1);
}
