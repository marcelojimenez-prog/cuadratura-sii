// Autenticación con el SII mediante certificado digital (servicios SOAP DTEWS):
//   1. CrSeed.jws            -> getSeed: entrega una semilla
//   2. Se firma <getToken><item><Semilla>…</Semilla></item></getToken> con XML-DSig (RSA-SHA1)
//   3. GetTokenFromSeed.jws  -> getToken: entrega el TOKEN de sesión
// Producción: palena.sii.cl · Certificación: maullin.sii.cl
import crypto from 'node:crypto';
import forge from 'node-forge';

const HOSTS = { produccion: 'palena.sii.cl', certificacion: 'maullin.sii.cl' };
const USER_AGENT = 'Mozilla/4.0 ( compatible; PROG 1.0; Windows NT)';
const TIMEOUT_MS = 30000;

export class ErrorSii extends Error {
  constructor(paso, mensaje, detalle) {
    super(`${paso}: ${mensaje}`);
    this.name = 'ErrorSii';
    this.paso = paso;
    this.detalle = detalle;
  }
}

const desescapar = (s) =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const tag = (xml, t) => new RegExp(`<(?:\\w+:)?${t}>([^<]*)</(?:\\w+:)?${t}>`).exec(xml)?.[1]?.trim() ?? null;

async function soap(host, servicio, cuerpo) {
  const sobre =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body>' +
    cuerpo +
    '</soapenv:Body></soapenv:Envelope>';
  const res = await fetch(`https://${host}/DTEWS/${servicio}`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: '', 'User-Agent': USER_AGENT },
    body: sobre,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const texto = await res.text();
  if (!res.ok) throw new ErrorSii(servicio, `HTTP ${res.status}`, texto.slice(0, 500));
  return texto;
}

/** Pide una semilla al SII. */
export async function obtenerSemilla(ambiente = 'produccion') {
  const resp = await soap(HOSTS[ambiente], 'CrSeed.jws', '<getSeed></getSeed>');
  const interno = desescapar(tag(resp, 'getSeedReturn') ?? resp);
  const estado = tag(interno, 'ESTADO');
  const semilla = tag(interno, 'SEMILLA');
  if (estado !== '00' || !semilla) throw new ErrorSii('CrSeed', `estado ${estado ?? '?'}`, interno.slice(0, 500));
  return semilla;
}

const b64 = (bytes) => forge.util.encode64(bytes);
const bigB64 = (n) => {
  let h = n.toString(16);
  if (h.length % 2) h = '0' + h;
  return b64(forge.util.hexToBytes(h));
};

/**
 * Firma la semilla (XML-DSig enveloped, C14N, RSA-SHA1) tal como lo exige el SII.
 * @param {string} semilla
 * @param {{ cert, llave }} certificado objetos forge (ver certificado.js)
 */
export function firmarSemilla(semilla, { cert, llave }) {
  const documento = `<getToken><item><Semilla>${semilla}</Semilla></item></getToken>`;
  // Con la transformación enveloped-signature el digest se calcula sobre el documento sin <Signature>
  const digest = crypto.createHash('sha1').update(documento, 'utf8').digest('base64');

  const signedInfoInterno =
    '<CanonicalizationMethod Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"></CanonicalizationMethod>' +
    '<SignatureMethod Algorithm="http://www.w3.org/2000/09/xmldsig#rsa-sha1"></SignatureMethod>' +
    '<Reference URI=""><Transforms><Transform Algorithm="http://www.w3.org/2000/09/xmldsig#enveloped-signature"></Transform></Transforms>' +
    '<DigestMethod Algorithm="http://www.w3.org/2000/09/xmldsig#sha1"></DigestMethod>' +
    `<DigestValue>${digest}</DigestValue></Reference>`;
  // Forma canónica de SignedInfo: hereda el namespace de <Signature>, por eso se declara aquí
  const signedInfoCanonico = `<SignedInfo xmlns="http://www.w3.org/2000/09/xmldsig#">${signedInfoInterno}</SignedInfo>`;

  const md = forge.md.sha1.create();
  md.update(signedInfoCanonico, 'utf8');
  const firma = b64(llave.sign(md));
  const certDer = b64(forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes());

  const signature =
    '<Signature xmlns="http://www.w3.org/2000/09/xmldsig#">' +
    `<SignedInfo>${signedInfoInterno}</SignedInfo>` +
    `<SignatureValue>${firma}</SignatureValue>` +
    '<KeyInfo><KeyValue><RSAKeyValue>' +
    `<Modulus>${bigB64(cert.publicKey.n)}</Modulus><Exponent>${bigB64(cert.publicKey.e)}</Exponent>` +
    '</RSAKeyValue></KeyValue>' +
    `<X509Data><X509Certificate>${certDer}</X509Certificate></X509Data></KeyInfo>` +
    '</Signature>';

  return `<?xml version="1.0"?><getToken><item><Semilla>${semilla}</Semilla></item>${signature}</getToken>`;
}

/**
 * Obtiene un TOKEN de sesión del SII.
 * @returns {Promise<string>}
 */
export async function obtenerToken(certificado, ambiente = 'produccion') {
  const semilla = await obtenerSemilla(ambiente);
  const firmado = firmarSemilla(semilla, certificado);
  const resp = await soap(HOSTS[ambiente], 'GetTokenFromSeed.jws', `<getToken><pszXml><![CDATA[${firmado}]]></pszXml></getToken>`);
  const interno = desescapar(tag(resp, 'getTokenReturn') ?? resp);
  const estado = tag(interno, 'ESTADO');
  const token = tag(interno, 'TOKEN');
  if (estado !== '00' || !token) {
    throw new ErrorSii('GetTokenFromSeed', `estado ${estado ?? '?'} ${tag(interno, 'GLOSA') ?? ''}`.trim(), interno.slice(0, 500));
  }
  return token;
}
