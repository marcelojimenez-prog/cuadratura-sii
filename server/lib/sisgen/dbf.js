// Lector de tablas DBF (dBase / Visual FoxPro) sin dependencias externas.
// Sisgen guarda cada tabla como .DBF (+ índice .CDX). Solo leemos; nunca escribimos.
import fs from 'node:fs';

// Byte 29 del encabezado: página de códigos (language driver)
const CODEPAGES = { 0x01: 'ibm437', 0x02: 'ibm850', 0x03: 'windows-1252', 0x57: 'windows-1252', 0xc8: 'windows-1250' };

/**
 * Lee la estructura (campos) de un DBF.
 * @returns {{ registros:number, largoEncabezado:number, largoRegistro:number, codificacion:string, campos:Array }}
 */
export function leerEstructura(ruta) {
  const fd = fs.openSync(ruta, 'r');
  try {
    const h = Buffer.alloc(32);
    fs.readSync(fd, h, 0, 32, 0);
    const registros = h.readUInt32LE(4);
    const largoEncabezado = h.readUInt16LE(8);
    const largoRegistro = h.readUInt16LE(10);
    const codificacion = CODEPAGES[h[29]] || 'windows-1252';
    const buf = Buffer.alloc(largoEncabezado);
    fs.readSync(fd, buf, 0, largoEncabezado, 0);
    const campos = [];
    let offset = 1; // byte 0 de cada registro = marca de borrado
    for (let p = 32; p + 32 <= largoEncabezado && buf[p] !== 0x0d; p += 32) {
      const nombre = buf.toString('latin1', p, p + 11).replace(/\0.*$/s, '').trim().toUpperCase();
      const tipo = String.fromCharCode(buf[p + 11]);
      const largo = buf[p + 16];
      const decimales = buf[p + 17];
      campos.push({ nombre, tipo, largo, decimales, offset });
      offset += largo;
    }
    return { registros, largoEncabezado, largoRegistro, codificacion, campos };
  } finally {
    fs.closeSync(fd);
  }
}

const registroValido = (reg) => reg[0] === 0x20 || reg[0] === 0x2a;

function decodificar(buf, est, campo, decoder) {
  const { offset, largo, tipo } = campo;
  const s = () => decoder.decode(buf.subarray(offset, offset + largo)).replace(/\0/g, '').trim();
  switch (tipo) {
    case 'C': return s();
    case 'N':
    case 'F': {
      const t = s();
      return t === '' ? null : Number(t);
    }
    case 'D': {
      const t = s();
      return /^\d{8}$/.test(t) ? `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}` : null;
    }
    case 'L': {
      const c = String.fromCharCode(buf[offset]).toUpperCase();
      return c === 'T' || c === 'Y' || c === 'S' ? true : c === 'F' || c === 'N' ? false : null;
    }
    case 'I': return buf.readInt32LE(offset);
    case 'Y': return Number(buf.readBigInt64LE(offset)) / 10000;
    case 'B': return buf.readDoubleLE(offset);
    case 'T': {
      const jul = buf.readInt32LE(offset);
      const ms = buf.readInt32LE(offset + 4);
      if (!jul) return null;
      return new Date((jul - 2440588) * 86400000 + ms).toISOString();
    }
    default: return undefined; // Memo / General / binarios: no se usan en la cuadratura
  }
}

/**
 * Recorre los registros de un DBF.
 * @param {string} ruta
 * @param {{ campos?: string[], incluirBorrados?: boolean }} opciones  campos = subconjunto a leer
 * @yields {object} registro con { _borrado, ...campos }
 */
export function* leerRegistros(ruta, opciones = {}) {
  const est = leerEstructura(ruta);
  const decoder = new TextDecoder(est.codificacion);
  const filtro = opciones.campos?.map((c) => c.toUpperCase());
  const campos = filtro ? est.campos.filter((c) => filtro.includes(c.nombre)) : est.campos;
  const fd = fs.openSync(ruta, 'r');
  const memo = opciones.memos ? abrirMemo(ruta) : null;
  try {
    const LOTE = 512;
    const buf = Buffer.alloc(est.largoRegistro * LOTE);
    for (let i = 0; i < est.registros; i += LOTE) {
      const n = Math.min(LOTE, est.registros - i);
      const leidos = fs.readSync(fd, buf, 0, n * est.largoRegistro, est.largoEncabezado + i * est.largoRegistro);
      const completos = Math.floor(leidos / est.largoRegistro);
      for (let k = 0; k < completos; k++) {
        const reg = buf.subarray(k * est.largoRegistro, (k + 1) * est.largoRegistro);
        // Byte 0 válido: ' ' (activo) o '*' (borrado). Cualquier otro valor (0x1A, 0x00…) es un
        // registro dañado, frecuente en FoxPro tras un corte: se salta y se sigue leyendo.
        // El fin real lo marca la cantidad de registros del encabezado.
        if (!registroValido(reg)) continue;
        const borrado = reg[0] === 0x2a;
        if (borrado && !opciones.incluirBorrados) continue;
        const fila = { _borrado: borrado };
        for (const c of campos) {
          fila[c.nombre] = memo && (c.tipo === 'M' || c.tipo === 'G' || c.tipo === 'W')
            ? leerMemo(memo, reg, c, decoder)
            : decodificar(reg, est, c, decoder);
        }
        yield fila;
      }
    }
  } finally {
    fs.closeSync(fd);
    if (memo) fs.closeSync(memo.fd);
  }
}

// ---------- Campos memo (archivo .FPT de tablas, .FRT de reportes, .SCT de formularios) ----------

const EXT_MEMO = { '.dbf': '.fpt', '.frx': '.frt', '.lbx': '.lbt', '.scx': '.sct', '.vcx': '.vct', '.mnx': '.mnt' };

function abrirMemo(rutaTabla) {
  const ext = rutaTabla.slice(rutaTabla.lastIndexOf('.')).toLowerCase();
  const base = rutaTabla.slice(0, rutaTabla.lastIndexOf('.'));
  const dir = base.replace(/[\\/][^\\/]*$/, '');
  const nombre = base.slice(dir.length + 1).toLowerCase() + (EXT_MEMO[ext] ?? '.fpt');
  const archivo = fs.readdirSync(dir).find((f) => f.toLowerCase() === nombre);
  if (!archivo) return null;
  const fd = fs.openSync(`${dir}/${archivo}`, 'r');
  const h = Buffer.alloc(8);
  fs.readSync(fd, h, 0, 8, 0);
  return { fd, tamBloque: h.readUInt16BE(6) || 64 };
}

function leerMemo(memo, reg, campo, decoder) {
  // Visual FoxPro: puntero binario de 4 bytes; dBase/FoxPro 2: 10 dígitos ASCII
  const bloque = campo.largo === 4
    ? reg.readUInt32LE(campo.offset)
    : parseInt(reg.toString('latin1', campo.offset, campo.offset + campo.largo).trim() || '0', 10);
  if (!bloque) return '';
  const cab = Buffer.alloc(8);
  fs.readSync(memo.fd, cab, 0, 8, bloque * memo.tamBloque);
  const largo = cab.readUInt32BE(4);
  if (!largo || largo > 10_000_000) return '';
  const datos = Buffer.alloc(largo);
  fs.readSync(memo.fd, datos, 0, largo, bloque * memo.tamBloque + 8);
  return decoder.decode(datos).replace(/\0+$/, '');
}

/**
 * Recorre los registros desde el ÚLTIMO hacia el primero.
 * Útil para tablas históricas que crecen en orden cronológico (CLIDOCTO, CLIPAGOS): el que
 * llama corta la iteración (break) cuando los registros ya son demasiado antiguos, y así
 * solo se lee el final del archivo (clave cuando se lee por red).
 */
export function* leerRegistrosDesdeElFinal(ruta, opciones = {}) {
  const est = leerEstructura(ruta);
  const decoder = new TextDecoder(est.codificacion);
  const filtro = opciones.campos?.map((c) => c.toUpperCase());
  const campos = filtro ? est.campos.filter((c) => filtro.includes(c.nombre)) : est.campos;
  const fd = fs.openSync(ruta, 'r');
  try {
    const LOTE = 2048;
    const buf = Buffer.alloc(est.largoRegistro * LOTE);
    for (let fin = est.registros; fin > 0; fin -= LOTE) {
      const ini = Math.max(0, fin - LOTE);
      const n = fin - ini;
      const leidos = fs.readSync(fd, buf, 0, n * est.largoRegistro, est.largoEncabezado + ini * est.largoRegistro);
      const completos = Math.floor(leidos / est.largoRegistro);
      for (let k = completos - 1; k >= 0; k--) {
        const reg = buf.subarray(k * est.largoRegistro, (k + 1) * est.largoRegistro);
        if (!registroValido(reg)) continue;
        const borrado = reg[0] === 0x2a;
        if (borrado && !opciones.incluirBorrados) continue;
        const fila = { _borrado: borrado };
        for (const c of campos) fila[c.nombre] = decodificar(reg, est, c, decoder);
        yield fila;
      }
    }
  } finally {
    fs.closeSync(fd);
  }
}

/** Busca un archivo en una carpeta sin distinguir mayúsculas (Sisgen mezcla .DBF/.dbf). */
export function buscarArchivo(carpeta, nombre) {
  const objetivo = nombre.toLowerCase();
  const encontrado = fs.readdirSync(carpeta).find((f) => f.toLowerCase() === objetivo);
  return encontrado ? `${carpeta.replace(/[\\/]+$/, '')}/${encontrado}` : null;
}
