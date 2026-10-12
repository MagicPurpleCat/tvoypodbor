// SVG из assets/src → PNG в assets/. Запуск: cd scripts && npm i && npm run assets
import { readFile, writeFile, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Resvg } from '@resvg/resvg-js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (f) => path.join(root, 'assets/src', f);

// [исходник, результат, ширина в px]
const jobs = [
  ['logo-3d.svg', 'assets/logo-3d.png', 1024],               // основной логотип, прозрачный фон
  ['bot-avatar.svg', 'assets/bot-avatar.png', 640],          // @BotFather → /setuserpic
  ['miniapp-cover.svg', 'assets/miniapp-cover.png', 640],    // @BotFather → /newapp
  ['bot-description.svg', 'assets/bot-description.png', 640], // @BotFather → /setdescription
  ['logo.svg', 'assets/logo-512.png', 512],                  // универсальный логотип
];

// 3D-логотип хранится в одном файле; в макетах на его месте метка <g data-logo3d transform="…"/>
const logo3d = await readFile(src('logo-3d.svg'), 'utf8');
const logoBody = logo3d.slice(logo3d.indexOf('<!--BODY-->'), logo3d.indexOf('<!--/BODY-->'));
const injectLogo = (svg) => svg.replace(/<g data-logo3d (transform="[^"]*")\s*\/>/g, `<g $1>${logoBody}</g>`);

for (const [from, to, width] of jobs) {
  const svg = injectLogo(await readFile(src(from), 'utf8'));
  const png = new Resvg(svg, {
    fitTo: { mode: 'width', value: width },
    font: { loadSystemFonts: true, defaultFontFamily: 'Segoe UI' },
  }).render().asPng();
  await writeFile(path.join(root, to), png);
  console.log(`${to}  ${(png.length / 1024).toFixed(0)} KB`);
}

// иконка вкладки для Mini App
await copyFile(src('logo.svg'), path.join(root, 'webapp/public/favicon.svg'));
console.log('webapp/public/favicon.svg');
