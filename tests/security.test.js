const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

test('renderer stays sandboxed behind a strict local-only CSP', () => {
  const main = read('main.js');
  const html = read('src/index.html');
  const renderer = read('src/renderer.js');

  assert.match(main, /contextIsolation:\s*true/);
  assert.match(main, /nodeIntegration:\s*false/);
  assert.match(main, /sandbox:\s*true/);
  assert.match(main, /webviewTag:\s*false/);
  assert.match(main, /setPermissionRequestHandler\([\s\S]*callback\(false\)/);
  assert.match(main, /setPermissionCheckHandler\(\(\) => false\)/);
  assert.match(main, /will-attach-webview/);
  assert.match(main, /protocol\.registerSchemesAsPrivileged/);
  assert.match(main, /protocol\.handle\(APP_SCHEME/);
  assert.match(main, /APP_ASSETS\.has\(url\.pathname\)/);
  assert.match(main, /mainWindow\.loadURL\(APP_ENTRY_URL\)/);
  assert.doesNotMatch(main, /mainWindow\.loadFile\(/);
  assert.match(html, /connect-src 'none'/);
  assert.doesNotMatch(renderer, /\.innerHTML\s*=/);
});

test('AI IPC exposes narrow operations and the main process owns source construction', () => {
  const main = read('main.js');
  const preload = read('preload.js');

  [
    'ai:get-settings',
    'ai:save-settings',
    'ai:set-key',
    'ai:clear-key',
    'ai:generate-report',
    'ai:cancel',
  ].forEach((channel) => assert.match(main, new RegExp(`ipcMain\\.handle\\('${channel.replace(':', '\\:')}'`)));

  assert.match(main, /todoStore\.getSnapshot\(\)/);
  assert.match(main, /buildReportSourceData\(store,/);
  assert.match(main, /confirmAiReportTransfer\(options\)/);
  assert.match(main, /fetch:\s*\(\.\.\.args\) => net\.fetch\(\.\.\.args\)/);
  assert.doesNotMatch(preload, /ipcRenderer\s*:\s*ipcRenderer/);
  assert.doesNotMatch(preload, /\binvoke\s*:\s*\(/);
  assert.doesNotMatch(preload, /fetch\s*:/);
  assert.doesNotMatch(preload, /endpoint\s*:/);
  assert.doesNotMatch(preload, /Authorization/);
});

test('end-of-day notification uses the narrow preload route to open shutdown', () => {
  const main = read('main.js');
  const preload = read('preload.js');
  const renderer = read('src/renderer.js');

  assert.match(main, /notification\.on\('click', showAndFocusDailyShutdown\)/);
  assert.match(main, /webContents\.send\('app:open-daily-shutdown'\)/);
  assert.match(preload, /onOpenDailyShutdown:[\s\S]*app:open-daily-shutdown/);
  assert.match(renderer, /bridge\.onOpenDailyShutdown\(\(\) =>/);
});

test('release build enables hardened runtime, ASAR integrity, and dangerous-fuse shutdowns', () => {
  const packageJson = JSON.parse(read('package.json'));
  const build = packageJson.build;
  assert.equal(build.asar, true);
  assert.equal(build.mac.hardenedRuntime, true);
  assert.equal(build.electronFuses.runAsNode, false);
  assert.equal(build.electronFuses.enableNodeOptionsEnvironmentVariable, false);
  assert.equal(build.electronFuses.enableNodeCliInspectArguments, false);
  assert.equal(build.electronFuses.enableEmbeddedAsarIntegrityValidation, true);
  assert.equal(build.electronFuses.onlyLoadAppFromAsar, true);
  assert.equal(build.electronFuses.grantFileProtocolExtraPrivileges, false);
});
