// Lista funciones con su comentario previo y su cuerpo resumido (primeras líneas), por archivo.
const fs = require('fs'), path = require('path');
const raiz = process.argv[2], archivos = process.argv.slice(3);
const csFn = /^\s*(public|private|internal|protected|static|override|async|readonly|\s)*[\w<>\[\],\.\?]+\s+(\w+)\s*\(([^)]*)\)?\s*(\{.*)?$/;
const csCls = /^\s*(public |internal |static |abstract )*(class|struct)\s+(\w+)/;
const jsFn = /^\s*(export\s+)?(default\s+)?(async\s+)?function\s*\*?\s*(\w+)\s*\(|^\s*(export\s+)?(const|let)\s+(\w+)\s*=\s*(async\s*)?(\([^)]*\)|\w+)\s*=>|^\s*(router|app)\.(get|post|put|delete|patch)\(\s*['"`]([^'"`]+)/;
const no = new Set(['if','for','foreach','while','switch','catch','using','lock','return','new','throw','else','base','this']);
for (const a of archivos) {
  const ruta = path.join(raiz, a);
  const l = fs.readFileSync(ruta, 'utf8').split(/\r?\n/);
  console.log('\n######## ' + a + ' (' + l.length + ' líneas)');
  // comentario de cabecera
  const cab = []; for (const x of l) { if (/^\s*(\/\/|\/\*|\*)/.test(x)) cab.push(x.trim()); else if (x.trim()) break; }
  if (cab.length) console.log(cab.join('\n'));
  const cs = a.endsWith('.cs');
  for (let i = 0; i < l.length; i++) {
    const x = l[i];
    let nombre = null;
    if (cs) {
      const c = x.match(csCls); if (c) { console.log(`\n== clase ${c[3]} (L${i+1})`); continue; }
      const m = x.match(csFn); if (m && !no.has(m[2]) && !/[=;]\s*$/.test(x.replace(/\{.*$/, '')) && !/^\s*(return|new|var|throw)\b/.test(x)) nombre = m[2];
    } else {
      const m = x.match(jsFn); if (m && /^\s{0,2}\S/.test(x)) nombre = m[4] || m[7] || (m[11] ? m[11].toUpperCase() + ' ' + m[12] : null);
    }
    if (!nombre) continue;
    if (!cs) { const com = []; for (let j = i - 1; j >= 0 && /^\s*(\/\/|\/\*|\*)/.test(l[j]); j--) com.unshift(l[j].trim()); console.log(`-- ${nombre} (L${i+1})` + (com.length ? ' :: ' + com.join(' ').slice(0, 300) : '') + ' > ' + l.slice(i, i + 4).map(z => z.trim()).join(' ⏎ ').slice(0, 220)); continue; }
    const com = []; for (let j = i - 1; j >= 0 && /^\s*(\/\/|\/\*|\*|\/\/\/|\[)/.test(l[j]); j--) com.unshift(l[j].trim().replace(/<\/?summary>|\/\/\/ ?/g, ''));
    console.log(`\n-- ${nombre} (L${i+1}): ${x.trim().slice(0, 160)}`);
    if (com.length) console.log('   ' + com.filter(z => z).join(' ').slice(0, 400));
    const cuerpo = l.slice(i + 1, i + 7).map(z => z.trim()).filter(z => z && z !== '{').join(' ⏎ ');
    console.log('   > ' + cuerpo.slice(0, 380));
  }
}
