import { useEffect, useState } from 'react';
import Resumen from './Resumen.jsx';
import Alertas from './Alertas.jsx';
import Documentos from './Documentos.jsx';
import CambiarClave from './CambiarClave.jsx';
import Admin from './Admin.jsx';
import TablaClientes from './TablaClientes.jsx';
import FichaCliente from './FichaCliente.jsx';
import BuscarDocumentos from './BuscarDocumentos.jsx';
import Compras from './Compras.jsx';
import QueRevisar from './QueRevisar.jsx';
import Agentes from './Agentes.jsx';
import SelectorMes from './SelectorMes.jsx';
import Icono from './Iconos.jsx';
import { api, formatoRut } from '../util.js';
import { MARCA } from '../marca.js';

/**
 * Estructura del portal: menú fijo a la izquierda (en celular, botón ☰) y el contenido a la derecha
 * con una ruta de navegación arriba (Inicio › Cliente › Razón social).
 */
export default function Portal({ usuario, alSalir, alActualizarUsuario }) {
  const esAdmin = usuario.rol === 'admin';
  const [empresas, setEmpresas] = useState(null);
  const [error, setError] = useState(null);
  // Al recargar (F5) se vuelve a la misma pantalla, guardada en el historial del navegador
  const inicial = window.history.state?.portal ?? {};
  const [seccion, setSeccion] = useState(inicial.seccion ?? 'inicio'); // inicio | revisar | buscar | clientes | usuarios | agentes | clave
  const [clienteId, setClienteId] = useState(inicial.clienteId ?? null); // ficha de cliente (equipo Sisgen)
  const [rut, setRut] = useState(inicial.rut ?? '');                     // razón social abierta
  const [periodo, setPeriodo] = useState(inicial.periodo ?? '');
  const [vista, setVista] = useState(inicial.vista ?? 'resumen');        // pestaña dentro de la razón social
  const [sucursal, setSucursal] = useState(inicial.sucursal ?? '');      // '' = todas las sucursales
  const [datos, setDatos] = useState(null);
  const [cargando, setCargando] = useState(false);
  const [filtroInicial, setFiltroInicial] = useState(null);
  const [menuAbierto, setMenuAbierto] = useState(false);
  const [pestanaAdmin, setPestanaAdmin] = useState(null);
  const [rutBuscar, setRutBuscar] = useState('');

  const cargarEmpresas = () => api('/api/empresas').then((lista) => {
    setEmpresas(lista);
    // Un cliente con una sola razón social entra directo a ella
    if (!esAdmin && lista.length === 1 && !inicial.rut) {
      setRut(lista[0].rut); setPeriodo(lista[0].ultimoPeriodoSisgen || lista[0].periodos[0] || ''); setVista('alertas');
    }
  }).catch((e) => setError(e.message));
  useEffect(() => { cargarEmpresas(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!rut || !periodo) return;
    setCargando(true);
    setError(null);
    api(`/api/cuadratura/${encodeURIComponent(rut)}/${periodo}`)
      .then(setDatos).catch((e) => setError(e.message)).finally(() => setCargando(false));
    // Mes en curso: se actualiza solo cada minuto (los documentos llegan en línea desde la sucursal)
    const hoy = new Date();
    const actual = `${hoy.getFullYear()}-${String(hoy.getMonth() + 1).padStart(2, '0')}`;
    if (periodo !== actual) return undefined;
    const t = setInterval(() => {
      if (document.hidden) return; // pestaña no visible: no se consulta
      api(`/api/cuadratura/${encodeURIComponent(rut)}/${periodo}`).then(setDatos).catch(() => {});
    }, 60000);
    return () => clearInterval(t);
  }, [rut, periodo]);

  const unaSola = !esAdmin && empresas?.length === 1;
  // Dónde se navegan las razones sociales: equipo Sisgen en "Clientes"; un cliente, en su "Inicio"
  const seccionEmpresas = esAdmin ? 'clientes' : 'inicio';
  const empresa = empresas?.find((e) => e.rut === rut);
  // Vista por sucursal: los datos de la razón social filtrados a una sucursal ('' = todas)
  const nombresSucursal = (a) => (a.sucursal ?? '').split(', ');
  const datosVista = datos && sucursal
    ? {
      ...datos,
      documentos: datos.documentos.filter((d) => d.sucursal === sucursal),
      alertas: datos.alertas.filter((a) => nombresSucursal(a).includes(sucursal)),
    }
    : datos;
  const nAlertas = datosVista?.alertas.filter((a) => a.nivel !== 'baja').length ?? 0;

  const ir = (s, opciones = {}) => {
    setSeccion(s);
    setMenuAbierto(false);
    setPestanaAdmin(opciones.pestana ?? null);
    if (s === seccionEmpresas && !unaSola) { setRut(''); setDatos(null); setClienteId(opciones.clienteId ?? null); }
    if (s === 'inicio' && unaSola) setVista('alertas'); // cliente con una razón social: su inicio son sus alertas
    if (s === 'clientes' || s === 'usuarios') cargarEmpresas();
  };
  const abrir = (nuevoRut, nuevoPeriodo, nuevaVista = 'resumen') => {
    const emp = empresas.find((x) => x.rut === nuevoRut);
    setSeccion(seccionEmpresas);
    setDatos(null);
    setVista(nuevaVista);
    if (nuevoRut !== rut) setSucursal('');
    setRut(nuevoRut);
    setPeriodo(nuevoPeriodo && emp?.periodos.includes(nuevoPeriodo) ? nuevoPeriodo : emp?.ultimoPeriodoSisgen || emp?.periodos[0] || '');
  };
  const irAAdmin = (pestana) => ir('usuarios', { pestana });
  const irADocumentos = (filtro) => { setFiltroInicial({ ...filtro, _t: Date.now() }); setVista('documentos'); };

  // ---------- Historial: el botón Atrás del navegador (y "← Volver") vuelve a la pantalla anterior ----------
  // Cada pantalla del portal queda como una entrada del historial del navegador.
  const pantalla = { seccion, clienteId, rut, periodo, vista, sucursal };
  const [profundidad, setProfundidad] = useState(window.history.state?.nivel ?? 0);
  useEffect(() => {
    // Al volver con Atrás, el historial ya está en esta pantalla: no se agrega una entrada nueva
    const actual = window.history.state?.portal;
    if (actual && JSON.stringify(actual) === JSON.stringify(pantalla)) return;
    const nivel = (window.history.state?.nivel ?? -1) + 1;
    const estado = { portal: pantalla, nivel };
    if (!actual) window.history.replaceState({ ...estado, nivel: 0 }, '');
    else window.history.pushState(estado, '');
    setProfundidad(actual ? nivel : 0);
  }, [seccion, clienteId, rut, periodo, vista, sucursal]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const alVolver = (ev) => {
      const p = ev.state?.portal;
      if (!p) return;
      setSeccion(p.seccion); setClienteId(p.clienteId); setVista(p.vista); setPeriodo(p.periodo); setSucursal(p.sucursal ?? '');
      if (p.rut !== rut) setDatos(null);
      setRut(p.rut);
      setProfundidad(ev.state.nivel ?? 0);
      setMenuAbierto(false);
    };
    window.addEventListener('popstate', alVolver);
    return () => window.removeEventListener('popstate', alVolver);
  }, [rut]);
  const volver = () => window.history.back();

  // ---------- Menú ----------
  const opciones = [
    ['inicio', 'Inicio'],
    ['revisar', 'Qué revisar'],
    ['buscar', 'Buscar documento'],
  ];
  const opcionesAdmin = [
    ['clientes', 'Clientes'],
    ['usuarios', 'Usuarios y accesos'],
    ['agentes', 'Agentes instalados'],
  ];
  const BotonMenu = ([id, texto, icono = id]) => (
    <button key={id} type="button" className={`menu-item ${seccion === id ? 'activo' : ''}`} aria-current={seccion === id ? 'page' : undefined}
      onClick={() => ir(id)}>
      <Icono nombre={icono} />{texto}
    </button>
  );

  // ---------- Ruta de navegación ----------

  const migas = [];
  if (seccion === seccionEmpresas) {
    migas.push([esAdmin ? 'Clientes' : 'Inicio', unaSola ? null : () => ir(seccionEmpresas)]);
    // Cada razón social va por su cuenta: el cliente (grupo) solo aparece al estar en su ficha
    if (esAdmin && clienteId && !rut) {
      migas.push([`Ficha · ${empresas?.find((e) => e.clienteId === clienteId)?.razonSocial ?? 'cliente'}`, null]);
    }
    if (rut && empresa) migas.push([empresa.razonSocial, null]);
  } else {
    const nombres = Object.fromEntries([...opciones, ...opcionesAdmin, ['clave', 'Cambiar contraseña']]);
    if (seccion === 'inicio') migas.push(['Inicio', null]);
    else migas.push(['Inicio', () => ir('inicio')], [nombres[seccion], null]);
  }

  // ---------- Contenido ----------
  let contenido;
  if (seccion === 'clave') {
    contenido = <CambiarClave usuario={usuario} alCancelar={() => ir('inicio')} alCambiar={(u) => { alActualizarUsuario(u); ir('inicio'); }} />;
  } else if (seccion === 'inicio' && esAdmin) {
    // Inicio del equipo Sisgen: por ahora vacío (se definirá más adelante)
    contenido = (
      <div className="inicio-vacio">
        <h1 className="h4">Hola, {usuario.nombre.split(' ')[0]}</h1>
        <p className="text-secondary mb-0">Usa el menú de la izquierda: <strong>Clientes</strong> para ver cada razón social, <strong>Qué revisar</strong> para lo pendiente.</p>
      </div>
    );
  } else if (seccion === 'usuarios' && esAdmin) {
    contenido = <Admin key={`u-${pestanaAdmin}`} usuarioActual={usuario} titulo="Usuarios y accesos" pestanas={['usuarios', 'clientes', 'empresas', 'ingresos']} pestanaInicial={pestanaAdmin ?? 'usuarios'} />;
  } else if (seccion === 'agentes' && esAdmin) {
    contenido = <Agentes abrirCliente={(cid) => ir('clientes', { clienteId: cid })} />;
  } else if (!empresas) {
    contenido = error ? <div className="alert alert-danger">{error}</div> : <div className="text-secondary">Cargando…</div>;
  } else if (empresas.length === 0 && seccion !== 'revisar') {
    contenido = <div className="alert alert-info">{esAdmin ? 'Aún no hay razones sociales en el portal.' : 'Tu usuario aún no tiene razones sociales asignadas. Contacta a Sisgen.'}</div>;
  } else if (seccion === 'revisar') {
    contenido = <QueRevisar usuario={usuario} abrir={(r, p) => abrir(r, p, 'alertas')} />;
  } else if (seccion === 'buscar') {
    const rb = rutBuscar || (empresas.length === 1 ? empresas[0].rut : '');
    contenido = (
      <>
        <h1 className="h4 mb-3">Buscar documento</h1>
        {empresas.length > 1 && (
          <div className="mb-3" style={{ maxWidth: '32rem' }}>
            <label className="form-label small mb-1" htmlFor="buscar-rut">Razón social</label>
            <select id="buscar-rut" className="form-select" value={rb} onChange={(e) => setRutBuscar(e.target.value)}>
              <option value="">Elige la razón social…</option>
              {empresas.map((e) => <option key={e.rut} value={e.rut}>{e.razonSocial} · {formatoRut(e.rut)}</option>)}
            </select>
          </div>
        )}
        {rb ? <BuscarDocumentos key={rb} rut={rb} /> : <div className="text-secondary">Elige una razón social para buscar sus documentos.</div>}
      </>
    );
  } else if (!rut) {
    contenido = esAdmin
      ? (clienteId
        ? <FichaCliente clienteId={clienteId} abrir={abrir} volver={() => setClienteId(null)} irAAdmin={irAAdmin} />
        : <TablaClientes abrirRazon={(r, p) => abrir(r, p)} abrirCliente={setClienteId} />)
      : <QueRevisar usuario={usuario} titulo="Tus alertas" abrir={(r, p) => abrir(r, p, 'alertas')} />;
  } else {
    contenido = (
      <>
        {empresa?.esDemo && (
          <div className="alert alert-info py-2"><strong>Datos de ejemplo.</strong> Esta empresa es ficticia y sirve para ver el funcionamiento del portal.</div>
        )}
        <div className="d-flex flex-wrap justify-content-between align-items-end gap-2 mb-2">
          <div>
            <h1 className="h4 mb-0">{empresa?.razonSocial}</h1>
            <div className="text-secondary small">
              RUT {formatoRut(empresa?.rut)} · {empresa?.sucursales.length} {empresa?.sucursales.length === 1 ? 'sucursal' : 'sucursales'}
            </div>
          </div>
          <div className="d-flex gap-2 flex-wrap">
            {empresa?.sucursales.length > 1 && vista !== 'buscar' && (
              <select className="form-select form-select-sm w-auto selector-sucursal" aria-label="Sucursal" value={sucursal}
                onChange={(e) => setSucursal(e.target.value)}>
                <option value="">Todas las sucursales</option>
                {empresa.sucursales.map((s) => <option key={s.id} value={s.nombre}>{s.nombre}</option>)}
              </select>
            )}
            {vista !== 'buscar' && <SelectorMes valor={periodo} periodos={empresa?.periodos} alCambiar={setPeriodo} />}
          </div>
        </div>
        <div className="pestanas-empresa mb-3" role="tablist">
          {[
            ['resumen', 'Resumen'],
            ['alertas', <>Qué revisar{nAlertas > 0 && <span className="contador-pestana">{nAlertas}</span>}</>],
            ['documentos', 'Detalle'],
            ['compras', 'Compras'],
            ['buscar', 'Buscar documento'],
          ].map(([id, txt]) => (
            <button key={id} type="button" role="tab" aria-selected={vista === id} className={`pestana ${vista === id ? 'activa' : ''}`}
              onClick={() => setVista(id)}>{txt}</button>
          ))}
        </div>
        {error && <div className="alert alert-danger">{error}</div>}
        {cargando && !datos && vista !== 'buscar' && <div className="text-secondary">Cargando…</div>}
        {vista === 'buscar' && <BuscarDocumentos rut={rut} />}
        {vista === 'compras' && periodo && <Compras rut={rut} periodo={periodo} sucursal={sucursal} />}
        {datos && vista !== 'buscar' && vista !== 'compras' && (
          <div style={{ opacity: cargando ? 0.5 : 1 }}>
            {sucursal && <div className="small text-secondary mb-2">Mostrando solo la sucursal <strong>{sucursal}</strong>.</div>}
            {vista === 'resumen' && <Resumen datos={datosVista} irAAlertas={() => setVista('alertas')} irADocumentos={irADocumentos} />}
            {vista === 'alertas' && <Alertas alertas={datosVista.alertas} irADocumentos={irADocumentos} rut={datosVista.rut} />}
            {vista === 'documentos' && <Documentos key={sucursal} datos={datosVista} filtroInicial={filtroInicial} />}
          </div>
        )}
      </>
    );
  }

  const iniciales = usuario.nombre.split(/\s+/).slice(0, 2).map((p) => p[0]).join('').toUpperCase();

  return (
    <div className="disposicion">
      {/* Barra superior solo en celular */}
      <header className="barra-movil">
        <button type="button" className="btn btn-link p-1 text-body" aria-label="Abrir menú" aria-expanded={menuAbierto} onClick={() => setMenuAbierto(!menuAbierto)}>
          <Icono nombre="menu" />
        </button>
        <img src={MARCA.logo} alt={MARCA.portal} className="logo-movil" />
      </header>

      <aside className={`menu-lateral ${menuAbierto ? 'abierto' : ''}`} aria-label="Menú principal">
        <button type="button" className="marca-menu btn btn-link p-0 text-decoration-none text-start" onClick={() => ir('inicio')}>
          <img src={MARCA.logo} alt="" className="logo-menu" />
          <span className="texto-marca">{MARCA.portal}<small>{MARCA.modulo}</small></span>
        </button>
        <nav className="menu-grupo">{opciones.map(BotonMenu)}</nav>
        {esAdmin && (
          <>
            <div className="menu-titulo">Solo equipo Sisgen</div>
            <nav className="menu-grupo">{opcionesAdmin.map(BotonMenu)}</nav>
          </>
        )}
        <div className="menu-titulo">Mi cuenta</div>
        <div className="menu-usuario-info">
          <span className="avatar" aria-hidden="true">{iniciales}</span>
          <span><strong>{usuario.nombre}</strong><small>{esAdmin ? 'Equipo Sisgen' : usuario.cliente}</small></span>
        </div>
        <nav className="menu-grupo">
          {BotonMenu(['clave', 'Cambiar contraseña'])}
          <button type="button" className="menu-item" onClick={alSalir}><Icono nombre="salir" />Salir</button>
        </nav>
      </aside>
      {menuAbierto && <div className="velo-menu" onClick={() => setMenuAbierto(false)} aria-hidden="true" />}

      <main className="contenido">
        {profundidad > 0 && (
          <button type="button" className="boton-volver mb-1" onClick={volver}>← Volver</button>
        )}
        <nav aria-label="Ruta" className="migas">
          {migas.map(([txt, fn], i) => (
            <span key={i}>
              {i > 0 && <span className="separador" aria-hidden="true">›</span>}
              {fn && i < migas.length - 1
                ? <button type="button" className="btn btn-link p-0 align-baseline" onClick={fn}>{txt}</button>
                : <span className={i === migas.length - 1 ? 'actual' : ''}>{txt}</span>}
            </span>
          ))}
        </nav>
        {contenido}
      </main>
    </div>
  );
}
