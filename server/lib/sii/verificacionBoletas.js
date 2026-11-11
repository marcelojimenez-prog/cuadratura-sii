// Verificación de boletas una a una en la API de boletas del SII.
//
// El Registro de Ventas solo entrega el TOTAL mensual de boletas. Cuando Sisgen tiene más boletas
// (o más monto) que el SII, se consultan todas las boletas del mes en la API para encontrar
// exactamente cuáles no llegaron (FAU), llegaron con otros datos (DNK) o están anuladas (FAN).
// La API responde rápido (~35.000 boletas en 2-3 minutos con 5 consultas en paralelo).

/**
 * Consulta una lista de boletas con concurrencia limitada.
 * @param {Array} boletas
 * @param {(b) => Promise<{codigo:string|null, descripcion?:string}>} consultar
 * @param {{ concurrencia?: number, alAvanzar?: (hechas:number, total:number) => void }} [op]
 * @returns {Promise<Array<{ boleta, codigo, descripcion }>>} en el mismo orden que `boletas`
 */
export async function verificarBoletas(boletas, consultar, op = {}) {
  const concurrencia = Math.max(1, op.concurrencia ?? 5);
  const salida = new Array(boletas.length);
  let siguiente = 0, hechas = 0;
  async function trabajador() {
    while (siguiente < boletas.length) {
      const i = siguiente++;
      const r = await consultar(boletas[i]);
      salida[i] = { boleta: boletas[i], codigo: r?.codigo ?? null, descripcion: r?.descripcion ?? null };
      hechas++;
      op.alAvanzar?.(hechas, boletas.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrencia, boletas.length) }, trabajador));
  return salida;
}

/**
 * ¿Hay que barrer todas las boletas del tipo? Sí cuando Sisgen, descontando las ya confirmadas
 * como no recibidas, tiene más documentos que el SII, o la misma cantidad con otro monto.
 * (Si el SII tiene MÁS, la diferencia se busca fuera de Sisgen: ver foliosExternos.js.)
 */
export function requiereBarrido({ sisgenDocs, sisgenMonto, siiDocs, siiMonto, conocidasDocs = 0, conocidasMonto = 0 }, tolerancia = 1) {
  const docs = sisgenDocs - conocidasDocs;
  const monto = sisgenMonto - conocidasMonto;
  if (docs > siiDocs) return true;
  return docs === siiDocs && Math.abs(monto - siiMonto) > tolerancia;
}
