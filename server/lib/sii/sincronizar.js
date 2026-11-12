// Sincronización con el SII de una razón social en un periodo (solo consultas):
//   1. Registro de Ventas (resumen + detalle)
//   2. Boletas: verificación una a una en la API oficial (sospechosas y, si no cuadra, todas)
//   3. Boletas emitidas fuera de Sisgen (folios fuera de los CAF de las sucursales)
// Las consultas pasan por un "cliente SII": local (certificado configurado en este equipo) o
// remoto (el agente del cliente consulta con SU certificado, que nunca sale de su servidor).
import {
  guardarEmpresa, guardarSincronizacionRcv, boletasSospechosas, guardarDocsSii, rangosCaf, conteoSisgenPorTipo,
  reemplazarFoliosExternos, docsSisgenDeTipo, boletasConProblemaApi,
} from '../../db.js';
import { verificarBoletas, requiereBarrido } from './verificacionBoletas.js';
import { huecosCaf, detectarFoliosExternos, existenciaDesdeCodigo } from './foliosExternos.js';
import { estadoDesdeApi } from './boletas.js';

/**
 * @param {{ rut, razonSocial }} emp
 * @param {string} periodo YYYY-MM
 * @param {{ rcvResumen, rcvDetalle, estadoBoleta }} cliente
 * @param {(m:string)=>void} [log]
 */
export async function sincronizarEmpresa(emp, periodo, cliente, log = console.log, { barrido = true } = {}) {
  guardarEmpresa({ rut: emp.rut, razonSocial: emp.razonSocial });
  const resumen = await cliente.rcvResumen(emp.rut, periodo);
  const detalle = [];
  for (const r of resumen) {
    const linea = `  ${String(r.tipoSii).padStart(3)} ${r.nombre.padEnd(42)} ${String(r.totDoc).padStart(6)} docs  $${Math.round(r.montoTotal).toLocaleString('es-CL')}`;
    if (r.tipoIngreso === 'RESUMEN') {
      log(`${linea}  (resumen)`);
      continue;
    }
    let docs;
    try {
      docs = await cliente.rcvDetalle(emp.rut, periodo, r.tipoSii);
    } catch (e) {
      // Con mucho volumen el SII no entrega el detalle en línea ("debe ser de forma diferida", código 99):
      // ese tipo se cuadra con los totales del resumen en vez de documento a documento
      if (!/\b99\b|diferida/i.test(e.message)) throw e;
      r.tipoIngreso = 'RESUMEN';
      log(`${linea}  (solo totales: el SII exige descarga diferida del detalle)`);
      continue;
    }
    detalle.push(...docs);
    log(`${linea}  (detalle: ${docs.length})`);
  }
  guardarSincronizacionRcv(emp.rut, periodo, resumen, detalle);
  log(`  ✓ RCV guardado: ${resumen.length} tipos, ${detalle.length} documentos con detalle`);

  // ---- Boletas: verificación una a una en la API oficial de boletas ----
  const consultar = async (b) => {
    if (!b.fecha) return { codigo: null, descripcion: 'sin fecha' };
    for (let intento = 1; ; intento++) {
      try {
        const r = await cliente.estadoBoleta({
          rutEmisor: emp.rut, tipoSii: b.tipo_sii, folio: b.folio, fecha: b.fecha, monto: b.total, rutReceptor: b.rut_receptor,
        });
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
      if (codigo !== 'DOK') log(`    · ${b.sucursal ?? ''} boleta ${b.tipo_sii}-${b.folio} (${b.fecha}, $${b.total}): ${codigo} ${descripcion ?? ''}`);
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
    log(`  ✓ API boletas: ${sospechosas.length} sospechosas verificadas, ${conProblema.length} con problema`);
  }

  // 2) Si aún sobran boletas en Sisgen (o el monto no cuadra), se revisan TODAS las del mes:
  //    toda boleta que no llegó al SII se informa siempre.
  for (const r of resumen) {
    if (!barrido) break; // consulta rápida (cada pocos minutos): sin revisar todas las boletas una por una
    if (r.tipoIngreso !== 'RESUMEN' || ![39, 41].includes(r.tipoSii)) continue;
    const boletas = docsSisgenDeTipo(emp.rut, periodo, r.tipoSii);
    const conocidas = boletasConProblemaApi(emp.rut, periodo).filter((b) => b.tipo_sii === r.tipoSii);
    const sumar = (l) => l.reduce((s, b) => s + (b.total ?? 0), 0);
    const datos = { sisgenDocs: boletas.length, sisgenMonto: sumar(boletas), siiDocs: r.totDoc, siiMonto: r.montoTotal,
      conocidasDocs: conocidas.length, conocidasMonto: sumar(conocidas) };
    if (!requiereBarrido(datos)) continue;
    const yaVistas = new Set(sospechosas.map((b) => `${b.tipo_sii}-${b.folio}`));
    const pendientes = boletas.filter((b) => !yaVistas.has(`${b.tipo_sii}-${b.folio}`));
    log(`  … Tipo ${r.tipoSii}: Sisgen ${datos.sisgenDocs - datos.conocidasDocs} vs SII ${r.totDoc}; revisando ${pendientes.length} boletas en la API`);
    const t0 = Date.now();
    const resultados = await verificarBoletas(pendientes, consultar, { concurrencia: 5 });
    const sinRespuesta = resultados.filter((x) => !x.codigo).length;
    const conProblema = guardarResultados(resultados, marcadas);
    log(`  ✓ Tipo ${r.tipoSii}: ${conProblema.length} con problema en el SII` +
      `${sinRespuesta ? `, ${sinRespuesta} sin respuesta` : ''} (${Math.round((Date.now() - t0) / 1000)} s)`);
  }

  // Boletas emitidas fuera de Sisgen: si el SII informa MÁS boletas que todas las sucursales,
  // se buscan folios recibidos por el SII que no pertenecen a ningún CAF de las sucursales.
  const conteo = conteoSisgenPorTipo(emp.rut, periodo);
  const rangos = rangosCaf(emp.rut);
  for (const r of resumen) {
    if (r.tipoIngreso !== 'RESUMEN' || ![39, 41].includes(r.tipoSii)) continue;
    const enSisgen = conteo.get(r.tipoSii) ?? 0;
    const exceso = r.totDoc - enSisgen;
    const rangosTipo = rangos.filter((c) => c.tipo_sii === r.tipoSii);
    // Sin ventas de ese tipo cargadas desde Sisgen en el mes (aún no se importan) no hay con qué comparar
    if (exceso <= 0 || !rangosTipo.length || enSisgen === 0) {
      reemplazarFoliosExternos(emp.rut, periodo, r.tipoSii, []);
      continue;
    }
    let consultas = 0;
    const existencia = async (folio) => {
      consultas++;
      const resp = await cliente.estadoBoleta({
        rutEmisor: emp.rut, tipoSii: r.tipoSii, folio, fecha: `${periodo}-15`, monto: 1, rutReceptor: '99999999-9',
      });
      return existenciaDesdeCodigo(resp.respuesta?.codigo);
    };
    const bloques = await detectarFoliosExternos(huecosCaf(rangosTipo), existencia);
    reemplazarFoliosExternos(emp.rut, periodo, r.tipoSii, bloques);
    log(`  ✓ Tipo ${r.tipoSii}: el SII tiene ${exceso} más que Sisgen; ${bloques.length} bloque(s) de folios fuera de los CAF de las sucursales (${consultas} consultas)`);
    for (const b of bloques) log(`    · folios ${b.desde}–${b.ultimo} (${b.cantidad}) entre CAF de ${b.antes ?? '?'} y ${b.despues ?? '—'}`);
  }
}
