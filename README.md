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

## Agente Sisgen (sucursales)

Servicio de Windows (C# / .NET 4, `agente/`) que se instala en el servidor de cada sucursal. **Solo lee** Sisgen:

- ventas del mes (F1, F2, CLIDOCTO, CLIPAGOS), XML emitidos, seguimiento de envío (trazadte / trazabol) y CAF;
- compras: XML de `procesos\DTE\intercambio\Recibidos`;
- detalle de documentos en blanco (carpeta `backup` de la estación y tabla DT);
- consultas al SII con el certificado del cliente, que nunca sale del equipo.

Compilar: `agente\compilar.bat` (genera `dist\SisgenAgente.exe` y el instalador `dist\InstalarAgenteSisgen.exe`).

**Actualización en línea:** `node scripts/publicar-agente.js --solo <ids>` firma y publica `dist\SisgenAgente.exe`;
cada agente lo descarga, verifica la firma (RSA, llave pública en `agente/src/LlavePublica.cs`) y se reinicia.
Si la versión nueva no se conecta, vuelve sola a la anterior. La llave privada (`config/firma-agente.pem`) no se versiona.

**Cambio de carpeta a distancia:** un archivo `data/agentes/carpeta-<id>.json` (`{"id": "...", "sisgen": "C:\SisGen"}`)
hace que el agente cambie su carpeta de Sisgen (verifica que sea el mismo RUT) y se reinicie.

## Pruebas

`npm test`: pruebas del motor de cuadratura, del agente y de las actualizaciones.

## Pendientes

- **Mudanza a un VPS** con dirección propia (p. ej. `portal.sisgenchile.cl`) y HTTPS: el túnel de pruebas
  (Dev Tunnels) tiene un límite mensual de transferencia.
- Agente 1.6.11: dirección de respaldo del portal y cambio de dirección a distancia; historiales más livianos.
- Agentes 1.5.0 (sin actualización en línea): reinstalar.
- Permisos de técnicos, firma de código del agente y base de datos PostgreSQL para todos los clientes.
