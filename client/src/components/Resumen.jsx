import { pesos, numero, ESTADO_INFO, NIVEL_INFO } from '../util.js';

function Kpi({ etiqueta, valor, detalle, color }) {
  return (
    <div className="col-6 col-lg">
      <div className="card kpi h-100">
        <div className="card-body">
          <div className="etiqueta">{etiqueta}</div>
          <div className={`valor ${color ? 'text-' + color : ''}`}>{valor}</div>
          {detalle && <div className="small text-secondary">{detalle}</div>}
        </div>
      </div>
    </div>
  );
}

const ESTADO_CUADRE = {
  CUADRA: { texto: 'Cuadra', color: 'success' },
  CUADRA_SIN_FALTANTES: { texto: 'Cuadra sin los faltantes', color: 'warning' },
  DIFERENCIA: { texto: 'Diferencia', color: 'danger' },
  SOLO_SII: { texto: 'Solo en el SII', color: 'info' },
};

function CuadreSii({ filas, consultadoEn }) {
  return (
    <div className="card tarjeta mb-4">
      <div className="card-header d-flex justify-content-between flex-wrap gap-2">
        <span>Sisgen vs Registro de Ventas del SII</span>
        {consultadoEn && <span className="small text-secondary fw-normal">Consultado al SII: {consultadoEn}</span>}
      </div>
      <div className="table-responsive">
        <table className="table mb-0 align-middle">
          <thead className="table-light">
            <tr>
              <th>Tipo</th>
              <th className="tabla-num">Sisgen</th><th className="tabla-num">Monto Sisgen</th>
              <th className="tabla-num">SII</th><th className="tabla-num">Monto SII</th>
              <th className="tabla-num">Diferencia</th><th>Resultado</th>
            </tr>
          </thead>
          <tbody>
            {filas.map((f) => {
              const dif = (f.sisgenMonto ?? 0) - (f.siiMonto ?? 0);
              const e = ESTADO_CUADRE[f.estado] ?? { texto: f.estado, color: 'secondary' };
              return (
                <tr key={f.tipoSii}>
                  <td>{f.tipoNombre} <span className="text-secondary small">({f.tipoSii}{f.modo === 'resumen' ? ', resumen' : ''})</span></td>
                  <td className="tabla-num">{numero(f.sisgenDocs)}</td>
                  <td className="tabla-num">{pesos(f.sisgenMonto)}</td>
                  <td className="tabla-num">{numero(f.siiDocs)}</td>
                  <td className="tabla-num">{pesos(f.siiMonto)}</td>
                  <td className={`tabla-num ${dif ? 'text-danger' : 'text-secondary'}`}>
                    {f.sisgenDocs - f.siiDocs !== 0 && <>{f.sisgenDocs - f.siiDocs > 0 ? '+' : ''}{f.sisgenDocs - f.siiDocs} docs · </>}{pesos(dif)}
                  </td>
                  <td><span className={`badge text-bg-${e.color}`}>{e.texto}</span></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function Resumen({ datos, irAAlertas, irADocumentos }) {
  const { resumen, alertas } = datos;
  const e = resumen.porEstado;
  const problemas = e.FALTA_EN_SII + e.RECHAZADO + e.REPARO + e.MONTO_DISTINTO + e.SOLO_EN_SII;
  const verificados = resumen.documentos - e.SIN_VERIFICAR;
  // Se trunca (no redondea): nunca mostrar 100% si queda algún documento sin cuadrar
  const pctOk = verificados ? Math.floor((e.OK / verificados) * 1000) / 10 : 0;
  const urgentes = alertas.filter((a) => a.nivel === 'alta');

  return (
    <>
      <div className="row g-3 mb-4">
        <Kpi etiqueta="Total vendido" valor={pesos(resumen.montoTotal)} detalle="Neto de notas de crédito" />
        <Kpi etiqueta="Documentos" valor={numero(resumen.documentos)} detalle={`${resumen.porTipo.length} tipos`} />
        <Kpi etiqueta="Cuadrados con SII" valor={`${pctOk}%`} detalle={`${numero(e.OK)} de ${numero(verificados)}`} color="success" />
        <Kpi etiqueta="Con problemas" valor={numero(problemas)} color={problemas ? 'danger' : 'success'}
          detalle={`${e.FALTA_EN_SII} faltan · ${e.RECHAZADO} rechazados`} />
        {resumen.enBlanco > 0 && (
          <Kpi etiqueta="Documentos en blanco" valor={numero(resumen.enBlanco)} color="danger" detalle="No quedaron completos en Sisgen" />
        )}
        {resumen.sinXml > 0 && (
          <Kpi etiqueta="Sin XML generado" valor={numero(resumen.sinXml)} color="danger" detalle="Probablemente no enviados al SII" />
        )}
        {e.SIN_VERIFICAR > 0 && <Kpi etiqueta="Sin verificar" valor={numero(e.SIN_VERIFICAR)} detalle="Aún no consultados al SII" />}
      </div>

      {urgentes.length > 0 && (
        <div className="card tarjeta mb-4 border-start border-danger border-4">
          <div className="card-header d-flex justify-content-between align-items-center">
            <span>Requiere acción ({urgentes.length})</span>
            <button className="btn btn-sm btn-outline-primary" onClick={irAAlertas}>Ver todas las alertas</button>
          </div>
          <ul className="list-group list-group-flush">
            {urgentes.slice(0, 5).map((a, i) => (
              <li key={i} className="list-group-item d-flex justify-content-between gap-2 flex-wrap">
                <span>
                  <span className={`text-${NIVEL_INFO[a.nivel].color} me-2`}>●</span>
                  <strong>{a.tipoNombre} {a.folio == null ? '(total del mes)' : a.folioHasta ? `folios ${numero(a.folio)} al ${numero(a.folioHasta)}` : numero(a.folio)}</strong> — {a.titulo}
                  {a.motivo && <span className="text-secondary">: {a.motivo}</span>}
                  {a.adicionales?.map((t) => <span key={t} className="badge text-bg-light ms-2">{t}</span>)}
                </span>
                <span className="text-secondary small">{a.sucursal ?? 'Sin sucursal'}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {datos.cuadreTipos?.length > 0 && <CuadreSii filas={datos.cuadreTipos} consultadoEn={datos.siiConsultadoEn} />}

      <div className="row g-4">
        <div className="col-lg-7">
          <div className="card tarjeta h-100">
            <div className="card-header">Ventas por sucursal</div>
            <div className="table-responsive">
              <table className="table table-hover mb-0 align-middle">
                <thead className="table-light">
                  <tr><th>Sucursal</th><th className="tabla-num">Docs</th><th className="tabla-num">Monto</th><th style={{ width: '30%' }}>Estado SII</th></tr>
                </thead>
                <tbody>
                  {resumen.porSucursal.map((s) => {
                    const pOk = (s.ok / s.documentos) * 100;
                    const pProb = (s.problemas / s.documentos) * 100;
                    return (
                      <tr key={s.sucursal} className="fila-click" onClick={() => irADocumentos({ sucursal: s.sucursal })}>
                        <td>{s.sucursal}</td>
                        <td className="tabla-num">{numero(s.documentos)}</td>
                        <td className="tabla-num">{pesos(s.monto)}</td>
                        <td>
                          <div className="progress barra-estado" role="progressbar" aria-label={`${s.ok} OK, ${s.problemas} con problemas`}>
                            <div className="progress-bar bg-success" style={{ width: pOk + '%' }} />
                            <div className="progress-bar bg-danger" style={{ width: pProb + '%' }} />
                          </div>
                          <div className="small text-secondary mt-1">
                            {s.problemas > 0 ? <span className="text-danger">{s.problemas} con problemas</span> : 'Todo cuadrado'}
                            {s.enBlanco > 0 && <span className="text-danger"> · {s.enBlanco} en blanco</span>}
                            {s.sinXml > 0 && <span className="text-danger"> · {s.sinXml} sin XML</span>}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <div className="col-lg-5">
          <div className="card tarjeta mb-4">
            <div className="card-header">Por tipo de documento</div>
            <table className="table mb-0">
              <tbody>
                {resumen.porTipo.map((t) => (
                  <tr key={t.tipoSii} className="fila-click" onClick={() => irADocumentos({ tipo: String(t.tipoSii) })}>
                    <td>{t.tipoNombre} <span className="text-secondary small">({t.tipoSii})</span></td>
                    <td className="tabla-num">{numero(t.documentos)}</td>
                    <td className="tabla-num">{pesos(t.monto)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="card tarjeta">
            <div className="card-header">Estado frente al SII</div>
            <ul className="list-group list-group-flush">
              {Object.entries(e).filter(([, n]) => n > 0).map(([est, n]) => (
                <li key={est} className="list-group-item d-flex justify-content-between fila-click"
                  onClick={() => irADocumentos({ estado: est })}>
                  <span><span className={`badge text-bg-${ESTADO_INFO[est].color} me-2`}>&nbsp;</span>{ESTADO_INFO[est].texto}</span>
                  <span className="tabla-num">{numero(n)}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </>
  );
}
