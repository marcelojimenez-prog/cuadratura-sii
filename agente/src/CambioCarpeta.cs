// Cambio remoto de la carpeta de Sisgen que lee el agente (p. ej. si al instalar quedó elegido un respaldo).
// El portal lo pide en /hola: {"cambiarCarpeta": {"id": "...", "sisgen": "C:\\SisGen"}}.
// Antes de cambiar se verifica que la carpeta nueva sea una instalación de Sisgen (procesos + datos*\empres.dbf)
// y que sus datos sean del MISMO RUT que lee hoy el agente. Solo se modifica el agente.ini del propio agente
// (se deja una copia agente.ini.anterior); nada de Sisgen se toca. Luego el servicio se reinicia.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;

namespace SisgenAgente
{
    public static class CambioCarpeta
    {
        static string ultimoPedido;

        public static void Revisar(Config cfg, Portal portal, Dictionary<string, object> respuesta)
        {
            object o;
            if (respuesta == null || !respuesta.TryGetValue("cambiarCarpeta", out o)) return;
            var p = o as Dictionary<string, object>;
            if (p == null || !p.ContainsKey("id") || !(p.ContainsKey("sisgen") && p["sisgen"] is string)) return;
            string id = Convert.ToString(p["id"]);
            if (id == ultimoPedido) return;
            ultimoPedido = id;

            bool ok = false;
            string resultado;
            try
            {
                string sisgen = ((string)p["sisgen"]).Trim().TrimEnd('\\');
                if (!Directory.Exists(Path.Combine(sisgen, "procesos"))) throw new Exception("no existe " + sisgen + "\\procesos");
                var actual = Ventas.Empresa(cfg);
                string rut = actual == null ? null : actual["rut"] as string;
                if (string.IsNullOrEmpty(rut)) throw new Exception("no se pudo leer el RUT de la carpeta actual");
                string preferida = p.ContainsKey("datos") && p["datos"] is string ? (string)p["datos"] : Path.GetFileName(cfg.CarpetaDatos.TrimEnd('\\'));
                var candidatos = Directory.GetDirectories(sisgen)
                    .Where(d => Path.GetFileName(d).StartsWith("datos", StringComparison.OrdinalIgnoreCase) && File.Exists(Path.Combine(d, "empres.dbf")))
                    .OrderBy(d => Path.GetFileName(d).Equals(preferida, StringComparison.OrdinalIgnoreCase) ? 0 : 1)
                    .ThenBy(d => Path.GetFileName(d).Length).ToList();
                string elegida = null;
                foreach (var d in candidatos)
                {
                    Dictionary<string, object> e = null;
                    try { e = Ventas.Empresa(new Config { CarpetaDatos = d }); } catch { }
                    if (e != null && Rut(e["rut"] as string) == Rut(rut)) { elegida = d; break; }
                }
                if (elegida == null) throw new Exception("en " + sisgen + " no hay una carpeta de datos del RUT " + rut);
                if (elegida.TrimEnd('\\').Equals(cfg.CarpetaDatos.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase))
                    throw new Exception("el agente ya lee " + elegida);

                string ini = Path.Combine(Program.Carpeta, "agente.ini");
                var lineas = File.ReadAllLines(ini, Encoding.UTF8).ToList();
                File.Copy(ini, ini + ".anterior", true);
                Fijar(lineas, "sisgen", sisgen);
                Fijar(lineas, "datos", elegida);
                lineas.RemoveAll(l => Clave(l) == "procesos");
                File.WriteAllLines(ini, lineas, new UTF8Encoding(false));
                // Para que vuelva a enviar todo el historial de ventas desde la carpeta correcta
                string meses = Path.Combine(Program.Carpeta, "estado", "meses-enviados.txt");
                if (File.Exists(meses)) File.Move(meses, meses + "." + DateTime.Now.ToString("yyyyMMddHHmmss") + ".anterior");
                ok = true;
                resultado = "carpeta cambiada a " + sisgen + " (datos: " + elegida + ")";
            }
            catch (Exception e) { resultado = "no se cambió: " + e.Message; }

            Log.Info("Cambio de carpeta de Sisgen: " + resultado);
            try
            {
                portal.Enviar("/diagnostico", Json.Objeto(new Dictionary<string, object> {
                    { "tipo", "carpeta" }, { "pedido", id }, { "ok", ok }, { "resultado", resultado } }), true);
            }
            catch { }
            if (ok) Actualizador.Reiniciar();
        }

        static string Clave(string linea)
        {
            int i = linea.IndexOf('=');
            return i > 0 ? linea.Substring(0, i).Trim().ToLowerInvariant() : null;
        }

        static void Fijar(List<string> lineas, string clave, string valor)
        {
            int i = lineas.FindIndex(l => Clave(l) == clave);
            if (i >= 0) lineas[i] = clave + "=" + valor; else lineas.Add(clave + "=" + valor);
        }

        static string Rut(string r)
        {
            return (r ?? "").Replace(".", "").Replace("-", "").Trim().TrimStart('0').ToUpperInvariant();
        }
    }
}
