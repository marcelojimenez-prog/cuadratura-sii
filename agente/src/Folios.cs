// Módulo de folios (etapa 1: solo lectura).
// Calcula, por tipo de documento, cuántos folios quedan en el CAF activo de Sisgen, si hay un CAF en espera,
// cuánto se consume al día y cuándo vence, y detecta un correlativo fuera de los CAF cargados (folio de otra
// sucursal). No escribe nada en Sisgen.
//
// Dónde guarda Sisgen cada cosa (leído de sisgen.exe):
//   prmsis.dbf   DTEFOLIOxx = último folio del CAF activo (tope); FOLIODESxx/FOLIOHASxx = CAF en espera (una ranura);
//                DTEFECHAxx = vencimiento del CAF activo (facturas y notas)
//   correlat.dbf BOLVENCEL, FACVENCEL… = próximo folio a usar
//   folios.dbf   un registro por CAF cargado (TIPODOCU, FOLDESDE, FOLHASTA, FECHAUTO dd/mm/aaaa)
//
//   SisgenAgente.exe --folios C:\sisgen\datos      -> muestra el estado en la ventana (no requiere agente.ini)
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;

namespace SisgenAgente
{
    public class TipoFolio
    {
        public string Sisgen;      // código Sisgen (FATDOCTO / sufijo de DTEFOLIOxx): BE, FE, NE…
        public string Sii;         // código SII (TIPODOCU de folios.dbf): 39, 33, 61…
        public string Nombre;
        public string Espera;      // sufijo de FOLIODESxx / FOLIOHASxx
        public string Correlativo; // campo de correlat.dbf
        public bool Vence;         // el CAF vence (facturas y notas)

        public static readonly TipoFolio[] Todos = {
            new TipoFolio { Sisgen = "BE", Sii = "39", Nombre = "Boleta",            Espera = "BO", Correlativo = "BOLVENCEL" },
            new TipoFolio { Sisgen = "BX", Sii = "41", Nombre = "Boleta exenta",     Espera = "BX", Correlativo = "BOXVENCEL" },
            new TipoFolio { Sisgen = "FE", Sii = "33", Nombre = "Factura",           Espera = "FA", Correlativo = "FACVENCEL", Vence = true },
            new TipoFolio { Sisgen = "EE", Sii = "34", Nombre = "Factura exenta",    Espera = "EE", Correlativo = "EXEVENCEL", Vence = true },
            new TipoFolio { Sisgen = "NE", Sii = "61", Nombre = "Nota de crédito",   Espera = "NE", Correlativo = "CREVENCEL", Vence = true },
            new TipoFolio { Sisgen = "DE", Sii = "56", Nombre = "Nota de débito",    Espera = "DE", Correlativo = "DEBVENCEL", Vence = true },
            new TipoFolio { Sisgen = "GE", Sii = "52", Nombre = "Guía de despacho",  Espera = "GE", Correlativo = "GUIVENCEL" },
        };
    }

    public class RangoCaf
    {
        public string Tipo;
        public long Desde, Hasta;
        public DateTime? Autorizado;
    }

    public class EstadoFolio
    {
        public TipoFolio Tipo;
        public long Tope, Proximo;            // tope del CAF activo y próximo folio a usar
        public long Quedan;                   // folios del CAF activo que quedan (sin contar la espera)
        public RangoCaf Activo;               // CAF de folios.dbf que contiene al tope (null si no se encuentra)
        public long EsperaDesde, EsperaHasta; // CAF en espera (0 si no hay)
        public DateTime? Vence;               // vencimiento del CAF activo según Sisgen
        public double ConsumoDiario;          // documentos por día (últimos 30 días)
        public long CargadosSinAsignar;       // folios de CAF cargados después del tope que no están en la espera
        public long UltimoEmitido;            // mayor folio de este tipo en F1 (mes actual y anterior)
        public long UltimoRango;              // cantidad de folios del último CAF cargado de este tipo
        public List<RangoCaf> Cargados = new List<RangoCaf>(); // CAF de este tipo que ya están en folios.dbf
        public List<string> Alertas = new List<string>();

        public long QuedanConEspera { get { return Quedan + (EsperaHasta >= EsperaDesde && EsperaDesde > 0 ? EsperaHasta - EsperaDesde + 1 : 0); } }
        public double? Dias { get { return ConsumoDiario > 0 ? (double?)(QuedanConEspera / ConsumoDiario) : null; } }
    }

    public static class Folios
    {
        const int DiasConsumo = 30;

        /// <summary>Estado de folios de una carpeta de datos de Sisgen. Solo lee.</summary>
        public static List<EstadoFolio> Calcular(string carpetaDatos, DateTime hoy)
        {
            var prm = PrimerRegistro(Ruta(carpetaDatos, "prmsis.dbf"));
            if (prm == null) throw new Exception("No se pudo leer prmsis.dbf en " + carpetaDatos);
            var correlativos = Correlativos(Ruta(carpetaDatos, "correlat.dbf"));
            var cafs = Cafs(Ruta(carpetaDatos, "folios.dbf"));
            Dictionary<string, long> ultimos;
            var consumo = Consumo(carpetaDatos, hoy, out ultimos);

            var lista = new List<EstadoFolio>();
            foreach (var t in TipoFolio.Todos)
            {
                long tope = Entero(prm.Texto("DTEFOLIO" + t.Sisgen));
                long proximo;
                correlativos.TryGetValue(t.Correlativo, out proximo);
                var deTipo = cafs.Where(c => c.Tipo == t.Sii).OrderBy(c => c.Desde).ToList();
                if (tope <= 0 && deTipo.Count == 0) continue; // tipo no usado por esta empresa

                var e = new EstadoFolio { Tipo = t, Tope = tope, Proximo = proximo, Cargados = deTipo };
                e.EsperaDesde = Entero(prm.Texto("FOLIODES" + t.Espera));
                e.EsperaHasta = Entero(prm.Texto("FOLIOHAS" + t.Espera));
                e.Activo = deTipo.FirstOrDefault(c => c.Hasta == tope);
                if (deTipo.Count > 0) e.UltimoRango = deTipo[deTipo.Count - 1].Hasta - deTipo[deTipo.Count - 1].Desde + 1;
                e.Quedan = Math.Max(0, tope - proximo + 1);
                if (t.Vence) e.Vence = FechaDbf(prm.Texto("DTEFECHA" + t.Sisgen));
                double n;
                if (consumo.TryGetValue(t.Sisgen, out n)) e.ConsumoDiario = n / DiasConsumo;
                e.CargadosSinAsignar = deTipo.Where(c => c.Desde > tope && c.Desde != e.EsperaDesde).Sum(c => c.Hasta - c.Desde + 1);
                long ult;
                if (ultimos.TryGetValue(t.Sisgen, out ult)) e.UltimoEmitido = ult;

                // Alertas
                if (proximo > 0 && e.UltimoEmitido >= proximo && e.UltimoEmitido <= tope)
                    e.Alertas.Add("el próximo folio (" + proximo + ") ya fue emitido: la última venta en F1 es la " + e.UltimoEmitido + " (correlativo atrasado, se repetirían folios)");
                if (proximo > 0 && deTipo.Count > 0 && proximo <= tope && !deTipo.Any(c => proximo >= c.Desde && proximo <= c.Hasta))
                    e.Alertas.Add("el próximo folio (" + proximo + ") no está en ningún CAF cargado: sería un folio de otra sucursal");
                else if (e.Activo != null && proximo > 0 && proximo < e.Activo.Desde)
                    e.Alertas.Add("el próximo folio (" + proximo + ") está antes del CAF activo (" + e.Activo.Desde + "-" + e.Activo.Hasta + "): usaría folios de otra sucursal");
                if (tope > 0 && e.Activo == null)
                    e.Alertas.Add("el tope " + tope + " no corresponde al final de ningún CAF cargado");
                if (e.EsperaDesde > 0 && !deTipo.Any(c => c.Desde == e.EsperaDesde && c.Hasta == e.EsperaHasta))
                    e.Alertas.Add("el CAF en espera (" + e.EsperaDesde + "-" + e.EsperaHasta + ") no está en folios.dbf");
                if (e.Quedan == 0 && e.EsperaDesde == 0)
                    e.Alertas.Add("sin folios y sin CAF en espera");
                if (e.Vence.HasValue && e.Vence.Value < hoy)
                    e.Alertas.Add("el CAF activo venció el " + e.Vence.Value.ToString("dd-MM-yyyy"));
                else if (e.Vence.HasValue && e.ConsumoDiario > 0 && e.Quedan / e.ConsumoDiario > (e.Vence.Value - hoy).TotalDays)
                    e.Alertas.Add("al ritmo actual quedarán folios sin usar al vencer (" + e.Vence.Value.ToString("dd-MM-yyyy") + ")");
                lista.Add(e);
            }
            return lista;
        }

        /// <summary>Texto para la ventana o el registro.</summary>
        public static string Resumen(List<EstadoFolio> estados)
        {
            var sb = new StringBuilder();
            sb.AppendLine(string.Format("{0,-17} {1,9} {2,9} {3,8} {4,-17} {5,8} {6,6} {7,-10}",
                "Documento", "Próximo", "Tope", "Quedan", "En espera", "Por día", "Días", "Vence"));
            foreach (var e in estados)
            {
                string espera = e.EsperaDesde > 0 ? e.EsperaDesde + "-" + e.EsperaHasta : "-";
                string dias = e.Dias.HasValue ? (e.Dias.Value > 9999 ? ">9999" : e.Dias.Value.ToString("0")) : "-";
                sb.AppendLine(string.Format("{0,-17} {1,9} {2,9} {3,8} {4,-17} {5,8} {6,6} {7,-10}",
                    e.Tipo.Nombre, e.Proximo, e.Tope, e.Quedan, espera, e.ConsumoDiario.ToString("0.0", CultureInfo.InvariantCulture),
                    dias, e.Vence.HasValue ? e.Vence.Value.ToString("dd-MM-yyyy") : "-"));
                if (e.CargadosSinAsignar > 0) sb.AppendLine("    · " + e.CargadosSinAsignar + " folios cargados después del tope que Sisgen no tiene en espera");
                foreach (var a in e.Alertas) sb.AppendLine("    ! " + a);
            }
            return sb.ToString();
        }

        // ---------- lectura ----------

        static string Ruta(string carpeta, string tabla)
        {
            if (!Directory.Exists(carpeta)) throw new Exception("No existe la carpeta " + carpeta);
            var f = Directory.GetFiles(carpeta, tabla).FirstOrDefault();
            if (f == null) throw new Exception("No existe " + tabla + " en " + carpeta);
            return f;
        }

        static RegistroDbf PrimerRegistro(string ruta)
        {
            using (var t = new TablaDbf(ruta))
                for (int i = 0; i < t.Registros; i++) { var r = t.Leer(i); if (r != null) return r; }
            return null;
        }

        /// <summary>Próximo folio por campo de correlat.dbf. Si hay varios registros (por caja), el mayor.</summary>
        static Dictionary<string, long> Correlativos(string ruta)
        {
            var d = new Dictionary<string, long>(StringComparer.OrdinalIgnoreCase);
            using (var t = new TablaDbf(ruta))
                for (int i = 0; i < t.Registros; i++)
                {
                    var r = t.Leer(i);
                    if (r == null) continue;
                    foreach (var tf in TipoFolio.Todos)
                    {
                        long v = Entero(r.Texto(tf.Correlativo)), ant;
                        if (!d.TryGetValue(tf.Correlativo, out ant) || v > ant) d[tf.Correlativo] = v;
                    }
                }
            return d;
        }

        static List<RangoCaf> Cafs(string ruta)
        {
            var l = new List<RangoCaf>();
            using (var t = new TablaDbf(ruta))
                for (int i = 0; i < t.Registros; i++)
                {
                    var r = t.Leer(i);
                    if (r == null) continue;
                    DateTime f;
                    l.Add(new RangoCaf {
                        Tipo = r.Texto("TIPODOCU"), Desde = Entero(r.Texto("FOLDESDE")), Hasta = Entero(r.Texto("FOLHASTA")),
                        Autorizado = DateTime.TryParseExact(r.Texto("FECHAUTO"), "dd/MM/yyyy", CultureInfo.InvariantCulture, DateTimeStyles.None, out f) ? (DateTime?)f : null });
                }
            return l;
        }

        /// <summary>
        /// Documentos emitidos por tipo Sisgen en los últimos 30 días y el mayor folio emitido de cada tipo
        /// (tablas F1 del mes y el anterior).
        /// </summary>
        static Dictionary<string, double> Consumo(string carpetaDatos, DateTime hoy, out Dictionary<string, long> ultimos)
        {
            var d = new Dictionary<string, double>(StringComparer.OrdinalIgnoreCase);
            ultimos = new Dictionary<string, long>(StringComparer.OrdinalIgnoreCase);
            string desde = hoy.AddDays(-DiasConsumo).ToString("yyyy-MM-dd"), hasta = hoy.ToString("yyyy-MM-dd");
            for (var m = new DateTime(hoy.Year, hoy.Month, 1); m >= new DateTime(hoy.Year, hoy.Month, 1).AddMonths(-1); m = m.AddMonths(-1))
            {
                var f = Directory.GetFiles(carpetaDatos, "F1" + m.ToString("MMyyyy") + ".dbf").FirstOrDefault();
                if (f == null) continue;
                using (var t = new TablaDbf(f))
                    for (int i = 0; i < t.Registros; i++)
                    {
                        var r = t.Leer(i);
                        if (r == null) continue;
                        string tipo = r.Texto("FATDOCTO");
                        long num = Entero(r.Texto("FANUMERO")), u;
                        if (num > 0 && (!ultimos.TryGetValue(tipo, out u) || num > u)) ultimos[tipo] = num;
                        string fecha = r.Fecha("FAFECHA");
                        if (fecha == null || string.CompareOrdinal(fecha, desde) <= 0 || string.CompareOrdinal(fecha, hasta) > 0) continue;
                        double n;
                        d.TryGetValue(tipo, out n);
                        d[tipo] = n + 1;
                    }
            }
            return d;
        }

        static long Entero(string s)
        {
            long n;
            return long.TryParse((s ?? "").Trim(), NumberStyles.Integer, CultureInfo.InvariantCulture, out n) ? n : 0;
        }

        static DateTime? FechaDbf(string s)
        {
            DateTime d;
            return DateTime.TryParseExact((s ?? "").Trim(), "yyyyMMdd", CultureInfo.InvariantCulture, DateTimeStyles.None, out d) ? (DateTime?)d : null;
        }
    }
}
