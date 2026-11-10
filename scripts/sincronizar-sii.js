// Descarga del SII el Registro de Ventas (RCV) de un periodo y lo guarda para la cuadratura.
// Solo consulta: no envía ni modifica nada en el SII.
// Uso: npm run sii -- 2026-10 [rutEmpresa]
import { cargarConfig } from '../server/config.js';
import { abrirDb, guardarEmpresa, guardarSincronizacionRcv, boletasSospechosas, guardarDocsSii } from '../server/db.js';
import { obtenerTokenBoletas, consultarEstadoBoleta, estadoDesdeApi } from '../server/lib/sii/boletas.js';
import { cargarCertificado } from '../server/lib/sii/certificado.js';
import { obtenerToken } from '../server/lib/sii/autenticacion.js';
import { rcvResumenVentas, rcvDetalleVentas } from '../server/lib/sii/rcv.js';

const [periodo, soloRut] = process.argv.slice(2);
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
    guardarEmpresa({ rut: emp.rut, razonSocial: emp.razonSocial });
    const token = await obtenerToken(cargarCertificado(emp.certificado), ambiente);
    const resumen = await rcvResumenVentas(token, emp.rut, periodo);
    const detalle = [];
    for (const r of resumen) {
      const linea = `  ${String(r.tipoSii).padStart(3)} ${r.nombre.padEnd(42)} ${String(r.totDoc).padStart(6)} docs  $${Math.round(r.montoTotal).toLocaleString('es-CL')}`;
      if (r.tipoIngreso === 'RESUMEN') {
        console.log(`${linea}  (resumen)`);
        continue;
      }
      const docs = await rcvDetalleVentas(token, emp.rut, periodo, r.tipoSii);
      detalle.push(...docs);
      console.log(`${linea}  (detalle: ${docs.length})`);
    }
    guardarSincronizacionRcv(emp.rut, periodo, resumen, detalle);
    console.log(`  ✓ RCV guardado: ${resumen.length} tipos, ${detalle.length} documentos con detalle`);

    // Boletas sospechosas: verificación una a una en la API oficial de boletas
    const sospechosas = boletasSospechosas(emp.rut, periodo);
    if (sospechosas.length) {
      const tokenBol = await obtenerTokenBoletas(cargarCertificado(emp.certificado), ambiente);
      const verificadas = [];
      for (const b of sospechosas) {
        if (!b.fecha) {
          console.log(`    - ${b.tipo_sii} ${b.folio}: sin fecha, no se puede consultar`);
          continue;
        }
        const r = await consultarEstadoBoleta(tokenBol, {
          rutEmisor: emp.rut, tipoSii: b.tipo_sii, folio: b.folio, fecha: b.fecha, monto: b.total, rutReceptor: b.rut_receptor,
        }, ambiente);
        const codigo = r.respuesta?.codigo ?? `HTTP ${r.http}`;
        const { estado, motivo } = estadoDesdeApi(codigo, r.respuesta?.descripcion);
        verificadas.push({ rutEmisor: emp.rut, periodo, tipoSii: b.tipo_sii, folio: b.folio, fecha: b.fecha,
          rutReceptor: b.rut_receptor, total: estado === 'NO_RECIBIDO' ? 0 : b.total, estado, motivo, fuente: 'API_BOLETA' });
        console.log(`    · Boleta ${b.tipo_sii} ${b.folio}: ${codigo} ${r.respuesta?.descripcion ?? ''}`);
      }
      guardarDocsSii(verificadas);
      console.log(`  ✓ API boletas: ${verificadas.length} boletas sospechosas verificadas`);
    }
  } catch (e) {
    errores++;
    console.error(`  ✗ ${e.message}`);
  }
}
process.exit(errores ? 1 : 0);
