// Capa de base de datos.
// Piloto: SQLite (node:sqlite, incluido en Node >= 22.5). Todo el acceso pasa por este
// módulo para poder migrar a PostgreSQL sin tocar el resto del sistema.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const ESQUEMA = `
CREATE TABLE IF NOT EXISTS empresas (
  rut            TEXT PRIMARY KEY,          -- RUT emisor con DV, ej: 11111111-1
  razon_social   TEXT NOT NULL,
  es_demo        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sucursales (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  rut_empresa    TEXT NOT NULL REFERENCES empresas(rut),
  codigo         TEXT NOT NULL,
  nombre         TEXT NOT NULL,
  ruta_datos     TEXT,                      -- carpeta datos* de Sisgen
  ruta_procesos  TEXT,                      -- carpeta procesos de Sisgen (XML, timbres, CAF)
  UNIQUE (rut_empresa, codigo)
);

-- Lo que Sisgen dice que se emitió (tablas F1 de cada sucursal)
CREATE TABLE IF NOT EXISTS docs_sisgen (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  rut_emisor     TEXT NOT NULL REFERENCES empresas(rut),
  sucursal_id    INTEGER NOT NULL REFERENCES sucursales(id),
  periodo        TEXT NOT NULL,             -- YYYY-MM
  tipo_sisgen    TEXT NOT NULL,             -- FE, BE, NE, ...
  tipo_sii       INTEGER,                   -- 33, 39, 61, ... (NULL si no es tributario)
  folio          INTEGER NOT NULL,
  fecha          TEXT,                      -- YYYY-MM-DD
  rut_receptor   TEXT,
  nombre_receptor TEXT,
  neto           REAL DEFAULT 0,
  exento         REAL DEFAULT 0,
  iva            REAL DEFAULT 0,
  total          REAL DEFAULT 0,
  en_blanco      INTEGER NOT NULL DEFAULT 0, -- no quedó completo en F1/F2 (se reconstruyó de CLIDOCTO/CLIPAGOS/XML)
  sin_xml        INTEGER NOT NULL DEFAULT 0, -- registrado en Sisgen pero sin XML en procesos\\DTE
  importado_en   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (sucursal_id, periodo, tipo_sisgen, folio)
);
CREATE INDEX IF NOT EXISTS ix_sisgen_periodo ON docs_sisgen (rut_emisor, periodo);

-- XML de DTE generados en los meses vecinos al periodo importado (explican "saltos" de folio)
CREATE TABLE IF NOT EXISTS xml_otros_meses (
  sucursal_id    INTEGER NOT NULL REFERENCES sucursales(id),
  rut_empresa    TEXT NOT NULL,
  periodo        TEXT NOT NULL,             -- periodo importado al que se asocian
  tipo_sii       INTEGER NOT NULL,
  folio          INTEGER NOT NULL,
  fecha          TEXT,
  PRIMARY KEY (sucursal_id, periodo, tipo_sii, folio)
);

-- Rangos de folios (CAF) cargados en cada sucursal (procesos\\Folios)
CREATE TABLE IF NOT EXISTS caf_rangos (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  sucursal_id    INTEGER NOT NULL REFERENCES sucursales(id),
  rut_empresa    TEXT NOT NULL REFERENCES empresas(rut),
  tipo_sii       INTEGER NOT NULL,
  desde          INTEGER NOT NULL,
  hasta          INTEGER NOT NULL,
  archivo        TEXT,
  UNIQUE (sucursal_id, tipo_sii, desde)
);
CREATE INDEX IF NOT EXISTS ix_caf_rut ON caf_rangos (rut_empresa, tipo_sii);

-- Totales del Registro de Ventas (RCV) por tipo: única fuente del SII para boletas (vienen resumidas)
CREATE TABLE IF NOT EXISTS sii_resumen (
  rut_emisor     TEXT NOT NULL,
  periodo        TEXT NOT NULL,
  tipo_sii       INTEGER NOT NULL,
  nombre         TEXT,
  tipo_ingreso   TEXT,                      -- RESUMEN (boletas) | DET_ELE (detalle electrónico) | …
  tot_doc        INTEGER NOT NULL DEFAULT 0,
  monto_neto     REAL DEFAULT 0,
  monto_exento   REAL DEFAULT 0,
  monto_iva      REAL DEFAULT 0,
  monto_total    REAL DEFAULT 0,
  PRIMARY KEY (rut_emisor, periodo, tipo_sii)
);

-- Registro de cada sincronización con el SII (sirve para saber qué periodos ya se consultaron)
CREATE TABLE IF NOT EXISTS sii_sincronizaciones (
  rut_emisor     TEXT NOT NULL,
  periodo        TEXT NOT NULL,
  consultado_en  TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  PRIMARY KEY (rut_emisor, periodo)
);

-- Lo que el SII tiene registrado (RCV, consulta estado DTE, API boletas)
CREATE TABLE IF NOT EXISTS docs_sii (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  rut_emisor     TEXT NOT NULL REFERENCES empresas(rut),
  periodo        TEXT NOT NULL,
  tipo_sii       INTEGER NOT NULL,
  folio          INTEGER NOT NULL,
  fecha          TEXT,
  rut_receptor   TEXT,
  total          REAL DEFAULT 0,
  estado         TEXT NOT NULL,             -- REGISTRADO | ACEPTADO | REPARO | RECHAZADO | ANULADO
  motivo         TEXT,                      -- glosa del SII cuando hay rechazo/reparo
  fuente         TEXT NOT NULL,             -- RCV | ESTADO_DTE | ESTADO_ENVIO | API_BOLETA | DEMO
  consultado_en  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (rut_emisor, tipo_sii, folio)
);
CREATE INDEX IF NOT EXISTS ix_sii_periodo ON docs_sii (rut_emisor, periodo);
`;

let db;

export function abrirDb(rutaArchivo) {
  if (db) return db;
  fs.mkdirSync(path.dirname(rutaArchivo), { recursive: true });
  db = new DatabaseSync(rutaArchivo);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 30000;');
  db.exec(ESQUEMA);
  migrar(db);
  return db;
}

/** Cambios de esquema sobre bases ya creadas. */
function migrar(d) {
  const cols = d.prepare('PRAGMA table_info(docs_sisgen)').all().map((c) => c.name);
  if (!cols.includes('en_blanco')) d.exec('ALTER TABLE docs_sisgen ADD COLUMN en_blanco INTEGER NOT NULL DEFAULT 0');
  if (!cols.includes('sin_xml')) d.exec('ALTER TABLE docs_sisgen ADD COLUMN sin_xml INTEGER NOT NULL DEFAULT 0');
  const colsSuc = d.prepare('PRAGMA table_info(sucursales)').all().map((c) => c.name);
  if (!colsSuc.includes('ruta_procesos')) d.exec('ALTER TABLE sucursales ADD COLUMN ruta_procesos TEXT');
}

export function getDb() {
  if (!db) throw new Error('Base de datos no inicializada');
  return db;
}

/** Ejecuta fn dentro de una transacción. */
export function transaccion(fn) {
  const d = getDb();
  d.exec('BEGIN');
  try {
    const r = fn(d);
    d.exec('COMMIT');
    return r;
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
}

// ---------- Consultas ----------

export function listarEmpresas() {
  const d = getDb();
  const empresas = d.prepare('SELECT rut, razon_social, es_demo FROM empresas ORDER BY razon_social').all();
  const sucs = d.prepare('SELECT id, codigo, nombre FROM sucursales WHERE rut_empresa = ? ORDER BY nombre');
  const periodos = d.prepare(
    'SELECT DISTINCT periodo FROM docs_sisgen WHERE rut_emisor = ? UNION SELECT DISTINCT periodo FROM docs_sii WHERE rut_emisor = ? ORDER BY periodo DESC'
  );
  return empresas.map((e) => ({
    rut: e.rut,
    razonSocial: e.razon_social,
    esDemo: !!e.es_demo,
    sucursales: sucs.all(e.rut),
    periodos: periodos.all(e.rut, e.rut).map((p) => p.periodo),
  }));
}

export function docsSisgen(rut, periodo) {
  return getDb()
    .prepare(
      `SELECT d.*, s.nombre AS sucursal, s.codigo AS sucursal_codigo
         FROM docs_sisgen d JOIN sucursales s ON s.id = d.sucursal_id
        WHERE d.rut_emisor = ? AND d.periodo = ?`
    )
    .all(rut, periodo);
}

/** Documento de Sisgen con la carpeta procesos de su sucursal (para ubicar XML y timbre). */
export function documentoConSucursal(rut, tipoSii, folio, sucursal) {
  return getDb()
    .prepare(
      `SELECT d.tipo_sii, d.tipo_sisgen, d.folio, d.fecha, d.periodo, s.nombre AS sucursal, s.ruta_procesos, s.ruta_datos
         FROM docs_sisgen d JOIN sucursales s ON s.id = d.sucursal_id
        WHERE d.rut_emisor = ? AND d.tipo_sii = ? AND d.folio = ? AND (? IS NULL OR s.nombre = ?)
        ORDER BY d.periodo DESC LIMIT 1`
    )
    .get(rut, tipoSii, folio, sucursal ?? null, sucursal ?? null);
}

export function docsSii(rut, periodo) {
  return getDb().prepare('SELECT * FROM docs_sii WHERE rut_emisor = ? AND periodo = ?').all(rut, periodo);
}

export function guardarEmpresa({ rut, razonSocial, esDemo = false }) {
  getDb()
    .prepare(
      `INSERT INTO empresas (rut, razon_social, es_demo) VALUES (?, ?, ?)
       ON CONFLICT(rut) DO UPDATE SET razon_social = excluded.razon_social`
    )
    .run(rut, razonSocial, esDemo ? 1 : 0);
}

export function guardarSucursal({ rutEmpresa, codigo, nombre, rutaDatos = null, rutaProcesos = null }) {
  const d = getDb();
  d.prepare(
    `INSERT INTO sucursales (rut_empresa, codigo, nombre, ruta_datos, ruta_procesos) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(rut_empresa, codigo) DO UPDATE SET nombre = excluded.nombre, ruta_datos = excluded.ruta_datos,
       ruta_procesos = excluded.ruta_procesos`
  ).run(rutEmpresa, codigo, nombre, rutaDatos, rutaProcesos);
  return d.prepare('SELECT id FROM sucursales WHERE rut_empresa = ? AND codigo = ?').get(rutEmpresa, codigo).id;
}

/** Reemplaza los documentos Sisgen de una sucursal/periodo (reimportación idempotente). */
export function reemplazarDocsSisgen(sucursalId, periodo, docs) {
  return transaccion((d) => {
    d.prepare('DELETE FROM docs_sisgen WHERE sucursal_id = ? AND periodo = ?').run(sucursalId, periodo);
    const ins = d.prepare(
      `INSERT INTO docs_sisgen (rut_emisor, sucursal_id, periodo, tipo_sisgen, tipo_sii, folio, fecha,
         rut_receptor, nombre_receptor, neto, exento, iva, total, en_blanco, sin_xml)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    );
    for (const x of docs) {
      ins.run(x.rutEmisor, sucursalId, periodo, x.tipoSisgen, x.tipoSii, x.folio, x.fecha ?? null,
        x.rutReceptor ?? null, x.nombreReceptor ?? null, x.neto ?? 0, x.exento ?? 0, x.iva ?? 0, x.total ?? 0,
        x.enBlanco ? 1 : 0, x.sinXml ? 1 : 0);
    }
    return docs.length;
  });
}

/**
 * Guarda una sincronización completa del RCV de un periodo: resumen por tipo + detalle.
 * Reemplaza lo anterior de esa fuente para que documentos eliminados del RCV no queden.
 */
export function guardarSincronizacionRcv(rut, periodo, resumen, detalle) {
  return transaccion((d) => {
    d.prepare('DELETE FROM sii_resumen WHERE rut_emisor = ? AND periodo = ?').run(rut, periodo);
    const insR = d.prepare(
      `INSERT INTO sii_resumen (rut_emisor, periodo, tipo_sii, nombre, tipo_ingreso, tot_doc, monto_neto, monto_exento, monto_iva, monto_total)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    );
    for (const r of resumen) {
      insR.run(rut, periodo, r.tipoSii, r.nombre, r.tipoIngreso, r.totDoc, r.montoNeto, r.montoExento, r.montoIva, r.montoTotal);
    }
    d.prepare("DELETE FROM docs_sii WHERE rut_emisor = ? AND periodo = ? AND fuente = 'RCV'").run(rut, periodo);
    const insD = d.prepare(
      `INSERT INTO docs_sii (rut_emisor, periodo, tipo_sii, folio, fecha, rut_receptor, total, estado, motivo, fuente)
       VALUES (?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(rut_emisor, tipo_sii, folio) DO UPDATE SET
         periodo = excluded.periodo, fecha = excluded.fecha, rut_receptor = excluded.rut_receptor,
         total = excluded.total, estado = excluded.estado, motivo = excluded.motivo,
         fuente = excluded.fuente, consultado_en = datetime('now')`
    );
    for (const x of detalle) {
      insD.run(rut, periodo, x.tipoSii, x.folio, x.fecha ?? null, x.rutReceptor ?? null, x.total ?? 0, x.estado, x.motivo ?? null, x.fuente);
    }
    d.prepare(
      `INSERT INTO sii_sincronizaciones (rut_emisor, periodo) VALUES (?, ?)
       ON CONFLICT(rut_emisor, periodo) DO UPDATE SET consultado_en = datetime('now','localtime')`
    ).run(rut, periodo);
    return { tipos: resumen.length, documentos: detalle.length };
  });
}

/** Boletas sospechosas (sin XML o en blanco) que conviene verificar una a una en la API de boletas. */
export function boletasSospechosas(rut, periodo) {
  return getDb()
    .prepare(
      `SELECT tipo_sii, folio, fecha, total, rut_receptor FROM docs_sisgen
        WHERE rut_emisor = ? AND periodo = ? AND tipo_sii IN (39, 41) AND (sin_xml = 1 OR en_blanco = 1)`
    )
    .all(rut, periodo);
}

export function resumenSii(rut, periodo) {
  return getDb().prepare('SELECT * FROM sii_resumen WHERE rut_emisor = ? AND periodo = ?').all(rut, periodo);
}

export function sincronizacionSii(rut, periodo) {
  return getDb().prepare('SELECT consultado_en FROM sii_sincronizaciones WHERE rut_emisor = ? AND periodo = ?').get(rut, periodo) ?? null;
}

/** Reemplaza el índice de XML de meses vecinos de una sucursal/periodo. */
export function reemplazarXmlOtrosMeses(sucursalId, rutEmpresa, periodo, lista) {
  return transaccion((d) => {
    d.prepare('DELETE FROM xml_otros_meses WHERE sucursal_id = ? AND periodo = ?').run(sucursalId, periodo);
    const ins = d.prepare(
      'INSERT OR IGNORE INTO xml_otros_meses (sucursal_id, rut_empresa, periodo, tipo_sii, folio, fecha) VALUES (?,?,?,?,?,?)'
    );
    for (const x of lista) ins.run(sucursalId, rutEmpresa, periodo, x.tipoSii, x.folio, x.fecha ?? null);
    return lista.length;
  });
}

/** Map 'tipo-folio' -> fecha de XML emitidos en meses vecinos (cualquier sucursal del RUT). */
export function xmlOtrosMeses(rut, periodo) {
  const filas = getDb()
    .prepare('SELECT tipo_sii, folio, fecha FROM xml_otros_meses WHERE rut_empresa = ? AND periodo = ?')
    .all(rut, periodo);
  return new Map(filas.map((f) => [`${f.tipo_sii}-${f.folio}`, f.fecha]));
}

/** Reemplaza los rangos CAF de una sucursal. */
export function reemplazarRangosCaf(sucursalId, rutEmpresa, rangos) {
  return transaccion((d) => {
    d.prepare('DELETE FROM caf_rangos WHERE sucursal_id = ?').run(sucursalId);
    const ins = d.prepare(
      `INSERT OR IGNORE INTO caf_rangos (sucursal_id, rut_empresa, tipo_sii, desde, hasta, archivo)
       VALUES (?,?,?,?,?,?)`
    );
    for (const r of rangos) ins.run(sucursalId, rutEmpresa, r.tipoSii, r.desde, r.hasta, r.archivo ?? null);
    return rangos.length;
  });
}

export function rangosCaf(rut) {
  return getDb()
    .prepare(
      `SELECT c.tipo_sii, c.desde, c.hasta, s.nombre AS sucursal
         FROM caf_rangos c JOIN sucursales s ON s.id = c.sucursal_id
        WHERE c.rut_empresa = ?`
    )
    .all(rut);
}

/** Inserta o actualiza el estado SII de documentos. */
export function guardarDocsSii(docs) {
  return transaccion((d) => {
    const up = d.prepare(
      `INSERT INTO docs_sii (rut_emisor, periodo, tipo_sii, folio, fecha, rut_receptor, total, estado, motivo, fuente)
       VALUES (?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(rut_emisor, tipo_sii, folio) DO UPDATE SET
         periodo = excluded.periodo, fecha = excluded.fecha, rut_receptor = excluded.rut_receptor,
         total = excluded.total, estado = excluded.estado, motivo = excluded.motivo,
         fuente = excluded.fuente, consultado_en = datetime('now')`
    );
    for (const x of docs) {
      up.run(x.rutEmisor, x.periodo, x.tipoSii, x.folio, x.fecha ?? null, x.rutReceptor ?? null,
        x.total ?? 0, x.estado, x.motivo ?? null, x.fuente);
    }
    return docs.length;
  });
}

export function hayDatos() {
  return getDb().prepare('SELECT COUNT(*) AS n FROM empresas').get().n > 0;
}
