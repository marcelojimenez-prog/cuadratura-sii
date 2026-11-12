// Tareas automáticas del portal (para que nadie tenga que actualizar a mano):
//  - Cada hora: consulta al SII del mes en curso (y del anterior los primeros 10 días).
//  - Cada noche: consulta al SII de todos los meses que se cuadran (según la vigencia de los folios
//    de facturas y notas: desde la autorización del CAF vigente más antiguo) y reimporta por red las
//    sucursales que tienen ruta de datos (las que usan el agente envían sus ventas solas).
// Cada razón social consulta con el certificado de este equipo (si está configurado) o con el suyo
// propio a través de su agente. Se ejecuta de a una tarea, sin bloquear el portal.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { cargarConfig, RAIZ } from './config.js';
import { getDb, rangosCaf } from './db.js';
import { sincronizarEmpresa } from './lib/sii/sincronizar.js';
import { clienteRemoto } from './lib/sii/clientes.js';
import { agenteDisponible } from './lib/sii/remoto.js';
import { mesesACuadrar } from './lib/sii/vigenciaCaf.js';

const HORA_NOCTURNA = 3;
let ocupado = false;
let ultimaNocturna = null;
let ultimaCompleta = 0;

const periodo = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
function periodosRecientes(ahora = new Date()) {
  const lista = [periodo(ahora)];
  if (ahora.getDate() <= 10) lista.unshift(periodo(new Date(ahora.getFullYear(), ahora.getMonth() - 1, 1)));
  return lista;
}

function correr(script, args) {
  return new Promise((ok) => {
    const p = spawn(process.execPath, ['--no-warnings', path.join(RAIZ, 'scripts', script), ...args], { cwd: RAIZ });
    const salida = [];
    p.stdout.on('data', (b) => salida.push(b));
    p.stderr.on('data', (b) => salida.push(b));
    p.on('close', (codigo) => ok({ codigo, salida: Buffer.concat(salida).toString() }));
  });
}

const log = (m) => console.log(`[auto ${new Date().toLocaleString('sv-SE')}] ${m}`);

/** Consulta al SII de una razón social en los periodos indicados (local o vía agente). */
async function consultarEmpresa(emp, periodos, conCertificadoLocal, { barrido = true } = {}) {
  for (const p of periodos) {
    if (conCertificadoLocal.has(emp.rut)) {
      const r = await correr('sincronizar-sii.js', [p, emp.rut, ...(barrido ? [] : ['--rapido'])]);
      log(`SII ${emp.razon_social} ${p}: ${r.codigo === 0 ? 'ok' : `error (código ${r.codigo})`}`);
      if (r.codigo !== 0) console.log(r.salida.split('\n').slice(-8).join('\n'));
    } else if (agenteDisponible(emp.rut)) {
      try {
        await sincronizarEmpresa({ rut: emp.rut, razonSocial: emp.razon_social }, p, clienteRemoto(), () => {}, { barrido });
        log(`SII ${emp.razon_social} ${p} (vía agente): ok`);
      } catch (e) {
        log(`SII ${emp.razon_social} ${p} (vía agente): error ${e.message}`);
      }
    }
  }
}

async function consultarSii({ todosLosMeses = false, barrido = true } = {}) {
  const cfg = cargarConfig();
  const empresas = getDb().prepare('SELECT rut, razon_social FROM empresas WHERE es_demo = 0').all();
  const conCertificadoLocal = new Set(cfg.empresas.filter((e) => e.certificado?.rutaPfx).map((e) => e.rut));
  for (const emp of empresas) {
    await consultarEmpresa(emp, todosLosMeses ? mesesACuadrar(rangosCaf(emp.rut)) : periodosRecientes(), conCertificadoLocal, { barrido });
  }
}

const MESES_ANTIGUOS_POR_HORA = 12;

/**
 * Meses antiguos (con ventas de Sisgen) que nunca se han consultado al SII: se consultan una vez,
 * de a pocos por hora y del más nuevo al más antiguo.
 */
async function consultarMesesAntiguos() {
  const cfg = cargarConfig();
  const conCertificadoLocal = new Set(cfg.empresas.filter((e) => e.certificado?.rutaPfx).map((e) => e.rut));
  const empresas = getDb().prepare('SELECT rut, razon_social FROM empresas WHERE es_demo = 0').all();
  for (const emp of empresas) {
    if (!conCertificadoLocal.has(emp.rut) && !agenteDisponible(emp.rut)) continue;
    const pendientes = getDb().prepare(
      `SELECT DISTINCT d.periodo FROM docs_sisgen d
        WHERE d.rut_emisor = ? AND NOT EXISTS (SELECT 1 FROM sii_sincronizaciones s WHERE s.rut_emisor = d.rut_emisor AND s.periodo = d.periodo)
        ORDER BY d.periodo DESC LIMIT ?`
    ).all(emp.rut, MESES_ANTIGUOS_POR_HORA).map((r) => r.periodo);
    if (pendientes.length) await consultarEmpresa(emp, pendientes, conCertificadoLocal);
  }
}

/** Consulta inmediata de todos los meses que se cuadran (al conectarse un agente por primera vez). */
export async function consultarAhora(rut) {
  const emp = getDb().prepare('SELECT rut, razon_social FROM empresas WHERE rut = ?').get(rut);
  if (!emp || !agenteDisponible(rut)) return;
  // Se da tiempo a que el agente envíe primero las ventas de esos meses
  await new Promise((ok) => setTimeout(ok, 5 * 60 * 1000));
  await consultarEmpresa(emp, mesesACuadrar(rangosCaf(rut)), new Set());
}

async function importarPorRed() {
  const cfg = cargarConfig();
  for (const emp of cfg.empresas) {
    if (!emp.sucursales?.some((s) => s.rutaDatos)) continue;
    for (const p of periodosRecientes()) {
      const r = await correr('importar-sisgen.js', [p, emp.rut]);
      log(`Importación ${emp.razonSocial} ${p}: ${r.codigo === 0 ? 'ok' : `error (código ${r.codigo})`}`);
    }
  }
}

async function tick() {
  if (ocupado) return;
  ocupado = true;
  try {
    const ahora = new Date();
    const hoy = ahora.toDateString();
    if (ahora.getHours() === HORA_NOCTURNA && ultimaNocturna !== hoy) {
      ultimaNocturna = hoy;
      await importarPorRed();
      await consultarSii({ todosLosMeses: true });
    } else {
      // Cada 15 minutos el mes en curso; la revisión completa de boletas, una vez por hora
      const completa = Date.now() - ultimaCompleta >= 55 * 60 * 1000;
      if (completa) ultimaCompleta = Date.now();
      await consultarSii({ barrido: completa });
    }
    await consultarMesesAntiguos();
  } catch (e) {
    log(`Error: ${e.message}`);
  } finally {
    ocupado = false;
  }
}

/** Inicia las tareas automáticas: primera consulta a los 2 minutos, luego cada 15 minutos. */
export function iniciarProgramador({ minutos = 15 } = {}) {
  log(`Tareas automáticas activas: consulta al SII del mes en curso cada ${minutos} min (revisión completa de boletas cada hora); a las ${HORA_NOCTURNA}:00 todos los meses que se cuadran.`);
  setTimeout(tick, 2 * 60 * 1000);
  setInterval(tick, minutos * 60 * 1000);
}
