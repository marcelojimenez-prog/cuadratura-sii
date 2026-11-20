// Ciclo del agente: detecta documentos nuevos y su seguimiento de envío al SII y los sube al portal.
// Solo lee: nunca escribe, mueve ni bloquea archivos de Sisgen o de DTESERVICE.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;

namespace SisgenAgente
{
    public class Motor
    {
        readonly Config cfg;
        readonly Portal portal;
        readonly Estado estado;
        readonly AutoResetEvent despertar = new AutoResetEvent(false);
        volatile bool detener;
        Thread hilo;
        readonly List<FileSystemWatcher> vigilantes = new List<FileSystemWatcher>();
        DateTime ultimoHola = DateTime.MinValue;
        string ultimoError;

        public Motor(Config c)
        {
            cfg = c;
            portal = new Portal(c.Portal, c.Llave);
            estado = new Estado(Path.Combine(Program.Carpeta, "estado"));
            historial = new Historial(c, portal, Path.Combine(Program.Carpeta, "estado"));
            sii = new Sii(c);
            consultas = new ConsultasSii(portal, sii);
            respaldo = new Respaldo(c, portal);
            compras = new Compras(c, portal, Path.Combine(Program.Carpeta, "estado"));
            inventario = new Inventario(c, portal);
            buscaTablas = new BuscaTablas(c, portal);
            if (c.Folios) motoresFolios = c.CarpetasFolios.Select(x => new MotorFolios(x)).ToList();
        }

        readonly List<MotorFolios> motoresFolios = new List<MotorFolios>();

        public void Iniciar()
        {
            Log.Info("Agente Sisgen " + Program.Version + " iniciado. Sisgen: " + cfg.Sisgen + " · Portal: " + cfg.Portal);
            Vigilar(cfg.CarpetaDte, "*.xml", true, ruta => { lock (xmlAvisados) xmlAvisados.Add(ruta); });
            Vigilar(cfg.CarpetaDatos, "traza*.dbf", false);
            // Certificado local para consultar al SII (nunca sale de este equipo)
            try { sii.CargarCertificado(); } catch (Exception e) { sii.EstadoCertificado = "error: " + e.Message; }
            Log.Info("Certificado para consultas al SII: " + sii.EstadoCertificado);
            consultas.Iniciar();
            hilo = new Thread(Bucle) { IsBackground = true, Name = "motor" };
            hilo.Start();
        }

        public void Detener()
        {
            detener = true;
            despertar.Set();
            consultas.Detener();
            foreach (var v in vigilantes) v.Dispose();
            if (hilo != null) hilo.Join(30000);
            Log.Info("Agente detenido.");
        }

        void Vigilar(string carpeta, string filtro, bool subcarpetas, Action<string> alCambiar = null)
        {
            try
            {
                if (!Directory.Exists(carpeta)) { Log.Error("No existe la carpeta " + carpeta); return; }
                var w = new FileSystemWatcher(carpeta, filtro) { IncludeSubdirectories = subcarpetas, InternalBufferSize = 65536 };
                w.NotifyFilter = NotifyFilters.FileName | NotifyFilters.LastWrite | NotifyFilters.Size;
                FileSystemEventHandler h = (s, e) => { if (alCambiar != null) alCambiar(e.FullPath); despertar.Set(); };
                w.Created += h; w.Changed += h; w.Renamed += (s, e) => { if (alCambiar != null) alCambiar(e.FullPath); despertar.Set(); };
                w.EnableRaisingEvents = true;
                vigilantes.Add(w);
            }
            catch (Exception e) { Log.Error("No se pudo vigilar " + carpeta + ": " + e.Message); }
        }

        void Bucle()
        {
            while (!detener)
            {
                try { Ciclo(); ultimoError = null; }
                catch (Exception e)
                {
                    ultimoError = e.Message;
                    Log.Error("Ciclo: " + e.Message);
                }
                // Espera el próximo ciclo o un aviso de archivo nuevo; luego da 3 s para que se termine de escribir
                // Mientras se carga el historial se avanza cada pocos segundos; después, al ritmo normal
                var espera = historial.Terminado || ultimoError != null ? TimeSpan.FromSeconds(cfg.IntervaloSegundos) : TimeSpan.FromSeconds(3);
                if (despertar.WaitOne(espera) && !detener) Thread.Sleep(3000);
            }
        }

        public void Ciclo()
        {
            if ((DateTime.Now - ultimoHola).TotalSeconds >= 60) Hola();
            EnviarTrazas("trazadte.dbf");
            EnviarTrazas("trazabol.dbf");
            EnviarXml();
            estado.Guardar();
            EnviarVentasMes();
            try { respaldo.Procesar(); } catch (Exception e) { Log.Error("Respaldo: " + e.Message); }
            try { compras.Avanzar(); } catch (Exception e) { Log.Error("Compras: " + e.Message); }
            try { inventario.Avanzar(); } catch (Exception e) { Log.Error("Diagnóstico: " + e.Message); }
            try { buscaTablas.Recibir(ultimaRespuestaHola); } catch (Exception e) { Log.Error("Diagnóstico tablas: " + e.Message); }
            // Folios: aislado, si falla no afecta lo demás
            foreach (var mf in motoresFolios) try { mf.Revisar(); } catch (Exception e) { Log.Error("Folios: " + e.Message); }
            // Lo último y de a poco: el historial de XML (no retrasa lo que se está emitiendo hoy)
            int h = historial.Avanzar();
            if (h > 0 && (DateTime.Now - ultimoLogHistorial).TotalMinutes >= 5)
            {
                Log.Info("Historial: " + historial.Resumen() + ".");
                ultimoLogHistorial = DateTime.Now;
            }
        }

        readonly Historial historial;
        readonly Respaldo respaldo;
        readonly Compras compras;
        readonly Inventario inventario;
        readonly BuscaTablas buscaTablas;
        Dictionary<string, object> ultimaRespuestaHola;
        readonly Sii sii;
        readonly ConsultasSii consultas;
        DateTime ultimoLogHistorial = DateTime.MinValue;

        // ---------- Ventas completas del mes (F1, F2, CLIDOCTO, CLIPAGOS, índice XML, CAF) ----------
        // Meses que el portal pide cuadrar (según la vigencia de los folios de facturas y notas)
        List<string> mesesPortal = new List<string>();
        readonly Dictionary<string, DateTime> ultimoEnvioMes = new Dictionary<string, DateTime>();
        // Meses con documentos corregidos que el portal pide reenviar ya
        readonly List<string> mesesUrgentesPendientes = new List<string>();

        /// <summary>
        /// Envía las ventas de cada mes que corresponda: el actual (y el anterior los primeros 10 días)
        /// cada pocas horas; los demás meses que pide el portal, una vez al día.
        /// </summary>
        void EnviarVentasMes()
        {
            var hoy = DateTime.Today;
            var actual = new DateTime(hoy.Year, hoy.Month, 1);
            var recientes = new List<string> { actual.ToString("yyyy-MM") };
            if (hoy.Day <= 10) recientes.Add(actual.AddMonths(-1).ToString("yyyy-MM"));
            if (ultimoEnvioMes.Count == 0) recientes.Add(actual.AddMonths(-1).ToString("yyyy-MM")); // al iniciar
            var urgentes = mesesUrgentesPendientes.ToList();
            mesesUrgentesPendientes.Clear();
            var todos = urgentes.Concat(recientes).Concat(mesesPortal).Distinct().ToList();
            foreach (var m in todos)
            {
                DateTime ultimo;
                bool enviado = ultimoEnvioMes.TryGetValue(m, out ultimo);
                double horas = urgentes.Contains(m) ? 0 : recientes.Contains(m) ? cfg.HorasVentas : 24;
                if (enviado && (DateTime.Now - ultimo).TotalHours < horas) continue;
                var mes = DateTime.ParseExact(m + "-01", "yyyy-MM-dd", CultureInfo.InvariantCulture);
                var inicio = DateTime.Now;
                var paquete = Ventas.PaqueteMes(cfg, mes);
                ultimoEnvioMes[m] = DateTime.Now;
                if (paquete == null) { Log.Info("Ventas " + m + ": no existe la tabla F1 del mes."); continue; }
                var r = portal.Enviar("/mes", Json.Objeto(paquete), true);
                if (!r.Ok) { ultimoEnvioMes.Remove(m); throw new Exception("Ventas del mes rechazadas por el portal (" + r.Estado + "): " + r.Cuerpo); }
                Log.Info("Ventas " + m + ": " + r.Valor("documentos") + " documentos enviados (" + (int)(DateTime.Now - inicio).TotalSeconds + " s).");
            }
            EnviarMesAntiguo(todos);
        }

        /// <summary>
        /// Meses antiguos (todos los que tengan tabla F1): uno por ciclo, del más nuevo al más antiguo, una
        /// sola vez (queda anotado en estado\meses-enviados.txt aunque el equipo se reinicie).
        /// </summary>
        void EnviarMesAntiguo(List<string> yaCubiertos)
        {
            string archivo = Path.Combine(Program.Carpeta, "estado", "meses-enviados.txt");
            if (mesesAntiguosEnviados == null)
                mesesAntiguosEnviados = new HashSet<string>(File.Exists(archivo) ? File.ReadAllLines(archivo) : new string[0]);
            if (mesesConVentas == null || (DateTime.Now - mesesConVentasLeidos).TotalHours > 12)
            {
                mesesConVentas = Ventas.MesesConVentas(cfg);
                mesesConVentasLeidos = DateTime.Now;
            }
            var m = mesesConVentas.FirstOrDefault(x => !yaCubiertos.Contains(x) && !mesesAntiguosEnviados.Contains(x));
            if (m == null) return;
            var inicio = DateTime.Now;
            var paquete = Ventas.PaqueteMes(cfg, DateTime.ParseExact(m + "-01", "yyyy-MM-dd", CultureInfo.InvariantCulture), false);
            if (paquete != null)
            {
                var r = portal.Enviar("/mes", Json.Objeto(paquete), true);
                if (!r.Ok) throw new Exception("Ventas de " + m + " rechazadas por el portal (" + r.Estado + "): " + r.Cuerpo);
                Log.Info("Ventas antiguas " + m + ": " + r.Valor("documentos") + " documentos enviados (" + (int)(DateTime.Now - inicio).TotalSeconds + " s).");
            }
            mesesAntiguosEnviados.Add(m);
            try { File.AppendAllText(archivo, m + Environment.NewLine); } catch { }
        }

        HashSet<string> mesesAntiguosEnviados;
        List<string> mesesConVentas;
        DateTime mesesConVentasLeidos;

        Dictionary<string, object> empresa;

        void Hola()
        {
            if (empresa == null) empresa = Ventas.Empresa(cfg);
            var r = portal.Enviar("/hola", Json.Objeto(new Dictionary<string, object> {
                { "version", Program.Version }, { "equipo", Environment.MachineName }, { "error", ultimoError }, { "empresa", empresa },
                { "historial", historial.Resumen() }, { "certificado", sii.EstadoCertificado } }));
            if (empresa != null) { historial.FijarRut(empresa["rut"] as string); sii.FijarRut(empresa["rut"] as string); }
            if (r.Estado == 409 || r.Estado == 400) throw new Exception("El portal no aceptó la sucursal: " + r.Valor("error"));
            if (r.Estado == 401) throw new Exception("La llave del agente no es válida. Genera una nueva en el portal y actualiza agente.ini.");
            if (r.Estado == 403) throw new Exception("El agente está desactivado en el portal.");
            if (!r.Ok) throw new Exception("El portal respondió " + r.Estado);
            if (ultimoHola == DateTime.MinValue) Log.Info("Conectado al portal: " + r.Valor("sucursal") + " (" + r.Valor("rut") + ")");
            try
            {
                var datos = JsonLector.Leer(r.Cuerpo) as Dictionary<string, object>;
                object m;
                Actualizador.Confirmar();
                Actualizador.Revisar(portal, datos);
                CambioCarpeta.Revisar(cfg, portal, datos);
                respaldo.Recibir(datos);
                ultimaRespuestaHola = datos;
                object u;
                if (datos != null && datos.TryGetValue("mesesUrgentes", out u) && u is List<object>)
                    foreach (var x in ((List<object>)u).OfType<string>().Where(x => Regex.IsMatch(x, @"^\d{4}-\d{2}$")))
                        if (!mesesUrgentesPendientes.Contains(x)) { mesesUrgentesPendientes.Add(x); ultimoEnvioMes.Remove(x); }
                if (datos != null && datos.TryGetValue("mesesVentas", out m) && m is List<object>)
                    mesesPortal = ((List<object>)m).OfType<string>().Where(x => Regex.IsMatch(x, @"^\d{4}-\d{2}$")).ToList();
            }
            catch { }
            ultimoHola = DateTime.Now;
        }

        // ---------- Seguimiento de envío (trazadte / trazabol) ----------
        void EnviarTrazas(string tabla)
        {
            string ruta = BuscarArchivo(cfg.CarpetaDatos, tabla);
            if (ruta == null) return;
            string desde = DateTime.Today.AddDays(-cfg.DiasTraza).ToString("yyyy-MM-dd");
            if (string.CompareOrdinal(desde, cfg.Desde) < 0) desde = cfg.Desde;
            var cambios = new List<KeyValuePair<string, Dictionary<string, object>>>();
            using (var t = new TablaDbf(ruta))
            {
                // Se leen desde el final (lo más reciente) hasta encontrar muchos registros seguidos más antiguos
                int viejosSeguidos = 0;
                for (int i = t.Registros - 1; i >= 0 && viejosSeguidos < 500; i--)
                {
                    var r = t.Leer(i);
                    if (r == null) continue;
                    string fecha = r.Fecha("TRAFECDOC");
                    if (fecha == null || string.CompareOrdinal(fecha, desde) < 0) { viejosSeguidos++; continue; }
                    viejosSeguidos = 0;
                    int tipo, folio;
                    if (!int.TryParse(r.Texto("TRATIPDOC"), out tipo) || !int.TryParse(r.Texto("TRANUMDOC"), out folio)) continue;
                    var d = new Dictionary<string, object> {
                        { "tipo", tipo }, { "folio", folio }, { "fecha", fecha },
                        { "rutReceptor", r.Texto("TRARUTDOC") }, { "nombreReceptor", r.Texto("TRANOMDOC") },
                        { "monto", r.Numero("TRAMONDOC") }, { "emitido", r.Texto("TRAEMITIDO") }, { "enviado", r.Texto("TRAENVIO") },
                        { "estadoEnvio", r.Texto("TRAENVSTA") }, { "trackId", r.Texto("TRACKIDEN") },
                        { "estadoSii", r.Texto("TRARECSTA") }, { "detalleSii", r.Texto("TRARECDET") },
                    };
                    string clave = tipo + "-" + folio;
                    string huella = Json.Objeto(d);
                    if (estado.HuellaTraza(clave) != huella) cambios.Add(new KeyValuePair<string, Dictionary<string, object>>(clave + "|" + fecha + "|" + huella, d));
                }
            }
            if (cambios.Count == 0) return;
            cambios.Reverse(); // del más antiguo al más nuevo
            int enviados = 0;
            foreach (var lote in Lotes(cambios, 1000))
            {
                var r = portal.Enviar("/trazas", Json.Objeto(new Dictionary<string, object> { { "trazas", lote.Select(x => x.Value).ToList() } }));
                if (!r.Ok) throw new Exception("Trazas rechazadas por el portal (" + r.Estado + "): " + r.Cuerpo);
                foreach (var x in lote)
                {
                    var p = x.Key.Split(new[] { '|' }, 3);
                    estado.FijarTraza(p[0], p[1], p[2]);
                }
                enviados += lote.Count;
            }
            Log.Info(tabla + ": " + enviados + " documentos nuevos o con cambios enviados al portal.");
        }

        // ---------- XML de documentos emitidos ----------
        // XML avisados por el vigilante (cualquier carpeta de mes: un documento corregido y republicado
        // queda en la carpeta del mes del documento, no en la del mes en curso)
        readonly HashSet<string> xmlAvisados = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        DateTime ultimaRevisionMeses = DateTime.MinValue;

        void EnviarXml()
        {
            if (!Directory.Exists(cfg.CarpetaDte)) return;
            var pendientes = new List<FileInfo>();
            DateTime limite = DateTime.Now.AddSeconds(-3);
            var vistos = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            List<string> avisados;
            lock (xmlAvisados) { avisados = xmlAvisados.ToList(); xmlAvisados.Clear(); }
            foreach (string ruta in avisados)
            {
                try
                {
                    var f = new FileInfo(ruta);
                    if (!f.Exists || !Regex.IsMatch(f.Directory.Name, @"^\d{4}$") || !f.Name.EndsWith(".xml", StringComparison.OrdinalIgnoreCase)) continue;
                    if (f.LastWriteTime > limite) { lock (xmlAvisados) xmlAvisados.Add(ruta); continue; } // todavía se está escribiendo
                    if (!estado.XmlEnviado(f.Name) && vistos.Add(f.FullName)) pendientes.Add(f);
                }
                catch { }
            }
            // Cada hora, por si el vigilante perdió algún aviso: XML recientes en las carpetas de los meses que se cuadran
            if ((DateTime.Now - ultimaRevisionMeses).TotalMinutes >= 60)
            {
                ultimaRevisionMeses = DateTime.Now;
                foreach (string m in mesesPortal)
                {
                    string carpeta = Path.Combine(cfg.CarpetaDte, m.Substring(2, 2) + m.Substring(5, 2));
                    if (!Directory.Exists(carpeta)) continue;
                    foreach (var f in new DirectoryInfo(carpeta).GetFiles("*.xml"))
                        if (f.LastWriteTime > DateTime.Now.AddDays(-3) && f.LastWriteTime <= limite && !estado.XmlEnviado(f.Name) && vistos.Add(f.FullName)) pendientes.Add(f);
                }
            }
            foreach (string mes in MesesAVigilar())
            {
                string carpeta = Path.Combine(cfg.CarpetaDte, mes);
                if (!Directory.Exists(carpeta)) continue;
                foreach (var f in new DirectoryInfo(carpeta).GetFiles("*.xml"))
                {
                    if (f.LastWriteTime > limite) continue; // todavía se está escribiendo
                    if (string.CompareOrdinal(f.LastWriteTime.ToString("yyyy-MM-dd"), cfg.Desde) < 0) continue;
                    if (!estado.XmlEnviado(f.Name) && vistos.Add(f.FullName)) pendientes.Add(f);
                }
            }
            if (pendientes.Count == 0) return;
            int ok = 0, rechazados = 0;
            foreach (var lote in Lotes(pendientes.OrderBy(f => f.LastWriteTime).ToList(), 50))
            {
                var archivos = new List<object>();
                foreach (var f in lote)
                {
                    byte[] bytes;
                    try { bytes = LeerCompartido(f.FullName); }
                    catch (IOException) { continue; } // ocupado: se intenta en el próximo ciclo
                    archivos.Add(new Dictionary<string, object> { { "nombre", f.Name }, { "contenido", Convert.ToBase64String(Gzip(bytes)) } });
                }
                if (archivos.Count == 0) continue;
                var r = portal.Enviar("/xml", Json.Objeto(new Dictionary<string, object> { { "archivos", archivos } }));
                if (!r.Ok) throw new Exception("XML rechazados por el portal (" + r.Estado + "): " + r.Cuerpo);
                foreach (var f in lote) estado.MarcarXml(f.Name);
                int rech = CuentaRechazados(r.Cuerpo);
                if (rech > 0) Log.Error("El portal rechazó " + rech + " XML: " + r.Cuerpo);
                ok += archivos.Count - rech;
                rechazados += rech;
            }
            Log.Info("XML: " + ok + " documentos enviados al portal" + (rechazados > 0 ? ", " + rechazados + " rechazados" : "") + ".");
        }

        static int CuentaRechazados(string cuerpo)
        {
            int i = cuerpo.IndexOf("\"rechazados\"", StringComparison.Ordinal);
            if (i < 0) return 0;
            int fin = cuerpo.IndexOf(']', i);
            string parte = fin > i ? cuerpo.Substring(i, fin - i) : "";
            int n = 0, pos = 0;
            while ((pos = parte.IndexOf("\"nombre\"", pos, StringComparison.Ordinal)) >= 0) { n++; pos++; }
            return n;
        }

        /// <summary>Carpetas AAMM a revisar: el mes actual y, los primeros días, también el anterior.</summary>
        IEnumerable<string> MesesAVigilar()
        {
            var hoy = DateTime.Today;
            if (hoy.Day <= 5) yield return hoy.AddMonths(-1).ToString("yyMM");
            yield return hoy.ToString("yyMM");
        }

        static byte[] LeerCompartido(string ruta)
        {
            using (var fs = new FileStream(ruta, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
            using (var ms = new MemoryStream())
            {
                fs.CopyTo(ms);
                return ms.ToArray();
            }
        }

        static byte[] Gzip(byte[] datos)
        {
            using (var ms = new MemoryStream())
            {
                using (var gz = new GZipStream(ms, CompressionMode.Compress)) gz.Write(datos, 0, datos.Length);
                return ms.ToArray();
            }
        }

        static IEnumerable<List<T>> Lotes<T>(List<T> lista, int tamano)
        {
            for (int i = 0; i < lista.Count; i += tamano) yield return lista.GetRange(i, Math.Min(tamano, lista.Count - i));
        }

        static string BuscarArchivo(string carpeta, string nombre)
        {
            if (!Directory.Exists(carpeta)) return null;
            return Directory.GetFiles(carpeta, nombre).FirstOrDefault();
        }
    }

    /// <summary>Lo ya enviado al portal (para no repetir). Se guarda en la carpeta "estado" del agente.</summary>
    public class Estado
    {
        readonly string carpeta;
        readonly Dictionary<string, KeyValuePair<string, string>> trazas = new Dictionary<string, KeyValuePair<string, string>>(); // clave -> (fecha, huella)
        readonly HashSet<string> xml = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        bool cambios;

        public Estado(string c)
        {
            carpeta = c;
            Directory.CreateDirectory(carpeta);
            string ft = Path.Combine(carpeta, "trazas.txt");
            if (File.Exists(ft))
                foreach (var l in File.ReadAllLines(ft, Encoding.UTF8))
                {
                    var p = l.Split(new[] { '\t' }, 3);
                    if (p.Length == 3) trazas[p[0]] = new KeyValuePair<string, string>(p[1], p[2]);
                }
            string fx = Path.Combine(carpeta, "xml.txt");
            if (File.Exists(fx)) foreach (var l in File.ReadAllLines(fx)) if (l.Length > 0) xml.Add(l);
        }

        public string HuellaTraza(string clave)
        {
            KeyValuePair<string, string> v;
            return trazas.TryGetValue(clave, out v) ? v.Value : null;
        }

        public void FijarTraza(string clave, string fecha, string huella) { trazas[clave] = new KeyValuePair<string, string>(fecha, huella); cambios = true; }
        public bool XmlEnviado(string nombre) { return xml.Contains(nombre); }
        public void MarcarXml(string nombre) { if (xml.Add(nombre)) cambios = true; }

        public void Guardar()
        {
            if (!cambios) return;
            // Se olvida lo de hace más de 45 días para que los archivos no crezcan sin fin
            string corte = DateTime.Today.AddDays(-45).ToString("yyyy-MM-dd");
            var lineas = trazas.Where(kv => string.CompareOrdinal(kv.Value.Key, corte) >= 0)
                               .Select(kv => kv.Key + "\t" + kv.Value.Key + "\t" + kv.Value.Value).ToList();
            EscribirSeguro(Path.Combine(carpeta, "trazas.txt"), lineas);
            string mesMin = DateTime.Today.AddMonths(-2).ToString("yyyyMMdd");
            // nombre de XML Sisgen: t39f1730198-20261111-191629.xml (la fecha va después del primer guion)
            var xs = xml.Where(n => { var p = n.Split('-'); return p.Length < 2 || string.CompareOrdinal(p[1], mesMin) >= 0; }).ToList();
            EscribirSeguro(Path.Combine(carpeta, "xml.txt"), xs);
            cambios = false;
        }

        static void EscribirSeguro(string ruta, List<string> lineas)
        {
            string tmp = ruta + ".tmp";
            File.WriteAllLines(tmp, lineas, Encoding.UTF8);
            if (File.Exists(ruta)) File.Replace(tmp, ruta, null);
            else File.Move(tmp, ruta);
        }
    }
}
