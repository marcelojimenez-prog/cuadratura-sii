// Registro de Compras y Ventas (RCV) del SII — solo lectura.
// Servicio JSON usado por la consulta web del RCV (www4.sii.cl/consdcvinternetui),
// autenticado con el TOKEN obtenido con el certificado (cookie TOKEN).
//   getResumen      -> totales del periodo por tipo de documento
//   getDetalleVenta -> documentos uno a uno de un tipo (facturas, notas de crédito/débito, …)
// Las boletas (35, 38, 39, 41, …) vienen solo como RESUMEN: no hay detalle por documento.
import crypto from 'node:crypto';

const URL_BASE = 'https://www4.sii.cl/consdcvinternetui/services/data/facadeService';
const NAMESPACE = 'cl.sii.sdi.lob.diii.consdcv.data.api.interfaces.FacadeService';
const TIMEOUT_MS = 120000;

export class ErrorRcv extends Error {
  constructor(metodo, mensaje) {
    super(`RCV ${metodo}: ${mensaje}`);
    this.name = 'ErrorRcv';
  }
}

// El SII responde a veces HTTP 5xx transitorios: se reintenta antes de fallar
const REINTENTOS = 3;

async function llamar(token, metodo, data) {
  for (let intento = 1; ; intento++) {
    try {
      return await llamarUnaVez(token, metodo, data);
    } catch (e) {
      const transitorio = e.transitorio || e.name === 'TimeoutError' || e.name === 'TypeError';
      if (!transitorio || intento >= REINTENTOS) throw e;
      await new Promise((r) => setTimeout(r, 3000 * intento));
    }
  }
}

async function llamarUnaVez(token, metodo, data) {
  const res = await fetch(`${URL_BASE}/${metodo}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/plain, */*',
      Cookie: `TOKEN=${token}`,
      'User-Agent': 'Mozilla/5.0',
      Origin: 'https://www4.sii.cl',
      Referer: 'https://www4.sii.cl/consdcvinternetui/',
    },
    body: JSON.stringify({
      metaData: { namespace: `${NAMESPACE}/${metodo}`, conversationId: token, transactionId: crypto.randomUUID(), page: null },
      data,
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw Object.assign(new ErrorRcv(metodo, `HTTP ${res.status}`), { transitorio: res.status >= 500 });
  const json = await res.json();
  const est = json.respEstado;
  if (est && est.codRespuesta !== 0) throw new ErrorRcv(metodo, `${est.codRespuesta} ${est.msgeRespuesta ?? est.codError ?? ''}`.trim());
  return json;
}

const base = (rut, periodo) => {
  const [num, dv] = rut.split('-');
  return { rutEmisor: num, dvEmisor: dv.toUpperCase(), ptributario: periodo.replace('-', ''), estadoContab: 'REGISTRO', operacion: 'VENTA', busquedaInicial: true };
};

/**
 * Totales del Registro de Ventas por tipo de documento.
 * @returns {Promise<Array<{ tipoSii, nombre, tipoIngreso:'RESUMEN'|'DET_ELE'|string, totDoc, montoNeto, montoExento, montoIva, montoTotal }>>}
 */
export async function rcvResumenVentas(token, rut, periodo) {
  const json = await llamar(token, 'getResumen', base(rut, periodo));
  return (json.data ?? []).map((r) => ({
    tipoSii: r.rsmnTipoDocInteger,
    nombre: (r.dcvNombreTipoDoc ?? '').trim(),
    tipoIngreso: r.dcvTipoIngresoDoc,
    totDoc: r.rsmnTotDoc ?? 0,
    montoNeto: r.rsmnMntNeto ?? 0,
    montoExento: r.rsmnMntExe ?? 0,
    montoIva: r.rsmnMntIVA ?? 0,
    montoTotal: r.rsmnMntTotal ?? 0,
  }));
}

const fechaIso = (f) => (f && /^\d{2}\/\d{2}\/\d{4}/.test(f) ? `${f.slice(6, 10)}-${f.slice(3, 5)}-${f.slice(0, 2)}` : null);

/**
 * Documentos del Registro de Ventas de un tipo (uno a uno).
 * @returns {Promise<Array>} filas listas para docs_sii
 */
export async function rcvDetalleVentas(token, rut, periodo, tipoSii) {
  const json = await llamar(token, 'getDetalleVenta', { ...base(rut, periodo), codTipoDoc: Number(tipoSii) });
  return (json.data ?? []).map((d) => ({
    rutEmisor: rut,
    periodo,
    tipoSii: d.detTipoDoc,
    folio: Number(d.detNroDoc),
    fecha: fechaIso(d.detFchDoc),
    rutReceptor: d.detRutDoc ? `${d.detRutDoc}-${d.detDvDoc}` : null,
    total: d.detMntTotal ?? 0,
    estado: d.detAnulado ? 'ANULADO' : 'REGISTRADO',
    motivo: d.detAnulado ? 'Documento anulado en el Registro de Ventas' : null,
    fuente: 'RCV',
  }));
}
