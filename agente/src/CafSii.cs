// Pedido de folios (CAF) al SII por la página de timbraje electrónico, con el certificado de la sucursal.
// Flujo de la página: of_solicita_folios_dcto (RUT y documento) -> of_confirma_folio (propone el rango, no genera)
// -> of_genera_folio (GENERA) -> descarga del XML del CAF.
// Candado: mientras SoloCertificacion esté activo, solo se habla con maullin (ambiente de certificación); el
// ambiente se toma de empres.dbf (AMBIENTE = maullin / palena). El XML del CAF contiene la llave privada (RSASK):
// se guarda tal cual en la cola local del agente y nunca se registra ni se envía a ninguna parte.
using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Text.RegularExpressions;
using System.Xml;

namespace SisgenAgente
{
    public class PropuestaCaf
    {
        public int Tipo, Cantidad;
        public long Desde, Hasta, Disponible, MaximoAutorizado;
        public string Mensaje;
        public Dictionary<string, string> Formulario;
    }

    public class CafSii : IDisposable
    {
        public static bool SoloCertificacion = true;
        static readonly Encoding Latin = Encoding.GetEncoding(28591);

        readonly string carpetaDatos;
        readonly Sii sii;
        public string Host, RutNumero, RutDv;
        X509Certificate2 cert;
        CookieContainer galletas;

        /// <param name="carpetaSisgen">Carpeta de Sisgen (de ahí se usan datos\ y procesos\certificado)</param>
        public CafSii(string carpetaSisgen, string carpetaDatos = null)
        {
            this.carpetaDatos = carpetaDatos ?? Path.Combine(carpetaSisgen, "datos");
            sii = new Sii(new Config { Sisgen = carpetaSisgen, CarpetaDatos = this.carpetaDatos, CarpetaDte = Path.Combine(carpetaSisgen, "procesos", "DTE") });
            string ambiente = null, rut = null;
            string ruta = Ventas.Buscar(this.carpetaDatos, "empres.dbf");
            if (ruta == null) throw new Exception("No está empres.dbf en " + this.carpetaDatos);
            using (var t = new TablaDbf(ruta))
            {
                var r = t.Registros > 0 ? t.Leer(0) : null;
                if (r != null) { ambiente = r.Texto("AMBIENTE").Trim().ToLowerInvariant(); rut = r.Texto("DTERUT"); }
            }
            if (ambiente != "maullin" && ambiente != "palena") throw new Exception("Ambiente de empres.dbf no reconocido: '" + ambiente + "'");
            if (ambiente == "palena" && SoloCertificacion) throw new Exception("La empresa está en producción (palena) y el pedido de folios está limitado a certificación.");
            Host = ambiente + ".sii.cl";
            var p = (rut ?? "").Replace(".", "").Trim().ToUpperInvariant().Split('-');
            if (p.Length != 2 || !Regex.IsMatch(p[0], @"^\d{6,8}$")) throw new Exception("RUT de empres.dbf no válido");
            RutNumero = p[0]; RutDv = p[1];
        }

        public string EstadoCertificado { get { return sii.EstadoCertificado; } }

        void Entrar()
        {
            if (galletas != null) return;
            ServicePointManager.SecurityProtocol |= (SecurityProtocolType)3072; // TLS 1.2
            cert = sii.CertificadoTls();
            galletas = new CookieContainer();
            string destino = "https://" + Host + "/cvc_cgi/dte/of_solicita_folios";
            string pagina = Post("https://herculesr.sii.cl/cgi_AUT2000/CAutInicio.cgi?" + destino, "referencia=" + Uri.EscapeDataString(destino));
            if (galletas.GetCookies(new Uri("https://" + Host + "/")).Count == 0 || galletas.GetCookies(new Uri("https://" + Host + "/"))["TOKEN"] == null)
            {
                galletas = null;
                // Se guarda la página que respondió el SII (para saber el motivo real) y se incluye su texto en el error
                Guardar(Path.Combine(Program.Carpeta, "logs"), "sii_login_rechazado.html", pagina);
                string motivo = Texto(pagina);
                motivo = Regex.Replace(motivo, @"var msg = '.*?';", "");
                if (motivo.Length > 300) motivo = motivo.Substring(0, 300) + "…";
                throw new Exception("El SII no dejó entrar con el certificado (" + sii.EstadoCertificado + "). Respuesta del SII: «" + motivo + "»");
            }
        }

        /// <summary>
        /// Cierra la sesión en el SII ("Cerrar Sesión" del sitio). El SII permite máximo 10 sesiones abiertas por persona,
        /// así que el agente no debe dejar ninguna abierta: si no, las demás sucursales y el navegador no pueden entrar.
        /// </summary>
        public void Salir()
        {
            if (galletas == null) return;
            try { PostBytes("https://zeusr.sii.cl/cgi_AUT2000/autTermino.cgi", null); }
            catch (Exception e) { Log.Error("Folios: no se pudo cerrar la sesión del SII: " + e.Message); }
            galletas = null;
        }

        public void Dispose() { Salir(); }

        /// <summary>Solo entra al SII con el certificado y vuelve a salir (prueba; no consulta ni pide folios).</summary>
        public void ProbarEntrada()
        {
            Entrar();
            Salir();
        }

        /// <summary>Pregunta al SII qué rango entregaría. No genera folios.</summary>
        public PropuestaCaf Consultar(int tipo, int cantidad)
        {
            if (cantidad < 1) throw new Exception("Cantidad no válida");
            Entrar();
            string url = "https://" + Host + "/cvc_cgi/dte/";
            string p = Post(url + "of_solicita_folios_dcto", "RUT_EMP=" + RutNumero + "&DV_EMP=" + RutDv + "&ACEPTAR=Continuar");
            var f = Campos(p);
            if (!f.ContainsKey("FOLIO_INICIAL")) throw new Exception("SII: " + Error(p, "no mostró el formulario de timbraje"));
            f.Remove("NEW"); f.Remove("ACEPTAR");
            f["COD_DOCTO"] = tipo.ToString();
            p = Post(url + "of_solicita_folios_dcto", Form(f));
            f = Campos(p);
            if (!f.ContainsKey("CANT_DOCTOS")) throw new Exception("SII: " + Error(p, "no aceptó el tipo de documento " + tipo));
            f.Remove("NEW");
            f["COD_DOCTO"] = tipo.ToString();
            f["CANT_DOCTOS"] = cantidad.ToString();
            f["ACEPTAR"] = "Solicitar Numeración";
            p = Post(url + "of_confirma_folio", Form(f));
            f = Campos(p);
            var r = new PropuestaCaf { Tipo = tipo, Cantidad = cantidad, Formulario = f, Mensaje = Texto(p) };
            string v;
            if (!f.TryGetValue("FOLIO_INI", out v) || !long.TryParse(v, out r.Desde) || !f.TryGetValue("FOLIO_FIN", out v) || !long.TryParse(v, out r.Hasta))
                throw new Exception("SII no propuso rango: " + Error(p, r.Mensaje));
            long n;
            var m = Regex.Match(r.Mensaje, @"Disponible\s+(\d+)"); if (m.Success && long.TryParse(m.Groups[1].Value, out n)) r.Disponible = n;
            m = Regex.Match(r.Mensaje, @"M\S*ximo Autorizado\s+(\d+)"); if (m.Success && long.TryParse(m.Groups[1].Value, out n)) r.MaximoAutorizado = n;
            if (f.ContainsKey("COD_DOCTO") && f["COD_DOCTO"] != tipo.ToString()) throw new Exception("SII propuso otro tipo de documento");
            return r;
        }

        /// <summary>
        /// Pide los folios (GENERA en el SII) y guarda el XML del CAF en <paramref name="carpetaCola"/> con el nombre
        /// que usa Sisgen (T39D26H35.xml). Devuelve la ruta del archivo.
        /// </summary>
        public string Pedir(PropuestaCaf propuesta, string carpetaCola)
        {
            if (SoloCertificacion && Host != "maullin.sii.cl") throw new Exception("Pedido de folios limitado a certificación.");
            string url = "https://" + Host + "/cvc_cgi/dte/";
            var f = new Dictionary<string, string>(propuesta.Formulario);
            f.Remove("NEW");
            string p = Post(url + "of_genera_folio", Form(f));
            Guardar(carpetaCola, "ultimo_genera.html", p);
            // La respuesta trae el formulario para bajar el archivo
            byte[] xml = null;
            var forms = Regex.Matches(p, "<form[^>]*action=\"([^\"]+)\"[^>]*>(.*?)</form>", RegexOptions.IgnoreCase | RegexOptions.Singleline);
            foreach (Match m in forms)
            {
                var campos = Campos(m.Groups[2].Value);
                campos.Remove("NEW");
                string accion = m.Groups[1].Value.StartsWith("http") ? m.Groups[1].Value : "https://" + Host + (m.Groups[1].Value.StartsWith("/") ? "" : "/cvc_cgi/dte/") + m.Groups[1].Value;
                if (accion.IndexOf("archivo", StringComparison.OrdinalIgnoreCase) < 0) continue;
                byte[] b = PostBytes(accion, Form(campos));
                if (Latin.GetString(b, 0, Math.Min(b.Length, 400)).IndexOf("<AUTORIZACION", StringComparison.OrdinalIgnoreCase) >= 0) { xml = b; break; }
                Guardar(carpetaCola, "ultimo_archivo.html", Latin.GetString(b));
            }
            if (xml == null) throw new Exception("SII: no se pudo bajar el CAF. " + Error(p, Texto(p)));
            // Validar que el CAF es el pedido
            var doc = new XmlDocument();
            using (var ms = new MemoryStream(xml)) doc.Load(ms);
            string re = Nodo(doc, "//CAF/DA/RE"), td = Nodo(doc, "//CAF/DA/TD"), d = Nodo(doc, "//CAF/DA/RNG/D"), h = Nodo(doc, "//CAF/DA/RNG/H");
            if (re != RutNumero + "-" + RutDv) throw new Exception("El CAF bajado es de otro RUT");
            if (td != propuesta.Tipo.ToString()) throw new Exception("El CAF bajado es de otro tipo de documento");
            if (d != propuesta.Desde.ToString() || h != propuesta.Hasta.ToString())
                throw new Exception("El CAF bajado (" + d + "-" + h + ") no es el rango propuesto (" + propuesta.Desde + "-" + propuesta.Hasta + ")");
            Directory.CreateDirectory(carpetaCola);
            string ruta = Path.Combine(carpetaCola, "T" + td + "D" + d + "H" + h + ".xml");
            if (File.Exists(ruta)) throw new Exception("Ya existe " + ruta);
            File.WriteAllBytes(ruta, xml);
            return ruta;
        }

        static string Nodo(XmlDocument d, string x) { var n = d.SelectSingleNode(x); return n == null ? null : n.InnerText.Trim(); }

        static void Guardar(string carpeta, string nombre, string html)
        {
            try { Directory.CreateDirectory(carpeta); File.WriteAllText(Path.Combine(carpeta, nombre), html, Latin); } catch { }
        }

        // ---------- HTTP ----------

        string Post(string url, string cuerpo) { return Latin.GetString(PostBytes(url, cuerpo)); }

        byte[] PostBytes(string url, string cuerpo)
        {
            var r = (HttpWebRequest)WebRequest.Create(url);
            r.Method = cuerpo == null ? "GET" : "POST";
            r.CookieContainer = galletas;
            r.UserAgent = "Mozilla/5.0 (SisgenAgente)";
            r.Timeout = r.ReadWriteTimeout = 120000;
            r.ClientCertificates.Add(cert);
            if (cuerpo != null)
            {
                r.ContentType = "application/x-www-form-urlencoded";
                byte[] b = Latin.GetBytes(cuerpo);
                r.ContentLength = b.Length;
                using (var s = r.GetRequestStream()) s.Write(b, 0, b.Length);
            }
            HttpWebResponse resp;
            try { resp = (HttpWebResponse)r.GetResponse(); }
            catch (WebException e)
            {
                resp = e.Response as HttpWebResponse;
                if (resp == null) throw new Exception("Sin conexión con el SII: " + e.Message);
            }
            using (resp)
            using (var ms = new MemoryStream())
            {
                resp.GetResponseStream().CopyTo(ms);
                if ((int)resp.StatusCode >= 400) throw new Exception("SII respondió HTTP " + (int)resp.StatusCode + " en " + new Uri(url).AbsolutePath);
                return ms.ToArray();
            }
        }

        static string Form(Dictionary<string, string> d)
        {
            var l = new List<string>();
            foreach (var kv in d) l.Add(kv.Key + "=" + Uri.EscapeDataString(WebUtilityDecode(kv.Value)).Replace("%20", "+"));
            return string.Join("&", l);
        }

        static string WebUtilityDecode(string s) { return WebUtility.HtmlDecode(s ?? ""); }

        static Dictionary<string, string> Campos(string html)
        {
            var d = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            foreach (Match m in Regex.Matches(html ?? "", "<input[^>]*>", RegexOptions.IgnoreCase))
            {
                var n = Regex.Match(m.Value, "name\\s*=\\s*\"?([^\" >]+)", RegexOptions.IgnoreCase);
                var v = Regex.Match(m.Value, "value\\s*=\\s*\"([^\"]*)\"", RegexOptions.IgnoreCase);
                if (n.Success) d[n.Groups[1].Value] = v.Success ? v.Groups[1].Value : "";
            }
            return d;
        }

        static string Texto(string html)
        {
            string t = Regex.Replace(html ?? "", "<script.*?</script>|<style.*?</style>", "", RegexOptions.Singleline | RegexOptions.IgnoreCase);
            t = WebUtility.HtmlDecode(Regex.Replace(t, "<[^>]*>", " "));
            return Regex.Replace(t, "\\s+", " ").Trim();
        }

        static string Error(string html, string porDefecto)
        {
            var m = Regex.Match(Texto(html), "(No ha sido posible[^.]*\\.|[^.]*c[oó]digo [A-Z0-9-]+)");
            return m.Success ? m.Value.Trim() : porDefecto;
        }
    }
}
