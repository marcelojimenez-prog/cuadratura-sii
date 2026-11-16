// Documentos corregidos y republicados (p. ej. una boleta "en blanco" que se vuelve a emitir días después):
// cuando llega su XML nuevo, el portal pide al agente las ventas de ese mes al momento y luego consulta
// al SII ese mes, para que el documento aparezca aceptado en minutos y no recién en la revisión nocturna.
const urgentes = new Map(); // agenteId -> Set(periodo)
const timers = new Map();   // 'rut|periodo' -> timeout

let consultar = async () => {};
/** El programador entrega la función que consulta al SII una razón social y periodo. */
export function fijarConsultaPeriodo(fn) { consultar = fn; }

export const ESPERA_SIN_RESPUESTA_MS = 3 * 60 * 1000; // si el agente no reenvía el mes (versión antigua)
export const ESPERA_TRAS_MES_MS = 20 * 1000;

// Después de la primera consulta se vuelve a mirar por si el SII aún no terminaba de procesar el documento
export const REVISIONES_EXTRA_MS = [5 * 60 * 1000, 15 * 60 * 1000];

function programar(rut, periodo, ms, extra = true) {
  const k = `${rut}|${periodo}|${extra ? 'principal' : ms}`;
  clearTimeout(timers.get(k));
  const t = setTimeout(() => {
    timers.delete(k);
    consultar(rut, periodo).catch((e) => console.error(`[corrección] ${rut} ${periodo}: ${e.message}`));
    if (extra) for (const r of REVISIONES_EXTRA_MS) programar(rut, periodo, r, false);
  }, ms);
  t.unref?.();
  timers.set(k, t);
}

/** Llegaron documentos corregidos de estos periodos. */
export function registrarCorreccion(agente, periodos) {
  for (const p of new Set(periodos)) {
    if (!urgentes.has(agente.id)) urgentes.set(agente.id, new Set());
    urgentes.get(agente.id).add(p);
    programar(agente.rut, p, ESPERA_SIN_RESPUESTA_MS);
  }
}

/** Meses que el agente debe reenviar ya (van en la respuesta de /hola). */
export function mesesUrgentes(agenteId) {
  return [...(urgentes.get(agenteId) ?? [])];
}

/** El agente envió las ventas de un mes: si estaba pendiente por una corrección, se consulta al SII en seguida. */
export function mesRecibido(agente, periodo) {
  const s = urgentes.get(agente.id);
  if (!s?.has(periodo)) return false;
  s.delete(periodo);
  programar(agente.rut, periodo, ESPERA_TRAS_MES_MS);
  return true;
}

export function _limpiar() {
  urgentes.clear();
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
}
