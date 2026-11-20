// Agente Sisgen: servicio de Windows que envía al Portal Sisgen cada documento emitido por la sucursal
// (XML) y su seguimiento de envío al SII (tablas trazadte / trazabol de DTESERVICE).
//
//   SisgenAgente.exe              -> se ejecuta como servicio de Windows (instalar con instalar.bat)
//   SisgenAgente.exe --consola    -> se ejecuta en la ventana, para pruebas (Ctrl+C para salir)
//   SisgenAgente.exe --una-vez    -> un solo ciclo y termina (diagnóstico)
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.ServiceProcess;
using System.Text;
using System.Threading;

namespace SisgenAgente
{
    public static class Program
    {
        public const string Version = "1.7.0";
        public static readonly string Carpeta = AppDomain.CurrentDomain.BaseDirectory;

        public static int Main(string[] args)
        {
            Directory.SetCurrentDirectory(Carpeta);
            // Diagnóstico de folios (solo lectura, no requiere agente.ini): SisgenAgente.exe --folios C:\sisgen\datos
            int iFol = Array.FindIndex(args, a => a.Equals("--folios", StringComparison.OrdinalIgnoreCase));
            if (iFol >= 0)
            {
                try
                {
                    string datos = iFol + 1 < args.Length ? args[iFol + 1] : Config.Cargar(Path.Combine(Carpeta, "agente.ini")).CarpetaDatos;
                    Console.WriteLine("Folios de " + datos + " al " + DateTime.Now.ToString("dd-MM-yyyy HH:mm"));
                    Console.Write(Folios.Resumen(Folios.Calcular(datos, DateTime.Today)));
                    return 0;
                }
                catch (Exception e) { Console.WriteLine("Error: " + e.Message); return 1; }
            }
            // Folios al SII (solo certificación): SisgenAgente.exe --caf C:\sisgen2 39 10 [--pedir]
            // Sin --pedir solo muestra el rango que entregaría el SII. Con --pedir lo genera y deja el XML en caf\<carpeta>\.
            int iCaf = Array.FindIndex(args, a => a.Equals("--caf", StringComparison.OrdinalIgnoreCase));
            if (iCaf >= 0)
            {
                try
                {
                    if (iCaf + 3 >= args.Length) { Console.WriteLine("Uso: SisgenAgente.exe --caf <carpeta sisgen> <tipo SII> <cantidad> [--pedir]"); return 1; }
                    string sisgen = args[iCaf + 1].TrimEnd('\\');
                    int tipo = int.Parse(args[iCaf + 2]), cantidad = int.Parse(args[iCaf + 3]);
                    bool pedir = args.Any(a => a.Equals("--pedir", StringComparison.OrdinalIgnoreCase));
                    var caf = new CafSii(sisgen);
                    Console.WriteLine("Empresa " + caf.RutNumero + "-" + caf.RutDv + " en " + caf.Host);
                    var p = caf.Consultar(tipo, cantidad);
                    Console.WriteLine("Certificado: " + caf.EstadoCertificado);
                    Console.WriteLine("SII propone tipo " + p.Tipo + ": folios " + p.Desde + " al " + p.Hasta + " (disponible " + p.Disponible + ", máximo autorizado " + p.MaximoAutorizado + ")");
                    if (!pedir) { Console.WriteLine("Solo consulta: no se pidió nada. Agrega --pedir para generar."); return 0; }
                    string cola = Path.Combine(Carpeta, "caf", Path.GetFileName(sisgen));
                    string archivo = caf.Pedir(p, cola);
                    Console.WriteLine("CAF guardado: " + archivo);
                    return 0;
                }
                catch (Exception e) { Console.WriteLine("Error: " + e.Message); return 1; }
            }
            // Prueba del módulo de folios en la ventana: SisgenAgente.exe --folios-motor C:\sisgen C:\sisgen2 [--minutos-critico 2]
            int iMot = Array.FindIndex(args, a => a.Equals("--folios-motor", StringComparison.OrdinalIgnoreCase));
            if (iMot >= 0)
            {
                Log.Consola = true;
                int iMin = Array.FindIndex(args, a => a.Equals("--minutos-critico", StringComparison.OrdinalIgnoreCase));
                int min;
                if (iMin >= 0 && iMin + 1 < args.Length && int.TryParse(args[iMin + 1], out min)) MotorFolios.MinutosCritico = min;
                var motores = args.Skip(iMot + 1).TakeWhile(a => !a.StartsWith("--")).Select(c => new MotorFolios(c)).ToList();
                Log.Info("Módulo de folios en prueba para " + motores.Count + " carpeta(s); crítico sin respuesta = " + MotorFolios.MinutosCritico + " min. Ctrl+C para salir.");
                while (true)
                {
                    foreach (var m in motores)
                        try { m.Revisar(); } catch (Exception e) { Log.Error("Folios: " + e.Message); }
                    Thread.Sleep(10000);
                }
            }
            // Cargar un CAF en Sisgen: SisgenAgente.exe --cargar-caf C:\sisgen2 C:\ruta\T39D26H35.xml
            int iCar = Array.FindIndex(args, a => a.Equals("--cargar-caf", StringComparison.OrdinalIgnoreCase));
            if (iCar >= 0)
            {
                try
                {
                    if (iCar + 2 >= args.Length) { Console.WriteLine("Uso: SisgenAgente.exe --cargar-caf <carpeta sisgen> <archivo CAF .xml>"); return 1; }
                    Console.WriteLine(CargaCaf.Cargar(args[iCar + 1].TrimEnd('\\'), args[iCar + 2], Path.Combine(Carpeta, "respaldos")));
                    return 0;
                }
                catch (Exception e) { Console.WriteLine("Error: " + e.Message); return 1; }
            }
            bool consola = args.Any(a => a.Equals("--consola", StringComparison.OrdinalIgnoreCase));
            bool unaVez = args.Any(a => a.Equals("--una-vez", StringComparison.OrdinalIgnoreCase));
            if (!consola && !unaVez && !Environment.UserInteractive)
            {
                ServiceBase.Run(new Servicio());
                return 0;
            }
            Log.Consola = true;
            Config cfg;
            try { cfg = Config.Cargar(Path.Combine(Carpeta, "agente.ini")); }
            catch (Exception e) { Log.Error(e.Message); return 2; }
            if (cfg.SoloFolios)
            {
                // Sin llave del portal: solo el módulo de folios
                var cf = new CicloFolios(cfg);
                if (unaVez) { cf.Ciclo(); Log.Info("Ciclo de folios completo."); return 0; }
                if (!consola) { Console.WriteLine("Este programa es un servicio de Windows. Pruébalo con: SisgenAgente.exe --consola"); return 1; }
                var fin = new ManualResetEvent(false);
                Console.CancelKeyPress += (s, e) => { e.Cancel = true; fin.Set(); };
                cf.Iniciar();
                fin.WaitOne();
                cf.Detener();
                return 0;
            }
            var motor = new Motor(cfg);
            if (unaVez)
            {
                try { motor.Ciclo(); Log.Info("Ciclo completo."); return 0; }
                catch (Exception e) { Log.Error(e.Message); return 1; }
            }
            if (!consola)
            {
                Console.WriteLine("Este programa es un servicio de Windows. Instálalo con instalar.bat o pruébalo con: SisgenAgente.exe --consola");
                return 1;
            }
            var salir = new ManualResetEvent(false);
            Console.CancelKeyPress += (s, e) => { e.Cancel = true; salir.Set(); };
            motor.Iniciar();
            salir.WaitOne();
            motor.Detener();
            return 0;
        }
    }

    public class Servicio : ServiceBase
    {
        Motor motor;
        CicloFolios soloFolios;
        public Servicio() { ServiceName = "SisgenAgente"; CanStop = true; CanShutdown = true; }

        protected override void OnStart(string[] args)
        {
            var cfg = Config.Cargar(Path.Combine(Program.Carpeta, "agente.ini"));
            if (cfg.SoloFolios) { soloFolios = new CicloFolios(cfg); soloFolios.Iniciar(); return; }
            Actualizador.Habilitado = true;
            Actualizador.AlIniciar();
            motor = new Motor(cfg);
            motor.Iniciar();
        }

        protected override void OnStop() { if (motor != null) motor.Detener(); if (soloFolios != null) soloFolios.Detener(); }
        protected override void OnShutdown() { OnStop(); }
    }

    public class Config
    {
        public string Portal, Llave, Sisgen, CarpetaDatos, CarpetaDte, Desde, Certificado, ClaveCertificado;
        public int IntervaloSegundos = 30, DiasTraza = 3, HorasVentas = 3;
        public bool Folios; // módulo de folios (avisos, pedido y carga de CAF); apagado salvo folios=si
        public bool SoloFolios; // sin portal ni llave: el agente solo atiende folios
        public List<string> CarpetasFolios = new List<string>(); // foliosSisgen=C:\sisgen;C:\sisgen2 (por defecto, sisgen)

        public static Config Cargar(string ruta)
        {
            if (!File.Exists(ruta)) throw new Exception("Falta el archivo " + ruta + " (copia agente.ini.ejemplo y complétalo).");
            var v = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            foreach (var linea in File.ReadAllLines(ruta, Encoding.UTF8))
            {
                string l = linea.Trim();
                if (l.Length == 0 || l.StartsWith("#") || l.StartsWith(";") || l.StartsWith("[")) continue;
                int i = l.IndexOf('=');
                if (i > 0) v[l.Substring(0, i).Trim()] = l.Substring(i + 1).Trim();
            }
            Func<string, string> req = k =>
            {
                string x;
                if (!v.TryGetValue(k, out x) || x.Length == 0) throw new Exception("Falta '" + k + "' en agente.ini");
                return x;
            };
            string t;
            bool folios = v.TryGetValue("folios", out t) && t.Equals("si", StringComparison.OrdinalIgnoreCase);
            bool sinPortal = (!v.TryGetValue("portal", out t) || t.Length == 0) && (!v.TryGetValue("llave", out t) || t.Length == 0);
            var c = sinPortal && folios
                ? new Config { SoloFolios = true, Sisgen = req("sisgen").TrimEnd('\\') }
                : new Config { Portal = req("portal"), Llave = req("llave"), Sisgen = req("sisgen").TrimEnd('\\') };
            c.Folios = folios;
            c.CarpetasFolios = v.TryGetValue("foliosSisgen", out t) && t.Length > 0
                ? t.Split(';').Select(x => x.Trim().TrimEnd('\\')).Where(x => x.Length > 0).ToList()
                : new List<string> { c.Sisgen };
            c.CarpetaDatos = v.TryGetValue("datos", out t) && t.Length > 0 ? t : Path.Combine(c.Sisgen, "datos");
            c.CarpetaDte = Path.Combine(v.TryGetValue("procesos", out t) && t.Length > 0 ? t : Path.Combine(c.Sisgen, "procesos"), "DTE");
            int n;
            if (v.TryGetValue("intervalo", out t) && int.TryParse(t, out n) && n >= 5) c.IntervaloSegundos = n;
            if (v.TryGetValue("diasTraza", out t) && int.TryParse(t, out n) && n >= 1) c.DiasTraza = n;
            if (v.TryGetValue("horasVentas", out t) && int.TryParse(t, out n) && n >= 1) c.HorasVentas = n;
            // Folios reales: solo si se habilita a propósito (si no, los pedidos al SII quedan limitados a certificación)
            CafSii.SoloCertificacion = !(v.TryGetValue("foliosProduccion", out t) && t.Equals("si", StringComparison.OrdinalIgnoreCase));
            if (v.TryGetValue("avisoFolios", out t)) MotorFolios.LeerAvisos(t);
            if (v.TryGetValue("folioAviso", out t) && int.TryParse(t, out n) && n >= 1 && n <= 90) MotorFolios.PorcentajeAviso = n;
            if (v.TryGetValue("folioCritico", out t) && int.TryParse(t, out n) && n >= 1 && n <= 50) MotorFolios.PorcentajeCritico = n;
            if (v.TryGetValue("minutosCritico", out t) && int.TryParse(t, out n) && n >= 1) MotorFolios.MinutosCritico = n;
            // Opcional: certificado indicado a mano (si no, se busca solo en procesos\certificado)
            if (v.TryGetValue("certificado", out t) && t.Length > 0) c.Certificado = t;
            if (v.TryGetValue("claveCertificado", out t)) c.ClaveCertificado = t;
            // "desde": no se envía nada anterior a esta fecha (por defecto, el día en que se instaló el agente)
            DateTime d;
            if (v.TryGetValue("desde", out t) && DateTime.TryParseExact(t, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out d))
                c.Desde = t;
            else
            {
                string marca = Path.Combine(Program.Carpeta, "estado", "instalado.txt");
                Directory.CreateDirectory(Path.GetDirectoryName(marca));
                if (!File.Exists(marca)) File.WriteAllText(marca, DateTime.Today.ToString("yyyy-MM-dd"));
                c.Desde = File.ReadAllText(marca).Trim();
            }
            if (c.SoloFolios) return c;
            if (!c.Portal.StartsWith("http://") && !c.Portal.StartsWith("https://")) throw new Exception("'portal' debe empezar con http:// o https://");
            if (!c.Llave.StartsWith("sga_")) throw new Exception("La 'llave' no tiene el formato correcto (debe empezar con sga_).");
            return c;
        }
    }

    public static class Log
    {
        public static bool Consola;
        static readonly object candado = new object();

        public static void Info(string m) { Escribir("INFO ", m); }
        public static void Error(string m) { Escribir("ERROR", m); }

        static void Escribir(string nivel, string m)
        {
            string linea = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " " + nivel + " " + m;
            lock (candado)
            {
                if (Consola) Console.WriteLine(linea);
                try
                {
                    string carpeta = Path.Combine(Program.Carpeta, "logs");
                    Directory.CreateDirectory(carpeta);
                    File.AppendAllText(Path.Combine(carpeta, "agente-" + DateTime.Today.ToString("yyyyMMdd") + ".log"), linea + Environment.NewLine, Encoding.UTF8);
                    // Se guardan 30 días de registros
                    foreach (var f in new DirectoryInfo(carpeta).GetFiles("agente-*.log"))
                        if (f.LastWriteTime < DateTime.Now.AddDays(-30)) f.Delete();
                }
                catch { }
            }
        }
    }
}
