// Diagnóstico: ¿en qué tabla de la carpeta datos está un documento? El portal pide unos textos (p. ej. folio y RUT)
// y el agente informa qué tablas tienen un registro que los contiene todos, con sus nombres de columnas.
// No se envía el contenido de los registros; solo el nombre de la tabla, sus columnas (nombre y tipo) y cuántos coinciden.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;

namespace SisgenAgente
{
    public class BuscaTablas
    {
        readonly Config cfg;
        readonly Portal portal;
        string ultimoPedido;

        public BuscaTablas(Config c, Portal p) { cfg = c; portal = p; }

        /// <summary>Pedido que llega en /hola: {"id":"…","textos":["16059","11111111"]}.</summary>
        public void Recibir(Dictionary<string, object> respuesta)
        {
            object o;
            if (respuesta == null || !respuesta.TryGetValue("buscarEnTablas", out o)) return;
            var p = o as Dictionary<string, object>;
            if (p == null || !p.ContainsKey("id") || !(p["textos"] is List<object>)) return;
            string id = Convert.ToString(p["id"]);
            if (id == ultimoPedido) return;
            ultimoPedido = id;
            var textos = ((List<object>)p["textos"]).Select(x => Convert.ToString(x)).Where(x => !string.IsNullOrEmpty(x)).ToList();
            if (textos.Count == 0) return;
            var resultado = new List<object>();
            var latin = Encoding.GetEncoding(28591);
            foreach (var f in new DirectoryInfo(cfg.CarpetaDatos).GetFiles("*.dbf"))
            {
                if (f.Length > 300L * 1024 * 1024) continue;
                try
                {
                    int coincidencias = 0;
                    using (var fs = new FileStream(f.FullName, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
                    {
                        // Búsqueda en bruto, por bloques (más rápido que leer campo a campo)
                        var buf = new byte[4 * 1024 * 1024];
                        int n; string resto = "";
                        while ((n = fs.Read(buf, 0, buf.Length)) > 0)
                        {
                            string bloque = resto + latin.GetString(buf, 0, n);
                            if (textos.All(t => bloque.IndexOf(t, StringComparison.OrdinalIgnoreCase) >= 0)) coincidencias++;
                            resto = bloque.Length > 4096 ? bloque.Substring(bloque.Length - 4096) : bloque;
                        }
                    }
                    if (coincidencias == 0) continue;
                    var cols = new List<object>();
                    int registros = 0;
                    try
                    {
                        using (var t = new TablaDbf(f.FullName))
                        {
                            registros = t.Registros;
                            cols = t.Campos.Values.OrderBy(c => c.Desplazamiento).Select(c => (object)(c.Nombre + "(" + c.Tipo + c.Largo + ")")).ToList();
                        }
                    }
                    catch { }
                    resultado.Add(new Dictionary<string, object> {
                        { "tabla", f.Name }, { "registros", registros }, { "bytes", f.Length },
                        { "modificada", f.LastWriteTime.ToString("yyyy-MM-dd HH:mm") }, { "columnas", cols } });
                }
                catch (Exception e) { resultado.Add(new Dictionary<string, object> { { "tabla", f.Name }, { "error", e.Message } }); }
            }
            portal.Enviar("/diagnostico", Json.Objeto(new Dictionary<string, object> {
                { "tipo", "tablas" }, { "pedido", id }, { "textos", textos }, { "datos", cfg.CarpetaDatos }, { "tablas", resultado } }), true);
            Log.Info("Diagnóstico: búsqueda en tablas terminada (" + resultado.Count + " tablas con coincidencias).");
        }
    }
}
