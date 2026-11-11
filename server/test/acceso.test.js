import { test } from 'node:test';
import assert from 'node:assert/strict';
import { abrirDb, guardarEmpresa } from '../db.js';
import { hashClave, verificarClave, problemaClave, claveTemporal } from '../lib/auth/claves.js';
import {
  guardarCliente, asignarEmpresasACliente, crearUsuario, iniciarSesion, usuarioDeSesion, cerrarSesion,
  rutsPermitidos, puedeVer, cambiarClavePropia, fijarClave, activarUsuario, buscarUsuario, MAX_INTENTOS,
} from '../usuarios.js';

abrirDb(':memory:');
for (const [rut, rs] of [['11111111-1', 'A'], ['22222222-2', 'B'], ['33333333-3', 'C']]) guardarEmpresa({ rut, razonSocial: rs });
const grupo = guardarCliente('Grupo AB');
const otro = guardarCliente('Cliente C');
asignarEmpresasACliente(grupo.id, ['11111111-1', '22222222-2']);
asignarEmpresasACliente(otro.id, ['33333333-3']);
crearUsuario({ usuario: 'grupoab', nombre: 'Usuario AB', clave: 'Temporal123', rol: 'cliente', clienteId: grupo.id });
crearUsuario({ usuario: 'clientec', nombre: 'Usuario C', clave: 'Temporal123', rol: 'cliente', clienteId: otro.id });
crearUsuario({ usuario: 'jefe', nombre: 'Admin', clave: 'Temporal123', rol: 'admin' });

test('hash de contraseña: verifica la correcta y rechaza otras; nunca guarda el texto', () => {
  const h = hashClave('Secreta123');
  assert.ok(!h.includes('Secreta123'));
  assert.equal(verificarClave('Secreta123', h), true);
  assert.equal(verificarClave('secreta123', h), false);
  assert.notEqual(hashClave('Secreta123'), h); // sal distinta
});

test('reglas de contraseña y clave temporal', () => {
  assert.ok(problemaClave('corta1'));
  assert.ok(problemaClave('soloLetrasAqui'));
  assert.ok(problemaClave('juan12345', 'juan'));
  assert.equal(problemaClave('Buena2026x', 'juan'), null);
  for (let i = 0; i < 20; i++) assert.equal(problemaClave(claveTemporal()), null);
});

test('un cliente ve solo sus razones sociales; el administrador ve todas', () => {
  const ab = iniciarSesion('grupoab', 'Temporal123').usuario;
  assert.deepEqual([...rutsPermitidos(ab)].sort(), ['11111111-1', '22222222-2']);
  assert.equal(puedeVer(ab, '33333333-3'), false);
  const c = iniciarSesion('clientec', 'Temporal123').usuario;
  assert.equal(puedeVer(c, '11111111-1'), false);
  assert.equal(puedeVer(c, '33333333-3'), true);
  const jefe = iniciarSesion('jefe', 'Temporal123').usuario;
  assert.equal(rutsPermitidos(jefe), null);
  assert.equal(puedeVer(jefe, '33333333-3'), true);
});

test('sesión: token válido, cierre de sesión y usuario desactivado', () => {
  const r = iniciarSesion('GRUPOAB', 'Temporal123'); // usuario sin distinguir mayúsculas
  assert.equal(r.ok, true);
  assert.equal(usuarioDeSesion(r.token).usuario, 'grupoab');
  assert.equal(usuarioDeSesion('token-inventado'), null);
  cerrarSesion(r.token);
  assert.equal(usuarioDeSesion(r.token), null);

  const r2 = iniciarSesion('clientec', 'Temporal123');
  activarUsuario(buscarUsuario('clientec').id, false);
  assert.equal(usuarioDeSesion(r2.token), null);
  assert.equal(iniciarSesion('clientec', 'Temporal123').motivo, 'inactivo');
  activarUsuario(buscarUsuario('clientec').id, true);
});

test('usuario inexistente y clave incorrecta dan la misma respuesta', () => {
  assert.deepEqual(iniciarSesion('nadie', 'x'), { ok: false, motivo: 'credenciales' });
  assert.deepEqual(iniciarSesion('grupoab', 'mala'), { ok: false, motivo: 'credenciales' });
  iniciarSesion('grupoab', 'Temporal123'); // reinicia el contador
});

test(`bloqueo tras ${MAX_INTENTOS} intentos fallidos, aun con la clave correcta`, () => {
  for (let i = 0; i < MAX_INTENTOS - 1; i++) assert.equal(iniciarSesion('jefe', 'mala').motivo, 'credenciales');
  assert.equal(iniciarSesion('jefe', 'mala').motivo, 'bloqueado');
  assert.equal(iniciarSesion('jefe', 'Temporal123').motivo, 'bloqueado');
  fijarClave(buscarUsuario('jefe').id, 'Temporal123', { temporal: true }); // restablecer desbloquea
  assert.equal(iniciarSesion('jefe', 'Temporal123').ok, true);
});

test('cambio de clave: exige la actual, quita la marca de temporal y cierra otras sesiones', () => {
  const s1 = iniciarSesion('grupoab', 'Temporal123');
  const s2 = iniciarSesion('grupoab', 'Temporal123');
  assert.equal(s1.usuario.debeCambiarClave, true);
  const id = buscarUsuario('grupoab').id;
  assert.equal(cambiarClavePropia(id, 'incorrecta', 'NuevaClave9', s1.token), false);
  assert.equal(cambiarClavePropia(id, 'Temporal123', 'NuevaClave9', s1.token), true);
  assert.equal(usuarioDeSesion(s1.token).debeCambiarClave, false);
  assert.equal(usuarioDeSesion(s2.token), null);
  assert.equal(iniciarSesion('grupoab', 'NuevaClave9').ok, true);
});
