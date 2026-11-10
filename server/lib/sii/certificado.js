// Lectura del certificado digital (.pfx / PKCS#12) de la persona autorizada ante el SII.
// Se usa node-forge porque los certificados chilenos suelen venir con cifrado antiguo
// (RC2/3DES) que OpenSSL 3 ya no lee.
import fs from 'node:fs';
import forge from 'node-forge';

export class ClaveCertificadoIncorrecta extends Error {
  constructor() {
    super('La clave no abre el certificado');
    this.name = 'ClaveCertificadoIncorrecta';
  }
}

/**
 * Abre el .pfx y devuelve certificado, clave privada (objetos forge) y datos del titular.
 * @param {{ rutaPfx:string, clave:string }} conf
 */
export function cargarCertificado({ rutaPfx, clave }) {
  const der = fs.readFileSync(rutaPfx).toString('binary');
  let p12;
  try {
    p12 = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(der), false, clave ?? '');
  } catch (e) {
    if (/mac|password|decrypt|invalid/i.test(e.message)) throw new ClaveCertificadoIncorrecta();
    throw e;
  }
  const certs = p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] ?? [];
  const llaves = [
    ...(p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag] ?? []),
    ...(p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag] ?? []),
  ];
  if (!llaves.length) throw new Error('El certificado no contiene clave privada');
  const llave = llaves[0].key;
  // El certificado del titular es el que corresponde a la clave privada
  const cert = certs.map((b) => b.cert).find((c) => c.publicKey.n?.equals?.(llave.n)) ?? certs[0]?.cert;
  if (!cert) throw new Error('El archivo no contiene certificado');

  const attr = (lista, nombre) => lista.getField(nombre)?.value ?? null;
  const san = cert.getExtension('subjectAltName');
  const rutTitular =
    (san && JSON.stringify(san).match(/(\d{7,8}-[\dkK])/)?.[1]) ??
    attr(cert.subject, 'serialNumber') ?? null;

  return {
    cert,
    llave,
    titular: attr(cert.subject, 'CN'),
    rutTitular,
    emisor: attr(cert.issuer, 'O') ?? attr(cert.issuer, 'CN'),
    validoDesde: cert.validity.notBefore,
    validoHasta: cert.validity.notAfter,
  };
}
