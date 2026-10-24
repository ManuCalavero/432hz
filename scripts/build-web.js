// Copia ffmpeg.wasm a public/vendor para servirlo desde nuestro propio dominio (sin CDN de terceros)
// y genera public/vendor/config.json con la configuración pública del navegador.
require('dotenv').config({ quiet: true });

const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const vendorDir = path.join(rootDir, 'public', 'vendor');

const copies = [
  ['node_modules/@ffmpeg/ffmpeg/dist/esm', 'ffmpeg', (name) => name.endsWith('.js')],
  ['node_modules/@ffmpeg/core/dist/esm', 'ffmpeg-core', (name) => /\.(js|wasm)$/.test(name)],
];

fs.rmSync(vendorDir, { recursive: true, force: true });

for (const [source, target, include] of copies) {
  const sourceDir = path.join(rootDir, source);
  const targetDir = path.join(vendorDir, target);
  fs.mkdirSync(targetDir, { recursive: true });

  for (const name of fs.readdirSync(sourceDir).filter(include)) {
    fs.copyFileSync(path.join(sourceDir, name), path.join(targetDir, name));
  }
}

// Solo valores públicos: la clave de sitio de Turnstile está pensada para ir en el HTML.
const siteKey = process.env.TURNSTILE_SITE_KEY || '';
if (!/^[A-Za-z0-9_-]*$/.test(siteKey)) {
  throw new Error('TURNSTILE_SITE_KEY no es válida');
}
fs.writeFileSync(path.join(vendorDir, 'config.json'), JSON.stringify({ turnstileSiteKey: siteKey }));

console.log(`ffmpeg.wasm copiado en ${path.relative(rootDir, vendorDir)}`);
