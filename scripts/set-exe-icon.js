// Coloca o ícone e as informações de versão no Telao.exe (sem precisar de Wine).
// Uso: node scripts/set-exe-icon.js <caminho do exe> <icone.ico>
const fs = require('fs');
const ResEdit = require('resedit');

const [, , exePath, icoPath] = process.argv;
const exe = ResEdit.NtExecutable.from(fs.readFileSync(exePath), { ignoreCert: true });
const res = ResEdit.NtExecutableResource.from(exe);
const ico = ResEdit.Data.IconFile.from(fs.readFileSync(icoPath));

const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
const groupId = groups.length ? groups[0].id : 1;
const lang = groups.length ? groups[0].lang : 1033;
ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, groupId, lang, ico.icons.map((i) => i.data));

const vi = ResEdit.Resource.VersionInfo.fromEntries(res.entries)[0];
if (vi) {
  const v = require('../package.json').version.split('.').map(Number);
  vi.setFileVersion(v[0], v[1], v[2], 0);
  vi.setProductVersion(v[0], v[1], v[2], 0);
  vi.setStringValues({ lang: 1033, codepage: 1200 }, {
    FileDescription: 'Telão', ProductName: 'Telão', CompanyName: 'Telão', OriginalFilename: 'Telao.exe', InternalName: 'Telao',
  });
  vi.outputToResourceEntries(res.entries);
}
res.outputResource(exe);
fs.writeFileSync(exePath, Buffer.from(exe.generate()));
console.log('ícone aplicado em', exePath);
