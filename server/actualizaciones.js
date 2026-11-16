// Actualización en línea del Agente Sisgen.
// La versión publicada vive en data/actualizaciones/agente.json (la crea scripts/publicar-agente.js) junto a su .exe.
// Se ofrece solo a los agentes elegidos (prueba piloto) o a todos.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CARPETA_ACTUALIZACIONES = path.join(RAIZ, 'data', 'actualizaciones');
const MANIFIESTO = path.join(CARPETA_ACTUALIZACIONES, 'agente.json');

export function compararVersiones(a, b) {
  const pa = String(a ?? '').split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b ?? '').split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

export function versionPublicada(archivo = MANIFIESTO) {
  try { return JSON.parse(fs.readFileSync(archivo, 'utf8')); } catch { return null; }
}

/** La actualización que corresponde a este agente (o null): más nueva que la suya y el agente está habilitado para recibirla. */
export function actualizacionPara(agenteId, versionAgente, manifiesto = versionPublicada()) {
  if (!manifiesto?.version || !manifiesto.sha256 || !manifiesto.firma) return null;
  // Los agentes anteriores a 1.6.0 no saben actualizarse: no se les ofrece nada
  if (!versionAgente || compararVersiones(versionAgente, '1.6.0') < 0) return null;
  if (compararVersiones(manifiesto.version, versionAgente) <= 0) return null;
  const habilitado = manifiesto.agentes === 'todos' || (Array.isArray(manifiesto.agentes) && manifiesto.agentes.includes(agenteId));
  if (!habilitado) return null;
  return { version: manifiesto.version, sha256: manifiesto.sha256, firma: manifiesto.firma };
}

export function archivoActualizacion(manifiesto = versionPublicada()) {
  if (!manifiesto?.archivo) return null;
  const ruta = path.join(CARPETA_ACTUALIZACIONES, path.basename(manifiesto.archivo));
  return fs.existsSync(ruta) ? ruta : null;
}
