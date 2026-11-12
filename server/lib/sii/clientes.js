// "Clientes SII": la misma interfaz para consultar al SII con el certificado de este equipo (local)
// o a través del agente del cliente (remoto, el certificado nunca sale de su servidor).
import { cargarCertificado } from './certificado.js';
import { obtenerToken } from './autenticacion.js';
import { rcvResumenVentas, rcvDetalleVentas, base, revisarRcv, mapearResumen, mapearDetalle, ErrorRcv } from './rcv.js';
import { obtenerTokenBoletas, consultarEstadoBoleta } from './boletas.js';
import { pedir } from './remoto.js';

/** Con un certificado configurado en este equipo (config.local.json). */
export function clienteLocal(certificado, ambiente = 'produccion') {
  let token = null, tokenBol = null;
  const cert = () => cargarCertificado(certificado);
  return {
    async rcvResumen(rut, periodo) {
      token ??= await obtenerToken(cert(), ambiente);
      return rcvResumenVentas(token, rut, periodo);
    },
    async rcvDetalle(rut, periodo, tipo) {
      token ??= await obtenerToken(cert(), ambiente);
      return rcvDetalleVentas(token, rut, periodo, tipo);
    },
    async estadoBoleta(b) {
      tokenBol ??= await obtenerTokenBoletas(cert(), ambiente);
      return consultarEstadoBoleta(tokenBol, b, ambiente);
    },
  };
}

const json = (cuerpo) => { try { return JSON.parse(cuerpo); } catch { return cuerpo; } };

async function rcvRemoto(rut, metodo, data) {
  for (let intento = 1; ; intento++) {
    const r = await pedir(rut, 'rcv', { metodo, data: JSON.stringify(data) });
    if (r.http >= 500 && intento < 3) { await new Promise((ok) => setTimeout(ok, 3000 * intento)); continue; }
    if (r.http !== 200) throw new ErrorRcv(metodo, `HTTP ${r.http}`);
    return revisarRcv(metodo, JSON.parse(r.cuerpo));
  }
}

/** A través del agente del cliente. */
export function clienteRemoto() {
  return {
    async rcvResumen(rut, periodo) {
      return mapearResumen(await rcvRemoto(rut, 'getResumen', base(rut, periodo)));
    },
    async rcvDetalle(rut, periodo, tipo) {
      return mapearDetalle(await rcvRemoto(rut, 'getDetalleVenta', { ...base(rut, periodo), codTipoDoc: Number(tipo) }), rut, periodo);
    },
    async estadoBoleta(b) {
      const [rr, dr] = (b.rutReceptor || '66666666-6').split('-');
      const [a, m, d] = b.fecha.split('-');
      const r = await pedir(b.rutEmisor, 'boleta', {
        tipo: String(b.tipoSii), folio: String(b.folio), rutReceptor: rr, dvReceptor: dr,
        monto: String(Math.round(b.monto)), fecha: `${d}-${m}-${a}`,
      });
      return { http: r.http, respuesta: json(r.cuerpo) };
    },
  };
}
