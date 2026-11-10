import { useEffect, useState } from 'react';
import Resumen from './components/Resumen.jsx';
import Alertas from './components/Alertas.jsx';
import Documentos from './components/Documentos.jsx';
import { nombrePeriodo } from './util.js';

export default function App() {
  const [empresas, setEmpresas] = useState([]);
  const [rut, setRut] = useState('');
  const [periodo, setPeriodo] = useState('');
  const [datos, setDatos] = useState(null);
  const [vista, setVista] = useState('resumen');
  const [error, setError] = useState(null);
  const [cargando, setCargando] = useState(false);
  const [filtroInicial, setFiltroInicial] = useState(null);

  useEffect(() => {
    fetch('/api/empresas')
      .then((r) => r.json())
      .then((lista) => {
        setEmpresas(lista);
        if (lista[0]) {
          setRut(lista[0].rut);
          setPeriodo(lista[0].periodos[0] || '');
        }
      })
      .catch(() => setError('No se pudo conectar con el servidor.'));
  }, []);

  useEffect(() => {
    if (!rut || !periodo) return;
    setCargando(true);
    setError(null);
    fetch(`/api/cuadratura/${encodeURIComponent(rut)}/${periodo}`)
      .then((r) => (r.ok ? r.json() : r.json().then((e) => Promise.reject(new Error(e.error)))))
      .then(setDatos)
      .catch((e) => setError(e.message))
      .finally(() => setCargando(false));
  }, [rut, periodo]);

  const empresa = empresas.find((e) => e.rut === rut);
  const nAlertas = datos?.alertas.filter((a) => a.nivel !== 'baja').length ?? 0;

  const irADocumentos = (filtro) => {
    setFiltroInicial({ ...filtro, _t: Date.now() });
    setVista('documentos');
  };

  return (
    <>
      <nav className="navbar navbar-dark barra">
        <div className="container-xl gap-2 flex-wrap">
          <span className="navbar-brand mb-0">Cuadratura SII</span>
          <div className="d-flex gap-2 flex-wrap flex-grow-1 justify-content-end">
            <select className="form-select form-select-sm w-auto" value={rut} aria-label="Razón social"
              onChange={(e) => {
                const emp = empresas.find((x) => x.rut === e.target.value);
                setRut(e.target.value);
                setPeriodo(emp?.periodos[0] || '');
              }}>
              {empresas.map((e) => (
                <option key={e.rut} value={e.rut}>{e.razonSocial} · {e.rut}</option>
              ))}
            </select>
            <select className="form-select form-select-sm w-auto" value={periodo} aria-label="Periodo"
              onChange={(e) => setPeriodo(e.target.value)}>
              {empresa?.periodos.map((p) => <option key={p} value={p}>{nombrePeriodo(p)}</option>)}
            </select>
          </div>
        </div>
      </nav>

      {empresa?.esDemo && (
        <div className="aviso-demo py-2">
          <div className="container-xl">
            <strong>Datos de ejemplo.</strong> Esta empresa es ficticia y sirve para ver el funcionamiento del portal
            mientras se conectan los datos reales de Sisgen y del SII.
          </div>
        </div>
      )}

      <main className="container-xl py-4">
        {empresa && (
          <div className="mb-3">
            <h1 className="h4 mb-0">{empresa.razonSocial}</h1>
            <div className="text-secondary small">
              RUT {empresa.rut} · {empresa.sucursales.length} sucursales · {periodo && nombrePeriodo(periodo)}
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
      </main>
    </>
  );
}
