// Revisión de una carpeta de Sisgen antes de activar los folios (la usa el instalador). SOLO LEE: las pruebas de
// escritura se hacen sobre una copia temporal de las tablas, nunca sobre las del cliente.
//   - que se puedan leer prmsis, correlat y folios, y cuántos folios quedan de cada documento
//   - que correlat tenga un solo registro (los correlativos por caja aún no se manejan)
//   - que el índice folios.cdx tenga una forma que el agente sabe actualizar (se simula agregar un CAF en la copia)
//   - que haya certificado en procesos\certificado
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;

namespace SisgenAgente
{
    public class ResultadoRevision
    {
        public bool Ok;          // false = impide activar los folios
        public string Texto;
        public override string ToString() { return (Ok ? "✓ " : "✗ ") + Texto; }
    }

    public static class RevisionCliente
    {
        public static List<ResultadoRevision> Revisar(string carpetaSisgen)
        {
            var r = new List<ResultadoRevision>();
            Action<bool, string> anotar = (ok, t) => r.Add(new ResultadoRevision { Ok = ok, Texto = t });
            string datos = Path.Combine(carpetaSisgen, "datos");

            // 1) Estado de folios (lectura de prmsis, correlat y folios)
            try
            {
                var estados = Folios.Calcular(datos, DateTime.Today);
                anotar(true, "Tablas de folios leídas: " + (estados.Count == 0 ? "sin documentos con folios" :
                    string.Join(", ", estados.Select(e => e.Tipo.Nombre + " quedan " + e.Quedan.ToString("N0")))));
            }
            catch (Exception e) { anotar(false, "No se pudieron leer las tablas de folios: " + e.Message); return r; }

            string rFolios = Ventas.Buscar(datos, "folios.dbf"), rCor = Ventas.Buscar(datos, "correlat.dbf");

            // 2) Correlativos por caja
            try
            {
                using (var fs = new FileStream(rCor, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
                {
                    var cor = new Dbf(fs);
                    int vigentes = Enumerable.Range(0, cor.Registros).Count(i => !cor.Borrado(i));
                    if (vigentes == 1) anotar(true, "Correlativos: uno solo para la sucursal");
                    else anotar(false, "correlat.dbf tiene " + vigentes + " correlativos (por caja o bodega): el agente aún no los maneja");
                }
            }
            catch (Exception e) { anotar(false, "No se pudo revisar correlat.dbf: " + e.Message); }

            // 3) Índice de folios: se simula agregar un CAF en una copia temporal
            string temp = Path.Combine(Path.GetTempPath(), "revision_folios_" + Guid.NewGuid().ToString("N"));
            try
            {
                string rCdx = rFolios == null ? null : Path.ChangeExtension(rFolios, ".cdx");
                if (rFolios == null) anotar(false, "No está folios.dbf");
                else if (!File.Exists(rCdx)) anotar(true, "folios.dbf sin índice .cdx (no hay que actualizarlo)");
                else
                {
                    Directory.CreateDirectory(temp);
                    string tDbf = Path.Combine(temp, "folios.dbf"), tCdx = Path.Combine(temp, "folios.cdx");
                    Copiar(rFolios, tDbf); Copiar(rCdx, tCdx);
                    using (var fd = new FileStream(tDbf, FileMode.Open, FileAccess.ReadWrite))
                    using (var fc = new FileStream(tCdx, FileMode.Open, FileAccess.ReadWrite))
                    {
                        var tabla = new Dbf(fd);
                        IndiceCdx.Agregar(fc, tabla, "TIPODOCU", "39");
                        anotar(true, "Índice de folios: el agente lo puede actualizar (" + tabla.Registros + " CAF cargados)");
                    }
                }
            }
            catch (Exception e) { anotar(false, "Índice de folios (folios.cdx): " + e.Message); }
            finally { try { if (Directory.Exists(temp)) Directory.Delete(temp, true); } catch { } }

            // 4) Certificado
            try
            {
                string dir = Path.Combine(carpetaSisgen, "procesos", "certificado");
                int n = Directory.Exists(dir) ? Directory.GetFiles(dir, "*.pfx").Length + Directory.GetFiles(dir, "*.p12").Length : 0;
                if (n > 0) anotar(true, "Certificado: " + n + " archivo(s) en procesos\\certificado");
                else anotar(false, "No hay certificado (.pfx) en procesos\\certificado: no se podrán pedir folios al SII");
            }
            catch (Exception e) { anotar(false, "No se pudo revisar el certificado: " + e.Message); }
            return r;
        }

        /// <summary>Copia aunque Sisgen tenga la tabla abierta (lectura compartida).</summary>
        static void Copiar(string origen, string destino)
        {
            using (var a = new FileStream(origen, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
            using (var b = new FileStream(destino, FileMode.Create, FileAccess.Write)) a.CopyTo(b);
        }
    }
}
