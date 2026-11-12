// Cuadratura completa y resúmenes por razón social / cliente para las pantallas del portal.
import {
  docsSisgen, docsSii, rangosCaf, xmlOtrosMeses, resumenSii, sincronizacionSii, foliosExternos, huellaDatos,
  sucursalesConLectura, ultimoFolioUsado, registradosEnOtroMes, enviosSii,
} from '../../db.js';
import { TIPOS_A_CUADRAR, NOMBRES_SII } from '../sisgen/tipos.js';
import { alertasVencimiento, marcarFoliosVencidos, marcarDocumentosVencidos } from '../sii/vigenciaCaf.js';
import { cuadrar } from './motor.js';
import { estadoAgente } from '../../agentes.js';

/** Resultado completo de cuadratura de una razón social en un periodo. */
export function calcularCuadratura(rut, periodo) {
  const sinc = sincronizacionSii(rut, periodo);
  const otrosMeses = xmlOtrosMeses(rut, periodo);
  const resultado = cuadrar(ajustarOtrosMeses(rut, periodo, docsSisgen(rut, periodo), otrosMeses), docsSii(rut, periodo), {
    rangos: rangosCaf(rut),
    xmlOtrosMeses: otrosMeses,
    resumenSii: resumenSii(rut, periodo),
    foliosExternos: foliosExternos(rut, periodo),
    envios: enviosSii(rut, periodo),
    // Con el RCV sincronizado, todo tipo tributario se considera consultado al SII
    ...(sinc ? { tiposConsultados: TIPOS_A_CUADRAR } : {}),
  });
  const hoy = new Date();
  const cafs = rangosCaf(rut);
  // Facturas/notas no recibidas por el SII con el CAF vencido: hay que anular el folio
  marcarFoliosVencidos(resultado.alertas, cafs, hoy);
  marcarDocumentosVencidos(resultado.documentos, cafs, hoy);
  // En el mes en curso se avisa de folios de facturas/notas por vencer (o vencidos) sin usar
  if (periodo === `${hoy.getFullYear()}-${String(hoy.getMonth() + 1).padStart(2, '0')}`) {
    resultado.alertas.push(...alertasVencimiento(cafs, (t, d, h) => ultimoFolioUsado(rut, t, d, h), NOMBRES_SII, hoy));
  }
  return { rut, periodo, siiConsultadoEn: sinc?.consultado_en ?? null, ...resultado };
}

/**
 * Documentos regenerados en otro mes (p. ej. una factura de octubre cuyo XML se generó en noviembre):
 *  - registrado "sin XML" en este mes, pero con XML en la carpeta de un mes vecino -> sí tiene XML;
 *  - "en blanco" en este mes (solo hay XML), pero registrado en Sisgen en otro mes -> es de ese
 *    otro mes y no se cuenta aquí.
 */
export function ajustarOtrosMeses(rut, periodo, docs, otrosMeses) {
  const blancos = docs.filter((d) => d.en_blanco && d.tipo_sii).map((d) => `${d.tipo_sii}-${d.folio}`);
  const deOtroMes = registradosEnOtroMes(rut, periodo, blancos);
  return docs
    .filter((d) => !(d.en_blanco && deOtroMes.has(`${d.tipo_sii}-${d.folio}`)))
    .map((d) => (d.sin_xml && otrosMeses.has(`${d.tipo_sii}-${d.folio}`) ? { ...d, sin_xml: 0 } : d));
}

// Con 150 clientes no se puede recalcular todo en cada visita: el resumen se guarda en memoria
// y se recalcula solo cuando cambian los datos de esa razón social y periodo.
const cache = new Map();

/** Cifras del periodo de una razón social (lo que muestran la tabla de clientes y la ficha). */
export function resumenPeriodo(rut, periodo) {
  const clave = `${rut}|${periodo}`;
  const huella = huellaDatos(rut, periodo);
  const enCache = cache.get(clave);
  if (enCache?.huella === huella) return enCache.valor;
  const c = calcularCuadratura(rut, periodo);
  const valor = {
    siiConsultadoEn: c.siiConsultadoEn,
    documentos: c.resumen.documentos,
    montoTotal: c.resumen.montoTotal,
    ok: c.resumen.porEstado.OK,
    sinVerificar: c.resumen.porEstado.SIN_VERIFICAR,
    conProblemas: c.resumen.documentos - c.resumen.porEstado.OK - c.resumen.porEstado.SIN_VERIFICAR,
    urgentes: c.alertas.filter((a) => a.nivel === 'alta').length,
    alertas: c.alertas.filter((a) => a.nivel !== 'baja').length,
  };
  cache.set(clave, { huella, valor });
  return valor;
}

/** Estado de una razón social en el periodo pedido (o en su último periodo con datos). */
export function estadoEmpresa(e, periodo = null) {
  const p = periodo ?? e.ultimoPeriodoSisgen ?? e.periodos[0] ?? null;
  const base = { rut: e.rut, razonSocial: e.razonSocial, cliente: e.cliente, esDemo: e.esDemo, sucursales: e.sucursales.length, periodo: p };
  if (!p || !e.periodos.includes(p)) return { ...base, sinDatos: true };
  return { ...base, ...resumenPeriodo(e.rut, p) };
}

// Gravedad para ordenar: primero lo urgente, al final lo que cuadra
export const GRAVEDAD = { urgente: 0, revisar: 1, sinSii: 2, sinDatos: 3, ok: 4 };
export function gravedadEmpresa(x) {
  if (x.sinDatos) return 'sinDatos';
  // Sin consulta al SII la cuadratura no está hecha: sus "alertas" no son confiables todavía
  if (!x.siiConsultadoEn && !x.esDemo) return 'sinSii';
  if (x.urgentes) return 'urgente';
  if (x.alertas) return 'revisar';
  return 'ok';
}

/** Número del RUT sin dígito verificador (para ordenar de menor a mayor). */
export const numeroRut = (rut) => Number(String(rut).split('-')[0].replace(/\D/g, '')) || 0;

const HORAS_DESACTUALIZADA = 48;

/** Sucursales con la fecha de su última lectura y si están desactualizadas. */
export function sucursalesEstado(rut, ahora = Date.now()) {
  return sucursalesConLectura(rut).map((s) => {
    const ms = s.ultima_lectura ? Date.parse(s.ultima_lectura.replace(' ', 'T') + 'Z') : null;
    const ag = estadoAgente(s.id);
    return {
      id: s.id, codigo: s.codigo, nombre: s.nombre, ultimaLectura: s.ultima_lectura, ultimoPeriodo: s.ultimo_periodo,
      desactualizada: !ms || ahora - ms > HORAS_DESACTUALIZADA * 3600e3,
      agente: ag && { activo: !!ag.activo, ultimoContacto: ag.ultimo_contacto, version: ag.version, equipo: ag.equipo, error: ag.ultimo_error, historial: ag.historial },
    };
  });
}

/** Une los estados de varias razones sociales en una fila de cliente. */
export function filaCliente(cliente, estados, sucursales) {
  const conDatos = estados.filter((x) => !x.sinDatos);
  const suma = (k, lista = conDatos) => lista.reduce((s, x) => s + (x[k] ?? 0), 0);
  const consultadas = conDatos.filter((x) => x.siiConsultadoEn || x.esDemo); // sin SII las alertas no cuentan
  const gravedades = estados.map(gravedadEmpresa);
  const peor = gravedades.length ? gravedades.reduce((a, g) => (GRAVEDAD[g] < GRAVEDAD[a] ? g : a)) : 'sinDatos';
  const lecturas = sucursales.map((s) => s.ultimaLectura).filter(Boolean).sort();
  const ruts = estados.map((x) => x.rut).sort((a, b) => numeroRut(a) - numeroRut(b));
  return {
    ...cliente,
    ruts,
    rutMenor: ruts[0] ?? null,
    razones: estados.length,
    sucursales: sucursales.length,
    sucursalesDesactualizadas: sucursales.filter((s) => s.desactualizada).length,
    // La lectura más antigua: si una sucursal dejó de conectarse, se nota aquí
    lecturaMasAntigua: sucursales.some((s) => !s.ultimaLectura) ? null : lecturas[0] ?? null,
    documentos: suma('documentos'),
    montoTotal: suma('montoTotal'),
    ok: suma('ok'),
    urgentes: suma('urgentes', consultadas),
    alertas: suma('alertas', consultadas),
    conProblemas: suma('conProblemas', consultadas),
    sinSii: estados.filter((x) => !x.sinDatos && !x.siiConsultadoEn && !x.esDemo).length,
    estado: peor,
  };
}
