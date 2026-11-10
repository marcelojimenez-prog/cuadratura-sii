// Hilo de trabajo (worker_threads) que lee archivos de las sucursales por red y arma el XML/PDF.
// Corre aparte del servidor: si una carpeta de red se cuelga, solo se bloquea este hilo y el
// portal sigue respondiendo. Mantiene sus cachés (listados de carpetas, logo, F2) mientras vive.
import { parentPort } from 'node:worker_threads';
import { rutasXml, elegirXml } from './archivos.js';
import { extrasSucursal, detalleDesdeF2 } from './extras.js';
import { generarPdf } from './pdf.js';

parentPort.on('message', async (t) => {
  try {
    const xml = elegirXml(rutasXml({ rutaProcesos: t.rutaProcesos, tipoSii: t.tipo, folio: t.folio, fecha: t.fecha }));
    if (!xml) {
      parentPort.postMessage({ id: t.id, status: 404, error: 'No se encontró el XML de este documento (no fue generado)' });
      return;
    }
    if (t.formato === 'xml') {
      parentPort.postMessage({ id: t.id, datos: Buffer.from(xml.texto, 'latin1') });
      return;
    }
    const extras = { ...extrasSucursal({ rutaDatos: t.rutaDatos, rutaProcesos: t.rutaProcesos }) };
    // Sin logo por defecto: solo si la razón social lo tiene habilitado (config pdf.mostrarLogo)
    if (!t.mostrarLogo) extras.logo = null;
    // Si el XML no trae detalle (pasa con boletas), se usan las líneas de F2 de Sisgen
    const detalleAlterno = /<Detalle>/i.test(xml.texto)
      ? null
      : detalleDesdeF2({ rutaDatos: t.rutaDatos, periodo: t.periodo, tipoSisgen: t.tipoSisgen, folio: t.folio });
    const pdf = await generarPdf(xml.texto, { extras, detalleAlterno });
    parentPort.postMessage({ id: t.id, datos: pdf });
  } catch (e) {
    parentPort.postMessage({ id: t.id, status: 500, error: e.message });
  }
});
