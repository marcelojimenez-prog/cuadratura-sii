import { useEffect, useRef, useState } from 'react';
import { nombrePeriodo } from '../util.js';

const MESES = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];

/**
 * Selector de mes tipo calendario: año con flechas y los 12 meses. Solo se pueden elegir los meses
 * que tienen datos (`periodos`, YYYY-MM). Con `permitirUltimo`, valor '' = "Último mes disponible".
 */
export default function SelectorMes({ valor, periodos = [], alCambiar, permitirUltimo = false }) {
  const disponibles = new Set(periodos);
  const ordenados = [...disponibles].sort();
  const referencia = valor || ordenados.at(-1) || new Date().toISOString().slice(0, 7);
  const [abierto, setAbierto] = useState(false);
  const [anio, setAnio] = useState(Number(referencia.slice(0, 4)));
  const ref = useRef(null);

  useEffect(() => { if (abierto) setAnio(Number(referencia.slice(0, 4))); }, [abierto]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!abierto) return;
    const cerrar = (e) => { if (!ref.current?.contains(e.target)) setAbierto(false); };
    const esc = (e) => { if (e.key === 'Escape') setAbierto(false); };
    document.addEventListener('mousedown', cerrar);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', cerrar); document.removeEventListener('keydown', esc); };
  }, [abierto]);

  const anioMin = ordenados.length ? Number(ordenados[0].slice(0, 4)) : anio;
  const anioMax = ordenados.length ? Number(ordenados.at(-1).slice(0, 4)) : anio;
  const elegir = (p) => { alCambiar(p); setAbierto(false); };
  const etiqueta = valor ? nombrePeriodo(valor) : permitirUltimo ? 'Último mes disponible' : '—';

  return (
    <div className="position-relative selector-mes" ref={ref}>
      <button type="button" className="form-select form-select-sm text-start selector-mes-boton" aria-haspopup="dialog" aria-expanded={abierto}
        aria-label={`Periodo: ${etiqueta}`} onClick={() => setAbierto(!abierto)}>
        <span className="selector-mes-icono" aria-hidden="true">▦</span>{etiqueta}
      </button>
      {abierto && (
        <div className="selector-mes-panel" role="dialog" aria-label="Elegir mes">
          <div className="d-flex justify-content-between align-items-center mb-2">
            <button type="button" className="btn btn-sm btn-light" aria-label="Año anterior" disabled={anio <= anioMin} onClick={() => setAnio(anio - 1)}>‹</button>
            <strong>{anio}</strong>
            <button type="button" className="btn btn-sm btn-light" aria-label="Año siguiente" disabled={anio >= anioMax} onClick={() => setAnio(anio + 1)}>›</button>
          </div>
          <div className="selector-mes-grilla">
            {MESES.map((m, i) => {
              const p = `${anio}-${String(i + 1).padStart(2, '0')}`;
              const hay = disponibles.has(p);
              return (
                <button key={p} type="button" disabled={!hay} onClick={() => elegir(p)}
                  className={`selector-mes-celda ${p === valor ? 'activo' : ''} ${hay ? 'con-datos' : ''}`}
                  title={hay ? nombrePeriodo(p) : `${nombrePeriodo(p)}: sin datos`}>
                  {m}
                </button>
              );
            })}
          </div>
          {permitirUltimo && (
            <button type="button" className={`btn btn-sm w-100 mt-2 ${valor ? 'btn-outline-secondary' : 'btn-primary boton-marca'}`} onClick={() => elegir('')}>
              Último mes disponible
            </button>
          )}
        </div>
      )}
    </div>
  );
}
