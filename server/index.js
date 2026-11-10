import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { cargarConfig, RAIZ } from './config.js';
import { abrirDb, hayDatos } from './db.js';
import { cargarDemo } from './lib/demo.js';
import apiRouter from './routes/api.js';

const cfg = cargarConfig();
abrirDb(cfg.rutaBaseDatos);

if (!hayDatos()) {
  cargarDemo();
  console.log('[demo] Base vacía: se cargaron datos de ejemplo (empresa DEMO).');
}

const app = express();
app.use(express.json());
app.use('/api', apiRouter);

// En producción se sirve la interfaz compilada (client/dist)
const dist = path.join(RAIZ, 'client', 'dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^\/(?!api).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
}

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: err.message });
});

app.listen(cfg.puerto, () => {
  console.log(`Cuadratura SII escuchando en http://localhost:${cfg.puerto}`);
  if (!cfg.tieneConfigLocal) console.log('Sin config/config.local.json: modo demo.');
});
