// Datos de Sisgen que el XML del DTE no trae y que van en la representación impresa:
//   - logo de la empresa         <sisgen>\formatos\DTE\dtelogo.jpg
//   - oficina del SII            empres.dbf DTEOFISII
//   - resolución que autoriza    empres.dbf DTENUMRES / DTEFECRES
//   - detalle de líneas (F2)     para boletas cuyo XML no incluye <Detalle>
// Todo es solo lectura y se cachea unos minutos (se lee por red).
import fs from 'node:fs';
import path from 'node:path';
import { leerRegistros, buscarArchivo } from '../sisgen/dbf.js';

const CACHE_MS = 10 * 60 * 1000;
const cache = new Map();
function memo(clave, fn) {
  const c = cache.get(clave);
  if (c && c.hasta > Date.now()) return c.valor;
  const valor = fn();
  cache.set(clave, { valor, hasta: Date.now() + CACHE_MS });
  return valor;
}

/** Logo, oficina SII y resolución de la sucursal. */
export function extrasSucursal({ rutaDatos, rutaProcesos }) {
  return memo(`suc|${rutaDatos}|${rutaProcesos}`, () => {
    const extras = { logo: null, oficinaSii: null, resolucionNumero: null, resolucionAnio: null };
    if (rutaProcesos) {
      const dir = path.join(path.dirname(rutaProcesos), 'formatos', 'DTE');
      try {
        const f = fs.readdirSync(dir).find((x) => x.toLowerCase() === 'dtelogo.jpg');
        if (f) extras.logo = fs.readFileSync(path.join(dir, f));
      } catch { /* sin logo */ }
    }
    if (rutaDatos) {
      try {
        const ruta = buscarArchivo(rutaDatos, 'empres.dbf');
        for (const r of leerRegistros(ruta, { campos: ['DTEOFISII', 'DTENUMRES', 'DTEFECRES'] })) {
          extras.oficinaSii = r.DTEOFISII || null;
          extras.resolucionNumero = r.DTENUMRES || null;
          extras.resolucionAnio = r.DTEFECRES ? r.DTEFECRES.slice(0, 4) : null;
          break;
        }
      } catch { /* sin datos de empresa */ }
    }
    return extras;
  });
}

/**
 * Líneas de detalle de un documento desde la tabla F2 del mes (Sisgen).
 * Se indexa la tabla completa una vez y se cachea.
 */
export function detalleDesdeF2({ rutaDatos, periodo, tipoSisgen, folio }) {
  if (!rutaDatos || !periodo || !tipoSisgen) return [];
  const [a, m] = periodo.split('-');
  const indice = memo(`f2|${rutaDatos}|${periodo}`, () => {
    const idx = new Map();
    const ruta = buscarArchivo(rutaDatos, `F2${m}${a}.dbf`);
    if (!ruta) return idx;
    const campos = ['DETDOCTO', 'DENUMFAC', 'DECODPRO', 'DEDESPRO', 'DECANTIDAD', 'DEVALOR', 'DETOTAL', 'DEDSCTO'];
    for (const r of leerRegistros(ruta, { campos })) {
      const f = parseInt(r.DENUMFAC, 10);
      if (!r.DETDOCTO || !Number.isFinite(f) || !r.DEDESPRO) continue;
      const k = `${r.DETDOCTO.toUpperCase()}-${f}`;
      if (!idx.has(k)) idx.set(k, []);
      idx.get(k).push({
        codigo: r.DECODPRO || '', nombre: r.DEDESPRO, cantidad: r.DECANTIDAD, precio: r.DEVALOR,
        descuentoPct: r.DEDSCTO || null, monto: r.DETOTAL,
      });
    }
    return idx;
  });
  return indice.get(`${tipoSisgen.toUpperCase()}-${folio}`) ?? [];
}
