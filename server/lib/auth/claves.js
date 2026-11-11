// Contraseñas: hash scrypt con sal aleatoria (nunca se guardan en texto).
// Formato: scrypt$N$r$p$sal(base64)$hash(base64)
import crypto from 'node:crypto';

const N = 16384, R = 8, P = 1, LARGO = 64;

export function hashClave(clave) {
  const sal = crypto.randomBytes(16);
  const h = crypto.scryptSync(String(clave), sal, LARGO, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${sal.toString('base64')}$${h.toString('base64')}`;
}

export function verificarClave(clave, guardado) {
  const partes = String(guardado ?? '').split('$');
  if (partes.length !== 6 || partes[0] !== 'scrypt') return false;
  const [, n, r, p, sal, hash] = partes;
  const esperado = Buffer.from(hash, 'base64');
  const h = crypto.scryptSync(String(clave), Buffer.from(sal, 'base64'), esperado.length, { N: Number(n), r: Number(r), p: Number(p) });
  return crypto.timingSafeEqual(h, esperado);
}

/** Reglas mínimas para una contraseña nueva. Devuelve el problema o null si es válida. */
export function problemaClave(clave, usuario = '') {
  const c = String(clave ?? '');
  if (c.length < 8) return 'Debe tener al menos 8 caracteres';
  if (!/[a-zA-Z]/.test(c) || !/\d/.test(c)) return 'Debe combinar letras y números';
  if (usuario && c.toLowerCase().includes(String(usuario).toLowerCase())) return 'No puede contener el nombre de usuario';
  return null;
}

/** Contraseña temporal legible (sin caracteres confundibles: 0/O, 1/l/I). */
export function claveTemporal(largo = 10) {
  const letras = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ', digitos = '23456789';
  const todos = letras + digitos;
  const elegir = (s) => s[crypto.randomInt(s.length)];
  const c = [elegir(letras), elegir(digitos), ...Array.from({ length: largo - 2 }, () => elegir(todos))];
  for (let i = c.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [c[i], c[j]] = [c[j], c[i]]; }
  return c.join('');
}

export const tokenSesion = () => crypto.randomBytes(32).toString('base64url');
export const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
