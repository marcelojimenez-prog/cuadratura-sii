// Muestra la diagramación de un reporte de Visual FoxPro (.FRX) de Sisgen: bandas y objetos
// con su posición (mm), tamaño, fuente y expresión. Solo lectura.
// Uso: node scripts/inspeccionar-frx.js <ruta.frx>
import { leerRegistros } from '../server/lib/sisgen/dbf.js';

const ruta = process.argv[2];
const BANDAS = { 0: 'Título', 1: 'Encabezado de página', 2: 'Encabezado de columna', 3: 'Encabezado de grupo', 4: 'Detalle', 5: 'Pie de grupo', 6: 'Pie de columna', 7: 'Pie de página', 8: 'Resumen' };
const TIPOS = { 5: 'TEXTO', 6: 'LINEA', 7: 'CAJA', 8: 'CAMPO', 17: 'IMAGEN' };
const mm = (v) => Math.round((v / 10000) * 25.4 * 10) / 10; // 1/10000 de pulgada -> mm

const filas = [...leerRegistros(ruta, { memos: true })];
const rep = filas.find((f) => f.OBJTYPE === 1);
if (rep) console.log(`Reporte: ancho ${mm(rep.WIDTH)} mm, márgenes ${rep.TOPMARGIN ?? '-'} / ${rep.BOTMARGIN ?? '-'}, ${rep.EXPR?.split('\n').find((l) => /PAPERSIZE|ORIENTATION/i.test(l)) ?? ''}`);

let y = 0;
const bandas = filas.filter((f) => f.OBJTYPE === 9).map((b) => {
  const desde = y;
  y += b.HEIGHT;
  return { nombre: BANDAS[b.OBJCODE] ?? `Banda ${b.OBJCODE}`, desde, hasta: y, alto: b.HEIGHT, expr: b.EXPR };
});
for (const b of bandas) {
  console.log(`\n=== ${b.nombre}  (alto ${mm(b.alto)} mm)${b.expr ? '  grupo: ' + b.expr : ''}`);
  const objs = filas
    .filter((f) => TIPOS[f.OBJTYPE] && f.VPOS >= b.desde && f.VPOS < b.hasta)
    .sort((a, c) => a.VPOS - c.VPOS || a.HPOS - c.HPOS);
  for (const o of objs) {
    const pos = `y=${mm(o.VPOS - b.desde)} x=${mm(o.HPOS)} w=${mm(o.WIDTH)} h=${mm(o.HEIGHT)}`;
    const fuente = o.FONTFACE ? ` ${o.FONTFACE} ${o.FONTSIZE}${o.FONTSTYLE & 1 ? ' negrita' : ''}${o.FONTSTYLE & 2 ? ' cursiva' : ''}` : '';
    const color = o.PENRED >= 0 && (o.PENRED || o.PENGREEN || o.PENBLUE) ? ` color(${o.PENRED},${o.PENGREEN},${o.PENBLUE})` : '';
    const expr = (o.EXPR || o.PICTURE || o.NAME || '').replace(/\s+/g, ' ').slice(0, 140);
    const cond = o.SUPEXPR ? `  [imprimir si: ${o.SUPEXPR.replace(/\s+/g, ' ').slice(0, 80)}]` : '';
    console.log(`  ${TIPOS[o.OBJTYPE].padEnd(6)} ${pos.padEnd(36)}${fuente}${color}  ${expr}${o.PICTURE && o.OBJTYPE === 8 ? '  formato ' + o.PICTURE : ''}${cond}`);
  }
}
