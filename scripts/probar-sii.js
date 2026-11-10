// Prueba la autenticación con el SII usando el certificado configurado para una empresa.
// Solo pide semilla y token: no envía ni modifica nada en el SII. No imprime el token completo.
// Uso: node scripts/probar-sii.js <rutEmpresa>
import { cargarConfig } from '../server/config.js';
import { cargarCertificado } from '../server/lib/sii/certificado.js';
import { obtenerSemilla, obtenerToken } from '../server/lib/sii/autenticacion.js';

const rut = process.argv[2];
const cfg = cargarConfig();
const emp = cfg.empresas.find((e) => e.rut === rut);
if (!emp?.certificado?.rutaPfx) {
  console.error(`Sin certificado configurado para ${rut}`);
  process.exit(1);
}
const ambiente = cfg.sii?.ambiente ?? 'produccion';
try {
  const cert = cargarCertificado(emp.certificado);
  console.log(`Certificado: ${cert.titular} (${cert.rutTitular}) · ambiente ${ambiente}`);
  const semilla = await obtenerSemilla(ambiente);
  console.log(`1. Semilla recibida del SII: ${semilla}`);
  const token = await obtenerToken(cert, ambiente);
  console.log(`2. TOKEN recibido: ${token.slice(0, 3)}${'*'.repeat(Math.max(0, token.length - 3))} (${token.length} caracteres)`);
  console.log('Autenticación con el SII: OK');
} catch (e) {
  console.error(`Autenticación con el SII: FALLÓ\n  ${e.message}`);
  if (e.detalle) console.error(`  Respuesta SII: ${e.detalle}`);
  process.exit(1);
}
