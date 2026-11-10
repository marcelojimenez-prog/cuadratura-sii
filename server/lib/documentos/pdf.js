// Representación impresa (PDF) de un DTE, con la diagramación de los formatos de Sisgen:
//   - Carta  (formatos\DTE\dtefactura.frx): facturas, notas de crédito/débito, guías.
//   - Térmico 72 mm (formatos\DTE\dteboleta.frx): boletas.
// Los datos salen del XML del DTE. De Sisgen solo se toma lo que el XML no trae: logo, oficina
// del SII, resolución y, si el XML de una boleta no trae <Detalle>, las líneas de la tabla F2.
// El timbre PDF417 se dibuja desde el <TED> del propio XML.
import PDFDocument from 'pdfkit';
import bwipjs from 'bwip-js';
import { XMLParser } from 'fast-xml-parser';
import { NOMBRES_SII } from '../sisgen/tipos.js';

const parser = new XMLParser({
  ignoreAttributes: false,
  parseTagValue: false,
  trimValues: true,
  isArray: (n) => ['Detalle', 'ImptoReten', 'Referencia', 'DscRcgGlobal', 'CdgItem'].includes(n),
});

// Impuestos adicionales (código SII -> etiqueta como la usa Sisgen)
const IMPUESTOS = {
  271: 'IABA 18%', 27: 'IABA 10%', 26: 'ILA 20,5% (cervezas)', 25: 'ILA 20,5% (vinos)',
  24: 'ILA 31,5% (licores)', 23: 'Imp. art. suntuarios', 14: 'IVA margen comerc.', 15: 'IVA retenido',
  17: 'IVA anticipado faenamiento', 28: 'Imp. específico diésel', 35: 'Imp. específico gasolinas',
};
const REFERENCIAS = {
  801: 'Orden de compra', 802: 'Nota de pedido', 803: 'Contrato', 804: 'Resolución',
  805: 'Proceso ChileCompra', 806: 'Ficha ChileCompra', 807: 'DUS', 808: 'B/L', 809: 'AWB',
  HES: 'Hoja entrada servicio', HEM: 'Hoja entrada materiales', SET: 'Set de pruebas',
};
const COD_REF = { 1: 'Anula documento', 2: 'Corrige texto', 3: 'Corrige montos' };
const NOMBRE_RECUADRO = {
  33: ['FACTURA', 'ELECTRÓNICA'], 34: ['FACTURA NO AFECTA', 'O EXENTA ELECTRÓNICA'],
  39: ['BOLETA', 'ELECTRÓNICA'], 41: ['BOLETA EXENTA', 'ELECTRÓNICA'],
  52: ['GUÍA DE DESPACHO', 'ELECTRÓNICA'], 56: ['NOTA DE DÉBITO', 'ELECTRÓNICA'],
  61: ['NOTA DE CRÉDITO', 'ELECTRÓNICA'], 110: ['FACTURA DE', 'EXPORTACIÓN ELECTRÓNICA'],
};

const MM = 2.8346; // puntos por milímetro
const AZUL = '#000080';
const ROJO = '#d00000';
const RECEPTORES_GENERICOS = ['66666666-6', '99999999-9'];

const n0 = (v) => (v == null || v === '' ? 0 : Number(v));
const miles = (v) => (v == null || v === '' ? '' : Math.round(Number(v)).toLocaleString('es-CL'));
const cant = (v) => (v == null || v === '' ? '' : Number(v).toLocaleString('es-CL', { maximumFractionDigits: 2 }));
const rutFmt = (r) => {
  if (!r) return '';
  const [n, dv] = String(r).split('-');
  return `${Number(n).toLocaleString('es-CL')}-${dv}`;
};
const fechaCl = (f) => (f ? f.split('-').reverse().join('-') : '');
const nombreDoc = (t) => NOMBRE_RECUADRO[t] ?? [(NOMBRES_SII[t] ?? `DOCUMENTO ${t}`).toUpperCase()];

/** Extrae los datos del DTE (facturas, notas, guías y boletas). */
export function leerDte(xmlTexto) {
  const raiz = parser.parse(xmlTexto);
  const dte = raiz.DTE ?? raiz.EnvioDTE?.SetDTE?.DTE ?? raiz.EnvioBOLETA?.SetDTE?.DTE;
  const doc = dte?.Documento ?? dte?.Exportaciones ?? dte?.Liquidacion;
  if (!doc) throw new Error('El XML no contiene un DTE reconocible');
  const enc = doc.Encabezado;
  const ted = /<TED[\s\S]*?<\/TED>/.exec(xmlTexto)?.[0]?.replace(/>\s+</g, '><') ?? null;
  const e = enc.Emisor, r = enc.Receptor ?? {};
  return {
    tipo: Number(enc.IdDoc.TipoDTE),
    folio: Number(enc.IdDoc.Folio),
    fecha: enc.IdDoc.FchEmis,
    fechaVenc: enc.IdDoc.FchVenc ?? null,
    formaPago: { 1: 'Contado', 2: 'Crédito', 3: 'Sin costo' }[enc.IdDoc.FmaPago] ?? null,
    emisor: {
      rut: e.RUTEmisor, razon: e.RznSoc ?? e.RznSocEmisor, giro: e.GiroEmis ?? e.GiroEmisor,
      direccion: e.DirOrigen, comuna: e.CmnaOrigen, ciudad: e.CiudadOrigen, telefono: e.Telefono, correo: e.CorreoEmisor,
    },
    receptor: {
      rut: r.RUTRecep, razon: r.RznSocRecep, giro: r.GiroRecep, direccion: r.DirRecep,
      comuna: r.CmnaRecep, ciudad: r.CiudadRecep, contacto: r.Contacto,
    },
    totales: enc.Totales ?? {},
    detalle: (doc.Detalle ?? []).map((d) => ({
      codigo: d.CdgItem?.[0]?.VlrCodigo ?? '',
      nombre: [d.NmbItem, d.DscItem].filter(Boolean).join(' - '),
      cantidad: d.QtyItem, precio: d.PrcItem,
      descuento: d.DescuentoMonto, descuentoPct: d.DescuentoPct, monto: d.MontoItem,
    })),
    itemTimbre: /<IT1>([^<]*)<\/IT1>/.exec(xmlTexto)?.[1] ?? null,
    referencias: (doc.Referencia ?? []).map((x) => ({
      tipo: x.TpoDocRef, folio: x.FolioRef, fecha: x.FchRef, razon: x.RazonRef ?? COD_REF[x.CodRef] ?? '',
    })),
    ted,
  };
}

async function timbrePng(dte) {
  if (!dte.ted) return null;
  return bwipjs.toBuffer({ bcid: 'pdf417', text: dte.ted, eclevel: 5, scale: 2, columns: 12 });
}

const lineasTotales = (t) => [
  ['Neto', t.MntNeto], ['Exento', t.MntExe], [`IVA ${t.TasaIVA ?? 19}%`, t.IVA],
  ...(t.ImptoReten ?? []).map((i) => [IMPUESTOS[i.TipoImp] ?? `Impuesto ${i.TipoImp} ${i.TasaImp ?? ''}%`, i.MontoImp]),
].filter(([, v]) => n0(v) !== 0);

const leyendaResolucion = (extras) =>
  extras.resolucionNumero ? `Res. ${extras.resolucionNumero} del ${extras.resolucionAnio ?? ''}` : null;

function aBuffer(doc) {
  const partes = [];
  doc.on('data', (b) => partes.push(b));
  return new Promise((ok) => doc.on('end', () => ok(Buffer.concat(partes))));
}

/**
 * Genera el PDF del documento.
 * @param {string} xmlTexto
 * @param {{ extras?: { logo?, oficinaSii?, resolucionNumero?, resolucionAnio? }, detalleAlterno?: Array }} opciones
 *   detalleAlterno: líneas desde F2 de Sisgen cuando el XML no trae <Detalle>
 */
export async function generarPdf(xmlTexto, opciones = {}) {
  const dte = leerDte(xmlTexto);
  const extras = opciones.extras ?? {};
  dte.detalleOrigen = 'xml';
  if (!dte.detalle.length && opciones.detalleAlterno?.length) {
    dte.detalle = opciones.detalleAlterno;
    dte.detalleOrigen = 'sisgen';
  }
  const timbre = await timbrePng(dte);
  return [39, 41].includes(dte.tipo) ? pdfTermico(dte, extras, timbre) : pdfCarta(dte, extras, timbre);
}

// ============================ Formato carta (dtefactura.frx) ============================

function pdfCarta(dte, extras, timbre) {
  const doc = new PDFDocument({ size: 'LETTER', margin: 0, info: { Title: `${nombreDoc(dte.tipo).join(' ')} N° ${dte.folio}` } });
  const fin = aBuffer(doc);
  const mm = (v) => v * MM;
  const ALTO_PAG = 279.4;
  const X0 = 15.9, ANCHO = 184.4;

  // Columnas del detalle (mm), igual que Sisgen
  const COLS = [
    { t: 'Cantidad', x: 15.9, w: 16.9, a: 'right', v: (d) => cant(d.cantidad) },
    { t: 'Código', x: 32.8, w: 20.6, a: 'left', v: (d) => d.codigo ?? '' },
    { t: 'Descripción', x: 53.4, w: 88.4, a: 'left', v: (d) => d.nombre ?? '' },
    { t: 'P.Unitario', x: 141.8, w: 18.8, a: 'right', v: (d) => miles(d.precio) },
    { t: 'Descuento', x: 160.6, w: 18.8, a: 'right', v: (d) => (n0(d.descuento) ? miles(d.descuento) : n0(d.descuentoPct) ? `${cant(d.descuentoPct)}%` : '') },
    { t: 'Total', x: 179.4, w: 20.9, a: 'right', v: (d) => miles(d.monto) },
  ];
  const ALTO_PIE = 78;              // pie (referencias, totales, timbre)
  const Y_TABLA = 73.3;             // inicio de la tabla en la primera página
  const LIMITE_DET = ALTO_PAG - 8 - ALTO_PIE;

  const encabezado = () => {
    // Logo (o datos del emisor si no hay logo)
    if (extras.logo) {
      try { doc.image(extras.logo, mm(X0), mm(8.2), { fit: [mm(113.2), mm(35)] }); } catch { extras.logo = null; }
    }
    if (!extras.logo) {
      const e = dte.emisor;
      doc.fillColor('black').font('Helvetica-Bold').fontSize(12).text(e.razon ?? '', mm(X0), mm(10), { width: mm(113) });
      doc.font('Helvetica').fontSize(8);
      if (e.giro) doc.text(e.giro, { width: mm(113) });
      doc.text([e.direccion, e.comuna, e.ciudad].filter(Boolean).join(', '), { width: mm(113) });
      if (e.telefono || e.correo) doc.text([e.telefono && `Fono: ${e.telefono}`, e.correo].filter(Boolean).join('  ·  '), { width: mm(113) });
    }
    // Recuadro tributario
    doc.lineWidth(2).strokeColor(ROJO).rect(mm(135.2), mm(8.2), mm(65.1), mm(29.6)).stroke();
    doc.fillColor(ROJO).font('Helvetica-Bold').fontSize(12);
    doc.text(`R.U.T.: ${rutFmt(dte.emisor.rut)}`, mm(136), mm(11.1), { width: mm(63.5), align: 'center' });
    const lineas = nombreDoc(dte.tipo);
    lineas.forEach((l, i) => doc.text(l, mm(136), mm(lineas.length > 1 ? 17.7 + i * 5 : 20), { width: mm(63.5), align: 'center' }));
    doc.text(`Nº ${dte.folio}`, mm(136), mm(29.5), { width: mm(63.5), align: 'center' });
    doc.fontSize(11).text(`S.I.I. - ${extras.oficinaSii ?? ''}`.trim().replace(/-$/, ''), mm(130.7), mm(39.5), { width: mm(73.3), align: 'center' });
  };

  const datosCliente = () => {
    const r = dte.receptor;
    doc.lineWidth(0.5).strokeColor('black').rect(mm(X0), mm(45.8), mm(ANCHO), mm(26)).stroke();
    const izq = [
      ['Cliente', r.razon], ['R.U.T.', rutFmt(r.rut)], ['Giro', r.giro], ['Dirección', r.direccion],
    ];
    const der = [
      ['Emitido', fechaCl(dte.fecha)], ['Vence', fechaCl(dte.fechaVenc)], ['Pago', dte.formaPago], ['Contacto', r.contacto],
    ];
    doc.font('Helvetica').fontSize(8).fillColor('black');
    izq.forEach(([k, v], i) => {
      doc.text(k, mm(18.3), mm(47.4 + i * 4), { width: mm(14) });
      doc.text(`: ${v ?? ''}`, mm(32.8), mm(47.4 + i * 4), { width: mm(100), lineBreak: false, ellipsis: true });
    });
    doc.text('Comuna', mm(18.3), mm(63.4)).text(`: ${r.comuna ?? ''}`, mm(32.8), mm(63.4), { width: mm(40), lineBreak: false });
    doc.text('Ciudad', mm(74.1), mm(63.4)).text(`: ${r.ciudad ?? ''}`, mm(84.4), mm(63.4), { width: mm(49), lineBreak: false });
    der.forEach(([k, v], i) => {
      doc.text(k, mm(135.5), mm(47.4 + i * 4), { width: mm(13) });
      doc.text(`: ${v ?? ''}`, mm(148.7), mm(47.4 + i * 4), { width: mm(51), lineBreak: false, ellipsis: true });
    });
  };

  const cabeceraTabla = (y) => {
    doc.rect(mm(X0), mm(y), mm(ANCHO), mm(6.1)).fill(AZUL);
    doc.fillColor('white').font('Helvetica-Bold').fontSize(8);
    for (const c of COLS) doc.text(c.t, mm(c.x + 1), mm(y + 1.6), { width: mm(c.w - 2), align: 'center' });
    return y + 6.1;
  };
  const marcoTabla = (yIni, yFin) => {
    doc.lineWidth(0.5).strokeColor('black').rect(mm(X0), mm(yIni), mm(ANCHO), mm(yFin - yIni)).stroke();
    for (const c of COLS.slice(1)) doc.moveTo(mm(c.x), mm(yIni)).lineTo(mm(c.x), mm(yFin)).stroke();
  };

  // ---- Página 1 ----
  encabezado();
  datosCliente();
  let yIniTabla = Y_TABLA;
  let y = cabeceraTabla(yIniTabla) + 1.2;
  doc.font('Helvetica').fontSize(7).fillColor('black');
  for (const d of dte.detalle) {
    const altoDesc = doc.heightOfString(COLS[2].v(d), { width: mm(COLS[2].w - 2) }) / MM;
    const alto = Math.max(3.7, altoDesc + 0.6);
    if (y + alto > LIMITE_DET) {
      marcoTabla(yIniTabla, LIMITE_DET + 2);
      doc.addPage({ size: 'LETTER', margin: 0 });
      encabezado();
      yIniTabla = 45.8;
      y = cabeceraTabla(yIniTabla) + 1.2;
      doc.font('Helvetica').fontSize(7).fillColor('black');
    }
    for (const c of COLS) doc.text(String(c.v(d)), mm(c.x + 1), mm(y), { width: mm(c.w - 2), align: c.a });
    y += alto;
  }
  if (!dte.detalle.length) {
    doc.fillColor('#555').text(
      dte.itemTimbre ? `El XML no incluye el detalle. Primer ítem según el timbre: ${dte.itemTimbre}` : 'El XML no incluye el detalle.',
      mm(COLS[2].x + 1), mm(y), { width: mm(COLS[2].w - 2) }
    );
  }
  const yFinTabla = LIMITE_DET + 2;
  marcoTabla(yIniTabla, yFinTabla);

  // ---- Pie ----
  const yp = yFinTabla + 2;
  // Referencias
  doc.lineWidth(0.5).strokeColor('black').rect(mm(X0), mm(yp), mm(126.2), mm(17.7)).stroke();
  doc.rect(mm(X0), mm(yp), mm(126.2), mm(5.5)).fill(AZUL);
  doc.fillColor('white').font('Helvetica-Bold').fontSize(8);
  const RC = [[X0, 46.5, 'Documento Ref.'], [62.4, 19.4, 'Folio'], [81.8, 18.7, 'Fecha'], [100.5, 41.6, 'Razón Ref.']];
  RC.forEach(([x, w, t]) => doc.text(t, mm(x), mm(yp + 1.4), { width: mm(w), align: 'center' }));
  RC.slice(1).forEach(([x]) => doc.moveTo(mm(x), mm(yp)).lineTo(mm(x), mm(yp + 17.7)).stroke());
  doc.fillColor('black').font('Helvetica').fontSize(7.5);
  dte.referencias.slice(0, 3).forEach((r, i) => {
    const yr = yp + 6.4 + i * 3.7;
    const nom = NOMBRES_SII[Number(r.tipo)] ?? REFERENCIAS[r.tipo] ?? `Tipo ${r.tipo}`;
    [[X0 + 1, 44.5, nom], [63.4, 17.4, r.folio], [82.8, 16.7, fechaCl(r.fecha)], [101.5, 39.6, r.razon]]
      .forEach(([x, w, v]) => doc.text(String(v ?? ''), mm(x), mm(yr), { width: mm(w), lineBreak: false, ellipsis: true }));
  });
  const unidades = dte.detalle.reduce((s, d) => s + n0(d.cantidad), 0);
  doc.font('Helvetica').fontSize(8).text(`Total unidades: ${cant(unidades)}`, mm(68.5), mm(yp + 19));

  // Totales en casillas
  const filas = [...lineasTotales(dte.totales), ['TOTAL', dte.totales.MntTotal]];
  const altoTot = filas.length * 5.3 + 1.6;
  doc.lineWidth(0.5).strokeColor('black').rect(mm(145.8), mm(yp), mm(54.8), mm(altoTot)).stroke();
  filas.forEach(([k, v], i) => {
    const yt = yp + 0.8 + i * 5.3;
    const esTotal = k === 'TOTAL';
    doc.rect(mm(175.7), mm(yt), mm(24.6), mm(4.8)).stroke();
    doc.fillColor('black').font('Helvetica-Bold').fontSize(esTotal ? 9 : 7.5)
      .text(k, mm(147.4), mm(yt + 1), { width: mm(28), lineBreak: false, ellipsis: true })
      .text(miles(v), mm(175.7), mm(yt + 1), { width: mm(23.3), align: 'right' });
  });

  // Timbre
  if (timbre) doc.image(timbre, mm(X0), mm(yp + 24), { fit: [mm(62), mm(30)] });
  doc.fillColor('black').font('Helvetica').fontSize(9).text('Timbre Electrónico SII', mm(X0), mm(yp + 55.5), { width: mm(62), align: 'center' });
  doc.fontSize(6.5).text(
    [leyendaResolucion(extras), 'Verifique documento: www.sii.cl'].filter(Boolean).join(' · '),
    mm(X0), mm(yp + 59.5), { width: mm(62), align: 'center' }
  );
  if (dte.detalleOrigen === 'sisgen') {
    doc.fontSize(6).fillColor('#777').text('Detalle tomado de Sisgen (el XML no lo incluye).', mm(68.5), mm(yp + 24), { width: mm(70) });
  }
  doc.end();
  return fin;
}

// ============================ Formato térmico 72 mm (dteboleta.frx) ============================

async function pdfTermico(dte, extras, timbre) {
  // Dos pasadas: la primera mide el alto real del ticket; la segunda dibuja con ese alto exacto
  const ANCHO_MM = 72.2;
  const medida = new PDFDocument({ size: [ANCHO_MM * MM, 5000], margin: 0 });
  const altoMm = dibujarTermico(medida, dte, extras, timbre) + 4;
  medida.end();
  const doc = new PDFDocument({ size: [ANCHO_MM * MM, altoMm * MM], margin: 0, info: { Title: `${nombreDoc(dte.tipo).join(' ')} N° ${dte.folio}` } });
  const fin = aBuffer(doc);
  dibujarTermico(doc, dte, extras, timbre);
  doc.end();
  return fin;
}

/** Dibuja el ticket y devuelve el alto usado (mm). */
function dibujarTermico(doc, dte, extras, timbre) {
  const ANCHO_MM = 72.2;
  const mm = (v) => v * MM;
  const W = ANCHO_MM - 2;           // ancho útil
  const X = 1;

  // Recuadro rojo
  doc.lineWidth(1.5).strokeColor(ROJO).rect(mm(3.7), mm(2), mm(65.1), mm(22.2)).stroke();
  doc.fillColor(ROJO).font('Helvetica-Bold').fontSize(11);
  doc.text(`R.U.T.: ${rutFmt(dte.emisor.rut)}`, mm(3.7), mm(4), { width: mm(65.1), align: 'center' });
  doc.text(nombreDoc(dte.tipo).join(' '), mm(3.7), mm(10), { width: mm(65.1), align: 'center' });
  doc.text(`Nº ${dte.folio}`, mm(3.7), mm(17), { width: mm(65.1), align: 'center' });
  doc.fontSize(10).text(`S.I.I. - ${extras.oficinaSii ?? ''}`.trim().replace(/-$/, ''), mm(X), mm(26), { width: mm(W), align: 'center' });

  // Emisor
  let y = 32;
  doc.fillColor('black').font('Helvetica-Bold').fontSize(9).text(dte.emisor.razon ?? '', mm(X), mm(y), { width: mm(W), align: 'center' });
  doc.font('Helvetica-Oblique').fontSize(8);
  if (dte.emisor.giro) doc.text(dte.emisor.giro, { width: mm(W), align: 'center' });
  doc.font('Helvetica').fontSize(8);
  const dir = [dte.emisor.direccion, dte.emisor.comuna].filter(Boolean).join(', ');
  if (dir) doc.text(`Dirección: ${dir}`, { width: mm(W), align: 'center' });
  y = doc.y / MM + 2;
  doc.moveTo(mm(0), mm(y)).lineTo(mm(ANCHO_MM), mm(y)).lineWidth(0.5).strokeColor('black').stroke();
  y += 1.5;
  doc.fontSize(9).text(`Fecha emisión: ${fechaCl(dte.fecha)}`, mm(X), mm(y), { width: mm(W) });
  y += 5;
  const r = dte.receptor;
  if (r.rut && !(RECEPTORES_GENERICOS.includes(r.rut) && !r.razon)) {
    doc.fontSize(8).text(`Cliente: ${rutFmt(r.rut)} ${r.razon ?? ''}`, mm(X), mm(y), { width: mm(W) });
    y = doc.y / MM + 1;
  }

  // Detalle
  doc.lineWidth(0.5).rect(mm(0), mm(y), mm(67.5), mm(5)).stroke();
  doc.font('Helvetica-Bold').fontSize(8.5);
  doc.text('Descripción', mm(1.6), mm(y + 1.2), { width: mm(30) });
  doc.text('Cant.', mm(26), mm(y + 1.2), { width: mm(13), align: 'right' });
  doc.text('P.unit.', mm(39), mm(y + 1.2), { width: mm(14), align: 'right' });
  doc.text('Valor', mm(53), mm(y + 1.2), { width: mm(14), align: 'right' });
  y += 6.5;
  doc.font('Helvetica').fontSize(8);
  for (const d of dte.detalle) {
    doc.text(d.nombre ?? '', mm(0.5), mm(y), { width: mm(66.4) });
    y = doc.y / MM + 0.3;
    doc.text(cant(d.cantidad), mm(26), mm(y), { width: mm(13), align: 'right' });
    doc.text(miles(d.precio), mm(39), mm(y), { width: mm(14), align: 'right' });
    doc.text(miles(d.monto), mm(53), mm(y), { width: mm(14), align: 'right' });
    y += 4.2;
  }
  if (!dte.detalle.length) {
    doc.fillColor('#555').text(dte.itemTimbre ? `${dte.itemTimbre} (según timbre)` : 'El XML no incluye el detalle.', mm(0.5), mm(y), { width: mm(66.4) });
    y = doc.y / MM + 1;
    doc.fillColor('black');
  }
  y += 1;
  doc.moveTo(mm(0), mm(y)).lineTo(mm(65.6), mm(y)).stroke();
  y += 1.5;

  // Totales
  doc.font('Helvetica-Bold').fontSize(8.5);
  for (const [k, v] of lineasTotales(dte.totales)) {
    doc.text(`${k.toUpperCase()} $`, mm(0.5), mm(y), { width: mm(44) });
    doc.text(miles(v), mm(43.4), mm(y), { width: mm(23.5), align: 'right' });
    y += 4.6;
  }
  doc.fontSize(12).text('TOTAL $', mm(0.3), mm(y + 0.5), { width: mm(30) });
  doc.text(miles(dte.totales.MntTotal), mm(31.2), mm(y + 0.5), { width: mm(35.7), align: 'right' });
  y += 7;
  doc.moveTo(mm(0), mm(y)).lineTo(mm(65.6), mm(y)).lineWidth(0.5).stroke();
  y += 2;

  // Timbre
  if (timbre) {
    doc.image(timbre, mm(1), mm(y), { fit: [mm(66), mm(40)] });
    y += 42;
  }
  doc.font('Helvetica').fontSize(8).text('Timbre Electrónico SII', mm(0), mm(y), { width: mm(ANCHO_MM), align: 'center' });
  if (leyendaResolucion(extras)) doc.text(leyendaResolucion(extras), { width: mm(ANCHO_MM), align: 'center' });
  doc.text('Verifique documento: www.sii.cl', { width: mm(ANCHO_MM), align: 'center' });
  if (dte.detalleOrigen === 'sisgen') {
    doc.fontSize(6).fillColor('#777').text('Detalle tomado de Sisgen (el XML no lo incluye).', { width: mm(ANCHO_MM), align: 'center' });
  }
  return doc.y / MM;
}
