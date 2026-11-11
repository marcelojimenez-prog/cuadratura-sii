import { useState } from 'react';
import { api } from '../util.js';
import { MARCA } from '../marca.js';

/** Cambio de contraseña. obligatorio = primer ingreso con clave temporal (pantalla completa). */
export default function CambiarClave({ usuario, obligatorio, alCambiar, alCancelar, alSalir }) {
  const [actual, setActual] = useState('');
  const [nueva, setNueva] = useState('');
  const [repetir, setRepetir] = useState('');
  const [error, setError] = useState(null);
  const [enviando, setEnviando] = useState(false);

  const enviar = async (e) => {
    e.preventDefault();
    setError(null);
    if (nueva !== repetir) return setError('Las contraseñas nuevas no coinciden');
    setEnviando(true);
    try {
      const r = await api('/api/auth/cambiar-clave', { metodo: 'POST', cuerpo: { actual, nueva } });
      alCambiar(r.usuario);
    } catch (err) {
      setError(err.message);
    } finally {
      setEnviando(false);
    }
  };

  const formulario = (
    <form className="login-tarjeta" onSubmit={enviar} noValidate>
      <h2 className="h4 mb-1">{obligatorio ? 'Crea tu contraseña' : 'Cambiar contraseña'}</h2>
      <p className="text-secondary mb-4">
        {obligatorio
          ? <>Hola {usuario.nombre}. Estás usando una contraseña temporal; crea una propia para continuar.</>
          : 'Ingresa tu contraseña actual y la nueva.'}
      </p>
      {error && <div className="alert alert-danger py-2 small" role="alert">{error}</div>}
      <div className="mb-3">
        <label htmlFor="actual" className="form-label">{obligatorio ? 'Contraseña temporal' : 'Contraseña actual'}</label>
        <input id="actual" type="password" className="form-control" autoComplete="current-password" autoFocus
          value={actual} onChange={(e) => setActual(e.target.value)} />
      </div>
      <div className="mb-3">
        <label htmlFor="nueva" className="form-label">Contraseña nueva</label>
        <input id="nueva" type="password" className="form-control" autoComplete="new-password"
          value={nueva} onChange={(e) => setNueva(e.target.value)} aria-describedby="reglas" />
        <div id="reglas" className="form-text">Mínimo 8 caracteres, con letras y números.</div>
      </div>
      <div className="mb-4">
        <label htmlFor="repetir" className="form-label">Repite la contraseña nueva</label>
        <input id="repetir" type="password" className="form-control" autoComplete="new-password"
          value={repetir} onChange={(e) => setRepetir(e.target.value)} />
      </div>
      <button type="submit" className="btn btn-primary w-100 boton-marca" disabled={enviando || !actual || !nueva || !repetir}>
        {enviando ? 'Guardando…' : 'Guardar contraseña'}
      </button>
      {obligatorio
        ? <button type="button" className="btn btn-link w-100 mt-2" onClick={alSalir}>Salir</button>
        : <button type="button" className="btn btn-link w-100 mt-2" onClick={alCancelar}>Cancelar</button>}
    </form>
  );

  return obligatorio
    ? (
      <div className="pantalla-centrada flex-column gap-4">
        <img src={MARCA.logo} alt={MARCA.empresa} className="logo-pantalla" />
        {formulario}
      </div>
    )
    : <div className="d-flex justify-content-center py-4">{formulario}</div>;
}
