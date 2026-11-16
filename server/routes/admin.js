// Panel de administración (solo usuarios Sisgen con rol admin).
import { Router } from 'express';
import { requiereAdmin } from './auth.js';
import {
  guardarCliente, buscarCliente, actualizarCliente, asignarEmpresa, listarClientes, listarEmpresasAdmin,
  listarUsuariosAdmin, crearUsuario, buscarUsuario, usuarioPorId, actualizarUsuario, activarUsuario, fijarClave,
  adminsActivos, listarIngresos,
} from '../usuarios.js';
import { claveTemporal } from '../lib/auth/claves.js';
import { listarEmpresas, getDb } from '../db.js';
import { estadoEmpresa, filaCliente, sucursalesEstado, numeroRut, gravedadEmpresa } from '../lib/cuadratura/resumen.js';
import { generarLlaveAgente, generarLlaveInstalacion, activarAgente } from '../agentes.js';
import { sincronizarEmpresa } from '../lib/sii/sincronizar.js';
import { clienteRemoto } from '../lib/sii/clientes.js';
import { agenteDisponible, estadoCertificado } from '../lib/sii/remoto.js';

const r = Router();
r.use(requiereAdmin);

/**
 * Inicio del equipo Sisgen: listado simple, una fila por razón social (sin agrupar por cliente) con
 * sus sucursales. El mes y la cuadratura se ven al entrar a cada razón social.
 */
r.get('/razones', (_req, res) => {
  const filas = listarEmpresas().map((e) => {
    const sucs = sucursalesEstado(e.rut);
    const lecturas = sucs.map((s) => s.ultimaLectura).filter(Boolean).sort();
    return {
      rut: e.rut, razonSocial: e.razonSocial, esDemo: e.esDemo, clienteId: e.clienteId,
      periodo: e.ultimoPeriodoSisgen ?? e.periodos[0] ?? null,
      sucursales: sucs.length, nombresSucursales: sucs.map((s) => s.nombre),
      sucursalesDesactualizadas: sucs.filter((s) => s.desactualizada).length,
      lecturaMasAntigua: sucs.some((s) => !s.ultimaLectura) ? null : lecturas[0] ?? null,
    };
  });
  res.json({ razones: filas });
});

/** Todos los agentes instalados, con su estado (para la pantalla "Agentes instalados"). */
r.get('/agentes', (_req, res) => {
  const filas = getDb().prepare(
    `SELECT a.id, a.activo, a.ultimo_contacto, a.version, a.equipo, a.ultimo_error, a.historial, a.creado_en, a.certificado, a.ventas_mes,
            s.nombre AS sucursal, e.rut, e.razon_social, COALESCE(c.id, ci.id) AS cliente_id, COALESCE(c.nombre, ci.nombre) AS cliente
       FROM agentes a
       LEFT JOIN sucursales s ON s.id = a.sucursal_id
       LEFT JOIN empresas e ON e.rut = s.rut_empresa
       LEFT JOIN clientes c ON c.id = e.cliente_id
       LEFT JOIN clientes ci ON ci.id = a.cliente_id
      ORDER BY COALESCE(c.nombre, ci.nombre), s.nombre`
  ).all();
  res.json(filas.map((a) => ({
    id: a.id, activo: !!a.activo, ultimoContacto: a.ultimo_contacto, version: a.version, equipo: a.equipo, error: a.ultimo_error,
    historial: a.historial, sucursal: a.sucursal, rut: a.rut, razonSocial: a.razon_social, clienteId: a.cliente_id, cliente: a.cliente,
    // El certificado de cada agente (cada sucursal puede tener su propia carpeta de certificado)
    certificado: a.certificado ?? (a.rut ? estadoCertificado(a.rut) : null),
    creadoEn: a.creado_en, ventasMes: a.ventas_mes,
  })));
});

// ---------- Consulta al SII a pedido (con el certificado del cliente, a través de su agente) ----------
const consultasEnCurso = new Map(); // rut -> { inicio, periodo, lineas: [], fin, error }

r.post('/empresas/:rut/consultar-sii', (req, res) => {
  const { rut } = req.params;
  const periodo = /^\d{4}-\d{2}$/.test(req.body?.periodo ?? '') ? req.body.periodo : null;
  const emp = getDb().prepare('SELECT rut, razon_social FROM empresas WHERE rut = ?').get(rut);
  if (!emp || !periodo) return error(res, 400, 'Razón social o periodo no válidos');
  if (!agenteDisponible(rut)) {
    return error(res, 409, `El agente de esta razón social no está disponible para consultar al SII (certificado: ${estadoCertificado(rut) ?? 'sin información'})`);
  }
  const actual = consultasEnCurso.get(rut);
  if (actual && !actual.fin) return error(res, 409, 'Ya hay una consulta en curso para esta razón social');
  const estado = { inicio: new Date().toISOString(), periodo, lineas: [], fin: null, error: null };
  consultasEnCurso.set(rut, estado);
  sincronizarEmpresa({ rut, razonSocial: emp.razon_social }, periodo, clienteRemoto(), (m) => estado.lineas.push(m))
    .catch((e) => { estado.error = e.message; })
    .finally(() => { estado.fin = new Date().toISOString(); });
  res.status(202).json({ ok: true });
});

r.get('/empresas/:rut/consultar-sii', (req, res) => {
  res.json({ certificado: estadoCertificado(req.params.rut), disponible: agenteDisponible(req.params.rut), consulta: consultasEnCurso.get(req.params.rut) ?? null });
});

const id = (v) => (/^\d+$/.test(String(v)) ? Number(v) : null);
const error = (res, status, msg) => res.status(status).json({ error: msg });

// ---------- Agente Sisgen de cada sucursal ----------
const sucursal = (sid) => getDb().prepare('SELECT id, nombre, rut_empresa FROM sucursales WHERE id = ?').get(sid) ?? null;

/** Genera (o reemplaza) la llave del agente de la sucursal. Se muestra una sola vez. */
r.post('/sucursales/:id/agente', (req, res) => {
  const s = sucursal(id(req.params.id));
  if (!s) return error(res, 404, 'Sucursal no encontrada');
  res.status(201).json({ sucursal: s.nombre, rut: s.rut_empresa, llave: generarLlaveAgente(s.id) });
});

/**
 * Llave de instalación de un cliente: sirve para instalar el agente en un servidor nuevo; al conectarse,
 * el agente crea su razón social y sucursal (según su empres.dbf) dentro de este cliente.
 */
r.post('/clientes/:id/llave-instalacion', (req, res) => {
  const c = buscarCliente(id(req.params.id));
  if (!c) return error(res, 404, 'Cliente no encontrado');
  res.status(201).json({ sucursal: `nueva sucursal de ${c.nombre}`, llave: generarLlaveInstalacion(c.id) });
});

r.patch('/sucursales/:id/agente', (req, res) => {
  const s = sucursal(id(req.params.id));
  if (!s || typeof req.body?.activo !== 'boolean') return error(res, 400, 'Datos no válidos');
  if (!activarAgente(s.id, req.body.activo)) return error(res, 404, 'La sucursal aún no tiene agente');
  res.json({ ok: true });
});

/** Todo lo que necesita el panel en una sola llamada. */
r.get('/datos', (_req, res) => {
  res.json({
    clientes: listarClientes().map((c) => ({ id: c.id, nombre: c.nombre, activo: !!c.activo, empresas: c.empresas.length, usuarios: c.usuarios.length })),
    empresas: listarEmpresasAdmin(),
    usuarios: listarUsuariosAdmin(),
  });
});

const periodoValido = (p) => (/^\d{4}-\d{2}$/.test(p ?? '') ? p : null);

/**
 * Tabla de trabajo: una fila por cliente con el estado de sus razones sociales en el periodo
 * (por defecto, el último periodo con datos de cada razón social).
 */
r.get('/tabla', (req, res) => {
  const periodo = periodoValido(req.query.periodo);
  const empresas = listarEmpresas();
  const filas = listarClientes().map((c) => {
    const suyas = empresas.filter((e) => e.clienteId === c.id);
    return filaCliente(
      { id: c.id, nombre: c.nombre, activo: !!c.activo, usuarios: c.usuarios.length },
      suyas.map((e) => estadoEmpresa(e, periodo)),
      suyas.flatMap((e) => sucursalesEstado(e.rut)),
    );
  });
  res.json({
    periodo,
    periodos: [...new Set(empresas.flatMap((e) => e.periodos))].sort().reverse(),
    clientes: filas,
    sinCliente: empresas.filter((e) => !e.clienteId).map((e) => ({ rut: e.rut, razonSocial: e.razonSocial })),
  });
});

/** Ficha de un cliente: razones sociales con sus sucursales, usuarios y estado del periodo. */
r.get('/clientes/:id/ficha', (req, res) => {
  const c = buscarCliente(id(req.params.id));
  if (!c) return error(res, 404, 'Cliente no encontrado');
  const periodo = periodoValido(req.query.periodo);
  const empresas = listarEmpresas().filter((e) => e.clienteId === c.id);
  const razones = empresas
    .map((e) => estadoEmpresa(e, periodo))
    .map((x) => ({ ...x, estado: gravedadEmpresa(x), sucursales: sucursalesEstado(x.rut) }))
    .sort((a, b) => numeroRut(a.rut) - numeroRut(b.rut));
  res.json({
    cliente: { id: c.id, nombre: c.nombre, activo: !!c.activo, creadoEn: c.creado_en },
    periodo,
    periodos: [...new Set(empresas.flatMap((e) => e.periodos))].sort().reverse(),
    resumen: filaCliente({}, razones, razones.flatMap((x) => x.sucursales)),
    razones,
    usuarios: listarUsuariosAdmin().filter((u) => u.cliente_id === c.id).map((u) => ({
      id: u.id, usuario: u.usuario, nombre: u.nombre, activo: !!u.activo, ultimoIngreso: u.ultimo_ingreso,
      debeCambiarClave: !!u.debe_cambiar_clave, bloqueado: u.bloqueado,
    })),
  });
});

r.get('/ingresos',(req, res) => res.json(listarIngresos(Math.min(Number(req.query.limite) || 200, 1000))));

// ---------- Clientes ----------
r.post('/clientes', (req, res) => {
  const nombre = String(req.body?.nombre ?? '').trim();
  if (nombre.length < 2) return error(res, 400, 'Ingresa el nombre del cliente');
  if (buscarCliente(nombre)) return error(res, 409, 'Ya existe un cliente con ese nombre');
  res.status(201).json(guardarCliente(nombre));
});

r.patch('/clientes/:id', (req, res) => {
  const cid = id(req.params.id);
  if (!cid || !buscarCliente(cid)) return error(res, 404, 'Cliente no encontrado');
  const { nombre, activo } = req.body ?? {};
  if (nombre != null) {
    const n = String(nombre).trim();
    if (n.length < 2) return error(res, 400, 'Nombre inválido');
    const otro = buscarCliente(n);
    if (otro && otro.id !== cid) return error(res, 409, 'Ya existe un cliente con ese nombre');
  }
  res.json(actualizarCliente(cid, { nombre, activo: activo == null ? null : !!activo }));
});

// ---------- Razones sociales ----------
r.put('/empresas/:rut/cliente', (req, res) => {
  const clienteId = req.body?.clienteId == null ? null : id(req.body.clienteId);
  if (req.body?.clienteId != null && (!clienteId || !buscarCliente(clienteId))) return error(res, 400, 'Cliente no válido');
  if (!asignarEmpresa(req.params.rut, clienteId)) return error(res, 404, 'Razón social no encontrada');
  res.json({ ok: true });
});

// ---------- Usuarios ----------
/** Crea un usuario y devuelve su clave temporal (se muestra una sola vez en el panel). */
r.post('/usuarios', (req, res) => {
  const { usuario, nombre, rol, clienteId } = req.body ?? {};
  if (!['admin', 'cliente'].includes(rol)) return error(res, 400, 'Rol no válido');
  if (!String(nombre ?? '').trim()) return error(res, 400, 'Ingresa el nombre');
  if (!/^[a-zA-Z0-9._-]{3,40}$/.test(String(usuario ?? ''))) return error(res, 400, 'Usuario: 3 a 40 caracteres (letras, números, punto, guion)');
  if (buscarUsuario(usuario)) return error(res, 409, 'Ese nombre de usuario ya existe');
  const cid = rol === 'cliente' ? id(clienteId) : null;
  if (rol === 'cliente' && (!cid || !buscarCliente(cid))) return error(res, 400, 'Elige el cliente del usuario');
  const clave = claveTemporal();
  const u = crearUsuario({ usuario, nombre: String(nombre).trim(), clave, rol, clienteId: cid });
  res.status(201).json({ id: u.id, usuario: u.usuario, claveTemporal: clave });
});

r.patch('/usuarios/:id', (req, res) => {
  const u = usuarioPorId(id(req.params.id));
  if (!u) return error(res, 404, 'Usuario no encontrado');
  const { nombre, clienteId, activo } = req.body ?? {};
  if (activo === false) {
    if (u.id === req.usuario.id) return error(res, 400, 'No puedes desactivar tu propio usuario');
    if (u.rol === 'admin' && u.activo && adminsActivos() <= 1) return error(res, 400, 'Debe quedar al menos un administrador activo');
  }
  if (clienteId != null && (u.rol !== 'cliente' || !buscarCliente(id(clienteId)))) return error(res, 400, 'Cliente no válido');
  if (nombre != null && !String(nombre).trim()) return error(res, 400, 'Nombre inválido');
  actualizarUsuario(u.id, { nombre, clienteId: clienteId == null ? null : id(clienteId) });
  if (activo != null) activarUsuario(u.id, !!activo);
  res.json({ ok: true });
});

/** Nueva clave temporal (también desbloquea la cuenta y cierra sus sesiones). */
r.post('/usuarios/:id/restablecer', (req, res) => {
  const u = usuarioPorId(id(req.params.id));
  if (!u) return error(res, 404, 'Usuario no encontrado');
  if (u.id === req.usuario.id) return error(res, 400, 'Para tu propio usuario usa "Cambiar contraseña"');
  const clave = claveTemporal();
  fijarClave(u.id, clave, { temporal: true });
  res.json({ usuario: u.usuario, claveTemporal: clave });
});

export default r;
