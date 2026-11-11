// Agrega una sucursal Sisgen a partir de su ruta de red, la importa y la sincroniza con el SII.
// Uso: npm run agregar -- "\\host\sisgen" [YYYY-MM]
//  - Lee RUT y razón social desde datos\empres.dbf (solo lectura).
//  - Si el RUT ya existe en la configuración se agrega como sucursal; si no, crea la razón social.
//  - Certificado: busca *.pfx en procesos\certificado y prueba las claves ya configuradas
//    (nunca las muestra). Si ninguna sirve, queda sin certificado y se avisa.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { RAIZ } from '../server/config.js';
import { leerEmpresa } from '../server/lib/sisgen/importar.js';
import { cargarCertificado } from '../server/lib/sii/certificado.js';

const [raizArg, periodo = periodoAnterior()] = process.argv.slice(2);
if (!raizArg || !/^\d{4}-\d{2}$/.test(periodo)) {
  console.error('Uso: npm run agregar -- "\\\\host\\sisgen" [YYYY-MM]');
  process.exit(1);
}
const raiz = raizArg.replace(/[\\/]+$/, '');

function periodoAnterior() {
  const d = new Date();
  d.setDate(1); d.setMonth(d.getMonth() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

const nombreBonito = (s) => s.toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase());
const codigoDe = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '');

// 1) Datos de la sucursal
const carpetas = fs.readdirSync(raiz, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
const datos = carpetas.find((c) => c.toLowerCase() === 'datos');
const procesos = carpetas.find((c) => c.toLowerCase() === 'procesos');
if (!datos) { console.error(`No existe carpeta datos en ${raiz}`); process.exit(1); }
const rutaDatos = path.join(raiz, datos);
const rutaProcesos = procesos ? path.join(raiz, procesos) : null;
const emp = leerEmpresa(rutaDatos);
const nombreSisgen = (emp.nombreSistema || emp.razonSocial || 'Sucursal').trim();
console.log(`Sucursal ${nombreSisgen} · ${emp.razonSocial} (${emp.rut})`);

// 2) Configuración
const archivoCfg = path.join(RAIZ, 'config', 'config.local.json');
const cfg = JSON.parse(fs.readFileSync(archivoCfg, 'utf8').replace(/^\uFEFF/, ''));
cfg.empresas ??= [];
const mismaRuta = (s) => s.rutaDatos.toLowerCase() === rutaDatos.toLowerCase();
const yaEsta = cfg.empresas.find((e) => e.sucursales.some(mismaRuta));
if (yaEsta && yaEsta.rut !== emp.rut) {
  console.error(`Esta ruta ya está configurada en ${yaEsta.razonSocial} (${yaEsta.rut}), pero empres.dbf indica ${emp.rut}. Revisar a mano.`);
  process.exit(1);
}
let empresa = cfg.empresas.find((e) => e.rut === emp.rut);
if (!empresa) {
  empresa = { rut: emp.rut, razonSocial: emp.razonSocial, pdf: { mostrarLogo: false }, certificado: { rutaPfx: '', clave: '' }, sucursales: [] };
  cfg.empresas.push(empresa);
  console.log('  + Razón social nueva');
}
let codigo = codigoDe(nombreSisgen);
if (!empresa.sucursales.some(mismaRuta)) {
  while (empresa.sucursales.some((s) => s.codigo === codigo)) codigo += '_2';
  empresa.sucursales.push({ codigo, nombre: nombreBonito(nombreSisgen), rutaDatos, rutaProcesos });
  console.log(`  + Sucursal ${codigo} (${empresa.sucursales.length} en total)`);
} else {
  codigo = empresa.sucursales.find(mismaRuta).codigo;
  console.log(`  = La sucursal ya estaba configurada (${codigo})`);
}

// 3) Certificado: solo si la razón social aún no tiene uno que funcione
const certificadoOk = (c) => { try { return c?.rutaPfx && cargarCertificado(c) && true; } catch { return false; } };
if (!certificadoOk(empresa.certificado) && rutaProcesos) {
  const dirCert = path.join(rutaProcesos, 'certificado');
  const pfxs = fs.existsSync(dirCert) ? fs.readdirSync(dirCert).filter((f) => /\.(pfx|p12)$/i.test(f)) : [];
  // Solo se reutiliza una clave para el MISMO certificado ya configurado (mismo nombre de archivo).
  // Nunca se prueban claves en otros archivos: la clave de un certificado nuevo la entrega el usuario.
  const conocidos = cfg.empresas.map((e) => e.certificado).filter((c) => c?.rutaPfx && c.clave);
  let encontrado = null;
  for (const f of pfxs) {
    const igual = conocidos.find((c) => path.basename(c.rutaPfx).toLowerCase() === f.toLowerCase());
    if (igual) { encontrado = { rutaPfx: path.join(dirCert, f), clave: igual.clave }; break; }
  }
  if (encontrado && certificadoOk(encontrado)) {
    empresa.certificado = encontrado;
    console.log(`  + Certificado ${path.basename(encontrado.rutaPfx)} (mismo certificado ya configurado en otra razón social)`);
  } else {
    console.log(`  ! Sin certificado configurado. Archivos en procesos\\certificado: ${pfxs.join(', ') || '(ninguno)'}. ` +
      'Indicar cuál usar y su clave.');
  }
}
fs.writeFileSync(archivoCfg, JSON.stringify(cfg, null, 2));

// 4) ¿Tiene ventas del periodo? Si no, se informa el último mes con ventas
const [anio, mes] = periodo.split('-');
const tablasF1 = fs.readdirSync(rutaDatos).map((f) => /^F1(\d{2})(\d{4})\.dbf$/i.exec(f)).filter(Boolean)
  .map((m) => ({ periodo: `${m[2]}-${m[1]}`, tam: fs.statSync(path.join(rutaDatos, m[0])).size }));
if (!tablasF1.some((t) => t.periodo === `${anio}-${mes}`)) {
  const ultimo = tablasF1.filter((t) => t.tam > 50000).map((t) => t.periodo).sort().pop();
  console.log(`  ! No hay ventas de ${periodo} en esta sucursal. Último mes con ventas: ${ultimo ?? 'ninguno'}.`);
}

// 5) Importar y sincronizar
const correr = (script, args) => spawnSync(process.execPath, ['--no-warnings', path.join(RAIZ, 'scripts', script), ...args], { stdio: 'inherit', cwd: RAIZ });
correr('importar-sisgen.js', [periodo, emp.rut, codigo]);
if (certificadoOk(empresa.certificado)) correr('sincronizar-sii.js', [periodo, emp.rut]);
