// API REST oficial del SII para boletas electrónicas — solo consultas.
// Autenticación con el certificado (sin reCAPTCHA):
//   GET  /recursos/v1/boleta.electronica.semilla  -> semilla
//   POST /recursos/v1/boleta.electronica.token    -> token (semilla firmada, mismo formato XML-DSig que DTEWS)
// Consulta:
//   GET  /recursos/v1/boleta.electronica/{rut}-{dv}-{tipo}-{folio}/estado?rut_receptor&dv_receptor&monto&fechaEmision
// Producción: api.sii.cl · Certificación: apicert.sii.cl
import { firmarSemilla, ErrorSii } from './autenticacion.js';

const HOSTS = { produccion: 'api.sii.cl', certificacion: 'apicert.sii.cl' };
const TIMEOUT_MS = 30000;
const tag = (xml, t) => new RegExp(`<(?:\\w+:)?${t}>([^<]*)</(?:\\w+:)?${t}>`).exec(xml)?.[1]?.trim() ?? null;

export async function obtenerTokenBoletas(certificado, ambiente = 'produccion') {
  const host = HOSTS[ambiente];
  const rSem = await fetch(`https://${host}/recursos/v1/boleta.electronica.semilla`, {
    headers: { Accept: 'application/xml' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const xSem = await rSem.text();
  const semilla = tag(xSem, 'SEMILLA');
  if (!rSem.ok || !semilla) throw new ErrorSii('API boletas semilla', `HTTP ${rSem.status} estado ${tag(xSem, 'ESTADO') ?? '?'}`, xSem.slice(0, 400));

  const rTok = await fetch(`https://${host}/recursos/v1/boleta.electronica.token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/xml', Accept: 'application/xml' },
    body: firmarSemilla(semilla, certificado),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const xTok = await rTok.text();
  const token = tag(xTok, 'TOKEN');
  if (!rTok.ok || !token) {
    throw new ErrorSii('API boletas token', `HTTP ${rTok.status} estado ${tag(xTok, 'ESTADO') ?? '?'} ${tag(xTok, 'GLOSA') ?? ''}`.trim(), xTok.slice(0, 400));
  }
  return token;
}

/**
 * Traduce el código de la API de boletas al estado interno de docs_sii.
 *   DOK -> ACEPTADO · FAU -> NO_RECIBIDO · FAN -> ANULADO · otros (DNK, FNA, …) -> REPARO con la glosa
 */
export function estadoDesdeApi(codigo, descripcion) {
  const glosa = `${descripcion ?? ''} (${codigo})`.trim();
  if (codigo === 'DOK') return { estado: 'ACEPTADO', motivo: null };
  if (codigo === 'FAU') return { estado: 'NO_RECIBIDO', motivo: `Confirmado por la API de boletas del SII: ${glosa}` };
  if (codigo === 'FAN') return { estado: 'ANULADO', motivo: glosa };
  return { estado: 'REPARO', motivo: glosa };
}

/**
 * Estado de una boleta en el SII.
 * @param {{ rutEmisor, tipoSii, folio, fecha:'YYYY-MM-DD', monto, rutReceptor? }} b
 * @returns {Promise<{ http:number, respuesta:object|string }>} respuesta tal cual del SII
 */
export async function consultarEstadoBoleta(token, b, ambiente = 'produccion') {
  const [num, dv] = b.rutEmisor.split('-');
  const [rr, dr] = (b.rutReceptor || '66666666-6').split('-');
  const [a, m, d] = b.fecha.split('-');
  const qs = new URLSearchParams({ rut_receptor: rr, dv_receptor: dr, monto: String(Math.round(b.monto)), fechaEmision: `${d}-${m}-${a}` });
  const res = await fetch(`https://${HOSTS[ambiente]}/recursos/v1/boleta.electronica/${num}-${dv}-${b.tipoSii}-${b.folio}/estado?${qs}`, {
    headers: { Accept: 'application/json', Cookie: `TOKEN=${token}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const txt = await res.text();
  let respuesta = txt;
  try { respuesta = JSON.parse(txt); } catch { /* texto */ }
  return { http: res.status, respuesta };
}
