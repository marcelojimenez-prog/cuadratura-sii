// Descarga del SII el Registro de Ventas (RCV) de un periodo y lo guarda para la cuadratura.
// Solo consulta: no envía ni modifica nada en el SII.
// Uso: npm run sii -- 2026-10 [rutEmpresa]
import { cargarConfig } from '../server/config.js';
import { abrirDb, guardarEmpresa, guardarSincronizacionRcv, boletasSospechosas, guardarDocsSii, rangosCaf, conteoSisgenPorTipo, reemplazarFoliosExternos, docsSisgenDeTipo, boletasConProblemaApi } from '../server/db.js';
import { verificarBoletas, requiereBarrido } from '../server/lib/sii/verificacionBoletas.js';
import { huecosCaf, detectarFoliosExternos, existenciaDesdeCodigo } from '../server/lib/sii/foliosExternos.js';
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

    // ---- Boletas: verificación una a una en la API oficial de boletas ----
    let tokenBolCache = null;
    const tokenBoletas = async () => (tokenBolCache ??= await obtenerTokenBoletas(cargarCertificado(emp.certificado), ambiente));
    const consultar = async (b) => {
      if (!b.fecha) return { codigo: null, descripcion: 'sin fecha' };
      const tok = await tokenBoletas();
      for (let intento = 1; ; intento++) {
        try {
          const r = await consultarEstadoBoleta(tok, {
            rutEmisor: emp.rut, tipoSii: b.tipo_sii, folio: b.folio, fecha: b.fecha, monto: b.total, rutReceptor: b.rut_receptor,
          }, ambiente);
          if (r.http >= 500 && intento < 3) throw new Error(`HTTP ${r.http}`);
          return { codigo: r.respuesta?.codigo ?? `HTTP ${r.http}`, descripcion: r.respuesta?.descripcion };
        } catch (e) {
          if (intento >= 3) return { codigo: null, descripcion: e.message };
          await new Promise((res) => setTimeout(res, 2000 * intento));
        }
      }
    };
    /** Guarda resultados: problemas siempre; DOK solo si la boleta ya estaba marcada (se corrige). */
    const guardarResultados = (resultados, marcadas) => {
      const filas = [];
      for (const { boleta: b, codigo, descripcion } of resultados) {
        if (!codigo) continue;
        if (codigo === 'DOK' && !marcadas.has(`${b.tipo_sii}-${b.folio}`)) continue;
        const { estado, motivo } = estadoDesdeApi(codigo, descripcion);
        filas.push({ rutEmisor: emp.rut, periodo, tipoSii: b.tipo_sii, folio: b.folio, fecha: b.fecha,
          rutReceptor: b.rut_receptor, total: estado === 'NO_RECIBIDO' ? 0 : b.total, estado, motivo, fuente: 'API_BOLETA' });
        if (codigo !== 'DOK') console.log(`    · ${b.sucursal ?? ''} boleta ${b.tipo_sii}-${b.folio} (${b.fecha}, $${b.total}): ${codigo} ${descripcion ?? ''}`);
      }
      guardarDocsSii(filas);
      return filas.filter((f) => f.estado !== 'ACEPTADO');
    };

    // 1) Sospechosas (sin XML o en blanco) y las que ya tenían problema en una consulta anterior
    const previas = boletasConProblemaApi(emp.rut, periodo);
    const marcadas = new Set(previas.map((b) => `${b.tipo_sii}-${b.folio}`));
    const sospechosas = [...new Map([...boletasSospechosas(emp.rut, periodo), ...previas]
      .map((b) => [`${b.tipo_sii}-${b.folio}`, b])).values()];
    if (sospechosas.length) {
      const conProblema = guardarResultados(await verificarBoletas(sospechosas, consultar), marcadas);
      console.log(`  ✓ API boletas: ${sospechosas.length} sospechosas verificadas, ${conProblema.length} con problema`);
    }

    // 2) Si aún sobran boletas en Sisgen (o el monto no cuadra), se revisan TODAS las del mes:
    //    toda boleta que no llegó al SII se informa siempre.
    for (const r of resumen) {
      if (r.tipoIngreso !== 'RESUMEN' || ![39, 41].includes(r.tipoSii)) continue;
      const boletas = docsSisgenDeTipo(emp.rut, periodo, r.tipoSii);
      const conocidas = boletasConProblemaApi(emp.rut, periodo).filter((b) => b.tipo_sii === r.tipoSii);
      const sumar = (l) => l.reduce((s, b) => s + (b.total ?? 0), 0);
      const datos = { sisgenDocs: boletas.length, sisgenMonto: sumar(boletas), siiDocs: r.totDoc, siiMonto: r.montoTotal,
        conocidasDocs: conocidas.length, conocidasMonto: sumar(conocidas) };
      if (!requiereBarrido(datos)) continue;
      const yaVistas = new Set(sospechosas.map((b) => `${b.tipo_sii}-${b.folio}`));
      const pendientes = boletas.filter((b) => !yaVistas.has(`${b.tipo_sii}-${b.folio}`));
      console.log(`  … Tipo ${r.tipoSii}: Sisgen ${datos.sisgenDocs - datos.conocidasDocs} vs SII ${r.totDoc}; revisando ${pendientes.length} boletas en la API`);
      const t0 = Date.now();
      const resultados = await verificarBoletas(pendientes, consultar, { concurrencia: 5 });
      const sinRespuesta = resultados.filter((x) => !x.codigo).length;
      const conProblema = guardarResultados(resultados, marcadas);
      console.log(`  ✓ Tipo ${r.tipoSii}: ${conProblema.length} con problema en el SII` +
        `${sinRespuesta ? `, ${sinRespuesta} sin respuesta` : ''} (${Math.round((Date.now() - t0) / 1000)} s)`);
    }

    // Boletas emitidas fuera de Sisgen: si el SII informa MÁS boletas que todas las sucursales,
    // se buscan folios recibidos por el SII que no pertenecen a ningún CAF de las sucursales.
    const conteo = conteoSisgenPorTipo(emp.rut, periodo);
    const rangos = rangosCaf(emp.rut);
    for (const r of resumen) {
      if (r.tipoIngreso !== 'RESUMEN' || ![39, 41].includes(r.tipoSii)) continue;
      const exceso = r.totDoc - (conteo.get(r.tipoSii) ?? 0);
      const rangosTipo = rangos.filter((c) => c.tipo_sii === r.tipoSii);
      if (exceso <= 0 || !rangosTipo.length) {
        reemplazarFoliosExternos(emp.rut, periodo, r.tipoSii, []);
        continue;
      }
      const tok = await tokenBoletas();
      let consultas = 0;
      const existencia = async (folio) => {
        consultas++;
        const resp = await consultarEstadoBoleta(tok, {
          rutEmisor: emp.rut, tipoSii: r.tipoSii, folio, fecha: `${periodo}-15`, monto: 1, rutReceptor: '99999999-9',
        }, ambiente);
        return existenciaDesdeCodigo(resp.respuesta?.codigo);
      };
      const bloques = await detectarFoliosExternos(huecosCaf(rangosTipo), existencia);
      reemplazarFoliosExternos(emp.rut, periodo, r.tipoSii, bloques);
      console.log(`  ✓ Tipo ${r.tipoSii}: el SII tiene ${exceso} más que Sisgen; ${bloques.length} bloque(s) de folios fuera de los CAF de las sucursales (${consultas} consultas)`);
      for (const b of bloques) console.log(`    · folios ${b.desde}–${b.ultimo} (${b.cantidad}) entre CAF de ${b.antes ?? '?'} y ${b.despues ?? '—'}`);
    }
  } catch (e) {
    errores++;
    console.error(`  ✗ ${e.message}`);
  }
}
process.exit(errores ? 1 : 0);
