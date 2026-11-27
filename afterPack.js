const { execSync } = require('child_process');
const path = require('path');
exports.default = async (ctx) => {
  if (ctx.electronPlatformName !== 'darwin') return;
  const app = path.join(ctx.appOutDir, `${ctx.packager.appInfo.productFilename}.app`);
  const id = ctx.packager.appInfo.id;
  // 1) подписываем все вложенные части (ad-hoc)
  execSync(`codesign --force --deep --sign - "${app}"`, { stdio: 'inherit' });
  // 2) переподписываем сам пакет с постоянным requirement: тогда macOS считает
  //    каждую новую сборку тем же приложением и не сбрасывает «Запись экрана»
  execSync(`codesign --force --sign - -r='designated => identifier "${id}"' "${app}"`, { stdio: 'inherit' });
  try { execSync(`codesign -dr - "${app}"`, { stdio: 'inherit' }); } catch (e) {}
};
