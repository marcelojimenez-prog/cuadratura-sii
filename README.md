# Cuadratura SII

Portal que junta las ventas de todas las sucursales Sisgen de una razón social y las cruza
directamente con el SII. Avisa qué documento falta, cuál fue rechazado (y por qué) y a qué
sucursal corresponde.

## Puesta en marcha

```bash
npm install
npm --prefix client install
npm run build        # compila la interfaz
npm start            # http://localhost:4100
```

Para desarrollo con recarga automática: `npm run dev` (interfaz en http://localhost:5180).

Sin `config/config.local.json` el sistema arranca en **modo demo** con una empresa ficticia.

## Configuración del cliente piloto

1. Copiar `config/config.example.json` a `config/config.local.json` (no se versiona).
2. Completar el RUT, la razón social, el certificado (.pfx y clave) y, por cada sucursal, las rutas
   `datos` (tablas DBF) y `procesos` (CAF en `procesos\Folios`, XML y logs de DTE).
3. Importar las ventas de un mes: `npm run importar -- 2026-10`.

## Estructura

| Ruta | Contenido |
|---|---|
| `server/lib/sisgen/` | Lector DBF propio, equivalencia de tipos Sisgen→SII e importación de F1 |
| `server/lib/sii/` | Conexión directa al SII (Fase 1, pendiente de certificado) |
| `server/lib/cuadratura/motor.js` | Cruce Sisgen vs SII, alertas, duplicados y saltos de folio |
| `server/db.js` | Base de datos (SQLite en el piloto, preparado para migrar a PostgreSQL) |
| `client/` | Portal web (React + Bootstrap) |
| `scripts/` | `npm run dbf -- <tabla.dbf>` inspecciona una tabla; `npm run importar` importa ventas |

## Pruebas

`npm test`: pruebas del motor de cuadratura.

## Pendientes

- **Fase 1:** autenticación con certificado, descarga del RCV, estado de DTE y envíos, y API de boletas.
- Confirmar la equivalencia de los tipos `NE`, `BT`, `NC`, `OV` y `FX` (`server/lib/sisgen/tipos.js`).
- Usuarios y permisos por razón social y sucursal.
- Agente en las sucursales para reemplazar la extracción por LogMeIn.
