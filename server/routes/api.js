import { Router } from 'express';
import { listarEmpresas } from '../db.js';
import { calcularCuadratura, estadoEmpresa } from '../lib/cuadratura/resumen.js';
import { documentoConSucursal } from '../db.js';
import { prepararDocumento } from '../lib/documentos/servicio.js';
import { cargarConfig } from '../config.js';
import authRouter, { requiereSesion } from './auth.js';
import adminRouter from './admin.js';
import { rutsPermitidos, puedeVer } from '../usuarios.js';

const r = Router();

r.get('/salud', (_req, res) => res.json({ ok: true }));
r.use('/auth', authRouter);

// Todo lo que sigue exige sesión iniciada
r.use(requiereSesion);
r.use('/admin', adminRouter);

/** Un RUT que el usuario no puede ver se responde igual que uno inexistente. */
const noEncontrado = (res) => res.status(404).json({ error: 'Razón social no encontrada' });

r.get('/empresas', (req, res) => res.json(listarEmpresas(rutsPermitidos(req.usuario))));

/** Resultado completo de cuadratura de una razón social en un periodo. */
r.get('/cuadratura/:rut/:periodo', (req, res) => {
  const { rut, periodo } = req.params;
  if (!/^\d{4}-\d{2}$/.test(periodo)) return res.status(400).json({ error: 'Periodo debe ser YYYY-MM' });
  if (!puedeVer(req.usuario, rut)) return noEncontrado(res);
  res.json(calcularCuadratura(rut, periodo));
});

/**
 * Página de inicio: estado de todas las razones sociales visibles para el usuario en un periodo
 * (por defecto, el último periodo con datos de cada una).
 */
r.get('/inicio', (req, res) => {
  const periodo = /^\d{4}-\d{2}$/.test(req.query.periodo ?? '') ? req.query.periodo : null;
  const empresas = listarEmpresas(rutsPermitidos(req.usuario));
  const filas = empresas.map((e) => estadoEmpresa(e, periodo));
  const periodos = [...new Set(empresas.flatMap((e) => e.periodos))].sort().reverse();
  res.json({ periodo, periodos, empresas: filas });
});

/**
 * Descarga del XML o del PDF (representación impresa) de un documento.
 * GET /api/documento/:rut/:tipo/:folio/xml|pdf?sucursal=Nombre
 */
r.get('/documento/:rut/:tipo/:folio/:formato', async (req, res, next) => {
  try {
    const { rut, formato } = req.params;
    const tipo = Number(req.params.tipo), folio = Number(req.params.folio);
    if (!/^\d{7,8}-[\dkK]$/.test(rut) || !Number.isInteger(tipo) || !Number.isInteger(folio) || !['xml', 'pdf'].includes(formato)) {
      return res.status(400).json({ error: 'Parámetros inválidos' });
    }
    if (!puedeVer(req.usuario, rut)) throw Object.assign(new Error('Documento no encontrado'), { status: 404 });
    const doc = documentoConSucursal(rut, tipo, folio, req.query.sucursal || null);
    if (!doc) throw Object.assign(new Error('Documento no encontrado en Sisgen'), { status: 404 });
    if (!doc.ruta_procesos) throw Object.assign(new Error('La sucursal no tiene configurada su carpeta procesos'), { status: 404 });
    // La lectura por red y el armado se hacen en un hilo aparte con tiempo máximo:
    // una sucursal sin conexión nunca bloquea el portal
    const datos = await prepararDocumento({
      formato, tipo, folio, fecha: doc.fecha, periodo: doc.periodo, tipoSisgen: doc.tipo_sisgen,
      sucursal: doc.sucursal, rutaDatos: doc.ruta_datos, rutaProcesos: doc.ruta_procesos,
      mostrarLogo: cargarConfig().empresas.find((e) => e.rut === rut)?.pdf?.mostrarLogo === true,
    });
    const nombre = `T${tipo}F${folio}`;
    if (formato === 'xml') {
      res.set('Content-Type', 'application/xml; charset=ISO-8859-1');
      res.set('Content-Disposition', `attachment; filename="${nombre}.xml"`);
    } else {
      res.set('Content-Type', 'application/pdf');
      res.set('Content-Disposition', `inline; filename="${nombre}.pdf"`);
    }
    return res.send(datos);
  } catch (e) {
    if (!e.status) return next(e);
    // Abierto desde el portal en una pestaña: página legible en vez de JSON
    if (req.accepts(['html', 'json']) === 'html') {
      const msg = String(e.message).replace(/[<>&]/g, '');
      return res.status(e.status).type('html').send(
        `<!doctype html><meta charset="utf-8"><title>Documento no disponible</title>` +
        `<body style="font-family:system-ui,sans-serif;max-width:560px;margin:15vh auto;padding:0 16px;color:#333">` +
        `<h2 style="color:#0b3c5d">Documento no disponible</h2><p>${msg}</p>` +
        `<p style="color:#777;font-size:14px">Puedes cerrar esta pestaña e intentarlo nuevamente en unos minutos.</p></body>`
      );
    }
    return res.status(e.status).json({ error: e.message });
  }
});

export default r;
