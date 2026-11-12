import { useEffect, useState } from 'react';
import { api, pesos, numero, nombrePeriodo, haceCuanto, ESTADO_CLIENTE, formatoRut } from '../util.js';
import SelectorMes from './SelectorMes.jsx';

/** Pantalla propia de un cliente: sus razones sociales, sucursales, usuarios y estado del mes. */
export default function FichaCliente({ clienteId, abrir, volver, irAAdmin }) {
  const [periodo, setPeriodo] = useState('');
  const [datos, setDatos] = useState(null);
  const [error, setError] = useState(null);
  const [cargando, setCargando] = useState(true);
  const [llave, setLlave] = useState(null); // { sucursal, llave } se muestra una sola vez
  const [recargar, setRecargar] = useState(0);

  const generarLlave = async (s) => {
    const reemplaza = s.agente ? ' La llave anterior dejará de funcionar y habrá que actualizarla en el agente.' : '';
    if (!window.confirm(`¿Generar la llave del agente para ${s.nombre}?${reemplaza}`)) return;
    try {
      const r = await api(`/api/admin/sucursales/${s.id}/agente`, { metodo: 'POST' });
      setLlave(r);
      setRecargar((n) => n + 1);
    } catch (e) { setError(e.message); }
  };

  const llaveInstalacion = async () => {
    if (!window.confirm(`¿Generar una llave de instalación para ${datos.cliente.nombre}? Sirve para instalar el agente en un servidor nuevo: al conectarse, la razón social y la sucursal se crean solas.`)) return;
    try {
      setLlave(await api(`/api/admin/clientes/${clienteId}/llave-instalacion`, { metodo: 'POST' }));
    } catch (e) { setError(e.message); }
  };

  useEffect(() => {
    setCargando(true);
    api(`/api/admin/clientes/${clienteId}/ficha${periodo ? `?periodo=${periodo}` : ''}`)
      .then((d) => { setDatos(d); setError(null); })
      .catch((e) => setError(e.message))
      .finally(() => setCargando(false));
  }, [clienteId, periodo, recargar]);

  const r = datos?.resumen;
  return (
    <>
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
            <SelectorMes valor={periodo} periodos={datos.periodos} alCambiar={setPeriodo} permitirUltimo />
          </div>

          {llave && (
            <div className="alert alert-success" role="status">
              <div className="d-flex justify-content-between align-items-start gap-2">
                <div>
                  <strong>Llave del agente de {llave.sucursal}</strong>
                  <div className="small">Cópiala ahora en el archivo <code>agente.ini</code> del servicio. Por seguridad no se vuelve a mostrar.</div>
                </div>
                <button type="button" className="btn-close" aria-label="Cerrar" onClick={() => setLlave(null)} />
              </div>
              <div className="input-group input-group-sm mt-2">
                <input className="form-control font-monospace" readOnly value={llave.llave} aria-label="Llave del agente" onFocus={(e) => e.target.select()} />
                <button type="button" className="btn btn-outline-dark" onClick={() => navigator.clipboard?.writeText(llave.llave)}>Copiar</button>
              </div>
            </div>
          )}

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
              <div className="d-flex justify-content-between align-items-center mb-2">
                <h2 className="h6 text-uppercase text-secondary mb-0">Razones sociales y sucursales</h2>
                <button type="button" className="btn btn-sm btn-outline-secondary" onClick={llaveInstalacion}>
                  Instalar agente en un servidor nuevo
                </button>
              </div>
              {datos.razones.length === 0 && (
                <div className="alert alert-info">
                  Este cliente aún no tiene razones sociales. Instala el agente en su servidor con una
                  <strong> llave de instalación</strong> (botón de arriba) y aparecerán solas, o{' '}
                  <button type="button" className="btn btn-link p-0 align-baseline" onClick={() => irAAdmin('empresas')}>asigna una existente</button>.
                </div>
              )}
              {datos.razones.map((e) => <RazonSocial key={e.rut} e={e} abrir={abrir} generarLlave={generarLlave} />)}
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

function RazonSocial({ e, abrir, generarLlave }) {
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
            {e.sucursales.some((s) => s.agente?.activo) && <ConsultarSii rut={e.rut} periodo={e.periodo} />}
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
            <span className="d-flex align-items-center gap-2 flex-wrap justify-content-end">
              <span className={s.desactualizada ? 'text-warning-emphasis' : 'text-secondary'}>
                Leída {haceCuanto(s.ultimaLectura)}{s.ultimoPeriodo && ` · último mes ${nombrePeriodo(s.ultimoPeriodo).toLowerCase()}`}
              </span>
              <EstadoAgente agente={s.agente} />
              {s.agente?.historial && s.agente.historial !== 'pendiente' && (
                <span className="text-secondary" title="Carga de XML antiguos desde la carpeta de Sisgen">
                  {s.agente.historial === 'terminado' ? 'Historial completo' : `Historial: ${s.agente.historial}`}
                </span>
              )}
              <button type="button" className="btn btn-link btn-sm p-0" onClick={() => generarLlave(s)}>
                {s.agente ? 'Nueva llave' : 'Conectar agente'}
              </button>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Consulta al SII ahora, con el certificado del cliente a través de su agente. */
function ConsultarSii({ rut, periodo }) {
  const [estado, setEstado] = useState(null); // null | 'consultando' | texto final
  const consultar = async () => {
    if (!periodo) return;
    setEstado('consultando');
    try {
      await api(`/api/admin/empresas/${encodeURIComponent(rut)}/consultar-sii`, { metodo: 'POST', cuerpo: { periodo } });
      for (let i = 0; i < 120; i++) {
        await new Promise((ok) => setTimeout(ok, 3000));
        const r = await api(`/api/admin/empresas/${encodeURIComponent(rut)}/consultar-sii`);
        if (r.consulta?.fin) { setEstado(r.consulta.error ? `Error: ${r.consulta.error}` : 'SII consultado ✓'); return; }
      }
      setEstado('La consulta sigue en curso');
    } catch (e) { setEstado(e.message); }
  };
  if (estado && estado !== 'consultando') return <span className="small text-secondary" title={estado}>{estado.length > 40 ? `${estado.slice(0, 40)}…` : estado}</span>;
  return (
    <button type="button" className="btn btn-sm btn-outline-secondary" disabled={estado === 'consultando' || !periodo} onClick={consultar}
      title="Consulta el Registro de Ventas y las boletas en el SII con el certificado del cliente (a través de su agente)">
      {estado === 'consultando' ? 'Consultando SII…' : 'Consultar SII ahora'}
    </button>
  );
}

/** Estado del Agente Sisgen (servicio de Windows) de una sucursal. */
function EstadoAgente({ agente }) {
  if (!agente) return <span className="badge text-bg-light border">Sin agente</span>;
  if (!agente.activo) return <span className="badge text-bg-secondary">Agente desactivado</span>;
  if (!agente.ultimoContacto) return <span className="badge text-bg-warning">Agente sin conectar</span>;
  const min = (Date.now() - Date.parse(agente.ultimoContacto.replace(' ', 'T') + 'Z')) / 60000;
  const titulo = [agente.equipo, agente.version && `v${agente.version}`, agente.error].filter(Boolean).join(' · ');
  return min <= 5
    ? <span className="badge text-bg-success" title={titulo}>Agente en línea</span>
    : <span className="badge text-bg-danger" title={titulo}>Agente sin conexión {haceCuanto(agente.ultimoContacto)}</span>;
}
