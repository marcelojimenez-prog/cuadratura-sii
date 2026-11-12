// Hilo que atiende las consultas al SII que pide el portal: espera pedidos (el portal mantiene la
// conexión abierta hasta que haya alguno), los ejecuta con el certificado local y devuelve las respuestas.
using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;

namespace SisgenAgente
{
    public class ConsultasSii
    {
        const int Simultaneas = 5;
        readonly Portal portal;
        readonly Sii sii;
        volatile bool detener;
        Thread hilo;

        public ConsultasSii(Portal p, Sii s) { portal = p; sii = s; }

        public void Iniciar()
        {
            hilo = new Thread(Bucle) { IsBackground = true, Name = "consultas-sii" };
            hilo.Start();
        }

        public void Detener() { detener = true; }

        void Bucle()
        {
            while (!detener)
            {
                try
                {
                    if (sii.RutNumero == null) { Thread.Sleep(5000); continue; }
                    var r = portal.Enviar("/consultas/esperar", "{\"certificado\":" + Json.Texto(sii.EstadoCertificado) + "}");
                    if (!r.Ok) { Thread.Sleep(30000); continue; }
                    var datos = JsonLector.Leer(r.Cuerpo) as Dictionary<string, object>;
                    var pedidos = datos != null && datos.ContainsKey("pedidos") ? datos["pedidos"] as List<object> : null;
                    if (pedidos == null || pedidos.Count == 0) continue; // nada que hacer: se vuelve a esperar
                    var resultados = Ejecutar(pedidos.Cast<Dictionary<string, object>>().ToList());
                    portal.Enviar("/consultas/resultado", Json.Objeto(new Dictionary<string, object> { { "resultados", resultados } }), true);
                }
                catch (Exception e)
                {
                    Log.Error("Consultas SII: " + e.Message);
                    Thread.Sleep(30000);
                }
            }
        }

        List<object> Ejecutar(List<Dictionary<string, object>> pedidos)
        {
            var resultados = new object[pedidos.Count];
            int siguiente = -1;
            var hilos = new List<Thread>();
            for (int h = 0; h < Math.Min(Simultaneas, pedidos.Count); h++)
            {
                var t = new Thread(() =>
                {
                    int k;
                    while ((k = Interlocked.Increment(ref siguiente)) < pedidos.Count)
                        resultados[k] = Uno(pedidos[k]);
                }) { IsBackground = true };
                t.Start();
                hilos.Add(t);
            }
            foreach (var t in hilos) t.Join();
            return resultados.ToList();
        }

        Dictionary<string, object> Uno(Dictionary<string, object> pedido)
        {
            var res = new Dictionary<string, object> { { "id", pedido["id"] } };
            try
            {
                var p = new Dictionary<string, string>();
                var parametros = pedido.ContainsKey("params") ? pedido["params"] as Dictionary<string, object> : null;
                if (parametros != null)
                    foreach (var kv in parametros) p[kv.Key] = kv.Value is string ? (string)kv.Value : Json.Valor(kv.Value);
                var r = sii.Ejecutar((string)pedido["tipo"], p);
                res["http"] = r.Http;
                res["cuerpo"] = r.Cuerpo;
            }
            catch (Exception e)
            {
                res["error"] = e.Message;
            }
            return res;
        }
    }
}
