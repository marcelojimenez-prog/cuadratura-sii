// Lo que llevaba un documento "en blanco", en dos lugares de Sisgen:
//  1) Carpeta "backup" de la estación de trabajo (cada caja tiene la suya) (junto a datos y procesos): un archivo por día (AAAAMMDD.dbf) con el detalle
// de lo vendido. Cuando un documento queda "en blanco" (no se grabó completo), ahí suele estar lo que llevaba.
//   CODMAT = tipo + folio (BE001124718)   OBSERV = "HH:MM:SS  RUT"   DESCRI, CANTID, PRECIO, DESCTO, MTOTAL
import fs from 'node:fs';
import path from 'node:path';
import { leerRegistros, buscarArchivo } from './dbf.js';

const CAMPOS = ['CODIGO', 'CODMAT', 'DESCRI', 'OBSERV', 'CANTID', 'PRECIO', 'DESCTO', 'MTOTAL'];

/** Carpeta backup de una instalación Sisgen a partir de su carpeta de datos (…\sisgen\datos -> …\sisgen\backup). */
export function carpetaRespaldo(carpetaDatos) {
  const raiz = path.dirname(path.resolve(carpetaDatos));
  for (const n of ['backup', 'BACKUP', 'Backup']) {
    const c = path.join(raiz, n);
    if (fs.existsSync(c)) return c;
  }
  return null;
}

const diaSiguiente = (fecha) => {
  const d = new Date(fecha + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};

/** Separa CODMAT en tipo y folio: 'BE001124718' -> ['BE', 1124718]. */
export function documentoDeCodmat(codmat) {
  const m = /^([A-Z]{2})0*(\d+)$/.exec(String(codmat ?? '').trim().toUpperCase());
  return m ? [m[1], parseInt(m[2], 10)] : null;
}

/** Arma el resultado de un documento a partir de sus líneas en el respaldo (función pura). */
export function armarRespaldo(lineas, archivo) {
  if (!lineas.length) return { encontrado: false };
  const obs = String(lineas[0].OBSERV ?? '');
  const hora = /(\d{1,2}:\d{2}(:\d{2})?)/.exec(obs)?.[1] ?? null;
  const rutCliente = /(\d{1,9}-[\dkK])/.exec(obs)?.[1] ?? null;
  const items = lineas.map((r) => ({
    codigo: String(r.CODIGO ?? '').trim() || null,
    descripcion: String(r.DESCRI ?? '').trim(),
    cantidad: Number(r.CANTID ?? 0),
    precio: Number(r.PRECIO ?? 0),
    descuento: Number(r.DESCTO ?? 0),
    total: Number(r.MTOTAL ?? 0),
  }));
  return { encontrado: true, fuente: 'BACKUP', archivo, hora, rutCliente, total: items.reduce((s, x) => s + x.total, 0), lineas: items };
}

/**
 * Busca documentos en el respaldo del día de su fecha (y del día siguiente, por si se grabó pasada la medianoche).
 * @param {string} carpeta carpeta backup
 * @param {Array<{tipoSisgen, folio, fecha}>} docs
 * @returns {Map<string, object>} 'BE-1124718' -> resultado (encontrado o no)
 */
export function buscarEnRespaldo(carpeta, docs) {
  const resultado = new Map();
  const porArchivo = new Map(); // AAAAMMDD -> Set de claves buscadas
  for (const d of docs) {
    const k = `${d.tipoSisgen}-${d.folio}`;
    resultado.set(k, { encontrado: false });
    if (!d.fecha) continue;
    for (const f of [d.fecha, diaSiguiente(d.fecha)]) {
      const n = f.replaceAll('-', '');
      if (!porArchivo.has(n)) porArchivo.set(n, new Set());
      porArchivo.get(n).add(k);
    }
  }
  for (const [dia, claves] of porArchivo) {
    const ruta = buscarArchivo(carpeta, `${dia}.dbf`);
    if (!ruta) continue;
    const lineas = new Map();
    try {
      for (const r of leerRegistros(ruta, { campos: CAMPOS })) {
        const doc = documentoDeCodmat(r.CODMAT);
        if (!doc) continue;
        const k = `${doc[0]}-${doc[1]}`;
        if (!claves.has(k) || resultado.get(k).encontrado) continue;
        if (!lineas.has(k)) lineas.set(k, []);
        lineas.get(k).push(r);
      }
    } catch { continue; }
    for (const [k, ls] of lineas) resultado.set(k, armarRespaldo(ls, path.basename(ruta)));
  }
  return resultado;
}

// ---------- 2) Tabla DT del mes (DTMMAAAA.dbf, movimientos de inventario) ----------
//   TIPO + NUMERO (BE / 001700007), CODPRO, DESCRI, SALE (cantidad). No guarda el precio de venta.
const CAMPOS_DT = ['TIPO', 'NUMERO', 'CODPRO', 'DESCRI', 'SALE', 'ENTRA'];

/** Arma el resultado desde líneas de la tabla DT (función pura). */
export function armarDesdeDt(lineas, archivo) {
  if (!lineas.length) return { encontrado: false };
  const items = lineas.map((r) => ({
    codigo: String(r.CODPRO ?? '').trim() || null,
    descripcion: String(r.DESCRI ?? '').trim(),
    cantidad: Number(r.SALE ?? 0) || Number(r.ENTRA ?? 0) || 0,
    precio: null, descuento: 0, total: null,
  }));
  return { encontrado: true, fuente: 'DT', archivo, hora: null, rutCliente: null, total: null, lineas: items };
}

/**
 * Busca documentos en la tabla DT del mes de su fecha.
 * @param {string} carpetaDatos carpeta datos de Sisgen
 * @param {Array<{tipoSisgen, folio, fecha}>} docs
 * @returns {Map<string, object>} 'BE-1700007' -> resultado
 */
export function buscarEnDt(carpetaDatos, docs) {
  const resultado = new Map();
  const porMes = new Map();
  for (const d of docs) {
    const k = `${d.tipoSisgen}-${d.folio}`;
    resultado.set(k, { encontrado: false });
    if (!d.fecha) continue;
    const n = `DT${d.fecha.slice(5, 7)}${d.fecha.slice(0, 4)}.dbf`;
    if (!porMes.has(n)) porMes.set(n, new Set());
    porMes.get(n).add(k);
  }
  for (const [nombre, claves] of porMes) {
    let ruta;
    try { ruta = buscarArchivo(carpetaDatos, nombre); } catch { ruta = null; }
    if (!ruta) continue;
    const lineas = new Map();
    try {
      for (const r of leerRegistros(ruta, { campos: CAMPOS_DT })) {
        const k = `${String(r.TIPO ?? '').trim().toUpperCase()}-${parseInt(r.NUMERO, 10)}`;
        if (!claves.has(k)) continue;
        if (!lineas.has(k)) lineas.set(k, []);
        lineas.get(k).push(r);
      }
    } catch { continue; }
    for (const [k, ls] of lineas) resultado.set(k, armarDesdeDt(ls, path.basename(ruta)));
  }
  return resultado;
}

/** Backup de la estación y, para lo que no esté ahí, la tabla DT del mes. */
export function buscarDetalleBlancos(carpetaDatos, docs) {
  const bk = carpetaRespaldo(carpetaDatos);
  const r = bk ? buscarEnRespaldo(bk, docs) : new Map(docs.map((d) => [`${d.tipoSisgen}-${d.folio}`, { encontrado: false }]));
  const faltan = docs.filter((d) => !r.get(`${d.tipoSisgen}-${d.folio}`)?.encontrado);
  if (faltan.length) for (const [k, v] of buscarEnDt(carpetaDatos, faltan)) if (v.encontrado) r.set(k, v);
  return r;
}
