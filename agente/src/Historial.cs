// Carga del historial: sube al portal TODOS los XML de documentos emitidos que existan en la carpeta
// de Sisgen (procesos\DTE\AAMM y cualquier otra subcarpeta: antes los XML no quedaban ordenados).
// Va de a poco (no satura el equipo ni la conexión), de lo más reciente a lo más antiguo, y retoma
// donde quedó si el equipo se reinicia.
// Seguridad: nunca sube un archivo que contenga una llave privada (los CAF de procesos\Folios la traen).
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;

namespace SisgenAgente
{
    public class Historial
    {
        const int ArchivosPorLote = 100;
        const int LotesPorCiclo = 5;
        static readonly Encoding Latin1 = Encoding.GetEncoding(28591);
        static readonly string[] CarpetasExcluidas = { "folios", "certificado", "certificados", "firmas" };

        readonly Config cfg;
        readonly Portal portal;
        readonly string archivoHechas, archivoFin, archivoFolios;
        readonly HashSet<string> hechas = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        // Documentos (tipo-folio) ya enviados: una copia repetida en otra carpeta no se vuelve a subir
        readonly HashSet<string> folios = new HashSet<string>();
        static readonly Regex IdDoc = new Regex(@"<TipoDTE>\s*(\d+)\s*</TipoDTE>\s*<Folio>\s*(\d+)\s*</Folio>");
        Queue<string> pendientes;          // carpetas por revisar
        Queue<string> archivosCarpeta;     // archivos de la carpeta en curso
        string carpetaActual;
        public bool Terminado { get; private set; }
        public int CarpetasTotal { get; private set; }
        public long Enviados { get; private set; }
        string rutPropio;

        public Historial(Config c, Portal p, string carpetaEstado)
        {
            cfg = c;
            portal = p;
            archivoHechas = Path.Combine(carpetaEstado, "historial-carpetas.txt");
            archivoFin = Path.Combine(carpetaEstado, "historial-terminado.txt");
            archivoFolios = Path.Combine(carpetaEstado, "historial-folios.txt");
            Terminado = File.Exists(archivoFin);
            if (File.Exists(archivoHechas)) foreach (var l in File.ReadAllLines(archivoHechas)) if (l.Length > 0) hechas.Add(l);
            if (File.Exists(archivoFolios)) foreach (var l in File.ReadAllLines(archivoFolios)) if (l.Length > 0) folios.Add(l);
        }

        public long Repetidos { get; private set; }

        public string Resumen()
        {
            if (Terminado) return "terminado";
            if (pendientes == null) return "pendiente";
            return "carpetas " + hechas.Count + " de " + CarpetasTotal + ", " + folios.Count + " documentos subidos" +
                   (Repetidos > 0 ? ", " + Repetidos + " copias repetidas omitidas" : "");
        }

        public void FijarRut(string rut)
        {
            rutPropio = rut == null ? null : rut.Replace(".", "").Trim().ToUpperInvariant();
        }

        /// <summary>Avanza un poco. Devuelve la cantidad de XML enviados en este ciclo.</summary>
        public int Avanzar()
        {
            if (Terminado || rutPropio == null) return 0;
            if (pendientes == null) Planificar();
            int enviados = 0;
            for (int lote = 0; lote < LotesPorCiclo; lote++)
            {
                var archivos = new List<object>();
                var terminadas = new List<string>(); // se marcan como hechas solo si el envío resulta
                var nuevosFolios = new HashSet<string>(); // documentos de este lote (evita repetidos dentro del mismo lote)
                bool fin = false;
                while (archivos.Count < ArchivosPorLote)
                {
                    if (archivosCarpeta == null || archivosCarpeta.Count == 0)
                    {
                        if (carpetaActual != null) terminadas.Add(carpetaActual);
                        carpetaActual = null;
                        if (pendientes.Count == 0) { fin = true; break; }
                        carpetaActual = pendientes.Dequeue();
                        archivosCarpeta = new Queue<string>(ArchivosXml(carpetaActual));
                        continue;
                    }
                    var a = Leer(archivosCarpeta.Dequeue(), nuevosFolios);
                    if (a != null) archivos.Add(a);
                }
                if (archivos.Count > 0)
                {
                    var r = portal.Enviar("/xml", Json.Objeto(new Dictionary<string, object> { { "historial", true }, { "archivos", archivos } }), true);
                    if (!r.Ok)
                    {
                        // Se reintenta la carpeta en curso desde el principio en el próximo ciclo
                        if (carpetaActual != null) { pendientes = new Queue<string>(new[] { carpetaActual }.Concat(pendientes)); carpetaActual = null; archivosCarpeta = null; }
                        foreach (var t in terminadas) pendientes = new Queue<string>(new[] { t }.Concat(pendientes));
                        throw new Exception("Historial: el portal respondió " + r.Estado + ": " + r.Cuerpo);
                    }
                    enviados += archivos.Count;
                    Enviados += archivos.Count;
                    RecordarFolios(nuevosFolios);
                }
                foreach (var t in terminadas) MarcarHecha(t);
                if (fin) { Terminar(); break; }
            }
            return enviados;
        }

        /// <summary>Orden: carpetas de meses de procesos\DTE (de la más nueva a la más antigua) y luego el resto.</summary>
        void Planificar()
        {
            var dte = cfg.CarpetaDte;
            var meses = Directory.Exists(dte)
                ? Directory.GetDirectories(dte).Where(d => Regex.IsMatch(Path.GetFileName(d), @"^\d{4}$")).OrderByDescending(d => Path.GetFileName(d)).ToList()
                : new List<string>();
            var resto = new List<string>();
            var pila = new Stack<string>();
            pila.Push(cfg.Sisgen);
            while (pila.Count > 0)
            {
                string d = pila.Pop();
                if (CarpetasExcluidas.Contains(Path.GetFileName(d).ToLowerInvariant())) continue;
                if (!meses.Contains(d, StringComparer.OrdinalIgnoreCase)) resto.Add(d);
                try { foreach (var s in Directory.GetDirectories(d)) pila.Push(s); } catch { }
            }
            var todas = meses.Concat(resto).ToList();
            CarpetasTotal = todas.Count;
            pendientes = new Queue<string>(todas.Where(d => !hechas.Contains(d)));
            Log.Info("Historial: " + CarpetasTotal + " carpetas por revisar (" + pendientes.Count + " pendientes).");
        }

        static IEnumerable<string> ArchivosXml(string carpeta)
        {
            try { return Directory.GetFiles(carpeta, "*.xml").OrderByDescending(f => f, StringComparer.OrdinalIgnoreCase).ToList(); }
            catch { return new string[0]; }
        }

        /// <summary>
        /// El archivo, comprimido, si es un documento emitido por esta razón social y trae al menos un
        /// documento (tipo-folio) que aún no se haya subido; si no, null. Las copias repetidas no se envían.
        /// </summary>
        Dictionary<string, object> Leer(string ruta, HashSet<string> enLote)
        {
            try
            {
                var info = new FileInfo(ruta);
                if (info.Length < 200 || info.Length > 3 * 1024 * 1024) return null;
                byte[] bytes;
                using (var fs = new FileStream(ruta, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
                using (var ms = new MemoryStream()) { fs.CopyTo(ms); bytes = ms.ToArray(); }
                string t = Latin1.GetString(bytes);
                if (t.IndexOf("<DTE", StringComparison.Ordinal) < 0) return null;
                // Jamás se envía un archivo con llave privada
                if (t.IndexOf("RSASK", StringComparison.OrdinalIgnoreCase) >= 0 || t.IndexOf("PRIVATE KEY", StringComparison.OrdinalIgnoreCase) >= 0) return null;
                var m = Regex.Match(t, @"<RUTEmisor>\s*([0-9.]+-[0-9kK])\s*</RUTEmisor>");
                if (!m.Success || m.Groups[1].Value.Replace(".", "").ToUpperInvariant() != rutPropio) return null;
                // Documentos que trae el archivo (un sobre antiguo puede traer varios)
                var claves = IdDoc.Matches(t).Cast<Match>().Select(x => x.Groups[1].Value + "-" + long.Parse(x.Groups[2].Value)).Distinct().ToList();
                if (claves.Count == 0) return null;
                if (claves.All(k => folios.Contains(k) || enLote.Contains(k))) { Repetidos++; return null; }
                foreach (var k in claves) enLote.Add(k);
                using (var ms = new MemoryStream())
                {
                    using (var gz = new System.IO.Compression.GZipStream(ms, System.IO.Compression.CompressionMode.Compress)) gz.Write(bytes, 0, bytes.Length);
                    return new Dictionary<string, object> { { "nombre", Path.GetFileName(ruta) }, { "contenido", Convert.ToBase64String(ms.ToArray()) } };
                }
            }
            catch { return null; }
        }

        void RecordarFolios(HashSet<string> nuevos)
        {
            var agregar = nuevos.Where(k => folios.Add(k)).ToList();
            if (agregar.Count == 0) return;
            try { File.AppendAllLines(archivoFolios, agregar); } catch { }
        }

        void MarcarHecha(string carpeta)
        {
            if (!hechas.Add(carpeta)) return;
            try { File.AppendAllText(archivoHechas, carpeta + Environment.NewLine); } catch { }
        }

        void Terminar()
        {
            Terminado = true;
            try { File.WriteAllText(archivoFin, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss")); } catch { }
            Log.Info("Historial: carga completa (" + hechas.Count + " carpetas revisadas).");
        }
    }
}
