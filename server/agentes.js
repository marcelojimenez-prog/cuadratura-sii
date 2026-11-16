// Agente Sisgen: servicio de Windows que cada sucursal ejecuta para enviar al portal, en línea,
// cada documento emitido (XML) y su seguimiento de envío al SII (tablas trazadte / trazabol).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { XMLParser } from 'fast-xml-parser';
import {
  getDb, transaccion, carpetaXml, rutaRelativaXml, rutaRelativaCompra, guardarEmpresa, guardarSucursal, reemplazarDocsSisgen, reemplazarRangosCaf, reemplazarXmlOtrosMeses,
} from './db.js';
import { tokenSesion, hashToken } from './lib/auth/claves.js';
import { TIPO_SISGEN_POR_SII, tipoSii } from './lib/sisgen/tipos.js';
import { consolidar, normalizarRut } from './lib/sisgen/importar.js';

const ahoraUtc = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

// ---------- Llaves ----------
/** Crea (o reemplaza) la llave del agente de una sucursal. La llave se muestra una sola vez. */
export function generarLlaveAgente(sucursalId) {
  const llave = 'sga_' + tokenSesion();
  getDb()
    .prepare(
      `INSERT INTO agentes (sucursal_id, llave_hash) VALUES (?, ?)
       ON CONFLICT(sucursal_id) DO UPDATE SET llave_hash = excluded.llave_hash, activo = 1, creado_en = datetime('now')`
    )
    .run(sucursalId, hashToken(llave));
  return llave;
}

/**
 * Llave de instalación para un cliente: el agente que la use queda asociado a la razón social y
 * sucursal que informe su empres.dbf al conectarse la primera vez (se crean si no existen).
 */
export function generarLlaveInstalacion(clienteId) {
  const llave = 'sga_' + tokenSesion();
  getDb().prepare('INSERT INTO agentes (cliente_id, llave_hash) VALUES (?, ?)').run(clienteId, hashToken(llave));
  return llave;
}

const codigoDe = (s) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '') || 'SUCURSAL';
const nombreBonito = (s) => s.toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase());
const conflicto = (msg, status = 409) => Object.assign(new Error(msg), { status });

/**
 * Asocia un agente con llave de instalación a su razón social y sucursal (según su empres.dbf).
 * Si ya estaba asociado, solo verifica que el RUT coincida.
 * @returns el agente actualizado
 */
export function vincularAgente(agente, empresa) {
  const rut = empresa?.rut ? normalizarRut(empresa.rut) : null;
  if (agente.sucursal_id) {
    if (rut && rut !== agente.rut) throw conflicto(`Este agente es de ${agente.rut}, pero el equipo informa ${rut}`);
    return agente;
  }
  if (!rut || !/^\d{7,8}-[\dK]$/.test(rut)) throw conflicto('El agente no pudo leer el RUT de empres.dbf', 400);
  const razonSocial = texto(empresa.razonSocial, 100) ?? rut;
  const nombre = nombreBonito(texto(empresa.nombreSistema, 60) ?? razonSocial);
  const d = getDb();
  const e = d.prepare('SELECT cliente_id FROM empresas WHERE rut = ?').get(rut);
  if (e?.cliente_id && agente.cliente_id && e.cliente_id !== agente.cliente_id) {
    throw conflicto('Esa razón social pertenece a otro cliente del portal');
  }
  guardarEmpresa({ rut, razonSocial });
  if (agente.cliente_id) d.prepare('UPDATE empresas SET cliente_id = COALESCE(cliente_id, ?) WHERE rut = ?').run(agente.cliente_id, rut);
  const sucId = sucursalParecida(d, rut, codigoDe(nombre)) ?? guardarSucursal({ rutEmpresa: rut, codigo: codigoDe(nombre), nombre });
  const otro = d.prepare('SELECT id, activo FROM agentes WHERE sucursal_id = ? AND id <> ?').get(sucId, agente.id);
  if (otro?.activo) throw conflicto(`La sucursal ${d.prepare('SELECT nombre FROM sucursales WHERE id = ?').get(sucId)?.nombre ?? nombre} ya tiene un agente conectado (desactívalo en el portal si se reinstala en otro equipo)`);
  // Un agente desactivado de esa sucursal se reemplaza por el nuevo
  if (otro) d.prepare('DELETE FROM agentes WHERE id = ?').run(otro.id);
  d.prepare('UPDATE agentes SET sucursal_id = ? WHERE id = ?').run(sucId, agente.id);
  const nombreSuc = d.prepare('SELECT nombre FROM sucursales WHERE id = ?').get(sucId)?.nombre ?? nombre;
  return { ...agente, sucursal_id: sucId, sucursal: nombreSuc, rut };
}

/**
 * Sucursal ya existente (importada por red) cuyo código coincide o está contenido en el del agente:
 * "TOP_DRINKS_EXPOSICION" -> "EXPOSICION". Solo si hay una sola candidata, para no adivinar.
 */
function sucursalParecida(d, rut, codigo) {
  const todas = d.prepare('SELECT id, codigo FROM sucursales WHERE rut_empresa = ?').all(rut);
  const exacta = todas.find((s) => s.codigo === codigo);
  if (exacta) return exacta.id;
  const parte = (a, b) => b.length >= 4 && (`_${a}_`).includes(`_${b}_`);
  const candidatas = todas.filter((s) => parte(codigo, s.codigo) || parte(s.codigo, codigo));
  return candidatas.length === 1 ? candidatas[0].id : null;
}

export function activarAgente(sucursalId, activo) {
  return getDb().prepare('UPDATE agentes SET activo = ? WHERE sucursal_id = ?').run(activo ? 1 : 0, sucursalId).changes > 0;
}

/** Agente (con su sucursal y RUT) que corresponde a una llave vigente, o null. */
export function agentePorLlave(llave) {
  if (!llave || !String(llave).startsWith('sga_')) return null;
  return getDb()
    .prepare(
      `SELECT a.id, a.sucursal_id, a.cliente_id, a.activo, s.nombre AS sucursal, s.rut_empresa AS rut
         FROM agentes a LEFT JOIN sucursales s ON s.id = a.sucursal_id WHERE a.llave_hash = ?`
    )
    .get(hashToken(llave)) ?? null;
}

export function registrarContacto(agenteId, { version, equipo, ip, error } = {}) {
  getDb()
    .prepare(
      `UPDATE agentes SET ultimo_contacto = ?, version = COALESCE(?, version), equipo = COALESCE(?, equipo),
              ip = COALESCE(?, ip), ultimo_error = ? WHERE id = ?`
    )
    .run(ahoraUtc(), version ?? null, equipo ?? null, ip ?? null, error ?? null, agenteId);
}

/** Estado del certificado informado por el agente en /hola ("ok; vence …", "VENCIDO; …", …). */
export function anotarCertificadoAgente(agenteId, certificado) {
  if (typeof certificado !== 'string' || !certificado) return;
  getDb().prepare('UPDATE agentes SET certificado = ? WHERE id = ?').run(certificado.slice(0, 200), agenteId);
}

/** Mes de ventas recibido del agente: se guarda el más reciente. */
export function anotarVentasMesAgente(agenteId, periodo) {
  if (!/^\d{4}-\d{2}$/.test(String(periodo ?? ''))) return;
  getDb().prepare('UPDATE agentes SET ventas_mes = ? WHERE id = ? AND (ventas_mes IS NULL OR ventas_mes < ?)').run(periodo, agenteId, periodo);
}

export function estadoAgente(sucursalId) {
  return getDb()
    .prepare('SELECT activo, creado_en, ultimo_contacto, version, equipo, ultimo_error, historial FROM agentes WHERE sucursal_id = ?')
    .get(sucursalId) ?? null;
}

// ---------- Trazas (trazadte / trazabol) ----------
const texto = (v, max = 200) => (v == null ? null : String(v).trim().slice(0, max) || null);
const fechaIso = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v ?? '')) ? v : null);

/**
 * Guarda el seguimiento de envío informado por el agente y crea en docs_sisgen los documentos
 * que aún no estaban (así el portal los ve en línea, sin esperar la importación de F1).
 * @returns {{ guardadas: number, nuevos: number, descartadas: number }}
 */
export function guardarTrazas(agente, trazas) {
  let guardadas = 0, nuevos = 0, descartadas = 0;
  transaccion((d) => {
    const env = d.prepare(
      `INSERT INTO envios_sii (rut_emisor, tipo_sii, folio, sucursal_id, fecha, emitido_en, enviado_en, track_id,
                               estado_envio, estado_sii, detalle_sii, actualizado_en)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,datetime('now'))
       ON CONFLICT(rut_emisor, tipo_sii, folio) DO UPDATE SET
         sucursal_id = excluded.sucursal_id, fecha = excluded.fecha, emitido_en = excluded.emitido_en,
         enviado_en = excluded.enviado_en, track_id = excluded.track_id, estado_envio = excluded.estado_envio,
         estado_sii = excluded.estado_sii, detalle_sii = excluded.detalle_sii, actualizado_en = datetime('now')`
    );
    const doc = d.prepare(
      `INSERT INTO docs_sisgen (rut_emisor, sucursal_id, periodo, tipo_sisgen, tipo_sii, folio, fecha, rut_receptor,
                                nombre_receptor, total, origen)
       VALUES (?,?,?,?,?,?,?,?,?,?,'AGENTE')
       ON CONFLICT(sucursal_id, periodo, tipo_sisgen, folio) DO NOTHING`
    );
    for (const t of trazas) {
      const tipo = Number(t.tipo), folio = Number(t.folio), fecha = fechaIso(t.fecha);
      if (!TIPO_SISGEN_POR_SII[tipo] || !Number.isInteger(folio) || folio <= 0 || !fecha) { descartadas++; continue; }
      env.run(agente.rut, tipo, folio, agente.sucursal_id, fecha, texto(t.emitido, 19), texto(t.enviado, 19),
        texto(t.trackId, 20), texto(t.estadoEnvio, 10), texto(t.estadoSii, 10), texto(t.detalleSii, 60));
      guardadas++;
      const r = doc.run(agente.rut, agente.sucursal_id, fecha.slice(0, 7), TIPO_SISGEN_POR_SII[tipo], tipo, folio, fecha,
        texto(t.rutReceptor, 12), texto(t.nombreReceptor, 60), Number(t.monto) || 0);
      nuevos += r.changes;
    }
  });
  return { guardadas, nuevos, descartadas };
}

// ---------- XML de documentos ----------
const parser = new XMLParser({ ignoreAttributes: true, removeNSPrefix: true, parseTagValue: false });

/** Datos básicos de un XML de DTE de Sisgen (un documento firmado). */
export function datosDte(xml) {
  const raiz = parser.parse(xml);
  const dte = raiz.DTE ?? raiz.EnvioDTE?.SetDTE?.DTE ?? raiz.EnvioBOLETA?.SetDTE?.DTE;
  const doc = (Array.isArray(dte) ? dte[0] : dte)?.Documento;
  const enc = doc?.Encabezado;
  if (!enc?.IdDoc) return null;
  const n = (v) => Number(v ?? 0) || 0;
  return {
    tipo: n(enc.IdDoc.TipoDTE),
    folio: n(enc.IdDoc.Folio),
    fecha: String(enc.IdDoc.FchEmis ?? ''),
    rutEmisor: String(enc.Emisor?.RUTEmisor ?? '').toUpperCase(),
    nombreEmisor: String(enc.Emisor?.RznSoc ?? enc.Emisor?.RznSocEmisor ?? '').trim().slice(0, 100) || null,
    rutReceptor: enc.Receptor?.RUTRecep ? String(enc.Receptor.RUTRecep) : null,
    nombreReceptor: enc.Receptor?.RznSocRecep ? String(enc.Receptor.RznSocRecep).slice(0, 60) : null,
    neto: n(enc.Totales?.MntNeto),
    exento: n(enc.Totales?.MntExe),
    iva: n(enc.Totales?.IVA),
    total: n(enc.Totales?.MntTotal),
  };
}

const CABECERA_XML = '<?xml version="1.0" encoding="ISO-8859-1"?>\n';

/**
 * Documentos (DTE) que trae un archivo XML: un DTE suelto, o varios dentro de un sobre
 * EnvioDTE / EnvioBOLETA (así quedaban los XML antiguos). Cada DTE se separa tal cual viene
 * (firmado), agregando el espacio de nombres del SII si lo heredaba del sobre.
 */
export function separarDtes(xml) {
  if (/^\s*(<\?xml[^>]*>\s*)?<DTE[\s>]/.test(xml)) return [xml];
  return [...xml.matchAll(/<DTE[\s>][\s\S]*?<\/DTE>/g)].map((m) => {
    const dte = /^<DTE[^>]*xmlns=/.test(m[0]) ? m[0] : m[0].replace(/^<DTE/, '<DTE xmlns="http://www.sii.cl/SiiDte"');
    return CABECERA_XML + dte;
  });
}

const FECHA_MINIMA = '2001-01-01';

/**
 * Guarda los XML enviados por el agente. Cada archivo llega comprimido (gzip) en base64.
 * Se rechazan los que no son de la razón social del agente.
 *  - En línea (historial = false): el documento también aparece de inmediato en la cuadratura.
 *  - Historial (historial = true): solo se archiva para búsqueda y descarga; no reemplaza lo que ya exista.
 */
export function guardarXml(agente, archivos, { historial = false } = {}) {
  let guardados = 0;
  const rechazados = [];
  const filas = [];
  const corregidos = [];
  for (const a of archivos) {
    try {
      const contenido = zlib.gunzipSync(Buffer.from(String(a.contenido ?? ''), 'base64'), { maxOutputLength: 8 * 1024 * 1024 }).toString('latin1');
      // Seguridad: nunca se guarda un archivo con llave privada (CAF)
      if (/RSASK|PRIVATE KEY/i.test(contenido)) throw new Error('El archivo contiene una llave privada: no se guarda');
      const dtes = separarDtes(contenido);
      if (!dtes.length) throw new Error('XML no reconocido');
      for (const xml of dtes) {
        const x = datosDte(xml);
        if (!x || !TIPO_SISGEN_POR_SII[x.tipo] || !x.folio || !/^\d{4}-\d{2}-\d{2}$/.test(x.fecha)) throw new Error('XML no reconocido');
        if (x.rutEmisor !== agente.rut.toUpperCase()) throw new Error('El XML es de otra razón social');
        if (x.fecha < FECHA_MINIMA) continue;
        filas.push({ ...x, xml, archivo: texto(a.nombre, 60) });
      }
    } catch (e) {
      rechazados.push({ nombre: texto(a.nombre, 60), motivo: e.message.slice(0, 80) });
    }
  }
  const base = carpetaXml();
  transaccion((d) => {
    const ins = d.prepare(
      `INSERT INTO xml_documentos (rut_emisor, tipo_sii, folio, sucursal_id, fecha, rut_receptor, nombre_receptor, total, archivo, ruta)
       VALUES (?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(rut_emisor, tipo_sii, folio) DO UPDATE SET
         fecha = COALESCE(xml_documentos.fecha, excluded.fecha), rut_receptor = COALESCE(xml_documentos.rut_receptor, excluded.rut_receptor),
         nombre_receptor = COALESCE(xml_documentos.nombre_receptor, excluded.nombre_receptor),
         total = COALESCE(xml_documentos.total, excluded.total), sucursal_id = COALESCE(xml_documentos.sucursal_id, excluded.sucursal_id)`
    );
    const reemplazar = d.prepare(
      `UPDATE xml_documentos SET sucursal_id = ?, fecha = ?, rut_receptor = ?, nombre_receptor = ?, total = ?, archivo = ?,
              recibido_en = datetime('now') WHERE rut_emisor = ? AND tipo_sii = ? AND folio = ?`
    );
    const existe = d.prepare('SELECT 1 FROM xml_documentos WHERE rut_emisor = ? AND tipo_sii = ? AND folio = ?');
    // Corrección: XML de un documento que estaba en blanco / sin XML, o republicado (un archivo distinto y más
    // nuevo que el que ya teníamos; el mismo archivo reenviado no cuenta)
    const conProblema = d.prepare(`SELECT 1 FROM docs_sisgen WHERE rut_emisor = ? AND tipo_sii = ? AND folio = ? AND (en_blanco = 1 OR sin_xml = 1) AND fecha < date('now', 'localtime')`);
    const anterior = d.prepare('SELECT archivo FROM xml_documentos WHERE rut_emisor = ? AND tipo_sii = ? AND folio = ?');
    const marca = (nombre) => /-(\d{8}-\d{6})\.xml$/i.exec(String(nombre ?? ''))?.[1] ?? null;
    for (const x of filas) {
      if (historial) continue;
      const ant = anterior.get(agente.rut, x.tipo, x.folio)?.archivo;
      const republicado = ant && marca(x.archivo) && marca(ant) && marca(x.archivo) > marca(ant);
      if (republicado || conProblema.get(agente.rut, x.tipo, x.folio)) {
        corregidos.push({ tipo: x.tipo, folio: x.folio, periodo: x.fecha.slice(0, 7) });
      }
    }
    for (const x of filas) {
      const rel = rutaRelativaXml(agente.rut, x.tipo, x.folio);
      const abs = path.join(base, rel);
      const yaEsta = !!existe.get(agente.rut, x.tipo, x.folio);
      // El historial no pisa un XML ya archivado (el de línea es el más reciente)
      if (!historial || !yaEsta || !fs.existsSync(abs)) {
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, zlib.gzipSync(Buffer.from(x.xml, 'latin1')));
      }
      ins.run(agente.rut, x.tipo, x.folio, agente.sucursal_id, x.fecha, x.rutReceptor, x.nombreReceptor, x.total, x.archivo, rel);
      if (!historial && yaEsta) reemplazar.run(agente.sucursal_id, x.fecha, x.rutReceptor, x.nombreReceptor, x.total, x.archivo, agente.rut, x.tipo, x.folio);
      guardados++;
    }
    if (historial) return;
    const doc = d.prepare(
      `INSERT INTO docs_sisgen (rut_emisor, sucursal_id, periodo, tipo_sisgen, tipo_sii, folio, fecha, rut_receptor,
                                nombre_receptor, neto, exento, iva, total, origen)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'AGENTE')
       ON CONFLICT(sucursal_id, periodo, tipo_sisgen, folio) DO UPDATE SET
         neto = excluded.neto, exento = excluded.exento, iva = excluded.iva, total = excluded.total, sin_xml = 0,
         importado_en = datetime('now')
       WHERE docs_sisgen.origen = 'AGENTE'`
    );
    for (const x of filas) {
      doc.run(agente.rut, agente.sucursal_id, x.fecha.slice(0, 7), TIPO_SISGEN_POR_SII[x.tipo], x.tipo, x.folio, x.fecha,
        x.rutReceptor, x.nombreReceptor, x.neto, x.exento, x.iva, x.total);
    }
  });
  return { guardados, rechazados, corregidos };
}

/**
 * Compras: XML recibidos de proveedores (carpeta procesos\Correo\Descargas de Sisgen).
 * Solo se guardan los DTE cuyo receptor es esta razón social; lo demás (respuestas, acuses, otros
 * archivos del correo) se ignora. Un mismo documento se guarda una vez (proveedor + tipo + folio).
 */
export function guardarCompras(agente, archivos, motivos = null) {
  let guardados = 0, ignorados = 0;
  const anotar = (motivo, muestra) => {
    if (!motivos) return;
    motivos.conteo[motivo] = (motivos.conteo[motivo] ?? 0) + 1;
    if (muestra && (motivos.muestras[motivo] ??= []).length < 15) motivos.muestras[motivo].push(muestra);
  };
  const rechazados = [];
  const filas = [];
  const propio = agente.rut.toUpperCase();
  for (const a of archivos) {
    try {
      const contenido = zlib.gunzipSync(Buffer.from(String(a.contenido ?? ''), 'base64'), { maxOutputLength: 8 * 1024 * 1024 }).toString('latin1');
      if (/RSASK|PRIVATE KEY/i.test(contenido)) throw new Error('El archivo contiene una llave privada: no se guarda');
      let dtes = [];
      try { dtes = separarDtes(contenido); } catch { dtes = []; }
      const raiz = /<([A-Za-z_][\w.:-]*)[\s>]/.exec(contenido.replace(/<\?xml[^>]*>/, '').replace(/<!--[\s\S]*?-->/g, ''))?.[1] ?? '?';
      if (!dtes.length) anotar(`sin DTE (raíz ${raiz})`, texto(a.nombre, 60));
      let alguno = false;
      for (const xml of dtes) {
        let x = null;
        try { x = datosDte(xml); } catch { x = null; }
        if (!x || !x.tipo || !x.folio || !/^\d{4}-\d{2}-\d{2}$/.test(x.fecha) || !/^\d{1,8}-[\dK]$/.test(x.rutEmisor)) {
          anotar('DTE ilegible', `${texto(a.nombre, 60)} (raíz ${raiz})`);
          continue;
        }
        if (String(x.rutReceptor ?? '').toUpperCase() !== propio) { // no es una compra de esta razón social
          anotar(x.rutEmisor === propio ? 'emitido por la propia empresa' : 'receptor es otro RUT', `${texto(a.nombre, 60)}: T${x.tipo} F${x.folio} emisor ${x.rutEmisor} receptor ${x.rutReceptor}`);
          continue;
        }
        anotar('compra');
        filas.push({ ...x, xml, archivo: texto(a.nombre, 120) });
        alguno = true;
      }
      if (!alguno) ignorados++;
    } catch (e) {
      rechazados.push({ nombre: texto(a.nombre, 120), motivo: e.message.slice(0, 80) });
    }
  }
  const base = carpetaXml();
  transaccion((d) => {
    const ins = d.prepare(
      `INSERT INTO compras_documentos (rut_receptor, rut_emisor, tipo_sii, folio, sucursal_id, razon_social, fecha, neto, exento, iva, total, archivo, ruta)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT (rut_receptor, rut_emisor, tipo_sii, folio) DO UPDATE SET
         razon_social = COALESCE(excluded.razon_social, compras_documentos.razon_social), fecha = excluded.fecha,
         neto = excluded.neto, exento = excluded.exento, iva = excluded.iva, total = excluded.total,
         archivo = excluded.archivo, sucursal_id = COALESCE(compras_documentos.sucursal_id, excluded.sucursal_id)`
    );
    for (const x of filas) {
      const rel = rutaRelativaCompra(agente.rut, x.rutEmisor, x.tipo, x.folio);
      const abs = path.join(base, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, zlib.gzipSync(Buffer.from(x.xml, 'latin1')));
      ins.run(agente.rut, x.rutEmisor, x.tipo, x.folio, agente.sucursal_id, x.nombreEmisor, x.fecha, x.neto, x.exento, x.iva, x.total, x.archivo, rel);
      guardados++;
    }
  });
  return { guardados, ignorados, rechazados };
}

/** XML archivado de un documento (texto), o null. */
export function xmlGuardado(rut, tipo, folio) {
  const f = getDb().prepare('SELECT ruta FROM xml_documentos WHERE rut_emisor = ? AND tipo_sii = ? AND folio = ?').get(rut, tipo, folio);
  if (!f) return null;
  try { return zlib.gunzipSync(fs.readFileSync(path.join(carpetaXml(), f.ruta))).toString('latin1'); } catch { return null; }
}

/** Avance de la carga del historial que informa el agente. */
export function registrarHistorial(agenteId, resumen) {
  if (resumen) getDb().prepare('UPDATE agentes SET historial = ? WHERE id = ?').run(String(resumen).slice(0, 120), agenteId);
}

/** Datos impresos en los documentos (oficina SII y resolución), informados por el agente. */
export function guardarDatosImpresion(rut, empresa) {
  if (!empresa) return;
  getDb().prepare(
    `UPDATE empresas SET oficina_sii = COALESCE(?, oficina_sii), resolucion_numero = COALESCE(?, resolucion_numero),
            resolucion_fecha = COALESCE(?, resolucion_fecha) WHERE rut = ?`
  ).run(texto(empresa.oficinaSii, 60), texto(empresa.resolucionNumero, 20), texto(empresa.resolucionFecha, 10), rut);
}

// ---------- Ventas del mes (lo que el agente leyó de las tablas de Sisgen) ----------
const num = (v) => Number(v ?? 0) || 0;
const folioDe = (v) => parseInt(v, 10);
const fechaDe = (v) => fechaIso(texto(v, 10));

/** Índice de XML a partir de los nombres de archivo (T39F123-20261111-191629.xml). */
function indiceXml(nombres) {
  const idx = new Map();
  for (const n of nombres ?? []) {
    const m = /^T(\d+)F(\d+)-(\d{4})(\d{2})(\d{2})/i.exec(String(n));
    if (!m) continue;
    const tipo = Number(m[1]), folio = Number(m[2]);
    if (!idx.has(`${tipo}-${folio}`)) idx.set(`${tipo}-${folio}`, { tipoSii: tipo, folio, fecha: `${m[3]}-${m[4]}-${m[5]}` });
  }
  return idx;
}

/**
 * Importa las ventas de un mes enviadas por el agente, con la misma lógica que la importación por
 * red (F1 + F2 + CLIDOCTO + CLIPAGOS + índice de XML), y los rangos de folios (CAF).
 * El paquete trae solo los campos necesarios: nunca claves ni llaves privadas.
 */
export function importarMes(agente, p) {
  const periodo = String(p?.periodo ?? '');
  if (!/^\d{4}-\d{2}$/.test(periodo)) throw conflicto('Periodo no válido', 400);
  if (!Array.isArray(p.f1)) throw conflicto('Falta F1 del mes', 400);
  const f1 = [];
  for (const r of p.f1) {
    const folio = folioDe(r.FANUMERO), tipo = String(r.FATDOCTO ?? '').trim().toUpperCase();
    if (!tipo || !Number.isFinite(folio)) continue;
    f1.push({
      tipoSisgen: tipo, tipoSii: tipoSii(tipo), folio, fecha: fechaDe(r.FAFECHA),
      rutReceptor: r.FARUTCLI ? normalizarRut(r.FARUTCLI) : null, nombreReceptor: texto(r.FANOMCLI, 60),
      neto: num(r.FAAFECTO), exento: num(r.FAEXENTO), iva: num(r.FAIVA), total: num(r.FATOTAL),
      codSucursalSisgen: texto(r.CODSUC, 10), electronico: String(r.ELECTRON ?? '').trim() === 'S',
    });
  }
  const detalle = Array.isArray(p.detalle)
    ? new Set(p.detalle.map((k) => { const [t, f] = String(k).split('-'); return `${t.trim().toUpperCase()}-${folioDe(f)}`; }))
    : null;
  const enPeriodo = (f) => typeof f === 'string' && f.startsWith(periodo);
  const clidocto = Array.isArray(p.clidocto)
    ? p.clidocto.map((r) => ({
      tipoSisgen: String(r.TDOCTO ?? '').trim().toUpperCase(), folio: folioDe(r.NUMFAC), fecha: fechaDe(r.FECFAC),
      rut: texto(r.RUTCLI, 12), nombre: texto(r.NOMCLI, 60), monto: num(r.MONTO),
    })).filter((c) => c.tipoSisgen && Number.isFinite(c.folio) && enPeriodo(c.fecha))
    : null;
  let clipagos = null;
  if (Array.isArray(p.clipagos)) {
    const porDoc = new Map();
    for (const r of p.clipagos) {
      const t = String(r.TDOCTO ?? '').trim().toUpperCase(), folio = folioDe(r.NUMFAC);
      if (!t || !Number.isFinite(folio) || !enPeriodo(fechaDe(r.FECPAG))) continue;
      const x = porDoc.get(`${t}-${folio}`) || { tipoSisgen: t, folio, rut: texto(r.RUTCLI, 12), monto: 0 };
      x.monto += num(r.VALDOC);
      porDoc.set(`${t}-${folio}`, x);
    }
    clipagos = [...porDoc.values()];
  }
  const xml = Array.isArray(p.xml) ? indiceXml(p.xml) : null;
  // Montos de XML sin registro en las tablas: se toman de los XML que el agente ya subió
  if (xml) {
    // (solo se abren los XML de documentos que no están en ninguna tabla: son pocos)
    const conocidos = new Set([...f1, ...(clidocto ?? []), ...(clipagos ?? [])].filter((d) => tipoSii(d.tipoSisgen)).map((d) => `${tipoSii(d.tipoSisgen)}-${d.folio}`));
    for (const [k, x] of xml) {
      if (conocidos.has(k)) continue;
      const texto = xmlGuardado(agente.rut, x.tipoSii, x.folio);
      if (!texto) continue;
      try { Object.assign(x, datosDte(texto) ?? {}); } catch { /* sin datos */ }
    }
  }
  const docs = consolidar({ f1, detalle, clidocto, clipagos, xml }).map((d) => ({ ...d, rutEmisor: agente.rut }));
  reemplazarDocsSisgen(agente.sucursal_id, periodo, docs);
  if (Array.isArray(p.xmlVecinos)) reemplazarXmlOtrosMeses(agente.sucursal_id, agente.rut, periodo, [...indiceXml(p.xmlVecinos).values()]);
  if (Array.isArray(p.cafs)) {
    const rangos = p.cafs
      .map((c) => ({ tipoSii: Number(c.tipo), desde: Number(c.desde), hasta: Number(c.hasta), archivo: texto(c.archivo, 60), fechaAutorizacion: texto(c.fa, 10) }))
      .filter((c) => c.tipoSii > 0 && c.desde > 0 && c.hasta >= c.desde);
    reemplazarRangosCaf(agente.sucursal_id, agente.rut, rangos);
  }
  return { periodo, documentos: docs.length, enBlanco: docs.filter((d) => d.enBlanco).length, sinXml: docs.filter((d) => d.sinXml).length };
}
