import { useEffect, useMemo, useState } from 'react';
import { pesos, numero, fecha, ESTADO_INFO, descargarCsv } from '../util.js';

const POR_PAGINA = 50;

/** URL de descarga del XML o PDF; null si el documento no tiene archivos (sin XML o solo en el SII). */
export function urlArchivo(rut, d, formato) {
  if (!d.tipoSisgen || !d.sucursal || d.sinXml) return null;
  return `/api/documento/${encodeURIComponent(rut)}/${d.tipoSii}/${d.folio}/${formato}?sucursal=${encodeURIComponent(d.sucursal)}`;
}

function BotonesArchivo({ rut, d, chico }) {
  const pdf = urlArchivo(rut, d, 'pdf');
  const xml = urlArchivo(rut, d, 'xml');
  const cls = `btn ${chico ? 'btn-sm py-0 px-2' : 'btn-sm'} btn-outline-primary`;
  if (!pdf) {
    return <span className="small text-secondary" title="No hay XML generado para este documento">—</span>;
  }
  return (
    <span className="d-inline-flex gap-1" onClick={(e) => e.stopPropagation()}>
      <a className={cls} href={pdf} target="_blank" rel="noreferrer" title="Ver PDF">PDF</a>
      <a className={cls} href={xml} download title="Descargar XML">XML</a>
    </span>
  );
}
const folioAjeno = (d) => !!(d.sucursal && d.cafSucursal && d.cafSucursal !== d.sucursal);
const VACIO = { sucursal: '', tipo: '', estado: '', buscar: '' };

export default function Documentos({ datos, filtroInicial }) {
  const [f, setF] = useState(VACIO);
  const [pagina, setPagina] = useState(0);
  const [detalle, setDetalle] = useState(null);

  useEffect(() => {
    if (filtroInicial) {
      const { _t, ...resto } = filtroInicial;
      setF({ ...VACIO, ...resto });
    }
  }, [filtroInicial]);
  useEffect(() => setPagina(0), [f, datos]);

  const docs = datos.documentos;
  const sucursales = useMemo(() => [...new Set(docs.map((d) => d.sucursal).filter(Boolean))].sort(), [docs]);
  const tipos = useMemo(() => [...new Map(docs.map((d) => [d.tipoSii, d.tipoNombre])).entries()], [docs]);

  const filtrados = useMemo(() => {
    const q = f.buscar.trim().toLowerCase();
    return docs.filter((d) =>
      (!f.sucursal || d.sucursal === f.sucursal) &&
      (!f.tipo || String(d.tipoSii) === f.tipo) &&
      (!f.estado || (f.estado === 'EN_BLANCO' ? d.enBlanco : f.estado === 'SIN_XML' ? d.sinXml
        : f.estado === 'OTRA_SUCURSAL' ? folioAjeno(d) : d.estado === f.estado)) &&
      (!q || String(d.folio).includes(q) || (d.rutReceptor ?? '').toLowerCase().includes(q) || (d.nombreReceptor ?? '').toLowerCase().includes(q))
    );
  }, [docs, f]);

  const paginas = Math.max(1, Math.ceil(filtrados.length / POR_PAGINA));
  const vista = filtrados.slice(pagina * POR_PAGINA, (pagina + 1) * POR_PAGINA);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  const exportar = () =>
    descargarCsv(`cuadratura_${datos.rut}_${datos.periodo}.csv`, filtrados, [
      { titulo: 'Tipo', valor: (d) => d.tipoNombre },
      { titulo: 'Cod SII', valor: (d) => d.tipoSii },
      { titulo: 'Folio', valor: (d) => d.folio },
      { titulo: 'Fecha', valor: (d) => d.fecha },
      { titulo: 'Sucursal', valor: (d) => d.sucursal },
      { titulo: 'RUT receptor', valor: (d) => d.rutReceptor },
      { titulo: 'Receptor', valor: (d) => d.nombreReceptor },
      { titulo: 'Monto Sisgen', valor: (d) => d.montoSisgen },
      { titulo: 'Monto SII', valor: (d) => d.montoSii },
      { titulo: 'Estado', valor: (d) => ESTADO_INFO[d.estado].texto },
      { titulo: 'Documento en blanco', valor: (d) => (d.enBlanco ? 'Sí' : '') },
      { titulo: 'Folio corresponde a', valor: (d) => d.cafSucursal ?? '' },
      { titulo: 'Sin XML generado', valor: (d) => (d.sinXml ? 'Sí' : '') },
      { titulo: 'Motivo', valor: (d) => d.motivo },
    ]);

  return (
    <div className="card tarjeta">
      <div className="card-header">
        <div className="row g-2 align-items-center">
          <div className="col-12 col-md-3">
            <input className="form-control form-control-sm" placeholder="Buscar folio, RUT o cliente" value={f.buscar} onChange={set('buscar')} aria-label="Buscar" />
          </div>
          <div className="col-6 col-md-2">
            <select className="form-select form-select-sm" value={f.sucursal} onChange={set('sucursal')} aria-label="Sucursal">
              <option value="">Todas las sucursales</option>
              {sucursales.map((s) => <option key={s}>{s}</option>)}
            </select>
          </div>
          <div className="col-6 col-md-3">
            <select className="form-select form-select-sm" value={f.tipo} onChange={set('tipo')} aria-label="Tipo">
              <option value="">Todos los tipos</option>
              {tipos.map(([t, n]) => <option key={t} value={t}>{n}</option>)}
            </select>
          </div>
          <div className="col-6 col-md-2">
            <select className="form-select form-select-sm" value={f.estado} onChange={set('estado')} aria-label="Estado">
              <option value="">Todos los estados</option>
              {Object.entries(ESTADO_INFO).map(([k, v]) => <option key={k} value={k}>{v.texto}</option>)}
              <option value="EN_BLANCO">Documento en blanco</option>
              <option value="OTRA_SUCURSAL">Folio de otra sucursal</option>
              <option value="SIN_XML">Sin XML generado</option>
            </select>
          </div>
          <div className="col-6 col-md-2 d-flex gap-2 justify-content-end">
            <button className="btn btn-sm btn-outline-secondary" onClick={() => setF(VACIO)}>Limpiar</button>
            <button className="btn btn-sm btn-primary" onClick={exportar}>Exportar</button>
          </div>
        </div>
      </div>

      <div className="table-responsive">
        <table className="table table-hover table-sm mb-0 align-middle">
          <thead className="table-light">
            <tr>
              <th>Tipo</th><th className="tabla-num">Folio</th><th>Fecha</th><th>Sucursal</th>
              <th>Receptor</th><th className="tabla-num">Monto</th><th>Estado SII</th><th>Archivos</th>
            </tr>
          </thead>
          <tbody>
            {vista.map((d, i) => (
              <tr key={`${d.tipoSii}-${d.folio}-${d.sucursal}-${i}`} className="fila-click" onClick={() => setDetalle(d)}>
                <td className="small">{d.tipoNombre}</td>
                <td className="tabla-num">{numero(d.folio)}</td>
                <td className="small">{fecha(d.fecha)}</td>
                <td className="small">
                  {d.sucursal ?? <span className="text-secondary">—</span>}
                  {folioAjeno(d) && <div className="text-warning-emphasis">Folio de {d.cafSucursal}</div>}
                </td>
                <td className="small text-truncate" style={{ maxWidth: 220 }}>{d.nombreReceptor ?? d.rutReceptor ?? <span className="text-secondary">Consumidor final</span>}</td>
                <td className="tabla-num">{pesos(d.montoSisgen ?? d.montoSii)}</td>
                <td>
                  <span className={`badge text-bg-${ESTADO_INFO[d.estado].color}`}>{ESTADO_INFO[d.estado].texto}</span>
                  {d.enBlanco && <span className="badge text-bg-dark ms-1">En blanco</span>}
                  {d.sinXml && <span className="badge text-bg-danger ms-1">Sin XML</span>}
                </td>
                <td><BotonesArchivo rut={datos.rut} d={d} chico /></td>
              </tr>
            ))}
            {!vista.length && <tr><td colSpan={8} className="text-center text-secondary py-4">Sin documentos para este filtro</td></tr>}
          </tbody>
        </table>
      </div>

      <div className="card-footer bg-transparent d-flex justify-content-between align-items-center small">
        <span className="text-secondary">{numero(filtrados.length)} documentos</span>
        <div className="btn-group btn-group-sm">
          <button className="btn btn-outline-secondary" disabled={pagina === 0} onClick={() => setPagina(pagina - 1)}>Anterior</button>
          <span className="btn btn-outline-secondary disabled">{pagina + 1} / {paginas}</span>
          <button className="btn btn-outline-secondary" disabled={pagina >= paginas - 1} onClick={() => setPagina(pagina + 1)}>Siguiente</button>
        </div>
      </div>

      {detalle && <Detalle d={detalle} rut={datos.rut} cerrar={() => setDetalle(null)} />}
    </div>
  );
}

function Detalle({ d, rut, cerrar }) {
  const info = ESTADO_INFO[d.estado];
  const fila = (k, sisgen, sii) => (
    <tr><th className="fw-normal text-secondary">{k}</th><td>{sisgen ?? '—'}</td><td>{sii ?? '—'}</td></tr>
  );
  return (
    <>
      <div className="modal d-block" tabIndex={-1} role="dialog" onClick={cerrar}>
        <div className="modal-dialog modal-dialog-centered" onClick={(e) => e.stopPropagation()}>
          <div className="modal-content">
            <div className="modal-header">
              <h2 className="modal-title h5">{d.tipoNombre} N° {numero(d.folio)}</h2>
              <button className="btn-close" onClick={cerrar} aria-label="Cerrar" />
            </div>
            <div className="modal-body">
              <div className={`alert alert-${info.color === 'light' ? 'secondary' : info.color} py-2`}>
                <strong>{info.texto}</strong>{d.motivo && <> — {d.motivo}</>}
              </div>
              {folioAjeno(d) && (
                <div className="alert alert-warning py-2">
                  <strong>Folio de otra sucursal</strong> — emitido por {d.sucursal}, pero corresponde al CAF de{' '}
                  <strong>{d.cafSucursal}</strong> ({numero(d.cafDesde)} al {numero(d.cafHasta)}).
                </div>
              )}
              {d.sinXml && (
                <div className="alert alert-danger py-2">
                  <strong>Sin XML generado</strong> — está registrado en Sisgen pero no se generó su XML;
                  probablemente no se envió al SII.
                </div>
              )}
              {d.enBlanco && (
                <div className="alert alert-dark py-2">
                  <strong>Documento en blanco</strong> — no quedó registrado completo en Sisgen.
                </div>
              )}
              <table className="table table-sm mb-0">
                <thead><tr><th></th><th>Sisgen</th><th>SII</th></tr></thead>
                <tbody>
                  {fila('Sucursal', d.sucursal, null)}
                  {d.cafSucursal && fila('Rango CAF', `${d.cafSucursal} (${numero(d.cafDesde)} al ${numero(d.cafHasta)})`, null)}
                  {fila('Fecha', fecha(d.fecha), d.montoSii != null ? fecha(d.fecha) : null)}
                  {fila('Receptor', d.nombreReceptor ?? d.rutReceptor, d.montoSii != null ? d.rutReceptor : null)}
                  {fila('Monto', pesos(d.montoSisgen), d.montoSii != null ? pesos(d.montoSii) : null)}
                  {fila('Estado', d.tipoSisgen ? `Emitido (${d.tipoSisgen})` : 'No existe', d.estadoSii)}
                  {fila('Fuente', null, d.fuenteSii)}
                </tbody>
              </table>
            </div>
            <div className="modal-footer">
              {urlArchivo(rut, d, 'pdf') ? (
                <>
                  <a className="btn btn-primary" href={urlArchivo(rut, d, 'pdf')} target="_blank" rel="noreferrer">Ver PDF</a>
                  <a className="btn btn-outline-primary" href={urlArchivo(rut, d, 'xml')} download>Descargar XML</a>
                </>
              ) : (
                <span className="small text-secondary">Este documento no tiene XML generado: no hay PDF ni XML para descargar.</span>
              )}
            </div>
          </div>
        </div>
      </div>
      <div className="modal-backdrop show" />
    </>
  );
}
