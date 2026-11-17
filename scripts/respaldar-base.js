// Respaldo diario de la base de datos (para programarlo en el servidor: cron o Programador de tareas).
// Copia consistente con el portal funcionando y conserva los últimos 14 días.
//
//   node scripts/respaldar-base.js        -> data/respaldos/cuadratura-AAAAMMDD.db
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { RAIZ, cargarConfig } from '../server/config.js';

const CONSERVAR = 14;
const cfg = cargarConfig();
const carpeta = path.join(RAIZ, 'data', 'respaldos');
fs.mkdirSync(carpeta, { recursive: true });
const destino = path.join(carpeta, `cuadratura-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.db`);
fs.rmSync(destino, { force: true });
const db = new DatabaseSync(cfg.rutaBaseDatos, { readOnly: true });
db.exec(`VACUUM INTO '${destino.replace(/'/g, "''")}'`);
db.close();
const viejos = fs.readdirSync(carpeta).filter((f) => /^cuadratura-\d{8}\.db$/.test(f)).sort().reverse().slice(CONSERVAR);
for (const f of viejos) fs.rmSync(path.join(carpeta, f));
console.log(`Respaldo: ${destino} (${(fs.statSync(destino).size / 1048576).toFixed(0)} MB)`);
