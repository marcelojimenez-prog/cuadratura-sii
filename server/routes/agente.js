// API para el Agente Sisgen (servicio de Windows de cada sucursal). Autenticación: llave por sucursal
// o llave de instalación del cliente.   Authorization: Bearer sga_…
import { Router } from 'express';
import {
  agentePorLlave, registrarContacto, guardarTrazas, guardarXml, vincularAgente, importarMes, registrarHistorial, guardarDatosImpresion,
} from '../agentes.js';
import { agenteEspera, agenteResponde, agenteDisponible } from '../lib/sii/remoto.js';
import { mesesACuadrar } from '../lib/sii/vigenciaCaf.js';
import { rangosCaf } from '../db.js';
import { consultarAhora } from '../programador.js';

const r = Router();
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
  // Meses cuyas ventas debe enviar el agente: según la vigencia de los folios de facturas y notas
  res.json({ ok: true, rut: agente.rut, sucursal: agente.sucursal, intervaloSegundos: 30, mesesVentas: mesesACuadrar(rangosCaf(agente.rut)) });
}));

// El resto exige que el agente ya esté asociado a su sucursal (primero debe llamar a /hola)
r.use((req, res, next) => {
  if (!req.agente.sucursal_id) return res.status(409).json({ error: 'El agente aún no identificó su sucursal' });
  next();
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
  res.json({ ok: true, ...guardarXml(req.agente, archivos, { historial: req.body.historial === true }) });
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
  console.log(`[agente] ${req.agente.sucursal} (${req.agente.rut}) ${resultado.periodo}: ${resultado.documentos} documentos importados`);
  res.json({ ok: true, ...resultado });
}));

export default r;
