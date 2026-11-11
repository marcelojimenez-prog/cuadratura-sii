// Detección de boletas emitidas FUERA de Sisgen.
//
// El SII solo entrega las boletas como total del mes. Cuando el SII informa más boletas que
// las que tienen todas las sucursales, se buscan folios recibidos por el SII que no pertenecen
// a ningún CAF cargado en las sucursales (otro equipo emitiendo con el mismo RUT).
//
// Método: los huecos entre los CAF conocidos se sondean en la API de boletas. La API responde
// sin necesidad de conocer el monto: DNK/DOK/FAN = el folio fue recibido por el SII,
// FAU = autorizado pero no recibido (sin usar), FNA = folio nunca autorizado.
//  - Hueco cuyo primer folio fue recibido y el último NO: CAF ajeno en uso; se busca por
//    bisección el último folio recibido (los folios se usan en orden).
//  - Hueco completamente recibido: CAF antiguo ya agotado (meses anteriores); se ignora.
//  - Sobre el último CAF conocido: si el folio siguiente fue recibido, se busca hacia arriba.

export const RECIBIDO = 'RECIBIDO';
export const AUTORIZADO = 'AUTORIZADO';
export const NO_AUTORIZADO = 'NO_AUTORIZADO';

/** Traduce el código de la API de boletas a si el folio existe en el SII. */
export function existenciaDesdeCodigo(codigo) {
  if (['DOK', 'DNK', 'FAN'].includes(codigo)) return RECIBIDO;
  if (codigo === 'FAU') return AUTORIZADO;
  if (codigo === 'FNA') return NO_AUTORIZADO;
  return null; // respuesta desconocida: no se concluye nada
}

/**
 * Huecos entre los CAF conocidos de un tipo (todas las sucursales del RUT).
 * @param {Array<{desde:number, hasta:number, sucursal?:string}>} rangos
 * @returns {Array<{desde:number, hasta:number|null, antes:string|null, despues:string|null}>}
 *          hasta = null para el tramo sobre el último CAF.
 */
export function huecosCaf(rangos) {
  const ord = [...rangos].sort((a, b) => a.desde - b.desde);
  const huecos = [];
  let fin = null, suc = null;
  for (const r of ord) {
    if (fin != null && r.desde > fin + 1) huecos.push({ desde: fin + 1, hasta: r.desde - 1, antes: suc, despues: r.sucursal ?? null });
    if (fin == null || r.hasta > fin) { fin = r.hasta; suc = r.sucursal ?? null; }
  }
  if (fin != null) huecos.push({ desde: fin + 1, hasta: null, antes: suc, despues: null });
  return huecos;
}

const MAX_SALTO_ARRIBA = 1 << 20;

/**
 * Busca bloques de folios recibidos por el SII dentro de los huecos.
 * @param {ReturnType<typeof huecosCaf>} huecos
 * @param {(folio:number) => Promise<string|null>} existencia  RECIBIDO | AUTORIZADO | NO_AUTORIZADO | null
 * @returns {Promise<Array<{desde, ultimo, cantidad, antes, despues}>>}
 */
export async function detectarFoliosExternos(huecos, existencia) {
  const bloques = [];
  for (const h of huecos) {
    if ((await existencia(h.desde)) !== RECIBIDO) continue;
    let lo = h.desde; // recibido
    let hi;            // primer folio conocido NO recibido
    if (h.hasta != null) {
      const fin = await existencia(h.hasta);
      if (fin === RECIBIDO || fin == null) continue; // CAF antiguo agotado, o sin respuesta clara
      hi = h.hasta;
    } else {
      // Sobre el último CAF: avanzar en saltos crecientes hasta encontrar un folio no recibido
      let paso = 1;
      for (;;) {
        const f = lo + paso;
        const e = await existencia(f);
        if (e == null) break;
        if (e !== RECIBIDO) { hi = f; break; }
        lo = f;
        if (paso >= MAX_SALTO_ARRIBA) break;
        paso *= 2;
      }
      if (hi == null) continue;
    }
    while (hi - lo > 1) {
      const m = Math.floor((lo + hi) / 2);
      const e = await existencia(m);
      if (e == null) break;
      if (e === RECIBIDO) lo = m; else hi = m;
    }
    bloques.push({ desde: h.desde, ultimo: lo, cantidad: lo - h.desde + 1, antes: h.antes, despues: h.despues });
  }
  return bloques;
}
