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
        // Aviso por documento (código SII -> avisar cuando queden N folios; 0 = no vigilar ese documento).
        // agente.ini: avisoFolios=39:200;61:5;33:0
        public static readonly Dictionary<string, long> AvisoPorTipo = new Dictionary<string, long>();

        /// <summary>Documento desmarcado en el instalador (avisoFolios=33:0): no se avisa, no se piden ni cargan folios.</summary>
        public static bool NoVigilar(TipoFolio t) { long n; return AvisoPorTipo.TryGetValue(t.Sii, out n) && n == 0; }

        public static void LeerAvisos(string texto)
        {
            AvisoPorTipo.Clear();
            foreach (var par in (texto ?? "").Split(';'))
            {
                var p = par.Split(':');
                long n;
                if (p.Length == 2 && long.TryParse(p[1].Trim(), out n) && n >= 0) AvisoPorTipo[p[0].Trim()] = n;
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

        bool siiProbado;

        /// <summary>
        /// Al arrancar el servicio: entra al SII con el certificado (solo entra y sale, no pide nada) para saber de inmediato
        /// si podrá pedir folios cuando haga falta. El resultado queda en el registro y en estado_sii.txt (lo lee el instalador).
        /// </summary>
        public string ProbarSii()
        {
            string resultado;
            try
            {
                using (var caf = new CafSii(sisgen))
                {
                    caf.ProbarEntrada();
                    resultado = "ok|" + caf.Host + "|" + caf.EstadoCertificado;
                }
                Log.Info("Folios: prueba de entrada al SII correcta (" + Path.GetFileName(sisgen) + ").");
            }
            catch (Exception ex)
            {
                resultado = "error|" + ex.Message.Replace("|", "/").Replace("\r", " ").Replace("\n", " ");
                Log.Error("Folios: prueba de entrada al SII falló (" + Path.GetFileName(sisgen) + "): " + ex.Message);
            }
            try { Escribir(Path.Combine(comunicacion, "estado_sii.txt"), new List<string> { DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture) + "|" + Program.Version + "|" + resultado }); }
            catch { }
            return resultado;
        }

        void RevisarSinCandado()
        {
            Directory.CreateDirectory(comunicacion);
            if (!siiProbado) { siiProbado = true; ProbarSii(); }
            var estados = Folios.Calcular(datos, DateTime.Today);
            // 1) Salto automático al CAF en espera
            foreach (var e in estados.Where(x => x.Proximo > x.Tope && x.EsperaHasta > 0))
            {
                string r = CargaCaf.AsignarEspera(sisgen, e.Tipo, respaldos);
                if (r != null) Informar(r);
            }
            estados = Folios.Calcular(datos, DateTime.Today);
            // 1b) CAF ya pedidos al SII que no se alcanzaron a cargar (se cargan antes de pedir otros)
            if (CargarPendientes(estados)) estados = Folios.Calcular(datos, DateTime.Today);
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
            // 2b) Pedidos anotados (de una caja o automáticos) que todavía no resultan: se reintentan solos, con la misma cantidad
            foreach (var e in estados.ToList())
                if (IntentarPedidoAnotado(e)) estados = Folios.Calcular(datos, DateTime.Today);
            // 3) Avisos (y carga automática en crítico)
            var lineas = new List<string>();
            foreach (var e in estados)
            {
                string nivel = Nivel(e);
                string id = e.Tipo.Sii + "-" + e.Tope;
                // Con folios ya pedidos al SII sin cargar no se ofrece "Cargar" (pedir más solo gastaría folios)
                if (nivel != null && PendientesSinCargar(e).Count > 0) nivel = null;
                // Con un pedido ya anotado tampoco: la cantidad se escribe una sola vez y el agente la reintenta
                if (nivel != null && LeerPedidoAnotado(e.Tipo) != null) nivel = null;
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
                            AnotarPedidoCaja(e.Tipo, (int)cant, "automático (nadie respondió el aviso)");
                            IntentarPedidoAnotado(e);
                            continue; // desde aquí lo sigue el pedido anotado (no se vuelve a mostrar el cuadro)
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
            if (NoVigilar(e.Tipo)) return null;                 // desmarcado en el instalador: esta sucursal no lo emite
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
            if (LeerPedidoAnotado(e.Tipo) != null) return; // ya hay un pedido de este documento en curso: no se pide otro
            AnotarPedidoCaja(e.Tipo, cant, "pedido por " + quien);
            IntentarPedidoAnotado(e);
        }

        // ---------- Pedido anotado: la cantidad se escribe una sola vez ----------
        // caf\<carpeta>\pedido_anotado_<tipo>.txt: cantidad, motivo, desde (cuándo se pidió), intentos y último intento.
        // Sobrevive a reinicios del servicio. Se borra cuando el CAF ya se bajó del SII (desde ahí sigue la cola de CAF).
        public static int MinutosEntreReintentos = 10, ReintentosAntesDeSoporte = 12;

        string ArchivoPedidoAnotado(TipoFolio t) { return Path.Combine(cola, "pedido_anotado_" + t.Sii + ".txt"); }

        Dictionary<string, string> LeerPedidoAnotado(TipoFolio t)
        {
            try { string f = ArchivoPedidoAnotado(t); return File.Exists(f) ? LeerPedido(f) : null; }
            catch { return null; }
        }

        void GuardarPedidoAnotado(TipoFolio t, Dictionary<string, string> p)
        {
            Directory.CreateDirectory(cola);
            File.WriteAllLines(ArchivoPedidoAnotado(t), p.Select(kv => kv.Key + "=" + kv.Value), Encoding.UTF8);
        }

        void BorrarPedidoAnotado(TipoFolio t) { try { File.Delete(ArchivoPedidoAnotado(t)); } catch { } }

        void AnotarPedidoCaja(TipoFolio t, int cantidad, string motivo)
        {
            GuardarPedidoAnotado(t, new Dictionary<string, string> {
                { "cantidad", cantidad.ToString() }, { "motivo", motivo }, { "desde", DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture) },
                { "intentos", "0" }, { "ultimo", "" } });
            Log.Info("Folios: " + t.Nombre + ": se anotó el pedido de " + cantidad + " folios (" + motivo + ").");
        }

        /// <summary>
        /// Intenta el pedido anotado de un documento (si toca: el primero de inmediato, luego cada 10 minutos).
        /// Devuelve true si se cargaron folios. Si falla, el pedido queda anotado con la misma cantidad.
        /// </summary>
        bool IntentarPedidoAnotado(EstadoFolio e)
        {
            var p = LeerPedidoAnotado(e.Tipo);
            if (p == null) return false;
            int cant, intentos;
            if (!int.TryParse(p.ContainsKey("cantidad") ? p["cantidad"] : "", out cant) || cant < 1) { BorrarPedidoAnotado(e.Tipo); return false; }
            int.TryParse(p.ContainsKey("intentos") ? p["intentos"] : "0", out intentos);
            string motivo = p.ContainsKey("motivo") ? p["motivo"] : "pedido";
            // Ya no hace falta: el documento tiene folios en espera, se desmarcó, o ya hay un CAF bajado esperando cargarse
            if (Nivel(e) == null || PendientesSinCargar(e).Count > 0) { BorrarPedidoAnotado(e.Tipo); return false; }
            DateTime ultimo;
            if (intentos > 0 && DateTime.TryParseExact(p.ContainsKey("ultimo") ? p["ultimo"] : "", "yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture, DateTimeStyles.None, out ultimo)
                && (DateTime.Now - ultimo).TotalMinutes < MinutosEntreReintentos) return false;
            try
            {
                Cargar(e, cant, motivo + (intentos > 0 ? ", reintento " + intentos : ""));
                BorrarPedidoAnotado(e.Tipo);
                return true;
            }
            catch (Exception ex)
            {
                // Si el CAF alcanzó a bajarse, ahora lo maneja la cola de CAF (no se vuelve a pedir)
                if (PendientesSinCargar(e).Count > 0) { BorrarPedidoAnotado(e.Tipo); return false; }
                intentos++;
                p["intentos"] = intentos.ToString();
                p["ultimo"] = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture);
                // Facturas y notas: si se pidió más de lo que autoriza el SII, se ajusta al máximo (en vez de fallar siempre)
                var m = System.Text.RegularExpressions.Regex.Match(ex.Message, @"el SII autoriza hasta (\d+)");
                long max;
                if (m.Success && long.TryParse(m.Groups[1].Value, out max) && max > 0 && max < cant)
                {
                    p["cantidad"] = max.ToString();
                    p["ultimo"] = "";
                    p["intentos"] = "0";
                    Informar(e.Tipo.Nombre + ": el SII autoriza hasta " + max + " folios; se pedirán " + max + " en vez de " + cant + ".");
                }
                else if (intentos == 1)
                    Informar(e.Tipo.Nombre + ": no se pudieron cargar los folios ahora (" + ex.Message + "). Se reintentará solo cada " +
                             MinutosEntreReintentos + " minutos con la misma cantidad (" + cant + "). No hace falta volver a pedir.", true);
                else if (intentos == ReintentosAntesDeSoporte)
                    Informar(e.Tipo.Nombre + ": llevamos " + (intentos * MinutosEntreReintentos / 60) + " horas sin poder cargar los " + cant +
                             " folios pedidos (" + ex.Message + "). Se sigue intentando. Llame a soporte.", true);
                else Log.Error("Folios: " + e.Tipo.Nombre + ": reintento " + intentos + " sin resultado: " + ex.Message);
                try { GuardarPedidoAnotado(e.Tipo, p); } catch (Exception ex2) { Log.Error("Folios: no se pudo guardar el pedido anotado: " + ex2.Message); }
                return false;
            }
        }

        /// <summary>CAF en la cola del agente (pedidos al SII y aún no cargados en Sisgen) de un documento, del más antiguo al más nuevo.</summary>
        List<Tuple<string, long, long>> Pendientes(string tipoSii)
        {
            var l = new List<Tuple<string, long, long>>();
            if (!Directory.Exists(cola)) return l;
            foreach (var f in Directory.GetFiles(cola, "*.xml"))
            {
                var m = System.Text.RegularExpressions.Regex.Match(Path.GetFileName(f), @"^T(\d+)D(\d+)H(\d+)\.xml$", System.Text.RegularExpressions.RegexOptions.IgnoreCase);
                if (m.Success && m.Groups[1].Value == tipoSii) l.Add(Tuple.Create(f, long.Parse(m.Groups[2].Value), long.Parse(m.Groups[3].Value)));
            }
            return l.OrderBy(x => x.Item2).ToList();
        }

        /// <summary>Pendientes que de verdad faltan: sin los que ya están en folios.dbf.</summary>
        List<Tuple<string, long, long>> PendientesSinCargar(EstadoFolio e)
        {
            return Pendientes(e.Tipo.Sii).Where(x => !e.Cargados.Any(c => c.Desde == x.Item2 && c.Hasta == x.Item3)).ToList();
        }

        /// <summary>Saca un CAF de la cola una vez cargado (o si ya no sirve), dejándolo en una subcarpeta.</summary>
        void Archivar(string xml, string subcarpeta)
        {
            try
            {
                string d = Path.Combine(cola, subcarpeta);
                Directory.CreateDirectory(d);
                string destino = Path.Combine(d, Path.GetFileName(xml));
                if (File.Exists(destino)) destino = Path.Combine(d, DateTime.Now.ToString("yyyyMMdd_HHmmss_") + Path.GetFileName(xml));
                File.Move(xml, destino);
            }
            catch (Exception ex) { Log.Error("Folios: no se pudo archivar " + xml + ": " + ex.Message); }
        }

        readonly HashSet<string> pendienteAvisado = new HashSet<string>();

        /// <summary>
        /// Carga en Sisgen los CAF que el agente ya pidió al SII y no pudo cargar (por ejemplo, Sisgen ocupado o un error).
        /// Son folios ya autorizados: hay que usarlos antes de pedir otros. Carga como máximo uno por documento en cada revisión.
        /// </summary>
        bool CargarPendientes(List<EstadoFolio> estados)
        {
            bool cargo = false;
            foreach (var e in estados)
            {
                var p = Pendientes(e.Tipo.Sii).FirstOrDefault();
                if (p == null) continue;
                // Ya está en folios.dbf (lo cargó una versión anterior, que dejaba el XML en la cola, o se cargó a mano): solo se archiva
                if (e.Cargados.Any(c => c.Desde == p.Item2 && c.Hasta == p.Item3)) { Archivar(p.Item1, "cargados"); cargo = true; continue; }
                // Documento desmarcado en el instalador: no se le carga nada, ni siquiera lo ya pedido (se anula en el SII)
                if (NoVigilar(e.Tipo))
                {
                    if (pendienteAvisado.Add(p.Item1 + "|novigilar"))
                        Log.Error("Folios: " + Path.GetFileName(p.Item1) + " no se carga porque " + e.Tipo.Nombre + " está desmarcado en el instalador (anularlo en el SII si no se usará).");
                    continue;
                }
                if (p.Item3 < e.Proximo)
                {
                    // Ya quedaron atrás (Sisgen avanzó con otros folios): no se pueden usar
                    Log.Error("Folios: el CAF " + Path.GetFileName(p.Item1) + " quedó atrás del próximo folio " + e.Proximo + "; se aparta (hay que anularlo en el SII).");
                    Informar(e.Tipo.Nombre + ": los folios " + p.Item2 + " al " + p.Item3 + " pedidos al SII no se pudieron usar. Llame a soporte.", true);
                    Archivar(p.Item1, "no_usados");
                    continue;
                }
                if (e.EsperaHasta > 0 && e.Proximo <= e.Tope) continue; // la ranura de espera de Sisgen está ocupada: se carga después
                try
                {
                    string r = CargaCaf.Cargar(sisgen, p.Item1, respaldos);
                    Log.Info(r + " (CAF ya pedido al SII)");
                    Archivar(p.Item1, "cargados");
                    Informar(e.Tipo.Nombre + ": se cargaron los folios " + p.Item2 + " al " + p.Item3 + " (ya estaban pedidos al SII).");
                    cargo = true;
                }
                catch (Exception ex)
                {
                    if (ex.Message.Contains("ya está cargado")) { Archivar(p.Item1, "cargados"); continue; }
                    if (pendienteAvisado.Add(p.Item1 + ex.Message)) Log.Error("Folios: no se pudo cargar " + Path.GetFileName(p.Item1) + " (ya pedido al SII): " + ex.Message);
                }
            }
            return cargo;
        }

        // Tope de seguridad de pedidos al SII por documento (se guarda en la cola, así sobrevive a reinicios del servicio)
        public static int PedidosPorHora = 1, PedidosPorDia = 3;
        string ArchivoPedidos { get { return Path.Combine(cola, "pedidos_sii.txt"); } }

        /// <summary>Pedidos al SII ya hechos de un documento (fecha y hora de cada uno).</summary>
        List<DateTime> PedidosHechos(TipoFolio t)
        {
            var l = new List<DateTime>();
            try
            {
                if (!File.Exists(ArchivoPedidos)) return l;
                foreach (var linea in File.ReadAllLines(ArchivoPedidos))
                {
                    var p = linea.Split('|');
                    DateTime f;
                    if (p.Length >= 2 && p[1] == t.Sii && DateTime.TryParseExact(p[0], "yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture, DateTimeStyles.None, out f)) l.Add(f);
                }
            }
            catch (Exception ex) { Log.Error("Folios: no se pudo leer " + ArchivoPedidos + ": " + ex.Message); }
            return l;
        }

        /// <summary>Frena el pedido si ya se pidieron folios de ese documento hace menos de una hora, o 3 veces hoy.</summary>
        void RevisarTope(TipoFolio t)
        {
            var hechos = PedidosHechos(t);
            int ultimaHora = hechos.Count(f => (DateTime.Now - f).TotalMinutes < 60), hoy = hechos.Count(f => f.Date == DateTime.Today);
            if (ultimaHora >= PedidosPorHora || hoy >= PedidosPorDia)
                throw new Exception("límite de seguridad: ya se pidieron folios de " + t.Nombre + " al SII " +
                                    (ultimaHora >= PedidosPorHora ? "hace menos de una hora" : hoy + " veces hoy") +
                                    ". No se pidieron más. Llame a soporte");
        }

        void AnotarPedido(TipoFolio t, long desde, long hasta)
        {
            try
            {
                Directory.CreateDirectory(cola);
                File.AppendAllText(ArchivoPedidos, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture) + "|" + t.Sii + "|" + desde + "-" + hasta + Environment.NewLine);
            }
            catch (Exception ex) { Log.Error("Folios: no se pudo anotar el pedido: " + ex.Message); }
        }

        void Cargar(EstadoFolio e, int cantidad, string motivo)
        {
            // No se piden más folios al SII mientras haya otros ya pedidos sin cargar
            var pend = PendientesSinCargar(e);
            if (pend.Count > 0)
                throw new Exception("hay folios ya pedidos al SII sin cargar (" + string.Join(", ", pend.Select(x => x.Item2 + "-" + x.Item3)) + "); no se pidieron más");
            // Tope de seguridad: aunque aparezca un error que no conocemos, nunca se piden folios en bucle
            RevisarTope(e.Tipo);
            PropuestaCaf propuesta;
            string xml;
            using (var caf = new CafSii(sisgen)) // al salir cierra la sesión del SII
            {
                propuesta = caf.Consultar(int.Parse(e.Tipo.Sii), cantidad);
                if (e.Tipo.Vence && propuesta.MaximoAutorizado > 0 && cantidad > propuesta.MaximoAutorizado)
                    throw new Exception("el SII autoriza hasta " + propuesta.MaximoAutorizado);
                xml = caf.Pedir(propuesta, cola);
            }
            AnotarPedido(e.Tipo, propuesta.Desde, propuesta.Hasta);
            Log.Info("Folios " + e.Tipo.Nombre + " " + propuesta.Desde + "-" + propuesta.Hasta + " pedidos al SII (" + motivo + ").");
            string r = CargaCaf.Cargar(sisgen, xml, respaldos); // si falla, el XML queda en la cola y se reintenta en la próxima revisión
            Log.Info(r);
            Archivar(xml, "cargados");
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
            // Se guarda 1 hora; si el SII no respondió, se vuelve a intentar a los 10 minutos.
            if (maximoSii.TryGetValue(t.Sii, out m) && (DateTime.Now - m.Item2).TotalMinutes < (m.Item1 > 0 ? 60 : 10)) return m.Item1;
            long max = 0;
            try { using (var caf = new CafSii(sisgen)) max = caf.Consultar(int.Parse(t.Sii), 1).MaximoAutorizado; }
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
