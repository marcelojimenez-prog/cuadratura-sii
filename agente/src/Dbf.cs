// Lector mínimo de tablas DBF (Visual FoxPro) en modo solo lectura y compartido:
// nunca bloquea ni modifica las tablas que Sisgen y DTESERVICE están usando.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;

namespace SisgenAgente
{
    public class CampoDbf
    {
        public string Nombre;
        public char Tipo;
        public int Desplazamiento;
        public int Largo;
        public int Decimales;
    }

    public sealed class TablaDbf : IDisposable
    {
        static readonly Encoding Ansi = Encoding.GetEncoding(1252);
        readonly FileStream fs;
        public readonly int Registros;
        readonly int largoCabecera;
        readonly int largoRegistro;
        public readonly Dictionary<string, CampoDbf> Campos = new Dictionary<string, CampoDbf>(StringComparer.OrdinalIgnoreCase);

        public TablaDbf(string ruta)
        {
            fs = new FileStream(ruta, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete, 65536);
            var cab = new byte[32];
            LeerExacto(0, cab, 32);
            Registros = BitConverter.ToInt32(cab, 4);
            largoCabecera = BitConverter.ToUInt16(cab, 8);
            largoRegistro = BitConverter.ToUInt16(cab, 10);
            var desc = new byte[largoCabecera];
            LeerExacto(0, desc, largoCabecera);
            int pos = 1; // byte 0 = marca de borrado
            for (int i = 32; i + 32 <= largoCabecera && desc[i] != 0x0D; i += 32)
            {
                string nombre = Encoding.ASCII.GetString(desc, i, 11).TrimEnd('\0', ' ');
                var c = new CampoDbf { Nombre = nombre, Tipo = (char)desc[i + 11], Desplazamiento = pos, Largo = desc[i + 16], Decimales = desc[i + 17] };
                Campos[nombre] = c;
                pos += c.Largo;
            }
            // El encabezado puede quedar desactualizado mientras otro programa agrega registros
            long porTamano = (fs.Length - largoCabecera) / Math.Max(1, largoRegistro);
            if (porTamano < Registros) Registros = (int)Math.Max(0, porTamano);
        }

        void LeerExacto(long pos, byte[] buf, int n)
        {
            fs.Position = pos;
            int leidos = 0;
            while (leidos < n)
            {
                int r = fs.Read(buf, leidos, n - leidos);
                if (r <= 0) throw new EndOfStreamException("DBF truncado");
                leidos += r;
            }
        }

        /// <summary>Registro i (0 = primero), o null si está borrado.</summary>
        public RegistroDbf Leer(int i)
        {
            var buf = new byte[largoRegistro];
            LeerExacto(largoCabecera + (long)i * largoRegistro, buf, largoRegistro);
            // '*' = borrado; algo distinto de ' ' = registro dañado (frecuente tras un corte de luz)
            if (buf[0] != (byte)' ') return null;
            return new RegistroDbf(this, buf);
        }

        internal string Texto(byte[] buf, CampoDbf c)
        {
            return Ansi.GetString(buf, c.Desplazamiento, c.Largo).TrimEnd('\0', ' ').Trim();
        }

        public void Dispose() { fs.Dispose(); }
    }

    public class RegistroDbf
    {
        readonly TablaDbf tabla;
        readonly byte[] buf;
        internal RegistroDbf(TablaDbf t, byte[] b) { tabla = t; buf = b; }

        public string Texto(string campo)
        {
            CampoDbf c;
            return tabla.Campos.TryGetValue(campo, out c) ? tabla.Texto(buf, c) : "";
        }

        /// <summary>Fecha (campo D) como yyyy-MM-dd, o null.</summary>
        public string Fecha(string campo)
        {
            string t = Texto(campo);
            DateTime d;
            if (t.Length == 8 && DateTime.TryParseExact(t, "yyyyMMdd", CultureInfo.InvariantCulture, DateTimeStyles.None, out d))
                return d.ToString("yyyy-MM-dd");
            return null;
        }

        public decimal Numero(string campo)
        {
            object v = Valor(campo);
            return v is decimal ? (decimal)v : 0m;
        }

        /// <summary>Valor según el tipo del campo: texto, número (decimal), fecha (yyyy-MM-dd) o lógico.</summary>
        public object Valor(string campo)
        {
            CampoDbf c;
            if (!tabla.Campos.TryGetValue(campo, out c)) return null;
            int o = c.Desplazamiento;
            switch (c.Tipo)
            {
                case 'C': return tabla.Texto(buf, c);
                case 'N':
                case 'F':
                    {
                        decimal n;
                        string t = tabla.Texto(buf, c);
                        return decimal.TryParse(t, NumberStyles.Number, CultureInfo.InvariantCulture, out n) ? (object)n : null;
                    }
                case 'D': return Fecha(campo);
                case 'L':
                    {
                        char l = char.ToUpperInvariant((char)buf[o]);
                        return l == 'T' || l == 'Y' || l == 'S' ? (object)true : l == 'F' || l == 'N' ? (object)false : null;
                    }
                case 'I': return (decimal)BitConverter.ToInt32(buf, o);
                case 'Y': return BitConverter.ToInt64(buf, o) / 10000m;
                case 'B': return (decimal)BitConverter.ToDouble(buf, o);
                default: return null; // memo, general, binarios: no se envían
            }
        }
    }
}
