import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const DEFECTO = {
  puerto: 4100,
  baseDatos: 'data/cuadratura.db',
  sii: { ambiente: 'produccion' },
  empresas: [],
};

/** Carga config/config.local.json si existe; si no, usa valores por defecto (modo demo). */
export function cargarConfig() {
  const archivo = path.join(RAIZ, 'config', 'config.local.json');
  let local = {};
  if (fs.existsSync(archivo)) {
    local = JSON.parse(fs.readFileSync(archivo, 'utf8'));
  }
  const cfg = { ...DEFECTO, ...local, sii: { ...DEFECTO.sii, ...(local.sii || {}) } };
  cfg.rutaBaseDatos = path.resolve(RAIZ, cfg.baseDatos);
  cfg.tieneConfigLocal = fs.existsSync(archivo);
  return cfg;
}
