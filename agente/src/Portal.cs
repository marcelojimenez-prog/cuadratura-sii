// Comunicación con el Portal Sisgen (HTTP + JSON armado a mano: .NET 4 no trae JSON nativo).
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Net;
using System.Text;
using System.Text.RegularExpressions;

namespace SisgenAgente
{
    public class RespuestaPortal
    {
        public int Estado;
        public string Cuerpo;
        public bool Ok { get { return Estado >= 200 && Estado < 300; } }
        public string Valor(string campo)
        {
            var m = Regex.Match(Cuerpo ?? "", "\"" + Regex.Escape(campo) + "\"\\s*:\\s*(\"((?:[^\"\\\\]|\\\\.)*)\"|[-0-9.]+|true|false|null)");
            if (!m.Success) return null;
            return m.Groups[2].Success ? Regex.Unescape(m.Groups[2].Value) : m.Groups[1].Value;
        }
    }

    public class Portal
    {
        readonly string baseUrl;
        readonly string llave;

        static Portal()
        {
            // TLS 1.2 (3072) para cuando el portal esté en hosting con https; requiere .NET 4.5 instalado
            try { ServicePointManager.SecurityProtocol |= (SecurityProtocolType)3072; } catch { }
            ServicePointManager.Expect100Continue = false;
        }

        public Portal(string url, string llave)
        {
            baseUrl = url.TrimEnd('/') + "/api/agente";
            this.llave = llave;
        }

        public RespuestaPortal Enviar(string ruta, string json, bool comprimir = false)
        {
            var req = (HttpWebRequest)WebRequest.Create(baseUrl + ruta);
            req.Method = "POST";
            req.ContentType = "application/json; charset=utf-8";
            req.Headers["Authorization"] = "Bearer " + llave;
            req.UserAgent = "SisgenAgente/" + Program.Version;
            req.Timeout = 300000;
            req.ReadWriteTimeout = 300000;
            byte[] datos = Encoding.UTF8.GetBytes(json);
            if (comprimir)
            {
                using (var ms = new MemoryStream())
                {
                    using (var gz = new System.IO.Compression.GZipStream(ms, System.IO.Compression.CompressionMode.Compress)) gz.Write(datos, 0, datos.Length);
                    datos = ms.ToArray();
                }
                req.Headers["Content-Encoding"] = "gzip";
            }
            req.ContentLength = datos.Length;
            using (var s = req.GetRequestStream()) s.Write(datos, 0, datos.Length);
            HttpWebResponse resp;
            try { resp = (HttpWebResponse)req.GetResponse(); }
            catch (WebException e)
            {
                resp = e.Response as HttpWebResponse;
                if (resp == null) throw; // sin conexión: se reintenta en el próximo ciclo
            }
            using (resp)
            using (var lector = new StreamReader(resp.GetResponseStream(), Encoding.UTF8))
                return new RespuestaPortal { Estado = (int)resp.StatusCode, Cuerpo = lector.ReadToEnd() };
        }
    }

    /// <summary>Armado mínimo de JSON.</summary>
    public static class Json
    {
        public static string Texto(string s)
        {
            if (s == null) return "null";
            var sb = new StringBuilder("\"");
            foreach (char c in s)
            {
                switch (c)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        if (c < 32) sb.Append("\\u").Append(((int)c).ToString("x4"));
                        else sb.Append(c);
                        break;
                }
            }
            return sb.Append('"').ToString();
        }

        public static string Objeto(IDictionary<string, object> campos)
        {
            var sb = new StringBuilder("{");
            bool p = true;
            foreach (var kv in campos)
            {
                if (!p) sb.Append(',');
                p = false;
                sb.Append(Texto(kv.Key)).Append(':').Append(Valor(kv.Value));
            }
            return sb.Append('}').ToString();
        }

        public static string Valor(object v)
        {
            if (v == null) return "null";
            if (v is string) return Texto((string)v);
            if (v is bool) return (bool)v ? "true" : "false";
            if (v is int || v is long || v is decimal || v is double)
                return Convert.ToString(v, CultureInfo.InvariantCulture);
            if (v is IDictionary<string, object>) return Objeto((IDictionary<string, object>)v);
            if (v is System.Collections.IEnumerable)
            {
                var sb = new StringBuilder("[");
                bool p = true;
                foreach (var x in (System.Collections.IEnumerable)v)
                {
                    if (!p) sb.Append(',');
                    p = false;
                    sb.Append(Valor(x));
                }
                return sb.Append(']').ToString();
            }
            return Texto(v.ToString());
        }
    }
}
