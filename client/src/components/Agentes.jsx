import { useEffect, useState } from 'react';
import { api, haceCuanto, formatoRut } from '../util.js';

/** Todos los agentes instalados en los servidores de los clientes y su estado. */
export default function Agentes({ abrirCliente }) {
  const [lista, setLista] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    const cargar = () => api('/api/admin/agentes').then(setLista).catch((e) => setError(e.message));
    cargar();
    const t = setInterval(cargar, 30000);
    return () => clearInterval(t);
  }, []);

  const enLinea = (a) => a.activo && a.ultimoContacto && Date.now() - Date.parse(a.ultimoContacto.replace(' ', 'T') + 'Z') < 5 * 60000;
  // Agente en línea hace más de 2 horas que no ha enviado las ventas del mes en curso: suele ser una
  // carpeta de Sisgen equivocada (un respaldo antiguo) o una tabla F1 del mes que no existe
  const mesActual = new Date().toISOString().slice(0, 7);
  const sinVentasDelMes = (a) => enLinea(a) && a.creadoEn && Date.now() - Date.parse(a.creadoEn.replace(' ', 'T') + 'Z') > 2 * 3600000
    && (!a.ventasMes || a.ventasMes < mesActual);

  return (
    <>
      <h1 className="h4 mb-1">Agentes instalados</h1>
      <div className="text-secondary small mb-3">
        Servicio de Windows en el servidor de cada cliente: envía las ventas al portal y consulta al SII con el certificado del cliente.
        Para instalar uno nuevo: Clientes → ficha del cliente → "Instalar agente en un servidor nuevo".
      </div>
      {error && <div className="alert alert-danger">{error}</div>}
      {!lista && !error && <div className="text-secondary">Cargando…</div>}
      {lista && lista.length === 0 && <div className="alert alert-info">Aún no hay agentes instalados.</div>}
      {lista && lista.length > 0 && (
        <div className="card tarjeta">
          <div className="table-responsive">
            <table className="table table-sm align-middle mb-0">
              <thead>
                <tr><th>Cliente / razón social</th><th>Sucursal</th><th>Estado</th><th>Certificado SII</th><th>Historial de XML</th><th>Equipo</th></tr>
              </thead>
              <tbody>
                {lista.map((a) => (
                  <tr key={a.id}>
                    <td>
                      {a.clienteId
                        ? <button type="button" className="btn btn-link p-0 text-start fw-semibold text-decoration-none" onClick={() => abrirCliente(a.clienteId)}>{a.cliente}</button>
                        : <span className="fw-semibold">{a.cliente ?? '—'}</span>}
                      <div className="small text-secondary">{a.razonSocial ?? 'Aún no se conecta'}{a.rut && ` · ${formatoRut(a.rut)}`}</div>
                    </td>
                    <td>{a.sucursal ?? '—'}</td>
                    <td>
                      {!a.activo ? <span className="badge text-bg-secondary">Desactivado</span>
                        : !a.ultimoContacto ? <span className="badge text-bg-warning">Sin conectar</span>
                        : enLinea(a) ? <span className="badge text-bg-success">En línea</span>
                        : <span className="badge text-bg-danger">Sin conexión {haceCuanto(a.ultimoContacto)}</span>}
                      {a.error && <div className="small text-danger" title={a.error}>{a.error.slice(0, 60)}</div>}
                      {sinVentasDelMes(a) && (
                        <div className="small text-danger fw-semibold"
                          title={`Último mes de ventas recibido: ${a.ventasMes ?? 'ninguno'}. Probablemente el agente lee una carpeta de Sisgen equivocada (p. ej. un respaldo): revisa "sisgen=" en agente.ini.`}>
                          No envía ventas del mes actual{a.ventasMes ? ` (último: ${a.ventasMes})` : ''}: revisar carpeta de Sisgen
                        </div>
                      )}
                    </td>
                    <td className="small">
                      {a.certificado
                        ? (a.certificado.startsWith('ok') ? <span className="text-success">✓ {a.certificado.slice(4)}</span> : <span className="text-danger">{a.certificado}</span>)
                        : <span className="text-secondary">—</span>}
                    </td>
                    <td className="small">{a.historial === 'terminado' ? 'Completo' : a.historial ?? '—'}</td>
                    <td className="small text-secondary">{a.equipo ?? '—'}{a.version && <div>v{a.version}</div>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}
