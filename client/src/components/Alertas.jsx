import { useMemo, useState } from 'react';
import { numero, pesos } from '../util.js';
import { urlDocumentoEnBlanco } from './DocumentoEnBlanco.jsx';

// Sigla del documento como en Sisgen
const SIGLA = { 33: 'FE', 34: 'FX', 39: 'BE', 41: 'BX', 52: 'GE', 56: 'DE', 61: 'NE', 110: 'FEX' };

/** Qué pasa, en pocas palabras. */
export function fraseAlerta(a) {
  if (a.folioVencido) return a.codigo === 'SALTO_FOLIO' ? 'Folios vencidos: anular en el SII' : 'CAF vencido: anular en el SII';
  switch (a.codigo) {
    case 'FALTA_EN_SII': return a.republicar ? 'No llegó al SII: republicar' : 'No llegó al SII';
    case 'RECHAZADO': return 'Rechazado por el SII';
    case 'MONTO_DISTINTO': return 'Monto distinto al del SII';
    case 'REPARO': return 'Aceptado con reparos';
    case 'SOLO_EN_SII': return 'Está en el SII, no en Sisgen';
    case 'ANULADO': return 'Anulado en el SII';
    case 'DOCUMENTO_EN_BLANCO': return 'Documento en blanco';
    case 'SIN_XML': return a.republicar ? 'Sin XML: republicar' : 'Sin XML: no se envió';
    case 'FOLIO_DUPLICADO': return 'Folio usado dos veces';
    case 'FOLIO_DE_OTRA_SUCURSAL': return 'Folio de otra sucursal';
    case 'FOLIO_SIN_CAF': return 'Folio sin CAF';
    case 'SALTO_FOLIO': return 'Folios sin emitir';
    case 'FOLIO_OTRO_MES': return 'Emitidos en otro mes';
    case 'FOLIOS_FUERA_DE_SISGEN': return 'Emitidos fuera de Sisgen';
    case 'FOLIOS_POR_VENCER': return `Folios por vencer (${numero(a.sinUsar)} sin usar)`;
    case 'FOLIOS_VENCIDOS': return `Folios vencidos sin usar (${numero(a.sinUsar)})`;
    default: return a.titulo;
  }
}

/** "BE N° 430.771", "BE N° 1.000 al 1.020" o "BE · total del mes". */
export function documentoAlerta(a) {
  const s = SIGLA[a.tipoSii] ?? a.tipoNombre ?? '';
  if (a.folio == null) return `${s} · total del mes`;
  return a.folioHasta ? `${s} N° ${numero(a.folio)} al ${numero(a.folioHasta)}` : `${s} N° ${numero(a.folio)}`;
}

const NIVELES = { alta: 'Urgentes', media: 'Por revisar', baja: 'Informativas' };

export default function Alertas({ alertas, irADocumentos, rut }) {
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

  const verDocumento = (a) => a.folio != null && !a.folioHasta && !['SALTO_FOLIO', 'FOLIO_OTRO_MES', 'FOLIOS_FUERA_DE_SISGEN'].includes(a.codigo);

  return (
    <div className="card tarjeta">
      <div className="card-header d-flex flex-wrap gap-2 align-items-center">
        <span className="me-auto fw-semibold">{visibles.length} alertas</span>
        <select className="form-select form-select-sm w-auto" value={nivel} onChange={(e) => setNivel(e.target.value)} aria-label="Nivel">
          <option value="">Todas</option>
          {Object.entries(NIVELES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        {sucursales.length > 1 && (
          <select className="form-select form-select-sm w-auto" value={sucursal} onChange={(e) => setSucursal(e.target.value)} aria-label="Sucursal">
            <option value="">Todas las sucursales</option>
            {sucursales.map((s) => <option key={s}>{s}</option>)}
          </select>
        )}
      </div>
      <div className="table-responsive">
        <table className="table table-sm table-hover align-middle mb-0 tabla-alertas">
          <thead>
            <tr><th aria-label="Nivel" /><th>Documento</th><th className="text-end">Monto</th><th>Sucursal</th><th>Qué pasa</th><th aria-label="Acciones" /></tr>
          </thead>
          <tbody>
            {visibles.map((a, i) => (
              <tr key={i}>
                <td><span className={`punto-nivel nivel-${a.nivel}`} title={NIVELES[a.nivel]} /></td>
                <td className="fw-semibold text-nowrap">{documentoAlerta(a)}</td>
                <td className="text-end tabla-num text-nowrap">{a.monto != null ? pesos(a.monto) : ''}</td>
                <td className="small text-secondary">{a.sucursal ?? '—'}</td>
                <td className={a.nivel === 'alta' ? 'text-danger' : ''} title={a.motivo ?? ''}>
                  {fraseAlerta(a)}
                  {a.respaldo?.encontrado && (
                    <div className="small">
                      <a href={urlDocumentoEnBlanco(rut, a.respaldo.tipoSisgen, a.folio)} target="_blank" rel="noopener">Ver qué llevaba ↗</a>
                    </div>
                  )}
                  {a.respaldo && !a.respaldo.encontrado && !a.republicar && (
                    <div className="small fw-semibold">Detalle no encontrado en ninguna tabla: eliminar</div>
                  )}
                </td>
                <td className="text-end">
                  {verDocumento(a) && (
                    <button className="btn btn-link btn-sm p-0" onClick={() => irADocumentos({ buscar: String(a.folio), tipo: String(a.tipoSii) })}>Ver</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
