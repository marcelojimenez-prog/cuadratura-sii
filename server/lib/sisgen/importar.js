// Importa las ventas de un mes desde una carpeta datos* de Sisgen.
//   F1MMAAAA.DBF = encabezado de ventas del mes
//   empres.dbf   = empresa emisora (RUT, razón social)
import fs from 'node:fs';
import path from 'node:path';
import { leerRegistros, leerRegistrosDesdeElFinal, buscarArchivo } from './dbf.js';
import { tipoSii, TIPO_SISGEN_POR_SII } from './tipos.js';

/** Lee la empresa emisora configurada en la carpeta de datos de Sisgen. */
export function leerEmpresa(carpetaDatos) {
  const ruta = buscarArchivo(carpetaDatos, 'empres.dbf');
  if (!ruta) throw new Error(`No se encontró empres.dbf en ${carpetaDatos}`);
  for (const r of leerRegistros(ruta, { campos: ['EMPNOM', 'EMPRUT', 'DTERUT', 'DTERAZ', 'DTESUC', 'DTECODSUC'] })) {
    // DTERUT/DTERAZ son los datos usados al emitir DTE; EMPRUT/EMPNOM como respaldo.
    return {
      rut: normalizarRut(r.DTERUT || r.EMPRUT),
      razonSocial: r.DTERAZ || r.EMPNOM,
      nombreSistema: r.EMPNOM,
      sucursalSii: r.DTESUC || null,
      codigoSucursalSii: r.DTECODSUC || null,
    };
  }
  throw new Error(`empres.dbf vacío en ${carpetaDatos}`);
}

/**
 * Lee las ventas (F1) de un periodo.
 * @param {string} carpetaDatos carpeta datos* de una sucursal
 * @param {string} periodo YYYY-MM
 */
export function leerVentasMes(carpetaDatos, periodo) {
  const [anio, mes] = periodo.split('-');
  const nombre = `F1${mes}${anio}.dbf`;
  const ruta = buscarArchivo(carpetaDatos, nombre);
  if (!ruta) throw new Error(`No existe ${nombre} en ${carpetaDatos}`);

  const campos = ['FATDOCTO', 'FANUMERO', 'FAFECHA', 'FARUTCLI', 'FANOMCLI', 'FAAFECTO', 'FAEXENTO', 'FAIVA', 'FATOTAL', 'CODSUC', 'NOMSUC', 'ELECTRON'];
  const docs = [];
  for (const r of leerRegistros(ruta, { campos })) {
    const folio = parseInt(r.FANUMERO, 10);
    if (!r.FATDOCTO || !Number.isFinite(folio)) continue;
    docs.push({
      tipoSisgen: r.FATDOCTO.toUpperCase(),
      tipoSii: tipoSii(r.FATDOCTO),
      folio,
      fecha: r.FAFECHA,
      rutReceptor: r.FARUTCLI ? normalizarRut(r.FARUTCLI) : null,
      nombreReceptor: r.FANOMCLI || null,
      neto: r.FAAFECTO ?? 0,
      exento: r.FAEXENTO ?? 0,
      iva: r.FAIVA ?? 0,
      total: r.FATOTAL ?? 0,
      codSucursalSisgen: r.CODSUC || null,
      electronico: r.ELECTRON === 'S',
    });
  }
  return docs;
}

const claveDoc = (tipo, folio) => `${tipo}-${folio}`;
const enPeriodo = (fecha, periodo) => typeof fecha === 'string' && fecha.startsWith(periodo);

/** Claves tipo-folio con al menos una línea de detalle en F2 del mes. null si no existe F2. */
export function leerDetalleMes(carpetaDatos, periodo) {
  const [anio, mes] = periodo.split('-');
  const ruta = buscarArchivo(carpetaDatos, `F2${mes}${anio}.dbf`);
  if (!ruta) return null;
  const claves = new Set();
  for (const r of leerRegistros(ruta, { campos: ['DETDOCTO', 'DENUMFAC'] })) {
    const folio = parseInt(r.DENUMFAC, 10);
    if (r.DETDOCTO && Number.isFinite(folio)) claves.add(claveDoc(r.DETDOCTO.toUpperCase(), folio));
  }
  return claves;
}

// CLIDOCTO y CLIPAGOS guardan todos los años y crecen en orden cronológico. Se leen desde el
// final y se corta cuando aparecen muchos registros seguidos anteriores al periodo con margen.
const MESES_MARGEN = 3;        // registros hasta 3 meses antes del periodo siguen revisándose
const CORTE_CONSECUTIVOS = 5000; // registros antiguos seguidos para dar por terminada la lectura

function* recientes(ruta, campos, campoFecha, periodo) {
  const limite = `${periodoVecino(periodo, -MESES_MARGEN)}-01`;
  let antiguos = 0;
  for (const r of leerRegistrosDesdeElFinal(ruta, { campos })) {
    const f = r[campoFecha];
    if (f && f < limite) {
      if (++antiguos >= CORTE_CONSECUTIVOS) return;
      continue;
    }
    antiguos = 0;
    yield r;
  }
}

/** Documentos de CLIDOCTO (cuentas por cobrar) con fecha en el periodo. null si no existe. */
export function leerClidoctoMes(carpetaDatos, periodo) {
  const ruta = buscarArchivo(carpetaDatos, 'clidocto.dbf');
  if (!ruta) return null;
  const docs = [];
  for (const r of recientes(ruta, ['TDOCTO', 'NUMFAC', 'FECFAC', 'RUTCLI', 'NOMCLI', 'MONTO'], 'FECFAC', periodo)) {
    const folio = parseInt(r.NUMFAC, 10);
    if (!r.TDOCTO || !Number.isFinite(folio) || !enPeriodo(r.FECFAC, periodo)) continue;
    docs.push({ tipoSisgen: r.TDOCTO.toUpperCase(), folio, fecha: r.FECFAC, rut: r.RUTCLI, nombre: r.NOMCLI, monto: r.MONTO ?? 0 });
  }
  return docs;
}

/** Pagos de CLIPAGOS registrados en el periodo, sumados por documento. null si no existe. */
export function leerClipagosMes(carpetaDatos, periodo) {
  const ruta = buscarArchivo(carpetaDatos, 'clipagos.dbf');
  if (!ruta) return null;
  const porDoc = new Map();
  for (const r of recientes(ruta, ['TDOCTO', 'NUMFAC', 'FECPAG', 'RUTCLI', 'VALDOC'], 'FECPAG', periodo)) {
    const folio = parseInt(r.NUMFAC, 10);
    if (!r.TDOCTO || !Number.isFinite(folio) || !enPeriodo(r.FECPAG, periodo)) continue;
    const k = claveDoc(r.TDOCTO.toUpperCase(), folio);
    const p = porDoc.get(k) || { tipoSisgen: r.TDOCTO.toUpperCase(), folio, rut: r.RUTCLI, monto: 0 };
    p.monto += r.VALDOC ?? 0;
    porDoc.set(k, p);
  }
  return [...porDoc.values()];
}

/**
 * Junta lo emitido en el mes desde todas las fuentes de Sisgen (función pura, testeable).
 *  - F1 es la fuente principal.
 *  - Documento EN BLANCO = no quedó completo en F1/F2:
 *      a) está en F1 pero sin detalle en F2 (solo si ese tipo sí tiene detalle en F2 ese mes), o
 *      b) no está en F1, pero aparece en CLIDOCTO o CLIPAGOS.
 *  - CLIPAGOS registra la fecha del pago, no la del documento: para no traer documentos de
 *    meses anteriores, solo se consideran folios dentro del rango del mes (según F1/CLIDOCTO).
 */
export function consolidar({ f1, detalle, clidocto, clipagos, xml }) {
  const docs = new Map();
  for (const d of f1) docs.set(claveDoc(d.tipoSisgen, d.folio), { ...d, enBlanco: false });

  if (detalle) {
    const tiposConDetalle = new Set([...detalle].map((k) => k.split('-')[0]));
    for (const [k, d] of docs) {
      if (tiposConDetalle.has(d.tipoSisgen) && !detalle.has(k)) d.enBlanco = true;
    }
  }

  const nuevo = (tipoSisgen, folio, x) => ({
    tipoSisgen, tipoSii: tipoSii(tipoSisgen), folio, fecha: x.fecha ?? null,
    rutReceptor: x.rut ? normalizarRut(x.rut) : null, nombreReceptor: x.nombre || null,
    neto: 0, exento: 0, iva: 0, total: x.monto ?? 0, codSucursalSisgen: null, electronico: true, enBlanco: true,
  });

  for (const c of clidocto ?? []) {
    const k = claveDoc(c.tipoSisgen, c.folio);
    if (!docs.has(k)) docs.set(k, nuevo(c.tipoSisgen, c.folio, c));
  }

  if (clipagos?.length) {
    const rango = new Map(); // tipo -> [min, max]
    for (const d of docs.values()) {
      const r = rango.get(d.tipoSisgen) || [Infinity, -Infinity];
      rango.set(d.tipoSisgen, [Math.min(r[0], d.folio), Math.max(r[1], d.folio)]);
    }
    for (const p of clipagos) {
      const k = claveDoc(p.tipoSisgen, p.folio);
      const r = rango.get(p.tipoSisgen);
      if (docs.has(k) || !r || p.folio < r[0] || p.folio > r[1]) continue;
      docs.set(k, nuevo(p.tipoSisgen, p.folio, p));
    }
  }

  // XML de procesos\DTE del mes (índice por tipoSii-folio):
  //  - documento registrado sin XML  -> sinXml (probablemente nunca llegó al SII)
  //  - XML sin registro en Sisgen    -> documento EN BLANCO (se generó pero no quedó grabado)
  if (xml) {
    const registrados = new Set();
    for (const d of docs.values()) {
      if (!d.tipoSii) continue;
      const k = claveDoc(d.tipoSii, d.folio);
      registrados.add(k);
      d.sinXml = d.electronico !== false && TIPOS_CON_XML.has(d.tipoSii) && !xml.has(k);
    }
    for (const [k, x] of xml) {
      const ts = TIPO_SISGEN_POR_SII[x.tipoSii];
      if (registrados.has(k) || !ts) continue;
      docs.set(claveDoc(ts, x.folio), {
        ...nuevo(ts, x.folio, { fecha: x.fecha, rut: x.rutReceptor, nombre: x.nombreReceptor, monto: x.total }),
        neto: x.neto ?? 0, exento: x.exento ?? 0, iva: x.iva ?? 0, sinXml: false,
      });
    }
  }
  return [...docs.values()];
}

// ---------- XML de DTE (procesos\DTE\AAMM) ----------

const TIPOS_CON_XML = new Set([33, 34, 39, 41, 52, 56, 61, 110]);

/** '2026-10' -> '2610' (nombre de la carpeta mensual en procesos\DTE y procesos\logs) */
export const carpetaMes = (periodo) => periodo.slice(2, 4) + periodo.slice(5, 7);

/** Periodo desplazado en meses: ('2026-01', -1) -> '2025-12' */
export function periodoVecino(periodo, delta) {
  const [a, m] = periodo.split('-').map(Number);
  const d = new Date(a, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * Índice de los XML de DTE generados en un mes, solo a partir del NOMBRE del archivo:
 *   T33F49705-20250516-085356.xml -> tipo 33, folio 49705, fecha 2025-05-16
 * Un mismo folio puede tener varios XML (reintentos): se agrupan.
 * @returns {Map<string,{tipoSii,folio,fecha,archivos:string[],dir:string}>|null} null si no existe la carpeta
 */
export function leerIndiceXml(carpetaProcesos, periodo) {
  const dir = path.join(carpetaProcesos, 'DTE', carpetaMes(periodo));
  if (!fs.existsSync(dir)) return null;
  const idx = new Map();
  for (const archivo of fs.readdirSync(dir)) {
    const m = /^T(\d+)F(\d+)-(\d{4})(\d{2})(\d{2})/i.exec(archivo);
    if (!m) continue;
    const tipoSii = Number(m[1]), folio = Number(m[2]);
    const k = claveDoc(tipoSii, folio);
    if (!idx.has(k)) idx.set(k, { tipoSii, folio, fecha: `${m[3]}-${m[4]}-${m[5]}`, archivos: [], dir });
    idx.get(k).archivos.push(archivo);
  }
  return idx;
}

/** Datos del encabezado de un XML de DTE (receptor y montos). Solo lectura de etiquetas públicas. */
export function leerDatosXml(ruta) {
  const xml = fs.readFileSync(ruta, 'latin1');
  const tag = (t) => new RegExp(`<${t}>([^<]*)</${t}>`, 'i').exec(xml)?.[1]?.trim() ?? null;
  const num = (t) => (tag(t) == null ? null : Number(tag(t)));
  return {
    fecha: tag('FchEmis'), rutReceptor: tag('RUTRecep'), nombreReceptor: tag('RznSocRecep'),
    neto: num('MntNeto'), exento: num('MntExe'), iva: num('IVA'), total: num('MntTotal'),
  };
}

/**
 * Lee y consolida todo lo emitido en el mes en una sucursal.
 * @param {string} carpetaDatos     carpeta datos de Sisgen
 * @param {string} periodo          YYYY-MM
 * @param {string} [carpetaProcesos] carpeta procesos de Sisgen (XML de DTE)
 * @returns {{ docs, avisos, xmlOtrosMeses: Array<{tipoSii,folio,fecha}> }}
 */
export function leerDocumentosMes(carpetaDatos, periodo, carpetaProcesos = null) {
  const avisos = [];
  const detalle = leerDetalleMes(carpetaDatos, periodo);
  if (!detalle) avisos.push('No existe F2 del mes: no se puede detectar documentos sin detalle');
  const clidocto = leerClidoctoMes(carpetaDatos, periodo);
  if (!clidocto) avisos.push('No existe CLIDOCTO.DBF');
  const clipagos = leerClipagosMes(carpetaDatos, periodo);
  if (!clipagos) avisos.push('No existe CLIPAGOS.DBF');
  const f1 = leerVentasMes(carpetaDatos, periodo);

  let xml = null;
  const xmlOtrosMeses = [];
  if (carpetaProcesos) {
    xml = leerIndiceXml(carpetaProcesos, periodo);
    if (!xml) avisos.push(`No existe procesos\\DTE\\${carpetaMes(periodo)}: no se puede verificar XML`);
    else {
      // Solo se abre el XML de los documentos que no están registrados en ninguna tabla
      const conocidos = new Set(
        [...f1, ...(clidocto ?? []), ...(clipagos ?? [])]
          .filter((d) => tipoSii(d.tipoSisgen)).map((d) => claveDoc(tipoSii(d.tipoSisgen), d.folio))
      );
      for (const [k, x] of xml) {
        if (conocidos.has(k) || !TIPO_SISGEN_POR_SII[x.tipoSii]) continue;
        try {
          Object.assign(x, leerDatosXml(path.join(x.dir, x.archivos.sort().at(-1))));
        } catch { /* sin datos: queda con monto 0 */ }
      }
    }
    // Meses vecinos: para saber si un "salto" de folio se emitió en otro mes
    for (const p of [periodoVecino(periodo, -1), periodoVecino(periodo, 1)]) {
      for (const x of leerIndiceXml(carpetaProcesos, p)?.values() ?? []) {
        xmlOtrosMeses.push({ tipoSii: x.tipoSii, folio: x.folio, fecha: x.fecha });
      }
    }
  }
  const docs = consolidar({ f1, detalle, clidocto, clipagos, xml });
  return { docs, avisos, xmlOtrosMeses };
}

/**
 * Rangos de folios (CAF) cargados en una sucursal.
 * Los CAF están en <instalación Sisgen>\procesos\Folios, uno por archivo, con el rango en el nombre:
 *   t39d525201h535200.xml  -> tipo 39, folios 525201 a 535200
 * Si el nombre no sigue ese formato se lee el rango del propio XML (<TD>, <RNG><D>/<H>).
 * Solo se extraen tipo y rango: la clave privada del CAF nunca se lee ni se guarda.
 * Cada sucursal carga sus propios CAF, así que esto define qué folios le corresponden.
 * @param {string} carpetaProcesos carpeta procesos de la sucursal
 * @returns {Array<{ tipoSii, desde, hasta, archivo }>|null} null si no existe la carpeta Folios
 */
export function leerCafs(carpetaProcesos) {
  const dir = path.join(carpetaProcesos, 'Folios');
  if (!fs.existsSync(dir)) return null;
  const rangos = [];
  for (const archivo of fs.readdirSync(dir)) {
    if (!/\.xml$/i.test(archivo)) continue;
    let m = /^t(\d+)d(\d+)h(\d+)\.xml$/i.exec(archivo);
    let tipo, desde, hasta;
    if (m) {
      [tipo, desde, hasta] = m.slice(1).map(Number);
    } else {
      const xml = fs.readFileSync(path.join(dir, archivo), 'latin1');
      const td = /<TD>\s*(\d+)\s*<\/TD>/i.exec(xml);
      const rng = /<RNG>\s*<D>\s*(\d+)\s*<\/D>\s*<H>\s*(\d+)\s*<\/H>\s*<\/RNG>/i.exec(xml);
      if (!td || !rng) continue;
      [tipo, desde, hasta] = [td[1], rng[1], rng[2]].map(Number);
    }
    rangos.push({ tipoSii: tipo, desde, hasta, archivo });
  }
  return rangos;
}

/** "11.111.111-1" / "111111111" -> "11111111-1" */
export function normalizarRut(rut) {
  const limpio = String(rut).replace(/[^0-9kK]/g, '').toUpperCase();
  if (limpio.length < 2) return limpio;
  return `${parseInt(limpio.slice(0, -1), 10)}-${limpio.slice(-1)}`;
}
