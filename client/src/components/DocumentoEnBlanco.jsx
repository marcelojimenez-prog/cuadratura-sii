import { useEffect, useState } from 'react';
import { api, pesos, numero, fecha, formatoRut } from '../util.js';

const NOMBRE = { BE: 'Boleta electrónica', BX: 'Boleta exenta electrónica', FE: 'Factura electrónica', FX: 'Factura exenta electrónica', NE: 'Nota de crédito electrónica', DE: 'Nota de débito electrónica', GE: 'Guía de despacho electrónica' };

/** URL de la página (se abre en una pestaña nueva). */
export const urlDocumentoEnBlanco = (rut, tipoSisgen, folio) =>
  `/documento-en-blanco?rut=${encodeURIComponent(rut)}&tipo=${encodeURIComponent(tipoSisgen)}&folio=${folio}`;

/** Lo que llevaba un documento en blanco, según la carpeta backup de Sisgen. */
export default function DocumentoEnBlanco() {
  const q = new URLSearchParams(window.location.search);
  const rut = q.get('rut'), tipo = q.get('tipo'), folio = q.get('folio');
  const [datos, setDatos] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    api(`/api/respaldo/${encodeURIComponent(rut)}/${encodeURIComponent(tipo)}/${encodeURIComponent(folio)}`)
      .then(setDatos).catch((e) => setError(e.message));
  }, [rut, tipo, folio]);

  const titulo = `${NOMBRE[tipo] ?? tipo} N° ${numero(Number(folio))}`;
  // La tabla DT no guarda precios de venta: solo código, producto y cantidad
  const conPrecios = datos?.fuente !== 'DT';
  useEffect(() => { document.title = `${tipo} ${folio} · Portal Sisgen`; }, [tipo, folio]);

  return (
    <div className="container py-4" style={{ maxWidth: 820 }}>
      <img src="/logo-sisgen.png" alt="Sisgen" style={{ height: 32 }} className="mb-3" />
      <h1 className="h4 mb-1">{titulo}</h1>
      {error && <div className="alert alert-warning mt-3">{error}</div>}
      {!datos && !error && <div className="text-secondary mt-3">Cargando…</div>}
      {datos && (
        <>
          <div className="text-secondary mb-3">
            {datos.razonSocial} · {formatoRut(datos.rut)}{datos.sucursal && <> · {datos.sucursal}</>}
          </div>
          <div className="alert alert-dark py-2">
            {datos.enBlanco || !datos.sinXml
              ? <><strong>Documento en blanco</strong> — no quedó registrado completo en Sisgen.</>
              : <><strong>No llegó al SII</strong> — está completo en Sisgen pero no se generó su XML: hay que republicarlo.</>}
            {' '}Esto es lo que llevaba según
            {datos.fuente === 'DT' ? ' la tabla DT (movimientos del mes) de Sisgen.' : ' la carpeta backup de Sisgen.'}
          </div>
          <div className="d-flex gap-4 mb-3">
            <div><div className="small text-secondary">Fecha</div><div className="fw-semibold">{fecha(datos.fecha)}</div></div>
            <div><div className="small text-secondary">Monto</div><div className="fw-semibold">{pesos(datos.total)}</div></div>
          </div>
          <table className="table table-sm align-middle">
            <thead>
              <tr><th>Código</th><th>Producto</th><th className="text-end">Cantidad</th>{conPrecios && <><th className="text-end">Precio</th><th className="text-end">Total</th></>}</tr>
            </thead>
            <tbody>
              {datos.lineas.map((l, i) => (
                <tr key={i}>
                  <td className="text-nowrap">{l.codigo ?? '—'}</td>
                  <td>{l.descripcion}</td>
                  <td className="text-end">{numero(l.cantidad)}</td>
                  {conPrecios && <><td className="text-end">{pesos(l.precio)}</td><td className="text-end">{pesos(l.total)}</td></>}
                </tr>
              ))}
            </tbody>
            {conPrecios && (
              <tfoot>
                <tr className="fw-semibold"><td colSpan={4} className="text-end">Total</td><td className="text-end">{pesos(datos.total)}</td></tr>
              </tfoot>
            )}
          </table>
        </>
      )}
    </div>
  );
}
