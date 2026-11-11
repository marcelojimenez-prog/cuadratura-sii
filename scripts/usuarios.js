// Administración de clientes y usuarios del portal (equipo Sisgen).
// Las contraseñas temporales NO se muestran en pantalla: se agregan a data/credenciales-iniciales.txt
// (carpeta no versionada) para entregarlas al cliente; el usuario debe cambiarla en su primer ingreso.
//
//   npm run usuarios -- listar
//   npm run usuarios -- cliente "<Nombre cliente>" <rut> [<rut> ...]     crea el cliente y le asigna razones sociales
//   npm run usuarios -- admin <usuario> "<Nombre>"                       usuario del equipo Sisgen (ve todo)
//   npm run usuarios -- usuario <usuario> "<Nombre>" "<Nombre cliente>"  usuario de un cliente
//   npm run usuarios -- restablecer <usuario>                            nueva clave temporal
//   npm run usuarios -- desactivar <usuario> | activar <usuario>
import fs from 'node:fs';
import path from 'node:path';
import { cargarConfig, RAIZ } from '../server/config.js';
import { abrirDb } from '../server/db.js';
import {
  guardarCliente, buscarCliente, asignarEmpresasACliente, listarClientes, crearUsuario, buscarUsuario,
  listarUsuarios, fijarClave, activarUsuario,
} from '../server/usuarios.js';
import { claveTemporal } from '../server/lib/auth/claves.js';

abrirDb(cargarConfig().rutaBaseDatos);
const [cmd, ...args] = process.argv.slice(2);
const ARCHIVO_CLAVES = path.join(RAIZ, 'data', 'credenciales-iniciales.txt');

function guardarClaveTemporal(usuario, nombre, clave, detalle) {
  fs.mkdirSync(path.dirname(ARCHIVO_CLAVES), { recursive: true });
  fs.appendFileSync(ARCHIVO_CLAVES,
    `${new Date().toLocaleString('es-CL')}\t${detalle}\tusuario: ${usuario}\t(${nombre})\tclave temporal: ${clave}\n`);
  console.log(`  Clave temporal guardada en data\\credenciales-iniciales.txt (se pedirá cambiarla al ingresar).`);
}

const fallar = (m) => { console.error(m); process.exit(1); };

switch (cmd) {
  case 'listar': {
    for (const c of listarClientes()) {
      console.log(`\n[${c.id}] ${c.nombre}${c.activo ? '' : ' (inactivo)'}`);
      for (const e of c.empresas) console.log(`    ${e.rut}  ${e.razon_social}`);
      for (const u of c.usuarios) console.log(`    usuario ${u.usuario} (${u.nombre})${u.activo ? '' : ' [desactivado]'} último ingreso: ${u.ultimo_ingreso ?? '—'}`);
    }
    console.log('\nAdministradores:');
    for (const u of listarUsuarios().filter((x) => x.rol === 'admin')) console.log(`    ${u.usuario} (${u.nombre})${u.activo ? '' : ' [desactivado]'}`);
    break;
  }
  case 'cliente': {
    const [nombre, ...ruts] = args;
    if (!nombre || !ruts.length) fallar('Uso: cliente "<Nombre>" <rut> [<rut> ...]');
    const c = guardarCliente(nombre);
    for (const r of asignarEmpresasACliente(c.id, ruts)) console.log(`  ${r.ok ? '✓' : '✗ no existe'} ${r.rut}`);
    console.log(`Cliente [${c.id}] ${c.nombre}`);
    break;
  }
  case 'admin':
  case 'usuario': {
    const [usuario, nombre, cliente] = args;
    if (!usuario || !nombre || (cmd === 'usuario' && !cliente)) fallar(`Uso: ${cmd} <usuario> "<Nombre>"${cmd === 'usuario' ? ' "<Cliente>"' : ''}`);
    if (buscarUsuario(usuario)) fallar(`El usuario ${usuario} ya existe`);
    const c = cmd === 'usuario' ? buscarCliente(cliente) : null;
    if (cmd === 'usuario' && !c) fallar(`No existe el cliente "${cliente}"`);
    const clave = claveTemporal();
    crearUsuario({ usuario, nombre, clave, rol: cmd === 'admin' ? 'admin' : 'cliente', clienteId: c?.id });
    console.log(`✓ Usuario ${usuario} creado${c ? ` para ${c.nombre}` : ' (administrador Sisgen)'}`);
    guardarClaveTemporal(usuario, nombre, clave, c ? `cliente ${c.nombre}` : 'admin');
    break;
  }
  case 'restablecer': {
    const u = buscarUsuario(args[0] ?? '') ?? fallar('Usuario no encontrado');
    const clave = claveTemporal();
    fijarClave(u.id, clave, { temporal: true });
    console.log(`✓ Clave de ${u.usuario} restablecida`);
    guardarClaveTemporal(u.usuario, u.nombre, clave, 'restablecida');
    break;
  }
  case 'desactivar':
  case 'activar': {
    const u = buscarUsuario(args[0] ?? '') ?? fallar('Usuario no encontrado');
    activarUsuario(u.id, cmd === 'activar');
    console.log(`✓ ${u.usuario} ${cmd === 'activar' ? 'activado' : 'desactivado'}`);
    break;
  }
  default:
    console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).join('\n'));
}
