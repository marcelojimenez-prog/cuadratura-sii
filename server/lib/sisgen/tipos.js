// Equivalencia entre el tipo de documento de Sisgen (campo FATDOCTO de F1) y el código SII.
// `confirmado: false` = deducido de los datos, falta validarlo con el equipo Sisgen.
// `enRcv`: el documento aparece detallado en el Registro de Ventas (RCV) del SII.
//          Las boletas (39/41) solo aparecen como resumen diario: se validan con la API de boletas.
export const TIPOS_SISGEN = {
  FE: { sii: 33, nombre: 'Factura electrónica', enRcv: true, confirmado: true },
  FX: { sii: 34, nombre: 'Factura exenta electrónica', enRcv: true, confirmado: false },
  // NE y BX confirmados contra los XML de procesos\DTE del piloto (oct-2026): NE = T61, BX = T41
  NE: { sii: 61, nombre: 'Nota de crédito electrónica', enRcv: true, confirmado: true },
  BX: { sii: 41, nombre: 'Boleta exenta electrónica', enRcv: false, confirmado: true },
  DE: { sii: 56, nombre: 'Nota de débito electrónica', enRcv: true, confirmado: true }, // XML t56 en piloto
  BE: { sii: 39, nombre: 'Boleta electrónica', enRcv: false, confirmado: true },
  // BT: no se toma en cuenta en la cuadratura (indicación del usuario, nov-2026). No genera XML de DTE.
  BT: { sii: null, nombre: 'BT (no se considera)', enRcv: false, confirmado: true },
  GE: { sii: 52, nombre: 'Guía de despacho electrónica', enRcv: false, confirmado: true },
  // No tributarios o no electrónicos: se importan para información pero no se cuadran contra el SII
  NC: { sii: null, nombre: 'Nota de crédito (no electrónica)', enRcv: false, confirmado: false },
  GD: { sii: null, nombre: 'Guía de despacho (no electrónica)', enRcv: false, confirmado: false },
  OV: { sii: null, nombre: 'Orden / nota de venta', enRcv: false, confirmado: false },
};

export const NOMBRES_SII = {
  33: 'Factura electrónica',
  34: 'Factura exenta electrónica',
  35: 'Boleta (no electrónica)',
  38: 'Boleta exenta (no electrónica)',
  39: 'Boleta electrónica',
  41: 'Boleta exenta electrónica',
  46: 'Factura de compra electrónica',
  52: 'Guía de despacho electrónica',
  56: 'Nota de débito electrónica',
  61: 'Nota de crédito electrónica',
  110: 'Factura de exportación electrónica',
};

/** Tipo Sisgen que corresponde a un código SII (para documentos que solo existen como XML). */
export const TIPO_SISGEN_POR_SII = { 33: 'FE', 34: 'FX', 39: 'BE', 41: 'BX', 52: 'GE', 56: 'DE', 61: 'NE' };

export function tipoSii(tipoSisgen) {
  return TIPOS_SISGEN[tipoSisgen?.toUpperCase()]?.sii ?? null;
}

/** Tipos SII que se deben encontrar en el SII (se excluye guía 52: no va al RCV de ventas). */
export const TIPOS_A_CUADRAR = new Set([33, 34, 39, 41, 56, 61, 110]);
