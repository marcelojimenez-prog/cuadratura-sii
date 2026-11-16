import { useEffect, useState } from 'react';
import Login from './components/Login.jsx';
import CambiarClave from './components/CambiarClave.jsx';
import Portal from './components/Portal.jsx';
import DocumentoEnBlanco from './components/DocumentoEnBlanco.jsx';
import { api } from './util.js';

/** Puerta de entrada: sin sesión → ingreso; con clave temporal → cambio obligatorio; si no → portal. */
export default function App() {
  const [usuario, setUsuario] = useState(undefined); // undefined = verificando sesión
  const [mensaje, setMensaje] = useState(null);

  useEffect(() => {
    api('/api/auth/yo').then((r) => setUsuario(r.usuario)).catch(() => setUsuario(null));
    const expirada = () => { setUsuario(null); setMensaje('Tu sesión terminó. Vuelve a ingresar.'); };
    window.addEventListener('sesion-expirada', expirada);
    return () => window.removeEventListener('sesion-expirada', expirada);
  }, []);

  const salir = async () => {
    await api('/api/auth/logout', { metodo: 'POST' }).catch(() => {});
    setMensaje(null);
    setUsuario(null);
  };

  if (usuario === undefined) return <div className="pantalla-centrada text-secondary">Cargando…</div>;
  if (!usuario) return <Login mensaje={mensaje} alIngresar={(u) => { setMensaje(null); setUsuario(u); }} />;
  if (usuario.debeCambiarClave) return <CambiarClave usuario={usuario} obligatorio alCambiar={setUsuario} alSalir={salir} />;
  if (window.location.pathname === '/documento-en-blanco') return <DocumentoEnBlanco />;
  return <Portal usuario={usuario} alSalir={salir} alActualizarUsuario={setUsuario} />;
}
