// Cuadratura completa y resúmenes por razón social / cliente para las pantallas del portal.
import {
  docsSisgen, docsSii, rangosCaf, xmlOtrosMeses, resumenSii, sincronizacionSii, foliosExternos, huellaDatos,
  sucursalesConLectura,
} from '../../db.js';
import { TIPOS_A_CUADRAR } from '../sisgen/tipos.js';
import { cuadrar } from './motor.js';

/** Resultado completo de cuadratura de una razón social en un periodo. */
export function calcularCuadratura(rut, periodo) {
  const sinc = sincronizacionSii(rut, periodo);
  const resultado = cuadrar(docsSisgen(rut, periodo), docsSii(rut, periodo), {
    rangos: rangosCaf(rut),
    xmlOtrosMeses: xmlOtrosMeses(rut, periodo),
    resumenSii: resumenSii(rut, periodo),
    foliosExternos: foliosExternos(rut, periodo),
    // Con el RCV sincronizado, todo tipo tributario se considera consultado al SII
    ...(sinc ? { tiposConsultados: TIPOS_A_CUADRAR } : {}),
  });
  return { rut, periodo, siiConsultadoEn: sinc?.consultado_en ?? null, ...resultado };
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
  const p = periodo ?? e.periodos[0] ?? null;
  const base = { rut: e.rut, razonSocial: e.razonSocial, cliente: e.cliente, esDemo: e.esDemo, sucursales: e.sucursales.length, periodo: p };
  if (!p || !e.periodos.includes(p)) return { ...base, sinDatos: true };
  return { ...base, ...resumenPeriodo(e.rut, p) };
}

// Gravedad para ordenar: primero lo urgente, al final lo que cuadra
export const GRAVEDAD = { urgente: 0, revisar: 1, sinSii: 2, sinDatos: 3, ok: 4 };
export function gravedadEmpresa(x) {
  if (x.sinDatos) return 'sinDatos';
  if (x.urgentes) return 'urgente';
  if (!x.siiConsultadoEn) return 'sinSii';
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
    return {
      codigo: s.codigo, nombre: s.nombre, ultimaLectura: s.ultima_lectura, ultimoPeriodo: s.ultimo_periodo,
      desactualizada: !ms || ahora - ms > HORAS_DESACTUALIZADA * 3600e3,
    };
  });
}

/** Une los estados de varias razones sociales en una fila de cliente. */
export function filaCliente(cliente, estados, sucursales) {
  const conDatos = estados.filter((x) => !x.sinDatos);
  const suma = (k) => conDatos.reduce((s, x) => s + (x[k] ?? 0), 0);
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
    conProblemas: suma('conProblemas'),
    urgentes: suma('urgentes'),
    alertas: suma('alertas'),
    sinSii: estados.filter((x) => !x.sinDatos && !x.siiConsultadoEn).length,
    estado: peor,
  };
}
