// Firma y publica una versión nueva del Agente Sisgen para que se actualice sola en los clientes.
//
//   node scripts/publicar-agente.js --generar-llave     (una sola vez: crea la llave de firma de Sisgen)
//   node scripts/publicar-agente.js --solo 3            (publica agente/dist/SisgenAgente.exe solo para el agente 3)
//   node scripts/publicar-agente.js --solo 3,4
//   node scripts/publicar-agente.js --todos
//   node scripts/publicar-agente.js --estado            (qué versión está publicada y qué tiene cada agente)
//
// La llave privada queda en config/firma-agente.pem (no se versiona, no sale de este equipo).
// La llave pública se escribe en agente/src/LlavePublica.cs y va dentro del agente compilado.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CARPETA_ACTUALIZACIONES, versionPublicada } from '../server/actualizaciones.js';
import { abrirDb, getDb } from '../server/db.js';
import { cargarConfig } from '../server/config.js';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LLAVE = path.join(RAIZ, 'config', 'firma-agente.pem');
const PUBLICA_CS = path.join(RAIZ, 'agente', 'src', 'LlavePublica.cs');
const EXE = path.join(RAIZ, 'agente', 'dist', 'SisgenAgente.exe');
const PROGRAM_CS = path.join(RAIZ, 'agente', 'src', 'Program.cs');

const args = process.argv.slice(2);
const opcion = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const b64 = (b64url) => Buffer.from(b64url, 'base64url').toString('base64');

if (args.includes('--generar-llave')) {
  if (fs.existsSync(LLAVE)) { console.error('La llave ya existe: ' + LLAVE + ' (no se reemplaza: los agentes instalados confían en ella).'); process.exit(1); }
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 3072 });
  fs.writeFileSync(LLAVE, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  const jwk = publicKey.export({ format: 'jwk' });
  fs.writeFileSync(PUBLICA_CS,
    '// Llave pública de Sisgen para comprobar las actualizaciones del agente (generada por scripts/publicar-agente.js).\n' +
    'namespace SisgenAgente\n{\n    public static class LlavePublica\n    {\n' +
    `        public const string Xml = "<RSAKeyValue><Modulus>${b64(jwk.n)}</Modulus><Exponent>${b64(jwk.e)}</Exponent></RSAKeyValue>";\n` +
    '    }\n}\n');
  console.log('Llave creada. Privada: ' + LLAVE + ' · Pública: ' + PUBLICA_CS + '. Compila el agente (agente\\compilar.bat).');
  process.exit(0);
}

if (args.includes('--estado')) {
  abrirDb(cargarConfig().rutaBaseDatos);
  const m = versionPublicada();
  console.log('Publicada:', m ? `${m.version} para ${m.agentes === 'todos' ? 'todos' : 'agentes ' + m.agentes.join(', ')} (${m.publicado_en})` : 'ninguna');
  for (const a of getDb().prepare(`SELECT a.id, a.version, a.activo, a.ultimo_contacto, s.nombre FROM agentes a
                                   LEFT JOIN sucursales s ON s.id = a.sucursal_id ORDER BY a.id`).all())
    console.log(`  agente ${a.id}  ${a.nombre ?? '(sin sucursal)'}  v${a.version ?? '?'}  ${a.activo ? '' : '(desactivado)'}  último contacto ${a.ultimo_contacto ?? '—'}`);
  process.exit(0);
}

const solo = opcion('--solo');
if (!solo && !args.includes('--todos')) { console.error('Indica --solo <id agente> o --todos (ver --estado).'); process.exit(1); }
if (!fs.existsSync(LLAVE)) { console.error('Falta la llave de firma: node scripts/publicar-agente.js --generar-llave'); process.exit(1); }
if (!fs.existsSync(EXE)) { console.error('Falta ' + EXE + ': compila con agente\\compilar.bat'); process.exit(1); }
const version = /Version\s*=\s*"([\d.]+)"/.exec(fs.readFileSync(PROGRAM_CS, 'utf8'))?.[1];
if (!version) { console.error('No se encontró la versión en Program.cs'); process.exit(1); }
const fuentes = fs.readdirSync(path.join(RAIZ, 'agente', 'src')).map((f) => fs.statSync(path.join(RAIZ, 'agente', 'src', f)).mtimeMs);
if (Math.max(...fuentes) > fs.statSync(EXE).mtimeMs) { console.error('El agente compilado es más antiguo que el código: vuelve a compilar.'); process.exit(1); }

const exe = fs.readFileSync(EXE);
const sha256 = crypto.createHash('sha256').update(exe).digest('hex');
const firma = crypto.sign('sha256', Buffer.from(`SisgenAgente|${version}|${sha256}`), fs.readFileSync(LLAVE, 'utf8')).toString('base64');
const agentes = solo ? solo.split(',').map((x) => parseInt(x, 10)).filter(Number.isInteger) : 'todos';
fs.mkdirSync(CARPETA_ACTUALIZACIONES, { recursive: true });
const archivo = `SisgenAgente-${version}.exe`;
fs.writeFileSync(path.join(CARPETA_ACTUALIZACIONES, archivo), exe);
fs.writeFileSync(path.join(CARPETA_ACTUALIZACIONES, 'agente.json'),
  JSON.stringify({ version, archivo, sha256, firma, agentes, publicado_en: new Date().toISOString() }, null, 2));
console.log(`Publicada la versión ${version} para ${agentes === 'todos' ? 'todos los agentes' : 'agente(s) ' + agentes.join(', ')}. Se actualizarán en su próximo contacto (≈1 minuto).`);
