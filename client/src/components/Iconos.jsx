// Íconos simples (trazo) para el menú. Heredan el color del texto.
const base = { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true };

const RUTAS = {
  inicio: <><path d="M3 11l9-7 9 7" /><path d="M5 10v10h14V10" /><path d="M10 20v-6h4v6" /></>,
  revisar: <><path d="M12 3l9 16H3z" /><path d="M12 10v4" /><path d="M12 17h.01" /></>,
  buscar: <><circle cx="11" cy="11" r="7" /><path d="M20 20l-4-4" /></>,
  clientes: <><path d="M3 21V8l9-5 9 5v13" /><path d="M9 21v-6h6v6" /><path d="M3 21h18" /></>,
  usuarios: <><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20c.8-3.5 3.4-5.5 6.5-5.5s5.7 2 6.5 5.5" /><circle cx="17.5" cy="9" r="2.5" /><path d="M16.5 14.6c2.4.2 4.3 1.9 5 4.9" /></>,
  agentes: <><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8" /><path d="M12 16v4" /><path d="M7 9l2 2 4-4" /></>,
  clave: <><circle cx="8" cy="15" r="4" /><path d="M11 12l9-9" /><path d="M17 6l3 3" /></>,
  salir: <><path d="M15 4h3a2 2 0 012 2v12a2 2 0 01-2 2h-3" /><path d="M10 17l-5-5 5-5" /><path d="M5 12h11" /></>,
  menu: <><path d="M4 6h16" /><path d="M4 12h16" /><path d="M4 18h16" /></>,
};

export default function Icono({ nombre }) {
  return <svg {...base}>{RUTAS[nombre]}</svg>;
}
