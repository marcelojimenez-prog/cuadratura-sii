import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import express from 'express';
import { abrirDb, guardarEmpresa, guardarSucursal, getDb } from '../db.js';
import { generarLlaveAgente, activarAgente, xmlGuardado } from '../agentes.js';

abrirDb(':memory:');
const { default: agenteRouter } = await import('../routes/agente.js');

let servidor, base, llave, sucursalId;
before(async () => {
  guardarEmpresa({ rut: '11111111-1', razonSocial: 'Empresa A' });
  sucursalId = guardarSucursal({ rutEmpresa: '11111111-1', codigo: 'CASA', nombre: 'Casa matriz' });
  llave = generarLlaveAgente(sucursalId);
  const app = express();
  app.use('/api/agente', express.json({ limit: '8mb' }), agenteRouter);
  await new Promise((ok) => { servidor = app.listen(0, ok); });
  base = `http://127.0.0.1:${servidor.address().port}/api/agente`;
});
after(() => servidor.close());

const pedir = (ruta, cuerpo, k = llave) =>
  fetch(base + ruta, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${k}` }, body: JSON.stringify(cuerpo) })
    .then(async (r) => ({ status: r.status, json: await r.json() }));

const xml = (rut, tipo, folio, total) => `<?xml version="1.0" encoding="ISO-8859-1"?>
<DTE xmlns="http://www.sii.cl/SiiDte" version="1.0"><Documento ID="T${tipo}F${folio}"><Encabezado>
<IdDoc><TipoDTE>${tipo}</TipoDTE><Folio>${folio}</Folio><FchEmis>2026-11-12</FchEmis></IdDoc>
<Emisor><RUTEmisor>${rut}</RUTEmisor></Emisor><Receptor><RUTRecep>66666666-6</RUTRecep><RznSocRecep>Cliente Ñandú</RznSocRecep></Receptor>
<Totales><MntNeto>1000</MntNeto><IVA>190</IVA><MntTotal>${total}</MntTotal></Totales></Encabezado></Documento></DTE>`;
const archivo = (contenido, nombre = 'x.xml') => ({ nombre, contenido: zlib.gzipSync(Buffer.from(contenido, 'latin1')).toString('base64') });

test('sin llave válida no se acepta nada', async () => {
  assert.equal((await pedir('/hola', {}, 'sga_falsa')).status, 401);
  assert.equal((await pedir('/hola', {}, '')).status, 401);
});

test('hola registra el contacto y devuelve la sucursal', async () => {
  const r = await pedir('/hola', { version: '1.0.0', equipo: 'PC-CAJA' });
  assert.equal(r.status, 200);
  assert.equal(r.json.sucursal, 'Casa matriz');
  const a = getDb().prepare('SELECT version, equipo, ultimo_contacto FROM agentes WHERE sucursal_id = ?').get(sucursalId);
  assert.equal(a.equipo, 'PC-CAJA');
  assert.ok(a.ultimo_contacto);
});

test('las trazas crean el documento en línea y guardan el envío al SII', async () => {
  const r = await pedir('/trazas', { trazas: [
    { tipo: 39, folio: 500, fecha: '2026-11-12', monto: 5000, trackId: '24585795962', estadoEnvio: 'REC', estadoSii: 'DOK', detalleSii: 'Aceptado' },
    { tipo: 99, folio: 1, fecha: '2026-11-12' },
  ] });
  assert.deepEqual([r.json.guardadas, r.json.nuevos, r.json.descartadas], [1, 1, 1]);
  const d = getDb().prepare('SELECT periodo, tipo_sisgen, total, origen FROM docs_sisgen WHERE folio = 500').get();
  assert.deepEqual({ ...d }, { periodo: '2026-11', tipo_sisgen: 'BE', total: 5000, origen: 'AGENTE' });
  // repetir la misma traza no duplica
  assert.equal((await pedir('/trazas', { trazas: [{ tipo: 39, folio: 500, fecha: '2026-11-12', monto: 5000, estadoSii: 'DOK' }] })).json.nuevos, 0);
});

test('XML: se guarda comprimido y completa los montos; se rechaza el de otra razón social', async () => {
  const r = await pedir('/xml', { archivos: [archivo(xml('11111111-1', 33, 77, 1190), 'T33F77.xml'), archivo(xml('22222222-2', 33, 78, 1190))] });
  assert.equal(r.json.guardados, 1);
  assert.equal(r.json.rechazados[0].motivo, 'El XML es de otra razón social');
  const d = getDb().prepare('SELECT neto, iva, total, nombre_receptor FROM docs_sisgen WHERE folio = 77').get();
  assert.deepEqual([d.neto, d.iva, d.total, d.nombre_receptor], [1000, 190, 1190, 'Cliente Ñandú']);
  assert.match(xmlGuardado('11111111-1', 33, 77), /Cliente Ñandú/);
});

test('llave de instalación: el agente crea su razón social y sucursal dentro del cliente', async () => {
  const c = getDb().prepare("INSERT INTO clientes (nombre) VALUES ('Cliente Nuevo') RETURNING id").get();
  const { generarLlaveInstalacion } = await import('../agentes.js');
  const k = generarLlaveInstalacion(c.id);
  assert.equal((await pedir('/trazas', { trazas: [] }, k)).status, 409); // primero debe identificarse
  const r = await pedir('/hola', { empresa: { rut: '33.333.333-3', razonSocial: 'NUEVA SPA', nombreSistema: 'CASA CENTRAL' } }, k);
  assert.equal(r.status, 200);
  assert.deepEqual([r.json.rut, r.json.sucursal], ['33333333-3', 'Casa Central']);
  assert.equal(getDb().prepare('SELECT cliente_id FROM empresas WHERE rut = ?').get('33333333-3').cliente_id, c.id);
  // ya asociado: un RUT distinto se rechaza
  assert.equal((await pedir('/hola', { empresa: { rut: '44444444-4' } }, k)).status, 409);
  // otra llave de instalación no puede tomar la misma sucursal
  const k2 = generarLlaveInstalacion(c.id);
  assert.equal((await pedir('/hola', { empresa: { rut: '33333333-3', razonSocial: 'NUEVA SPA', nombreSistema: 'CASA CENTRAL' } }, k2)).status, 409);
});

test('ventas del mes: misma lógica que la importación por red y conserva lo llegado en línea', async () => {
  // documento en línea (traza) de un folio que F1 todavía no tiene
  await pedir('/trazas', { trazas: [{ tipo: 39, folio: 900, fecha: '2026-11-12', monto: 1000 }] });
  const r = await pedir('/mes', {
    periodo: '2026-11',
    f1: [
      { FATDOCTO: 'BE', FANUMERO: '500', FAFECHA: '2026-11-12', FATOTAL: 5000, FAAFECTO: 4202, FAIVA: 798, ELECTRON: 'S' },
      { FATDOCTO: 'BE', FANUMERO: '501', FAFECHA: '2026-11-12', FATOTAL: 3000, ELECTRON: 'S' },
    ],
    detalle: ['BE-500'],
    clidocto: [{ TDOCTO: 'FE', NUMFAC: '10', FECFAC: '2026-11-03', MONTO: 11900 }, { TDOCTO: 'FE', NUMFAC: '9', FECFAC: '2026-09-01', MONTO: 1 }],
    clipagos: [],
    xml: ['T39F500-20261112-100000.xml', 'T39F502-20261112-100500.xml'],
    xmlVecinos: ['T39F499-20261031-235900.xml'],
    cafs: [{ tipo: 39, desde: 1, hasta: 1000, archivo: 't39d1h1000.xml' }],
  });
  assert.equal(r.status, 200);
  const docs = getDb().prepare("SELECT tipo_sisgen, folio, en_blanco, sin_xml, origen FROM docs_sisgen WHERE sucursal_id = ? AND periodo = '2026-11' ORDER BY folio")
    .all(sucursalId).map((d) => `${d.tipo_sisgen}${d.folio}:${d.en_blanco}${d.sin_xml}:${d.origen}`);
  assert.ok(docs.includes('BE500:00:F1'));
  assert.ok(docs.includes('BE501:11:F1'), 'sin detalle en F2 y sin XML');
  assert.ok(docs.includes('FE10:11:F1'), 'en CLIDOCTO pero no en F1 = en blanco');
  assert.ok(docs.includes('BE502:10:F1'), 'XML sin registro = en blanco');
  assert.ok(docs.includes('BE900:00:AGENTE'), 'lo llegado en línea se conserva');
  assert.ok(!docs.some((d) => d.startsWith('FE9:')), 'CLIDOCTO de otro mes no entra');
  assert.equal(getDb().prepare('SELECT COUNT(*) n FROM caf_rangos WHERE sucursal_id = ?').get(sucursalId).n, 1);
});

test('historial: separa sobres con varios DTE, no pisa lo archivado y rechaza llaves privadas', async () => {
  const dte = (folio, total) => xml('11111111-1', 39, folio, total).replace(/^<\?xml[^>]*>\s*/, '').replace(' xmlns="http://www.sii.cl/SiiDte"', '');
  const sobre = `<?xml version="1.0" encoding="ISO-8859-1"?><EnvioBOLETA xmlns="http://www.sii.cl/SiiDte"><SetDTE>${dte(7001, 100)}${dte(7002, 200)}</SetDTE></EnvioBOLETA>`;
  const antiguo = xml('11111111-1', 33, 6000, 500).replace('2026-11-12', '2003-05-20');
  const r = await pedir('/xml', { historial: true, archivos: [archivo(sobre, 'envio.xml'), archivo(antiguo, 'viejo.xml'),
    archivo('<AUTORIZACION><CAF><DA><RE>11111111-1</RE></DA></CAF><RSASK>-----BEGIN RSA PRIVATE KEY-----</RSASK><DTE></DTE></AUTORIZACION>', 'caf.xml')] });
  assert.equal(r.json.guardados, 3);
  assert.match(r.json.rechazados[0].motivo, /llave privada/);
  assert.match(xmlGuardado('11111111-1', 39, 7002), /<DTE xmlns="http:\/\/www.sii.cl\/SiiDte"/);
  // el historial no aparece en la cuadratura del mes (solo se archiva)
  assert.equal(getDb().prepare('SELECT COUNT(*) n FROM docs_sisgen WHERE folio IN (7001, 6000)').get().n, 0);
  // y no reemplaza un XML ya archivado
  await pedir('/xml', { historial: true, archivos: [archivo(xml('11111111-1', 33, 77, 999999))] });
  assert.match(xmlGuardado('11111111-1', 33, 77), /<MntTotal>1190</);
  // anterior a 2001 no se guarda
  const r2 = await pedir('/xml', { historial: true, archivos: [archivo(xml('11111111-1', 33, 5, 1).replace('2026-11-12', '1999-01-01'))] });
  assert.equal(r2.json.guardados, 0);
});

test('un agente desactivado no puede enviar', async () => {
  activarAgente(sucursalId, false);
  assert.equal((await pedir('/hola', {})).status, 403);
  activarAgente(sucursalId, true);
  const nueva = generarLlaveAgente(sucursalId); // rotar la llave invalida la anterior
  assert.equal((await pedir('/hola', {})).status, 401);
  assert.equal((await pedir('/hola', {}, nueva)).status, 200);
});

test('un agente desactivado de la sucursal se reemplaza al instalar uno nuevo', async () => {
  const { generarLlaveInstalacion } = await import('../agentes.js');
  const c = getDb().prepare("INSERT INTO clientes (nombre) VALUES ('Cliente Reinstala') RETURNING id").get();
  const emp = { rut: '55555555-5', razonSocial: 'REINSTALA SPA', nombreSistema: 'LOCAL UNO' };
  const k1 = generarLlaveInstalacion(c.id);
  assert.equal((await pedir('/hola', { empresa: emp }, k1)).status, 200);
  const k2 = generarLlaveInstalacion(c.id);
  assert.equal((await pedir('/hola', { empresa: emp }, k2)).status, 409); // el primero sigue activo
  getDb().prepare("UPDATE agentes SET activo = 0 WHERE sucursal_id = (SELECT id FROM sucursales WHERE rut_empresa = '55555555-5')").run();
  assert.equal((await pedir('/hola', { empresa: emp }, k2)).status, 200);
  assert.equal((await pedir('/hola', {}, k1)).status, 401); // el antiguo ya no existe
});

test('documentos en blanco: el portal pide buscarlos en el backup y guarda lo que llevaban', async () => {
  const { reemplazarDocsSisgen, respaldosDocumentos } = await import('../db.js');
  const hoy = new Date().toISOString().slice(0, 10);
  reemplazarDocsSisgen(sucursalId, hoy.slice(0, 7), [
    { rutEmisor: '11111111-1', tipoSisgen: 'BE', tipoSii: 39, folio: 1124718, fecha: hoy, total: 1100, enBlanco: true },
    { rutEmisor: '11111111-1', tipoSisgen: 'BE', tipoSii: 39, folio: 1124719, fecha: hoy, total: 500 },
  ]);
  llave = generarLlaveAgente(sucursalId);
  const h = await pedir('/hola', { version: '1.6.1' });
  assert.deepEqual(h.json.respaldosPendientes.map((x) => x.folio), [1124718]);
  const r = await pedir('/respaldo', { docs: [{ documento: 'BE-1124718', lineas: [
    { CODIGO: '6655', DESCRI: 'CERV BUDWEISER BOT 660CC', OBSERV: '12:12:13  99999999-9', CANTID: 1, PRECIO: 1100, DESCTO: 0, MTOTAL: 1100, archivo: '20261009.dbf' },
  ] }] });
  assert.equal(r.json.encontrados, 1);
  const g = respaldosDocumentos('11111111-1').get('BE-1124718');
  assert.equal(g.hora, '12:12:13');
  assert.equal(g.total, 1100);
  assert.equal(g.lineas[0].descripcion, 'CERV BUDWEISER BOT 660CC');
  // Ya encontrado: no se vuelve a pedir
  assert.equal((await pedir('/hola', { version: '1.6.1' })).json.respaldosPendientes.length, 0);
});

test('documento corregido y republicado: el portal pide el mes al agente y consulta al SII', async () => {
  const { reemplazarDocsSisgen } = await import('../db.js');
  const { fijarConsultaPeriodo, _limpiar } = await import('../correcciones.js');
  fijarConsultaPeriodo(async () => {});
  llave = generarLlaveAgente(sucursalId);
  reemplazarDocsSisgen(sucursalId, '2026-09', [
    { rutEmisor: '11111111-1', tipoSisgen: 'FE', tipoSii: 33, folio: 4321, fecha: '2026-09-15', total: 1190, enBlanco: true, sinXml: true },
  ]);
  // XML nuevo de un documento que estaba en blanco
  await pedir('/xml', { archivos: [archivo(xml('11111111-1', 33, 4321, 1190).replace('2026-11-12', '2026-09-15'), 't33f4321-20261113-122435.xml')] });
  assert.deepEqual((await pedir('/hola', { version: '1.6.1' })).json.mesesUrgentes, ['2026-09']);
  // Un XML nuevo de un documento sin problemas no es una corrección, ni reenviar el mismo archivo
  await pedir('/xml', { archivos: [archivo(xml('11111111-1', 33, 4400, 1190), 't33f4400-20261112-100000.xml')] });
  await pedir('/xml', { archivos: [archivo(xml('11111111-1', 33, 4400, 1190), 't33f4400-20261112-100000.xml')] });
  assert.deepEqual((await pedir('/hola', { version: '1.6.1' })).json.mesesUrgentes, ['2026-09']);
  // Al llegar las ventas de ese mes deja de estar pendiente
  await pedir('/mes', { periodo: '2026-09', f1: [{ FATDOCTO: 'FE', FANUMERO: '4321', FAFECHA: '2026-09-15', FATOTAL: 1190, ELECTRON: 'S' }] });
  assert.deepEqual((await pedir('/hola', { version: '1.6.1' })).json.mesesUrgentes, []);
  // Republicado: un archivo más nuevo del mismo documento
  await pedir('/xml', { archivos: [archivo(xml('11111111-1', 33, 4400, 1190), 't33f4400-20261113-090000.xml')] });
  assert.deepEqual((await pedir('/hola', { version: '1.6.1' })).json.mesesUrgentes, ['2026-11']);
  _limpiar();
});

test('el agente reconoce la sucursal ya importada aunque empres.dbf tenga un nombre más largo', async () => {
  const { generarLlaveInstalacion } = await import('../agentes.js');
  const _g = guardarSucursal;
  const c = getDb().prepare("INSERT INTO clientes (nombre) VALUES ('Cliente Dos') RETURNING id").get();
  guardarEmpresa({ rut: '22222222-2', razonSocial: 'EMPRESA DOS' });
  const expo = _g({ rutEmpresa: '22222222-2', codigo: 'EXPOSICION', nombre: 'Exposición' });
  _g({ rutEmpresa: '22222222-2', codigo: 'AGATA', nombre: 'Agata' });
  const k = generarLlaveInstalacion(c.id);
  const r = await pedir('/hola', { empresa: { rut: '22222222-2', razonSocial: 'EMPRESA DOS', nombreSistema: 'TIENDA EXPOSICION' } }, k);
  assert.equal(r.status, 200);
  assert.equal(r.json.sucursal, 'Exposición');
  assert.equal(getDb().prepare("SELECT COUNT(*) n FROM sucursales WHERE rut_empresa = '22222222-2'").get().n, 2);
  assert.equal(getDb().prepare('SELECT a.sucursal_id FROM agentes a WHERE a.sucursal_id = ?').get(expo)?.sucursal_id, expo);
});

test('compras: guarda solo los XML recibidos por la razón social, una vez por documento', async () => {
  const { comprasPeriodo, rutaCompra } = await import('../db.js');
  llave = generarLlaveAgente(sucursalId);
  const compra = (emisor, receptor, folio, total) => `<?xml version="1.0" encoding="ISO-8859-1"?>
<EnvioDTE xmlns="http://www.sii.cl/SiiDte" version="1.0"><SetDTE ID="S"><Caratula version="1.0"><RutEmisor>${emisor}</RutEmisor></Caratula>
<DTE version="1.0"><Documento ID="T33F${folio}"><Encabezado><IdDoc><TipoDTE>33</TipoDTE><Folio>${folio}</Folio><FchEmis>2026-11-05</FchEmis></IdDoc>
<Emisor><RUTEmisor>${emisor}</RUTEmisor><RznSoc>PROVEEDOR ÑANDÚ SPA</RznSoc></Emisor><Receptor><RUTRecep>${receptor}</RUTRecep><RznSocRecep>Empresa A</RznSocRecep></Receptor>
<Totales><MntNeto>1000</MntNeto><IVA>190</IVA><MntTotal>${total}</MntTotal></Totales></Encabezado></Documento></DTE></SetDTE></EnvioDTE>`;
  const r = await pedir('/compras', { archivos: [
    archivo(compra('77777777-7', '11111111-1', 55, 1190), 'factura55.xml'),
    archivo(compra('77777777-7', '22222222-2', 56, 1190), 'otra-empresa.xml'),       // no es compra de esta razón social
    archivo('<RespuestaDTE>acuse</RespuestaDTE>', 'respuesta.xml'),                 // otro archivo del correo
    archivo(compra('77777777-7', '11111111-1', 55, 1190), 'factura55-copia.xml'),   // repetido
  ] });
  assert.equal(r.status, 200);
  assert.equal(r.json.ignorados, 2);
  const lista = comprasPeriodo('11111111-1', '2026-11');
  assert.equal(lista.length, 1);
  assert.deepEqual([lista[0].rutEmisor, lista[0].razonSocial, lista[0].folio, lista[0].total], ['77777777-7', 'PROVEEDOR ÑANDÚ SPA', 55, 1190]);
  assert.ok(rutaCompra('11111111-1', '77777777-7', 33, 55));
});
