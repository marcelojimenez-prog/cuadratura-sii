import { useEffect, useState } from 'react';
import { api, nombrePeriodo, formatoRut } from '../util.js';
import SelectorMes from './SelectorMes.jsx';

/** Todas las razones sociales con algo por revisar en el mes, de lo más urgente a lo menos. */
export default function QueRevisar({ usuario, abrir, titulo = 'Qué revisar' }) {
  const [periodo, setPeriodo] = useState('');
  const [datos, setDatos] = useState(null);
  const [error, setError] = useState(null);
  const [cargando, setCargando] = useState(true);

  useEffect(() => {
    setCargando(true);
    api(`/api/inicio${periodo ? `?periodo=${periodo}` : ''}`)
      .then((d) => { setDatos(d); setError(null); })
      .catch((e) => setError(e.message))
      .finally(() => setCargando(false));
  }, [periodo]);

  const conAlgo = (datos?.empresas ?? [])
    .filter((e) => !e.sinDatos && (e.urgentes > 0 || e.alertas > 0 || !e.siiConsultadoEn))
    .sort((a, b) => b.urgentes - a.urgentes || b.alertas - a.alertas);
  const esAdmin = usuario.rol === 'admin';

  return (
    <>
      <div className="d-flex flex-wrap justify-content-between align-items-end gap-2 mb-3">
        <div>
          <h1 className="h4 mb-0">{titulo}</h1>
          <div className="text-secondary small">{periodo ? nombrePeriodo(periodo) : 'Último mes con datos de cada razón social'}</div>
        </div>
        <SelectorMes valor={periodo} periodos={datos?.periodos} alCambiar={setPeriodo} permitirUltimo />
      </div>
      {error && <div className="alert alert-danger">{error}</div>}
      {cargando && !datos && <div className="text-secondary">Cargando…</div>}
      {datos && conAlgo.length === 0 && (
        <div className="alert alert-success">Todo cuadra: no hay nada pendiente por revisar{periodo ? ` en ${nombrePeriodo(periodo).toLowerCase()}` : ''}.</div>
      )}
      {datos && conAlgo.length > 0 && (
        <div className="card tarjeta" style={{ opacity: cargando ? 0.6 : 1 }}>
          <ul className="list-group list-group-flush">
            {conAlgo.map((e) => (
              <li key={e.rut} className="list-group-item d-flex flex-wrap justify-content-between align-items-center gap-2 py-3">
                <div>
                  <div className="fw-semibold">{e.razonSocial}</div>
                  <div className="small text-secondary">
                    {esAdmin && e.cliente ? `${e.cliente} · ` : ''}RUT {formatoRut(e.rut)} · {nombrePeriodo(e.periodo)}
                  </div>
                </div>
                <div className="d-flex align-items-center gap-2">
                  {!e.siiConsultadoEn && !e.esDemo
                    ? <span className="badge text-bg-secondary">Aún sin consultar al SII</span>
                    : <>
                      {e.urgentes > 0 && <span className="badge text-bg-danger">{e.urgentes} urgente{e.urgentes > 1 ? 's' : ''}</span>}
                      {e.alertas - e.urgentes > 0 && <span className="badge text-bg-warning">{e.alertas - e.urgentes} por revisar</span>}
                    </>}
                  <button type="button" className="btn btn-sm btn-primary boton-marca" onClick={() => abrir(e.rut, e.periodo)}>Ver</button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}
