// Inicio y cierre de sesión. La sesión viaja en una cookie HttpOnly (el navegador no la expone a JS).
import { Router } from 'express';
import { iniciarSesion, usuarioDeSesion, cerrarSesion, cambiarClavePropia, HORAS_SESION } from '../usuarios.js';
import { problemaClave } from '../lib/auth/claves.js';

export const COOKIE = 'cs_sesion';

export function leerCookie(req, nombre) {
  for (const parte of String(req.headers.cookie ?? '').split(';')) {
    const i = parte.indexOf('=');
    if (i > 0 && parte.slice(0, i).trim() === nombre) return decodeURIComponent(parte.slice(i + 1).trim());
  }
  return null;
}

const ipDe = (req) => req.ip ?? req.socket?.remoteAddress ?? null;

function fijarCookie(req, res, token) {
  const segura = req.secure || req.headers['x-forwarded-proto'] === 'https';
  const partes = [`${COOKIE}=${token ? encodeURIComponent(token) : ''}`, 'Path=/', 'HttpOnly', 'SameSite=Lax',
    token ? `Max-Age=${HORAS_SESION * 3600}` : 'Max-Age=0'];
  if (segura) partes.push('Secure');
  res.setHeader('Set-Cookie', partes.join('; '));
}

/** Middleware: exige sesión vigente; deja el usuario en req.usuario. */
export function requiereSesion(req, res, next) {
  const u = usuarioDeSesion(leerCookie(req, COOKIE));
  if (!u) return res.status(401).json({ error: 'Debes iniciar sesión' });
  req.usuario = u;
  // Con clave temporal solo se permite cambiarla
  if (u.debeCambiarClave && !req.originalUrl.startsWith('/api/auth/')) {
    return res.status(403).json({ error: 'Debes cambiar tu contraseña temporal', debeCambiarClave: true });
  }
  next();
}

export function requiereAdmin(req, res, next) {
  if (req.usuario?.rol !== 'admin') return res.status(403).json({ error: 'Solo administradores' });
  next();
}

// Freno por IP ante muchos intentos fallidos (además del bloqueo por cuenta)
const fallosPorIp = new Map();
const VENTANA_MS = 15 * 60000, MAX_FALLOS_IP = 20;
function ipFrenada(ip) {
  const f = fallosPorIp.get(ip);
  if (!f || Date.now() - f.desde > VENTANA_MS) return false;
  return f.n >= MAX_FALLOS_IP;
}
function anotarFallo(ip) {
  const f = fallosPorIp.get(ip);
  if (!f || Date.now() - f.desde > VENTANA_MS) fallosPorIp.set(ip, { n: 1, desde: Date.now() });
  else f.n++;
}

const r = Router();

r.post('/login', (req, res) => {
  const ip = ipDe(req);
  if (ipFrenada(ip)) return res.status(429).json({ error: 'Demasiados intentos. Espera unos minutos e inténtalo de nuevo.' });
  const { usuario, clave } = req.body ?? {};
  if (typeof usuario !== 'string' || typeof clave !== 'string' || !usuario || !clave) {
    return res.status(400).json({ error: 'Ingresa tu usuario y contraseña' });
  }
  const resultado = iniciarSesion(usuario.slice(0, 60), clave.slice(0, 200), ip);
  if (!resultado.ok) {
    anotarFallo(ip);
    const msg = {
      credenciales: 'Usuario o contraseña incorrectos',
      bloqueado: `Cuenta bloqueada temporalmente por intentos fallidos. Inténtalo en ${resultado.minutos} minutos o contacta a Sisgen.`,
      inactivo: 'Tu cuenta está desactivada. Contacta a Sisgen.',
    }[resultado.motivo];
    return res.status(401).json({ error: msg });
  }
  fijarCookie(req, res, resultado.token);
  res.json({ usuario: resultado.usuario });
});

r.post('/logout', (req, res) => {
  cerrarSesion(leerCookie(req, COOKIE));
  fijarCookie(req, res, null);
  res.json({ ok: true });
});

r.get('/yo', requiereSesion, (req, res) => res.json({ usuario: req.usuario }));

r.post('/cambiar-clave', requiereSesion, (req, res) => {
  const { actual, nueva } = req.body ?? {};
  const problema = problemaClave(nueva, req.usuario.usuario);
  if (problema) return res.status(400).json({ error: problema });
  if (actual === nueva) return res.status(400).json({ error: 'La contraseña nueva debe ser distinta de la actual' });
  if (!cambiarClavePropia(req.usuario.id, actual, nueva, leerCookie(req, COOKIE))) {
    return res.status(400).json({ error: 'La contraseña actual no es correcta' });
  }
  res.json({ usuario: { ...req.usuario, debeCambiarClave: false } });
});

export default r;
