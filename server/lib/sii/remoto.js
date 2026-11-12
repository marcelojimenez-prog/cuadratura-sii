// Consultas al SII a través del agente del cliente: el certificado se queda en su servidor.
// El portal deja "pedidos" en una cola por RUT; el agente los recoge (mantiene una conexión en
// espera), consulta al SII con su certificado y devuelve la respuesta.
import crypto from 'node:crypto';

const ESPERA_AGENTE_MS = 25000;   // cuánto se mantiene abierta la espera del agente
const LIMITE_PEDIDO_MS = 180000;  // un pedido sin respuesta se da por fallido
const MAX_POR_ENTREGA = 50;

const colas = new Map(); // rut -> { pendientes: [], esperando: [{res, timer}], ultimoContacto, certificado }
const enCurso = new Map(); // id -> { ok, error, timer, rut }

function cola(rut) {
  if (!colas.has(rut)) colas.set(rut, { pendientes: [], esperando: [], ultimoContacto: 0, certificado: null });
  return colas.get(rut);
}

/** true si hay un agente de ese RUT atento a consultas (contacto en el último minuto). */
export function agenteDisponible(rut) {
  const c = colas.get(rut);
  return !!c && Date.now() - c.ultimoContacto < 60000 && !!c.certificado && c.certificado.startsWith('ok');
}

export function estadoCertificado(rut) {
  return colas.get(rut)?.certificado ?? null;
}

function entregar(c) {
  while (c.esperando.length && c.pendientes.length) {
    const { res, timer } = c.esperando.shift();
    clearTimeout(timer);
    res.json({ pedidos: c.pendientes.splice(0, MAX_POR_ENTREGA) });
  }
}

/**
 * Pide una consulta al agente del RUT. Tipos: rcv | boleta | envioDte | envioBoleta.
 * @returns {Promise<{ http:number, cuerpo:string }>}
 */
export function pedir(rut, tipo, params) {
  const c = cola(rut);
  const id = crypto.randomUUID();
  return new Promise((ok, error) => {
    const timer = setTimeout(() => {
      enCurso.delete(id);
      error(new Error('El agente no respondió la consulta al SII a tiempo'));
    }, LIMITE_PEDIDO_MS);
    enCurso.set(id, { ok, error, timer, rut });
    c.pendientes.push({ id, tipo, params });
    entregar(c);
  });
}

/** El agente espera pedidos (long-poll). Responde de inmediato si hay, o a los 25 s vacío. */
export function agenteEspera(rut, certificado, res) {
  const c = cola(rut);
  c.ultimoContacto = Date.now();
  c.certificado = certificado ? String(certificado).slice(0, 200) : c.certificado;
  if (c.pendientes.length) return res.json({ pedidos: c.pendientes.splice(0, MAX_POR_ENTREGA) });
  const espera = { res, timer: null };
  espera.timer = setTimeout(() => {
    c.esperando = c.esperando.filter((e) => e !== espera);
    c.ultimoContacto = Date.now();
    res.json({ pedidos: [] });
  }, ESPERA_AGENTE_MS);
  res.on('close', () => { clearTimeout(espera.timer); c.esperando = c.esperando.filter((e) => e !== espera); });
  c.esperando.push(espera);
}

/** Respuestas del agente. Solo se aceptan pedidos que se hicieron a ESE RUT. */
export function agenteResponde(rut, resultados) {
  cola(rut).ultimoContacto = Date.now();
  let n = 0;
  for (const r of resultados ?? []) {
    const p = enCurso.get(r?.id);
    if (!p || p.rut !== rut) continue;
    enCurso.delete(r.id);
    clearTimeout(p.timer);
    if (r.error) p.error(new Error(`Agente: ${String(r.error).slice(0, 300)}`));
    else p.ok({ http: Number(r.http) || 0, cuerpo: String(r.cuerpo ?? '') });
    n++;
  }
  return n;
}
