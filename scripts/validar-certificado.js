// Valida localmente que la clave abre el certificado (.pfx) de una empresa y muestra a quién
// pertenece y su vigencia. NO contacta al SII. Nunca imprime la clave.
// Uso: node scripts/validar-certificado.js <rutEmpresa>
import { cargarConfig } from '../server/config.js';
import { cargarCertificado } from '../server/lib/sii/certificado.js';

const rut = process.argv[2];
const emp = cargarConfig().empresas.find((e) => e.rut === rut);
if (!emp?.certificado?.rutaPfx) {
  console.error(`Sin certificado configurado para ${rut}`);
  process.exit(1);
}
try {
  const c = cargarCertificado(emp.certificado);
  const hoy = new Date();
  console.log(JSON.stringify({
    clave: 'OK',
    titular: c.titular,
    rutTitular: c.rutTitular,
    emisor: c.emisor,
    validoDesde: c.validoDesde.toISOString().slice(0, 10),
    validoHasta: c.validoHasta.toISOString().slice(0, 10),
    vigente: hoy >= c.validoDesde && hoy <= c.validoHasta,
  }, null, 2));
} catch (e) {
  console.error(e.name === 'ClaveCertificadoIncorrecta' ? 'La clave NO abre el certificado' : `Error: ${e.message}`);
  process.exit(1);
}
