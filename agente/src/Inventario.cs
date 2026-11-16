// Diagnóstico: qué hay en la carpeta procesos\Correo (y otras carpetas de procesos que puedan tener compras).
// Solo nombres de carpetas y cantidad de archivos por extensión; nunca contenido. Se envía una vez por hora.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;

namespace SisgenAgente
{
    public class Inventario
    {
        readonly Config cfg;
        readonly Portal portal;
        DateTime ultimo = DateTime.MinValue;

        public Inventario(Config c, Portal p) { cfg = c; portal = p; }

        public void Avanzar()
        {
            if ((DateTime.Now - ultimo).TotalMinutes < 60) return;
            ultimo = DateTime.Now;
            string procesos = Path.GetDirectoryName(cfg.CarpetaDte.TrimEnd('\\'));
            var carpetas = new List<object>();
            // procesos: solo el primer nivel (para ver si hay carpetas de compras / recibidos fuera de Correo)
            try
            {
                foreach (var d in new DirectoryInfo(procesos).GetDirectories())
                    carpetas.Add(Fila(d, procesos, false));
            }
            catch { }
            // Correo: completo
            string correo = Path.Combine(procesos, "Correo");
            if (Directory.Exists(correo))
            {
                try
                {
                    var todas = new List<DirectoryInfo> { new DirectoryInfo(correo) };
                    todas.AddRange(new DirectoryInfo(correo).EnumerateDirectories("*", SearchOption.AllDirectories).Take(400));
                    foreach (var d in todas) carpetas.Add(Fila(d, procesos, true));
                }
                catch (Exception e) { carpetas.Add(new Dictionary<string, object> { { "carpeta", "Correo" }, { "error", e.Message } }); }
            }
            var r = portal.Enviar("/diagnostico", Json.Objeto(new Dictionary<string, object> {
                { "tipo", "correo" }, { "procesos", procesos }, { "carpetas", carpetas }, { "descargas", BuscarDescargas() } }), true);
            if (!r.Ok) Log.Error("Diagnóstico: el portal respondió " + r.Estado);
        }

        /// <summary>
        /// Todas las carpetas Correo\Descargas de los discos locales (instalaciones de Sisgen con otro nombre o en otro disco):
        /// ruta, cantidad de XML y fecha del más nuevo. Busca hasta 4 niveles de profundidad.
        /// </summary>
        static List<object> BuscarDescargas()
        {
            var lista = new List<object>();
            foreach (var disco in DriveInfo.GetDrives().Where(d => d.DriveType == DriveType.Fixed && d.IsReady))
                Recorrer(disco.RootDirectory, 0, lista);
            return lista;
        }

        static void Recorrer(DirectoryInfo dir, int nivel, List<object> lista)
        {
            if (nivel > 4 || lista.Count >= 30) return;
            DirectoryInfo[] hijos;
            try { hijos = dir.GetDirectories(); } catch { return; }
            foreach (var h in hijos)
            {
                string n = h.Name.ToLowerInvariant();
                if (n == "windows" || n.StartsWith("$") || n == "program files" || n == "program files (x86)" || n == "programdata" || n == "appdata") continue;
                if (n == "descargas" && dir.Name.Equals("correo", StringComparison.OrdinalIgnoreCase))
                {
                    var fila = new Dictionary<string, object> { { "carpeta", h.FullName } };
                    try
                    {
                        var xml = h.EnumerateFiles("*.xml", SearchOption.AllDirectories).ToList();
                        fila["xml"] = xml.Count;
                        if (xml.Count > 0) fila["masNuevo"] = xml.Max(f => f.LastWriteTime).ToString("yyyy-MM-dd HH:mm");
                        fila["subcarpetas"] = h.GetDirectories().Length;
                    }
                    catch (Exception e) { fila["error"] = e.Message; }
                    lista.Add(fila);
                    continue;
                }
                Recorrer(h, nivel + 1, lista);
            }
        }

        static Dictionary<string, object> Fila(DirectoryInfo d, string raiz, bool contarArchivos)
        {
            var fila = new Dictionary<string, object> { { "carpeta", d.FullName.Substring(raiz.Length).TrimStart('\\') } };
            try
            {
                var archivos = d.EnumerateFiles().ToList();
                fila["archivos"] = archivos.Count;
                if (contarArchivos || archivos.Count > 0)
                {
                    fila["ext"] = archivos.GroupBy(f => (f.Extension ?? "").ToLowerInvariant()).OrderByDescending(g => g.Count()).Take(6)
                        .ToDictionary(g => g.Key == "" ? "(sin)" : g.Key, g => (object)g.Count());
                    if (archivos.Count > 0)
                    {
                        fila["desde"] = archivos.Min(f => f.LastWriteTime).ToString("yyyy-MM-dd");
                        fila["hasta"] = archivos.Max(f => f.LastWriteTime).ToString("yyyy-MM-dd");
                    }
                }
            }
            catch (Exception e) { fila["error"] = e.Message; }
            return fila;
        }
    }
}
