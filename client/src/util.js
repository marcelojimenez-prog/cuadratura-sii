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

/**
 * Llamada a la API con la sesión del navegador (cookie). Si la sesión venció, avisa a la app
 * con el evento 'sesion-expirada' para volver a la pantalla de ingreso.
 */
export async function api(url, { metodo = 'GET', cuerpo } = {}) {
  const r = await fetch(url, {
    method: metodo,
    credentials: 'same-origin',
    headers: cuerpo ? { 'Content-Type': 'application/json' } : undefined,
    body: cuerpo ? JSON.stringify(cuerpo) : undefined,
  });
  const datos = await r.json().catch(() => ({}));
  if (r.status === 401 && !url.startsWith('/api/auth/')) window.dispatchEvent(new Event('sesion-expirada'));
  if (!r.ok) throw Object.assign(new Error(datos.error || `Error ${r.status}`), { status: r.status, datos });
  return datos;
}

/** "hace 5 min", "hace 3 días"… para fechas UTC de la base ('YYYY-MM-DD HH:MM:SS'). */
export function haceCuanto(utc, ahora = Date.now()) {
  if (!utc) return 'nunca';
  const ms = ahora - Date.parse(utc.replace(' ', 'T') + 'Z');
  const min = Math.max(0, Math.round(ms / 60000));
  if (min < 1) return 'recién';
  if (min < 60) return `hace ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `hace ${h} h`;
  const d = Math.round(h / 24);
  return `hace ${d} ${d === 1 ? 'día' : 'días'}`;
}

/** Estados de un cliente o razón social en el mes (para tabla y ficha). */
export const ESTADO_CLIENTE = {
  urgente: { texto: 'Alertas urgentes', color: 'danger' },
  revisar: { texto: 'Por revisar', color: 'warning' },
  sinSii: { texto: 'Sin consultar SII', color: 'secondary' },
  sinDatos: { texto: 'Sin datos', color: 'light' },
  ok: { texto: 'Todo cuadra', color: 'success' },
};
export const GRAVEDAD = { urgente: 0, revisar: 1, sinSii: 2, sinDatos: 3, ok: 4 };
export const numeroRut = (rut) => Number(String(rut ?? '').split('-')[0].replace(/\D/g, '')) || 0;
export const formatoRut = (rut) => {
  if (!rut) return '—';
  const [n, dv] = rut.split('-');
  return `${Number(n).toLocaleString('es-CL')}-${dv}`;
};
