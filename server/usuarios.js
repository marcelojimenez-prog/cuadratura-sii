// Acceso al portal: clientes, usuarios, sesiones y permisos por razón social.
import { getDb, transaccion } from './db.js';
import { hashClave, verificarClave, tokenSesion, hashToken } from './lib/auth/claves.js';

export const MAX_INTENTOS = 5;
export const MINUTOS_BLOQUEO = 15;
export const HORAS_SESION = 8;

const ahora = () => new Date();
const iso = (d) => d.toISOString();

// ---------- Clientes ----------
export function guardarCliente(nombre) {
  const d = getDb();
  d.prepare('INSERT INTO clientes (nombre) VALUES (?) ON CONFLICT(nombre) DO NOTHING').run(nombre.trim());
  return d.prepare('SELECT * FROM clientes WHERE nombre = ?').get(nombre.trim());
}

export function buscarCliente(nombreOId) {
  const d = getDb();
  return /^\d+$/.test(String(nombreOId))
    ? d.prepare('SELECT * FROM clientes WHERE id = ?').get(Number(nombreOId))
    : d.prepare('SELECT * FROM clientes WHERE nombre = ?').get(String(nombreOId).trim());
}

export function asignarEmpresasACliente(clienteId, ruts) {
  return transaccion((d) => {
    const st = d.prepare('UPDATE empresas SET cliente_id = ? WHERE rut = ?');
    return ruts.map((rut) => ({ rut, ok: st.run(clienteId, rut).changes > 0 }));
  });
}

export function listarClientes() {
  const d = getDb();
  const emp = d.prepare('SELECT rut, razon_social FROM empresas WHERE cliente_id = ? ORDER BY razon_social');
  const usu = d.prepare('SELECT usuario, nombre, activo, ultimo_ingreso FROM usuarios WHERE cliente_id = ? ORDER BY usuario');
  return d.prepare('SELECT * FROM clientes ORDER BY nombre').all()
    .map((c) => ({ ...c, empresas: emp.all(c.id), usuarios: usu.all(c.id) }));
}

// ---------- Usuarios ----------
export function crearUsuario({ usuario, nombre, clave, rol, clienteId = null }) {
  if (!/^[a-zA-Z0-9._-]{3,40}$/.test(usuario)) throw new Error('Usuario: 3 a 40 caracteres (letras, números, punto, guion)');
  getDb()
    .prepare(`INSERT INTO usuarios (usuario, nombre, clave_hash, rol, cliente_id, debe_cambiar_clave) VALUES (?,?,?,?,?,1)`)
    .run(usuario, nombre, hashClave(clave), rol, rol === 'admin' ? null : clienteId);
  return buscarUsuario(usuario);
}

export function buscarUsuario(usuario) {
  return getDb().prepare('SELECT * FROM usuarios WHERE usuario = ?').get(usuario) ?? null;
}

export function listarUsuarios() {
  return getDb()
    .prepare(`SELECT u.id, u.usuario, u.nombre, u.rol, u.activo, u.ultimo_ingreso, c.nombre AS cliente
                FROM usuarios u LEFT JOIN clientes c ON c.id = u.cliente_id ORDER BY u.rol, c.nombre, u.usuario`)
    .all();
}

// ---------- Administración (panel web) ----------
export function actualizarCliente(id, { nombre, activo }) {
  const d = getDb();
  if (nombre != null) d.prepare('UPDATE clientes SET nombre = ? WHERE id = ?').run(String(nombre).trim(), id);
  if (activo != null) {
    transaccion((t) => {
      t.prepare('UPDATE clientes SET activo = ? WHERE id = ?').run(activo ? 1 : 0, id);
      // Desactivar un cliente cierra las sesiones de sus usuarios
      if (!activo) t.prepare('DELETE FROM sesiones WHERE usuario_id IN (SELECT id FROM usuarios WHERE cliente_id = ?)').run(id);
    });
  }
  return d.prepare('SELECT * FROM clientes WHERE id = ?').get(id) ?? null;
}

/** Asigna (o quita, con clienteId null) una razón social a un cliente. */
export function asignarEmpresa(rut, clienteId) {
  return getDb().prepare('UPDATE empresas SET cliente_id = ? WHERE rut = ?').run(clienteId, rut).changes > 0;
}

export function listarEmpresasAdmin() {
  const d = getDb();
  return d.prepare(
    `SELECT e.rut, e.razon_social, e.es_demo, e.cliente_id, c.nombre AS cliente,
            (SELECT COUNT(*) FROM sucursales s WHERE s.rut_empresa = e.rut) AS sucursales,
            (SELECT MAX(periodo) FROM docs_sisgen x WHERE x.rut_emisor = e.rut) AS ultimo_periodo,
            (SELECT MAX(consultado_en) FROM sii_sincronizaciones y WHERE y.rut_emisor = e.rut) AS ultima_consulta_sii
       FROM empresas e LEFT JOIN clientes c ON c.id = e.cliente_id ORDER BY e.razon_social`
  ).all();
}

export function listarUsuariosAdmin() {
  return getDb()
    .prepare(`SELECT u.id, u.usuario, u.nombre, u.rol, u.cliente_id, c.nombre AS cliente, u.activo,
                     u.debe_cambiar_clave, u.bloqueado_hasta, u.creado_en, u.ultimo_ingreso
                FROM usuarios u LEFT JOIN clientes c ON c.id = u.cliente_id ORDER BY u.rol, c.nombre, u.usuario`)
    .all()
    .map((u) => ({ ...u, bloqueado: !!(u.bloqueado_hasta && new Date(u.bloqueado_hasta) > new Date()) }));
}

export function adminsActivos() {
  return getDb().prepare("SELECT COUNT(*) AS n FROM usuarios WHERE rol = 'admin' AND activo = 1").get().n;
}

export function actualizarUsuario(id, { nombre, clienteId }) {
  return transaccion((d) => {
    if (nombre != null) d.prepare('UPDATE usuarios SET nombre = ? WHERE id = ?').run(String(nombre).trim(), id);
    if (clienteId != null) {
      d.prepare("UPDATE usuarios SET cliente_id = ? WHERE id = ? AND rol = 'cliente'").run(clienteId, id);
      d.prepare('DELETE FROM sesiones WHERE usuario_id = ?').run(id); // cambia lo que puede ver
    }
  });
}

export function usuarioPorId(id) {
  return getDb().prepare('SELECT * FROM usuarios WHERE id = ?').get(id) ?? null;
}

export function listarIngresos(limite = 200) {
  return getDb().prepare('SELECT * FROM ingresos ORDER BY id DESC LIMIT ?').all(limite);
}

export function hayUsuarios() {
  return getDb().prepare('SELECT COUNT(*) AS n FROM usuarios').get().n > 0;
}

/** Fija una clave. temporal=true obliga a cambiarla en el próximo ingreso. Cierra sus sesiones. */
export function fijarClave(usuarioId, clave, { temporal }) {
  return transaccion((d) => {
    d.prepare(`UPDATE usuarios SET clave_hash = ?, debe_cambiar_clave = ?, intentos_fallidos = 0, bloqueado_hasta = NULL WHERE id = ?`)
      .run(hashClave(clave), temporal ? 1 : 0, usuarioId);
    if (temporal) d.prepare('DELETE FROM sesiones WHERE usuario_id = ?').run(usuarioId);
  });
}

export function activarUsuario(usuarioId, activo) {
  return transaccion((d) => {
    d.prepare('UPDATE usuarios SET activo = ? WHERE id = ?').run(activo ? 1 : 0, usuarioId);
    if (!activo) d.prepare('DELETE FROM sesiones WHERE usuario_id = ?').run(usuarioId);
  });
}

// ---------- Ingreso ----------
function registrarIngreso(usuario, usuarioId, exito, motivo, ip) {
  getDb().prepare('INSERT INTO ingresos (usuario, usuario_id, exito, motivo, ip) VALUES (?,?,?,?,?)')
    .run(String(usuario ?? '').slice(0, 60), usuarioId ?? null, exito ? 1 : 0, motivo ?? null, ip ?? null);
}

/**
 * Valida usuario y clave. Bloquea la cuenta tras MAX_INTENTOS fallidos seguidos.
 * @returns {{ ok:true, token, usuario } | { ok:false, motivo:'credenciales'|'bloqueado'|'inactivo', minutos? }}
 */
export function iniciarSesion(usuario, clave, ip) {
  const u = usuario ? buscarUsuario(String(usuario).trim()) : null;
  if (!u) {
    // Mismo costo que una verificación real: no revela si el usuario existe
    verificarClave(String(clave ?? ''), 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$' + 'A'.repeat(86) + '==');
    registrarIngreso(usuario, null, false, 'usuario inexistente', ip);
    return { ok: false, motivo: 'credenciales' };
  }
  if (u.bloqueado_hasta && new Date(u.bloqueado_hasta) > ahora()) {
    registrarIngreso(u.usuario, u.id, false, 'bloqueado', ip);
    return { ok: false, motivo: 'bloqueado', minutos: Math.ceil((new Date(u.bloqueado_hasta) - ahora()) / 60000) };
  }
  if (!verificarClave(String(clave ?? ''), u.clave_hash)) {
    const intentos = u.intentos_fallidos + 1;
    const bloqueo = intentos >= MAX_INTENTOS ? iso(new Date(Date.now() + MINUTOS_BLOQUEO * 60000)) : null;
    getDb().prepare('UPDATE usuarios SET intentos_fallidos = ?, bloqueado_hasta = ? WHERE id = ?')
      .run(bloqueo ? 0 : intentos, bloqueo, u.id);
    registrarIngreso(u.usuario, u.id, false, bloqueo ? 'clave incorrecta (bloqueado)' : 'clave incorrecta', ip);
    return bloqueo ? { ok: false, motivo: 'bloqueado', minutos: MINUTOS_BLOQUEO } : { ok: false, motivo: 'credenciales' };
  }
  if (!u.activo) {
    registrarIngreso(u.usuario, u.id, false, 'inactivo', ip);
    return { ok: false, motivo: 'inactivo' };
  }
  const token = tokenSesion();
  const t = ahora();
  transaccion((d) => {
    d.prepare('UPDATE usuarios SET intentos_fallidos = 0, bloqueado_hasta = NULL, ultimo_ingreso = ? WHERE id = ?')
      .run(t.toLocaleString('sv-SE'), u.id);
    d.prepare('DELETE FROM sesiones WHERE expira_en < ?').run(iso(t));
    d.prepare('INSERT INTO sesiones (token_hash, usuario_id, creada_en, expira_en, ip) VALUES (?,?,?,?,?)')
      .run(hashToken(token), u.id, iso(t), iso(new Date(t.getTime() + HORAS_SESION * 3600000)), ip ?? null);
  });
  registrarIngreso(u.usuario, u.id, true, null, ip);
  return { ok: true, token, usuario: usuarioPublico(buscarUsuario(u.usuario)) };
}

/** Usuario de una sesión vigente (renueva la expiración), o null. */
export function usuarioDeSesion(token) {
  if (!token) return null;
  const d = getDb();
  const h = hashToken(token);
  const s = d.prepare('SELECT * FROM sesiones WHERE token_hash = ?').get(h);
  if (!s) return null;
  const t = ahora();
  if (new Date(s.expira_en) < t) {
    d.prepare('DELETE FROM sesiones WHERE token_hash = ?').run(h);
    return null;
  }
  const u = d.prepare('SELECT * FROM usuarios WHERE id = ?').get(s.usuario_id);
  if (!u || !u.activo) return null;
  // Renovación deslizante: si queda menos de la mitad, se extiende
  if (new Date(s.expira_en) - t < (HORAS_SESION * 3600000) / 2) {
    d.prepare('UPDATE sesiones SET expira_en = ? WHERE token_hash = ?').run(iso(new Date(t.getTime() + HORAS_SESION * 3600000)), h);
  }
  return usuarioPublico(u);
}

export function cerrarSesion(token) {
  if (token) getDb().prepare('DELETE FROM sesiones WHERE token_hash = ?').run(hashToken(token));
}

/** Cambio de clave hecho por el propio usuario (exige la clave actual). Cierra sus otras sesiones. */
export function cambiarClavePropia(usuarioId, actual, nueva, tokenActual) {
  const u = getDb().prepare('SELECT * FROM usuarios WHERE id = ?').get(usuarioId);
  if (!u || !verificarClave(String(actual ?? ''), u.clave_hash)) return false;
  transaccion((d) => {
    d.prepare('UPDATE usuarios SET clave_hash = ?, debe_cambiar_clave = 0 WHERE id = ?').run(hashClave(nueva), usuarioId);
    d.prepare('DELETE FROM sesiones WHERE usuario_id = ? AND token_hash <> ?').run(usuarioId, hashToken(tokenActual ?? ''));
  });
  return true;
}

export function usuarioPublico(u) {
  const cliente = u.cliente_id ? getDb().prepare('SELECT nombre FROM clientes WHERE id = ?').get(u.cliente_id) : null;
  return {
    id: u.id, usuario: u.usuario, nombre: u.nombre, rol: u.rol,
    clienteId: u.cliente_id, cliente: cliente?.nombre ?? null, debeCambiarClave: !!u.debe_cambiar_clave,
  };
}

// ---------- Permisos ----------
/** RUTs que puede ver el usuario; null = todos (administrador Sisgen). */
export function rutsPermitidos(usuario) {
  if (usuario.rol === 'admin') return null;
  const filas = getDb()
    .prepare('SELECT e.rut FROM empresas e JOIN clientes c ON c.id = e.cliente_id WHERE e.cliente_id = ? AND c.activo = 1')
    .all(usuario.clienteId);
  return new Set(filas.map((f) => f.rut));
}

export function puedeVer(usuario, rut) {
  const p = rutsPermitidos(usuario);
  return p === null || p.has(rut);
}
