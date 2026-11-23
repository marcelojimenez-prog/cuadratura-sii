// Pruebas automáticas del agente (se ejecutan al compilar; si fallan, no se genera el instalador).
// Por cada caso de pruebas\casos\ (folios.dbf + folios.cdx reales, con los datos de clientes en blanco):
//   1) verifica que el índice original coincide con la tabla
//   2) agrega 200 CAF uno a uno con el mismo código que usa el agente (IndiceCdx.Agregar + Dbf.Agregar)
//   3) después de cada uno, revisa el índice con un lector propio de estas pruebas (independiente del agente)
// Así se cubren el formato chico de FoxPro (hasta 15 CAF), el cambio al formato grande, la marca "tipo 7"
// y los índices de varias páginas.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;

namespace SisgenAgente
{
    public static class Pruebas
    {
        public static int Main(string[] args)
        {
            string casos = args.Length > 0 ? args[0] : Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "..", "casos");
            int agregar = args.Length > 1 ? int.Parse(args[1]) : 200;
            int fallas = 0, total = 0;
            foreach (var caso in Directory.GetDirectories(casos).OrderBy(x => x))
            {
                total++;
                string nombre = Path.GetFileName(caso);
                string temp = Path.Combine(Path.GetTempPath(), "pruebas_agente_" + Guid.NewGuid().ToString("N"));
                try
                {
                    Directory.CreateDirectory(temp);
                    string dbf = Path.Combine(temp, "folios.dbf"), cdx = Path.Combine(temp, "folios.cdx");
                    File.Copy(Path.Combine(caso, "folios.dbf"), dbf);
                    File.Copy(Path.Combine(caso, "folios.cdx"), cdx);
                    int iniciales;
                    Verificar(dbf, cdx, out iniciales);
                    var tipos = new[] { "39", "33", "61", "41", "56", "52", "34" };
                    for (int i = 0; i < agregar; i++)
                    {
                        string td = tipos[i % tipos.Length];
                        using (var fd = new FileStream(dbf, FileMode.Open, FileAccess.ReadWrite))
                        using (var fc = new FileStream(cdx, FileMode.Open, FileAccess.ReadWrite))
                        {
                            var t = new Dbf(fd);
                            var nuevo = IndiceCdx.Agregar(fc, t, "TIPODOCU", td);
                            t.Agregar(new Dictionary<string, string> { { "TIPODOCU", td } });
                            fc.Position = 0; fc.Write(nuevo, 0, nuevo.Length); fc.SetLength(nuevo.Length);
                        }
                        int n;
                        try { Verificar(dbf, cdx, out n); }
                        catch (Exception e) { throw new Exception("después de agregar el CAF " + (i + 1) + ": " + e.Message); }
                    }
                    int finales; string forma = Verificar(dbf, cdx, out finales);
                    Console.WriteLine("OK     " + nombre + ": " + iniciales + " → " + finales + " CAF; " + forma);
                }
                catch (Exception e)
                {
                    fallas++;
                    Console.WriteLine("FALLA  " + nombre + ": " + e.Message);
                }
                finally { try { Directory.Delete(temp, true); } catch { } }
            }
            Console.WriteLine(fallas == 0 ? "Pruebas del índice: " + total + " casos correctos." : "Pruebas del índice: " + fallas + " de " + total + " FALLARON.");
            return fallas == 0 ? 0 : 1;
        }

        // ---------- Lector independiente del índice (no usa el código del agente) ----------

        /// <summary>Lee el índice completo y lo compara con la tabla. Devuelve una descripción de su forma.</summary>
        static string Verificar(string rutaDbf, string rutaCdx, out int filas)
        {
            byte[] d = File.ReadAllBytes(rutaDbf), b = File.ReadAllBytes(rutaCdx);
            filas = BitConverter.ToInt32(d, 4);
            int cab = BitConverter.ToUInt16(d, 8), largo = BitConverter.ToUInt16(d, 10);
            if (d.Length != cab + filas * largo + 1 || d[d.Length - 1] != 0x1A) throw new Exception("folios.dbf con tamaño inesperado");
            int pos = 1, ancho = 0, campo = -1;
            for (int o = 32; d[o] != 0x0D; o += 32)
            {
                string nm = Encoding.ASCII.GetString(d, o, 11).Split('\0')[0];
                if (nm.Equals("TIPODOCU", StringComparison.OrdinalIgnoreCase)) { campo = pos; ancho = d[o + 16]; }
                pos += d[o + 16];
            }
            // Tag único: el directorio es una hoja con una clave cuyo "registro" es la posición de la cabecera del tag
            int raizDir = BitConverter.ToInt32(b, 0);
            var dir = LeerHoja(b, raizDir, BitConverter.ToUInt16(b, 12));
            if (dir.Count != 1) throw new Exception("se esperaba un solo tag");
            int tag = (int)dir[0].Item2, kl = BitConverter.ToUInt16(b, tag + 12);
            var esperadas = new List<Tuple<string, long>>();
            for (int i = 0; i < filas; i++)
                esperadas.Add(Tuple.Create(Encoding.ASCII.GetString(d, cab + i * largo + campo, ancho).PadRight(kl).Substring(0, kl), (long)(i + 1)));
            esperadas = esperadas.OrderBy(x => x.Item1, StringComparer.Ordinal).ThenBy(x => x.Item2).ToList();

            // Recorre el árbol: los nodos interiores apuntan a sus hijos; las hojas se leen en orden
            var leidas = new List<Tuple<string, long>>();
            int hojas = 0, niveles = 0, raiz = BitConverter.ToInt32(b, tag);
            var nivel = new List<int> { raiz };
            while (true)
            {
                niveles++;
                int attr = BitConverter.ToUInt16(b, nivel[0]);
                if ((attr & 2) != 0)
                {
                    // Las hojas de este nivel también deben estar enlazadas entre sí, de izquierda a derecha
                    for (int i = 0; i < nivel.Count; i++)
                    {
                        int izq = BitConverter.ToInt32(b, nivel[i] + 4), der = BitConverter.ToInt32(b, nivel[i] + 8);
                        if (izq != (i == 0 ? -1 : nivel[i - 1]) || der != (i == nivel.Count - 1 ? -1 : nivel[i + 1])) throw new Exception("hojas mal enlazadas");
                        leidas.AddRange(LeerHoja(b, nivel[i], kl).Select(x => Tuple.Create(Encoding.ASCII.GetString(x.Item1), x.Item2)));
                        hojas++;
                    }
                    break;
                }
                var abajo = new List<int>();
                foreach (int o in nivel)
                {
                    int n = BitConverter.ToUInt16(b, o + 2);
                    for (int j = 0; j < n; j++)
                    {
                        int e = o + 12 + j * (kl + 8);
                        abajo.Add((b[e + kl + 4] << 24) | (b[e + kl + 5] << 16) | (b[e + kl + 6] << 8) | b[e + kl + 7]);
                    }
                }
                nivel = abajo;
                if (niveles > 8) throw new Exception("demasiados niveles");
            }
            if (leidas.Count != esperadas.Count) throw new Exception("el índice tiene " + leidas.Count + " claves y la tabla " + esperadas.Count + " filas");
            for (int i = 0; i < leidas.Count; i++)
                if (leidas[i].Item1 != esperadas[i].Item1 || leidas[i].Item2 != esperadas[i].Item2)
                    throw new Exception("clave " + (i + 1) + " distinta: índice " + leidas[i] + ", tabla " + esperadas[i]);
            return hojas + " hoja(s), " + niveles + " nivel(es), raíz tipo " + BitConverter.ToUInt16(b, raiz) + ", " + b[nivel[0] + 23] + " byte(s) por clave";
        }

        /// <summary>Decodifica una hoja comprimida de FoxPro: lista de (clave, número de registro).</summary>
        static List<Tuple<byte[], long>> LeerHoja(byte[] b, int o, int kl)
        {
            int n = BitConverter.ToUInt16(b, o + 2);
            long mRec = BitConverter.ToUInt32(b, o + 14);
            int mDup = b[o + 18], mTrail = b[o + 19], bRec = b[o + 20], bDup = b[o + 21], bytes = b[o + 23];
            var r = new List<Tuple<byte[], long>>();
            int fin = o + 512;
            byte[] previa = new byte[kl];
            for (int k = 0; k < n; k++)
            {
                long v = 0;
                for (int j = 0; j < bytes; j++) v |= (long)b[o + 24 + k * bytes + j] << (8 * j);
                long rec = v & mRec;
                int dup = (int)(v >> bRec) & mDup, trail = (int)(v >> (bRec + bDup)) & mTrail, guardados = kl - dup - trail;
                fin -= guardados;
                var c = new byte[kl];
                Array.Copy(previa, c, dup);
                Array.Copy(b, fin, c, dup, guardados);
                for (int j = kl - trail; j < kl; j++) c[j] = (byte)' ';
                r.Add(Tuple.Create(c, rec));
                previa = c;
            }
            return r;
        }
    }
}
