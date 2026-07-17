const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const projectDir = path.resolve(__dirname, '..');
const deliveryDir = path.join(projectDir, 'dist');
const directoryOnly = process.argv.includes('--dir');
const artifactPattern = /^Daymark-.*\.(?:dmg|zip)(?:\.blockmap)?$/;
const checksumName = 'SHA256SUMS.txt';

if (process.platform !== 'darwin') {
  console.error('Daymark 的当前交付构建仅支持 macOS。');
  process.exit(1);
}

const buildRoot = directoryOnly
  ? path.join(os.tmpdir(), 'daymark-pack-arm64')
  : fs.mkdtempSync(path.join(os.tmpdir(), 'daymark-builder-'));
const outputDir = directoryOnly ? buildRoot : path.join(buildRoot, 'output');
const builder = path.join(projectDir, 'node_modules', '.bin', 'electron-builder');

if (directoryOnly) fs.rmSync(buildRoot, { recursive: true, force: true });

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: projectDir,
    stdio: 'inherit',
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} 执行失败，退出码 ${result.status || 1}`);
  }
}

function replaceFile(source, target) {
  const temporaryTarget = `${target}.tmp`;
  fs.copyFileSync(source, temporaryTarget);
  fs.renameSync(temporaryTarget, target);
}

function sha256(target) {
  return createHash('sha256').update(fs.readFileSync(target)).digest('hex');
}

try {
  const args = [`--config.directories.output=${outputDir}`];
  if (directoryOnly) args.unshift('--dir');
  run(builder, args);

  const sourceApp = path.join(outputDir, 'mac-arm64', 'Daymark.app');
  run('codesign', ['--verify', '--deep', '--strict', sourceApp]);
  run(path.join(sourceApp, 'Contents', 'MacOS', 'Daymark'), ['--smoke-test']);

  if (!directoryOnly) {
    fs.mkdirSync(deliveryDir, { recursive: true });
    const artifacts = fs.readdirSync(outputDir).filter((name) => artifactPattern.test(name));

    if (!artifacts.some((name) => name.endsWith('.dmg'))
      || !artifacts.some((name) => name.endsWith('.zip'))) {
      throw new Error('构建结束，但没有同时找到 DMG 和 ZIP 安装包。');
    }

    for (const name of fs.readdirSync(deliveryDir)) {
      if (artifactPattern.test(name) && !artifacts.includes(name)) {
        fs.rmSync(path.join(deliveryDir, name), { force: true });
      }
    }

    for (const name of artifacts) {
      replaceFile(path.join(outputDir, name), path.join(deliveryDir, name));
    }

    const distributables = artifacts.filter((name) => /\.(?:dmg|zip)$/.test(name)).sort();
    distributables
      .filter((name) => name.endsWith('.dmg'))
      .forEach((name) => run('hdiutil', ['verify', path.join(deliveryDir, name)]));
    const checksums = `${distributables.map((name) => `${sha256(path.join(deliveryDir, name))}  ${name}`).join('\n')}\n`;
    fs.writeFileSync(path.join(deliveryDir, checksumName), checksums, { encoding: 'utf8', mode: 0o644 });
    fs.chmodSync(path.join(deliveryDir, checksumName), 0o644);

    // An unpacked .app under Documents can be mutated by macOS File Provider.
    // The signed application is therefore delivered only inside DMG/ZIP archives.
    fs.rmSync(path.join(deliveryDir, 'mac-arm64'), { recursive: true, force: true });
    console.log(`已生成 ${distributables.length} 个安装包及 SHA-256 校验文件到 ${deliveryDir}`);
  } else {
    console.log(`已生成临时验收应用到 ${path.dirname(sourceApp)}`);
  }
} finally {
  if (!directoryOnly) fs.rmSync(buildRoot, { recursive: true, force: true });
}
