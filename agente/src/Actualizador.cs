// Actualización en línea del agente: el portal ofrece una versión nueva en la respuesta de /hola;
// el agente la descarga, comprueba la firma de Sisgen (llave pública incluida en el programa),
// se reemplaza y reinicia el servicio. Si la versión nueva no logra conectarse al portal, vuelve sola a la anterior.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Threading;

namespace SisgenAgente
{
    public static class Actualizador
    {
        const string NombreServicio = "SisgenAgente";
        const int MinutosParaConfirmar = 15;

        static string Exe { get { return Path.Combine(Program.Carpeta, "SisgenAgente.exe"); } }
        static string Anterior { get { return Path.Combine(Program.Carpeta, "SisgenAgente.anterior.exe"); } }
        static string Fallida { get { return Path.Combine(Program.Carpeta, "SisgenAgente.fallida.exe"); } }
        static string Marca { get { return Path.Combine(Program.Carpeta, "estado", "actualizacion-pendiente.txt"); } }
        static string MarcaFallida { get { return Path.Combine(Program.Carpeta, "estado", "actualizacion-fallida.txt"); } }

        /// <summary>Solo el servicio instalado se actualiza (no las pruebas en consola).</summary>
        public static bool Habilitado;
        static bool enCurso;
        static Timer vigilante;

        // ---------- Al iniciar el servicio: ¿venimos de una actualización? ----------
        public static void AlIniciar()
        {
            if (!File.Exists(Marca)) return;
            try
            {
                var partes = File.ReadAllText(Marca).Split('|');
                int intentos = partes.Length > 1 ? int.Parse(partes[1]) + 1 : 1;
                File.WriteAllText(Marca, partes[0] + "|" + intentos);
                // Se cae al arrancar una y otra vez: se vuelve a la versión anterior
                if (intentos > 3) { VolverAtras("la versión " + Program.Version + " no logra arrancar"); return; }
                vigilante = new Timer(_ =>
                {
                    if (File.Exists(Marca)) VolverAtras("la versión " + Program.Version + " no se conectó al portal en " + MinutosParaConfirmar + " minutos");
                }, null, TimeSpan.FromMinutes(MinutosParaConfirmar), TimeSpan.FromMilliseconds(-1));
            }
            catch (Exception e) { Log.Error("Actualización: " + e.Message); }
        }

        /// <summary>La versión nueva habló con el portal: queda confirmada.</summary>
        public static void Confirmar()
        {
            if (!File.Exists(Marca)) return;
            try
            {
                File.Delete(Marca);
                if (vigilante != null) vigilante.Dispose();
                Log.Info("Actualización confirmada: el agente quedó en la versión " + Program.Version + ".");
            }
            catch { }
        }

        static void VolverAtras(string motivo)
        {
            try
            {
                if (!File.Exists(Anterior)) { Log.Error("Actualización con problemas (" + motivo + ") y no hay versión anterior guardada."); File.Delete(Marca); return; }
                Log.Error("Actualización con problemas: " + motivo + ". Se vuelve a la versión anterior.");
                if (File.Exists(Fallida)) File.Delete(Fallida);
                File.Move(Exe, Fallida);          // un exe en uso se puede renombrar, no sobrescribir
                File.Move(Anterior, Exe);
                File.WriteAllText(MarcaFallida, Program.Version);
                File.Delete(Marca);
                Reiniciar();
            }
            catch (Exception e) { Log.Error("No se pudo volver a la versión anterior: " + e.Message); }
        }

        // ---------- Revisar si el portal ofrece una versión nueva ----------
        public static void Revisar(Portal portal, Dictionary<string, object> respuesta)
        {
            if (!Habilitado || enCurso || respuesta == null) return;
            object o;
            if (!respuesta.TryGetValue("actualizacion", out o)) return;
            var a = o as Dictionary<string, object>;
            if (a == null) return;
            string version = a.ContainsKey("version") ? a["version"] as string : null;
            string sha = a.ContainsKey("sha256") ? a["sha256"] as string : null;
            string firma = a.ContainsKey("firma") ? a["firma"] as string : null;
            if (version == null || sha == null || firma == null || Comparar(version, Program.Version) <= 0) return;
            try
            {
                if (File.Exists(MarcaFallida) && File.ReadAllText(MarcaFallida).Trim() == version) return; // ya falló antes
            }
            catch { }
            enCurso = true;
            try { Instalar(portal, version, sha.ToLowerInvariant(), firma); }
            catch (Exception e) { Log.Error("No se pudo actualizar a la versión " + version + ": " + e.Message); enCurso = false; }
        }

        static void Instalar(Portal portal, string version, string sha, string firma)
        {
            Log.Info("El portal ofrece la versión " + version + " (esta es la " + Program.Version + "). Descargando…");
            // 1) La firma de Sisgen sobre versión + huella: sin ella no se instala nada
            if (!FirmaValida(version, sha, firma)) throw new Exception("la firma de la actualización no es válida; no se instala");
            // 2) El archivo descargado debe tener exactamente esa huella
            byte[] exe = portal.Descargar("/actualizacion", Json.Objeto(new Dictionary<string, object> { { "version", version } }));
            string huella;
            using (var h = SHA256.Create()) huella = BitConverter.ToString(h.ComputeHash(exe)).Replace("-", "").ToLowerInvariant();
            if (huella != sha) throw new Exception("el archivo descargado no coincide con la firma; no se instala");
            // 3) Reemplazo: el exe en uso se renombra (Windows lo permite) y el nuevo toma su lugar
            string nuevo = Path.Combine(Program.Carpeta, "SisgenAgente.nuevo.exe");
            File.WriteAllBytes(nuevo, exe);
            if (File.Exists(Anterior)) File.Delete(Anterior);
            File.Move(Exe, Anterior);
            try { File.Move(nuevo, Exe); }
            catch { File.Move(Anterior, Exe); throw; }
            Directory.CreateDirectory(Path.GetDirectoryName(Marca));
            File.WriteAllText(Marca, version + "|0");
            Log.Info("Versión " + version + " instalada. Reiniciando el servicio…");
            Reiniciar();
        }

        static bool FirmaValida(string version, string sha, string firma)
        {
            try
            {
                var cp = new CspParameters(24) { Flags = CspProviderFlags.UseMachineKeyStore }; // proveedor con SHA-256
                using (var rsa = new RSACryptoServiceProvider(cp))
                {
                    rsa.PersistKeyInCsp = false;
                    rsa.FromXmlString(LlavePublica.Xml);
                    byte[] datos = Encoding.UTF8.GetBytes("SisgenAgente|" + version + "|" + sha.ToLowerInvariant());
                    return rsa.VerifyData(datos, "SHA256", Convert.FromBase64String(firma));
                }
            }
            catch (Exception e) { Log.Error("Verificando firma: " + e.Message); return false; }
        }

        /// <summary>Detiene e inicia el servicio desde un proceso aparte (el servicio no puede reiniciarse a sí mismo).</summary>
        public static void Reiniciar()
        {
            Process.Start(new ProcessStartInfo("cmd.exe",
                "/c ping -n 4 127.0.0.1 >nul & net stop " + NombreServicio + " & net start " + NombreServicio)
            { CreateNoWindow = true, UseShellExecute = false, WorkingDirectory = Path.GetTempPath() });
        }

        /// <summary>Compara versiones tipo 1.6.0.</summary>
        public static int Comparar(string a, string b)
        {
            Func<string, int[]> partes = v => (v ?? "").Split('.').Select(x => { int n; return int.TryParse(x, out n) ? n : 0; }).ToArray();
            int[] x1 = partes(a), x2 = partes(b);
            for (int i = 0; i < Math.Max(x1.Length, x2.Length); i++)
            {
                int p = i < x1.Length ? x1[i] : 0, q = i < x2.Length ? x2[i] : 0;
                if (p != q) return p.CompareTo(q);
            }
            return 0;
        }
    }
}
