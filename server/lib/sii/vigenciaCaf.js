// Vigencia de los folios (CAF). Los CAF de factura electrónica (33), nota de débito (56) y nota de
// crédito (61) vencen 180 días después de su autorización (<FA>); los de boletas y guías no vencen.
//  - Define cuántos meses hacia atrás se cuadra cada razón social: desde la autorización del rango
//    vigente más antiguo (así se revisan todos los folios de los rangos en uso).
//  - Avisa cuando un rango está por vencer (o venció) con folios sin usar.

export const TIPOS_CON_VENCIMIENTO = new Set([33, 56, 61]);
export const DIAS_VIGENCIA = 180;
const DIAS_AVISO = 30;
const MAX_MESES = 7;

const DIA = 86400000;
const aFecha = (s) => new Date(`${s}T00:00:00`);
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const periodo = (d) => iso(d).slice(0, 7);

/** Fecha de vencimiento (YYYY-MM-DD) de un CAF, o null si su tipo no vence o no se conoce la autorización. */
export function vencimientoCaf(tipoSii, fechaAutorizacion) {
  if (!TIPOS_CON_VENCIMIENTO.has(Number(tipoSii)) || !/^\d{4}-\d{2}-\d{2}$/.test(fechaAutorizacion ?? '')) return null;
  // Aritmética en UTC: los cambios de horario no deben correr la fecha un día
  const [a, m, d] = fechaAutorizacion.split('-').map(Number);
  return new Date(Date.UTC(a, m - 1, d + DIAS_VIGENCIA)).toISOString().slice(0, 10);
}

/**
 * Meses a cuadrar (YYYY-MM, del más antiguo al actual): desde la autorización del CAF vigente más
 * antiguo de los tipos que vencen. Mínimo el mes anterior y el actual; máximo 7 meses.
 * @param {Array<{ tipo_sii, fecha_autorizacion }>} cafs
 */
export function mesesACuadrar(cafs, hoy = new Date()) {
  const hoyIso = iso(hoy);
  const vigentes = cafs
    .filter((c) => { const v = vencimientoCaf(c.tipo_sii, c.fecha_autorizacion); return v && v >= hoyIso; })
    .map((c) => c.fecha_autorizacion)
    .sort();
  const inicioMin = new Date(hoy.getFullYear(), hoy.getMonth() - 1, 1);
  const inicioMax = new Date(hoy.getFullYear(), hoy.getMonth() - (MAX_MESES - 1), 1);
  let inicio = vigentes.length ? aFecha(vigentes[0]) : inicioMin;
  inicio = new Date(inicio.getFullYear(), inicio.getMonth(), 1);
  if (inicio > inicioMin) inicio = inicioMin;
  if (inicio < inicioMax) inicio = inicioMax;
  const meses = [];
  for (let d = inicio; d <= hoy; d = new Date(d.getFullYear(), d.getMonth() + 1, 1)) meses.push(periodo(d));
  return meses;
}

/**
 * Documentos de factura/nota que el SII no recibió (o folios que quedaron sin emitir) cuyo CAF ya
 * venció: ya no se pueden enviar, hay que anular el folio en el SII. Ajusta esas alertas (no crea nuevas).
 */
export function marcarFoliosVencidos(alertas, cafs, hoy = new Date()) {
  const hoyIso = iso(hoy);
  for (const a of alertas) {
    if (!TIPOS_CON_VENCIMIENTO.has(Number(a.tipoSii)) || a.folio == null) continue;
    if (a.codigo !== 'FALTA_EN_SII' && a.codigo !== 'SALTO_FOLIO') continue;
    const caf = cafs.find((c) => Number(c.tipo_sii) === Number(a.tipoSii) && c.desde <= a.folio && a.folio <= c.hasta);
    const vence = caf && vencimientoCaf(caf.tipo_sii, caf.fecha_autorizacion);
    if (!vence || vence >= hoyIso) continue;
    const fechaCl = vence.split('-').reverse().join('-');
    a.folioVencido = true;
    a.venceCaf = vence;
    if (a.codigo === 'FALTA_EN_SII') {
      a.titulo = 'Folio vencido: anular en el SII';
      a.motivo = `${a.motivo ? `${a.motivo}. ` : ''}El CAF de este folio venció el ${fechaCl}: ya no se puede enviar al SII; hay que anular el folio en el SII.`;
    } else {
      a.titulo = 'Folios vencidos sin emitir: anular en el SII';
      a.motivo = `${a.motivo}. El CAF venció el ${fechaCl}: estos folios ya no se pueden usar; hay que anularlos en el SII.`;
    }
  }
  return alertas;
}

/** Marca en cada documento no recibido por el SII si su CAF (33, 56, 61) ya venció: `cafVencido`. */
export function marcarDocumentosVencidos(documentos, cafs, hoy = new Date()) {
  const hoyIso = iso(hoy);
  for (const d of documentos) {
    if (!TIPOS_CON_VENCIMIENTO.has(Number(d.tipoSii)) || d.estado !== 'FALTA_EN_SII') continue;
    const caf = cafs.find((c) => Number(c.tipo_sii) === Number(d.tipoSii) && c.desde <= d.folio && d.folio <= c.hasta);
    const vence = caf && vencimientoCaf(caf.tipo_sii, caf.fecha_autorizacion);
    if (vence && vence < hoyIso) { d.cafVencido = true; d.venceCaf = vence; }
  }
  return documentos;
}

/**
 * Alertas de folios por vencer o vencidos sin usar.
 * @param {Array<{ tipo_sii, desde, hasta, fecha_autorizacion, sucursal }>} cafs
 * @param {(tipo, desde, hasta) => number|null} ultimoUsado folio más alto emitido dentro del rango
 */
export function alertasVencimiento(cafs, ultimoUsado, nombres = {}, hoy = new Date()) {
  const alertas = [];
  const hoyMs = aFecha(iso(hoy)).getTime();
  for (const c of cafs) {
    const vence = vencimientoCaf(c.tipo_sii, c.fecha_autorizacion);
    if (!vence) continue;
    const dias = Math.round((aFecha(vence).getTime() - hoyMs) / DIA);
    if (dias > DIAS_AVISO || dias < -DIAS_AVISO) continue;
    const ultimo = ultimoUsado(c.tipo_sii, c.desde, c.hasta);
    const sinUsar = c.hasta - Math.max(c.desde - 1, ultimo ?? 0);
    if (sinUsar <= 0) continue;
    const fmt = (n) => Number(n).toLocaleString('es-CL');
    const fechaCl = vence.split('-').reverse().join('-');
    const nombre = nombres[c.tipo_sii] ?? `Tipo ${c.tipo_sii}`;
    alertas.push(dias >= 0
      ? {
        nivel: 'media', codigo: 'FOLIOS_POR_VENCER', titulo: 'Folios por vencer',
        tipoSii: c.tipo_sii, tipoNombre: nombre, sucursal: c.sucursal, vence, diasRestantes: dias, sinUsar,
        motivo: `${nombre}: el rango ${fmt(c.desde)} al ${fmt(c.hasta)} vence el ${fechaCl} (${dias === 0 ? 'hoy' : `en ${dias} días`}) ` +
          `y quedan ${fmt(sinUsar)} folios sin usar. Conviene pedir folios nuevos.`,
      }
      : {
        nivel: 'baja', codigo: 'FOLIOS_VENCIDOS', titulo: 'Folios vencidos sin usar',
        tipoSii: c.tipo_sii, tipoNombre: nombre, sucursal: c.sucursal, vence, sinUsar,
        motivo: `${nombre}: el rango ${fmt(c.desde)} al ${fmt(c.hasta)} venció el ${fechaCl} con ${fmt(sinUsar)} folios sin usar.`,
      });
  }
  return alertas;
}
