// Datos de EJEMPLO para ver el portal funcionando antes de tener datos reales.
// Empresa ficticia con 3 sucursales y problemas sembrados a propósito.
import { guardarEmpresa, guardarSucursal, reemplazarDocsSisgen, guardarDocsSii, reemplazarRangosCaf } from '../db.js';

const RUT = '11111111-1';

function prng(semilla) {
  let s = semilla >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

const CLIENTES = [
  ['76123456-7', 'DISTRIBUIDORA LOS ANDES SPA'], ['77234567-8', 'RESTAURANT EL PUERTO LTDA'],
  ['78345678-9', 'COMERCIAL SANTA ROSA SPA'], ['79456789-0', 'MINIMARKET DOÑA ANA'],
  ['96567890-1', 'SERVICIOS INTEGRALES DEL NORTE S.A.'], ['76678901-2', 'HOTEL VISTA MAR SPA'],
];

export function cargarDemo() {
  guardarEmpresa({ rut: RUT, razonSocial: 'DEMO COMERCIAL SPA (datos de ejemplo)', esDemo: true });
  const sucursales = [
    { codigo: 'MATRIZ', nombre: 'Casa Matriz' },
    { codigo: 'CENTRO', nombre: 'Sucursal Centro' },
    { codigo: 'NORTE', nombre: 'Sucursal Norte' },
  ].map((s) => ({ ...s, id: guardarSucursal({ rutEmpresa: RUT, ...s }) }));

  // Cada sucursal carga su propio CAF por tipo (como en procesos\Folios)
  const TAMANO = { 33: 500, 61: 100, 39: 20000 };
  const BASE = { 33: 15001, 61: 901, 39: 480001 };
  const folios = {}; // tipo -> codigoSucursal -> último folio usado
  for (const tipo of Object.keys(TAMANO).map(Number)) {
    folios[tipo] = {};
    sucursales.forEach((s, i) => {
      const desde = BASE[tipo] + i * TAMANO[tipo];
      folios[tipo][s.codigo] = desde - 1;
      s.cafs = [...(s.cafs || []), { tipoSii: tipo, desde, hasta: desde + TAMANO[tipo] - 1, archivo: `t${tipo}d${desde}h${desde + TAMANO[tipo] - 1}.xml` }];
    });
  }
  for (const s of sucursales) reemplazarRangosCaf(s.id, RUT, s.cafs);

  const periodos = ['2026-09', '2026-10'];
  periodos.forEach((periodo, ip) => {
    const rnd = prng(42 + ip);
    const [anio, mes] = periodo.split('-').map(Number);
    const dias = new Date(anio, mes, 0).getDate();
    const sisgenPorSuc = new Map(sucursales.map((s) => [s.id, []]));
    const sii = [];

    const emitir = (tipoSisgen, tipoSii, cantidad, montoMin, montoMax, conCliente, forzar = null) => {
      for (let i = 0; i < cantidad; i++) {
        // forzar = { emisor, rangoDe }: la sucursal emisora usa un folio del rango de otra
        const suc = forzar?.emisor ?? sucursales[Math.floor(rnd() * sucursales.length)];
        const folio = ++folios[tipoSii][(forzar?.rangoDe ?? suc).codigo];
        const total = Math.round(montoMin + rnd() * (montoMax - montoMin));
        const neto = Math.round(total / 1.19);
        const cli = conCliente ? CLIENTES[Math.floor(rnd() * CLIENTES.length)] : [null, null];
        const fecha = `${periodo}-${String(1 + Math.floor(rnd() * dias)).padStart(2, '0')}`;
        const doc = { rutEmisor: RUT, tipoSisgen, tipoSii, folio, fecha, rutReceptor: cli[0], nombreReceptor: cli[1],
          neto, exento: 0, iva: total - neto, total };
        sisgenPorSuc.get(suc.id).push(doc);
        sii.push({ rutEmisor: RUT, periodo, tipoSii, folio, fecha, rutReceptor: cli[0], total,
          estado: tipoSii === 39 ? 'ACEPTADO' : 'REGISTRADO', fuente: 'DEMO' });
      }
    };
    emitir('FE', 33, 140, 25000, 2500000, true);
    emitir('NE', 61, 9, 5000, 300000, true);
    emitir('BE', 39, 420, 1500, 60000, false);

    // ---- Problemas sembrados ----
    const quitarDeSii = (tipo, n) => {
      const cands = sii.filter((d) => d.tipoSii === tipo);
      for (let i = 0; i < n; i++) sii.splice(sii.indexOf(cands[Math.floor(rnd() * cands.length)]), 1);
    };
    const marcar = (tipo, estado, motivo) => {
      const cands = sii.filter((d) => d.tipoSii === tipo && d.estado !== 'RECHAZADO' && d.estado !== 'REPARO');
      const d = cands[Math.floor(rnd() * cands.length)];
      d.estado = estado; d.motivo = motivo;
    };
    quitarDeSii(33, ip === 0 ? 1 : 3);
    quitarDeSii(39, 2);
    marcar(33, 'RECHAZADO', 'RUT del receptor no válido o no corresponde');
    marcar(61, 'RECHAZADO', 'Documento de referencia no existe en el SII');
    if (ip === 1) {
      marcar(33, 'RECHAZADO', 'Folio fuera del rango autorizado (CAF)');
      marcar(33, 'REPARO', 'Monto de IVA no cuadra con el neto informado');
      const d = sii.find((x) => x.tipoSii === 33 && x.estado === 'REGISTRADO');
      d.total += 11900; // diferencia de monto
      // Sucursal Centro se quedó sin folios y usó 2 del rango de Sucursal Norte
      emitir('FE', 33, 2, 80000, 900000, true, { emisor: sucursales[1], rangoDe: sucursales[2] });
      sii.push({ rutEmisor: RUT, periodo, tipoSii: 33, folio: ++folios[33].MATRIZ, fecha: `${periodo}-28`,
        rutReceptor: CLIENTES[0][0], total: 357000, estado: 'REGISTRADO', fuente: 'DEMO' }); // solo en SII
      // folio duplicado entre sucursales
      const dup = sisgenPorSuc.get(sucursales[0].id).find((x) => x.tipoSii === 33);
      sisgenPorSuc.get(sucursales[2].id).push({ ...dup });
      // salto de folios: se eliminan 3 boletas de Sisgen y del SII
      const sucN = sisgenPorSuc.get(sucursales[1].id);
      const bol = sucN.filter((x) => x.tipoSii === 39).slice(10, 13);
      for (const b of bol) {
        sucN.splice(sucN.indexOf(b), 1);
        const i = sii.findIndex((x) => x.tipoSii === 39 && x.folio === b.folio);
        if (i >= 0) sii.splice(i, 1);
      }
    }

    // documentos en blanco (no quedaron completos en F1/F2)
    const sucC = sisgenPorSuc.get(sucursales[1].id).filter((x) => x.tipoSii === 33);
    sucC.slice(5, ip === 0 ? 6 : 8).forEach((x) => (x.enBlanco = true));

    for (const s of sucursales) reemplazarDocsSisgen(s.id, periodo, sisgenPorSuc.get(s.id));
    guardarDocsSii(sii);
  });
}
