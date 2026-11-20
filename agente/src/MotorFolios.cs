// Módulo de folios del servicio: revisa cada ciclo cuántos folios quedan en una carpeta de Sisgen y
//   - si un documento se acabó y hay un CAF en espera: lo asigna solo (salto automático)
//   - si quedan pocos y no hay CAF en espera: publica un aviso para que AvisoFolios.exe lo muestre en cada PC
//   - si alguien responde el aviso con una cantidad: pide el CAF al SII y lo carga
//   - si el aviso llega a crítico y nadie responde: pide la misma cantidad del último rango cargado
// Comunicación con los PC: carpeta procesos\folios\agente\ de Sisgen (los PC ya la ven por la red):
//   avisos.txt  (lo escribe el servicio)   pedido_*.txt (lo escribe AvisoFolios.exe)
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading;

namespace SisgenAgente
{
    /// <summary>Servicio que solo atiende folios (agente sin llave del portal): revisa cada carpeta cada cierto tiempo.</summary>
    public class CicloFolios
    {
        readonly List<MotorFolios> motores;
        readonly int segundos;
        readonly ManualResetEvent detener = new ManualResetEvent(false);
        Thread hilo;

        public CicloFolios(Config c)
        {
            motores = c.CarpetasFolios.Select(x => new MotorFolios(x)).ToList();
            segundos = c.IntervaloSegundos;
        }

        public void Ciclo()
        {
            foreach (var m in motores)
                try { m.Revisar(); } catch (Exception e) { Log.Error("Folios: " + e.Message); }
        }

        public void Iniciar()
        {
            Log.Info("Agente Sisgen " + Program.Version + " iniciado solo para folios: " + string.Join(", ", motores.Select(m => m.Carpeta)) +
                     (CafSii.SoloCertificacion ? " (pedidos al SII solo en certificación)" : ""));
            hilo = new Thread(() => { do Ciclo(); while (!detener.WaitOne(segundos * 1000)); }) { IsBackground = true, Name = "folios" };
            hilo.Start();
        }

        public void Detener()
        {
            detener.Set();
            if (hilo != null) hilo.Join(30000);
            Log.Info("Agente detenido.");
        }
    }

    public class MotorFolios
    {
        public string Carpeta { get { return sisgen; } }
        public static int PorcentajeAviso = 20, PorcentajeCritico = 5, MinutosCritico = 30;
        // Aviso por documento (código SII -> avisar cuando queden N folios). agente.ini: avisoFolios=39:200;61:5;33:20
        public static readonly Dictionary<string, long> AvisoPorTipo = new Dictionary<string, long>();

        public static void LeerAvisos(string texto)
        {
            AvisoPorTipo.Clear();
            foreach (var par in (texto ?? "").Split(';'))
            {
                var p = par.Split(':');
                long n;
                if (p.Length == 2 && long.TryParse(p[1].Trim(), out n) && n > 0) AvisoPorTipo[p[0].Trim()] = n;
            }
        }

        readonly string sisgen, datos, comunicacion, cola, respaldos;
        readonly Dictionary<string, DateTime> criticoDesde = new Dictionary<string, DateTime>();
        readonly Dictionary<string, Tuple<long, DateTime>> maximoSii = new Dictionary<string, Tuple<long, DateTime>>();
        readonly List<Tuple<DateTime, string>> mensajes = new List<Tuple<DateTime, string>>();

        public MotorFolios(string carpetaSisgen)
        {
            sisgen = carpetaSisgen.TrimEnd('\\');
            datos = Path.Combine(sisgen, "datos");
            comunicacion = Path.Combine(sisgen, "procesos", "folios", "agente");
            cola = Path.Combine(Program.Carpeta, "caf", Path.GetFileName(sisgen));
            respaldos = Path.Combine(Program.Carpeta, "respaldos");
            // Salto inmediato: apenas Sisgen guarda un correlativo se revisa si se acabó el rango (además del ciclo normal)
            try
            {
                vigilante = new FileSystemWatcher(datos, "correlat.dbf") { NotifyFilter = NotifyFilters.LastWrite | NotifyFilters.Size };
                temporizador = new System.Threading.Timer(_ => SaltoRapido(), null, System.Threading.Timeout.Infinite, System.Threading.Timeout.Infinite);
                vigilante.Changed += (s, e) => temporizador.Change(500, System.Threading.Timeout.Infinite);
                vigilante.EnableRaisingEvents = true;
            }
            catch (Exception ex) { Log.Error("Folios: no se pudo vigilar correlat.dbf (" + ex.Message + "); el salto se revisa en cada ciclo."); }
            // Pedidos de las cajas: se atienden apenas llegan (la caja que pidió está esperando con una ventana abierta)
            try
            {
                Directory.CreateDirectory(comunicacion);
                vigilantePedidos = new FileSystemWatcher(comunicacion, "pedido_*.txt") { NotifyFilter = NotifyFilters.FileName | NotifyFilters.LastWrite };
                temporizadorPedidos = new System.Threading.Timer(_ => { try { Revisar(); } catch (Exception ex) { Log.Error("Folios: " + ex.Message); } },
                                                                 null, System.Threading.Timeout.Infinite, System.Threading.Timeout.Infinite);
                FileSystemEventHandler h = (s, e) => temporizadorPedidos.Change(1000, System.Threading.Timeout.Infinite);
                vigilantePedidos.Created += h;
                vigilantePedidos.Changed += h;
                vigilantePedidos.EnableRaisingEvents = true;
            }
            catch (Exception ex) { Log.Error("Folios: no se pudo vigilar los pedidos (" + ex.Message + "); se atienden en cada ciclo."); }
        }

        readonly object candado = new object();
        readonly FileSystemWatcher vigilante, vigilantePedidos;
        readonly System.Threading.Timer temporizador, temporizadorPedidos;

        /// <summary>Revisión liviana (solo prmsis y correlat): si un rango se acabó y hay CAF en espera, lo asigna.</summary>
        void SaltoRapido()
        {
            lock (candado)
            {
                try
                {
                    RegistroDbf prm, cor = null;
                    using (var t = new TablaDbf(Ventas.Buscar(datos, "prmsis.dbf"))) prm = t.Registros > 0 ? t.Leer(0) : null;
                    using (var t = new TablaDbf(Ventas.Buscar(datos, "correlat.dbf"))) cor = t.Registros > 0 ? t.Leer(0) : null;
                    if (prm == null || cor == null) return;
                    foreach (var tipo in TipoFolio.Todos)
                    {
                        long tope, prox, esp;
                        long.TryParse(prm.Texto("DTEFOLIO" + tipo.Sisgen).Trim(), out tope);
                        long.TryParse(cor.Texto(tipo.Correlativo).Trim(), out prox);
                        long.TryParse(prm.Texto("FOLIOHAS" + tipo.Espera).Trim(), out esp);
                        if (tope <= 0 || prox <= tope || esp <= 0) continue;
                        string r = CargaCaf.AsignarEspera(sisgen, tipo, respaldos);
                        if (r != null) Informar(r);
                    }
                }
                catch (Exception ex) { Log.Error("Folios (salto): " + ex.Message); }
            }
        }

        public void Revisar() { lock (candado) RevisarSinCandado(); }

        void RevisarSinCandado()
        {
            Directory.CreateDirectory(comunicacion);
            var estados = Folios.Calcular(datos, DateTime.Today);
            // 1) Salto automático al CAF en espera
            foreach (var e in estados.Where(x => x.Proximo > x.Tope && x.EsperaHasta > 0))
            {
                string r = CargaCaf.AsignarEspera(sisgen, e.Tipo, respaldos);
                if (r != null) Informar(r);
            }
            estados = Folios.Calcular(datos, DateTime.Today);
            // 2) Pedidos de los PC
            foreach (var archivo in Directory.GetFiles(comunicacion, "pedido_*.txt").OrderBy(f => File.GetLastWriteTime(f)))
            {
                Dictionary<string, string> p;
                try { p = LeerPedido(archivo); } catch { continue; }
                BorrarPedidos(p.ContainsKey("tipo") ? p["tipo"] : null, archivo);
                try { Atender(estados, p); }
                catch (Exception ex) { Informar("No se pudieron cargar folios: " + ex.Message, true); }
                estados = Folios.Calcular(datos, DateTime.Today);
            }
            // 3) Avisos (y carga automática en crítico)
            var lineas = new List<string>();
            foreach (var e in estados)
            {
                string nivel = Nivel(e);
                string id = e.Tipo.Sii + "-" + e.Tope;
                if (nivel == null) { criticoDesde.Remove(id); continue; }
                long max = e.Tipo.Vence ? MaximoSii(e.Tipo) : 0;
                if (nivel == "critico")
                {
                    if (!criticoDesde.ContainsKey(id)) criticoDesde[id] = DateTime.Now;
                    if ((DateTime.Now - criticoDesde[id]).TotalMinutes >= MinutosCritico)
                    {
                        criticoDesde.Remove(id);
                        long cant = e.UltimoRango;
                        if (e.Tipo.Vence && max > 0) cant = Math.Min(cant, max);
                        if (cant <= 0 || (e.Tipo.Vence && max <= 0))
                        {
                            if (soporteAvisado.Add(id)) Informar(e.Tipo.Nombre + ": quedan " + e.Quedan + " folios y no se pudieron cargar solos. Llame a soporte.", true);
                        }
                        else
                        {
                            try { Cargar(e, (int)cant, "automático (nadie respondió el aviso)"); continue; }
                            catch (Exception ex) { Informar(e.Tipo.Nombre + ": no se pudieron cargar folios solos (" + ex.Message + "). Llame a soporte.", true); }
                        }
                    }
                }
                lineas.Add(string.Join("|", "aviso", id, e.Tipo.Sii, e.Tipo.Nombre, e.Quedan.ToString(), e.Tope.ToString(),
                    max.ToString(), e.Tipo.Vence ? "vence" : "", nivel));
            }
            mensajes.RemoveAll(m => (DateTime.Now - m.Item1).TotalMinutes > 15);
            foreach (var m in mensajes) lineas.Add("mensaje|" + m.Item1.ToString("yyyyMMddHHmmss") + "|" + m.Item2.Replace("|", "/"));
            lineas.Insert(0, "sucursal|" + Sucursal().Replace("|", "/"));
            Escribir(Path.Combine(comunicacion, "avisos.txt"), lineas);
        }

        /// <summary>Nombre para mostrar en el aviso: sucursal o dirección de empres.dbf (si no, la carpeta).</summary>
        string Sucursal()
        {
            try
            {
                using (var t = new TablaDbf(Ventas.Buscar(datos, "empres.dbf")))
                {
                    var r = t.Leer(0);
                    string s = t.Campos.ContainsKey("DTESUC") ? r.Texto("DTESUC").Trim() : "";
                    if (s.Length == 0 && t.Campos.ContainsKey("DTEDIR")) s = r.Texto("DTEDIR").Trim();
                    if (s.Length > 0) return s;
                }
            }
            catch { }
            return Path.GetFileName(sisgen);
        }

        // Avisos de "llame a soporte" ya dados (no se repiten mientras no cambie el rango)
        readonly HashSet<string> soporteAvisado = new HashSet<string>();

        static string Nivel(EstadoFolio e)
        {
            if (e.Tope <= 0 || e.EsperaHasta > 0) return null; // tipo no usado o ya tiene CAF en espera
            long tamano = e.Activo != null ? e.Activo.Hasta - e.Activo.Desde + 1 : e.UltimoRango;
            if (tamano <= 0) tamano = 100;
            if (e.Activo != null && e.Quedan >= tamano) return null; // rango recién asignado, sin usar: no se vuelve a preguntar
            long critico, aviso, porTipo;
            if (AvisoPorTipo.TryGetValue(e.Tipo.Sii, out porTipo))
            {
                // Configurado para este documento: avisa con N y es crítico con la cuarta parte
                aviso = porTipo;
                critico = Math.Max(1, (long)Math.Ceiling(porTipo / 4.0));
            }
            else
            {
                critico = Math.Max(1, (long)Math.Ceiling(tamano * PorcentajeCritico / 100.0));
                aviso = Math.Max(critico + 1, (long)Math.Ceiling(tamano * PorcentajeAviso / 100.0));
            }
            if (e.Quedan <= critico) return "critico";
            if (e.Quedan <= aviso) return "aviso";
            return null;
        }

        void Atender(List<EstadoFolio> estados, Dictionary<string, string> p)
        {
            string tipo, cantTxt;
            int cant;
            if (!p.TryGetValue("tipo", out tipo) || !p.TryGetValue("cantidad", out cantTxt) || !int.TryParse(cantTxt, out cant) || cant < 1)
                throw new Exception("pedido no válido");
            var e = estados.FirstOrDefault(x => x.Tipo.Sii == tipo);
            if (e == null || Nivel(e) == null) return; // ya no hace falta (otro PC lo cargó)
            long limite = Math.Max(100000, e.UltimoRango * 10);
            if (cant > limite) throw new Exception("la cantidad " + cant + " es mayor que lo permitido (" + limite + ")");
            string quien = (p.ContainsKey("usuario") ? p["usuario"] : "?") + " en " + (p.ContainsKey("equipo") ? p["equipo"] : "?");
            Cargar(e, cant, "pedido por " + quien);
        }

        void Cargar(EstadoFolio e, int cantidad, string motivo)
        {
            var caf = new CafSii(sisgen);
            var propuesta = caf.Consultar(int.Parse(e.Tipo.Sii), cantidad);
            if (e.Tipo.Vence && propuesta.MaximoAutorizado > 0 && cantidad > propuesta.MaximoAutorizado)
                throw new Exception("el SII autoriza hasta " + propuesta.MaximoAutorizado);
            string xml = caf.Pedir(propuesta, cola);
            Log.Info("Folios " + e.Tipo.Nombre + " " + propuesta.Desde + "-" + propuesta.Hasta + " pedidos al SII (" + motivo + ").");
            string r = CargaCaf.Cargar(sisgen, xml, respaldos);
            Log.Info(r);
            // En espera: Sisgen sigue con el rango actual hasta el final (no hay que reabrir nada).
            // Asignado (no quedaban folios): se usa ya y la pantalla de ventas debe reabrirse.
            if (r.Contains(" asignado"))
                Informar(e.Tipo.Nombre + ": se asignaron los folios " + propuesta.Desde + " al " + propuesta.Hasta + " (" + motivo + ").");
            else
                Informar(e.Tipo.Nombre + ": se cargaron los folios " + propuesta.Desde + " al " + propuesta.Hasta +
                         ". Se usarán cuando se terminen los actuales (" + motivo + ").");
        }

        long MaximoSii(TipoFolio t)
        {
            Tuple<long, DateTime> m;
            if (maximoSii.TryGetValue(t.Sii, out m) && (DateTime.Now - m.Item2).TotalHours < 1) return m.Item1;
            long max = 0;
            try { max = new CafSii(sisgen).Consultar(int.Parse(t.Sii), 1).MaximoAutorizado; }
            catch (Exception ex) { Log.Error("Folios: no se pudo consultar el máximo del SII para " + t.Nombre + ": " + ex.Message); }
            maximoSii[t.Sii] = Tuple.Create(max, DateTime.Now);
            return max;
        }

        // La pantalla de ventas de Sisgen lee los folios solo al abrirse
        const string Recordatorio = " Recuerda cerrar y volver a abrir la pantalla de ventas.";

        void Informar(string texto, bool error = false)
        {
            // Solo cuando el rango nuevo empieza a usarse
            if (!error && (texto.Contains("se asignaron") || texto.Contains("se asignó"))) texto += Recordatorio;
            if (error) Log.Error("Folios: " + texto); else Log.Info("Folios: " + texto);
            mensajes.Add(Tuple.Create(DateTime.Now, texto));
        }

        static Dictionary<string, string> LeerPedido(string archivo)
        {
            var d = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            foreach (var l in File.ReadAllLines(archivo, Encoding.UTF8))
            {
                int i = l.IndexOf('=');
                if (i > 0) d[l.Substring(0, i).Trim()] = l.Substring(i + 1).Trim();
            }
            return d;
        }

        void BorrarPedidos(string tipo, string archivo)
        {
            foreach (var f in Directory.GetFiles(comunicacion, "pedido_*.txt"))
            {
                bool mismo = f == archivo;
                if (!mismo && tipo != null)
                    try { string t; mismo = LeerPedido(f).TryGetValue("tipo", out t) && t == tipo; } catch { }
                if (mismo) try { File.Delete(f); } catch { }
            }
        }

        static void Escribir(string ruta, List<string> lineas)
        {
            string tmp = ruta + ".tmp";
            File.WriteAllLines(tmp, lineas, Encoding.UTF8);
            if (File.Exists(ruta)) File.Replace(tmp, ruta, null); else File.Move(tmp, ruta);
        }
    }
}
