import { useEffect, useMemo, useState } from 'react';
import { api, pesos, numero, fecha, formatoRut } from '../util.js';
import { NOMBRES_TIPO } from './tiposDocumento.js';

const POR_PAGINA = 50;
const urlCompra = (rut, d, formato) =>
  `/api/compra/${encodeURIComponent(rut)}/${encodeURIComponent(d.rutEmisor)}/${d.tipoSii}/${d.folio}/${formato}`;

/** Compras del mes: documentos recibidos de proveedores (procesos\DTE\intercambio\Recibidos de Sisgen). */
export default function Compras({ rut, periodo, sucursal }) {
  const [datos, setDatos] = useState(null);
  const [error, setError] = useState(null);
  const [buscar, setBuscar] = useState('');
  const [pagina, setPagina] = useState(0);

  useEffect(() => {
    setDatos(null); setError(null); setPagina(0);
    api(`/api/compras/${encodeURIComponent(rut)}/${periodo}`).then(setDatos).catch((e) => setError(e.message));
  }, [rut, periodo]);

  const filtrados = useMemo(() => {
    const q = buscar.trim().toLowerCase().replace(/\./g, '');
    return (datos?.documentos ?? []).filter((d) => (!sucursal || d.sucursal === sucursal) && (!q
      || String(d.folio).includes(q) || (d.razonSocial ?? '').toLowerCase().includes(q) || d.rutEmisor.toLowerCase().includes(q)));
  }, [datos, buscar, sucursal]);

  if (error) return <div className="alert alert-danger">{error}</div>;
  if (!datos) return <div className="text-secondary">Cargando…</div>;
  if (!datos.documentos.length) {
    return (
      <div className="alert alert-secondary">
        No hay compras en este mes. Las compras salen de los documentos recibidos en Sisgen
        (carpeta DTE\intercambio\Recibidos); el agente de la sucursal los envía al portal.
      </div>
    );
  }
  const paginas = Math.max(1, Math.ceil(filtrados.length / POR_PAGINA));
  const vista = filtrados.slice(pagina * POR_PAGINA, (pagina + 1) * POR_PAGINA);

  return (
    <div className="card tarjeta">
      <div className="card-header d-flex flex-wrap gap-2 align-items-center">
        <span className="me-auto fw-semibold">{numero(filtrados.length)} documentos de compra</span>
        <input className="form-control form-control-sm" style={{ maxWidth: 260 }} placeholder="Proveedor, RUT o folio"
          value={buscar} onChange={(e) => { setBuscar(e.target.value); setPagina(0); }} aria-label="Buscar compra" />
      </div>
      <div className="table-responsive">
        <table className="table table-sm table-hover align-middle mb-0">
          <thead>
            <tr>
              <th>Fecha</th><th>Tipo</th><th className="text-end">Folio</th><th>Proveedor</th>
              <th className="text-end">Neto</th><th className="text-end">IVA</th><th className="text-end">Total</th><th aria-label="Archivos" />
            </tr>
          </thead>
          <tbody>
            {vista.map((d) => (
              <tr key={`${d.rutEmisor}-${d.tipoSii}-${d.folio}`}>
                <td className="small text-nowrap">{fecha(d.fecha)}</td>
                <td className="small">{NOMBRES_TIPO[d.tipoSii] ?? `Tipo ${d.tipoSii}`}</td>
                <td className="tabla-num">{numero(d.folio)}</td>
                <td className="small">
                  {d.razonSocial ?? '—'}
                  <div className="text-secondary">{formatoRut(d.rutEmisor)}</div>
                </td>
                <td className="tabla-num">{pesos(d.neto + d.exento)}</td>
                <td className="tabla-num">{pesos(d.iva)}</td>
                <td className="tabla-num fw-semibold">{pesos(d.total)}</td>
                <td className="text-nowrap">
                  <span className="d-inline-flex gap-1">
                    <a className="btn btn-sm py-0 px-2 btn-outline-primary" href={urlCompra(rut, d, 'pdf')} target="_blank" rel="noreferrer">PDF</a>
                    <a className="btn btn-sm py-0 px-2 btn-outline-primary" href={urlCompra(rut, d, 'xml')} download>XML</a>
                  </span>
                </td>
              </tr>
            ))}
            {!vista.length && <tr><td colSpan={8} className="text-center text-secondary py-4">Sin documentos para esta búsqueda</td></tr>}
          </tbody>
        </table>
      </div>
      {paginas > 1 && (
        <div className="card-footer bg-transparent d-flex justify-content-end small">
          <div className="btn-group btn-group-sm">
            <button className="btn btn-outline-secondary" disabled={pagina === 0} onClick={() => setPagina(pagina - 1)}>Anterior</button>
            <span className="btn btn-outline-secondary disabled">{pagina + 1} / {paginas}</span>
            <button className="btn btn-outline-secondary" disabled={pagina >= paginas - 1} onClick={() => setPagina(pagina + 1)}>Siguiente</button>
          </div>
        </div>
      )}
    </div>
  );
}
