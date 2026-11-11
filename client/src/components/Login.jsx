import { useState } from 'react';
import { api } from '../util.js';
import { MARCA } from '../marca.js';

export default function Login({ alIngresar, mensaje }) {
  const [usuario, setUsuario] = useState('');
  const [clave, setClave] = useState('');
  const [verClave, setVerClave] = useState(false);
  const [error, setError] = useState(null);
  const [enviando, setEnviando] = useState(false);

  const enviar = async (e) => {
    e.preventDefault();
    setError(null);
    setEnviando(true);
    try {
      const r = await api('/api/auth/login', { metodo: 'POST', cuerpo: { usuario: usuario.trim(), clave } });
      alIngresar(r.usuario);
    } catch (err) {
      setError(err.message);
      setClave('');
    } finally {
      setEnviando(false);
    }
  };

  return (
    <div className="login">
      <section className="login-marca">
        <div className="login-marca-contenido">
          <img src={MARCA.logo} alt={MARCA.empresa} className="login-logo-img" />
          <h1>{MARCA.portal}<span className="login-modulo">{MARCA.modulo}</span></h1>
          <p className="lead">{MARCA.descripcion}</p>
          <ul className="login-beneficios">
            <li>Todas tus razones sociales y sucursales en un solo lugar</li>
            <li>Aviso de documentos que no llegaron al SII o fueron rechazados</li>
            <li>Descarga de PDF y XML de cada documento</li>
          </ul>
        </div>
        <div className="login-pie">© {new Date().getFullYear()} {MARCA.empresa} · {MARCA.lema}</div>
      </section>

      <section className="login-formulario">
        <form className="login-tarjeta" onSubmit={enviar} noValidate>
          <div className="login-encabezado-movil">
            <img src={MARCA.logo} alt={MARCA.empresa} className="logo-cabecera" />
            <span className="separador-marca" aria-hidden="true" />
            <span>{MARCA.portal}<small className="d-block text-secondary fw-normal">{MARCA.modulo}</small></span>
          </div>
          <h2 className="h4 mb-1">Iniciar sesión</h2>
          <p className="text-secondary mb-4">Ingresa con el usuario que te entregó Sisgen.</p>

          {mensaje && !error && <div className="alert alert-info py-2 small">{mensaje}</div>}
          {error && <div className="alert alert-danger py-2 small" role="alert">{error}</div>}

          <div className="mb-3">
            <label htmlFor="usuario" className="form-label">Usuario</label>
            <input id="usuario" className="form-control form-control-lg" autoComplete="username" autoFocus
              value={usuario} onChange={(e) => setUsuario(e.target.value)} required />
          </div>
          <div className="mb-4">
            <label htmlFor="clave" className="form-label">Contraseña</label>
            <div className="input-group">
              <input id="clave" type={verClave ? 'text' : 'password'} className="form-control form-control-lg"
                autoComplete="current-password" value={clave} onChange={(e) => setClave(e.target.value)} required />
              <button type="button" className="btn btn-outline-secondary" onClick={() => setVerClave(!verClave)}
                aria-label={verClave ? 'Ocultar contraseña' : 'Mostrar contraseña'}>
                {verClave ? 'Ocultar' : 'Ver'}
              </button>
            </div>
          </div>
          <button type="submit" className="btn btn-primary btn-lg w-100 boton-marca" disabled={enviando || !usuario || !clave}>
            {enviando ? 'Ingresando…' : 'Ingresar'}
          </button>
          <p className="text-secondary small mt-4 mb-0">
            ¿Olvidaste tu contraseña o no tienes usuario? Contacta a soporte Sisgen (mesa central +56 2 2267 0274) para que te la restablezcan.
          </p>
        </form>
      </section>
    </div>
  );
}
