// Consultas al SII hechas DESDE el servidor del cliente, con su propio certificado.
// El certificado y su clave nunca salen de este equipo: el portal pide una consulta y el agente
// devuelve solo la respuesta del SII. Solo se permiten consultas de lectura y siempre del RUT propio:
//   - Registro de Ventas (RCV): resumen y detalle del periodo
//   - Estado de una boleta (API de boletas)
//   - Estado de un envío por Track ID (DTE y boletas)
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Security.Cryptography.Xml;
using System.Text;
using System.Text.RegularExpressions;
using System.Xml;

namespace SisgenAgente
{
    public class RespuestaSii
    {
        public int Http;
        public string Cuerpo;
    }

    public class Sii
    {
        const string HostDte = "palena.sii.cl", HostApi = "api.sii.cl", HostRcv = "www4.sii.cl";
        readonly Config cfg;
        X509Certificate2 cert;
        string tokenDte, tokenBol;
        DateTime tokenDteHasta, tokenBolHasta;
        readonly object candado = new object();
        public string RutNumero, RutDv;
        public string EstadoCertificado = "sin revisar";
        // Certificado renovado: se vuelve a revisar la carpeta sin reiniciar el servicio
        string firmaCarpeta;
        DateTime ultimaRevisionCert = DateTime.Now, ultimaRecargaCert = DateTime.Now;

        public Sii(Config c) { cfg = c; }

        public void FijarRut(string rut)
        {
            if (string.IsNullOrEmpty(rut)) return;
            var p = rut.Replace(".", "").Trim().ToUpperInvariant().Split('-');
            if (p.Length == 2) { RutNumero = p[0]; RutDv = p[1]; }
        }

        // ---------- Certificado ----------

        /// <summary>
        /// Busca el certificado en procesos\certificado y su clave entre: el nombre de los archivos de
        /// texto de esa carpeta y los campos de clave de empres.dbf / prmsis.dbf. La clave nunca se
        /// registra ni se envía.
        /// </summary>
        public bool CargarCertificado()
        {
            firmaCarpeta = FirmaCarpeta();
            ultimaRecargaCert = DateTime.Now;
            // Opcional en agente.ini: certificado y clave indicados a mano (si la búsqueda automática no sirve)
            if (!string.IsNullOrEmpty(cfg.Certificado))
            {
                var c = AbrirPfx(cfg.Certificado, cfg.ClaveCertificado ?? "");
                if (c == null) { EstadoCertificado = "no se pudo abrir el certificado indicado en agente.ini"; return false; }
                return Usar(c);
            }
            string dir = Path.Combine(Path.GetDirectoryName(cfg.CarpetaDte), "certificado");
            if (!Directory.Exists(dir)) { EstadoCertificado = "no existe la carpeta procesos\\certificado"; return false; }
            var pfx = Directory.GetFiles(dir, "*.pfx").Concat(Directory.GetFiles(dir, "*.p12"))
                               .OrderByDescending(f => File.GetLastWriteTime(f)).ToList();
            if (pfx.Count == 0) { EstadoCertificado = "no hay certificado (.pfx) en procesos\\certificado"; return false; }
            var claves = ClavesPosibles(dir);
            X509Certificate2 mejor = null;
            foreach (var archivo in pfx)
                foreach (var clave in claves)
                {
                    var c = AbrirPfx(archivo, clave);
                    if (c == null) continue;
                    if (mejor == null || c.NotAfter > mejor.NotAfter) mejor = c;
                    break;
                }
            if (mejor == null) { EstadoCertificado = "no se pudo abrir el certificado (clave no encontrada)"; return false; }
            return Usar(mejor);
        }

        /// <summary>
        /// Cada 5 minutos mira si cambió la carpeta del certificado (archivo nuevo, reemplazado o clave nueva);
        /// si cambió, o si el certificado actual está vencido o no se pudo abrir (cada hora), lo vuelve a cargar.
        /// Así un certificado renovado se usa sin reiniciar el servicio.
        /// </summary>
        public void RevisarCertificado()
        {
            if ((DateTime.Now - ultimaRevisionCert).TotalMinutes < 5) return;
            ultimaRevisionCert = DateTime.Now;
            lock (candado)
            {
                bool valido = cert != null && cert.NotAfter >= DateTime.Now;
                bool cambio = FirmaCarpeta() != firmaCarpeta;
                if (!cambio && (valido || (DateTime.Now - ultimaRecargaCert).TotalMinutes < 60)) return;
                string antes = EstadoCertificado;
                try { CargarCertificado(); } catch (Exception e) { EstadoCertificado = "error: " + e.Message; }
                if (EstadoCertificado != antes) Log.Info("Certificado para consultas al SII actualizado: " + EstadoCertificado);
            }
        }

        string FirmaCarpeta()
        {
            try
            {
                var archivos = new List<string>();
                if (!string.IsNullOrEmpty(cfg.Certificado)) archivos.Add(cfg.Certificado);
                string dir = Path.Combine(Path.GetDirectoryName(cfg.CarpetaDte), "certificado");
                if (Directory.Exists(dir)) archivos.AddRange(Directory.GetFiles(dir));
                return string.Join("|", archivos.Where(File.Exists).OrderBy(a => a, StringComparer.OrdinalIgnoreCase)
                    .Select(a => { var i = new FileInfo(a); return i.Name + ":" + i.Length + ":" + i.LastWriteTimeUtc.Ticks; }));
            }
            catch { return null; }
        }

        static X509Certificate2 AbrirPfx(string archivo, string clave)
        {
            // Como servicio (cuenta del sistema) se usa el almacén del equipo; en una ventana, el del usuario
            foreach (var flags in new[] { X509KeyStorageFlags.MachineKeySet, X509KeyStorageFlags.UserKeySet })
            {
                try
                {
                    var c = new X509Certificate2(archivo, clave, flags);
                    if (c.HasPrivateKey) return c;
                }
                catch (CryptographicException) { }
            }
            return null;
        }

        bool Usar(X509Certificate2 mejor)
        {
            cert = mejor;
            tokenDte = tokenBol = null;
            EstadoCertificado = (cert.NotAfter < DateTime.Now ? "VENCIDO" : "ok") + "; vence " + cert.NotAfter.ToString("yyyy-MM-dd") +
                                "; " + Regex.Replace(cert.GetNameInfo(X509NameType.SimpleName, false) ?? "", @"\s+", " ");
            return cert.NotAfter >= DateTime.Now;
        }

        List<string> ClavesPosibles(string dirCertificado)
        {
            var claves = new List<string>();
            // 1) Archivo de texto cuyo nombre es la clave
            foreach (var f in Directory.GetFiles(dirCertificado, "*.txt")) claves.Add(Path.GetFileNameWithoutExtension(f));
            // 2) Campos de clave de empres.dbf y prmsis.dbf
            foreach (var tabla in new[] { "empres.dbf", "prmsis.dbf" })
            {
                string ruta = Ventas.Buscar(cfg.CarpetaDatos, tabla);
                if (ruta == null) continue;
                try
                {
                    using (var t = new TablaDbf(ruta))
                    {
                        var campos = t.Campos.Keys.Where(k => k.IndexOf("CLAVE", StringComparison.OrdinalIgnoreCase) >= 0 ||
                                                              k.IndexOf("PASS", StringComparison.OrdinalIgnoreCase) >= 0).ToList();
                        for (int i = 0; i < Math.Min(t.Registros, 5); i++)
                        {
                            var r = t.Leer(i);
                            if (r == null) continue;
                            foreach (var c in campos) { string v = r.Texto(c); if (v.Length > 0) claves.Add(v); }
                        }
                    }
                }
                catch { }
            }
            return claves.Distinct().ToList();
        }

        // ---------- Autenticación (semilla firmada con el certificado) ----------

        string FirmarSemilla(string semilla)
        {
            var doc = new XmlDocument { PreserveWhitespace = true };
            doc.LoadXml("<getToken><item><Semilla>" + semilla + "</Semilla></item></getToken>");
            var firmado = new SignedXml(doc) { SigningKey = cert.PrivateKey };
            firmado.SignedInfo.SignatureMethod = "http://www.w3.org/2000/09/xmldsig#rsa-sha1";
            var referencia = new Reference("") { DigestMethod = "http://www.w3.org/2000/09/xmldsig#sha1" };
            referencia.AddTransform(new XmlDsigEnvelopedSignatureTransform());
            firmado.AddReference(referencia);
            var info = new KeyInfo();
            info.AddClause(new RSAKeyValue((RSA)cert.PublicKey.Key));
            info.AddClause(new KeyInfoX509Data(cert));
            firmado.KeyInfo = info;
            firmado.ComputeSignature();
            doc.DocumentElement.AppendChild(doc.ImportNode(firmado.GetXml(), true));
            return "<?xml version=\"1.0\"?>" + doc.DocumentElement.OuterXml;
        }

        static string Etiqueta(string xml, string t)
        {
            var m = Regex.Match(xml ?? "", "<(?:\\w+:)?" + t + ">([^<]*)</(?:\\w+:)?" + t + ">");
            return m.Success ? m.Groups[1].Value.Trim() : null;
        }

        static string Desescapar(string s)
        {
            return s.Replace("&lt;", "<").Replace("&gt;", ">").Replace("&quot;", "\"").Replace("&apos;", "'").Replace("&amp;", "&");
        }

        RespuestaSii Soap(string servicio, string cuerpo)
        {
            string sobre = "<?xml version=\"1.0\" encoding=\"UTF-8\"?><soapenv:Envelope xmlns:soapenv=\"http://schemas.xmlsoap.org/soap/envelope/\"><soapenv:Body>" +
                           cuerpo + "</soapenv:Body></soapenv:Envelope>";
            return Http("POST", "https://" + HostDte + "/DTEWS/" + servicio, sobre, "text/xml; charset=utf-8", null,
                new Dictionary<string, string> { { "SOAPAction", "" } });
        }

        string TokenDte()
        {
            lock (candado)
            {
                if (tokenDte != null && DateTime.Now < tokenDteHasta) return tokenDte;
                if ((cert == null || cert.NotAfter < DateTime.Now) && !CargarCertificado()) throw new Exception("Certificado: " + EstadoCertificado);
                var rs = Soap("CrSeed.jws", "<getSeed></getSeed>");
                string interno = Desescapar(Etiqueta(rs.Cuerpo, "getSeedReturn") ?? rs.Cuerpo);
                string semilla = Etiqueta(interno, "SEMILLA");
                if (Etiqueta(interno, "ESTADO") != "00" || semilla == null) throw new Exception("SII: no entregó semilla (HTTP " + rs.Http + ")");
                var rt = Soap("GetTokenFromSeed.jws", "<getToken><pszXml><![CDATA[" + FirmarSemilla(semilla) + "]]></pszXml></getToken>");
                interno = Desescapar(Etiqueta(rt.Cuerpo, "getTokenReturn") ?? rt.Cuerpo);
                string token = Etiqueta(interno, "TOKEN");
                if (Etiqueta(interno, "ESTADO") != "00" || token == null)
                    throw new Exception("SII: no entregó token (" + Etiqueta(interno, "ESTADO") + " " + Etiqueta(interno, "GLOSA") + ")");
                tokenDte = token;
                tokenDteHasta = DateTime.Now.AddMinutes(45);
                return token;
            }
        }

        string TokenBoletas()
        {
            lock (candado)
            {
                if (tokenBol != null && DateTime.Now < tokenBolHasta) return tokenBol;
                if ((cert == null || cert.NotAfter < DateTime.Now) && !CargarCertificado()) throw new Exception("Certificado: " + EstadoCertificado);
                var rs = Http("GET", "https://" + HostApi + "/recursos/v1/boleta.electronica.semilla", null, null, null, null, "application/xml");
                string semilla = Etiqueta(rs.Cuerpo, "SEMILLA");
                if (semilla == null) throw new Exception("API boletas: no entregó semilla (HTTP " + rs.Http + ")");
                var rt = Http("POST", "https://" + HostApi + "/recursos/v1/boleta.electronica.token", FirmarSemilla(semilla), "application/xml", null, null, "application/xml");
                string token = Etiqueta(rt.Cuerpo, "TOKEN");
                if (token == null) throw new Exception("API boletas: no entregó token (HTTP " + rt.Http + " " + Etiqueta(rt.Cuerpo, "GLOSA") + ")");
                tokenBol = token;
                tokenBolHasta = DateTime.Now.AddMinutes(45);
                return token;
            }
        }

        // ---------- Consultas permitidas ----------

        /// <summary>Ejecuta una consulta pedida por el portal. Solo los tipos de la lista y siempre del RUT propio.</summary>
        public RespuestaSii Ejecutar(string tipo, Dictionary<string, string> p)
        {
            if (RutNumero == null) throw new Exception("RUT de la empresa aún no identificado");
            for (int intento = 1; ; intento++)
            {
                var r = EjecutarUnaVez(tipo, p);
                // Token vencido o rechazado: se pide uno nuevo y se reintenta una vez
                bool sinAutorizacion = r.Http == 401 || r.Http == 403 || (tipo == "rcv" && r.Cuerpo != null && r.Cuerpo.IndexOf("\"codRespuesta\":2", StringComparison.Ordinal) >= 0);
                if (!sinAutorizacion || intento >= 2) return r;
                lock (candado) { tokenDte = null; tokenBol = null; }
            }
        }

        RespuestaSii EjecutarUnaVez(string tipo, Dictionary<string, string> p)
        {
            switch (tipo)
            {
                case "rcv":
                    {
                        string metodo = p["metodo"];
                        if (metodo != "getResumen" && metodo != "getDetalleVenta") throw new Exception("Consulta RCV no permitida: " + metodo);
                        string token = TokenDte();
                        string data = p["data"];
                        // Siempre del RUT propio
                        if (!Regex.IsMatch(data, "\"rutEmisor\"\\s*:\\s*\"?" + RutNumero + "\"?[,}]")) throw new Exception("Consulta RCV de otro RUT");
                        if (!Regex.IsMatch(data, "\"operacion\"\\s*:\\s*\"VENTA\"")) throw new Exception("Solo se permite el registro de ventas");
                        string json = "{\"metaData\":{\"namespace\":\"cl.sii.sdi.lob.diii.consdcv.data.api.interfaces.FacadeService/" + metodo +
                                      "\",\"conversationId\":" + Json.Texto(token) + ",\"transactionId\":\"" + Guid.NewGuid() + "\",\"page\":null},\"data\":" + data + "}";
                        return Http("POST", "https://" + HostRcv + "/consdcvinternetui/services/data/facadeService/" + metodo, json, "application/json", token,
                            new Dictionary<string, string> { { "Origin", "https://" + HostRcv }, { "Referer", "https://" + HostRcv + "/consdcvinternetui/" } },
                            "application/json, text/plain, */*");
                    }
                case "boleta":
                    {
                        int t = int.Parse(p["tipo"]);
                        if (t != 39 && t != 41) throw new Exception("Tipo de boleta no válido");
                        string url = "https://" + HostApi + "/recursos/v1/boleta.electronica/" + RutNumero + "-" + RutDv + "-" + t + "-" + long.Parse(p["folio"]) +
                                     "/estado?rut_receptor=" + Uri.EscapeDataString(p["rutReceptor"]) + "&dv_receptor=" + Uri.EscapeDataString(p["dvReceptor"]) +
                                     "&monto=" + long.Parse(p["monto"]) + "&fechaEmision=" + Uri.EscapeDataString(p["fecha"]);
                        return Http("GET", url, null, null, TokenBoletas(), null, "application/json");
                    }
                case "envioDte":
                    {
                        string track = Regex.Replace(p["trackId"], @"\D", "");
                        var r = Soap("QueryEstUp.jws", "<getEstUp><RutCompania>" + RutNumero + "</RutCompania><DvCompania>" + RutDv +
                                     "</DvCompania><TrackId>" + track + "</TrackId><Token>" + TokenDte() + "</Token></getEstUp>");
                        r.Cuerpo = Desescapar(Etiqueta(r.Cuerpo, "getEstUpReturn") ?? r.Cuerpo);
                        return r;
                    }
                case "envioBoleta":
                    {
                        string track = Regex.Replace(p["trackId"], @"\D", "");
                        return Http("GET", "https://" + HostApi + "/recursos/v1/boleta.electronica.envio/" + RutNumero + "-" + RutDv + "-" + track,
                                    null, null, TokenBoletas(), null, "application/json");
                    }
                default:
                    throw new Exception("Consulta no permitida: " + tipo);
            }
        }

        static RespuestaSii Http(string metodo, string url, string cuerpo, string tipoContenido, string token,
                                 Dictionary<string, string> cabeceras, string acepta = null)
        {
            var req = (HttpWebRequest)WebRequest.Create(url);
            req.Method = metodo;
            req.Timeout = 120000;
            req.ReadWriteTimeout = 120000;
            req.UserAgent = "Mozilla/5.0 (SisgenAgente)";
            if (acepta != null) req.Accept = acepta;
            if (token != null) req.Headers["Cookie"] = "TOKEN=" + token;
            if (cabeceras != null)
                foreach (var kv in cabeceras)
                {
                    if (kv.Key == "Referer") req.Referer = kv.Value; // cabecera restringida en .NET
                    else req.Headers[kv.Key] = kv.Value;
                }
            if (cuerpo != null)
            {
                byte[] b = Encoding.UTF8.GetBytes(cuerpo);
                req.ContentType = tipoContenido;
                req.ContentLength = b.Length;
                using (var s = req.GetRequestStream()) s.Write(b, 0, b.Length);
            }
            HttpWebResponse resp;
            try { resp = (HttpWebResponse)req.GetResponse(); }
            catch (WebException e)
            {
                resp = e.Response as HttpWebResponse;
                if (resp == null) throw new Exception("Sin conexión con el SII: " + e.Message);
            }
            using (resp)
            using (var lector = new StreamReader(resp.GetResponseStream(), Encoding.UTF8))
                return new RespuestaSii { Http = (int)resp.StatusCode, Cuerpo = lector.ReadToEnd() };
        }
    }
}
