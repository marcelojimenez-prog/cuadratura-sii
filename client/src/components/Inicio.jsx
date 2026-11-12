import { useEffect, useState } from 'react';
import { api, pesos, numero, nombrePeriodo } from '../util.js';
import SelectorMes from './SelectorMes.jsx';

/** Pantalla de inicio: todas las razones sociales del cliente (o de todos, para Sisgen). */
export default function Inicio({ usuario, abrir }) {
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

  const empresas = datos?.empresas ?? [];
  const conDatos = empresas.filter((e) => !e.sinDatos);
  const total = {
    monto: conDatos.reduce((s, e) => s + e.montoTotal, 0),
    documentos: conDatos.reduce((s, e) => s + e.documentos, 0),
    ok: conDatos.reduce((s, e) => s + e.ok, 0),
    urgentes: conDatos.reduce((s, e) => s + e.urgentes, 0),
  };
  const esAdmin = usuario.rol === 'admin';
  const grupos = esAdmin
    ? [...new Set(empresas.map((e) => e.cliente ?? 'Sin cliente asignado'))].map((c) => [c, empresas.filter((e) => (e.cliente ?? 'Sin cliente asignado') === c)])
    : [[null, empresas]];

  return (
    <>
      <div className="d-flex flex-wrap justify-content-between align-items-end gap-2 mb-3">
        <div>
          <h1 className="h4 mb-0">{esAdmin ? 'Todos los clientes' : usuario.cliente}</h1>
          <div className="text-secondary small">
            {empresas.length} {empresas.length === 1 ? 'razón social' : 'razones sociales'}
            {' · '}{periodo ? nombrePeriodo(periodo) : 'último mes con datos de cada una'}
          </div>
        </div>
        <SelectorMes valor={periodo} periodos={datos?.periodos} alCambiar={setPeriodo} permitirUltimo />
      </div>

      {error && <div className="alert alert-danger">{error}</div>}
      {cargando && !datos && <div className="text-secondary">Cargando…</div>}

      {datos && (
        <div style={{ opacity: cargando ? 0.5 : 1 }}>
          {conDatos.length > 1 && (
            <div className="row g-3 mb-4">
              <Kpi etiqueta="Total vendido" valor={pesos(total.monto)} sub="Todas las razones sociales" />
              <Kpi etiqueta="Documentos" valor={numero(total.documentos)} />
              <Kpi etiqueta="Cuadrados con SII" valor={total.documentos ? `${Math.floor((total.ok / total.documentos) * 1000) / 10}%` : '—'}
                sub={`${numero(total.ok)} de ${numero(total.documentos)}`} color={total.ok === total.documentos ? 'success' : undefined} />
              <Kpi etiqueta="Requieren acción" valor={numero(total.urgentes)} color={total.urgentes ? 'danger' : 'success'}
                sub={total.urgentes ? 'Alertas urgentes' : 'Sin alertas urgentes'} />
            </div>
          )}

          {grupos.map(([cliente, lista]) => (
            <section key={cliente ?? 'unico'} className="mb-4">
              {cliente && <h2 className="h6 text-uppercase text-secondary mb-2">{cliente}</h2>}
              <div className="row g-3">
                {lista.map((e) => <TarjetaEmpresa key={e.rut} e={e} abrir={abrir} />)}
              </div>
            </section>
          ))}
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

function TarjetaEmpresa({ e, abrir }) {
  const pct = e.documentos ? Math.floor((e.ok / e.documentos) * 1000) / 10 : 0;
  const estado = e.sinDatos ? { txt: 'Sin datos del periodo', color: 'secondary' }
    : !e.siiConsultadoEn && !e.esDemo ? { txt: 'Sin consultar al SII', color: 'secondary' }
    : e.urgentes ? { txt: `${e.urgentes} ${e.urgentes === 1 ? 'alerta urgente' : 'alertas urgentes'}`, color: 'danger' }
    : e.alertas ? { txt: `${e.alertas} por revisar`, color: 'warning' }
    : { txt: 'Todo cuadra', color: 'success' };
  return (
    <div className="col-12 col-md-6 col-xl-4">
      <button type="button" className={`card tarjeta tarjeta-empresa w-100 text-start h-100 borde-${estado.color}`}
        onClick={() => !e.sinDatos && abrir(e.rut, e.periodo)} disabled={e.sinDatos}>
        <div className="card-body">
          <div className="d-flex justify-content-between gap-2">
            <div className="fw-semibold">{e.razonSocial}</div>
            <span className={`badge text-bg-${estado.color} align-self-start text-nowrap`}>{estado.txt}</span>
          </div>
          <div className="text-secondary small mb-3">
            RUT {e.rut} · {e.sucursales} {e.sucursales === 1 ? 'sucursal' : 'sucursales'}{e.periodo && ` · ${nombrePeriodo(e.periodo)}`}
          </div>
          {!e.sinDatos && (
            <>
              <div className="d-flex justify-content-between align-items-end">
                <div>
                  <div className="etiqueta-chica">Total vendido</div>
                  <div className="fs-5 fw-semibold tabla-num text-start">{pesos(e.montoTotal)}</div>
                </div>
                <div className="text-end">
                  <div className="etiqueta-chica">Cuadrado con SII</div>
                  <div className="fs-5 fw-semibold">{e.siiConsultadoEn ? `${pct}%` : '—'}</div>
                </div>
              </div>
              <div className="progress barra-estado mt-2" role="progressbar" aria-label="Documentos cuadrados con el SII"
                aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
                <div className={`progress-bar bg-${pct === 100 ? 'success' : e.urgentes ? 'danger' : 'warning'}`} style={{ width: `${pct}%` }} />
              </div>
              <div className="small text-secondary mt-2">
                {numero(e.documentos)} documentos{e.conProblemas > 0 && <> · <span className="text-danger">{numero(e.conProblemas)} con problemas</span></>}
              </div>
            </>
          )}
        </div>
      </button>
    </div>
  );
}
