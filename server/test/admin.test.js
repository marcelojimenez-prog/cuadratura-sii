import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { abrirDb, guardarEmpresa } from '../db.js';
import { guardarCliente, asignarEmpresasACliente, crearUsuario, fijarClave, buscarUsuario } from '../usuarios.js';

abrirDb(':memory:');
const { default: apiRouter } = await import('../routes/api.js');

let servidor, base;
const CLAVE = 'ClavePrueba1';
before(async () => {
  guardarEmpresa({ rut: '11111111-1', razonSocial: 'Empresa A' });
  guardarEmpresa({ rut: '22222222-2', razonSocial: 'Empresa B' });
  const c = guardarCliente('Cliente A');
  asignarEmpresasACliente(c.id, ['11111111-1']);
  for (const [usuario, rol, clienteId] of [['jefe', 'admin', null], ['clientea', 'cliente', c.id]]) {
    const u = crearUsuario({ usuario, nombre: usuario, clave: CLAVE, rol, clienteId });
    fijarClave(u.id, CLAVE, { temporal: false });
  }
  const app = express();
  app.use(express.json());
  app.use('/api', apiRouter);
  await new Promise((ok) => { servidor = app.listen(0, ok); });
  base = `http://127.0.0.1:${servidor.address().port}`;
});
after(() => servidor.close());

async function sesion(usuario, clave = CLAVE) {
  const r = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ usuario, clave }) });
  const cookie = r.headers.get('set-cookie')?.split(';')[0];
  return async (ruta, metodo = 'GET', cuerpo) => {
    const x = await fetch(base + ruta, { method: metodo, headers: { 'Content-Type': 'application/json', cookie }, body: cuerpo ? JSON.stringify(cuerpo) : undefined });
    return { status: x.status, json: await x.json().catch(() => null) };
  };
}

test('un usuario de cliente no puede usar el panel de administración', async () => {
  const pedir = await sesion('clientea');
  assert.equal((await pedir('/api/admin/datos')).status, 403);
  assert.equal((await pedir('/api/admin/usuarios', 'POST', { usuario: 'otro', nombre: 'x', rol: 'admin' })).status, 403);
});

test('el administrador ve clientes, razones sociales y usuarios', async () => {
  const pedir = await sesion('jefe');
  const d = (await pedir('/api/admin/datos')).json;
  assert.equal(d.clientes.length, 1);
  assert.equal(d.empresas.length, 2);
  assert.equal(d.usuarios.length, 2);
});

test('crear usuario devuelve una clave temporal que sirve para ingresar', async () => {
  const pedir = await sesion('jefe');
  const cliente = (await pedir('/api/admin/datos')).json.clientes[0];
  const r = await pedir('/api/admin/usuarios', 'POST', { usuario: 'nuevo.usuario', nombre: 'Nuevo', rol: 'cliente', clienteId: cliente.id });
  assert.equal(r.status, 201);
  assert.ok(r.json.claveTemporal.length >= 10);
  assert.equal((await pedir('/api/admin/usuarios', 'POST', { usuario: 'nuevo.usuario', nombre: 'Otra vez', rol: 'cliente', clienteId: cliente.id })).status, 409);
  const nuevo = await sesion('nuevo.usuario', r.json.claveTemporal);
  assert.equal((await nuevo('/api/empresas')).status, 403); // debe cambiar la clave temporal primero
});

test('asignar una razón social al cliente la hace visible para sus usuarios', async () => {
  const admin = await sesion('jefe');
  const cliente = await sesion('clientea');
  assert.deepEqual((await cliente('/api/empresas')).json.map((e) => e.rut), ['11111111-1']);
  const cid = (await admin('/api/admin/datos')).json.clientes[0].id;
  assert.equal((await admin('/api/admin/empresas/22222222-2/cliente', 'PUT', { clienteId: cid })).status, 200);
  assert.deepEqual((await cliente('/api/empresas')).json.map((e) => e.rut).sort(), ['11111111-1', '22222222-2']);
  await admin('/api/admin/empresas/22222222-2/cliente', 'PUT', { clienteId: null });
  assert.deepEqual((await cliente('/api/empresas')).json.map((e) => e.rut), ['11111111-1']);
});

test('desactivar un cliente: sus usuarios pierden la sesión', async () => {
  const admin = await sesion('jefe');
  const cliente = await sesion('clientea');
  const cid = (await admin('/api/admin/datos')).json.clientes[0].id;
  await admin(`/api/admin/clientes/${cid}`, 'PATCH', { activo: false });
  assert.equal((await cliente('/api/empresas')).status, 401);
  const otra = await sesion('clientea');
  assert.deepEqual((await otra('/api/empresas')).json, []); // cliente inactivo: no ve datos
  await admin(`/api/admin/clientes/${cid}`, 'PATCH', { activo: true });
});

test('tabla de clientes y ficha: solo para el equipo Sisgen', async () => {
  const admin = await sesion('jefe');
  const t = (await admin('/api/admin/tabla')).json;
  assert.equal(t.clientes.length, 1);
  assert.deepEqual(t.clientes[0].ruts, ['11111111-1']);
  assert.equal(t.clientes[0].estado, 'sinDatos');
  assert.deepEqual(t.sinCliente.map((e) => e.rut), ['22222222-2']);
  const f = await admin(`/api/admin/clientes/${t.clientes[0].id}/ficha`);
  assert.equal(f.status, 200);
  assert.equal(f.json.razones[0].rut, '11111111-1');
  assert.ok(f.json.usuarios.some((u) => u.usuario === 'clientea'));
  assert.equal((await admin('/api/admin/clientes/999/ficha')).status, 404);
  const cliente = await sesion('clientea');
  assert.equal((await cliente('/api/admin/tabla')).status, 403);
  assert.equal((await cliente(`/api/admin/clientes/${t.clientes[0].id}/ficha`)).status, 403);
});

test('protecciones: no desactivarse a sí mismo ni dejar el portal sin administradores', async () => {
  const admin = await sesion('jefe');
  const yo = buscarUsuario('jefe');
  assert.equal((await admin(`/api/admin/usuarios/${yo.id}`, 'PATCH', { activo: false })).status, 400);
  assert.equal((await admin(`/api/admin/usuarios/${yo.id}/restablecer`, 'POST')).status, 400);
});

test('restablecer clave entrega una nueva clave temporal y cierra la sesión del usuario', async () => {
  const admin = await sesion('jefe');
  const cliente = await sesion('clientea');
  const r = await admin(`/api/admin/usuarios/${buscarUsuario('clientea').id}/restablecer`, 'POST');
  assert.equal(r.status, 200);
  assert.equal((await cliente('/api/empresas')).status, 401);
  assert.equal((await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ usuario: 'clientea', clave: CLAVE }) })).status, 401);
});
