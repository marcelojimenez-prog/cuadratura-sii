import { useEffect, useRef, useState } from 'react';
import Resumen from './Resumen.jsx';
import Alertas from './Alertas.jsx';
import Documentos from './Documentos.jsx';
import Inicio from './Inicio.jsx';
import CambiarClave from './CambiarClave.jsx';
import Admin from './Admin.jsx';
import TablaClientes from './TablaClientes.jsx';
import FichaCliente from './FichaCliente.jsx';
import { api, nombrePeriodo } from '../util.js';
import { MARCA } from '../marca.js';

export default function Portal({ usuario, alSalir, alActualizarUsuario }) {
  const [empresas, setEmpresas] = useState(null);
  const [rut, setRut] = useState(''); // '' = pantalla de inicio
  const [periodo, setPeriodo] = useState('');
  const [datos, setDatos] = useState(null);
  const [vista, setVista] = useState('resumen');
  const [error, setError] = useState(null);
  const [cargando, setCargando] = useState(false);
  const [filtroInicial, setFiltroInicial] = useState(null);
  const [cambiandoClave, setCambiandoClave] = useState(false);
  const [enAdmin, setEnAdmin] = useState(false);
  const [pestanaAdmin, setPestanaAdmin] = useState('usuarios');
  const [clienteId, setClienteId] = useState(null); // ficha de cliente abierta (equipo Sisgen)
  const esAdmin = usuario.rol === 'admin';

  // Un cliente con una sola razón social entra directo a ella (sin pantalla de inicio)
  const unaSola = !esAdmin && empresas?.length === 1;

  const cargarEmpresas = () =>
    api('/api/empresas')
      .then((lista) => {
        setEmpresas(lista);
        if (!esAdmin && lista.length === 1) { setRut(lista[0].rut); setPeriodo(lista[0].periodos[0] || ''); }
      })
      .catch((e) => setError(e.message));
  useEffect(() => { cargarEmpresas(); }, []);

  const abrirAdmin = (pestana = 'usuarios') => { setCambiandoClave(false); setPestanaAdmin(pestana); setEnAdmin(true); };
  const salirAdmin = () => { setEnAdmin(false); setRut(''); setDatos(null); cargarEmpresas(); };
  const volverDeCuadratura = () => { setRut(''); setDatos(null); };

  useEffect(() => {
    if (!rut || !periodo) return;
    setCargando(true);
    setError(null);
    api(`/api/cuadratura/${encodeURIComponent(rut)}/${periodo}`)
      .then(setDatos)
      .catch((e) => setError(e.message))
      .finally(() => setCargando(false));
  }, [rut, periodo]);

  const empresa = empresas?.find((e) => e.rut === rut);
  const nAlertas = datos?.alertas.filter((a) => a.nivel !== 'baja').length ?? 0;

  const abrir = (nuevoRut, nuevoPeriodo) => {
    const emp = empresas.find((x) => x.rut === nuevoRut);
    setDatos(null);
    setVista('resumen');
    setRut(nuevoRut);
    setPeriodo(nuevoPeriodo && emp?.periodos.includes(nuevoPeriodo) ? nuevoPeriodo : emp?.periodos[0] || '');
  };
  const irAInicio = () => {
    if (enAdmin) { setClienteId(null); return salirAdmin(); }
    if (!unaSola) { setRut(''); setDatos(null); setClienteId(null); }
    setCambiandoClave(false);
  };
  const irADocumentos = (filtro) => { setFiltroInicial({ ...filtro, _t: Date.now() }); setVista('documentos'); };

  return (
    <>
      <nav className="navbar barra">
        <div className="container-xl gap-2 flex-wrap">
          <button type="button" className="navbar-brand marca-cabecera mb-0 btn btn-link p-0 text-decoration-none" onClick={irAInicio}
            aria-label={`${MARCA.portal} · ${MARCA.modulo} — ir al inicio`}>
            <img src={MARCA.logo} alt="" className="logo-cabecera" />
            <span className="separador-marca" aria-hidden="true" />
            <span className="texto-marca">{MARCA.portal}<small>{MARCA.modulo}</small></span>
          </button>
          <div className="d-flex gap-2 flex-wrap flex-grow-1 justify-content-end align-items-center">
            {rut && !cambiandoClave && !enAdmin && (
              <>
                {!unaSola && (
                  <select className="form-select form-select-sm w-auto" value={rut} aria-label="Razón social"
                    onChange={(e) => abrir(e.target.value)}>
                    {empresas.map((e) => <option key={e.rut} value={e.rut}>{e.razonSocial} · {e.rut}</option>)}
                  </select>
                )}
                <select className="form-select form-select-sm w-auto" value={periodo} aria-label="Periodo"
                  onChange={(e) => setPeriodo(e.target.value)}>
                  {empresa?.periodos.map((p) => <option key={p} value={p}>{nombrePeriodo(p)}</option>)}
                </select>
              </>
            )}
            {esAdmin && (
              <button type="button" className={`btn btn-sm ${enAdmin ? 'btn-primary boton-marca' : 'btn-outline-secondary'}`}
                aria-pressed={enAdmin} onClick={enAdmin ? salirAdmin : () => abrirAdmin()}>
                {enAdmin ? 'Volver al portal' : 'Administración'}
              </button>
            )}
            <MenuUsuario usuario={usuario} alCambiarClave={() => { setEnAdmin(false); setCambiandoClave(true); }} alSalir={alSalir} />
          </div>
        </div>
      </nav>

      {empresa?.esDemo && rut && !cambiandoClave && !enAdmin && (
        <div className="aviso-demo py-2">
          <div className="container-xl">
            <strong>Datos de ejemplo.</strong> Esta empresa es ficticia y sirve para ver el funcionamiento del portal.
          </div>
        </div>
      )}

      <main className="container-xl py-4">
        {cambiandoClave ? (
          <CambiarClave usuario={usuario} alCancelar={() => setCambiandoClave(false)}
            alCambiar={(u) => { alActualizarUsuario(u); setCambiandoClave(false); }} />
        ) : enAdmin ? (
          <Admin key={pestanaAdmin} usuarioActual={usuario} pestanaInicial={pestanaAdmin} />
        ) : !empresas ? (
          error ? <div className="alert alert-danger">{error}</div> : <div className="text-secondary">Cargando…</div>
        ) : empresas.length === 0 ? (
          <div className="alert alert-info">
            {esAdmin ? 'Aún no hay razones sociales cargadas en el portal.' : 'Tu usuario aún no tiene razones sociales asignadas. Contacta a Sisgen.'}
          </div>
        ) : !rut && esAdmin ? (
          clienteId
            ? <FichaCliente clienteId={clienteId} abrir={abrir} volver={() => setClienteId(null)} irAAdmin={abrirAdmin} />
            : <TablaClientes abrirCliente={setClienteId} irAAdmin={abrirAdmin} />
        ) : !rut ? (
          <Inicio usuario={usuario} abrir={abrir} />
        ) : (
          <>
            {!unaSola && (
              <button type="button" className="btn btn-link px-0 mb-2" onClick={clienteId ? volverDeCuadratura : irAInicio}>
                {clienteId ? '← Volver a la ficha del cliente' : esAdmin ? '← Volver a clientes' : '← Volver al inicio'}
              </button>
            )}
            {empresa && (
              <div className="mb-3">
                <h1 className="h4 mb-0">{empresa.razonSocial}</h1>
                <div className="text-secondary small">
                  RUT {empresa.rut} · {empresa.sucursales.length} {empresa.sucursales.length === 1 ? 'sucursal' : 'sucursales'}
                  {' · '}{periodo && nombrePeriodo(periodo)}
                </div>
              </div>
            )}

            <ul className="nav nav-tabs mb-3">
              {[
                ['resumen', 'Resumen'],
                ['alertas', <>Alertas {nAlertas > 0 && <span className="badge text-bg-danger ms-1">{nAlertas}</span>}</>],
                ['documentos', 'Documentos'],
              ].map(([id, txt]) => (
                <li className="nav-item" key={id}>
                  <button className={`nav-link ${vista === id ? 'active' : ''}`} onClick={() => setVista(id)}>{txt}</button>
                </li>
              ))}
            </ul>

            {error && <div className="alert alert-danger">{error}</div>}
            {cargando && !datos && <div className="text-secondary">Cargando…</div>}
            {datos && (
              <div style={{ opacity: cargando ? 0.5 : 1 }}>
                {vista === 'resumen' && <Resumen datos={datos} irAAlertas={() => setVista('alertas')} irADocumentos={irADocumentos} />}
                {vista === 'alertas' && <Alertas alertas={datos.alertas} irADocumentos={irADocumentos} />}
                {vista === 'documentos' && <Documentos datos={datos} filtroInicial={filtroInicial} />}
              </div>
            )}
          </>
        )}
      </main>
    </>
  );
}

function MenuUsuario({ usuario, alCambiarClave, alSalir }) {
  const [abierto, setAbierto] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!abierto) return;
    const cerrar = (e) => { if (!ref.current?.contains(e.target)) setAbierto(false); };
    const esc = (e) => { if (e.key === 'Escape') setAbierto(false); };
    document.addEventListener('mousedown', cerrar);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', cerrar); document.removeEventListener('keydown', esc); };
  }, [abierto]);
  const iniciales = usuario.nombre.split(/\s+/).slice(0, 2).map((p) => p[0]).join('').toUpperCase();
  return (
    <div className="position-relative" ref={ref}>
      <button type="button" className="btn btn-sm menu-usuario" aria-haspopup="menu" aria-expanded={abierto}
        onClick={() => setAbierto(!abierto)}>
        <span className="avatar" aria-hidden="true">{iniciales}</span>
        <span className="d-none d-sm-inline">{usuario.nombre}</span>
      </button>
      {abierto && (
        <div className="dropdown-menu dropdown-menu-end show menu-usuario-lista" role="menu">
          <div className="px-3 py-2 small text-secondary">
            <div className="fw-semibold text-body">{usuario.nombre}</div>
            {usuario.usuario}{usuario.rol === 'admin' ? ' · Administrador Sisgen' : usuario.cliente ? ` · ${usuario.cliente}` : ''}
          </div>
          <div className="dropdown-divider" />
          <button type="button" role="menuitem" className="dropdown-item" onClick={() => { setAbierto(false); alCambiarClave(); }}>
            Cambiar contraseña
          </button>
          <button type="button" role="menuitem" className="dropdown-item text-danger" onClick={alSalir}>Cerrar sesión</button>
        </div>
      )}
    </div>
  );
}
