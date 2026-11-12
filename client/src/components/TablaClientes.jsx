import { useEffect, useMemo, useState } from 'react';
import { api, numero, haceCuanto, numeroRut, formatoRut } from '../util.js';

const leer = (k, def) => { try { return JSON.parse(localStorage.getItem(k)) ?? def; } catch { return def; } };
const guardar = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* sin almacenamiento */ } };

// Columnas ordenables (clic en el título)
const COLUMNAS = [
  { id: 'rut', titulo: 'Rut', valor: (r) => numeroRut(r.rut) },
  { id: 'razon', titulo: 'Razón Social', valor: (r) => r.razonSocial.toLowerCase() },
  { id: 'sucursales', titulo: 'Sucursales', valor: (r) => r.sucursales, num: true },
  { id: 'lectura', titulo: 'Última lectura', valor: (r) => r.lecturaMasAntigua ?? '' },
];

const normalizar = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ.\-\s]/g, '');

/**
 * Inicio del equipo Sisgen (estilo "Fichas de Clientes"): listado simple de razones sociales.
 * El mes y la cuadratura se eligen al entrar a cada una.
 */
export default function TablaClientes({ abrirRazon, abrirCliente }) {
  const [datos, setDatos] = useState(null);
  const [error, setError] = useState(null);
  const [busqueda, setBusqueda] = useState('');
  const [porPagina, setPorPagina] = useState(() => leer('razones-por-pagina', 15));
  const [pagina, setPagina] = useState(0);
  const [orden, setOrden] = useState(() => leer('razones-orden', { col: 'rut', asc: true }));

  useEffect(() => {
    api('/api/admin/razones').then((d) => { setDatos(d); setError(null); }).catch((e) => setError(e.message));
  }, []);
  useEffect(() => setPagina(0), [busqueda, porPagina, orden]);

  const fijarOrden = (nuevo) => { setOrden(nuevo); guardar('razones-orden', nuevo); };
  const ordenarPor = (col) => fijarOrden({ col, asc: orden.col === col ? !orden.asc : !COLUMNAS.find((c) => c.id === col).num });

  const filas = useMemo(() => {
    const q = normalizar(busqueda);
    const col = COLUMNAS.find((c) => c.id === orden.col) ?? COLUMNAS[0];
    return (datos?.razones ?? [])
      .filter((r) => !q || normalizar(r.razonSocial).includes(q) || normalizar(r.rut).includes(q)
        || r.nombresSucursales.some((s) => normalizar(s).includes(q)))
      .sort((a, b) => {
        const va = col.valor(a), vb = col.valor(b);
        const x = va < vb ? -1 : va > vb ? 1 : a.razonSocial.localeCompare(b.razonSocial);
        return orden.asc ? x : -x;
      });
  }, [datos, busqueda, orden]);

  const paginas = Math.max(1, Math.ceil(filas.length / porPagina));
  const visibles = filas.slice(pagina * porPagina, (pagina + 1) * porPagina);

  return (
    <>
      <h1 className="titulo-fichas mb-0">Razones sociales</h1>
      <hr className="mt-2 mb-3" />

      <div className="row g-3 mb-3">
        <div className="col-md-4">
          <label className="form-label" htmlFor="f-orden">Ordenamiento</label>
          <select id="f-orden" className="form-select" value={`${orden.col}|${orden.asc ? 'asc' : 'desc'}`}
            onChange={(e) => { const [col, dir] = e.target.value.split('|'); fijarOrden({ col, asc: dir === 'asc' }); }}>
            <option value="rut|asc">Rut (menor a mayor)</option>
            <option value="rut|desc">Rut (mayor a menor)</option>
            <option value="razon|asc">Razón social (A a la Z)</option>
            <option value="sucursales|desc">Más sucursales primero</option>
          </select>
        </div>
      </div>

      <div className="d-flex flex-wrap justify-content-between align-items-center gap-2 mb-2">
        <label className="d-flex align-items-center gap-2 mb-0">
          Ver:
          <select className="form-select form-select-sm w-auto" value={porPagina}
            onChange={(e) => { const n = Number(e.target.value); setPorPagina(n); guardar('razones-por-pagina', n); }}>
            {[15, 25, 50, 100].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        <label className="d-flex align-items-center gap-2 mb-0">
          Buscar result.:
          <input type="search" className="form-control form-control-sm" style={{ width: '14rem' }} value={busqueda} onChange={(e) => setBusqueda(e.target.value)} />
        </label>
      </div>

      {error && <div className="alert alert-danger">{error}</div>}
      {!datos && !error && <div className="text-secondary">Cargando…</div>}

      {datos && (
        <>
          <div className="table-responsive">
            <table className="table table-striped align-middle tabla-fichas">
              <thead>
                <tr>
                  {COLUMNAS.map((c) => (
                    <th key={c.id} scope="col" className={c.num ? 'text-end' : ''} aria-sort={orden.col === c.id ? (orden.asc ? 'ascending' : 'descending') : 'none'}>
                      <button type="button" className="encabezado-orden" onClick={() => ordenarPor(c.id)}>
                        {c.titulo}
                        <span className={`flechas ${orden.col === c.id ? (orden.asc ? 'asc' : 'desc') : ''}`} aria-hidden="true">
                          <span>▲</span><span>▼</span>
                        </span>
                      </button>
                    </th>
                  ))}
                  <th aria-label="Acciones" />
                </tr>
              </thead>
              <tbody>
                {visibles.map((r) => (
                  <tr key={r.rut}>
                    <td className="text-nowrap">{formatoRut(r.rut)}</td>
                    <td>
                      {r.razonSocial}
                      {r.esDemo && <span className="badge text-bg-info ms-2">Demo</span>}
                    </td>
                    <td className="text-end" title={r.nombresSucursales.join(', ')}>{r.sucursales}</td>
                    <td className={`small text-nowrap ${r.sucursalesDesactualizadas ? 'text-warning-emphasis' : 'text-secondary'}`}>
                      {haceCuanto(r.lecturaMasAntigua)}
                    </td>
                    <td className="text-end text-nowrap">
                      <button type="button" className="btn btn-sm btn-outline-primary boton-accion me-1" title="Ver cuadratura" aria-label={`Ver cuadratura de ${r.razonSocial}`}
                        disabled={!r.periodo} onClick={() => abrirRazon(r.rut, r.periodo)}>
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M4 19V5" /><path d="M4 19h16" /><path d="M8 15l3-4 3 2 4-6" /></svg>
                      </button>
                      <button type="button" className="btn btn-sm btn-outline-info boton-accion" title="Ficha (sucursales, agente y usuarios)" aria-label={`Ficha de ${r.razonSocial}`}
                        disabled={!r.clienteId} onClick={() => abrirCliente(r.clienteId)}>
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M14 3H6a2 2 0 00-2 2v14a2 2 0 002 2h12a2 2 0 002-2V9z" /><path d="M14 3v6h6" /><path d="M8 13h8" /><path d="M8 17h5" /></svg>
                      </button>
                    </td>
                  </tr>
                ))}
                {visibles.length === 0 && (
                  <tr><td colSpan={COLUMNAS.length + 1} className="text-center text-secondary py-4">No se encontraron razones sociales.</td></tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="d-flex flex-wrap justify-content-between align-items-center gap-2 small text-secondary">
            <span>Mostrando {filas.length ? pagina * porPagina + 1 : 0} a {Math.min((pagina + 1) * porPagina, filas.length)} de {numero(filas.length)} razones sociales</span>
            {paginas > 1 && (
              <div className="btn-group btn-group-sm">
                <button type="button" className="btn btn-outline-secondary" disabled={pagina === 0} onClick={() => setPagina(pagina - 1)}>Anterior</button>
                <span className="btn btn-outline-secondary disabled">{pagina + 1} de {paginas}</span>
                <button type="button" className="btn btn-outline-secondary" disabled={pagina >= paginas - 1} onClick={() => setPagina(pagina + 1)}>Siguiente</button>
              </div>
            )}
          </div>
        </>
      )}
    </>
  );
}
