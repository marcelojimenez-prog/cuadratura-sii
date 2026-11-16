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
        public const string Version = "1.6.10";
        public static readonly string Carpeta = AppDomain.CurrentDomain.BaseDirectory;

        public static int Main(string[] args)
        {
            Directory.SetCurrentDirectory(Carpeta);
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
        public Servicio() { ServiceName = "SisgenAgente"; CanStop = true; CanShutdown = true; }

        protected override void OnStart(string[] args)
        {
            Actualizador.Habilitado = true;
            Actualizador.AlIniciar();
            var cfg = Config.Cargar(Path.Combine(Program.Carpeta, "agente.ini"));
            motor = new Motor(cfg);
            motor.Iniciar();
        }

        protected override void OnStop() { if (motor != null) motor.Detener(); }
        protected override void OnShutdown() { OnStop(); }
    }

    public class Config
    {
        public string Portal, Llave, Sisgen, CarpetaDatos, CarpetaDte, Desde, Certificado, ClaveCertificado;
        public int IntervaloSegundos = 30, DiasTraza = 3, HorasVentas = 3;

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
            var c = new Config { Portal = req("portal"), Llave = req("llave"), Sisgen = req("sisgen").TrimEnd('\\') };
            string t;
            c.CarpetaDatos = v.TryGetValue("datos", out t) && t.Length > 0 ? t : Path.Combine(c.Sisgen, "datos");
            c.CarpetaDte = Path.Combine(v.TryGetValue("procesos", out t) && t.Length > 0 ? t : Path.Combine(c.Sisgen, "procesos"), "DTE");
            int n;
            if (v.TryGetValue("intervalo", out t) && int.TryParse(t, out n) && n >= 5) c.IntervaloSegundos = n;
            if (v.TryGetValue("diasTraza", out t) && int.TryParse(t, out n) && n >= 1) c.DiasTraza = n;
            if (v.TryGetValue("horasVentas", out t) && int.TryParse(t, out n) && n >= 1) c.HorasVentas = n;
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
