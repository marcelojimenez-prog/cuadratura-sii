import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { cargarConfig, RAIZ } from './config.js';
import { abrirDb, hayDatos } from './db.js';
import { cargarDemo } from './lib/demo.js';
import apiRouter from './routes/api.js';
import { hayUsuarios } from './usuarios.js';

const cfg = cargarConfig();
abrirDb(cfg.rutaBaseDatos);

if (!hayDatos()) {
  cargarDemo();
  console.log('[demo] Base vacía: se cargaron datos de ejemplo (empresa DEMO).');
}

if (!hayUsuarios()) {
  console.log('[acceso] No hay usuarios. Crea el administrador con:  npm run usuarios -- admin <usuario> "<Nombre>"');
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '100kb' }));
// Cabeceras básicas de seguridad
app.use((_req, res, next) => {
  res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin' });
  next();
});
app.use('/api', apiRouter);

// En producción se sirve la interfaz compilada (client/dist)
const dist = path.join(RAIZ, 'client', 'dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^\/(?!api).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
}

app.use((err, _req, res, _next) => {
  console.error(err);
  // No se exponen detalles internos (rutas de red, etc.) al navegador
  res.status(500).json({ error: 'Error interno del servidor' });
});

app.listen(cfg.puerto, () => {
  console.log(`Cuadratura SII escuchando en http://localhost:${cfg.puerto}`);
  if (!cfg.tieneConfigLocal) console.log('Sin config/config.local.json: modo demo.');
});
