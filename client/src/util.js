export const pesos = (n) => (n == null ? '—' : '$' + Math.round(n).toLocaleString('es-CL'));
export const numero = (n) => (n ?? 0).toLocaleString('es-CL');

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
export const nombrePeriodo = (p) => {
  const [a, m] = p.split('-');
  const t = `${MESES[Number(m) - 1]} ${a}`;
  return t[0].toUpperCase() + t.slice(1);
};
export const fecha = (f) => (f ? f.split('-').reverse().join('-') : '—');

export const ESTADO_INFO = {
  OK: { texto: 'OK en SII', color: 'success' },
  FALTA_EN_SII: { texto: 'No está en SII', color: 'danger' },
  RECHAZADO: { texto: 'Rechazado', color: 'danger' },
  REPARO: { texto: 'Con reparos', color: 'warning' },
  MONTO_DISTINTO: { texto: 'Monto distinto', color: 'warning' },
  SOLO_EN_SII: { texto: 'Solo en SII', color: 'info' },
  ANULADO: { texto: 'Anulado', color: 'secondary' },
  SIN_VERIFICAR: { texto: 'Sin verificar', color: 'light' },
};

export const NIVEL_INFO = {
  alta: { texto: 'Urgente', color: 'danger', icono: '●' },
  media: { texto: 'Revisar', color: 'warning', icono: '●' },
  baja: { texto: 'Informativo', color: 'secondary', icono: '●' },
};

export function descargarCsv(nombre, filas, columnas) {
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [columnas.map((c) => c.titulo).join(';'), ...filas.map((f) => columnas.map((c) => esc(c.valor(f))).join(';'))].join('\r\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = nombre;
  a.click();
  URL.revokeObjectURL(a.href);
}
