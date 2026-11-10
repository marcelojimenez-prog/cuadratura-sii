// Ubica en la carpeta procesos de Sisgen el XML y el timbre de un documento.
//   procesos\DTE\AAMM\T{tipo}F{folio}-{AAAAMMDD}-{HHMMSS}.xml   (puede haber varios: reintentos)
//   procesos\Firmas\T{tipo}_F{folio}.png                        (timbre PDF417 ya dibujado por Sisgen)
// Los listados de carpetas se cachean unos minutos: por red, una carpeta mensual puede tener
// decenas de miles de archivos.
import fs from 'node:fs';
import path from 'node:path';
import { carpetaMes, periodoVecino } from '../sisgen/importar.js';

const CACHE_MS = 10 * 60 * 1000;
const cache = new Map(); // dir -> { hasta, archivos }

function listar(dir) {
  const c = cache.get(dir);
  if (c && c.hasta > Date.now()) return c.archivos;
  let archivos = [];
  try { archivos = fs.readdirSync(dir); } catch { /* carpeta inexistente o sin acceso */ }
  cache.set(dir, { hasta: Date.now() + CACHE_MS, archivos });
  return archivos;
}

/**
 * Todos los XML del documento (puede haber varios: reintentos o regeneraciones de Sisgen),
 * buscando en la carpeta del mes de emisión y en la del mes siguiente. Ordenados por nombre
 * (= fecha y hora de generación).
 */
export function rutasXml({ rutaProcesos, tipoSii, folio, fecha }) {
  if (!rutaProcesos || !fecha) return [];
  const prefijo = `t${tipoSii}f${folio}-`;
  const periodo = fecha.slice(0, 7);
  const rutas = [];
  for (const p of [periodo, periodoVecino(periodo, 1)]) {
    const dir = path.join(rutaProcesos, 'DTE', carpetaMes(p));
    for (const f of listar(dir)) {
      if (f.toLowerCase().startsWith(prefijo) && /\.xml$/i.test(f)) rutas.push({ ruta: path.join(dir, f), nombre: f.toLowerCase() });
    }
  }
  return rutas.sort((a, b) => a.nombre.localeCompare(b.nombre)).map((r) => r.ruta);
}

/**
 * Elige el XML a entregar: el más reciente que traiga el detalle (<Detalle>). Sisgen a veces
 * regenera el XML sin detalle; en ese caso se prefiere una versión anterior completa.
 * @returns {{ ruta:string, texto:string }|null}
 */
export function elegirXml(rutas) {
  let ultimo = null;
  for (const ruta of [...rutas].reverse()) {
    let texto;
    try { texto = fs.readFileSync(ruta, 'latin1'); } catch { continue; }
    ultimo ??= { ruta, texto };
    if (/<Detalle>/i.test(texto)) return { ruta, texto };
  }
  return ultimo;
}

/** Ruta del PNG del timbre generado por Sisgen, si existe. */
export function rutaTimbre({ rutaProcesos, tipoSii, folio }) {
  if (!rutaProcesos) return null;
  const objetivo = `t${tipoSii}_f${folio}.png`;
  for (const carpeta of ['Firmas', 'firmas']) {
    const dir = path.join(rutaProcesos, carpeta);
    const f = listar(dir).find((x) => x.toLowerCase() === objetivo);
    if (f) return path.join(dir, f);
  }
  return null;
}
