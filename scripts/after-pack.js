// electron-builder: põe o ícone no Telao.exe antes de montar o instalador (sem Wine).
const path = require('path');
const { execFileSync } = require('child_process');
exports.default = async function (ctx) {
  if (ctx.electronPlatformName !== 'win32') return;
  const exe = path.join(ctx.appOutDir, 'Telao.exe');
  execFileSync(process.execPath, [path.join(__dirname, 'set-exe-icon.js'), exe, path.join(__dirname, '..', 'src', 'assets', 'icon.ico')], { stdio: 'inherit' });
};
