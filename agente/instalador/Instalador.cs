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

        public static byte[] AgenteIncluido() { return Recurso("SisgenAgente.exe"); }

        public static byte[] Recurso(string nombre)
        {
            using (var s = Assembly.GetExecutingAssembly().GetManifestResourceStream(nombre))
            using (var ms = new MemoryStream())
            {
                if (s == null) return null;
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

        // Folios
        bool folios;
        List<string> carpetasFolios = new List<string>();
        CheckBox chkFolios, chkProduccion;
        bool produccion;
        // Avisar cuando queden N folios, por documento (código SII -> N)
        Dictionary<string, long> avisos = new Dictionary<string, long>();
        List<Tuple<string, TextBox, CheckBox>> camposAviso;
        CheckedListBox lstFolios;

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
            atras.Click += (s, e) => Mostrar(paso == 3 && actualizar ? 0 : paso == 5 && !folios ? 3 : paso - 1);
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
            atras.Visible = n > 0 && n < 6;
            siguiente.Enabled = true;
            siguiente.Text = "Siguiente >";
            cancelar.Text = "Cancelar";
            switch (n)
            {
                case 0: PasoBienvenida(); break;
                case 1: PasoCarpeta(); break;
                case 2: PasoLlave(); break;
                case 3: PasoFolios(); break;
                case 4: PasoAvisos(); break;
                case 5: PasoConfirmar(); break;
                case 6: PasoInstalar(); break;
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
                    // Lo que ya está configurado (para el paso de folios)
                    var ini = LeerIni();
                    string v;
                    if (ini.TryGetValue("sisgen", out v) && v.Length > 0)
                        candidato = new Candidato { Raiz = v.TrimEnd('\\'), Datos = ini.TryGetValue("datos", out v) && v.Length > 0 ? v : Path.Combine(ini["sisgen"].TrimEnd('\\'), "datos") };
                    folios = ini.TryGetValue("folios", out v) && v.Equals("si", StringComparison.OrdinalIgnoreCase);
                    produccion = ini.TryGetValue("foliosProduccion", out v) && v.Equals("si", StringComparison.OrdinalIgnoreCase);
                    if (ini.TryGetValue("avisoFolios", out v))
                        foreach (var par in v.Split(';')) { var p = par.Split(':'); long n; if (p.Length == 2 && long.TryParse(p[1], out n)) avisos[p[0].Trim()] = n; }
                    if (ini.TryGetValue("foliosSisgen", out v)) carpetasFolios = v.Split(';').Select(x => x.Trim().TrimEnd('\\')).Where(x => x.Length > 0).ToList();
                    llave = ini.TryGetValue("llave", out v) ? v : null;
                    if (candidato == null) { Aviso("No se pudo leer la carpeta de Sisgen de la configuración actual (agente.ini)."); return false; }
                    return true;
                });
                return;
            }
            Poner(Titulo("Bienvenido"),
                  Texto("Este asistente instala el Agente Sisgen como servicio de Windows. Desde ese momento, cada documento " +
                        "que emita esta sucursal se envía al Portal Sisgen junto con su estado en el SII.", 60),
                  Texto("El agente solo LEE la información de Sisgen: no modifica nada ni interfiere con DTESERVICE.", 40),
                  Texto("Necesitas la llave de instalación que se genera en el portal (ficha del cliente → \"Instalar agente en un servidor nuevo\"). " +
                        "Si solo vas a usar los avisos y la carga de folios, no se necesita llave.", 60));
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
                  Texto("Pega la llave que generaste en el portal (empieza con sga_). Déjala vacía si solo usarás folios.", 24),
                  txtLlave,
                  Texto("Dirección del portal (normalmente no hay que cambiarla):", 22),
                  txtPortal, lblEstado);
            txtLlave.Focus();
            siguiente.Tag = new Func<bool>(() =>
            {
                llave = txtLlave.Text.Trim();
                portal = txtPortal.Text.Trim().TrimEnd('/');
                if (llave.Length == 0) { conectadoComo = null; return true; } // solo folios (se exige activarlos en el paso siguiente)
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

        void PasoFolios()
        {
            chkFolios = new CheckBox { Text = "Avisar cuando queden pocos folios y cargarlos desde el SII", Width = 560, Checked = folios || string.IsNullOrEmpty(llave) };
            lstFolios = new CheckedListBox { Width = 570, Height = 96, CheckOnClick = true };
            // La carpeta elegida, marcada; las demás instalaciones de Sisgen del equipo, para marcar si este servidor atiende varias
            var raices = new List<string> { candidato.Raiz };
            foreach (var c in Instalador.CarpetasSisgen()) if (!raices.Any(r => r.Equals(c.Raiz, StringComparison.OrdinalIgnoreCase))) raices.Add(c.Raiz);
            foreach (var r in raices) lstFolios.Items.Add(r, r.Equals(candidato.Raiz, StringComparison.OrdinalIgnoreCase) || carpetasFolios.Contains(r));
            chkProduccion = new CheckBox { Text = "Pedir folios REALES al SII (producción). Sin marcar: solo certificación (pruebas).", Width = 570, Checked = produccion, ForeColor = Color.Firebrick };
            lstFolios.Height = 76;
            lstFolios.Enabled = chkProduccion.Enabled = chkFolios.Checked;
            chkFolios.CheckedChanged += (s, e) => lstFolios.Enabled = chkProduccion.Enabled = chkFolios.Checked;
            Poner(Titulo("Folios"),
                  Texto("El agente revisa cuántos folios quedan. Cuando quedan pocos, aparece un aviso en los equipos para cargar más; " +
                        "si se acaba un rango y hay otro cargado, lo asigna solo.", 44),
                  chkFolios,
                  Texto("Carpetas de Sisgen que atiende este servidor:", 22),
                  lstFolios,
                  chkProduccion);
            siguiente.Tag = new Func<bool>(() =>
            {
                folios = chkFolios.Checked;
                produccion = folios && chkProduccion.Checked;
                if (produccion && MessageBox.Show(this, "Se pedirán folios REALES al SII con el certificado de esta sucursal, y se cargarán en Sisgen.\n\n¿Continuar?",
                        "Folios en producción", MessageBoxButtons.YesNo, MessageBoxIcon.Warning) != DialogResult.Yes) return false;
                carpetasFolios = lstFolios.CheckedItems.Cast<string>().ToList();
                if (string.IsNullOrEmpty(llave) && !folios) { Aviso("Sin llave del portal, el agente solo puede usarse para folios: activa los folios o vuelve y pega la llave."); return false; }
                if (folios && carpetasFolios.Count == 0) { Aviso("Marca al menos una carpeta de Sisgen."); return false; }
                return true;
            });
        }

        /// <summary>
        /// Por cada documento que usa este Sisgen: cuántos folios quedan hoy, cuántos se usan al día y desde cuántos
        /// avisar. La sugerencia es lo que se usa en una semana (o el 20 % del último rango si no hay ventas recientes).
        /// </summary>
        void PasoAvisos()
        {
            List<EstadoFolio> estados = new List<EstadoFolio>();
            Cursor = Cursors.WaitCursor;
            try { estados = Folios.Calcular(candidato.Datos, DateTime.Today); } catch { }
            Cursor = Cursors.Default;
            var tabla = new TableLayoutPanel { ColumnCount = 4, AutoSize = true, Width = 570, CellBorderStyle = TableLayoutPanelCellBorderStyle.None };
            tabla.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 60));
            tabla.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 140));
            tabla.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 250));
            tabla.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 110));
            Func<string, bool, Label> celda = (t, neg) => new Label { Text = t, AutoSize = true, Margin = new Padding(0, 6, 0, 2), ForeColor = neg ? Negro : Gris,
                                                                     Font = neg ? new Font("Segoe UI Semibold", 9.5f) : Font };
            tabla.Controls.Add(celda("Vigilar", true)); tabla.Controls.Add(celda("Documento", true)); tabla.Controls.Add(celda("Hoy", true)); tabla.Controls.Add(celda("Avisar con", true));
            camposAviso = new List<Tuple<string, TextBox, CheckBox>>();
            foreach (var e in estados)
            {
                long actual;
                bool conValor = avisos.TryGetValue(e.Tipo.Sii, out actual);
                // 0 = documento que esta sucursal no usa: no se vigila ni se piden folios
                var vigilar = new CheckBox { Checked = !(conValor && actual == 0), AutoSize = true, Margin = new Padding(18, 6, 0, 0) };
                var num = new TextBox { Width = 90, TextAlign = HorizontalAlignment.Right, Margin = new Padding(0, 3, 0, 0), MaxLength = 7,
                                        Text = conValor && actual > 0 ? actual.ToString() : "", Enabled = vigilar.Checked };
                num.KeyPress += (s, ev) => { if (!char.IsDigit(ev.KeyChar) && !char.IsControl(ev.KeyChar)) ev.Handled = true; };
                vigilar.CheckedChanged += (s, ev) => num.Enabled = vigilar.Checked;
                tabla.Controls.Add(vigilar);
                tabla.Controls.Add(celda(e.Tipo.Nombre, false));
                tabla.Controls.Add(celda("quedan " + e.Quedan.ToString("N0") + (e.EsperaHasta > 0 ? " + rango en espera" : ""), false));
                tabla.Controls.Add(num);
                camposAviso.Add(Tuple.Create(e.Tipo.Sii, num, vigilar));
            }
            var marco = new Panel { Width = 575, Height = 190, AutoScroll = true };
            marco.Controls.Add(tabla);
            Poner(Titulo("Avisos por documento"),
                  Texto(estados.Count == 0 ? "No se pudo leer el estado de folios de esta carpeta; se usará el aviso normal (20 % del rango)."
                                           : "Desmarca los documentos que esta sucursal no emite: no se avisará ni se pedirán folios de ellos. " +
                                             "En \"Avisar con\" escribe con cuántos folios restantes avisar (en blanco: el 20 % del rango).", 40),
                  marco);
            siguiente.Tag = new Func<bool>(() =>
            {
                avisos = new Dictionary<string, long>();
                foreach (var x in camposAviso)
                {
                    long n;
                    if (!x.Item3.Checked) avisos[x.Item1] = 0;
                    else if (long.TryParse(x.Item2.Text.Trim(), out n) && n > 0) avisos[x.Item1] = n;
                }
                return true;
            });
        }

        string TextoAvisos() { return string.Join(";", avisos.Select(kv => kv.Key + ":" + kv.Value)); }

        void PasoConfirmar()
        {
            // Revisión del cliente antes de activar los folios: solo lee (las pruebas se hacen en una copia temporal)
            var revision = new List<string>();
            bool problemas = false;
            if (folios)
            {
                Cursor = Cursors.WaitCursor;
                foreach (var c in carpetasFolios)
                {
                    revision.Add(c + ":");
                    try
                    {
                        foreach (var r in RevisionCliente.Revisar(c)) { revision.Add("   " + r); if (!r.Ok) problemas = true; }
                    }
                    catch (Exception e) { revision.Add("   ✗ " + e.Message); problemas = true; }
                }
                Cursor = Cursors.Default;
            }
            var caja = new TextBox { Multiline = true, ReadOnly = true, Width = 570, Height = 118, ScrollBars = ScrollBars.Vertical, BackColor = Color.White,
                                     Text = string.Join("\r\n", revision), ForeColor = problemas ? Color.Firebrick : Negro };
            var controles = new List<Control> {
                Titulo(problemas ? "Revisión del cliente: hay problemas" : "Listo para instalar"),
                Texto(actualizar ? "Se actualizará el Agente Sisgen manteniendo su configuración." :
                      conectadoComo != null ? "Conectado al portal como: " + conectadoComo : "Sin portal: solo folios.", 22),
                Texto("Folios:  " + (folios ? "sí" + (produccion ? "  ·  REALES (producción)" : "  ·  solo certificación") : "no") +
                      "     ·     Se instala en:  " + Instalador.Destino, 22) };
            if (folios)
            {
                controles.Add(Texto(problemas
                    ? "Con estos problemas el agente no podría cargar folios en Sisgen. Envía esta lista a soporte, o vuelve atrás y desactiva los folios."
                    : "Revisión del cliente (solo lectura, no se cambió nada):", problemas ? 40 : 20));
                controles.Add(caja);
            }
            Poner(controles.ToArray());
            siguiente.Text = "Instalar";
            siguiente.Enabled = !problemas;
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
                    if (ok && !string.IsNullOrEmpty(llave)) Linea("\r\nListo. En el portal, esta sucursal aparecerá como \"Agente en línea\".\r\n" +
                                  "Los primeros minutos el agente envía las ventas del mes anterior y del actual.");
                    if (ok && folios) Linea("\r\nAviso de folios: en los demás equipos, abre una vez AvisoFolios.exe desde la carpeta " +
                                  "procesos\\folios\\agente de Sisgen (por la red) y quedará activo al iniciar sesión.");
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
                string texto = "# Configuración del Agente Sisgen (creada por el instalador)\r\n";
                if (!string.IsNullOrEmpty(llave)) texto += "portal=" + portal + "\r\nllave=" + llave + "\r\n";
                texto += "sisgen=" + candidato.Raiz + "\r\ndatos=" + candidato.Datos + "\r\n";
                if (folios) texto += "folios=si\r\nfoliosSisgen=" + string.Join(";", carpetasFolios) + "\r\n";
                if (folios && avisos.Count > 0) texto += "avisoFolios=" + TextoAvisos() + "\r\n";
                if (produccion) texto += "foliosProduccion=si\r\n";
                File.WriteAllText(ini, texto, new UTF8Encoding(false));
            }
            else
            {
                // Actualización: se mantiene todo y solo se reemplazan las líneas de folios
                Linea("Actualizando la configuración de folios…");
                var claves = new[] { "folios", "foliosSisgen", "foliosProduccion", "avisoFolios" };
                var lineas = File.ReadAllLines(ini).Where(l =>
                {
                    int i = l.IndexOf('=');
                    return i <= 0 || !claves.Contains(l.Substring(0, i).Trim(), StringComparer.OrdinalIgnoreCase);
                }).ToList();
                if (folios)
                {
                    lineas.Add("folios=si");
                    lineas.Add("foliosSisgen=" + string.Join(";", carpetasFolios));
                    if (avisos.Count > 0) lineas.Add("avisoFolios=" + TextoAvisos());
                    if (produccion) lineas.Add("foliosProduccion=si");
                }
                File.WriteAllLines(ini, lineas, new UTF8Encoding(false));
            }
            // Aviso de folios: en cada carpeta de Sisgen (los equipos lo abren desde ahí) y en este servidor al iniciar sesión
            var avisoBytes = Instalador.Recurso("AvisoFolios.exe");
            var avisoIni = Path.Combine(Instalador.Destino, "agente.ini");
            var carpetasAviso = File.ReadAllLines(avisoIni).Select(l => l.Trim())
                .Where(l => l.StartsWith("foliosSisgen=", StringComparison.OrdinalIgnoreCase))
                .SelectMany(l => l.Substring(13).Split(';')).Select(x => x.Trim()).Where(x => x.Length > 0).ToList();
            bool conFolios = File.ReadAllLines(avisoIni).Any(l => l.Trim().Equals("folios=si", StringComparison.OrdinalIgnoreCase));
            if (conFolios && avisoBytes != null)
            {
                Linea("Copiando el aviso de folios…");
                foreach (var c in carpetasAviso)
                {
                    string d = Path.Combine(c, "procesos", "folios", "agente");
                    try { Directory.CreateDirectory(d); File.WriteAllBytes(Path.Combine(d, "AvisoFolios.exe"), avisoBytes); Linea("   " + d); }
                    catch (Exception e) { Linea("   No se pudo copiar en " + d + ": " + e.Message); }
                }
                string avisoLocal = Path.Combine(Instalador.Destino, "AvisoFolios.exe");
                foreach (var p in Process.GetProcessesByName("AvisoFolios")) try { p.Kill(); p.WaitForExit(3000); } catch { }
                File.WriteAllBytes(avisoLocal, avisoBytes);
                File.WriteAllLines(Path.Combine(Instalador.Destino, "avisofolios.ini"), carpetasAviso.Select(c => "sisgen=" + c), new UTF8Encoding(false));
                using (var run = Microsoft.Win32.Registry.LocalMachine.CreateSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run"))
                    run.SetValue("AvisoFoliosSisgen", "\"" + avisoLocal + "\"");
                // Se abre ya para el usuario actual (sin permisos de administrador)
                try { Process.Start("explorer.exe", "\"" + avisoLocal + "\""); } catch { }
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
            if (conFolios) EsperarPruebaSii(carpetasAviso);
        }

        /// <summary>
        /// El servicio, al arrancar, entra al SII con el certificado y deja el resultado en procesos\folios\agente\estado_sii.txt.
        /// Se espera ese resultado (hasta 2 minutos) para mostrarlo: es la prueba real, con la misma cuenta del servicio.
        /// </summary>
        void EsperarPruebaSii(List<string> carpetas)
        {
            Linea("Probando la entrada al SII con el certificado (la hace el servicio)…");
            var inicio = DateTime.Now.AddSeconds(-5);
            foreach (var c in carpetas)
            {
                string f = Path.Combine(c, "procesos", "folios", "agente", "estado_sii.txt");
                string linea = null;
                for (int i = 0; i < 120 && linea == null; i++)
                {
                    try { if (File.Exists(f) && File.GetLastWriteTime(f) >= inicio) linea = File.ReadAllText(f).Trim(); } catch { }
                    if (linea == null) Thread.Sleep(1000);
                }
                if (linea == null) { Linea("   ? " + c + ": el servicio no informó a tiempo; revisa el registro en " + Path.Combine(Instalador.Destino, "logs")); continue; }
                var p = linea.Split('|');
                if (p.Length >= 3 && p[2] == "ok") Linea("   ✓ " + c + ": el agente entra al SII (" + (p.Length > 3 ? p[3] : "") + ").");
                else
                {
                    Linea("   ✗ " + c + ": el agente NO pudo entrar al SII. No podrá pedir folios hasta corregirlo.");
                    Linea("      " + (p.Length > 3 ? string.Join("|", p.Skip(3)) : linea));
                    Linea("      Envía este mensaje a soporte.");
                }
            }
        }

        void Desinstalar()
        {
            if (MessageBox.Show(this, "¿Desinstalar el Agente Sisgen de este equipo?\n\nSisgen y DTESERVICE no se modifican.", "Desinstalar",
                    MessageBoxButtons.YesNo, MessageBoxIcon.Question) != DialogResult.Yes) return;
            try
            {
                Instalador.DetenerServicio();
                Instalador.Sc("delete " + Instalador.Servicio);
                try { using (var run = Microsoft.Win32.Registry.LocalMachine.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run", true)) if (run != null) run.DeleteValue("AvisoFoliosSisgen", false); } catch { }
                foreach (var p in Process.GetProcessesByName("AvisoFolios")) try { p.Kill(); } catch { }
                Thread.Sleep(1500);
                try { Directory.Delete(Instalador.Destino, true); } catch { }
                MessageBox.Show(this, "El Agente Sisgen fue desinstalado.", "Listo", MessageBoxButtons.OK, MessageBoxIcon.Information);
                Close();
            }
            catch (Exception e) { Aviso("No se pudo desinstalar: " + e.Message); }
        }

        static Dictionary<string, string> LeerIni()
        {
            var d = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            string ruta = Path.Combine(Instalador.Destino, "agente.ini");
            if (!File.Exists(ruta)) return d;
            foreach (var l in File.ReadAllLines(ruta))
            {
                string t = l.Trim();
                if (t.StartsWith("#") || t.StartsWith(";")) continue;
                int i = t.IndexOf('=');
                if (i > 0) d[t.Substring(0, i).Trim()] = t.Substring(i + 1).Trim();
            }
            return d;
        }

        void Avanzar()
        {
            var validar = siguiente.Tag as Func<bool>;
            if (validar != null && !validar()) return;
            // Al actualizar se saltan carpeta y llave (se mantiene agente.ini)
            // Al actualizar se saltan carpeta y llave, pero se puede revisar/activar folios
            int siguientePaso = paso == 0 && actualizar ? 3 : paso == 3 && !folios ? 5 : paso + 1;
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
