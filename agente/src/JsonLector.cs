// Lector mínimo de JSON (.NET 4 no trae uno sin librerías extra).
// Devuelve Dictionary<string,object>, List<object>, string, decimal, bool o null.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace SisgenAgente
{
    public class JsonLector
    {
        readonly string s;
        int i;
        JsonLector(string texto) { s = texto ?? ""; }

        public static object Leer(string texto)
        {
            var l = new JsonLector(texto);
            l.Espacios();
            var v = l.Valor();
            return v;
        }

        void Espacios() { while (i < s.Length && char.IsWhiteSpace(s[i])) i++; }

        object Valor()
        {
            Espacios();
            if (i >= s.Length) throw new FormatException("JSON incompleto");
            char c = s[i];
            if (c == '{') return Objeto();
            if (c == '[') return Lista();
            if (c == '"') return Texto();
            if (s.Substring(i).StartsWith("true")) { i += 4; return true; }
            if (s.Substring(i).StartsWith("false")) { i += 5; return false; }
            if (s.Substring(i).StartsWith("null")) { i += 4; return null; }
            int ini = i;
            while (i < s.Length && "+-0123456789.eE".IndexOf(s[i]) >= 0) i++;
            return decimal.Parse(s.Substring(ini, i - ini), NumberStyles.Float, CultureInfo.InvariantCulture);
        }

        Dictionary<string, object> Objeto()
        {
            var d = new Dictionary<string, object>();
            i++; Espacios();
            if (s[i] == '}') { i++; return d; }
            while (true)
            {
                Espacios();
                string k = Texto();
                Espacios();
                if (s[i] != ':') throw new FormatException("Se esperaba ':'");
                i++;
                d[k] = Valor();
                Espacios();
                if (s[i] == ',') { i++; continue; }
                if (s[i] == '}') { i++; return d; }
                throw new FormatException("Se esperaba ',' o '}'");
            }
        }

        List<object> Lista()
        {
            var l = new List<object>();
            i++; Espacios();
            if (s[i] == ']') { i++; return l; }
            while (true)
            {
                l.Add(Valor());
                Espacios();
                if (s[i] == ',') { i++; continue; }
                if (s[i] == ']') { i++; return l; }
                throw new FormatException("Se esperaba ',' o ']'");
            }
        }

        string Texto()
        {
            if (s[i] != '"') throw new FormatException("Se esperaba texto");
            i++;
            var sb = new StringBuilder();
            while (s[i] != '"')
            {
                char c = s[i++];
                if (c != '\\') { sb.Append(c); continue; }
                char e = s[i++];
                switch (e)
                {
                    case 'n': sb.Append('\n'); break;
                    case 'r': sb.Append('\r'); break;
                    case 't': sb.Append('\t'); break;
                    case 'b': sb.Append('\b'); break;
                    case 'f': sb.Append('\f'); break;
                    case 'u': sb.Append((char)Convert.ToInt32(s.Substring(i, 4), 16)); i += 4; break;
                    default: sb.Append(e); break;
                }
            }
            i++;
            return sb.ToString();
        }
    }
}
