// Conexión directa con el SII (Fase 1).
//
// Todas las consultas se autentican con el certificado digital (.pfx) de una persona
// autorizada por la empresa. Flujo de autenticación del SII:
//   1. Pedir una "semilla"            (servicio CrSeed)
//   2. Firmar la semilla con el .pfx  (XML-DSig)
//   3. Canjearla por un token         (servicio GetTokenFromSeed)
// Para la API REST de boletas el flujo es equivalente, pero sobre api.sii.cl.
//
// Fuentes de información previstas:
//   - RCV de ventas (Registro de Compras y Ventas): lo registrado por RUT y periodo. Cruce masivo.
//   - Estado de un DTE (QueryEstDte): verificación puntual de un documento.
//   - Estado de un envío (QueryEstUp, por TrackID): resultado y motivo de rechazo.
//   - API boletas electrónicas: estado de boletas (39/41), que en el RCV solo van resumidas.
//
// IMPORTANTE: endpoints, parámetros y códigos de respuesta se deben VERIFICAR contra la
// documentación vigente del SII al implementar cada función (no fiarse de memoria).
// Pendiente: certificado del cliente piloto y rutas de prueba.

import { cargarCertificado } from './certificado.js';
import { obtenerToken as obtenerTokenSii } from './autenticacion.js';

export class PendienteFase1 extends Error {
  constructor(funcion) {
    super(`${funcion}: pendiente (Fase 1, requiere certificado del cliente piloto)`);
    this.name = 'PendienteFase1';
  }
}

/**
 * @param {{ rut:string, certificado:{ rutaPfx:string, clave:string } }} empresa
 * @returns {Promise<string>} token de sesión SII
 */
export async function obtenerToken(empresa, ambiente = 'produccion') {
  return obtenerTokenSii(cargarCertificado(empresa.certificado), ambiente);
}

/**
 * Descarga el detalle del Registro de Ventas del SII.
 * @returns {Promise<Array<{ rutEmisor, periodo, tipoSii, folio, fecha, rutReceptor, total, estado:'REGISTRADO', fuente:'RCV' }>>}
 */
export async function descargarRcvVentas(empresa, periodo) {
  throw new PendienteFase1('descargarRcvVentas');
}

/**
 * Consulta el estado de un DTE puntual.
 * @returns {Promise<{ estado, motivo, codigoSii, glosaSii }>}
 */
export async function consultarEstadoDte(empresa, { tipoSii, folio, fecha, rutReceptor, total }) {
  throw new PendienteFase1('consultarEstadoDte');
}

/**
 * Consulta el resultado de un envío por TrackID (incluye detalle de rechazos/reparos).
 */
export async function consultarEstadoEnvio(empresa, trackId) {
  throw new PendienteFase1('consultarEstadoEnvio');
}

/**
 * Consulta el estado de una boleta electrónica (API REST boletas).
 */
export async function consultarBoleta(empresa, { tipoSii, folio, fecha, total }) {
  throw new PendienteFase1('consultarBoleta');
}
