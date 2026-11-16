// Une una sucursal duplicada en otra de la misma razón social (p. ej. un agente que se registró con otro
// nombre que el de la sucursal ya importada por red). Lo del origen reemplaza lo del destino en los meses
// que el origen tiene (es lo más reciente) y luego se borra la sucursal de origen.
// Uso: node scripts/unir-sucursales.js <idOrigen> <idDestino>
import { abrirDb, getDb, transaccion } from '../server/db.js';
import { cargarConfig } from '../server/config.js';

const [origen, destino] = process.argv.slice(2).map((x) => parseInt(x, 10));
if (!origen || !destino || origen === destino) { console.error('Uso: node scripts/unir-sucursales.js <idOrigen> <idDestino>'); process.exit(1); }
abrirDb(cargarConfig().rutaBaseDatos);
const d = getDb();
const so = d.prepare('SELECT * FROM sucursales WHERE id = ?').get(origen), sd = d.prepare('SELECT * FROM sucursales WHERE id = ?').get(destino);
if (!so || !sd || so.rut_empresa !== sd.rut_empresa) { console.error('Las sucursales deben existir y ser de la misma razón social'); process.exit(1); }
const agenteDestino = d.prepare('SELECT id FROM agentes WHERE sucursal_id = ? AND activo = 1').get(destino);
if (agenteDestino && d.prepare('SELECT 1 FROM agentes WHERE sucursal_id = ?').get(origen)) { console.error('Ambas sucursales tienen agente'); process.exit(1); }

transaccion(() => {
  // Ventas: por cada mes que trae el origen, se reemplaza el del destino
  const meses = d.prepare('SELECT DISTINCT periodo FROM docs_sisgen WHERE sucursal_id = ?').all(origen).map((r) => r.periodo);
  const borrar = d.prepare('DELETE FROM docs_sisgen WHERE sucursal_id = ? AND periodo = ?');
  for (const p of meses) borrar.run(destino, p);
  d.prepare('UPDATE docs_sisgen SET sucursal_id = ? WHERE sucursal_id = ?').run(destino, origen);
  // CAF: los del origen (leídos por el agente) reemplazan a los del destino
  if (d.prepare('SELECT 1 FROM caf_rangos WHERE sucursal_id = ?').get(origen)) {
    d.prepare('DELETE FROM caf_rangos WHERE sucursal_id = ?').run(destino);
    d.prepare('UPDATE caf_rangos SET sucursal_id = ? WHERE sucursal_id = ?').run(destino, origen);
  }
  const mesesVec = d.prepare('SELECT DISTINCT periodo FROM xml_otros_meses WHERE sucursal_id = ?').all(origen).map((r) => r.periodo);
  for (const p of mesesVec) d.prepare('DELETE FROM xml_otros_meses WHERE sucursal_id = ? AND periodo = ?').run(destino, p);
  d.prepare('UPDATE xml_otros_meses SET sucursal_id = ? WHERE sucursal_id = ?').run(destino, origen);
  for (const t of ['envios_sii', 'xml_documentos', 'respaldo_documentos', 'agentes']) {
    d.prepare(`UPDATE ${t} SET sucursal_id = ? WHERE sucursal_id = ?`).run(destino, origen);
  }
  d.prepare('DELETE FROM sucursales WHERE id = ?').run(origen);
});
console.log(`Sucursal "${so.nombre}" (${origen}) unida a "${sd.nombre}" (${destino}).`);
