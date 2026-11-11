import { useEffect, useState } from 'react';
import { api, pesos, numero, nombrePeriodo, haceCuanto, ESTADO_CLIENTE, formatoRut } from '../util.js';

/** Pantalla propia de un cliente: sus razones sociales, sucursales, usuarios y estado del mes. */
export default function FichaCliente({ clienteId, abrir, volver, irAAdmin }) {
  const [periodo, setPeriodo] = useState('');
  const [datos, setDatos] = useState(null);
  const [error, setError] = useState(null);
  const [cargando, setCargando] = useState(true);

  useEffect(() => {
    setCargando(true);
    api(`/api/admin/clientes/${clienteId}/ficha${periodo ? `?periodo=${periodo}` : ''}`)
      .then((d) => { setDatos(d); setError(null); })
      .catch((e) => setError(e.message))
      .finally(() => setCargando(false));
  }, [clienteId, periodo]);

  const r = datos?.resumen;
  return (
    <>
      <button type="button" className="btn btn-link px-0 mb-2" onClick={volver}>← Volver a clientes</button>
      {error && <div className="alert alert-danger">{error}</div>}
      {cargando && !datos && <div className="text-secondary">Cargando…</div>}
      {datos && (
        <div style={{ opacity: cargando ? 0.5 : 1 }}>
          <div className="d-flex flex-wrap justify-content-between align-items-end gap-2 mb-3">
            <div>
              <h1 className="h4 mb-0">
                {datos.cliente.nombre}
                {!datos.cliente.activo && <span className="badge text-bg-secondary ms-2 align-middle fs-6">Inactivo</span>}
              </h1>
              <div className="text-secondary small">
                {r.razones} {r.razones === 1 ? 'razón social' : 'razones sociales'} · {r.sucursales} {r.sucursales === 1 ? 'sucursal' : 'sucursales'}
                {' · '}{periodo ? nombrePeriodo(periodo) : 'último mes con datos'}
                {' · '}cliente desde {datos.cliente.creadoEn?.slice(0, 10).split('-').reverse().join('-')}
              </div>
            </div>
            <select className="form-select form-select-sm w-auto" aria-label="Periodo" value={periodo} onChange={(e) => setPeriodo(e.target.value)}>
              <option value="">Último mes disponible</option>
              {datos.periodos.map((p) => <option key={p} value={p}>{nombrePeriodo(p)}</option>)}
            </select>
          </div>

          <div className="row g-3 mb-4">
            <Kpi etiqueta="Total vendido" valor={pesos(r.montoTotal)} />
            <Kpi etiqueta="Documentos" valor={numero(r.documentos)}
              sub={r.documentos ? `${Math.floor((r.ok / r.documentos) * 1000) / 10}% cuadrado con SII` : null} />
            <Kpi etiqueta="Alertas" valor={numero(r.alertas)} color={r.urgentes ? 'danger' : r.alertas ? 'warning' : 'success'}
              sub={r.urgentes ? `${r.urgentes} urgentes` : r.alertas ? 'Por revisar' : 'Sin alertas'} />
            <Kpi etiqueta="Sucursales al día" valor={`${r.sucursales - r.sucursalesDesactualizadas} de ${r.sucursales}`}
              color={r.sucursalesDesactualizadas ? 'warning' : 'success'}
              sub={r.sucursalesDesactualizadas ? 'Hay sucursales sin leer hace más de 2 días' : 'Todas leídas en los últimos 2 días'} />
          </div>

          <div className="row g-4">
            <div className="col-lg-8">
              <h2 className="h6 text-uppercase text-secondary mb-2">Razones sociales y sucursales</h2>
              {datos.razones.length === 0 && (
                <div className="alert alert-info">
                  Este cliente aún no tiene razones sociales.{' '}
                  <button type="button" className="btn btn-link p-0 align-baseline" onClick={() => irAAdmin('empresas')}>Asignar una</button>
                </div>
              )}
              {datos.razones.map((e) => <RazonSocial key={e.rut} e={e} abrir={abrir} />)}
            </div>
            <div className="col-lg-4">
              <h2 className="h6 text-uppercase text-secondary mb-2">Usuarios del cliente</h2>
              <div className="card tarjeta mb-3">
                <ul className="list-group list-group-flush">
                  {datos.usuarios.map((u) => (
                    <li key={u.id} className="list-group-item d-flex justify-content-between align-items-center gap-2">
                      <div>
                        <div className="fw-semibold">{u.usuario}</div>
                        <div className="small text-secondary">{u.nombre}</div>
                      </div>
                      <div className="text-end small">
                        {!u.activo ? <span className="badge text-bg-secondary">Desactivado</span>
                          : u.bloqueado ? <span className="badge text-bg-danger">Bloqueado</span>
                          : u.debeCambiarClave ? <span className="badge text-bg-warning">Clave temporal</span>
                          : <span className="text-secondary">{u.ultimoIngreso ? `entró ${u.ultimoIngreso.slice(0, 10).split('-').reverse().join('-')}` : 'nunca ha entrado'}</span>}
                      </div>
                    </li>
                  ))}
                  {datos.usuarios.length === 0 && <li className="list-group-item text-secondary small">Sin usuarios: el cliente aún no puede entrar al portal.</li>}
                </ul>
              </div>
              <button type="button" className="btn btn-sm btn-outline-secondary" onClick={() => irAAdmin('usuarios')}>
                Gestionar usuarios
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function Kpi({ etiqueta, valor, sub, color }) {
  return (
    <div className="col-6 col-lg-3">
      <div className="card kpi h-100"><div className="card-body">
        <div className="etiqueta">{etiqueta}</div>
        <div className={`valor ${color ? `text-${color}` : ''}`}>{valor}</div>
        {sub && <div className="small text-secondary">{sub}</div>}
      </div></div>
    </div>
  );
}

function RazonSocial({ e, abrir }) {
  const est = ESTADO_CLIENTE[e.estado];
  return (
    <div className="card tarjeta mb-3">
      <div className="card-body pb-2">
        <div className="d-flex flex-wrap justify-content-between align-items-start gap-2">
          <div>
            <div className="fw-semibold">{e.razonSocial}{e.esDemo && <span className="badge text-bg-info ms-2">Demo</span>}</div>
            <div className="small text-secondary">RUT {formatoRut(e.rut)}{e.periodo && ` · ${nombrePeriodo(e.periodo)}`}</div>
          </div>
          <div className="d-flex align-items-center gap-2">
            <span className={`badge text-bg-${est.color}`}>
              {e.estado === 'urgente' ? `${e.urgentes} ${e.urgentes === 1 ? 'alerta urgente' : 'alertas urgentes'}`
                : e.estado === 'revisar' ? `${e.alertas} por revisar` : est.texto}
            </span>
            <button type="button" className="btn btn-sm btn-primary boton-marca" disabled={e.sinDatos} onClick={() => abrir(e.rut, e.periodo)}>
              Ver cuadratura
            </button>
          </div>
        </div>
        {!e.sinDatos && (
          <div className="small text-secondary mt-1">
            {numero(e.documentos)} documentos · {pesos(e.montoTotal)}
            {e.conProblemas > 0 && <> · <span className="text-danger">{numero(e.conProblemas)} con problemas</span></>}
          </div>
        )}
      </div>
      <ul className="list-group list-group-flush">
        {e.sucursales.map((s) => (
          <li key={s.codigo} className="list-group-item d-flex justify-content-between align-items-center small py-2">
            <span>
              <span className={`punto-estado ${s.desactualizada ? 'punto-alerta' : 'punto-ok'}`} aria-hidden="true" />
              {s.nombre}
            </span>
            <span className={s.desactualizada ? 'text-warning-emphasis' : 'text-secondary'}>
              Leída {haceCuanto(s.ultimaLectura)}{s.ultimoPeriodo && ` · último mes ${nombrePeriodo(s.ultimoPeriodo).toLowerCase()}`}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
