import { useEffect, useMemo, useState } from 'react';
import { api, pesos, numero, nombrePeriodo, haceCuanto, ESTADO_CLIENTE, GRAVEDAD, numeroRut, formatoRut } from '../util.js';

const leer = (k, def) => { try { return JSON.parse(localStorage.getItem(k)) ?? def; } catch { return def; } };
const guardar = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* sin almacenamiento */ } };

const COLUMNAS = [
  { id: 'nombre', titulo: 'Cliente', valor: (c) => c.nombre.toLowerCase() },
  { id: 'rut', titulo: 'RUT', valor: (c) => numeroRut(c.rutMenor) || Infinity },
  { id: 'razones', titulo: 'Raz. sociales', valor: (c) => c.razones, num: true },
  { id: 'sucursales', titulo: 'Sucursales', valor: (c) => c.sucursales, num: true },
  { id: 'estado', titulo: 'Estado del mes', valor: (c) => GRAVEDAD[c.estado] * 1e6 - c.urgentes * 1e3 - c.alertas },
  { id: 'alertas', titulo: 'Alertas', valor: (c) => c.alertas, num: true },
  { id: 'monto', titulo: 'Total vendido', valor: (c) => c.montoTotal, num: true },
  { id: 'lectura', titulo: 'Última lectura', valor: (c) => c.lecturaMasAntigua ?? '' },
];

const FILTROS = [
  { id: 'todos', texto: 'Todos', cumple: () => true },
  { id: 'urgente', texto: 'Alertas urgentes', cumple: (c) => c.estado === 'urgente', color: 'danger' },
  { id: 'revisar', texto: 'Por revisar', cumple: (c) => c.estado === 'revisar', color: 'warning' },
  { id: 'sinSii', texto: 'Sin consultar SII', cumple: (c) => c.sinSii > 0 },
  { id: 'desactualizados', texto: 'Datos desactualizados', cumple: (c) => c.sucursalesDesactualizadas > 0 },
  { id: 'ok', texto: 'Todo cuadra', cumple: (c) => c.estado === 'ok', color: 'success' },
];

const normalizar = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ.\-\s]/g, '');

/** Inicio del equipo Sisgen: tabla de clientes ordenable y filtrable. */
export default function TablaClientes({ abrirCliente, irAAdmin }) {
  const [periodo, setPeriodo] = useState('');
  const [datos, setDatos] = useState(null);
  const [error, setError] = useState(null);
  const [cargando, setCargando] = useState(true);
  const [busqueda, setBusqueda] = useState('');
  const [filtro, setFiltro] = useState('todos');
  const [orden, setOrden] = useState(() => leer('tabla-clientes-orden', { col: 'estado', asc: true }));

  useEffect(() => {
    setCargando(true);
    api(`/api/admin/tabla${periodo ? `?periodo=${periodo}` : ''}`)
      .then((d) => { setDatos(d); setError(null); })
      .catch((e) => setError(e.message))
      .finally(() => setCargando(false));
  }, [periodo]);

  const ordenarPor = (col) => {
    const nuevo = { col, asc: orden.col === col ? !orden.asc : !COLUMNAS.find((c) => c.id === col).num };
    setOrden(nuevo);
    guardar('tabla-clientes-orden', nuevo);
  };

  const clientes = datos?.clientes ?? [];
  const conteo = Object.fromEntries(FILTROS.map((f) => [f.id, clientes.filter(f.cumple).length]));

  const filas = useMemo(() => {
    const q = normalizar(busqueda);
    const f = FILTROS.find((x) => x.id === filtro);
    const col = COLUMNAS.find((c) => c.id === orden.col) ?? COLUMNAS[4];
    return clientes
      .filter(f.cumple)
      .filter((c) => !q || normalizar(c.nombre).includes(q) || c.ruts.some((r) => normalizar(r).includes(q)))
      .sort((a, b) => {
        const va = col.valor(a), vb = col.valor(b);
        const r = va < vb ? -1 : va > vb ? 1 : a.nombre.localeCompare(b.nombre);
        return orden.asc ? r : -r;
      });
  }, [clientes, busqueda, filtro, orden]);

  return (
    <>
      <div className="d-flex flex-wrap justify-content-between align-items-end gap-2 mb-3">
        <div>
          <h1 className="h4 mb-0">Clientes</h1>
          <div className="text-secondary small">
            {clientes.length} clientes · {periodo ? nombrePeriodo(periodo) : 'último mes con datos de cada razón social'}
          </div>
        </div>
        <select className="form-select form-select-sm w-auto" aria-label="Periodo" value={periodo} onChange={(e) => setPeriodo(e.target.value)}>
          <option value="">Último mes disponible</option>
          {datos?.periodos.map((p) => <option key={p} value={p}>{nombrePeriodo(p)}</option>)}
        </select>
      </div>

      {error && <div className="alert alert-danger">{error}</div>}
      {cargando && !datos && <div className="text-secondary">Cargando…</div>}

      {datos && (
        <div style={{ opacity: cargando ? 0.5 : 1 }}>
          <div className="row g-2 mb-3">
            {[['urgente', 'Con alertas urgentes', 'danger'], ['revisar', 'Por revisar', 'warning'],
              ['desactualizados', 'Datos desactualizados', 'secondary'], ['ok', 'Todo cuadra', 'success']].map(([id, txt, color]) => (
              <div className="col-6 col-lg-3" key={id}>
                <button type="button" className={`contador contador-${color} w-100 text-start ${filtro === id ? 'activo' : ''}`}
                  onClick={() => setFiltro(filtro === id ? 'todos' : id)} aria-pressed={filtro === id}>
                  <div className="small">{txt}</div>
                  <div className="fs-4 fw-semibold">{conteo[id]}</div>
                </button>
              </div>
            ))}
          </div>

          {datos.sinCliente.length > 0 && (
            <div className="alert alert-warning py-2 d-flex flex-wrap justify-content-between align-items-center gap-2">
              <span>
                <strong>{datos.sinCliente.length} {datos.sinCliente.length === 1 ? 'razón social' : 'razones sociales'} sin cliente</strong>
                {' '}({datos.sinCliente.map((e) => e.razonSocial).join(', ')}): no aparecen en la tabla.
              </span>
              <button type="button" className="btn btn-sm btn-outline-dark" onClick={() => irAAdmin('empresas')}>Asignar cliente</button>
            </div>
          )}

          <div className="d-flex flex-wrap gap-2 align-items-center mb-2">
            <input type="search" className="form-control form-control-sm" style={{ maxWidth: '18rem' }}
              placeholder="Buscar por nombre o RUT" aria-label="Buscar cliente" value={busqueda} onChange={(e) => setBusqueda(e.target.value)} />
            <div className="d-flex flex-wrap gap-1" role="group" aria-label="Filtro">
              {FILTROS.map((f) => (
                <button key={f.id} type="button" className={`btn btn-sm chip-filtro ${filtro === f.id ? 'activo' : ''}`}
                  aria-pressed={filtro === f.id} onClick={() => setFiltro(f.id)}>
                  {f.texto} <span className="text-secondary">{conteo[f.id]}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="card tarjeta">
            <div className="table-responsive">
              <table className="table table-hover align-middle mb-0 tabla-clientes">
                <thead>
                  <tr>
                    {COLUMNAS.map((c) => (
                      <th key={c.id} scope="col" className={c.num ? 'text-end' : ''}
                        aria-sort={orden.col === c.id ? (orden.asc ? 'ascending' : 'descending') : 'none'}>
                        <button type="button" className="btn btn-link p-0 encabezado-orden" onClick={() => ordenarPor(c.id)}>
                          {c.titulo}<span className="flecha" aria-hidden="true">{orden.col === c.id ? (orden.asc ? ' ▲' : ' ▼') : ''}</span>
                        </button>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filas.map((c) => {
                    const est = ESTADO_CLIENTE[c.estado];
                    return (
                      <tr key={c.id} className="fila-cliente" onClick={() => abrirCliente(c.id)}>
                        <td>
                          <button type="button" className="btn btn-link p-0 text-start fw-semibold text-body text-decoration-none"
                            onClick={(e) => { e.stopPropagation(); abrirCliente(c.id); }}>{c.nombre}</button>
                          {!c.activo && <span className="badge text-bg-secondary ms-2">Inactivo</span>}
                        </td>
                        <td className="text-nowrap">
                          {formatoRut(c.rutMenor)}{c.ruts.length > 1 && <span className="text-secondary small"> +{c.ruts.length - 1}</span>}
                        </td>
                        <td className="text-end">{c.razones}</td>
                        <td className="text-end">{c.sucursales}</td>
                        <td>
                          <span className={`badge text-bg-${est.color}`}>
                            {c.estado === 'urgente' ? `${c.urgentes} ${c.urgentes === 1 ? 'urgente' : 'urgentes'}` : est.texto}
                          </span>
                          {c.conProblemas > 0 && <div className="small text-danger">{numero(c.conProblemas)} docs con problemas</div>}
                        </td>
                        <td className={`text-end ${c.alertas ? 'text-danger fw-semibold' : 'text-secondary'}`}>{c.alertas}</td>
                        <td className="text-end tabla-num">{c.documentos ? pesos(c.montoTotal) : '—'}</td>
                        <td className={`text-nowrap ${c.sucursalesDesactualizadas ? 'text-warning-emphasis' : 'text-secondary'}`}>
                          {haceCuanto(c.lecturaMasAntigua)}
                          {c.sucursalesDesactualizadas > 0 && (
                            <div className="small">{c.sucursalesDesactualizadas} de {c.sucursales} desactualizada{c.sucursalesDesactualizadas > 1 ? 's' : ''}</div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                  {filas.length === 0 && (
                    <tr><td colSpan={COLUMNAS.length} className="text-center text-secondary py-4">Ningún cliente coincide con la búsqueda o el filtro.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
          <div className="small text-secondary mt-2">
            Mostrando {filas.length} de {clientes.length}. "Última lectura" es la sucursal que lleva más tiempo sin leerse desde Sisgen
            (desactualizada: más de 2 días).
          </div>
        </div>
      )}
    </>
  );
}
