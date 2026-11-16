// Documentos "en blanco": el portal pide buscarlos en la carpeta backup de Sisgen (AAAAMMDD.dbf, un archivo por día)
// y el agente devuelve las líneas encontradas (producto, cantidad, precio, total). Solo lectura.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;

namespace SisgenAgente
{
    public class Respaldo
    {
        readonly Config cfg;
        readonly Portal portal;
        List<Dictionary<string, object>> pendientes = new List<Dictionary<string, object>>();

        public Respaldo(Config c, Portal p) { cfg = c; portal = p; }

        /// <summary>Lista que llega en la respuesta de /hola: [{tipoSisgen, folio, fecha}].</summary>
        public void Recibir(Dictionary<string, object> respuesta)
        {
            object o;
            if (respuesta == null || !respuesta.TryGetValue("respaldosPendientes", out o) || !(o is List<object>)) return;
            pendientes = ((List<object>)o).OfType<Dictionary<string, object>>().ToList();
        }

        string Carpeta()
        {
            foreach (var raiz in new[] { Path.GetDirectoryName(cfg.CarpetaDatos.TrimEnd('\\')), cfg.Sisgen })
            {
                if (string.IsNullOrEmpty(raiz)) continue;
                string c = Path.Combine(raiz, "backup");
                if (Directory.Exists(c)) return c;
            }
            return null;
        }

        public void Procesar()
        {
            if (pendientes.Count == 0) return;
            var lista = pendientes;
            pendientes = new List<Dictionary<string, object>>();
            string carpeta = Carpeta();
            var buscados = new Dictionary<string, List<Dictionary<string, object>>>(); // "BE-123" -> líneas
            var porDia = new Dictionary<string, HashSet<string>>();
            foreach (var p in lista)
            {
                string tipo = (p.ContainsKey("tipoSisgen") ? p["tipoSisgen"] as string : null) ?? "";
                string fecha = p.ContainsKey("fecha") ? p["fecha"] as string : null;
                object f; long folio;
                if (!p.TryGetValue("folio", out f) || f == null || !long.TryParse(Convert.ToString(f, CultureInfo.InvariantCulture), out folio)) continue;
                string k = tipo.ToUpperInvariant() + "-" + folio;
                buscados[k] = null;
                DateTime d;
                if (fecha == null || !DateTime.TryParseExact(fecha, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out d)) continue;
                foreach (var dia in new[] { d, d.AddDays(1) })
                {
                    string n = dia.ToString("yyyyMMdd");
                    if (!porDia.ContainsKey(n)) porDia[n] = new HashSet<string>();
                    porDia[n].Add(k);
                }
            }
            if (carpeta != null)
            {
                foreach (var dia in porDia)
                {
                    string ruta = Path.Combine(carpeta, dia.Key + ".dbf");
                    if (!File.Exists(ruta)) continue;
                    var encontrados = new Dictionary<string, List<Dictionary<string, object>>>();
                    try
                    {
                        using (var t = new TablaDbf(ruta))
                        {
                            for (int i = 0; i < t.Registros; i++)
                            {
                                var r = t.Leer(i);
                                if (r == null) continue;
                                var m = Regex.Match(r.Texto("CODMAT") ?? "", @"^([A-Za-z]{2})0*(\d+)$");
                                if (!m.Success) continue;
                                string k = m.Groups[1].Value.ToUpperInvariant() + "-" + long.Parse(m.Groups[2].Value);
                                if (!dia.Value.Contains(k) || buscados[k] != null) continue;
                                if (!encontrados.ContainsKey(k)) encontrados[k] = new List<Dictionary<string, object>>();
                                encontrados[k].Add(new Dictionary<string, object> {
                                    { "CODIGO", r.Texto("CODIGO") }, { "DESCRI", r.Texto("DESCRI") }, { "OBSERV", r.Texto("OBSERV") },
                                    { "CANTID", r.Numero("CANTID") }, { "PRECIO", r.Numero("PRECIO") }, { "DESCTO", r.Numero("DESCTO") },
                                    { "MTOTAL", r.Numero("MTOTAL") } });
                            }
                        }
                    }
                    catch (Exception e) { Log.Error("Respaldo " + dia.Key + ".dbf: " + e.Message); continue; }
                    foreach (var e in encontrados) buscados[e.Key] = e.Value;
                    foreach (var e in encontrados) e.Value.ForEach(l => l["archivo"] = dia.Key + ".dbf");
                }
            }
            // Lo que no está en el backup de esta estación se busca en la tabla DT del mes (movimientos de inventario)
            var fuente = buscados.Keys.ToDictionary(k => k, k => buscados[k] != null ? "BACKUP" : null);
            BuscarEnDt(lista, buscados, fuente);
            var docs = buscados.Select(b => (object)new Dictionary<string, object> {
                { "documento", b.Key }, { "fuente", fuente[b.Key] },
                { "lineas", b.Value == null ? new List<object>() : b.Value.Cast<object>().ToList() } }).ToList();
            var r2 = portal.Enviar("/respaldo", Json.Objeto(new Dictionary<string, object> { { "docs", docs } }), true);
            if (!r2.Ok) throw new Exception("El portal respondió " + r2.Estado + " al enviar el respaldo de documentos en blanco");
            int hallados = buscados.Count(b => b.Value != null);
            Log.Info("Documentos en blanco: " + hallados + " de " + buscados.Count + " con detalle encontrado (carpeta backup o tabla DT).");
        }

        /// <summary>Tabla DTMMAAAA.dbf de la carpeta datos: TIPO + NUMERO, CODPRO, DESCRI, SALE.</summary>
        void BuscarEnDt(List<Dictionary<string, object>> lista, Dictionary<string, List<Dictionary<string, object>>> buscados, Dictionary<string, string> fuente)
        {
            var porMes = new Dictionary<string, HashSet<string>>();
            foreach (var p in lista)
            {
                string tipo = ((p.ContainsKey("tipoSisgen") ? p["tipoSisgen"] as string : null) ?? "").ToUpperInvariant();
                string fecha = p.ContainsKey("fecha") ? p["fecha"] as string : null;
                object f; long folio;
                if (fecha == null || fecha.Length < 7 || !p.TryGetValue("folio", out f) || f == null
                    || !long.TryParse(Convert.ToString(f, CultureInfo.InvariantCulture), out folio)) continue;
                string k = tipo + "-" + folio;
                if (!buscados.ContainsKey(k) || buscados[k] != null) continue;
                string nombre = "DT" + fecha.Substring(5, 2) + fecha.Substring(0, 4) + ".dbf";
                if (!porMes.ContainsKey(nombre)) porMes[nombre] = new HashSet<string>();
                porMes[nombre].Add(k);
            }
            foreach (var mes in porMes)
            {
                string ruta = Path.Combine(cfg.CarpetaDatos, mes.Key);
                if (!File.Exists(ruta)) continue;
                var encontrados = new Dictionary<string, List<Dictionary<string, object>>>();
                try
                {
                    using (var t = new TablaDbf(ruta))
                    {
                        for (int i = 0; i < t.Registros; i++)
                        {
                            var r = t.Leer(i);
                            if (r == null) continue;
                            long numero;
                            if (!long.TryParse((r.Texto("NUMERO") ?? "").Trim(), out numero)) continue;
                            string k = (r.Texto("TIPO") ?? "").Trim().ToUpperInvariant() + "-" + numero;
                            if (!mes.Value.Contains(k)) continue;
                            if (!encontrados.ContainsKey(k)) encontrados[k] = new List<Dictionary<string, object>>();
                            encontrados[k].Add(new Dictionary<string, object> {
                                { "CODPRO", r.Texto("CODPRO") }, { "DESCRI", r.Texto("DESCRI") },
                                { "SALE", r.Numero("SALE") }, { "ENTRA", r.Numero("ENTRA") }, { "archivo", mes.Key } });
                        }
                    }
                }
                catch (Exception e) { Log.Error("Tabla " + mes.Key + ": " + e.Message); continue; }
                foreach (var e in encontrados) { buscados[e.Key] = e.Value; fuente[e.Key] = "DT"; }
            }
        }
    }
}
