// Capa de base de datos.
// Piloto: SQLite (node:sqlite, incluido en Node >= 22.5). Todo el acceso pasa por este
// módulo para poder migrar a PostgreSQL sin tocar el resto del sistema.
import fs from 'node:fs';
import os from 'node:os';
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

-- ===== Acceso al portal =====
-- Cliente = la empresa (grupo) con que trabaja Sisgen; agrupa una o varias razones sociales.
CREATE TABLE IF NOT EXISTS clientes (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  activo         INTEGER NOT NULL DEFAULT 1,
  creado_en      TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- Usuarios creados por Sisgen (no hay registro abierto).
-- rol 'admin' = equipo Sisgen (ve todo); 'cliente' = ve solo las razones sociales de su cliente.
CREATE TABLE IF NOT EXISTS usuarios (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  usuario            TEXT NOT NULL UNIQUE COLLATE NOCASE,
  nombre             TEXT NOT NULL,
  clave_hash         TEXT NOT NULL,
  rol                TEXT NOT NULL CHECK (rol IN ('admin', 'cliente')),
  cliente_id         INTEGER REFERENCES clientes(id),
  activo             INTEGER NOT NULL DEFAULT 1,
  debe_cambiar_clave INTEGER NOT NULL DEFAULT 1,
  intentos_fallidos  INTEGER NOT NULL DEFAULT 0,
  bloqueado_hasta    TEXT,
  creado_en          TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  ultimo_ingreso     TEXT,
  CHECK (rol = 'admin' OR cliente_id IS NOT NULL)
);

-- Sesiones: solo se guarda el hash del token (la cookie lleva el token).
CREATE TABLE IF NOT EXISTS sesiones (
  token_hash     TEXT PRIMARY KEY,
  usuario_id     INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  creada_en      TEXT NOT NULL,
  expira_en      TEXT NOT NULL,
  ip             TEXT
);

-- Registro de intentos de ingreso (auditoría)
CREATE TABLE IF NOT EXISTS ingresos (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  usuario        TEXT,
  usuario_id     INTEGER,
  exito          INTEGER NOT NULL,
  motivo         TEXT,
  ip             TEXT,
  fecha          TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- Bloques de folios recibidos por el SII que no pertenecen a ningún CAF de las sucursales
-- (boletas emitidas fuera de Sisgen). Se recalculan en cada sincronización del periodo.
CREATE TABLE IF NOT EXISTS sii_folios_externos (
  rut_emisor     TEXT NOT NULL,
  periodo        TEXT NOT NULL,
  tipo_sii       INTEGER NOT NULL,
  desde          INTEGER NOT NULL,
  ultimo         INTEGER NOT NULL,
  cantidad       INTEGER NOT NULL,
  caf_antes      TEXT,                      -- sucursal dueña del CAF anterior al bloque
  caf_despues    TEXT,                      -- sucursal dueña del CAF posterior al bloque
  consultado_en  TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  PRIMARY KEY (rut_emisor, periodo, tipo_sii, desde)
);

-- ===== Agente Sisgen (servicio de Windows en cada sucursal) =====
-- Cada sucursal tiene a lo más un agente; solo se guarda el hash de su llave.
-- Llave de instalación: se genera para un cliente (sucursal_id NULL); al conectarse por primera vez
-- el agente informa su razón social y sucursal (empres.dbf) y queda asociado a ella.
CREATE TABLE IF NOT EXISTS agentes (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  sucursal_id      INTEGER UNIQUE REFERENCES sucursales(id),
  cliente_id       INTEGER REFERENCES clientes(id),
  llave_hash       TEXT NOT NULL UNIQUE,
  activo           INTEGER NOT NULL DEFAULT 1,
  creado_en        TEXT NOT NULL DEFAULT (datetime('now')),
  ultimo_contacto  TEXT,                    -- UTC
  version          TEXT,
  equipo           TEXT,
  ip               TEXT,
  ultimo_error     TEXT
);

-- Envío de cada documento al SII según DTESERVICE (tablas trazadte / trazabol de la sucursal)
CREATE TABLE IF NOT EXISTS envios_sii (
  rut_emisor     TEXT NOT NULL,
  tipo_sii       INTEGER NOT NULL,
  folio          INTEGER NOT NULL,
  sucursal_id    INTEGER REFERENCES sucursales(id),
  fecha          TEXT,
  emitido_en     TEXT,                      -- como lo anota DTESERVICE (dd-mm-aaaa hh:mm:ss)
  enviado_en     TEXT,
  track_id       TEXT,
  estado_envio   TEXT,
  estado_sii     TEXT,                      -- DOK, EPR, RCH, …
  detalle_sii    TEXT,
  actualizado_en TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (rut_emisor, tipo_sii, folio)
);

-- Archivo de XML de documentos subidos por el agente (en línea e historial desde 2001): permite
-- descargar XML/PDF de cualquier documento sin acceso a la sucursal. El XML va comprimido en disco
-- (carpeta xml junto a la base); aquí quedan los datos para buscarlo.
CREATE TABLE IF NOT EXISTS xml_documentos (
  rut_emisor      TEXT NOT NULL,
  tipo_sii        INTEGER NOT NULL,
  folio           INTEGER NOT NULL,
  sucursal_id     INTEGER REFERENCES sucursales(id),
  fecha           TEXT,
  rut_receptor    TEXT,
  nombre_receptor TEXT,
  total           REAL,
  archivo         TEXT,                     -- nombre original en la sucursal
  ruta            TEXT NOT NULL,            -- relativa a la carpeta xml del portal
  recibido_en     TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (rut_emisor, tipo_sii, folio)
);
`;

let db;
let carpetaXmlActual = null;

/** Carpeta donde se guardan los XML comprimidos (junto a la base de datos). */
export function carpetaXml() {
  if (!carpetaXmlActual) throw new Error('Base de datos no inicializada');
  return carpetaXmlActual;
}

export function abrirDb(rutaArchivo) {
  if (db) return db;
  carpetaXmlActual = rutaArchivo === ':memory:'
    ? fs.mkdtempSync(path.join(os.tmpdir(), 'cuadratura-xml-'))
    : path.join(path.dirname(path.resolve(rutaArchivo)), 'xml');
  if (rutaArchivo !== ':memory:') fs.mkdirSync(path.dirname(rutaArchivo), { recursive: true });
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
  const colsEmp = d.prepare('PRAGMA table_info(empresas)').all().map((c) => c.name);
  if (!colsEmp.includes('cliente_id')) d.exec('ALTER TABLE empresas ADD COLUMN cliente_id INTEGER REFERENCES clientes(id)');
  // origen: F1 (importación de tablas Sisgen) | AGENTE (llegó en línea desde la sucursal)
  if (!cols.includes('origen')) d.exec("ALTER TABLE docs_sisgen ADD COLUMN origen TEXT NOT NULL DEFAULT 'F1'");
  // agentes: primera versión exigía sucursal_id; ahora admite llave de instalación por cliente
  const colsAg = d.prepare('PRAGMA table_info(agentes)').all().map((c) => c.name);
  if (!colsAg.includes('cliente_id')) {
    d.exec(`BEGIN;
      ALTER TABLE agentes RENAME TO agentes_v1;
      ${ESQUEMA.match(/CREATE TABLE IF NOT EXISTS agentes \([\s\S]*?\n\);/)[0]}
      INSERT INTO agentes (id, sucursal_id, llave_hash, activo, creado_en, ultimo_contacto, version, equipo, ip, ultimo_error)
        SELECT id, sucursal_id, llave_hash, activo, creado_en, ultimo_contacto, version, equipo, ip, ultimo_error FROM agentes_v1;
      DROP TABLE agentes_v1;
      COMMIT;`);
  }
  if (!colsAg.includes('historial')) d.exec('ALTER TABLE agentes ADD COLUMN historial TEXT');
  // Fecha de autorización del CAF (<FA>): facturas y notas vencen a los 180 días
  const colsCaf = d.prepare('PRAGMA table_info(caf_rangos)').all().map((c) => c.name);
  if (!colsCaf.includes('fecha_autorizacion')) d.exec('ALTER TABLE caf_rangos ADD COLUMN fecha_autorizacion TEXT');
  // Datos impresos en los documentos (vienen de empres.dbf vía agente)
  const colsEmp2 = d.prepare('PRAGMA table_info(empresas)').all().map((c) => c.name);
  for (const c of ['oficina_sii', 'resolucion_numero', 'resolucion_fecha']) {
    if (!colsEmp2.includes(c)) d.exec(`ALTER TABLE empresas ADD COLUMN ${c} TEXT`);
  }
  // xml_documentos v1 guardaba el XML dentro de la base: se pasa a archivos en disco
  const colsXml = d.prepare('PRAGMA table_info(xml_documentos)').all().map((c) => c.name);
  if (colsXml.includes('xml_gz')) {
    const viejos = d.prepare('SELECT * FROM xml_documentos').all();
    d.exec('ALTER TABLE xml_documentos RENAME TO xml_documentos_v1;');
    d.exec(ESQUEMA.match(/CREATE TABLE IF NOT EXISTS xml_documentos \([\s\S]*?\n\);/)[0]);
    const ins = d.prepare(`INSERT INTO xml_documentos (rut_emisor, tipo_sii, folio, sucursal_id, archivo, ruta, recibido_en)
                           VALUES (?,?,?,?,?,?,?)`);
    for (const v of viejos) {
      const rel = rutaRelativaXml(v.rut_emisor, v.tipo_sii, v.folio);
      fs.mkdirSync(path.dirname(path.join(carpetaXml(), rel)), { recursive: true });
      fs.writeFileSync(path.join(carpetaXml(), rel), v.xml_gz);
      ins.run(v.rut_emisor, v.tipo_sii, v.folio, v.sucursal_id, v.archivo, rel, v.recibido_en);
    }
    d.exec('DROP TABLE xml_documentos_v1');
  }
  d.exec('CREATE INDEX IF NOT EXISTS ix_xml_fecha ON xml_documentos (rut_emisor, fecha);');
}

/** Ruta (relativa a la carpeta xml) donde se guarda el XML comprimido de un documento. */
export const rutaRelativaXml = (rut, tipo, folio) => path.join(rut, String(tipo), `${folio}.xml.gz`);

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

/** @param {Set<string>|null} [soloRuts] null = todas */
export function listarEmpresas(soloRuts = null) {
  const d = getDb();
  const empresas = d
    .prepare(`SELECT e.rut, e.razon_social, e.es_demo, e.cliente_id, c.nombre AS cliente
                FROM empresas e LEFT JOIN clientes c ON c.id = e.cliente_id ORDER BY e.razon_social`)
    .all()
    .filter((e) => !soloRuts || soloRuts.has(e.rut));
  const sucs = d.prepare('SELECT id, codigo, nombre FROM sucursales WHERE rut_empresa = ? ORDER BY nombre');
  const periodos = d.prepare(
    'SELECT DISTINCT periodo FROM docs_sisgen WHERE rut_emisor = ? UNION SELECT DISTINCT periodo FROM docs_sii WHERE rut_emisor = ? ORDER BY periodo DESC'
  );
  const ultimoSisgen = d.prepare('SELECT MAX(periodo) AS p FROM docs_sisgen WHERE rut_emisor = ?');
  return empresas.map((e) => ({
    rut: e.rut,
    razonSocial: e.razon_social,
    esDemo: !!e.es_demo,
    clienteId: e.cliente_id ?? null,
    cliente: e.cliente ?? null,
    sucursales: sucs.all(e.rut),
    periodos: periodos.all(e.rut, e.rut).map((p) => p.periodo),
    // Último mes con ventas cargadas desde Sisgen (el "último mes disponible" por defecto)
    ultimoPeriodoSisgen: ultimoSisgen.get(e.rut)?.p ?? null,
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

/**
 * Reemplaza los documentos Sisgen de una sucursal/periodo (reimportación idempotente).
 * Los que llegaron en línea desde el agente (origen AGENTE) se conservan si la importación no los
 * trae (p. ej. emitidos después de leer F1); si los trae, pasan a tener los datos de F1.
 */
export function reemplazarDocsSisgen(sucursalId, periodo, docs) {
  return transaccion((d) => {
    d.prepare("DELETE FROM docs_sisgen WHERE sucursal_id = ? AND periodo = ? AND origen = 'F1'").run(sucursalId, periodo);
    const ins = d.prepare(
      `INSERT INTO docs_sisgen (rut_emisor, sucursal_id, periodo, tipo_sisgen, tipo_sii, folio, fecha,
         rut_receptor, nombre_receptor, neto, exento, iva, total, en_blanco, sin_xml)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(sucursal_id, periodo, tipo_sisgen, folio) DO UPDATE SET
         rut_emisor = excluded.rut_emisor, tipo_sii = excluded.tipo_sii, fecha = excluded.fecha,
         rut_receptor = excluded.rut_receptor, nombre_receptor = excluded.nombre_receptor, neto = excluded.neto,
         exento = excluded.exento, iva = excluded.iva, total = excluded.total, en_blanco = excluded.en_blanco,
         sin_xml = excluded.sin_xml, origen = 'F1', importado_en = datetime('now')`
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

/** Sucursales de una razón social con la última vez que se leyeron sus datos de Sisgen. */
export function sucursalesConLectura(rut) {
  return getDb()
    .prepare(
      `SELECT s.id, s.codigo, s.nombre,
              (SELECT MAX(importado_en) FROM docs_sisgen d WHERE d.sucursal_id = s.id) AS ultima_lectura,
              (SELECT MAX(periodo) FROM docs_sisgen d WHERE d.sucursal_id = s.id) AS ultimo_periodo
         FROM sucursales s WHERE s.rut_empresa = ? ORDER BY s.nombre`
    )
    .all(rut);
}

/**
 * Huella de los datos de una razón social en un periodo: cambia cada vez que se reimporta
 * desde Sisgen o se vuelve a consultar el SII (sirve para no recalcular la cuadratura sin necesidad).
 */
export function huellaDatos(rut, periodo) {
  const d = getDb();
  const a = d.prepare('SELECT COUNT(*) AS n, MAX(importado_en) AS m FROM docs_sisgen WHERE rut_emisor = ? AND periodo = ?').get(rut, periodo);
  const b = d.prepare('SELECT COUNT(*) AS n, MAX(consultado_en) AS m FROM docs_sii WHERE rut_emisor = ? AND periodo = ?').get(rut, periodo);
  const c = sincronizacionSii(rut, periodo);
  const f = d.prepare('SELECT COUNT(*) AS n, MAX(consultado_en) AS m FROM sii_folios_externos WHERE rut_emisor = ? AND periodo = ?').get(rut, periodo);
  const g = d.prepare("SELECT COUNT(*) AS n, MAX(actualizado_en) AS m FROM envios_sii WHERE rut_emisor = ? AND fecha LIKE ? || '%'").get(rut, periodo);
  return [a.n, a.m, b.n, b.m, c?.consultado_en, f.n, f.m, g.n, g.m].join('|');
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

/** Envíos al SII (Track ID y respuesta según DTESERVICE) de los documentos de un periodo. */
export function enviosSii(rut, periodo) {
  const filas = getDb()
    .prepare("SELECT tipo_sii, folio, track_id, estado_envio, estado_sii, detalle_sii FROM envios_sii WHERE rut_emisor = ? AND fecha LIKE ? || '%'")
    .all(rut, periodo);
  return new Map(filas.map((f) => [`${f.tipo_sii}-${f.folio}`, f]));
}

/**
 * Documentos (tipo-folio) registrados en Sisgen (F1, no en blanco) en OTRO mes que el indicado.
 * Sirve para no contar como "en blanco" un XML regenerado después para un documento de otro mes.
 */
export function registradosEnOtroMes(rut, periodo, claves) {
  if (!claves.length) return new Map();
  const st = getDb().prepare(
    `SELECT periodo FROM docs_sisgen WHERE rut_emisor = ? AND tipo_sii = ? AND folio = ? AND periodo <> ? AND en_blanco = 0 LIMIT 1`
  );
  const r = new Map();
  for (const k of claves) {
    const [tipo, folio] = k.split('-').map(Number);
    const f = st.get(rut, tipo, folio, periodo);
    if (f) r.set(k, f.periodo);
  }
  return r;
}

/** Reemplaza los rangos CAF de una sucursal. */
export function reemplazarRangosCaf(sucursalId, rutEmpresa, rangos) {
  return transaccion((d) => {
    d.prepare('DELETE FROM caf_rangos WHERE sucursal_id = ?').run(sucursalId);
    const ins = d.prepare(
      `INSERT OR IGNORE INTO caf_rangos (sucursal_id, rut_empresa, tipo_sii, desde, hasta, archivo, fecha_autorizacion)
       VALUES (?,?,?,?,?,?,?)`
    );
    for (const r of rangos) {
      const fa = /^\d{4}-\d{2}-\d{2}$/.test(r.fechaAutorizacion ?? '') ? r.fechaAutorizacion : null;
      ins.run(sucursalId, rutEmpresa, r.tipoSii, r.desde, r.hasta, r.archivo ?? null, fa);
    }
    return rangos.length;
  });
}

export function rangosCaf(rut) {
  return getDb()
    .prepare(
      `SELECT c.tipo_sii, c.desde, c.hasta, c.fecha_autorizacion, s.nombre AS sucursal
         FROM caf_rangos c JOIN sucursales s ON s.id = c.sucursal_id
        WHERE c.rut_empresa = ?`
    )
    .all(rut);
}

/** Folio más alto emitido (en cualquier mes) dentro de un rango, o null si no se ha usado. */
export function ultimoFolioUsado(rut, tipoSii, desde, hasta) {
  return getDb()
    .prepare('SELECT MAX(folio) AS f FROM docs_sisgen WHERE rut_emisor = ? AND tipo_sii = ? AND folio BETWEEN ? AND ?')
    .get(rut, tipoSii, desde, hasta)?.f ?? null;
}

/** Cantidad de documentos Sisgen por tipo SII en un periodo. */
export function conteoSisgenPorTipo(rut, periodo) {
  const filas = getDb()
    .prepare('SELECT tipo_sii, COUNT(*) AS n FROM docs_sisgen WHERE rut_emisor = ? AND periodo = ? AND tipo_sii IS NOT NULL GROUP BY tipo_sii')
    .all(rut, periodo);
  return new Map(filas.map((f) => [f.tipo_sii, f.n]));
}

/** Boletas (u otro tipo) de Sisgen de un periodo, para verificarlas una a una. */
export function docsSisgenDeTipo(rut, periodo, tipoSii) {
  return getDb()
    .prepare(
      `SELECT d.tipo_sii, d.folio, d.fecha, d.total, d.rut_receptor, s.nombre AS sucursal FROM docs_sisgen d
         JOIN sucursales s ON s.id = d.sucursal_id
        WHERE d.rut_emisor = ? AND d.periodo = ? AND d.tipo_sii = ?`
    )
    .all(rut, periodo, tipoSii);
}

/** Boletas del periodo que la API de boletas dejó con algún problema (se vuelven a consultar). */
export function boletasConProblemaApi(rut, periodo) {
  return getDb()
    .prepare(
      `SELECT d.tipo_sii, d.folio, d.fecha, d.total, d.rut_receptor FROM docs_sii a
         JOIN docs_sisgen d ON d.rut_emisor = a.rut_emisor AND d.tipo_sii = a.tipo_sii AND d.folio = a.folio AND d.periodo = a.periodo
        WHERE a.rut_emisor = ? AND a.periodo = ? AND a.fuente = 'API_BOLETA' AND a.estado <> 'ACEPTADO'`
    )
    .all(rut, periodo);
}

/** Reemplaza los bloques de folios externos detectados para un RUT/periodo/tipo. */
export function reemplazarFoliosExternos(rut, periodo, tipoSii, bloques) {
  return transaccion((d) => {
    d.prepare('DELETE FROM sii_folios_externos WHERE rut_emisor = ? AND periodo = ? AND tipo_sii = ?').run(rut, periodo, tipoSii);
    const ins = d.prepare(
      `INSERT INTO sii_folios_externos (rut_emisor, periodo, tipo_sii, desde, ultimo, cantidad, caf_antes, caf_despues)
       VALUES (?,?,?,?,?,?,?,?)`
    );
    for (const b of bloques) ins.run(rut, periodo, tipoSii, b.desde, b.ultimo, b.cantidad, b.antes ?? null, b.despues ?? null);
    return bloques.length;
  });
}

export function foliosExternos(rut, periodo) {
  return getDb().prepare('SELECT * FROM sii_folios_externos WHERE rut_emisor = ? AND periodo = ? ORDER BY tipo_sii, desde').all(rut, periodo);
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
