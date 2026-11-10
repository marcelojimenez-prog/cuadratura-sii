// Ejecuta en hilos aparte la preparación de XML/PDF, con tiempo máximo por documento.
// Hay UN hilo por sucursal (según su carpeta procesos): si la carpeta de red de una sucursal no
// responde, solo se afectan los documentos de esa sucursal; el portal y las demás sucursales
// siguen funcionando. Al exceder el tiempo, el hilo se descarta y se crea uno nuevo.
import { Worker } from 'node:worker_threads';

const TIMEOUT_MS = 90_000;
const URL_TRABAJADOR = new URL('./trabajador.js', import.meta.url);

export class SucursalNoResponde extends Error {
  constructor(sucursal) {
    super(`La carpeta de la sucursal ${sucursal ?? ''} no respondió a tiempo. Puede estar apagada o sin conexión.`.replace('  ', ' '));
    this.name = 'SucursalNoResponde';
    this.status = 504;
  }
}

let secuencia = 0;
const hilos = new Map(); // clave sucursal -> { w, pendientes: Map(id -> {ok,error,timer}) }

function hiloDe(clave) {
  const actual = hilos.get(clave);
  if (actual) return actual;
  const h = { w: new Worker(URL_TRABAJADOR), pendientes: new Map() };
  h.w.on('message', (m) => {
    const p = h.pendientes.get(m.id);
    if (!p) return;
    clearTimeout(p.timer);
    h.pendientes.delete(m.id);
    if (m.error) p.error(Object.assign(new Error(m.error), { status: m.status ?? 500 }));
    else p.ok(Buffer.from(m.datos));
  });
  h.w.on('error', (e) => descartar(clave, h, e));
  h.w.on('exit', () => descartar(clave, h, new Error('El hilo de documentos terminó')));
  hilos.set(clave, h);
  return h;
}

function descartar(clave, h, motivo) {
  if (hilos.get(clave) !== h) return;
  hilos.delete(clave);
  for (const [id, p] of h.pendientes) {
    clearTimeout(p.timer);
    p.error(motivo);
    h.pendientes.delete(id);
  }
  h.w.terminate().catch(() => {});
}

/**
 * @param {{ formato:'xml'|'pdf', tipo, folio, fecha, periodo, tipoSisgen, sucursal, rutaDatos, rutaProcesos }} tarea
 * @returns {Promise<Buffer>}
 */
export function prepararDocumento(tarea) {
  const clave = tarea.rutaProcesos ?? tarea.sucursal ?? 'general';
  const h = hiloDe(clave);
  const id = ++secuencia;
  return new Promise((ok, error) => {
    const timer = setTimeout(() => descartar(clave, h, new SucursalNoResponde(tarea.sucursal)), TIMEOUT_MS);
    h.pendientes.set(id, { ok, error, timer });
    h.w.postMessage({ ...tarea, id });
  });
}
