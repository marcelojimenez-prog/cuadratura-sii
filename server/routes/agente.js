// API para el Agente Sisgen (servicio de Windows de cada sucursal). Autenticación: llave por sucursal
// o llave de instalación del cliente.   Authorization: Bearer sga_…
import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { RAIZ } from '../config.js';
import {
  agentePorLlave, registrarContacto, guardarTrazas, guardarXml, guardarCompras, vincularAgente, importarMes, registrarHistorial, guardarDatosImpresion,
  anotarCertificadoAgente, anotarVentasMesAgente } from '../agentes.js';
import { agenteEspera, agenteResponde, agenteDisponible } from '../lib/sii/remoto.js';
import { mesesACuadrar } from '../lib/sii/vigenciaCaf.js';
import { rangosCaf, blancosSinRespaldo, guardarRespaldos } from '../db.js';
import { armarRespaldo, armarDesdeDt } from '../lib/sisgen/respaldo.js';
import { consultarAhora } from '../programador.js';
import { registrarCorreccion, mesesUrgentes, mesRecibido } from '../correcciones.js';
import { actualizacionPara, archivoActualizacion, versionPublicada } from '../actualizaciones.js';

const r = Router();
const archivoPedidoCarpeta = (id) => path.join(RAIZ, 'data', 'agentes', `carpeta-${id}.json`);
const pedidoCarpeta = (id) => {
  try { return JSON.parse(fs.readFileSync(archivoPedidoCarpeta(id), 'utf8')); } catch { return null; }
};
const pedidoDiagnostico = (id) => {
  try { return JSON.parse(fs.readFileSync(path.join(RAIZ, 'data', 'diagnostico', `pedido-${id}.json`), 'utf8')); } catch { return null; }
};
const MAX_TRAZAS = 5000, MAX_XML = 200;

r.use((req, res, next) => {
  const llave = /^Bearer\s+(\S+)$/i.exec(req.get('authorization') ?? '')?.[1];
  const agente = agentePorLlave(llave);
  if (!agente) return res.status(401).json({ error: 'Llave de agente no válida' });
  if (!agente.activo) return res.status(403).json({ error: 'Agente desactivado en el portal' });
  req.agente = agente;
  next();
});

const conErrores = (fn) => (req, res, next) => {
  try { fn(req, res); } catch (e) {
    if (!e.status) return next(e);
    res.status(e.status).json({ error: e.message });
  }
};

/**
 * Saludo periódico: confirma la llave y deja registro de que el agente está vivo.
 * Con llave de instalación, la primera vez asocia el agente a su razón social y sucursal (empres.dbf).
 */
r.post('/hola', conErrores((req, res) => {
  const { version, equipo, error, empresa, historial } = req.body ?? {};
  const agente = vincularAgente(req.agente, empresa);
  registrarHistorial(agente.id, historial);
  guardarDatosImpresion(agente.rut, empresa);
  registrarContacto(agente.id, { version: String(version ?? '').slice(0, 20) || null, equipo: String(equipo ?? '').slice(0, 60) || null,
    ip: req.ip, error: error ? String(error).slice(0, 300) : null });
  anotarCertificadoAgente(agente.id, req.body?.certificado);
  // Meses cuyas ventas debe enviar el agente: según la vigencia de los folios de facturas y notas
  res.json({ ok: true, rut: agente.rut, sucursal: agente.sucursal, intervaloSegundos: 30, mesesVentas: mesesACuadrar(rangosCaf(agente.rut)),
    actualizacion: actualizacionPara(agente.id, version),
    // Documentos en blanco que el agente debe buscar en la carpeta backup de Sisgen
    respaldosPendientes: agente.sucursal_id ? blancosSinRespaldo(agente.sucursal_id, 100) : [],
    // Meses con documentos corregidos: el agente los reenvía al momento
    mesesUrgentes: mesesUrgentes(agente.id),
    // Diagnóstico pedido a mano (data/diagnostico/pedido-<agente>.json): buscar en qué tabla está un documento
    buscarEnTablas: pedidoDiagnostico(agente.id),
    // Cambio de la carpeta de Sisgen pedido desde el portal (data/agentes/carpeta-<agente>.json)
    cambiarCarpeta: pedidoCarpeta(agente.id) });
}));

/** Descarga de la versión nueva del agente (solo si le corresponde a este agente). */
r.post('/actualizacion', (req, res) => {
  const m = versionPublicada();
  const ofrecida = actualizacionPara(req.agente.id, /SisgenAgente\/([\d.]+)/.exec(req.get('user-agent') ?? '')?.[1], m);
  const ruta = archivoActualizacion(m);
  if (!ofrecida || !ruta || ofrecida.version !== req.body?.version) return res.status(404).json({ error: 'No hay actualización para este agente' });
  res.type('application/octet-stream').sendFile(ruta);
});

// El resto exige que el agente ya esté asociado a su sucursal (primero debe llamar a /hola)
r.use((req, res, next) => {
  if (!req.agente.sucursal_id) return res.status(409).json({ error: 'El agente aún no identificó su sucursal' });
  next();
});

/** Detalle de documentos en blanco (carpeta backup o tabla DT): [{documento: 'BE-123', fuente, lineas: [filas del dbf]}]. */
r.post('/respaldo', (req, res) => {
  const docs = req.body?.docs;
  if (!Array.isArray(docs) || docs.length > 500) return res.status(400).json({ error: 'Envía entre 0 y 500 documentos' });
  const resultados = new Map();
  for (const x of docs) {
    const m = /^([A-Z]{2})-(\d{1,10})$/.exec(String(x?.documento ?? ''));
    if (!m) continue;
    const lineas = Array.isArray(x.lineas) ? x.lineas.slice(0, 200) : [];
    const archivo = lineas[0]?.archivo ? String(lineas[0].archivo).slice(0, 20) : null;
    // fuente: BACKUP (carpeta backup de la estación) o DT (tabla DTMMAAAA del mes)
    resultados.set(`${m[1]}-${parseInt(m[2], 10)}`, x.fuente === 'DT' ? armarDesdeDt(lineas, archivo) : armarRespaldo(lineas, archivo));
  }
  registrarContacto(req.agente.id, { ip: req.ip });
  res.json({ ok: true, encontrados: guardarRespaldos(req.agente.rut, req.agente.sucursal_id, resultados) });
});

/** Seguimiento de envío al SII (filas de trazadte / trazabol). */
r.post('/trazas', (req, res) => {
  const trazas = req.body?.trazas;
  if (!Array.isArray(trazas) || trazas.length > MAX_TRAZAS) return res.status(400).json({ error: `Envía entre 0 y ${MAX_TRAZAS} trazas` });
  registrarContacto(req.agente.id, { ip: req.ip });
  res.json({ ok: true, ...guardarTrazas(req.agente, trazas) });
});

/** XML de documentos emitidos (gzip + base64). */
r.post('/xml', (req, res) => {
  const archivos = req.body?.archivos;
  if (!Array.isArray(archivos) || archivos.length > MAX_XML) return res.status(400).json({ error: `Envía entre 0 y ${MAX_XML} archivos` });
  registrarContacto(req.agente.id, { ip: req.ip });
  const r = guardarXml(req.agente, archivos, { historial: req.body.historial === true });
  if (r.corregidos.length) {
    const lista = r.corregidos.slice(0, 5).map((c) => `${c.tipo}-${c.folio}`).join(', ') + (r.corregidos.length > 5 ? ` y ${r.corregidos.length - 5} más` : '');
    console.log(`[agente] ${req.agente.sucursal}: documento(s) corregido(s) ${lista}; se actualiza ${[...new Set(r.corregidos.map((c) => c.periodo))].join(', ')}`);
    registrarCorreccion(req.agente, r.corregidos.map((c) => c.periodo));
  }
  res.json({ ok: true, guardados: r.guardados, rechazados: r.rechazados });
});

/** Diagnóstico del agente (nombres de carpetas y cantidad de archivos; nunca contenido). Se guarda en data/diagnostico. */
r.post('/diagnostico', (req, res) => {
  const tipo = /^[a-z]{1,20}$/.test(req.body?.tipo ?? '') ? req.body.tipo : 'general';
  const dir = path.join(RAIZ, 'data', 'diagnostico');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `agente-${req.agente.id}-${tipo}.json`), JSON.stringify({ recibido: new Date().toISOString(), ...req.body }, null, 1).slice(0, 2_000_000));
  registrarContacto(req.agente.id, { ip: req.ip });
  console.log(`[agente] ${req.agente.sucursal}: diagnóstico "${tipo}" recibido`);
  if (tipo === 'carpeta') {
    console.log(`[agente] ${req.agente.sucursal}: cambio de carpeta de Sisgen: ${String(req.body.resultado ?? '').slice(0, 300)}`);
    // Terminado (bien o mal): se borra el pedido para que no se repita
    const pedido = pedidoCarpeta(req.agente.id);
    if (pedido && String(pedido.id) === String(req.body.pedido)) fs.rmSync(archivoPedidoCarpeta(req.agente.id), { force: true });
  }
  res.json({ ok: true });
});

/** Compras: XML de procesos\Correo\Descargas (gzip + base64). Solo se guardan los recibidos por esta razón social. */
r.post('/compras', (req, res) => {
  const archivos = req.body?.archivos;
  if (!Array.isArray(archivos) || archivos.length > MAX_XML) return res.status(400).json({ error: `Envía entre 0 y ${MAX_XML} archivos` });
  registrarContacto(req.agente.id, { ip: req.ip });
  // Se anota por qué se descarta cada archivo (solo tipo, folio y RUT; nunca contenido) en data/diagnostico
  const archivoDiag = path.join(RAIZ, 'data', 'diagnostico', `agente-${req.agente.id}-compras.json`);
  let motivos;
  try { motivos = JSON.parse(fs.readFileSync(archivoDiag, 'utf8')); } catch { motivos = { conteo: {}, muestras: {} }; }
  const r = guardarCompras(req.agente, archivos, motivos);
  try { fs.mkdirSync(path.dirname(archivoDiag), { recursive: true }); fs.writeFileSync(archivoDiag, JSON.stringify(motivos, null, 1)); } catch { /* sin diagnóstico */ }
  res.json({ ok: true, ...r });
});

/**
 * Consultas al SII que el agente hace con el certificado de su servidor (que nunca sale de ahí).
 * El agente espera aquí hasta 25 s; si el portal necesita consultar algo, se lo entrega.
 */
const yaConsultados = new Set(); // RUT consultados al conectarse su agente (una vez por arranque del portal)

r.post('/consultas/esperar', (req, res) => {
  registrarContacto(req.agente.id, { ip: req.ip });
  const { rut } = req.agente;
  agenteEspera(rut, req.body?.certificado, res);
  // Primera conexión con certificado válido: se consulta al SII de inmediato, sin esperar la hora
  if (!yaConsultados.has(rut) && agenteDisponible(rut)) {
    yaConsultados.add(rut);
    setTimeout(() => consultarAhora(rut).catch((e) => console.log(`[agente] Consulta SII de ${rut}: ${e.message}`)), 5000);
  }
});

r.post('/consultas/resultado', (req, res) => {
  res.json({ ok: true, recibidos: agenteResponde(req.agente.rut, req.body?.resultados) });
});

/** Ventas completas de un mes (F1, F2, CLIDOCTO, CLIPAGOS, índice de XML y rangos CAF). */
r.post('/mes', conErrores((req, res) => {
  registrarContacto(req.agente.id, { ip: req.ip });
  const resultado = importarMes(req.agente, req.body ?? {});
  anotarVentasMesAgente(req.agente.id, resultado.periodo);
  console.log(`[agente] ${req.agente.sucursal} (${req.agente.rut}) ${resultado.periodo}: ${resultado.documentos} documentos importados`);
  if (mesRecibido(req.agente, resultado.periodo)) console.log(`[agente] ${req.agente.sucursal}: ${resultado.periodo} recibido tras una corrección; se consulta al SII`);
  res.json({ ok: true, ...resultado });
}));

export default r;
