const { _electron } = require('playwright'); const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '../../desktop'); const UD = fs.mkdtempSync(path.join(require('os').tmpdir(), 'neura-ud-'));
(async () => {
  const app = await _electron.launch({ executablePath: require(ROOT + '/node_modules/electron'), cwd: ROOT, args: [ROOT, '--user-data-dir=' + UD] });
  const w = await app.firstWindow(); await w.waitForSelector('#target', { state: 'attached' });
  await w.setInputFiles('#fileIn', path.join(__dirname, 'fixtures/tabla.jpg')); await w.waitForSelector('#attachBar .chip');
  await w.waitForFunction(() => attach[0]?.ref, null, { timeout: 5000 }).catch(() => {});
  const r = await w.evaluate(async () => ({ ref: attach[0]?.ref, keys: (await blobs.keys()).length, warn: !document.querySelector('#saveWarn').hidden }));
  console.log(r.ref && r.keys === 1 && !r.warn ? '✓ PC: la imagen se guarda en IndexedDB (file://)' : '✗ PC IndexedDB ' + JSON.stringify(r));
  await app.close(); process.exit(0);
})();
