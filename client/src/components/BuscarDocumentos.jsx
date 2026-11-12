import { useEffect, useState } from 'react';
import { api, pesos, fecha, numero } from '../util.js';
import { NOMBRES_TIPO } from './tiposDocumento.js';

const VACIO = { tipo: '', folio: '', desde: '', hasta: '', texto: '' };

/** Búsqueda de documentos en todo el historial de la razón social, con descarga de XML y PDF. */
export default function BuscarDocumentos({ rut }) {
  const [filtros, setFiltros] = useState(VACIO);
  const [aplicados, setAplicados] = useState(VACIO);
  const [resultado, setResultado] = useState(null);
  const [pagina, setPagina] = useState(0);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    setCargando(true);
    const p = new URLSearchParams({ ...Object.fromEntries(Object.entries(aplicados).filter(([, v]) => v)), pagina });
    api(`/api/buscar/${encodeURIComponent(rut)}?${p}`)
      .then((d) => {
        setResultado((ant) => (pagina > 0 && ant ? { ...d, documentos: [...ant.documentos, ...d.documentos] } : d));
        setError(null);
      })
      .catch((e) => setError(e.message))
      .finally(() => setCargando(false));
  }, [rut, aplicados, pagina]);

  const cambiar = (k) => (e) => setFiltros({ ...filtros, [k]: e.target.value });
  const buscar = (e) => { e.preventDefault(); setPagina(0); setAplicados(filtros); };
  const limpiar = () => { setFiltros(VACIO); setPagina(0); setAplicados(VACIO); };
  const enlace = (d, formato) => `/api/documento/${encodeURIComponent(rut)}/${d.tipo_sii}/${d.folio}/${formato}`;

  return (
    <>
      <form className="card tarjeta mb-3" onSubmit={buscar}>
        <div className="card-body row g-2 align-items-end">
          <div className="col-6 col-md-3">
            <label className="form-label small mb-1" htmlFor="b-tipo">Tipo</label>
            <select id="b-tipo" className="form-select form-select-sm" value={filtros.tipo} onChange={cambiar('tipo')}>
              <option value="">Todos</option>
              {Object.entries(NOMBRES_TIPO).map(([t, n]) => <option key={t} value={t}>{n}</option>)}
            </select>
          </div>
          <div className="col-6 col-md-2">
            <label className="form-label small mb-1" htmlFor="b-folio">Folio</label>
            <input id="b-folio" className="form-control form-control-sm" inputMode="numeric" value={filtros.folio}
              onChange={(e) => setFiltros({ ...filtros, folio: e.target.value.replace(/\D/g, '') })} />
          </div>
          <div className="col-6 col-md-2">
            <label className="form-label small mb-1" htmlFor="b-desde">Desde</label>
            <input id="b-desde" type="date" min="2001-01-01" className="form-control form-control-sm" value={filtros.desde} onChange={cambiar('desde')} />
          </div>
          <div className="col-6 col-md-2">
            <label className="form-label small mb-1" htmlFor="b-hasta">Hasta</label>
            <input id="b-hasta" type="date" min="2001-01-01" className="form-control form-control-sm" value={filtros.hasta} onChange={cambiar('hasta')} />
          </div>
          <div className="col-12 col-md-3">
            <label className="form-label small mb-1" htmlFor="b-texto">Cliente (RUT o nombre)</label>
            <input id="b-texto" className="form-control form-control-sm" value={filtros.texto} onChange={cambiar('texto')} />
          </div>
          <div className="col-12 d-flex gap-2 justify-content-end">
            <button type="button" className="btn btn-sm btn-outline-secondary" onClick={limpiar}>Limpiar</button>
            <button type="submit" className="btn btn-sm btn-primary boton-marca">Buscar</button>
          </div>
        </div>
      </form>

      {resultado && (
        <div className="small text-secondary mb-2">
          {resultado.archivo.documentos > 0
            ? <>El portal tiene {numero(resultado.archivo.documentos)} XML archivados de esta razón social, desde el {fecha(resultado.archivo.desde)}.</>
            : <>Aún no hay XML archivados en el portal: se muestran los documentos importados de Sisgen.</>}
        </div>
      )}
      {error && <div className="alert alert-danger">{error}</div>}
      {cargando && !resultado && <div className="text-secondary">Buscando…</div>}

      {resultado && (
        <div className="card tarjeta" style={{ opacity: cargando ? 0.6 : 1 }}>
          <div className="table-responsive">
            <table className="table table-sm table-hover align-middle mb-0">
              <thead>
                <tr><th>Fecha</th><th>Documento</th><th className="text-end">Folio</th><th>Cliente</th><th className="text-end">Total</th><th>Sucursal</th><th className="text-end">Descargar</th></tr>
              </thead>
              <tbody>
                {resultado.documentos.map((d) => (
                  <tr key={`${d.tipo_sii}-${d.folio}`}>
                    <td className="text-nowrap">{fecha(d.fecha)}</td>
                    <td>{NOMBRES_TIPO[d.tipo_sii] ?? `Tipo ${d.tipo_sii}`}</td>
                    <td className="text-end tabla-num">{numero(d.folio)}</td>
                    <td>{d.nombre_receptor || '—'}{d.rut_receptor && d.rut_receptor !== '66666666-6' && <div className="small text-secondary">{d.rut_receptor}</div>}</td>
                    <td className="text-end tabla-num">{pesos(d.total)}</td>
                    <td className="small">{d.sucursal ?? '—'}</td>
                    <td className="text-end text-nowrap">
                      <a className="btn btn-sm btn-outline-secondary me-1" href={enlace(d, 'pdf')} target="_blank" rel="noopener">PDF</a>
                      <a className="btn btn-sm btn-outline-secondary" href={enlace(d, 'xml')}>XML</a>
                    </td>
                  </tr>
                ))}
                {resultado.documentos.length === 0 && (
                  <tr><td colSpan={7} className="text-center text-secondary py-4">No se encontraron documentos con esos filtros.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {resultado?.hayMas && (
        <div className="text-center mt-3">
          <button type="button" className="btn btn-sm btn-outline-secondary" disabled={cargando} onClick={() => setPagina(pagina + 1)}>Ver más</button>
        </div>
      )}
    </>
  );
}
