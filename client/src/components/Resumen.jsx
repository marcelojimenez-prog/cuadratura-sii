import { pesos, numero } from '../util.js';

const NOMBRE = {
  33: 'Factura Electrónica', 34: 'Factura No Afecta o Exenta Electrónica', 39: 'Boleta Electrónica',
  41: 'Boleta Exenta Electrónica', 52: 'Guía de Despacho Electrónica', 56: 'Nota de Débito Electrónica',
  61: 'Nota de Crédito Electrónica', 110: 'Factura de Exportación Electrónica',
};

/**
 * Resumen del mes al estilo del Registro de Compras y Ventas del SII: una fila por tipo de documento
 * con sus montos. Al hacer clic en un tipo se ve el detalle de sus documentos.
 */
export default function Resumen({ datos, irAAlertas, irADocumentos }) {
  // Montos por tipo según Sisgen (lo emitido), y cuántos de ellos están en el SII
  const porTipo = new Map();
  for (const d of datos.documentos) {
    if (d.montoSisgen == null) continue; // solo en el SII: no se emitió desde Sisgen
    const t = porTipo.get(d.tipoSii) ?? { tipo: d.tipoSii, docs: 0, exento: 0, neto: 0, iva: 0, total: 0, noEnSii: 0 };
    t.docs++;
    t.exento += d.exento ?? 0;
    t.neto += d.neto ?? 0;
    t.iva += d.iva ?? 0;
    t.total += d.montoSisgen ?? 0;
    if (['FALTA_EN_SII', 'RECHAZADO'].includes(d.estado)) t.noEnSii++;
    porTipo.set(d.tipoSii, t);
  }
  const filas = [...porTipo.values()].sort((a, b) => a.tipo - b.tipo);
  const noEnSii = filas.reduce((s, t) => s + t.noEnSii, 0);
  const alertas = datos.alertas.filter((a) => a.nivel !== 'baja').length;

  return (
    <>
      {datos.siiConsultadoEn && (noEnSii > 0 || alertas > 0) && (
        <div className="linea-aviso mb-2">
          {noEnSii > 0
            ? <>{numero(noEnSii)} {noEnSii === 1 ? 'documento no está' : 'documentos no están'} en el SII.</>
            : <>{numero(alertas)} {alertas === 1 ? 'alerta' : 'alertas'} por revisar.</>}
          {' '}<button type="button" className="btn btn-link p-0 align-baseline" onClick={irAAlertas}>Ver</button>
        </div>
      )}
      {!datos.siiConsultadoEn && <div className="linea-aviso gris mb-2">Este mes aún no se ha consultado al SII.</div>}

      <div className="table-responsive">
        <table className="table tabla-rcv mb-1">
          <thead>
            <tr>
              <th>Tipo Documento</th>
              <th className="text-end">Total Documentos</th>
              <th className="text-end">Monto Exento</th>
              <th className="text-end">Monto Neto</th>
              <th className="text-end">Monto IVA</th>
              <th className="text-end">Monto Total</th>
              <th className="text-end">No están en el SII</th>
            </tr>
          </thead>
          <tbody>
            {filas.map((t) => (
              <tr key={t.tipo}>
                <td>
                  <button type="button" className="btn btn-link p-0 text-start" onClick={() => irADocumentos({ tipo: String(t.tipo) })}>
                    {NOMBRE[t.tipo] ?? `Tipo ${t.tipo}`} ({t.tipo})
                  </button>
                </td>
                <td className="text-end tabla-num">{numero(t.docs)}</td>
                <td className="text-end tabla-num">{pesos(t.exento)}</td>
                <td className="text-end tabla-num">{pesos(t.neto)}</td>
                <td className="text-end tabla-num">{pesos(t.iva)}</td>
                <td className="text-end tabla-num">{pesos(t.total)}</td>
                <td className={`text-end tabla-num ${t.noEnSii ? 'text-danger fw-semibold' : 'text-secondary'}`}>
                  {t.noEnSii ? (
                    <button type="button" className="btn btn-link p-0 text-danger fw-semibold"
                      onClick={() => irADocumentos({ tipo: String(t.tipo), estado: 'RECHAZADO' })}>{numero(t.noEnSii)}</button>
                  ) : '0'}
                </td>
              </tr>
            ))}
            {filas.length === 0 && <tr><td colSpan={7} className="text-center text-secondary py-4">Sin documentos en este mes.</td></tr>}
          </tbody>
        </table>
      </div>
      {datos.siiConsultadoEn && <div className="small text-secondary">Consultado al SII el {datos.siiConsultadoEn.slice(0, 16).split(' ').map((p, i) => (i ? p : p.split('-').reverse().join('-'))).join(' a las ')}</div>}
    </>
  );
}
