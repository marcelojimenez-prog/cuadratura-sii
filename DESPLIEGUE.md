# Instalación del Portal Sisgen en un servidor (VPS)

Guía para quien instala el portal en el servidor. El portal es una aplicación Node.js con una base
de datos SQLite (un archivo). Los **agentes** de las sucursales se conectan al portal por HTTPS.

Se entregan dos cosas por separado:

| Qué | Cómo llega | Contenido |
|---|---|---|
| Código | Este repositorio de GitHub (privado) | Portal, interfaz y scripts |
| Paquete de datos `portal-datos-AAAAMMDD-HHMM.tar.gz` | Por un medio privado, nunca por correo ni GitHub | Base de datos, XML guardados, actualizaciones del agente y `config/config.local.json` |

> El paquete contiene datos de clientes. Guárdalo solo en el servidor y bórralo de cualquier otro lugar
> después de instalar.

## Requisitos

- **Linux (Ubuntu 22.04/24.04 recomendado)** o Windows Server 2019+.
- **Node.js 24** (usa `node:sqlite`; no sirve una versión menor a 22.5) y **git**.
- Un nombre para el portal, por ejemplo **`portal.sisgenchile.cl`**, con un registro DNS **A** apuntando a la IP del servidor.
- Puertos **80 y 443** abiertos hacia internet (el 80 solo se usa para obtener el certificado HTTPS).
  El puerto del portal (4100) **no** se abre: queda solo interno.
- Disco: unos **30 GB** libres para empezar. El paquete pesa unos 5 GB comprimido y bastante más
  descomprimido (base de datos de 1,2 GB, XML guardados y respaldos diarios).

---

## A) Linux (Ubuntu)

### 1. Node.js, git y Caddy (HTTPS automático)

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs git
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update && sudo apt-get install -y caddy
node -v   # debe decir v24.x
```

### 2. Usuario y código

```bash
sudo useradd --system --create-home --home-dir /opt/portal-sisgen portal
sudo -u portal git clone https://github.com/marcelojimenez-prog/cuadratura-sii.git /opt/portal-sisgen/app
cd /opt/portal-sisgen/app
sudo -u portal npm ci
sudo -u portal npm --prefix client ci
sudo -u portal npm run build
```

(El repositorio es privado: pide acceso al dueño o usa un *token* de GitHub de solo lectura al clonar.)

### 3. Datos

Copia el paquete al servidor (por ejemplo con `scp`) y descomprímelo **dentro de la carpeta del proyecto**:

```bash
cd /opt/portal-sisgen/app
sudo -u portal tar -xzf /ruta/al/portal-datos-AAAAMMDD-HHMM.tar.gz
ls data config   # debe aparecer data/cuadratura.db, data/xml y config/config.local.json
```

### 4. Probar

```bash
sudo -u portal npm start
# en otra consola:
curl http://127.0.0.1:4100/api/salud    # {"ok":true}
```

Detén la prueba con Ctrl+C.

### 5. Servicio (arranca solo)

Crear `/etc/systemd/system/portal-sisgen.service`:

```ini
[Unit]
Description=Portal Sisgen
After=network.target

[Service]
User=portal
WorkingDirectory=/opt/portal-sisgen/app
ExecStart=/usr/bin/node server/index.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now portal-sisgen
sudo systemctl status portal-sisgen
journalctl -u portal-sisgen -f      # registro en vivo
```

### 6. HTTPS con Caddy

`/etc/caddy/Caddyfile` (reemplaza el contenido):

```
portal.sisgenchile.cl {
    reverse_proxy 127.0.0.1:4100
    request_body {
        max_size 60MB
    }
}
```

```bash
sudo systemctl reload caddy
curl https://portal.sisgenchile.cl/api/salud    # {"ok":true}
```

Caddy obtiene y renueva solo el certificado HTTPS (el DNS ya debe apuntar al servidor).

### 7. Firewall

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

### 8. Respaldo diario de la base

```bash
sudo -u portal crontab -e
# agregar:
30 3 * * * cd /opt/portal-sisgen/app && /usr/bin/node scripts/respaldar-base.js >> data/respaldos.log 2>&1
```

Deja copias en `data/respaldos/` (últimos 14 días). Conviene además copiar esa carpeta fuera del servidor.

### 9. Actualizar el portal (cuando haya cambios en GitHub)

```bash
cd /opt/portal-sisgen/app
sudo -u portal git pull
sudo -u portal npm ci && sudo -u portal npm --prefix client ci && sudo -u portal npm run build
sudo systemctl restart portal-sisgen
```

---

## B) Windows Server

1. Instalar **Node.js 24 LTS** (nodejs.org) y **Git for Windows** (git-scm.com).
2. En PowerShell:
   ```powershell
   git clone https://github.com/marcelojimenez-prog/cuadratura-sii.git C:\PortalSisgen
   cd C:\PortalSisgen
   npm ci; npm --prefix client ci; npm run build
   tar -xzf C:\ruta\al\portal-datos-AAAAMMDD-HHMM.tar.gz
   npm start      # probar: http://127.0.0.1:4100/api/salud -> {"ok":true}; luego Ctrl+C
   ```
3. **Servicio:** con NSSM (nssm.cc):
   ```powershell
   nssm install PortalSisgen "C:\Program Files\nodejs\node.exe" "server\index.js"
   nssm set PortalSisgen AppDirectory C:\PortalSisgen
   nssm start PortalSisgen
   ```
4. **HTTPS:** Caddy para Windows (caddyserver.com) con el mismo `Caddyfile` del punto A.6, instalado
   como servicio (`nssm install Caddy C:\caddy\caddy.exe run --config C:\caddy\Caddyfile`).
5. **Firewall de Windows:** permitir entrada TCP 80 y 443; no abrir el 4100.
6. **Respaldo diario:** Programador de tareas, todos los días 03:30:
   `node C:\PortalSisgen\scripts\respaldar-base.js` (iniciar en `C:\PortalSisgen`).
7. **Actualizar:** `git pull`, `npm ci`, `npm --prefix client ci`, `npm run build` y reiniciar el servicio.

---

## Cambio desde el portal actual (corte)

1. En el equipo actual se genera el paquete: `node scripts/empaquetar-vps.js` →
   `paquete-vps/portal-datos-….tar.gz`. Se puede generar con el portal funcionando; demora varias
   horas por la cantidad de XML.
2. Instalar en el servidor con ese paquete (pasos de arriba) y comprobar `https://portal.sisgenchile.cl/api/salud`.
3. Entrar al portal con los mismos usuarios de siempre.
4. Cambiar la dirección en los agentes (`portal=https://portal.sisgenchile.cl` en `agente.ini` de cada
   sucursal y reiniciar el servicio "Agente Sisgen (Portal)"). Mientras tanto los agentes guardan lo pendiente
   y lo envían al reconectarse; no se pierde información.

## Qué NO va al servidor

- `config/firma-agente.pem`: llave para firmar las actualizaciones del agente. Se queda en el equipo donde
  se compila el agente; ahí se publican las versiones y luego se suben al servidor (`data/actualizaciones`).
- Certificados `.pfx` de clientes: las consultas al SII las hace cada agente con el certificado de su sucursal.
