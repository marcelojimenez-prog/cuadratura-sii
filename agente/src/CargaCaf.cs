// Carga de un CAF en Sisgen, igual que "Cargar nuevos folios" + "Asignar siguiente rango de folios":
//   - copia el XML a procesos\folios\
//   - agrega la fila a datos\folios.dbf y actualiza su índice folios.cdx (tag sobre tipodocu)
//   - si el documento está sin folios: lo asigna (prmsis DTEFOLIOxx = hasta; correlativo = max(desde, actual))
//     si aún quedan folios: lo deja en espera (prmsis FOLIODESxx / FOLIOHASxx), como hace Sisgen
// Excepción de escritura autorizada: SOLO folios.dbf/.cdx, prmsis.dbf, correlat.dbf y procesos\folios.
// Antes de escribir se respaldan las tablas; si algo falla a medias, se restauran. Las tablas se abren en
// exclusivo: si Sisgen las tiene abiertas, no se hace nada. El XML (con la llave privada RSASK) solo se copia.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;

namespace SisgenAgente
{
    public static class CargaCaf
    {
        static readonly Encoding Latin = Encoding.GetEncoding(28591);

        static readonly Dictionary<string, string> NombresDoc = new Dictionary<string, string> {
            { "39", "BOLETA" }, { "41", "BOLETA EXENTA" }, { "33", "FACTURA" }, { "34", "FACTURA EXENTA" },
            { "61", "NOTA DE CREDITO" }, { "56", "NOTA DE DEBITO" }, { "52", "GUIA DE DESPACHO" } };

        public static string Cargar(string carpetaSisgen, string archivoXml, string carpetaRespaldos)
        {
            string datos = Path.Combine(carpetaSisgen, "datos");
            string dirFolios = Path.Combine(carpetaSisgen, "procesos", "folios");
            // ---- CAF ----
            byte[] bytesXml = File.ReadAllBytes(archivoXml);
            string xml = Latin.GetString(bytesXml);
            Func<string, string> tag = t => { var m = Regex.Match(xml, "<" + t + ">([^<]*)</" + t + ">"); return m.Success ? m.Groups[1].Value.Trim() : null; };
            string re = tag("RE"), rs = tag("RS"), td = tag("TD"), sd = tag("D"), sh = tag("H"), fa = tag("FA"),
                   mod = tag("M"), exp = tag("E"), idk = tag("IDK"), frma = Regex.Match(xml, "<FRMA[^>]*>([^<]*)</FRMA>").Groups[1].Value.Trim();
            long desde, hasta;
            if (re == null || td == null || !long.TryParse(sd, out desde) || !long.TryParse(sh, out hasta) || fa == null || mod == null || frma.Length == 0)
                throw new Exception("El archivo no es un CAF válido");
            if (xml.IndexOf("<RSASK>", StringComparison.Ordinal) < 0) throw new Exception("El CAF no trae la llave privada (RSASK)");
            var tipo = TipoFolio.Todos.FirstOrDefault(x => x.Sii == td);
            if (tipo == null) throw new Exception("Tipo de documento " + td + " no manejado");

            // ---- Empresa ----
            string rutEmpresa;
            using (var t = new TablaDbf(Requerido(datos, "empres.dbf"))) rutEmpresa = t.Leer(0).Texto("DTERUT").Replace(".", "").Trim().ToUpperInvariant();
            if (rutEmpresa != re.ToUpperInvariant()) throw new Exception("El CAF es del RUT " + re + " y la empresa es " + rutEmpresa);

            string rFolios = Requerido(datos, "folios.dbf"), rCdx = Path.ChangeExtension(rFolios, ".cdx"),
                   rPrm = Requerido(datos, "prmsis.dbf"), rCor = Requerido(datos, "correlat.dbf");
            if (!File.Exists(rCdx)) rCdx = null;

            // ---- Respaldo ----
            string respaldo = Path.Combine(carpetaRespaldos, Path.GetFileName(carpetaSisgen.TrimEnd('\\')), DateTime.Now.ToString("yyyyMMdd_HHmmss"));
            Directory.CreateDirectory(respaldo);
            var archivos = new List<string> { rFolios, rPrm, rCor };
            if (rCdx != null) archivos.Add(rCdx);
            foreach (var a in archivos) File.Copy(a, Path.Combine(respaldo, Path.GetFileName(a)));

            string destinoXml = Path.Combine(dirFolios, ("T" + td + "D" + desde + "H" + hasta + ".xml").ToLowerInvariant());
            bool xmlCopiado = false;
            var abiertos = new List<FileStream>();
            try
            {
                // Compartido, como otra caja de Sisgen: se toman los bloqueos de FoxPro (no se impide que Sisgen abra la tabla).
                // Si una caja tiene tomado el registro o la tabla, se espera unos segundos; si no se libera, no se cambia nada.
                Func<string, FileStream> abrir = r =>
                {
                    try { var fs = new FileStream(r, FileMode.Open, FileAccess.ReadWrite, FileShare.ReadWrite); abiertos.Add(fs); return fs; }
                    catch (IOException) { throw new Exception("Sisgen tiene " + Path.GetFileName(r) + " abierta en exclusivo (reindexando o reparando). No se cambió nada."); }
                };
                var fsFolios = abrir(rFolios);
                Bloqueo.Tabla(fsFolios, rFolios);           // como FLOCK(): agregar un registro
                var cdx = rCdx != null ? abrir(rCdx) : null;
                if (cdx != null) Bloqueo.Cabecera(cdx, rCdx);
                var fsPrm = abrir(rPrm);
                var fsCor = abrir(rCor);
                var folios = new Dbf(fsFolios);
                var prm = new Dbf(fsPrm);
                var cor = new Dbf(fsCor);
                Bloqueo.Registro(fsPrm, rPrm, prm.PrimerVigente() + 1);  // como RLOCK()
                Bloqueo.Registro(fsCor, rCor, cor.PrimerVigente() + 1);

                // ---- Estado y validaciones ----
                for (int i = 0; i < folios.Registros; i++)
                {
                    if (folios.Borrado(i) || folios.Texto(i, "TIPODOCU") != td) continue;
                    long d, h;
                    if (!long.TryParse(folios.Texto(i, "FOLDESDE"), out d) || !long.TryParse(folios.Texto(i, "FOLHASTA"), out h)) continue;
                    if (d == desde && h == hasta) throw new Exception("Este CAF ya está cargado en folios.dbf");
                    if (d <= hasta && desde <= h) throw new Exception("El CAF se cruza con otro ya cargado (" + d + "-" + h + ")");
                }
                int regPrm = prm.PrimerVigente(), regCor = cor.PrimerVigente();
                if (regPrm < 0 || regCor < 0) throw new Exception("prmsis o correlat sin registros");
                if (Enumerable.Range(0, cor.Registros).Count(i => !cor.Borrado(i)) > 1) throw new Exception("correlat tiene correlativos por caja/bodega: aún no soportado");
                long tope = Num(prm.Texto(regPrm, "DTEFOLIO" + tipo.Sisgen)), proximo = Num(cor.Texto(regCor, tipo.Correlativo));
                long espDesde = Num(prm.Texto(regPrm, "FOLIODES" + tipo.Espera)), espHasta = Num(prm.Texto(regPrm, "FOLIOHAS" + tipo.Espera));
                if (hasta < proximo) throw new Exception("El CAF termina en " + hasta + " y el próximo folio ya es " + proximo + ": no sirve");
                bool asignar = proximo > tope;
                if (!asignar && espHasta > 0) throw new Exception("Ya hay un CAF en espera (" + espDesde + "-" + espHasta + "); Sisgen tiene una sola ranura");

                // ---- Índice: se calcula antes de escribir nada ----
                byte[] nuevoCdx = null;
                if (cdx != null) nuevoCdx = IndiceCdx.Agregar(cdx, folios, "TIPODOCU", td);

                // ---- Escritura ----
                Directory.CreateDirectory(dirFolios);
                if (!File.Exists(destinoXml)) { File.WriteAllBytes(destinoXml, bytesXml); xmlCopiado = true; }
                folios.Agregar(new Dictionary<string, string> {
                    { "RUTEMPRE", re }, { "RAZONSOC", rs ?? "" }, { "TIPODOCU", td },
                    { "NOMBDOCU", NombresDoc.ContainsKey(td) ? NombresDoc[td] : "" },
                    { "FOLDESDE", desde.ToString() }, { "FOLHASTA", hasta.ToString() },
                    { "FECHAUTO", DateTime.ParseExact(fa, "yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture).ToString("dd/MM/yyyy", System.Globalization.CultureInfo.InvariantCulture) },
                    { "MODULOXX", mod }, { "EXPONENT", exp ?? "" }, { "IDENTKEY", idk ?? "" }, { "FIRMAUTO", frma },
                    { "FIRMAPEM", "T" + td + "D" + desde + "H" + hasta + ".xml" } });
                if (nuevoCdx != null) { cdx.Position = 0; cdx.Write(nuevoCdx, 0, nuevoCdx.Length); cdx.SetLength(nuevoCdx.Length); }
                string resultado;
                if (asignar)
                {
                    prm.Escribir(regPrm, "DTEFOLIO" + tipo.Sisgen, hasta.ToString());
                    long nuevoProx = Math.Max(desde, proximo);
                    cor.Escribir(regCor, tipo.Correlativo, nuevoProx.ToString());
                    if (tipo.Vence) prm.Escribir(regPrm, "DTEFECHA" + tipo.Sisgen, DateTime.ParseExact(fa, "yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture).AddDays(180).ToString("yyyyMMdd"));
                    resultado = "asignado: próximo folio " + nuevoProx + ", tope " + hasta;
                }
                else
                {
                    prm.Escribir(regPrm, "FOLIODES" + tipo.Espera, desde.ToString());
                    prm.Escribir(regPrm, "FOLIOHAS" + tipo.Espera, hasta.ToString());
                    if (tipo.Vence) prm.Escribir(regPrm, "DTEFECH2" + tipo.Sisgen, DateTime.ParseExact(fa, "yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture).AddDays(180).ToString("yyyyMMdd"));
                    resultado = "en espera: Sisgen lo asigna al terminar el tope " + tope;
                }
                foreach (var fs in abiertos) fs.Flush();
                return tipo.Nombre + " " + desde + "-" + hasta + " " + resultado + ". Respaldo en " + respaldo;
            }
            catch
            {
                foreach (var fs in abiertos) fs.Dispose();
                abiertos.Clear();
                // Restaurar lo que se haya alcanzado a escribir
                foreach (var a in archivos)
                {
                    string b = Path.Combine(respaldo, Path.GetFileName(a));
                    try { if (File.Exists(b) && !SonIguales(a, b)) File.Copy(b, a, true); } catch { }
                }
                if (xmlCopiado) try { File.Delete(destinoXml); } catch { }
                throw;
            }
            finally { foreach (var fs in abiertos) fs.Dispose(); }
        }

        /// <summary>
        /// Salto automático: si el documento se quedó sin folios y hay un CAF en espera, hace lo mismo que
        /// "¿Desea asignar los próximos folios autorizados?" de Sisgen: tope = FOLIOHAS, próximo = max(FOLIODES, actual),
        /// vacía la ranura. Devuelve null si no había nada que hacer.
        /// </summary>
        public static string AsignarEspera(string carpetaSisgen, TipoFolio tipo, string carpetaRespaldos)
        {
            string datos = Path.Combine(carpetaSisgen, "datos");
            string rPrm = Requerido(datos, "prmsis.dbf"), rCor = Requerido(datos, "correlat.dbf");
            string respaldo = Path.Combine(carpetaRespaldos, Path.GetFileName(carpetaSisgen.TrimEnd('\\')), DateTime.Now.ToString("yyyyMMdd_HHmmss") + "_salto");
            Directory.CreateDirectory(respaldo);
            var archivos = new List<string> { rPrm, rCor };
            foreach (var a in archivos) File.Copy(a, Path.Combine(respaldo, Path.GetFileName(a)));
            var abiertos = new List<FileStream>();
            try
            {
                foreach (var a in archivos) abiertos.Add(new FileStream(a, FileMode.Open, FileAccess.ReadWrite, FileShare.ReadWrite));
                var prm = new Dbf(abiertos[0]);
                var cor = new Dbf(abiertos[1]);
                int regPrm = prm.PrimerVigente(), regCor = cor.PrimerVigente();
                if (regPrm < 0 || regCor < 0) throw new Exception("prmsis o correlat sin registros");
                if (Enumerable.Range(0, cor.Registros).Count(i => !cor.Borrado(i)) > 1) throw new Exception("correlat tiene correlativos por caja/bodega: aún no soportado");
                Bloqueo.Registro(abiertos[0], rPrm, regPrm + 1);
                Bloqueo.Registro(abiertos[1], rCor, regCor + 1);
                long tope = Num(prm.Texto(regPrm, "DTEFOLIO" + tipo.Sisgen)), proximo = Num(cor.Texto(regCor, tipo.Correlativo));
                long espDesde = Num(prm.Texto(regPrm, "FOLIODES" + tipo.Espera)), espHasta = Num(prm.Texto(regPrm, "FOLIOHAS" + tipo.Espera));
                if (proximo <= tope || espHasta <= 0) { Directory.Delete(respaldo, true); return null; }
                if (espHasta < proximo) throw new Exception("El CAF en espera (" + espDesde + "-" + espHasta + ") ya quedó atrás del próximo folio " + proximo);
                long nuevoProx = Math.Max(espDesde, proximo);
                prm.Escribir(regPrm, "DTEFOLIO" + tipo.Sisgen, espHasta.ToString());
                cor.Escribir(regCor, tipo.Correlativo, nuevoProx.ToString());
                if (tipo.Vence) prm.Escribir(regPrm, "DTEFECHA" + tipo.Sisgen, prm.Texto(regPrm, "DTEFECH2" + tipo.Sisgen));
                if (tipo.Vence) prm.Escribir(regPrm, "DTEFECH2" + tipo.Sisgen, "");
                prm.Escribir(regPrm, "FOLIODES" + tipo.Espera, "");
                prm.Escribir(regPrm, "FOLIOHAS" + tipo.Espera, "");
                foreach (var fs in abiertos) fs.Flush();
                return tipo.Nombre + ": se asignó el rango en espera " + espDesde + "-" + espHasta + " (próximo folio " + nuevoProx + ")";
            }
            catch
            {
                foreach (var fs in abiertos) fs.Dispose();
                abiertos.Clear();
                foreach (var a in archivos)
                {
                    string b = Path.Combine(respaldo, Path.GetFileName(a));
                    try { if (File.Exists(b) && !SonIguales(a, b)) File.Copy(b, a, true); } catch { }
                }
                throw;
            }
            finally { foreach (var fs in abiertos) fs.Dispose(); }
        }

        static bool SonIguales(string a, string b) { return File.ReadAllBytes(a).SequenceEqual(File.ReadAllBytes(b)); }
        static long Num(string s) { long n; return long.TryParse((s ?? "").Trim(), out n) ? n : 0; }

        static string Requerido(string carpeta, string nombre)
        {
            string r = Ventas.Buscar(carpeta, nombre);
            if (r == null) throw new Exception("No está " + nombre + " en " + carpeta);
            return r;
        }
    }

    /// <summary>
    /// Bloqueos de Visual FoxPro (los mismos bytes que bloquea Sisgen con RLOCK/FLOCK, fuera del contenido del archivo):
    /// registro n = 0x7FFFFFFE - n; cabecera = 0x7FFFFFFE; tabla completa = rango bajo la cabecera.
    /// Se liberan al cerrar el archivo.
    /// </summary>
    public static class Bloqueo
    {
        const long Base = 0x7FFFFFFE, RangoTabla = 0x07FFFFFF;

        public static void Registro(FileStream fs, string nombre, int recno) { Tomar(fs, nombre, Base - recno, 1); }
        public static void Cabecera(FileStream fs, string nombre) { Tomar(fs, nombre, Base, 1); }
        public static void Tabla(FileStream fs, string nombre) { Tomar(fs, nombre, Base, 1); Tomar(fs, nombre, Base - RangoTabla, RangoTabla); }

        static void Tomar(FileStream fs, string nombre, long pos, long largo)
        {
            for (int intento = 0; ; intento++)
            {
                try { fs.Lock(pos, largo); return; }
                catch (IOException)
                {
                    if (intento >= 50) throw new Exception("Sisgen está usando " + Path.GetFileName(nombre) + " (bloqueada por más de 10 segundos). No se cambió nada.");
                    System.Threading.Thread.Sleep(200);
                }
            }
        }
    }

    /// <summary>Tabla DBF (FoxPro) abierta para escribir: leer/escribir campos de tipo C, N y D y agregar registros.</summary>
    public class Dbf
    {
        readonly FileStream fs;
        public int Registros;
        readonly int largoCabecera, largoRegistro;
        readonly Dictionary<string, Tuple<int, int, char>> campos = new Dictionary<string, Tuple<int, int, char>>(StringComparer.OrdinalIgnoreCase);
        static readonly Encoding Latin = Encoding.GetEncoding(28591);

        public Dbf(FileStream f)
        {
            fs = f;
            var h = new byte[32];
            fs.Position = 0; fs.Read(h, 0, 32);
            Registros = BitConverter.ToInt32(h, 4); largoCabecera = BitConverter.ToUInt16(h, 8); largoRegistro = BitConverter.ToUInt16(h, 10);
            var cab = new byte[largoCabecera];
            fs.Position = 0; fs.Read(cab, 0, largoCabecera);
            int pos = 1;
            for (int o = 32; o + 32 <= largoCabecera && cab[o] != 0x0D; o += 32)
            {
                string n = Latin.GetString(cab, o, 11).Split('\0')[0];
                campos[n] = Tuple.Create(pos, (int)cab[o + 16], (char)cab[o + 11]);
                pos += cab[o + 16];
            }
            if (pos != largoRegistro) throw new Exception("Estructura de tabla inesperada");
        }

        byte[] Leer(int i)
        {
            var r = new byte[largoRegistro];
            fs.Position = largoCabecera + (long)i * largoRegistro;
            if (fs.Read(r, 0, largoRegistro) != largoRegistro) throw new Exception("Tabla incompleta");
            return r;
        }

        public bool Borrado(int i) { return Leer(i)[0] == (byte)'*'; }
        public int PrimerVigente() { for (int i = 0; i < Registros; i++) if (!Borrado(i)) return i; return -1; }

        public string Texto(int i, string campo)
        {
            var c = Campo(campo);
            return Latin.GetString(Leer(i), c.Item1, c.Item2).Trim();
        }

        Tuple<int, int, char> Campo(string n)
        {
            Tuple<int, int, char> c;
            if (!campos.TryGetValue(n, out c)) throw new Exception("No existe el campo " + n);
            return c;
        }

        byte[] Formatear(string campo, string valor, string actual)
        {
            var c = Campo(campo);
            string v;
            if (c.Item3 == 'N') v = valor.PadLeft(c.Item2);
            else if (c.Item3 == 'D') v = valor.PadRight(c.Item2);
            else if (c.Item3 == 'C')
            {
                // Correlativos guardados con ceros a la izquierda (000000026): se respeta ese formato
                string a = (actual ?? "").Trim();
                v = (a.Length > 1 && a.All(char.IsDigit) && a[0] == '0' && valor.All(char.IsDigit) ? valor.PadLeft(a.Length, '0') : valor).PadRight(c.Item2);
            }
            else throw new Exception("Campo " + campo + " de tipo " + c.Item3 + " no soportado");
            if (v.Length > c.Item2) throw new Exception("El valor no cabe en " + campo);
            return Latin.GetBytes(v);
        }

        public void Escribir(int i, string campo, string valor)
        {
            var c = Campo(campo);
            byte[] b = Formatear(campo, valor, Texto(i, campo));
            fs.Position = largoCabecera + (long)i * largoRegistro + c.Item1;
            fs.Write(b, 0, b.Length);
            Fecha();
        }

        public void Agregar(Dictionary<string, string> valores)
        {
            var r = Enumerable.Repeat((byte)' ', largoRegistro).ToArray();
            foreach (var kv in valores)
            {
                var c = Campo(kv.Key);
                byte[] b = Formatear(kv.Key, kv.Value, null);
                Array.Copy(b, 0, r, c.Item1, b.Length);
            }
            fs.Position = largoCabecera + (long)Registros * largoRegistro;
            fs.Write(r, 0, r.Length);
            fs.WriteByte(0x1A);
            fs.SetLength(fs.Position);
            Registros++;
            fs.Position = 4; fs.Write(BitConverter.GetBytes(Registros), 0, 4);
            Fecha();
        }

        void Fecha()
        {
            var h = DateTime.Today;
            fs.Position = 1; fs.Write(new[] { (byte)(h.Year % 100), (byte)h.Month, (byte)h.Day }, 0, 3);
        }
    }

    /// <summary>
    /// Índice compuesto de FoxPro (.cdx) con un solo tag de una sola hoja (caso de folios.cdx). Se decodifica la hoja,
    /// se verifica que corresponde exactamente a la tabla, se agrega la clave del registro nuevo y se vuelve a codificar.
    /// Si el índice no tiene esa forma simple, no se toca (error).
    /// </summary>
    public static class IndiceCdx
    {
        const int Nodo = 512;
        static readonly Encoding Latin = Encoding.GetEncoding(28591);

        class Hoja { public int Attr, BitsRec, BitsDup, BitsTrail, BytesInfo; public long MascaraRec; public int MascaraDup, MascaraTrail; public List<Tuple<byte[], long>> Claves; }

        public static byte[] Agregar(FileStream fs, Dbf tabla, string campo, string valorNuevo)
        {
            var b = new byte[fs.Length];
            fs.Position = 0; fs.Read(b, 0, b.Length);
            // Directorio de tags (cabecera en 0, raíz hoja con un solo tag)
            int raizDir = BitConverter.ToInt32(b, 0);
            var dir = Decodificar(b, raizDir, BitConverter.ToUInt16(b, 12));
            if (dir.Attr != 3 || dir.Claves.Count != 1) throw new Exception("Índice con varios tags: no soportado");
            int cab = (int)dir.Claves[0].Item2;
            int largoClave = BitConverter.ToUInt16(b, cab + 12);
            string expr = Latin.GetString(b, cab + 512, BitConverter.ToUInt16(b, cab + 510)).TrimEnd('\0').Trim();
            if (!expr.Equals(campo, StringComparison.OrdinalIgnoreCase)) throw new Exception("Índice sobre '" + expr + "': no soportado");
            if (BitConverter.ToUInt16(b, cab + 506) > 1) throw new Exception("Índice con filtro: no soportado");
            int raiz = BitConverter.ToInt32(b, cab);
            var hoja = Decodificar(b, raiz, largoClave);
            if (hoja.Attr != 3) throw new Exception("Índice de más de una hoja: no soportado");
            // Debe corresponder exactamente a la tabla (antes del registro nuevo)
            Func<string, byte[]> clave = v => Latin.GetBytes((v ?? "").PadRight(largoClave).Substring(0, largoClave));
            var esperadas = new List<Tuple<byte[], long>>();
            for (int i = 0; i < tabla.Registros; i++) esperadas.Add(Tuple.Create(clave(tabla.Texto(i, campo)), (long)(i + 1)));
            esperadas.Sort(Comparar);
            if (!Iguales(hoja.Claves, esperadas)) throw new Exception("El índice no coincide con la tabla (reindexar en Sisgen): no se tocó");
            esperadas.Add(Tuple.Create(clave(valorNuevo), (long)(tabla.Registros + 1)));
            esperadas.Sort(Comparar);
            var nodo = Codificar(hoja, esperadas, largoClave);
            var salida = (byte[])b.Clone();
            Array.Copy(nodo, 0, salida, raiz, Nodo);
            // Comprobación: lo escrito se vuelve a leer igual
            if (!Iguales(Decodificar(salida, raiz, largoClave).Claves, esperadas)) throw new Exception("Error al codificar el índice: no se tocó");
            return salida;
        }

        static int Comparar(Tuple<byte[], long> a, Tuple<byte[], long> b)
        {
            for (int i = 0; i < a.Item1.Length; i++) if (a.Item1[i] != b.Item1[i]) return a.Item1[i].CompareTo(b.Item1[i]);
            return a.Item2.CompareTo(b.Item2);
        }

        static bool Iguales(List<Tuple<byte[], long>> a, List<Tuple<byte[], long>> b)
        {
            return a.Count == b.Count && a.Zip(b, (x, y) => x.Item2 == y.Item2 && x.Item1.SequenceEqual(y.Item1)).All(z => z);
        }

        static Hoja Decodificar(byte[] b, int o, int largoClave)
        {
            var h = new Hoja { Attr = BitConverter.ToUInt16(b, o), Claves = new List<Tuple<byte[], long>>() };
            int n = BitConverter.ToUInt16(b, o + 2);
            h.MascaraRec = BitConverter.ToUInt32(b, o + 14); h.MascaraDup = b[o + 18]; h.MascaraTrail = b[o + 19];
            h.BitsRec = b[o + 20]; h.BitsDup = b[o + 21]; h.BitsTrail = b[o + 22]; h.BytesInfo = b[o + 23];
            if ((h.Attr & 2) == 0) return h; // nodo interior: no se decodifica
            int fin = o + Nodo;
            byte[] previa = new byte[largoClave];
            for (int k = 0; k < n; k++)
            {
                long v = 0;
                for (int j = 0; j < h.BytesInfo; j++) v |= (long)b[o + 24 + k * h.BytesInfo + j] << (8 * j);
                long rec = v & h.MascaraRec;
                int dup = (int)(v >> h.BitsRec) & h.MascaraDup, trail = (int)(v >> (h.BitsRec + h.BitsDup)) & h.MascaraTrail;
                int guardados = largoClave - dup - trail;
                fin -= guardados;
                var c = new byte[largoClave];
                Array.Copy(previa, c, dup);
                Array.Copy(b, fin, c, dup, guardados);
                for (int j = largoClave - trail; j < largoClave; j++) c[j] = (byte)' ';
                h.Claves.Add(Tuple.Create(c, rec));
                previa = c;
            }
            int libre = BitConverter.ToUInt16(b, o + 12);
            if (libre != fin - (o + 24 + n * h.BytesInfo)) throw new Exception("Índice con formato inesperado");
            return h;
        }

        static byte[] Codificar(Hoja h, List<Tuple<byte[], long>> claves, int largoClave)
        {
            var nodo = new byte[Nodo];
            BitConverter.GetBytes((ushort)h.Attr).CopyTo(nodo, 0);
            BitConverter.GetBytes((ushort)claves.Count).CopyTo(nodo, 2);
            BitConverter.GetBytes(-1).CopyTo(nodo, 4);
            BitConverter.GetBytes(-1).CopyTo(nodo, 8);
            BitConverter.GetBytes((uint)h.MascaraRec).CopyTo(nodo, 14);
            nodo[18] = (byte)h.MascaraDup; nodo[19] = (byte)h.MascaraTrail;
            nodo[20] = (byte)h.BitsRec; nodo[21] = (byte)h.BitsDup; nodo[22] = (byte)h.BitsTrail; nodo[23] = (byte)h.BytesInfo;
            int fin = Nodo;
            byte[] previa = null;
            for (int k = 0; k < claves.Count; k++)
            {
                byte[] c = claves[k].Item1;
                long rec = claves[k].Item2;
                if (rec > h.MascaraRec) throw new Exception("Índice: número de registro fuera de rango");
                int trail = 0;
                while (trail < largoClave && c[largoClave - 1 - trail] == (byte)' ') trail++;
                trail = Math.Min(trail, h.MascaraTrail);
                int dup = 0;
                if (previa != null) while (dup < largoClave - trail && previa[dup] == c[dup]) dup++;
                dup = Math.Min(dup, h.MascaraDup);
                int guardados = largoClave - dup - trail;
                fin -= guardados;
                if (fin < 24 + (k + 1) * h.BytesInfo) throw new Exception("Índice lleno (necesita más de una hoja): no soportado");
                Array.Copy(c, dup, nodo, fin, guardados);
                long v = rec | ((long)dup << h.BitsRec) | ((long)trail << (h.BitsRec + h.BitsDup));
                for (int j = 0; j < h.BytesInfo; j++) nodo[24 + k * h.BytesInfo + j] = (byte)(v >> (8 * j));
                previa = c;
            }
            BitConverter.GetBytes((ushort)(fin - (24 + claves.Count * h.BytesInfo))).CopyTo(nodo, 12);
            return nodo;
        }
    }
}
