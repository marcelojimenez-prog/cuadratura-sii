import { useCallback, useEffect, useState } from 'react';
import { api } from '../util.js';

const fechaHora = (s) => (s ? new Date(s.replace(' ', 'T')).toLocaleString('es-CL', { dateStyle: 'short', timeStyle: 'short' }) : '—');

/** Panel de administración: solo usuarios Sisgen (rol admin). */
export default function Admin({ usuarioActual, pestanaInicial = 'usuarios' }) {
  const [pestana, setPestana] = useState(pestanaInicial);
  const [datos, setDatos] = useState(null);
  const [error, setError] = useState(null);
  const [aviso, setAviso] = useState(null);       // { tipo, texto }
  const [clave, setClave] = useState(null);       // { usuario, claveTemporal } (se muestra una vez)

  const cargar = useCallback(() => api('/api/admin/datos').then(setDatos).catch((e) => setError(e.message)), []);
  useEffect(() => { cargar(); }, [cargar]);

  /** Ejecuta una acción del panel, muestra el resultado y recarga los datos. */
  const ejecutar = async (fn, exito) => {
    setAviso(null);
    try {
      const r = await fn();
      if (r?.claveTemporal) setClave({ usuario: r.usuario, claveTemporal: r.claveTemporal });
      if (exito) setAviso({ tipo: 'success', texto: exito });
      await cargar();
      return true;
    } catch (e) {
      setAviso({ tipo: 'danger', texto: e.message });
      return false;
    }
  };

  const sinCliente = datos?.empresas.filter((e) => !e.cliente_id).length ?? 0;
  const pestanas = [
    ['usuarios', 'Usuarios', datos?.usuarios.length],
    ['clientes', 'Clientes', datos?.clientes.length],
    ['empresas', 'Razones sociales', sinCliente ? <span className="badge text-bg-warning ms-1" title="Sin cliente asignado">{sinCliente}</span> : datos?.empresas.length],
    ['ingresos', 'Registro de ingresos'],
  ];

  return (
    <>
      <div className="mb-3">
        <h1 className="h4 mb-0">Administración</h1>
        <div className="text-secondary small">Clientes, razones sociales y usuarios del portal · solo equipo Sisgen</div>
      </div>

      <ul className="nav nav-tabs mb-3">
        {pestanas.map(([id, txt, n]) => (
          <li className="nav-item" key={id}>
            <button className={`nav-link ${pestana === id ? 'active' : ''}`} onClick={() => { setPestana(id); setAviso(null); }}>
              {txt} {typeof n === 'number' ? <span className="text-secondary small">({n})</span> : n}
            </button>
          </li>
        ))}
      </ul>

      {clave && (
        <div className="alert alert-success d-flex flex-wrap align-items-center gap-3" role="status">
          <div className="flex-grow-1">
            <div className="fw-semibold">Clave temporal de <code>{clave.usuario}</code></div>
            <div className="small">Entrégala al usuario: deberá cambiarla en su primer ingreso. <strong>Solo se muestra esta vez.</strong></div>
          </div>
          <code className="fs-5 px-3 py-1 bg-white rounded border user-select-all">{clave.claveTemporal}</code>
          <button type="button" className="btn btn-sm btn-outline-success" onClick={() => navigator.clipboard?.writeText(clave.claveTemporal)}>Copiar</button>
          <button type="button" className="btn-close" aria-label="Cerrar" onClick={() => setClave(null)} />
        </div>
      )}
      {aviso && <div className={`alert alert-${aviso.tipo} py-2`} role="alert">{aviso.texto}</div>}
      {error && <div className="alert alert-danger">{error}</div>}
      {!datos && !error && <div className="text-secondary">Cargando…</div>}

      {datos && pestana === 'usuarios' && <Usuarios datos={datos} usuarioActual={usuarioActual} ejecutar={ejecutar} />}
      {datos && pestana === 'clientes' && <Clientes datos={datos} ejecutar={ejecutar} />}
      {datos && pestana === 'empresas' && <Empresas datos={datos} ejecutar={ejecutar} />}
      {pestana === 'ingresos' && <Ingresos />}
    </>
  );
}

// ---------------------------------------------------------------- Usuarios
function Usuarios({ datos, usuarioActual, ejecutar }) {
  const [nuevo, setNuevo] = useState(null);
  const [filtro, setFiltro] = useState('');
  const clientesActivos = datos.clientes.filter((c) => c.activo);

  const crear = async (e) => {
    e.preventDefault();
    const ok = await ejecutar(() => api('/api/admin/usuarios', { metodo: 'POST', cuerpo: nuevo }), `Usuario ${nuevo.usuario} creado`);
    if (ok) setNuevo(null);
  };
  const lista = datos.usuarios.filter((u) => !filtro || `${u.usuario} ${u.nombre} ${u.cliente ?? 'sisgen'}`.toLowerCase().includes(filtro.toLowerCase()));

  return (
    <>
      <div className="d-flex flex-wrap gap-2 mb-3">
        <input className="form-control form-control-sm" style={{ maxWidth: '18rem' }} placeholder="Buscar usuario, nombre o cliente"
          aria-label="Buscar usuarios" value={filtro} onChange={(e) => setFiltro(e.target.value)} />
        <div className="flex-grow-1" />
        {!nuevo && (
          <button type="button" className="btn btn-sm btn-primary boton-marca"
            onClick={() => setNuevo({ usuario: '', nombre: '', rol: 'cliente', clienteId: clientesActivos[0]?.id ?? '' })}>
            + Nuevo usuario
          </button>
        )}
      </div>

      {nuevo && (
        <form className="card tarjeta mb-3" onSubmit={crear}>
          <div className="card-header">Nuevo usuario</div>
          <div className="card-body row g-3">
            <div className="col-md-3">
              <label className="form-label small" htmlFor="nu-usuario">Usuario (para ingresar)</label>
              <input id="nu-usuario" className="form-control" autoFocus value={nuevo.usuario} placeholder="ej: juan.perez"
                onChange={(e) => setNuevo({ ...nuevo, usuario: e.target.value.trim() })} />
            </div>
            <div className="col-md-3">
              <label className="form-label small" htmlFor="nu-nombre">Nombre</label>
              <input id="nu-nombre" className="form-control" value={nuevo.nombre} onChange={(e) => setNuevo({ ...nuevo, nombre: e.target.value })} />
            </div>
            <div className="col-md-3">
              <label className="form-label small" htmlFor="nu-tipo">Tipo</label>
              <select id="nu-tipo" className="form-select" value={nuevo.rol} onChange={(e) => setNuevo({ ...nuevo, rol: e.target.value })}>
                <option value="cliente">Cliente</option>
                <option value="admin">Equipo Sisgen (administrador)</option>
              </select>
            </div>
            <div className="col-md-3">
              <label className="form-label small" htmlFor="nu-cliente">Cliente</label>
              <select id="nu-cliente" className="form-select" disabled={nuevo.rol !== 'cliente'} value={nuevo.rol === 'cliente' ? nuevo.clienteId : ''}
                onChange={(e) => setNuevo({ ...nuevo, clienteId: Number(e.target.value) })}>
                {nuevo.rol !== 'cliente' && <option value="">Ve todos los clientes</option>}
                {clientesActivos.map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}
              </select>
            </div>
            <div className="col-12 d-flex gap-2">
              <button type="submit" className="btn btn-primary boton-marca" disabled={!nuevo.usuario || !nuevo.nombre}>Crear y generar clave temporal</button>
              <button type="button" className="btn btn-link" onClick={() => setNuevo(null)}>Cancelar</button>
            </div>
          </div>
        </form>
      )}

      <div className="card tarjeta">
        <div className="table-responsive">
          <table className="table table-hover align-middle mb-0">
            <thead className="table-light">
              <tr><th>Usuario</th><th>Nombre</th><th>Acceso</th><th>Estado</th><th>Último ingreso</th><th className="text-end">Acciones</th></tr>
            </thead>
            <tbody>
              {lista.map((u) => {
                const yo = u.id === usuarioActual.id;
                return (
                  <tr key={u.id} className={u.activo ? '' : 'text-secondary'}>
                    <td><code>{u.usuario}</code>{yo && <span className="badge text-bg-light ms-1">tú</span>}</td>
                    <td>{u.nombre}</td>
                    <td>
                      {u.rol === 'admin' ? <span className="badge text-bg-dark">Equipo Sisgen</span> : (
                        <select className="form-select form-select-sm" aria-label={`Cliente de ${u.usuario}`} value={u.cliente_id ?? ''}
                          onChange={(e) => ejecutar(() => api(`/api/admin/usuarios/${u.id}`, { metodo: 'PATCH', cuerpo: { clienteId: Number(e.target.value) } }),
                            `${u.usuario} ahora pertenece a ${datos.clientes.find((c) => c.id === Number(e.target.value))?.nombre}`)}>
                          {datos.clientes.map((c) => <option key={c.id} value={c.id}>{c.nombre}{c.activo ? '' : ' (inactivo)'}</option>)}
                        </select>
                      )}
                    </td>
                    <td>
                      {!u.activo ? <span className="badge text-bg-secondary">Desactivado</span>
                        : u.bloqueado ? <span className="badge text-bg-danger" title="Por intentos fallidos; restablecer la clave lo desbloquea">Bloqueado</span>
                        : u.debe_cambiar_clave ? <span className="badge text-bg-warning" title="Aún no cambia su clave temporal">Clave temporal</span>
                        : <span className="badge text-bg-success">Activo</span>}
                    </td>
                    <td className="small text-nowrap">{fechaHora(u.ultimo_ingreso)}</td>
                    <td className="text-end text-nowrap">
                      {!yo && (
                        <>
                          <button type="button" className="btn btn-sm btn-outline-primary me-1"
                            onClick={() => ejecutar(() => api(`/api/admin/usuarios/${u.id}/restablecer`, { metodo: 'POST' }))}>
                            Restablecer clave
                          </button>
                          <button type="button" className={`btn btn-sm ${u.activo ? 'btn-outline-danger' : 'btn-outline-success'}`}
                            onClick={() => ejecutar(() => api(`/api/admin/usuarios/${u.id}`, { metodo: 'PATCH', cuerpo: { activo: !u.activo } }),
                              `${u.usuario} ${u.activo ? 'desactivado' : 'activado'}`)}>
                            {u.activo ? 'Desactivar' : 'Activar'}
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
              {!lista.length && <tr><td colSpan={6} className="text-center text-secondary py-4">Sin usuarios</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- Clientes
function Clientes({ datos, ejecutar }) {
  const [nombre, setNombre] = useState('');
  const [editando, setEditando] = useState(null); // { id, nombre }

  const crear = async (e) => {
    e.preventDefault();
    if (await ejecutar(() => api('/api/admin/clientes', { metodo: 'POST', cuerpo: { nombre } }), `Cliente ${nombre} creado`)) setNombre('');
  };
  const renombrar = async (e) => {
    e.preventDefault();
    if (await ejecutar(() => api(`/api/admin/clientes/${editando.id}`, { metodo: 'PATCH', cuerpo: { nombre: editando.nombre } }), 'Cliente renombrado')) setEditando(null);
  };

  return (
    <>
      <p className="text-secondary small">
        Un cliente es la empresa con la que trabaja Sisgen. Puede tener una o varias razones sociales; sus usuarios ven todas ellas.
      </p>
      <form className="d-flex gap-2 mb-3" onSubmit={crear} style={{ maxWidth: '32rem' }}>
        <input className="form-control form-control-sm" placeholder="Nombre del nuevo cliente" aria-label="Nombre del nuevo cliente"
          value={nombre} onChange={(e) => setNombre(e.target.value)} />
        <button type="submit" className="btn btn-sm btn-primary boton-marca text-nowrap" disabled={nombre.trim().length < 2}>+ Crear cliente</button>
      </form>
      <div className="card tarjeta">
        <div className="table-responsive">
          <table className="table align-middle mb-0">
            <thead className="table-light"><tr><th>Cliente</th><th className="text-end">Razones sociales</th><th className="text-end">Usuarios</th><th>Estado</th><th className="text-end">Acciones</th></tr></thead>
            <tbody>
              {datos.clientes.map((c) => (
                <tr key={c.id} className={c.activo ? '' : 'text-secondary'}>
                  <td>
                    {editando?.id === c.id ? (
                      <form className="d-flex gap-2" onSubmit={renombrar}>
                        <input className="form-control form-control-sm" autoFocus aria-label="Nuevo nombre" value={editando.nombre}
                          onChange={(e) => setEditando({ ...editando, nombre: e.target.value })} />
                        <button type="submit" className="btn btn-sm btn-primary boton-marca">Guardar</button>
                        <button type="button" className="btn btn-sm btn-link" onClick={() => setEditando(null)}>Cancelar</button>
                      </form>
                    ) : <span className="fw-semibold">{c.nombre}</span>}
                  </td>
                  <td className="text-end">{c.empresas}</td>
                  <td className="text-end">{c.usuarios}</td>
                  <td>{c.activo ? <span className="badge text-bg-success">Activo</span> : <span className="badge text-bg-secondary" title="Sus usuarios no ven datos">Inactivo</span>}</td>
                  <td className="text-end text-nowrap">
                    <button type="button" className="btn btn-sm btn-outline-secondary me-1" onClick={() => setEditando({ id: c.id, nombre: c.nombre })}>Renombrar</button>
                    <button type="button" className={`btn btn-sm ${c.activo ? 'btn-outline-danger' : 'btn-outline-success'}`}
                      onClick={() => ejecutar(() => api(`/api/admin/clientes/${c.id}`, { metodo: 'PATCH', cuerpo: { activo: !c.activo } }),
                        `${c.nombre} ${c.activo ? 'desactivado: sus usuarios ya no ven datos' : 'activado'}`)}>
                      {c.activo ? 'Desactivar' : 'Activar'}
                    </button>
                  </td>
                </tr>
              ))}
              {!datos.clientes.length && <tr><td colSpan={5} className="text-center text-secondary py-4">Aún no hay clientes</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- Razones sociales
function Empresas({ datos, ejecutar }) {
  return (
    <>
      <p className="text-secondary small">
        Asigna cada razón social a su cliente. Una razón social sin cliente no la ve ningún usuario de cliente.
        Las sucursales se agregan por ahora con <code>npm run agregar</code>.
      </p>
      <div className="card tarjeta">
        <div className="table-responsive">
          <table className="table align-middle mb-0">
            <thead className="table-light">
              <tr><th>Razón social</th><th>RUT</th><th className="text-end">Sucursales</th><th>Último mes</th><th>Última consulta SII</th><th style={{ minWidth: '14rem' }}>Cliente</th></tr>
            </thead>
            <tbody>
              {datos.empresas.map((e) => (
                <tr key={e.rut} className={e.cliente_id ? '' : 'table-warning'}>
                  <td className="fw-semibold">{e.razon_social}{e.es_demo ? <span className="badge text-bg-light ms-1">demo</span> : null}</td>
                  <td className="text-nowrap">{e.rut}</td>
                  <td className="text-end">{e.sucursales}</td>
                  <td>{e.ultimo_periodo ?? '—'}</td>
                  <td className="small">{e.ultima_consulta_sii ? fechaHora(e.ultima_consulta_sii) : <span className="text-secondary">Nunca</span>}</td>
                  <td>
                    <select className="form-select form-select-sm" aria-label={`Cliente de ${e.razon_social}`} value={e.cliente_id ?? ''}
                      onChange={(ev) => {
                        const clienteId = ev.target.value ? Number(ev.target.value) : null;
                        const nombre = datos.clientes.find((c) => c.id === clienteId)?.nombre;
                        ejecutar(() => api(`/api/admin/empresas/${e.rut}/cliente`, { metodo: 'PUT', cuerpo: { clienteId } }),
                          clienteId ? `${e.razon_social} asignada a ${nombre}` : `${e.razon_social} quedó sin cliente`);
                      }}>
                      <option value="">— Sin cliente —</option>
                      {datos.clientes.map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- Registro de ingresos
function Ingresos() {
  const [filas, setFilas] = useState(null);
  const [soloFallidos, setSoloFallidos] = useState(false);
  useEffect(() => { api('/api/admin/ingresos?limite=300').then(setFilas).catch(() => setFilas([])); }, []);
  const lista = (filas ?? []).filter((f) => !soloFallidos || !f.exito);
  return (
    <>
      <div className="form-check mb-3">
        <input id="solo-fallidos" type="checkbox" className="form-check-input" checked={soloFallidos} onChange={(e) => setSoloFallidos(e.target.checked)} />
        <label htmlFor="solo-fallidos" className="form-check-label">Solo intentos fallidos</label>
      </div>
      <div className="card tarjeta">
        <div className="table-responsive">
          <table className="table table-sm align-middle mb-0">
            <thead className="table-light"><tr><th>Fecha</th><th>Usuario</th><th>Resultado</th><th>Detalle</th><th>IP</th></tr></thead>
            <tbody>
              {!filas && <tr><td colSpan={5} className="text-secondary py-3 text-center">Cargando…</td></tr>}
              {lista.map((f) => (
                <tr key={f.id}>
                  <td className="text-nowrap small">{fechaHora(f.fecha)}</td>
                  <td><code>{f.usuario}</code></td>
                  <td>{f.exito ? <span className="badge text-bg-success">Ingresó</span> : <span className="badge text-bg-danger">Rechazado</span>}</td>
                  <td className="small text-secondary">{f.motivo ?? ''}</td>
                  <td className="small text-secondary">{f.ip ?? ''}</td>
                </tr>
              ))}
              {filas && !lista.length && <tr><td colSpan={5} className="text-secondary py-3 text-center">Sin registros</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
