// Arma el paquete de DATOS para instalar el portal en un servidor (VPS). El código va por GitHub;
// esto lleva lo que NO se versiona:
//   - copia consistente de la base de datos (se puede hacer con el portal funcionando),
//   - XML guardados (ventas y compras) y actualizaciones publicadas del agente,
//   - config/config.local.json SIN certificados ni claves ni rutas de red (en el servidor las
//     consultas al SII las hacen los agentes con el certificado de cada cliente).
// No incluye: la llave de firma del agente (config/firma-agente.pem), certificados .pfx,
// data/credenciales-iniciales.txt ni respaldos antiguos.
//
//   node scripts/empaquetar-vps.js            -> paquete-vps/portal-datos-AAAAMMDD-HHMM.tar.gz
//
// En el servidor: detener el portal, descomprimir en la carpeta del proyecto (tar -xzf …) y arrancar.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { RAIZ, cargarConfig } from '../server/config.js';

const cfg = cargarConfig();
const salida = path.join(RAIZ, 'paquete-vps');
const temporal = path.join(salida, 'tmp');
fs.rmSync(temporal, { recursive: true, force: true });
fs.mkdirSync(path.join(temporal, 'data'), { recursive: true });
fs.mkdirSync(path.join(temporal, 'config'), { recursive: true });

// 1) Base de datos: VACUUM INTO deja una copia consistente aunque el portal esté escribiendo
const destinoDb = path.join(temporal, 'data', 'cuadratura.db');
console.log('Copiando la base de datos (puede tardar unos minutos)…');
const db = new DatabaseSync(cfg.rutaBaseDatos, { readOnly: true });
db.exec(`VACUUM INTO '${destinoDb.replace(/'/g, "''")}'`);
db.close();
console.log(`  ${(fs.statSync(destinoDb).size / 1048576).toFixed(0)} MB`);

// 2) Configuración para el servidor: sin certificados, claves ni rutas de red de las sucursales
const local = cfg.tieneConfigLocal ? JSON.parse(fs.readFileSync(path.join(RAIZ, 'config', 'config.local.json'), 'utf8')) : {};
const servidor = {
  puerto: local.puerto ?? 4100,
  baseDatos: 'data/cuadratura.db',
  sii: { ambiente: local.sii?.ambiente ?? 'produccion' },
  empresas: (local.empresas ?? []).map((e) => ({ rut: e.rut, razonSocial: e.razonSocial, ...(e.pdf ? { pdf: e.pdf } : {}) })),
};
fs.writeFileSync(path.join(temporal, 'config', 'config.local.json'), JSON.stringify(servidor, null, 2));

// 3) Un solo archivo .tar.gz: lo preparado + carpetas de datos tomadas directo de data/
const carpetas = ['xml', 'actualizaciones', 'agentes'].filter((c) => fs.existsSync(path.join(RAIZ, 'data', c)));
const sello = new Date().toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
const archivo = path.join(salida, `portal-datos-${sello}.tar.gz`);
console.log(`Comprimiendo ${['base de datos', 'configuración', ...carpetas.map((c) => 'data/' + c)].join(', ')}…`);
// En Windows se usa el tar del sistema (el de Git Bash interpreta "C:" como un equipo remoto)
const tarWin = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
const tar = process.platform === 'win32' && fs.existsSync(tarWin) ? tarWin : 'tar';
execFileSync(tar, ['-czf', archivo, '-C', temporal, 'data/cuadratura.db', 'config/config.local.json',
  ...(carpetas.length ? ['-C', RAIZ, ...carpetas.map((c) => `data/${c}`)] : [])], { stdio: 'inherit' });
fs.rmSync(temporal, { recursive: true, force: true });
console.log(`Listo: ${archivo} (${(fs.statSync(archivo).size / 1048576).toFixed(0)} MB)`);
console.log('Entrégalo por un medio privado (no por correo ni en GitHub): contiene datos de clientes.');
