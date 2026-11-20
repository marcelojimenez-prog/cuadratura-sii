// Aviso de folios para cada PC donde se usa Sisgen. Se abre al iniciar sesión y queda oculto; cada 10 segundos lee
// <sisgen>\procesos\folios\agente\avisos.txt (lo escribe el servicio del agente en el servidor) y, si quedan pocos
// folios, muestra una ventana encima de todo para pedir cuántos cargar. La respuesta se deja como pedido_*.txt en la
// misma carpeta; el servicio pide los folios al SII y los carga.
//
//   AvisoFolios.exe \\servidor\sisgen [\\servidor\sisgen2 ...]     (o carpetas en avisofolios.ini: sisgen=...)
using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace AvisoFolios
{
    static class Programa
    {
        static readonly Dictionary<string, DateTime> pospuestos = new Dictionary<string, DateTime>();
        static readonly Dictionary<string, Form> abiertos = new Dictionary<string, Form>();
        internal static readonly HashSet<string> mensajesVistos = new HashSet<string>();

        /// <summary>Líneas de avisos.txt de una carpeta de Sisgen (vacío si no se puede leer).</summary>
        internal static List<string> LeerLineas(string carpeta)
        {
            try
            {
                string f = Path.Combine(carpeta, "procesos", "folios", "agente", "avisos.txt");
                if (!File.Exists(f)) return new List<string>();
                using (var fs = new FileStream(f, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
                using (var r = new StreamReader(fs, Encoding.UTF8)) return r.ReadToEnd().Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries).ToList();
            }
            catch { return new List<string>(); }
        }
        static readonly DateTime inicio = DateTime.Now;
        static List<string> carpetas;

        [STAThread]
        static void Main(string[] args)
        {
            bool nuevo;
            if (args.Any(x => x.Equals("--demo", StringComparison.OrdinalIgnoreCase))) { Demo(); return; }
            using (var unico = new Mutex(true, "Local\\AvisoFoliosSisgen", out nuevo))
            {
                if (!nuevo) return;
                carpetas = args.Where(a => !a.StartsWith("-")).ToList();
                string ini = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "avisofolios.ini");
                if (carpetas.Count == 0 && File.Exists(ini))
                    carpetas = File.ReadAllLines(ini).Select(l => l.Trim()).Where(l => l.StartsWith("sisgen=", StringComparison.OrdinalIgnoreCase))
                                   .Select(l => l.Substring(7).Trim()).Where(l => l.Length > 0).ToList();
                // Abierto desde <sisgen>\procesos\folios\agente\ (por la red): la carpeta de Sisgen es la de arriba,
                // y queda activado al iniciar sesión en este equipo
                string propia = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');
                if (carpetas.Count == 0 && propia.EndsWith(@"\procesos\folios\agente", StringComparison.OrdinalIgnoreCase))
                {
                    carpetas.Add(propia.Substring(0, propia.Length - @"\procesos\folios\agente".Length));
                    try
                    {
                        string exe = "\"" + Application.ExecutablePath + "\"";
                        using (var run = Microsoft.Win32.Registry.CurrentUser.CreateSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run"))
                            if (!exe.Equals(run.GetValue("AvisoFoliosSisgen") as string, StringComparison.OrdinalIgnoreCase))
                            {
                                run.SetValue("AvisoFoliosSisgen", exe);
                                MessageBox.Show("Aviso de folios activado en este equipo para:\n" + carpetas[0] +
                                                "\n\nSe abrirá solo cada vez que inicies sesión.", "Aviso de folios", MessageBoxButtons.OK, MessageBoxIcon.Information);
                            }
                    }
                    catch { }
                }
                if (carpetas.Count == 0) { MessageBox.Show("Indique la carpeta de Sisgen en avisofolios.ini (sisgen=\\\\servidor\\sisgen).", "Aviso de folios"); return; }
                Application.EnableVisualStyles();
                var t = new System.Windows.Forms.Timer { Interval = 10000 };
                t.Tick += (s, e) => Revisar();
                t.Start();
                Revisar();
                Application.Run();
            }
        }

        /// <summary>Muestra ventanas de ejemplo (no lee ni escribe nada): AvisoFolios.exe --demo</summary>
        static void Demo()
        {
            Application.EnableVisualStyles();
            var ventanas = new List<Form> {
                new VentanaAviso(new Aviso { Sucursal = "WALKER MARTINEZ 1346", Id = "demo1", Tipo = "39", Nombre = "Boleta", Quedan = 2 }),
                new VentanaAviso(new Aviso { Sucursal = "PLAZA VESPUCIO", Id = "demo2", Tipo = "33", Nombre = "Factura", Quedan = 1, Maximo = 200, Vence = true, Critico = true }),
                new VentanaMensaje("WALKER MARTINEZ 1346", "Boleta: se cargaron los folios 166 al 215 (pedido por caja 1). Recuerda cerrar y volver a abrir la pantalla de ventas."),
                new VentanaMensaje("PLAZA VESPUCIO", "Nota de crédito: quedan 0 folios y no se pudieron cargar solos. Llame a soporte."),
                new VentanaEspera(new Aviso { Sucursal = "WALKER MARTINEZ 1346", Id = "demo3", Tipo = "39", Nombre = "Boleta" }, 500, new HashSet<string>()) };
            int x = 20, y = 20;
            foreach (var v in ventanas)
            {
                v.StartPosition = FormStartPosition.Manual;
                v.Location = new Point(x, y);
                x += 520; if (x > 1000) { x = 20; y += 330; }
                v.FormClosed += (s, e) => { if (Application.OpenForms.Count == 0) Application.ExitThread(); };
                v.Show();
            }
            Application.Run();
        }

        static void Revisar()
        {
            foreach (var c in carpetas)
            {
                List<string> lineas;
                try
                {
                    string f = Path.Combine(c, "procesos", "folios", "agente", "avisos.txt");
                    if (!File.Exists(f)) continue;
                    using (var fs = new FileStream(f, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
                    using (var r = new StreamReader(fs, Encoding.UTF8)) lineas = r.ReadToEnd().Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries).ToList();
                }
                catch { continue; }
                var vigentes = new HashSet<string>();
                string sucursal = c;
                foreach (var l in lineas)
                {
                    var p = l.Split('|');
                    if (p[0].TrimStart('﻿') == "sucursal" && p.Length >= 2) sucursal = p[1];
                    else if (p[0] == "aviso" && p.Length >= 9)
                    {
                        var a = new Aviso { Carpeta = c, Sucursal = sucursal, Id = p[1], Tipo = p[2], Nombre = p[3], Quedan = long.Parse(p[4]), Maximo = long.Parse(p[6]), Vence = p[7] == "vence", Critico = p[8] == "critico" };
                        string clave = c + "|" + a.Id;
                        vigentes.Add(clave);
                        DateTime hasta;
                        if (abiertos.ContainsKey(clave) || (pospuestos.TryGetValue(clave, out hasta) && hasta > DateTime.Now)) continue;
                        var v = new VentanaAviso(a);
                        v.FormClosed += (s, e) => { abiertos.Remove(clave); pospuestos[clave] = DateTime.Now.AddMinutes(v.MinutosPosponer); };
                        abiertos[clave] = v;
                        v.Show();
                        v.Activate();
                    }
                    else if (p[0] == "mensaje" && p.Length >= 3)
                    {
                        DateTime cuando;
                        if (!DateTime.TryParseExact(p[1], "yyyyMMddHHmmss", null, System.Globalization.DateTimeStyles.None, out cuando) || cuando < inicio) continue;
                        if (!mensajesVistos.Add(c + "|" + p[1] + "|" + p[2])) continue;
                        new VentanaMensaje(sucursal, p[2]).Show();
                    }
                }
                // Avisos que ya no están (otro PC cargó los folios): se cierran
                foreach (var k in abiertos.Keys.Where(k => k.StartsWith(c + "|") && !vigentes.Contains(k)).ToList())
                {
                    var f = abiertos[k];
                    abiertos.Remove(k);
                    ((VentanaAviso)f).CerrarSinPosponer();
                }
            }
        }
    }

    class Aviso
    {
        public string Carpeta, Sucursal, Id, Tipo, Nombre;
        public long Quedan, Maximo;
        public bool Vence, Critico;
    }

    /// <summary>
    /// Ventana con el aspecto estándar de Windows (como los mensajes del sistema): ícono del sistema a la izquierda,
    /// textos a la derecha y botones abajo en la franja gris. Aparece al centro de la pantalla y encima de todo.
    /// </summary>
    class Ventana : Form
    {
        protected readonly FlowLayoutPanel cuerpo, botones;
        protected const int AnchoTexto = 380;

        public Ventana(Icon icono, string sucursal)
        {
            Text = "Aviso de folios" + (string.IsNullOrEmpty(sucursal) ? "" : " - " + sucursal);
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = MinimizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;
            TopMost = true;
            ShowInTaskbar = true;
            Icon = icono;
            Font = SystemFonts.MessageBoxFont;
            BackColor = SystemColors.Window;
            AutoSize = true;
            AutoSizeMode = AutoSizeMode.GrowAndShrink;

            var raiz = new TableLayoutPanel { ColumnCount = 1, AutoSize = true, Dock = DockStyle.Fill, Margin = new Padding(0) };

            var arriba = new FlowLayoutPanel { FlowDirection = FlowDirection.LeftToRight, AutoSize = true, WrapContents = false, Padding = new Padding(22, 22, 26, 14),
                                               Margin = new Padding(0), BackColor = SystemColors.Window };
            // Ícono del tamaño que corresponde a la escala de la pantalla (125 %, 150 %…), completo y centrado
            int lado = 32;
            using (var g = CreateGraphics()) lado = (int)Math.Round(32 * g.DpiX / 96f);
            Bitmap imagen;
            try { imagen = new Icon(icono, lado, lado).ToBitmap(); } catch { imagen = icono.ToBitmap(); }
            arriba.Controls.Add(new PictureBox { Image = imagen, Size = new Size(lado, lado), SizeMode = PictureBoxSizeMode.Zoom, Margin = new Padding(0, 2, 16, 0) });
            cuerpo = new FlowLayoutPanel { FlowDirection = FlowDirection.TopDown, WrapContents = false, AutoSize = true, Margin = new Padding(0), BackColor = SystemColors.Window };
            arriba.Controls.Add(cuerpo);
            raiz.Controls.Add(arriba);

            botones = new FlowLayoutPanel { FlowDirection = FlowDirection.RightToLeft, AutoSize = false, Dock = DockStyle.Fill, Height = 50,
                                            Padding = new Padding(0, 12, 12, 0), Margin = new Padding(0), BackColor = SystemColors.Control };
            raiz.Controls.Add(botones);
            Controls.Add(raiz);
            // Sonido de Windows según el tipo de aviso (los clientes suelen tener parlantes)
            var sonido = icono == SystemIcons.Error ? System.Media.SystemSounds.Hand
                       : icono == SystemIcons.Warning ? System.Media.SystemSounds.Exclamation : System.Media.SystemSounds.Asterisk;
            Shown += (s, e) => { botones.Width = raiz.Width; Activate(); try { sonido.Play(); } catch { } };
        }

        /// <summary>Repite el sonido cada cierto tiempo mientras la ventana siga abierta (aviso crítico).</summary>
        protected void RepetirSonido(int segundos)
        {
            var t = new System.Windows.Forms.Timer { Interval = segundos * 1000 };
            t.Tick += (s, e) => { try { System.Media.SystemSounds.Exclamation.Play(); } catch { } };
            Shown += (s, e) => t.Start();
            FormClosed += (s, e) => { t.Stop(); t.Dispose(); };
        }

        protected Label Linea(string texto, bool destacado = false, int abajo = 6)
        {
            var l = new Label { Text = texto, AutoSize = true, MaximumSize = new Size(AnchoTexto, 0), Margin = new Padding(0, 0, 0, abajo),
                                Font = destacado ? new Font(SystemFonts.MessageBoxFont.FontFamily, 12F, FontStyle.Regular) : SystemFonts.MessageBoxFont,
                                ForeColor = destacado ? Color.FromArgb(0x00, 0x33, 0x99) : SystemColors.WindowText };
            cuerpo.Controls.Add(l);
            return l;
        }

        protected Button Boton(string texto, EventHandler clic)
        {
            var b = new Button { Text = texto, MinimumSize = new Size(96, 28), AutoSize = true, Margin = new Padding(8, 0, 0, 0), UseVisualStyleBackColor = true };
            b.Click += clic;
            botones.Controls.Add(b);
            return b;
        }
    }

    class VentanaAviso : Ventana
    {
        readonly Aviso a;
        readonly TextBox cantidad;
        public int MinutosPosponer;

        public VentanaAviso(Aviso aviso) : base(SystemIcons.Warning, aviso.Sucursal)
        {
            a = aviso;
            MinutosPosponer = a.Critico ? 1 : 2;
            if (a.Critico) RepetirSonido(30);

            Linea(a.Nombre + ": " + (a.Quedan == 1 ? "te queda 1 folio." : "te quedan " + a.Quedan.ToString("N0") + " folios."), true, 10);
            Linea("Sucursal: " + a.Sucursal, false, 2);
            Linea("No tienes otro rango cargado.", false, 2);
            Linea(a.Vence ? (a.Maximo > 0 ? "El SII te autoriza hasta " + a.Maximo.ToString("N0") + " folios." : "No se pudo consultar cuántos folios autoriza el SII.")
                          : "Sin límite de cantidad en el SII.", false, 12);

            var fila = new FlowLayoutPanel { FlowDirection = FlowDirection.LeftToRight, AutoSize = true, WrapContents = false, Margin = new Padding(0, 0, 0, 6) };
            fila.Controls.Add(new Label { Text = "¿Cuántos quieres cargar?", AutoSize = true, Margin = new Padding(0, 5, 10, 0) });
            cantidad = new TextBox { Width = 110, TextAlign = HorizontalAlignment.Right };
            cantidad.KeyPress += (s, e) => { if (!char.IsDigit(e.KeyChar) && !char.IsControl(e.KeyChar)) e.Handled = true; };
            fila.Controls.Add(cantidad);
            cuerpo.Controls.Add(fila);
            if (a.Vence) Linea("Recuerda que los folios de " + a.Nombre.ToLower() + " vencen en 6 meses.", false, 2);

            // RightToLeft: el primero queda a la derecha
            Boton("Más tarde", (s, e) => Close());
            var cargar = Boton("Cargar", (s, e) => Cargar());
            AcceptButton = cargar;
            Shown += (s, e) => cantidad.Focus();
        }

        void Cargar()
        {
            long n;
            if (!long.TryParse(cantidad.Text, out n) || n < 1) { MessageBox.Show(this, "Escribe cuántos folios quieres cargar.", "Aviso de folios", MessageBoxButtons.OK, MessageBoxIcon.Warning); return; }
            if (a.Vence && a.Maximo > 0 && n > a.Maximo) { MessageBox.Show(this, "El SII autoriza hasta " + a.Maximo.ToString("N0") + " folios.", "Aviso de folios", MessageBoxButtons.OK, MessageBoxIcon.Warning); return; }
            // Mensajes que ya existían antes del pedido (el resultado será uno nuevo; no depende del reloj de cada equipo)
            var antes = a.Carpeta == null ? new HashSet<string>() : new HashSet<string>(Programa.LeerLineas(a.Carpeta).Where(l => l.StartsWith("mensaje|")));
            if (a.Carpeta != null)
            {
                try
                {
                    string dir = Path.Combine(a.Carpeta, "procesos", "folios", "agente");
                    string archivo = Path.Combine(dir, "pedido_" + a.Id + "_" + Environment.MachineName + "_" + DateTime.Now.Ticks + ".txt");
                    File.WriteAllLines(archivo, new[] { "tipo=" + a.Tipo, "cantidad=" + n, "usuario=" + Environment.UserName, "equipo=" + Environment.MachineName, "aviso=" + a.Id }, Encoding.UTF8);
                }
                catch (Exception ex) { MessageBox.Show(this, "No se pudo enviar el pedido: " + ex.Message, "Aviso de folios", MessageBoxButtons.OK, MessageBoxIcon.Error); return; }
            }
            MinutosPosponer = 5;
            Close();
            new VentanaEspera(a, n, antes).Show();
        }

        public void CerrarSinPosponer() { MinutosPosponer = 0; Close(); }
    }

    /// <summary>
    /// "Cargando folios…": no se puede cerrar hasta que el servidor responde (folios cargados o error).
    /// Si en 3 minutos no hay respuesta, avisa y deja cerrarla (por ejemplo, si el servicio está detenido).
    /// </summary>
    class VentanaEspera : Ventana
    {
        readonly Aviso a;
        readonly HashSet<string> antes;
        readonly DateTime inicio = DateTime.Now;
        readonly System.Windows.Forms.Timer revisar = new System.Windows.Forms.Timer { Interval = 2000 };
        readonly Label detalle;
        readonly ProgressBar barra;
        bool puedeCerrar;

        public VentanaEspera(Aviso aviso, long cantidad, HashSet<string> mensajesAntes) : base(SystemIcons.Information, aviso.Sucursal)
        {
            a = aviso;
            antes = mensajesAntes;
            ControlBox = false; // sin X
            Linea("Cargando " + cantidad.ToString("N0") + " folios de " + a.Nombre.ToLower() + "…", true, 10);
            Linea("Sucursal: " + a.Sucursal, false, 2);
            detalle = Linea("Se están pidiendo al SII y cargando en Sisgen. Por favor espera, no cierres esta ventana.", false, 12);
            barra = new ProgressBar { Style = ProgressBarStyle.Marquee, MarqueeAnimationSpeed = 30, Width = AnchoTexto, Height = 18, Margin = new Padding(0, 0, 0, 6) };
            cuerpo.Controls.Add(barra);
            FormClosing += (s, e) => { if (!puedeCerrar && e.CloseReason == CloseReason.UserClosing) e.Cancel = true; };
            revisar.Tick += (s, e) => Revisar();
            Shown += (s, e) => revisar.Start();
            FormClosed += (s, e) => revisar.Dispose();
        }

        void Revisar()
        {
            if (a.Carpeta == null) return;
            foreach (var l in Programa.LeerLineas(a.Carpeta))
            {
                if (!l.StartsWith("mensaje|") || antes.Contains(l)) continue;
                var p = l.Split('|');
                if (p.Length < 3) continue;
                // El resultado de este pedido: un mensaje nuevo de este documento, o de error
                if (!p[2].StartsWith(a.Nombre + ":") && !p[2].StartsWith("No se pudieron")) continue;
                revisar.Stop();
                puedeCerrar = true;
                Close();
                if (Programa.mensajesVistos.Add(a.Carpeta + "|" + p[1] + "|" + p[2])) new VentanaMensaje(a.Sucursal, p[2]).Show();
                return;
            }
            if ((DateTime.Now - inicio).TotalMinutes >= 3 && !puedeCerrar)
            {
                revisar.Stop();
                puedeCerrar = true;
                barra.Visible = false;
                detalle.Text = "El servidor no respondió en 3 minutos. Revisa que el equipo servidor esté encendido o llama a soporte.";
                AcceptButton = Boton("Aceptar", (s, e) => Close());
            }
        }
    }

    class VentanaMensaje : Ventana
    {
        const string Recordatorio = "Recuerda cerrar y volver a abrir la pantalla de ventas.";
        static bool EsError(string t) { return t.IndexOf("soporte", StringComparison.OrdinalIgnoreCase) >= 0 || t.IndexOf("No se pudieron", StringComparison.OrdinalIgnoreCase) >= 0; }

        public VentanaMensaje(string sucursal, string texto, bool enCurso = false)
            : base(EsError(texto) ? SystemIcons.Error : SystemIcons.Information, sucursal)
        {
            bool conRecordatorio = texto.Contains(Recordatorio);
            Linea(EsError(texto) ? "No se pudieron cargar los folios" : enCurso ? "Pedido enviado"
                  : texto.Contains("asign") ? "Folios asignados" : "Folios cargados", true, 10);
            Linea("Sucursal: " + sucursal, false, 2);
            Linea(texto.Replace(Recordatorio, "").Trim(), false, conRecordatorio ? 10 : 4);
            if (conRecordatorio) Linea("Cierra y vuelve a abrir la pantalla de ventas de Sisgen para ver los folios nuevos.", false, 4);
            AcceptButton = Boton("Aceptar", (s, e) => Close());
            var t = new System.Windows.Forms.Timer { Interval = 120000 };
            t.Tick += (s, e) => { t.Stop(); Close(); };
            t.Start();
        }
    }
}
