// Instalador del Agente Sisgen: un solo .exe con pasos sencillos (Siguiente / Instalar).
// Lleva dentro SisgenAgente.exe; lo copia a Archivos de programa, crea agente.ini, registra el
// servicio de Windows y lo inicia. Si ya está instalado, permite actualizarlo o desinstalarlo.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Reflection;
using System.ServiceProcess;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace SisgenAgente
{
    public static class Instalador
    {
        public const string PortalPorDefecto = "https://fb6z02tn-4100.brs.devtunnels.ms";
        public const string Servicio = "SisgenAgente";
        public static readonly string Destino = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "SisgenAgente");

        [STAThread]
        public static void Main()
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new Asistente());
        }

        public static bool Instalado()
        {
            return ServiceController.GetServices().Any(s => s.ServiceName == Servicio);
        }

        public static string Sc(string args)
        {
            var p = Process.Start(new ProcessStartInfo("sc.exe", args)
            {
                UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true
            });
            string salida = p.StandardOutput.ReadToEnd() + p.StandardError.ReadToEnd();
            p.WaitForExit();
            return salida;
        }

        public static void DetenerServicio()
        {
            try
            {
                using (var s = new ServiceController(Servicio))
                    if (s.Status != ServiceControllerStatus.Stopped)
                    {
                        s.Stop();
                        s.WaitForStatus(ServiceControllerStatus.Stopped, TimeSpan.FromSeconds(30));
                    }
            }
            catch (InvalidOperationException) { } // no existe
        }

        /// <summary>
        /// Instalaciones de Sisgen del equipo, reconocidas por su contenido y no por el nombre de la
        /// carpeta (varía entre clientes): una carpeta "procesos" y una o más carpetas "datos*" con empres.dbf.
        /// Se buscan en la raíz de cada disco y un nivel más abajo.
        /// </summary>
        public static List<Candidato> CarpetasSisgen()
        {
            var lista = new List<Candidato>();
            foreach (var u in DriveInfo.GetDrives().Where(d => d.DriveType == DriveType.Fixed && d.IsReady))
            {
                foreach (var nivel1 in Subcarpetas(u.RootDirectory.FullName))
                {
                    lista.AddRange(Candidatos(nivel1));
                    string n = Path.GetFileName(nivel1).ToLowerInvariant();
                    if (n == "windows" || n.StartsWith("$") || n == "programdata" || n == "users") continue;
                    foreach (var nivel2 in Subcarpetas(nivel1)) lista.AddRange(Candidatos(nivel2));
                }
            }
            // Primero la instalación en uso: no un respaldo/copia y con ventas más recientes (tabla F1 del último mes).
            // Antes se elegía la primera en orden alfabético, y "C:\BackUP\sisgen…" quedaba antes que "C:\SisGen".
            return lista.OrderBy(c => c.EsRespaldo).ThenByDescending(c => c.UltimaVenta).ToList();
        }

        /// <summary>Si la carpeta es una instalación de Sisgen, sus carpetas de datos (una por razón social).</summary>
        public static List<Candidato> Candidatos(string raiz)
        {
            var r = new List<Candidato>();
            var subs = Subcarpetas(raiz);
            if (!subs.Any(s => Path.GetFileName(s).Equals("procesos", StringComparison.OrdinalIgnoreCase))) return r;
            foreach (var s in subs.Where(s => Path.GetFileName(s).StartsWith("datos", StringComparison.OrdinalIgnoreCase))
                                  .OrderBy(s => Path.GetFileName(s).Length))
                if (File.Exists(Path.Combine(s, "empres.dbf"))) r.Add(new Candidato { Raiz = raiz, Datos = s });
            return r;
        }

        static string[] Subcarpetas(string dir)
        {
            try { return Directory.GetDirectories(dir); } catch { return new string[0]; }
        }

        public static byte[] AgenteIncluido()
        {
            using (var s = Assembly.GetExecutingAssembly().GetManifestResourceStream("SisgenAgente.exe"))
            using (var ms = new MemoryStream())
            {
                s.CopyTo(ms);
                return ms.ToArray();
            }
        }
    }

    public class Candidato
    {
        public string Raiz, Datos;
        DateTime? ultima;

        /// <summary>Fecha de la tabla de ventas (F1MMAAAA.dbf) modificada más recientemente.</summary>
        public DateTime UltimaVenta
        {
            get
            {
                if (ultima == null)
                {
                    try { ultima = new DirectoryInfo(Datos).GetFiles("F1*.dbf").Select(f => f.LastWriteTime).DefaultIfEmpty(DateTime.MinValue).Max(); }
                    catch { ultima = DateTime.MinValue; }
                }
                return ultima.Value;
            }
        }

        /// <summary>Carpeta que parece un respaldo o copia (backup, respaldo, copia, old…).</summary>
        public bool EsRespaldo
        {
            get { return System.Text.RegularExpressions.Regex.IsMatch(Raiz, @"back\s*up|respaldo|copia|\bold\b|antiguo|\d{2}-\d{2}-\d{2}", System.Text.RegularExpressions.RegexOptions.IgnoreCase); }
        }

        public override string ToString()
        {
            string d = Path.GetFileName(Datos);
            string s = d.Equals("datos", StringComparison.OrdinalIgnoreCase) ? Raiz : Raiz + "   (datos: " + d + ")";
            if (UltimaVenta > DateTime.MinValue) s += "   · ventas al " + UltimaVenta.ToString("dd-MM-yyyy");
            if (EsRespaldo) s += "   · RESPALDO";
            return s;
        }
    }

    public class Asistente : Form
    {
        static readonly Color Negro = Color.FromArgb(0x1D, 0x1D, 0x1B), Azul = Color.FromArgb(0x36, 0x97, 0xD9),
                              Celeste = Color.FromArgb(0xE9, 0xF1, 0xFB), Gris = Color.FromArgb(0x77, 0x77, 0x7B);
        readonly Panel cuerpo = new Panel { Dock = DockStyle.Fill, Padding = new Padding(28, 16, 28, 8), BackColor = Color.White };
        readonly Button atras = new Button { Text = "< Atrás", Width = 95, Height = 30 };
        readonly Button siguiente = new Button { Text = "Siguiente >", Width = 110, Height = 30 };
        readonly Button cancelar = new Button { Text = "Cancelar", Width = 95, Height = 30 };
        int paso;
        bool actualizar;

        // Datos que se van completando
        Candidato candidato;
        string llave, portal = Instalador.PortalPorDefecto, conectadoComo;
        Dictionary<string, object> empresa;

        // Controles de cada paso
        ComboBox cboCarpeta;
        TextBox txtLlave, txtPortal;
        Label lblEmpresa, lblEstado;
        TextBox txtProgreso;

        public Asistente()
        {
            Text = "Instalar Agente Sisgen " + Program.Version;
            Size = new Size(640, 470);
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;
            Font = new Font("Segoe UI", 9.5f);
            BackColor = Color.White;

            var cabecera = new Panel { Dock = DockStyle.Top, Height = 74, BackColor = Celeste };
            var logo = CargarLogo();
            if (logo != null)
                cabecera.Controls.Add(new PictureBox { Image = logo, SizeMode = PictureBoxSizeMode.Zoom, Bounds = new Rectangle(20, 10, 105, 54) });
            cabecera.Controls.Add(new Label { Text = "Portal Sisgen", Font = new Font("Segoe UI Semibold", 14f), ForeColor = Negro, AutoSize = true, Location = new Point(140, 12) });
            cabecera.Controls.Add(new Label { Text = "Agente de la sucursal · envía las ventas al portal en línea", ForeColor = Gris, AutoSize = true, Location = new Point(142, 42) });

            var pie = new Panel { Dock = DockStyle.Bottom, Height = 52, BackColor = Color.FromArgb(0xF1, 0xF3, 0xF4) };
            cancelar.Location = new Point(510, 11);
            siguiente.Location = new Point(390, 11);
            atras.Location = new Point(290, 11);
            pie.Controls.AddRange(new Control[] { atras, siguiente, cancelar });
            siguiente.BackColor = Azul; siguiente.ForeColor = Color.White; siguiente.FlatStyle = FlatStyle.Flat; siguiente.FlatAppearance.BorderSize = 0;

            Controls.Add(cuerpo);
            Controls.Add(pie);
            Controls.Add(cabecera);
            AcceptButton = siguiente;
            cancelar.Click += (s, e) => Close();
            atras.Click += (s, e) => Mostrar(paso == 3 && actualizar ? 0 : paso - 1);
            siguiente.Click += (s, e) => Avanzar();
            Mostrar(0);
        }

        static Image CargarLogo()
        {
            try
            {
                var s = Assembly.GetExecutingAssembly().GetManifestResourceStream("logo.png");
                return s == null ? null : Image.FromStream(s);
            }
            catch { return null; }
        }

        Label Titulo(string t) { return new Label { Text = t, Font = new Font("Segoe UI Semibold", 12.5f), ForeColor = Negro, AutoSize = true }; }
        Label Texto(string t, int alto = 40) { return new Label { Text = t, ForeColor = Color.FromArgb(60, 60, 60), Width = 570, Height = alto }; }

        void Poner(params Control[] controles)
        {
            cuerpo.Controls.Clear();
            int y = 8;
            foreach (var c in controles)
            {
                c.Location = new Point(28, y);
                cuerpo.Controls.Add(c);
                y += c.Height + 10;
            }
        }

        // ---------- Pasos ----------
        void Mostrar(int n)
        {
            paso = n;
            atras.Visible = n > 0 && n < 4;
            siguiente.Enabled = true;
            cancelar.Text = "Cancelar";
            switch (n)
            {
                case 0: PasoBienvenida(); break;
                case 1: PasoCarpeta(); break;
                case 2: PasoLlave(); break;
                case 3: PasoConfirmar(); break;
                case 4: PasoInstalar(); break;
            }
        }

        void PasoBienvenida()
        {
            if (Instalador.Instalado())
            {
                var rbAct = new RadioButton { Text = "Actualizar el agente (mantiene la configuración actual)", Width = 560, Checked = true };
                var rbDes = new RadioButton { Text = "Desinstalar el agente de este equipo", Width = 560 };
                Poner(Titulo("El Agente Sisgen ya está instalado"),
                      Texto("¿Qué quieres hacer?", 26), rbAct, rbDes);
                siguiente.Text = "Siguiente >";
                siguiente.Tag = new Func<bool>(() =>
                {
                    if (rbDes.Checked) { Desinstalar(); return false; }
                    actualizar = true;
                    return true;
                });
                return;
            }
            Poner(Titulo("Bienvenido"),
                  Texto("Este asistente instala el Agente Sisgen como servicio de Windows. Desde ese momento, cada documento " +
                        "que emita esta sucursal se envía al Portal Sisgen junto con su estado en el SII.", 60),
                  Texto("El agente solo LEE la información de Sisgen: no modifica nada ni interfiere con DTESERVICE.", 40),
                  Texto("Necesitas la llave de instalación que se genera en el portal (ficha del cliente → \"Instalar agente en un servidor nuevo\").", 44));
            siguiente.Text = "Siguiente >";
            siguiente.Tag = null;
        }

        void PasoCarpeta()
        {
            cboCarpeta = new ComboBox { Width = 440, DropDownStyle = ComboBoxStyle.DropDownList };
            var buscar = new Button { Text = "Otra carpeta…", Width = 110, Height = 28 };
            var fila = new Panel { Width = 570, Height = 30 };
            fila.Controls.Add(cboCarpeta); buscar.Location = new Point(450, 0); fila.Controls.Add(buscar);
            lblEmpresa = Texto("", 50);
            lblEmpresa.ForeColor = Azul;
            Cursor = Cursors.WaitCursor;
            foreach (var c in Instalador.CarpetasSisgen()) cboCarpeta.Items.Add(c);
            Cursor = Cursors.Default;
            if (candidato != null)
            {
                var igual = cboCarpeta.Items.Cast<Candidato>().FirstOrDefault(c => c.Datos == candidato.Datos);
                if (igual == null) cboCarpeta.Items.Add(igual = candidato);
                cboCarpeta.SelectedItem = igual;
            }
            else if (cboCarpeta.Items.Count > 0) cboCarpeta.SelectedIndex = 0;
            buscar.Click += (s, e) =>
            {
                using (var d = new FolderBrowserDialog { Description = "Elige la carpeta de Sisgen (la que contiene \"procesos\" y \"datos\"), o directamente su carpeta de datos" })
                {
                    if (d.ShowDialog(this) != DialogResult.OK) return;
                    var encontrados = Instalador.Candidatos(d.SelectedPath);
                    // También se acepta elegir directamente la carpeta de datos
                    if (encontrados.Count == 0 && File.Exists(Path.Combine(d.SelectedPath, "empres.dbf")))
                        encontrados.Add(new Candidato { Raiz = Path.GetDirectoryName(d.SelectedPath), Datos = d.SelectedPath });
                    if (encontrados.Count == 0) { Aviso("En esa carpeta no hay una instalación de Sisgen (falta \"procesos\" o \"datos\\empres.dbf\")."); return; }
                    foreach (var c in encontrados) cboCarpeta.Items.Add(c);
                    cboCarpeta.SelectedItem = encontrados[0];
                }
            };
            cboCarpeta.SelectedIndexChanged += (s, e) => LeerEmpresa();
            Poner(Titulo("Carpeta de Sisgen"),
                  Texto(cboCarpeta.Items.Count == 0
                      ? "No se encontró Sisgen automáticamente. Presiona \"Otra carpeta…\" y elige la carpeta donde está instalado."
                      : "Se encontró Sisgen en este equipo. Revisa que la razón social y la sucursal sean las correctas.", 40),
                  fila, lblEmpresa);
            LeerEmpresa();
            siguiente.Tag = new Func<bool>(() =>
            {
                if (empresa == null) { Aviso("Elige la carpeta de Sisgen de esta sucursal."); return false; }
                candidato = (Candidato)cboCarpeta.SelectedItem;
                return true;
            });
        }

        void LeerEmpresa()
        {
            empresa = null;
            var c = cboCarpeta.SelectedItem as Candidato;
            try { if (c != null) empresa = Ventas.Empresa(new Config { CarpetaDatos = c.Datos }); }
            catch { }
            lblEmpresa.Text = empresa == null ? "" :
                "✓ " + empresa["razonSocial"] + "   (RUT " + empresa["rut"] + ")\n   Sucursal: " + empresa["nombreSistema"];
        }

        void PasoLlave()
        {
            txtLlave = new TextBox { Width = 570, Font = new Font("Consolas", 10f), Text = llave ?? "" };
            txtPortal = new TextBox { Width = 570, Text = portal };
            lblEstado = Texto("", 46);
            Poner(Titulo("Llave de instalación"),
                  Texto("Pega la llave que generaste en el portal (empieza con sga_).", 24),
                  txtLlave,
                  Texto("Dirección del portal (normalmente no hay que cambiarla):", 22),
                  txtPortal, lblEstado);
            txtLlave.Focus();
            siguiente.Tag = new Func<bool>(() =>
            {
                llave = txtLlave.Text.Trim();
                portal = txtPortal.Text.Trim().TrimEnd('/');
                if (!llave.StartsWith("sga_")) { Aviso("La llave debe empezar con sga_. Cópiala completa desde el portal."); return false; }
                lblEstado.ForeColor = Gris;
                lblEstado.Text = "Comprobando la conexión con el portal…";
                Refresh();
                try
                {
                    var r = new Portal(portal, llave).Enviar("/hola", Json.Objeto(new Dictionary<string, object> {
                        { "version", Program.Version }, { "equipo", Environment.MachineName }, { "empresa", empresa } }));
                    if (!r.Ok)
                    {
                        lblEstado.ForeColor = Color.Firebrick;
                        lblEstado.Text = r.Estado == 401 ? "La llave no es válida. Genera una nueva en el portal." :
                                         r.Estado == 403 ? "Este agente está desactivado en el portal." :
                                         "El portal no aceptó la conexión: " + (r.Valor("error") ?? ("código " + r.Estado));
                        return false;
                    }
                    conectadoComo = r.Valor("sucursal") + " · " + r.Valor("rut");
                    return true;
                }
                catch (Exception e)
                {
                    lblEstado.ForeColor = Color.Firebrick;
                    lblEstado.Text = "No se pudo conectar con el portal. Revisa la conexión a internet y la dirección.\n" + e.Message;
                    return false;
                }
            });
        }

        void PasoConfirmar()
        {
            Poner(Titulo("Listo para instalar"),
                  Texto(actualizar ? "Se actualizará el Agente Sisgen manteniendo su configuración." :
                        "Conectado al portal como: " + conectadoComo, 26),
                  Texto("Carpeta de Sisgen:  " + (candidato != null ? candidato.ToString() : "(la ya configurada)"), 24),
                  Texto("Se instalará en:  " + Instalador.Destino, 24),
                  Texto("El servicio \"Agente Sisgen (Portal)\" arrancará solo cada vez que se encienda el equipo.", 40));
            siguiente.Text = "Instalar";
            siguiente.Tag = null;
        }

        void PasoInstalar()
        {
            txtProgreso = new TextBox { Multiline = true, ReadOnly = true, Width = 570, Height = 200, ScrollBars = ScrollBars.Vertical, BackColor = Color.White };
            Poner(Titulo("Instalando…"), txtProgreso);
            siguiente.Enabled = false;
            atras.Visible = false;
            cancelar.Enabled = false;
            var hilo = new Thread(() =>
            {
                bool ok = false;
                try { Instalar(); ok = true; }
                catch (Exception e) { Linea("ERROR: " + e.Message); }
                BeginInvoke(new Action(() =>
                {
                    cancelar.Enabled = true;
                    cancelar.Text = "Cerrar";
                    ((Label)cuerpo.Controls[0]).Text = ok ? "Instalación terminada" : "La instalación no se completó";
                    if (ok) Linea("\r\nListo. En el portal, esta sucursal aparecerá como \"Agente en línea\".\r\n" +
                                  "Los primeros minutos el agente envía las ventas del mes anterior y del actual.");
                }));
            }) { IsBackground = true };
            hilo.Start();
        }

        void Instalar()
        {
            Linea("Deteniendo versión anterior (si existe)…");
            Instalador.DetenerServicio();
            Directory.CreateDirectory(Instalador.Destino);
            string exe = Path.Combine(Instalador.Destino, "SisgenAgente.exe");
            Linea("Copiando el agente a " + Instalador.Destino + "…");
            File.WriteAllBytes(exe, Instalador.AgenteIncluido());
            string ini = Path.Combine(Instalador.Destino, "agente.ini");
            if (!actualizar || !File.Exists(ini))
            {
                Linea("Guardando la configuración…");
                File.WriteAllText(ini, "# Configuración del Agente Sisgen (creada por el instalador)\r\n" +
                    "portal=" + portal + "\r\nllave=" + llave + "\r\nsisgen=" + candidato.Raiz + "\r\ndatos=" + candidato.Datos + "\r\n",
                    new UTF8Encoding(false));
            }
            if (!Instalador.Instalado())
            {
                Linea("Registrando el servicio de Windows…");
                string r = Instalador.Sc("create " + Instalador.Servicio + " binPath= \"\\\"" + exe + "\\\"\" start= delayed-auto DisplayName= \"Agente Sisgen (Portal)\"");
                if (!Instalador.Instalado()) throw new Exception("No se pudo crear el servicio: " + r.Trim());
                Instalador.Sc("description " + Instalador.Servicio + " \"Envia al Portal Sisgen los documentos emitidos y su estado de envio al SII.\"");
                Instalador.Sc("failure " + Instalador.Servicio + " reset= 86400 actions= restart/60000/restart/60000/restart/60000");
            }
            Linea("Iniciando el servicio…");
            using (var s = new ServiceController(Instalador.Servicio))
            {
                s.Start();
                s.WaitForStatus(ServiceControllerStatus.Running, TimeSpan.FromSeconds(30));
            }
            Linea("✓ Servicio \"Agente Sisgen (Portal)\" en ejecución.");
        }

        void Desinstalar()
        {
            if (MessageBox.Show(this, "¿Desinstalar el Agente Sisgen de este equipo?\n\nSisgen y DTESERVICE no se modifican.", "Desinstalar",
                    MessageBoxButtons.YesNo, MessageBoxIcon.Question) != DialogResult.Yes) return;
            try
            {
                Instalador.DetenerServicio();
                Instalador.Sc("delete " + Instalador.Servicio);
                Thread.Sleep(1500);
                try { Directory.Delete(Instalador.Destino, true); } catch { }
                MessageBox.Show(this, "El Agente Sisgen fue desinstalado.", "Listo", MessageBoxButtons.OK, MessageBoxIcon.Information);
                Close();
            }
            catch (Exception e) { Aviso("No se pudo desinstalar: " + e.Message); }
        }

        void Avanzar()
        {
            var validar = siguiente.Tag as Func<bool>;
            if (validar != null && !validar()) return;
            // Al actualizar se saltan carpeta y llave (se mantiene agente.ini)
            int siguientePaso = paso == 0 && actualizar ? 3 : paso + 1;
            Mostrar(siguientePaso);
        }

        void Linea(string t)
        {
            if (InvokeRequired) { BeginInvoke(new Action(() => Linea(t))); return; }
            txtProgreso.AppendText(t + "\r\n");
        }

        void Aviso(string t) { MessageBox.Show(this, t, "Agente Sisgen", MessageBoxButtons.OK, MessageBoxIcon.Warning); }
    }
}
