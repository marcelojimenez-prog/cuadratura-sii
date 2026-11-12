// Lectura de las ventas de un mes desde las tablas de Sisgen (solo los campos que usa la cuadratura)
// y de los datos de la empresa. Nunca lee claves (DTECLAVE) ni llaves privadas de los CAF.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;

namespace SisgenAgente
{
    public static class Ventas
    {
        static readonly string[] CamposF1 = { "FATDOCTO", "FANUMERO", "FAFECHA", "FARUTCLI", "FANOMCLI", "FAAFECTO", "FAEXENTO", "FAIVA", "FATOTAL", "CODSUC", "ELECTRON" };
        static readonly string[] CamposClidocto = { "TDOCTO", "NUMFAC", "FECFAC", "RUTCLI", "NOMCLI", "MONTO" };
        static readonly string[] CamposClipagos = { "TDOCTO", "NUMFAC", "FECPAG", "RUTCLI", "VALDOC" };

        /// <summary>RUT, razón social y nombre de la sucursal (empres.dbf). Solo esos campos.</summary>
        public static Dictionary<string, object> Empresa(Config cfg)
        {
            string ruta = Buscar(cfg.CarpetaDatos, "empres.dbf");
            if (ruta == null) return null;
            using (var t = new TablaDbf(ruta))
            {
                for (int i = 0; i < t.Registros; i++)
                {
                    var r = t.Leer(i);
                    if (r == null) continue;
                    string rut = r.Texto("DTERUT");
                    if (rut.Length == 0) rut = r.Texto("EMPRUT");
                    string razon = r.Texto("DTERAZ");
                    if (razon.Length == 0) razon = r.Texto("EMPNOM");
                    // Datos públicos que van impresos en los documentos (oficina SII y resolución)
                    return new Dictionary<string, object> {
                        { "rut", rut }, { "razonSocial", razon }, { "nombreSistema", r.Texto("EMPNOM") },
                        { "codigoSucursalSii", r.Texto("DTECODSUC") }, { "oficinaSii", r.Texto("DTEOFISII") },
                        { "resolucionNumero", r.Texto("DTENUMRES") }, { "resolucionFecha", r.Fecha("DTEFECRES") ?? r.Texto("DTEFECRES") },
                    };
                }
            }
            return null;
        }

        /// <summary>Meses (yyyy-MM) que tienen tabla de ventas F1MMAAAA en la carpeta de datos, del más nuevo al más antiguo.</summary>
        public static List<string> MesesConVentas(Config cfg)
        {
            var meses = new List<string>();
            if (!Directory.Exists(cfg.CarpetaDatos)) return meses;
            foreach (var f in Directory.GetFiles(cfg.CarpetaDatos, "F1??????.dbf"))
            {
                var m = Regex.Match(Path.GetFileNameWithoutExtension(f), @"^F1(\d{2})(\d{4})$", RegexOptions.IgnoreCase);
                if (!m.Success) continue;
                int mm = int.Parse(m.Groups[1].Value), aa = int.Parse(m.Groups[2].Value);
                if (mm < 1 || mm > 12 || aa < 2001) continue;
                meses.Add(aa.ToString("0000") + "-" + mm.ToString("00"));
            }
            return meses.Distinct().OrderByDescending(x => x, StringComparer.Ordinal).ToList();
        }

        /// <summary>
        /// Paquete con todo lo emitido en el mes. null si no existe la tabla F1 del mes.
        /// completo = false (meses antiguos): sin CLIDOCTO/CLIPAGOS, que obligan a recorrer tablas de todos los años.
        /// </summary>
        public static Dictionary<string, object> PaqueteMes(Config cfg, DateTime mes, bool completo = true)
        {
            string periodo = mes.ToString("yyyy-MM");
            string f1 = Buscar(cfg.CarpetaDatos, "F1" + mes.ToString("MMyyyy") + ".dbf");
            if (f1 == null) return null;
            var p = new Dictionary<string, object> { { "periodo", periodo } };
            p["f1"] = LeerTodo(f1, CamposF1);

            string f2 = Buscar(cfg.CarpetaDatos, "F2" + mes.ToString("MMyyyy") + ".dbf");
            if (f2 != null)
            {
                var claves = new HashSet<string>();
                using (var t = new TablaDbf(f2))
                    for (int i = 0; i < t.Registros; i++)
                    {
                        var r = t.Leer(i);
                        if (r == null) continue;
                        string tipo = r.Texto("DETDOCTO"), folio = r.Texto("DENUMFAC");
                        if (tipo.Length > 0 && folio.Length > 0) claves.Add(tipo.ToUpperInvariant() + "-" + folio);
                    }
                p["detalle"] = claves.ToList();
            }
            // CLIDOCTO / CLIPAGOS guardan todos los años: se leen desde el final hasta 3 meses antes del periodo
            string limite = mes.AddMonths(-3).ToString("yyyy-MM-01");
            if (completo)
            {
                string cd = Buscar(cfg.CarpetaDatos, "clidocto.dbf");
                if (cd != null) p["clidocto"] = LeerRecientes(cd, CamposClidocto, "FECFAC", periodo, limite);
                string cp = Buscar(cfg.CarpetaDatos, "clipagos.dbf");
                if (cp != null) p["clipagos"] = LeerRecientes(cp, CamposClipagos, "FECPAG", periodo, limite);
            }

            // Índice de XML (solo nombres de archivo) del mes y de los meses vecinos
            string xmlMes = Path.Combine(cfg.CarpetaDte, mes.ToString("yyMM"));
            if (Directory.Exists(xmlMes)) p["xml"] = NombresXml(xmlMes);
            var vecinos = new List<string>();
            foreach (var m in new[] { mes.AddMonths(-1), mes.AddMonths(1) })
            {
                string dir = Path.Combine(cfg.CarpetaDte, m.ToString("yyMM"));
                if (Directory.Exists(dir)) vecinos.AddRange(NombresXml(dir));
            }
            p["xmlVecinos"] = vecinos;

            var cafs = RangosCaf(Path.Combine(Path.GetDirectoryName(cfg.CarpetaDte), "Folios"));
            if (cafs != null) p["cafs"] = cafs;
            return p;
        }

        static List<object> LeerTodo(string ruta, string[] campos)
        {
            var filas = new List<object>();
            using (var t = new TablaDbf(ruta))
                for (int i = 0; i < t.Registros; i++)
                {
                    var r = t.Leer(i);
                    if (r != null) filas.Add(Fila(r, campos));
                }
            return filas;
        }

        static List<object> LeerRecientes(string ruta, string[] campos, string campoFecha, string periodo, string limite)
        {
            var filas = new List<object>();
            using (var t = new TablaDbf(ruta))
            {
                int antiguos = 0;
                for (int i = t.Registros - 1; i >= 0 && antiguos < 5000; i--)
                {
                    var r = t.Leer(i);
                    if (r == null) continue;
                    string f = r.Fecha(campoFecha);
                    if (f != null && string.CompareOrdinal(f, limite) < 0) { antiguos++; continue; }
                    antiguos = 0;
                    if (f != null && f.StartsWith(periodo)) filas.Add(Fila(r, campos));
                }
            }
            return filas;
        }

        static Dictionary<string, object> Fila(RegistroDbf r, string[] campos)
        {
            var d = new Dictionary<string, object>();
            foreach (var c in campos) d[c] = r.Valor(c);
            return d;
        }

        static List<string> NombresXml(string dir)
        {
            return Directory.GetFiles(dir, "*.xml").Select(Path.GetFileName).ToList();
        }

        static readonly Regex NombreCaf = new Regex(@"^t(\d+)d(\d+)h(\d+)\.xml$", RegexOptions.IgnoreCase);
        static readonly Regex Td = new Regex(@"<TD>\s*(\d+)\s*</TD>", RegexOptions.IgnoreCase);
        static readonly Regex Rng = new Regex(@"<RNG>\s*<D>\s*(\d+)\s*</D>\s*<H>\s*(\d+)\s*</H>\s*</RNG>", RegexOptions.IgnoreCase);

        static readonly Regex Fa = new Regex(@"<FA>\s*(\d{4}-\d{2}-\d{2})\s*</FA>", RegexOptions.IgnoreCase);

        /// <summary>
        /// Tipo, rango y fecha de autorización (FA) de cada CAF de procesos\Folios. Solo eso: la llave
        /// privada que trae el archivo nunca se envía.
        /// </summary>
        static List<object> RangosCaf(string dir)
        {
            if (!Directory.Exists(dir)) return null;
            var lista = new List<object>();
            foreach (var ruta in Directory.GetFiles(dir, "*.xml"))
            {
                string nombre = Path.GetFileName(ruta);
                string xml = null;
                try { xml = File.ReadAllText(ruta, Encoding.GetEncoding(1252)); } catch { }
                var m = NombreCaf.Match(nombre);
                string tipo, desde, hasta;
                if (m.Success) { tipo = m.Groups[1].Value; desde = m.Groups[2].Value; hasta = m.Groups[3].Value; }
                else
                {
                    if (xml == null) continue;
                    var td = Td.Match(xml); var rng = Rng.Match(xml);
                    if (!td.Success || !rng.Success) continue;
                    tipo = td.Groups[1].Value; desde = rng.Groups[1].Value; hasta = rng.Groups[2].Value;
                }
                var fa = xml == null ? null : Fa.Match(xml);
                lista.Add(new Dictionary<string, object> {
                    { "tipo", long.Parse(tipo) }, { "desde", long.Parse(desde) }, { "hasta", long.Parse(hasta) }, { "archivo", nombre },
                    { "fa", fa != null && fa.Success ? fa.Groups[1].Value : null } });
            }
            return lista;
        }

        public static string Buscar(string carpeta, string nombre)
        {
            if (!Directory.Exists(carpeta)) return null;
            return Directory.GetFiles(carpeta, nombre).FirstOrDefault();
        }
    }
}
