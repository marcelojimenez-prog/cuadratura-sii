// Motor de cuadratura: cruza lo emitido en Sisgen con lo registrado en el SII.
import { NOMBRES_SII, TIPOS_A_CUADRAR } from '../sisgen/tipos.js';

export const ESTADOS = {
  OK: 'OK',
  FALTA_EN_SII: 'FALTA_EN_SII',
  RECHAZADO: 'RECHAZADO',
  REPARO: 'REPARO',
  MONTO_DISTINTO: 'MONTO_DISTINTO',
  ANULADO: 'ANULADO',
  SOLO_EN_SII: 'SOLO_EN_SII',
  SIN_VERIFICAR: 'SIN_VERIFICAR', // aún no se consultó al SII ese tipo de documento
};

const TOLERANCIA_MONTO = 1; // pesos (redondeos)
const SALTO_MAXIMO_REPORTADO = 500; // saltos mayores suelen ser rangos CAF distintos por sucursal

const clave = (tipo, folio) => `${tipo}-${folio}`;

/**
 * @param {Array} docsSisgen filas de docs_sisgen (con `sucursal`)
 * @param {Array} docsSii    filas de docs_sii
 * @param {{ tiposConsultados?: Set<number>, rangos?: Array }} opciones
 *        tiposConsultados: tipos SII efectivamente consultados al SII (por defecto, los presentes en docsSii).
 *        rangos: CAF cargados por sucursal [{ tipo_sii, desde, hasta, sucursal }].
 *        xmlOtrosMeses: Map 'tipo-folio' -> fecha, XML generados en meses vecinos (explican saltos).
 */
export function cuadrar(docsSisgen, docsSii, opciones = {}) {
  const tiposConsultados = opciones.tiposConsultados ?? new Set(docsSii.map((d) => d.tipo_sii));
  const rangosPorTipo = new Map();
  for (const r of opciones.rangos ?? []) {
    if (!rangosPorTipo.has(r.tipo_sii)) rangosPorTipo.set(r.tipo_sii, []);
    rangosPorTipo.get(r.tipo_sii).push(r);
  }
  /** A qué sucursal corresponde un folio según los CAF. undefined = no hay CAF de ese tipo. */
  const duenoDelFolio = (tipo, folio, sucursalEmisora) => {
    const rs = rangosPorTipo.get(tipo);
    if (!rs) return undefined;
    const cont = rs.filter((r) => folio >= r.desde && folio <= r.hasta);
    return cont.find((r) => r.sucursal === sucursalEmisora) ?? cont[0] ?? null;
  };
  const resumenSii = opciones.resumenSii ?? [];
  // Tipos que el SII informa solo como total del mes (boletas): no se pueden marcar como
  // "falta" uno a uno; se cuadran por totales más abajo.
  const tiposResumen = new Set(resumenSii.filter((r) => r.tipo_ingreso === 'RESUMEN').map((r) => r.tipo_sii));
  const sii = new Map(docsSii.map((d) => [clave(d.tipo_sii, d.folio), d]));
  const vistos = new Map(); // clave -> [sucursales]
  const documentos = [];
  const alertas = [];

  for (const d of docsSisgen) {
    if (!d.tipo_sii || !TIPOS_A_CUADRAR.has(d.tipo_sii)) continue; // no tributario / no aplica
    const k = clave(d.tipo_sii, d.folio);
    if (!vistos.has(k)) vistos.set(k, []);
    vistos.get(k).push(d.sucursal);

    const s = sii.get(k);
    let estado;
    let motivo = null;
    if (!s) {
      estado = tiposConsultados.has(d.tipo_sii) && !tiposResumen.has(d.tipo_sii)
        ? ESTADOS.FALTA_EN_SII : ESTADOS.SIN_VERIFICAR;
    } else if (s.estado === 'NO_RECIBIDO') {
      estado = ESTADOS.FALTA_EN_SII; motivo = s.motivo;
    } else if (s.estado === 'RECHAZADO') {
      estado = ESTADOS.RECHAZADO; motivo = s.motivo;
    } else if (s.estado === 'ANULADO') {
      estado = ESTADOS.ANULADO; motivo = s.motivo;
    } else if (s.estado === 'REPARO') {
      estado = ESTADOS.REPARO; motivo = s.motivo;
    } else if (Math.abs((s.total ?? 0) - (d.total ?? 0)) > TOLERANCIA_MONTO) {
      estado = ESTADOS.MONTO_DISTINTO;
      motivo = `Sisgen ${fmt(d.total)} / SII ${fmt(s.total)}`;
    } else {
      estado = ESTADOS.OK;
    }

    documentos.push({
      tipoSii: d.tipo_sii,
      tipoNombre: NOMBRES_SII[d.tipo_sii] ?? `Tipo ${d.tipo_sii}`,
      tipoSisgen: d.tipo_sisgen,
      folio: d.folio,
      fecha: d.fecha,
      sucursal: d.sucursal,
      rutReceptor: d.rut_receptor,
      nombreReceptor: d.nombre_receptor,
      montoSisgen: d.total,
      montoSii: s?.total ?? null,
      estadoSii: s?.estado ?? null,
      fuenteSii: s?.fuente ?? null,
      consultadoEn: s?.consultado_en ?? null,
      enBlanco: !!d.en_blanco,
      sinXml: !!d.sin_xml,
      ...infoCaf(duenoDelFolio(d.tipo_sii, d.folio, d.sucursal), d.sucursal),
      estado,
      motivo,
    });
  }

  // Documentos que el SII tiene y Sisgen no
  for (const s of docsSii) {
    if (vistos.has(clave(s.tipo_sii, s.folio))) continue;
    documentos.push({
      tipoSii: s.tipo_sii,
      tipoNombre: NOMBRES_SII[s.tipo_sii] ?? `Tipo ${s.tipo_sii}`,
      tipoSisgen: null,
      folio: s.folio,
      fecha: s.fecha,
      sucursal: null,
      rutReceptor: s.rut_receptor,
      nombreReceptor: null,
      montoSisgen: null,
      montoSii: s.total,
      estadoSii: s.estado,
      fuenteSii: s.fuente,
      consultadoEn: s.consultado_en,
      enBlanco: false,
      sinXml: false,
      ...infoCaf(duenoDelFolio(s.tipo_sii, s.folio, null), null),
      estado: ESTADOS.SOLO_EN_SII,
      motivo: 'Registrado en el SII pero no encontrado en ninguna sucursal de Sisgen',
    });
  }

  // ---- Boletas: cuadre por totales contra el resumen del Registro de Ventas ----
  const cuadreTipos = cuadrarPorResumen(documentos, resumenSii, alertas);
  cuadreTipos.push(...cuadreDetalle(documentos, docsSii, tiposResumen));
  cuadreTipos.sort((a, b) => a.tipoSii - b.tipoSii);

  // ---- Alertas por documento ----
  const NIVEL = {
    FALTA_EN_SII: 'alta', RECHAZADO: 'alta', MONTO_DISTINTO: 'media',
    REPARO: 'media', SOLO_EN_SII: 'media', ANULADO: 'baja',
  };
  const TEXTO = {
    FALTA_EN_SII: 'No está en el SII',
    RECHAZADO: 'Rechazado por el SII',
    MONTO_DISTINTO: 'Monto no coincide con el SII',
    REPARO: 'Aceptado con reparos',
    SOLO_EN_SII: 'Está en el SII pero no en Sisgen',
    ANULADO: 'Anulado en el SII',
  };
  for (const d of documentos) {
    if (!NIVEL[d.estado]) continue;
    alertas.push({
      nivel: NIVEL[d.estado], codigo: d.estado, titulo: TEXTO[d.estado],
      tipoSii: d.tipoSii, tipoNombre: d.tipoNombre, folio: d.folio,
      sucursal: d.sucursal, motivo: d.motivo, monto: d.montoSisgen ?? d.montoSii,
    });
  }

  // ---- Documentos en blanco (no quedaron completos en F1/F2 de Sisgen) ----
  for (const d of documentos) {
    if (!d.enBlanco) continue;
    alertas.push({
      nivel: 'alta', codigo: 'DOCUMENTO_EN_BLANCO', titulo: 'Documento en blanco',
      tipoSii: d.tipoSii, tipoNombre: d.tipoNombre, folio: d.folio, sucursal: d.sucursal,
      monto: d.montoSisgen, motivo: 'No quedó registrado completo en Sisgen',
    });
  }

  // ---- Registrados en Sisgen sin XML generado ----
  for (const d of documentos) {
    if (!d.sinXml) continue;
    alertas.push({
      nivel: 'alta', codigo: 'SIN_XML', titulo: 'Sin XML generado',
      tipoSii: d.tipoSii, tipoNombre: d.tipoNombre, folio: d.folio, sucursal: d.sucursal, monto: d.montoSisgen,
      motivo: 'Está registrado en Sisgen pero no se generó su XML: probablemente no se envió al SII',
    });
  }

  // ---- Folios duplicados entre sucursales del mismo RUT ----
  for (const [k, sucs] of vistos) {
    if (sucs.length < 2) continue;
    const [tipo, folio] = k.split('-').map(Number);
    alertas.push({
      nivel: 'alta', codigo: 'FOLIO_DUPLICADO', titulo: 'Folio usado más de una vez',
      tipoSii: tipo, tipoNombre: NOMBRES_SII[tipo], folio, sucursal: sucs.join(', '),
      motivo: `El mismo folio aparece en: ${sucs.join(', ')}`,
    });
  }

  // ---- Folios usados fuera del rango CAF de la sucursal ----
  for (const d of documentos) {
    if (d.tipoSisgen == null || d.cafSucursal === undefined) continue;
    if (d.cafSucursal === null) {
      alertas.push({
        nivel: 'baja', codigo: 'FOLIO_SIN_CAF', titulo: 'Folio sin CAF',
        tipoSii: d.tipoSii, tipoNombre: d.tipoNombre, folio: d.folio, sucursal: d.sucursal,
        motivo: 'No se encontró el CAF de este folio en ninguna sucursal',
      });
    } else if (d.cafSucursal !== d.sucursal) {
      alertas.push({
        nivel: 'media', codigo: 'FOLIO_DE_OTRA_SUCURSAL', titulo: 'Folio de otra sucursal',
        tipoSii: d.tipoSii, tipoNombre: d.tipoNombre, folio: d.folio, sucursal: d.sucursal, monto: d.montoSisgen,
        motivo: `Emitido por ${d.sucursal}, pero el folio corresponde a ${d.cafSucursal} ` +
          `(rango ${fmtN(d.cafDesde)} al ${fmtN(d.cafHasta)})`,
      });
    }
  }

  // ---- Saltos de folio ----
  // Con CAF conocidos: se buscan saltos dentro de cada rango CAF (así no se confunde el
  // espacio entre los rangos de dos sucursales con folios perdidos). Sin CAF: por tipo.
  const grupos = new Map();
  for (const d of documentos) {
    if (d.tipoSisgen == null) continue;
    const g = d.cafSucursal ? `${d.tipoSii}|${d.cafDesde}` : `${d.tipoSii}|sin-caf`;
    if (!grupos.has(g)) grupos.set(g, { tipo: d.tipoSii, sucursalCaf: d.cafSucursal ?? null, lista: [] });
    grupos.get(g).lista.push(d);
  }
  // Un folio del hueco con XML en otro mes no falta: se emitió con otra fecha.
  const otroMes = opciones.xmlOtrosMeses ?? new Map();
  for (const { tipo, sucursalCaf, lista } of grupos.values()) {
    const ord = [...new Set(lista.map((d) => d.folio))].sort((a, b) => a - b);
    for (let i = 1; i < ord.length; i++) {
      const faltan = ord[i] - ord[i - 1] - 1;
      if (faltan <= 0 || faltan > SALTO_MAXIMO_REPORTADO) continue;
      const suc = sucursalCaf ?? lista.find((d) => d.folio === ord[i - 1])?.sucursal;
      const base = { tipoSii: tipo, tipoNombre: NOMBRES_SII[tipo], sucursal: suc };
      for (const tramo of tramos(ord[i - 1] + 1, ord[i] - 1, (f) => otroMes.get(clave(tipo, f)))) {
        const n = tramo.hasta - tramo.desde + 1;
        const rango = n === 1 ? `${fmtN(tramo.desde)}` : `${fmtN(tramo.desde)} al ${fmtN(tramo.hasta)}`;
        if (tramo.valor) {
          alertas.push({
            ...base, nivel: 'baja', codigo: 'FOLIO_OTRO_MES', titulo: 'Folios emitidos en otro mes',
            folio: tramo.desde, folioHasta: n > 1 ? tramo.hasta : undefined,
            motivo: `Folio${n > 1 ? 's' : ''} ${rango} emitido${n > 1 ? 's' : ''} ` +
              (tramo.valor === tramo.valorHasta ? `con fecha ${fechaCl(tramo.valor)}`
                : `entre el ${fechaCl(tramo.valor)} y el ${fechaCl(tramo.valorHasta)}`) + ': no faltan',
          });
        } else {
          alertas.push({
            ...base, nivel: 'media', codigo: 'SALTO_FOLIO', titulo: 'Folios sin emitir',
            folio: tramo.desde, folioHasta: n > 1 ? tramo.hasta : undefined,
            motivo: n === 1 ? `Falta el folio ${rango}: no existe en Sisgen ni tiene XML`
              : `Faltan ${n} folios (${rango}): no existen en Sisgen ni tienen XML`,
          });
        }
      }
    }
  }

  const finales = agruparPorDocumento(alertas);
  const orden = { alta: 0, media: 1, baja: 2 };
  finales.sort((a, b) => orden[a.nivel] - orden[b.nivel] || a.tipoSii - b.tipoSii || (a.folio ?? 0) - (b.folio ?? 0));
  documentos.sort((a, b) => a.tipoSii - b.tipoSii || a.folio - b.folio);

  return { resumen: resumir(documentos), documentos, alertas: finales, cuadreTipos };
}

// Cuando un mismo documento tiene varios problemas se informa UNA alerta: el problema principal
// según esta prioridad, y los demás como `adicionales` (etiquetas).
const PRIORIDAD_ALERTA = [
  'FALTA_EN_SII', 'RECHAZADO', 'MONTO_DISTINTO', 'REPARO', 'SOLO_EN_SII', 'DOCUMENTO_EN_BLANCO', 'SIN_XML',
  'FOLIO_DUPLICADO', 'FOLIO_DE_OTRA_SUCURSAL', 'ANULADO', 'FOLIO_SIN_CAF',
];
const POR_RANGO = new Set(['SALTO_FOLIO', 'FOLIO_OTRO_MES']);

function agruparPorDocumento(alertas) {
  const nivel = { alta: 0, media: 1, baja: 2 };
  const rango = (c) => { const i = PRIORIDAD_ALERTA.indexOf(c); return i < 0 ? 99 : i; };
  const grupos = new Map();
  const sueltas = [];
  for (const a of alertas) {
    if (a.folio == null || POR_RANGO.has(a.codigo)) { sueltas.push(a); continue; }
    const k = `${a.tipoSii}-${a.folio}-${a.sucursal ?? ''}`;
    if (!grupos.has(k)) grupos.set(k, []);
    grupos.get(k).push(a);
  }
  const salida = [...sueltas];
  for (const g of grupos.values()) {
    g.sort((x, y) => rango(x.codigo) - rango(y.codigo));
    const principal = { ...g[0] };
    principal.nivel = g.reduce((m, x) => (nivel[x.nivel] < nivel[m] ? x.nivel : m), principal.nivel);
    principal.codigos = g.map((x) => x.codigo);
    principal.adicionales = g.slice(1).map((x) => x.titulo);
    salida.push(principal);
  }
  return salida;
}

// Boletas NO electrónicas que el SII muestra en el resumen (35 boleta, 38 boleta exenta):
// no se toman en cuenta en la cuadratura (indicación del usuario).
const TIPOS_RESUMEN_IGNORADOS = new Set([35, 38]);

const sumar = (lista, campo) => lista.reduce((s, d) => s + (d[campo] ?? 0), 0);

/**
 * Cuadre de los tipos que el SII entrega solo como resumen mensual (boletas).
 *  - Si cantidad y monto de Sisgen coinciden con el SII: todos los documentos quedan OK.
 *  - Si no coinciden, pero coinciden al descontar los documentos SIN XML: esos documentos
 *    quedan "No está en el SII" y el resto OK (el SII cuadra exactamente sin ellos).
 *  - Si tampoco: alerta de diferencia; los documentos quedan "Sin verificar".
 * Modifica `documentos` (estado/motivo) y agrega alertas.
 */
function cuadrarPorResumen(documentos, resumenSii, alertas) {
  const filas = [];
  for (const r of resumenSii) {
    if (r.tipo_ingreso !== 'RESUMEN' || TIPOS_RESUMEN_IGNORADOS.has(r.tipo_sii)) continue;
    const nombre = NOMBRES_SII[r.tipo_sii] ?? r.nombre;
    const docs = documentos.filter((d) => d.tipoSii === r.tipo_sii && d.tipoSisgen != null);
    const fila = {
      tipoSii: r.tipo_sii, tipoNombre: nombre, modo: 'resumen',
      sisgenDocs: docs.length, sisgenMonto: sumar(docs, 'montoSisgen'),
      siiDocs: r.tot_doc, siiMonto: r.monto_total,
    };
    filas.push(fila);
    if (!docs.length) {
      fila.estado = 'SOLO_SII';
      alertas.push({
        nivel: 'media', codigo: 'RESUMEN_SOLO_SII', titulo: 'Registrado en el SII pero no en Sisgen',
        tipoSii: r.tipo_sii, tipoNombre: nombre, folio: null, sucursal: null, monto: r.monto_total,
        motivo: `El Registro de Ventas del SII informa ${r.tot_doc} ${nombre.toLowerCase()} por ${fmt(r.monto_total)} que no existen en ninguna sucursal`,
      });
      continue;
    }
    // Las boletas ya verificadas una a una en la API de boletas conservan ese resultado
    const verificadaApi = (d) => d.fuenteSii === 'API_BOLETA';
    const marcar = (lista, estado, motivo) =>
      lista.filter((d) => !verificadaApi(d)).forEach((d) => Object.assign(d, { estado, motivo, fuenteSii: 'RCV_RESUMEN' }));
    const cuadra = (n, monto) => n === r.tot_doc && Math.abs(monto - r.monto_total) <= TOLERANCIA_MONTO;

    if (cuadra(docs.length, fila.sisgenMonto)) {
      fila.estado = 'CUADRA';
      marcar(docs, ESTADOS.OK, 'Cuadra con el resumen del Registro de Ventas del SII');
      continue;
    }
    // Candidatas a faltar: sin XML, o confirmadas "no recibidas" por la API de boletas
    const faltante = (d) => d.sinXml || (verificadaApi(d) && d.estado === ESTADOS.FALTA_EN_SII);
    const faltan = docs.filter(faltante);
    if (faltan.length && cuadra(docs.length - faltan.length, fila.sisgenMonto - sumar(faltan, 'montoSisgen'))) {
      fila.estado = 'CUADRA_SIN_FALTANTES';
      fila.faltantes = faltan.length;
      marcar(docs.filter((d) => !faltante(d)), ESTADOS.OK, 'Cuadra con el resumen del Registro de Ventas del SII');
      marcar(faltan, ESTADOS.FALTA_EN_SII, 'No está en el resumen del SII: el total del SII cuadra exactamente sin este documento');
      continue;
    }
    fila.estado = 'DIFERENCIA';
    alertas.push({
      nivel: 'alta', codigo: 'RESUMEN_DIFERENTE', titulo: 'Total del mes no cuadra con el SII',
      tipoSii: r.tipo_sii, tipoNombre: nombre, folio: null, sucursal: null, monto: fila.sisgenMonto - r.monto_total,
      motivo: `Sisgen ${docs.length} docs por ${fmt(fila.sisgenMonto)} / SII ${r.tot_doc} docs por ${fmt(r.monto_total)} ` +
        `(diferencia ${docs.length - r.tot_doc} docs, ${fmt(fila.sisgenMonto - r.monto_total)})`,
    });
  }
  return filas;
}

/** Totales Sisgen vs SII para los tipos que el SII entrega con detalle (uno a uno). */
function cuadreDetalle(documentos, docsSii, tiposResumen) {
  const tipos = new Set([...documentos.map((d) => d.tipoSii), ...docsSii.map((d) => d.tipo_sii)]);
  const filas = [];
  for (const t of tipos) {
    if (tiposResumen.has(t)) continue;
    const sg = documentos.filter((d) => d.tipoSii === t && d.tipoSisgen != null);
    const si = docsSii.filter((d) => d.tipo_sii === t);
    if (!si.length && sg.every((d) => d.estado === ESTADOS.SIN_VERIFICAR)) continue; // tipo aún no consultado
    const fila = {
      tipoSii: t, tipoNombre: NOMBRES_SII[t] ?? `Tipo ${t}`, modo: 'detalle',
      sisgenDocs: sg.length, sisgenMonto: sumar(sg, 'montoSisgen'),
      siiDocs: si.length, siiMonto: sumar(si, 'total'),
    };
    fila.estado = sg.every((d) => d.estado === ESTADOS.OK) && fila.sisgenDocs === fila.siiDocs ? 'CUADRA' : 'DIFERENCIA';
    filas.push(fila);
  }
  return filas;
}

function resumir(documentos) {
  const porEstado = Object.fromEntries(Object.values(ESTADOS).map((e) => [e, 0]));
  const suc = new Map();
  const tipos = new Map();
  let montoTotal = 0;
  let enBlanco = 0;
  let sinXml = 0;
  for (const d of documentos) {
    porEstado[d.estado]++;
    if (d.enBlanco) enBlanco++;
    if (d.sinXml) sinXml++;
    const monto = d.montoSisgen ?? 0;
    // NC resta en el total vendido
    const signo = d.tipoSii === 61 ? -1 : 1;
    montoTotal += signo * monto;

    const ks = d.sucursal ?? '(no está en Sisgen)';
    if (!suc.has(ks)) suc.set(ks, { sucursal: ks, documentos: 0, monto: 0, ok: 0, problemas: 0, sinVerificar: 0, enBlanco: 0, sinXml: 0 });
    const s = suc.get(ks);
    s.documentos++; s.monto += signo * monto;
    if (d.enBlanco) s.enBlanco++;
    if (d.sinXml) s.sinXml++;
    if (d.estado === ESTADOS.OK) s.ok++;
    else if (d.estado === ESTADOS.SIN_VERIFICAR) s.sinVerificar++;
    else s.problemas++;

    if (!tipos.has(d.tipoSii)) tipos.set(d.tipoSii, { tipoSii: d.tipoSii, tipoNombre: d.tipoNombre, documentos: 0, monto: 0 });
    const t = tipos.get(d.tipoSii);
    t.documentos++; t.monto += monto;
  }
  return {
    documentos: documentos.length,
    montoTotal,
    enBlanco,
    sinXml,
    porEstado,
    porSucursal: [...suc.values()].sort((a, b) => b.monto - a.monto),
    porTipo: [...tipos.values()].sort((a, b) => a.tipoSii - b.tipoSii),
  };
}

/**
 * Agrupa folios consecutivos [desde..hasta] según si fn(folio) devuelve una fecha o no.
 * Cada tramo con fecha guarda la primera y última fecha (valor / valorHasta).
 */
function tramos(desde, hasta, fn) {
  const out = [];
  for (let f = desde; f <= hasta; f++) {
    const v = fn(f) ?? null;
    const ult = out.at(-1);
    if (ult && !!ult.valor === !!v && ult.hasta === f - 1) {
      ult.hasta = f;
      if (v && v < ult.valor) ult.valor = v;
      if (v && v > ult.valorHasta) ult.valorHasta = v;
    } else out.push({ desde: f, hasta: f, valor: v, valorHasta: v });
  }
  return out;
}

const fechaCl = (f) => (f ? f.split('-').reverse().join('-') : '');

/** Campos CAF del documento. cafSucursal: undefined = sin CAF de ese tipo, null = fuera de todo CAF. */
function infoCaf(rango, _sucursal) {
  if (rango === undefined) return { cafSucursal: undefined, cafDesde: null, cafHasta: null };
  if (rango === null) return { cafSucursal: null, cafDesde: null, cafHasta: null };
  return { cafSucursal: rango.sucursal, cafDesde: rango.desde, cafHasta: rango.hasta };
}

const fmtN = (n) => Number(n).toLocaleString('es-CL');
const fmt = (n) => (n == null ? '-' : '$' + Math.round(n).toLocaleString('es-CL'));
