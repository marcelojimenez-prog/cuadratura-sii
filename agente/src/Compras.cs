// Compras: XML de documentos recibidos de proveedores (procesos\DTE\intercambio\Recibidos de Sisgen).
// El agente los sube al portal (solo lectura; el portal guarda solo los que tienen como receptor el RUT propio).
// Se revisa la carpeta completa (con subcarpetas) cada 5 minutos; lo ya enviado queda anotado en
// estado\compras-enviadas.txt (ruta | tamaño | fecha de modificación) para no repetir.
using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Text;

namespace SisgenAgente
{
    public class Compras
    {
        const int MaxPorCiclo = 500, PorLote = 50;
        const long MaxBytes = 5 * 1024 * 1024;
        readonly Config cfg;
        readonly Portal portal;
        readonly string archivoEstado;
        HashSet<string> enviados;
        DateTime ultimaRevision = DateTime.MinValue;
        bool quedanPendientes;

        public Compras(Config c, Portal p, string carpetaEstado)
        {
            cfg = c; portal = p;
            archivoEstado = Path.Combine(carpetaEstado, "compras-enviadas-v2.txt");
        }

        // Compras: Sisgen baja los XML del correo a procesos\Correo\Descargas, revisa que el receptor sea el RUT
        // local y deja los válidos en procesos\DTE\intercambio\Recibidos. Esa es la carpeta que se lee.
        public string Carpeta
        {
            get { return Path.Combine(cfg.CarpetaDte, "intercambio", "Recibidos"); }
        }

        public void Avanzar()
        {
            if (!quedanPendientes && (DateTime.Now - ultimaRevision).TotalMinutes < 5) return;
            ultimaRevision = DateTime.Now;
            string carpeta = Carpeta;
            if (!Directory.Exists(carpeta)) { quedanPendientes = false; return; }
            if (enviados == null) Cargar();

            var pendientes = new List<KeyValuePair<string, FileInfo>>();
            try
            {
                foreach (string ruta in Directory.EnumerateFiles(carpeta, "*.xml", SearchOption.AllDirectories))
                {
                    FileInfo f;
                    try { f = new FileInfo(ruta); } catch { continue; }
                    if (f.Length == 0 || f.Length > MaxBytes || f.LastWriteTime > DateTime.Now.AddSeconds(-5)) continue;
                    string clave = ruta.Substring(carpeta.Length).TrimStart('\\') + "|" + f.Length + "|" + f.LastWriteTime.Ticks;
                    if (enviados.Contains(clave)) continue;
                    pendientes.Add(new KeyValuePair<string, FileInfo>(clave, f));
                    if (pendientes.Count >= MaxPorCiclo) break;
                }
            }
            catch (Exception e) { Log.Error("Compras: no se pudo revisar " + carpeta + ": " + e.Message); return; }
            quedanPendientes = pendientes.Count >= MaxPorCiclo;
            if (pendientes.Count == 0) return;

            int guardados = 0;
            foreach (var lote in Lotes(pendientes.OrderBy(x => x.Value.LastWriteTime).ToList()))
            {
                var archivos = new List<object>();
                var claves = new List<string>();
                foreach (var x in lote)
                {
                    byte[] bytes;
                    try { bytes = LeerCompartido(x.Value.FullName); } catch (IOException) { continue; }
                    // Seguridad: nunca se envía un archivo con llave privada
                    string texto = Encoding.GetEncoding(28591).GetString(bytes);
                    if (texto.IndexOf("RSASK", StringComparison.OrdinalIgnoreCase) >= 0 || texto.IndexOf("PRIVATE KEY", StringComparison.OrdinalIgnoreCase) >= 0) { claves.Add(x.Key); continue; }
                    archivos.Add(new Dictionary<string, object> { { "nombre", x.Value.Name }, { "contenido", Convert.ToBase64String(Gzip(bytes)) } });
                    claves.Add(x.Key);
                }
                if (archivos.Count > 0)
                {
                    var r = portal.Enviar("/compras", Json.Objeto(new Dictionary<string, object> { { "archivos", archivos } }));
                    if (!r.Ok) throw new Exception("Compras rechazadas por el portal (" + r.Estado + "): " + r.Cuerpo);
                    int g; if (int.TryParse(r.Valor("guardados"), out g)) guardados += g;
                }
                Marcar(claves);
            }
            Log.Info("Compras: " + pendientes.Count + " archivos revisados de DTE\\intercambio\\Recibidos, " + guardados + " documentos de compra en el portal.");
        }

        void Cargar()
        {
            enviados = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            try { if (File.Exists(archivoEstado)) foreach (var l in File.ReadAllLines(archivoEstado, Encoding.UTF8)) if (l.Length > 0) enviados.Add(l); }
            catch { }
        }

        void Marcar(List<string> claves)
        {
            foreach (var c in claves) enviados.Add(c);
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(archivoEstado));
                File.AppendAllLines(archivoEstado, claves, Encoding.UTF8);
            }
            catch { }
        }

        static IEnumerable<List<T>> Lotes<T>(List<T> lista)
        {
            for (int i = 0; i < lista.Count; i += PorLote) yield return lista.GetRange(i, Math.Min(PorLote, lista.Count - i));
        }

        static byte[] LeerCompartido(string ruta)
        {
            using (var fs = new FileStream(ruta, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
            using (var ms = new MemoryStream()) { fs.CopyTo(ms); return ms.ToArray(); }
        }

        static byte[] Gzip(byte[] datos)
        {
            using (var ms = new MemoryStream())
            {
                using (var gz = new GZipStream(ms, CompressionMode.Compress)) gz.Write(datos, 0, datos.Length);
                return ms.ToArray();
            }
        }
    }
}
