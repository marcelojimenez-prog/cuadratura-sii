# Prepara un caso de prueba a partir de folios.dbf/.cdx de un cliente: copia los dos archivos y deja en blanco
# todos los campos menos TIPODOCU (lo único que usa el índice). Así el proyecto no guarda datos de clientes.
# Uso: python anonimizar.py <carpeta datos origen> <carpeta del caso>
import os, struct, sys

origen, destino = sys.argv[1], sys.argv[2]
os.makedirs(destino, exist_ok=True)

def buscar(carpeta, nombre):
    for f in os.listdir(carpeta):
        if f.lower() == nombre:
            return os.path.join(carpeta, f)
    raise SystemExit('No está ' + nombre + ' en ' + carpeta)

d = bytearray(open(buscar(origen, 'folios.dbf'), 'rb').read())
n, hl, rl = struct.unpack_from('<IHH', d, 4)
campos = []; o = 32; pos = 1
while d[o] != 0x0D:
    nm = d[o:o + 11].split(b'\0')[0].decode('latin1').upper(); ln = d[o + 16]
    campos.append((nm, pos, ln)); pos += ln; o += 32
for i in range(n):
    base = hl + i * rl
    for nm, p, ln in campos:
        if nm != 'TIPODOCU':
            d[base + p:base + p + ln] = b' ' * ln
open(os.path.join(destino, 'folios.dbf'), 'wb').write(d)
open(os.path.join(destino, 'folios.cdx'), 'wb').write(open(buscar(origen, 'folios.cdx'), 'rb').read())
print('caso', destino, ':', n, 'filas')
