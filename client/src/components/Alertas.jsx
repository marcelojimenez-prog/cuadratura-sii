import { useMemo, useState } from 'react';
import { numero, pesos, NIVEL_INFO } from '../util.js';

export default function Alertas({ alertas, irADocumentos }) {
  const [sucursal, setSucursal] = useState('');
  const [nivel, setNivel] = useState('');

  const sucursales = useMemo(
    () => [...new Set(alertas.flatMap((a) => (a.sucursal ? a.sucursal.split(', ') : [])))].sort(),
    [alertas]
  );
  const visibles = alertas.filter(
    (a) => (!nivel || a.nivel === nivel) && (!sucursal || (a.sucursal ?? '').split(', ').includes(sucursal))
  );

  if (!alertas.length) {
    return <div className="alert alert-success">Sin alertas: todos los documentos del periodo cuadran con el SII.</div>;
  }

  return (
    <div className="card tarjeta">
      <div className="card-header d-flex flex-wrap gap-2 align-items-center">
        <span className="me-auto">{visibles.length} alertas</span>
        <select className="form-select form-select-sm w-auto" value={nivel} onChange={(e) => setNivel(e.target.value)} aria-label="Nivel">
          <option value="">Todos los niveles</option>
          {Object.entries(NIVEL_INFO).map(([k, v]) => <option key={k} value={k}>{v.texto}</option>)}
        </select>
        <select className="form-select form-select-sm w-auto" value={sucursal} onChange={(e) => setSucursal(e.target.value)} aria-label="Sucursal">
          <option value="">Todas las sucursales</option>
          {sucursales.map((s) => <option key={s}>{s}</option>)}
        </select>
      </div>
      <ul className="list-group list-group-flush">
        {visibles.map((a, i) => (
          <li key={i} className={`list-group-item alerta-item nivel-${a.nivel}`}>
            <div className="d-flex justify-content-between flex-wrap gap-2">
              <div>
                <span className={`badge text-bg-${NIVEL_INFO[a.nivel].color} me-2`}>{NIVEL_INFO[a.nivel].texto}</span>
                <strong>{a.titulo}</strong>
                {a.adicionales?.map((t) => <span key={t} className="badge text-bg-light ms-2">{t}</span>)}
              </div>
              <span className="small text-secondary">{a.sucursal ?? 'No registrado en ninguna sucursal'}</span>
            </div>
            <div className="mt-1">
              {a.tipoNombre}{' '}
              {a.folio == null ? <>(total del mes)</>
                : a.folioHasta ? <>folios {numero(a.folio)} al {numero(a.folioHasta)}</> : <>folio <strong>{numero(a.folio)}</strong></>}
              {a.monto != null && <span className="text-secondary"> · {pesos(a.monto)}</span>}
            </div>
            {a.motivo && <div className="small text-secondary">{a.motivo}</div>}
            {a.folio != null && !['SALTO_FOLIO', 'FOLIO_OTRO_MES', 'FOLIOS_FUERA_DE_SISGEN'].includes(a.codigo) && (
              <button className="btn btn-link btn-sm p-0 mt-1" onClick={() => irADocumentos({ buscar: String(a.folio), tipo: String(a.tipoSii) })}>
                Ver documento
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
