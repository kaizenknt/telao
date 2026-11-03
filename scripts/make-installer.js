// Monta o instalador com o NSIS nativo (makensis), sem Wine: node scripts/make-installer.js
const path = require('path');
const { execFileSync } = require('child_process');
const root = path.join(__dirname, '..');
const v = require('../package.json').version;
const out = path.join(root, 'dist', `Telao-Setup-${v}.exe`);
execFileSync('makensis', ['-V2', `-DVERSION=${v}`, `-DSRC=${path.join(root, 'dist', 'win-unpacked')}`,
  `-DICON=${path.join(root, 'src', 'assets', 'icon.ico')}`, `-DOUT=${out}`, path.join(__dirname, 'installer.nsi')], { stdio: 'inherit' });
console.log('instalador:', out);
