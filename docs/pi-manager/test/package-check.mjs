import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const artifacts = resolve('artifacts');
mkdirSync(artifacts, { recursive: true });
const report = JSON.parse(execFileSync(process.execPath, [process.env.npm_execpath, 'pack', '--json', '--pack-destination', artifacts], { encoding: 'utf8', windowsHide: true }));
const packed = Object.values(report)[0];
const packageFile = join(artifacts, packed.filename);
const staging = mkdtempSync(join(tmpdir(), 'pi-manager-package-'));
try {
  execFileSync('tar', ['-xf', packageFile, '-C', staging], { windowsHide: true });
  for (const file of packed.files) {
    assert.ok(!file.path.includes('node_modules') && !file.path.startsWith('test/'));
    if (!/\.(ts|mjs)$/.test(file.path)) continue;
    const source = readFileSync(join(staging, 'package', file.path), 'utf8');
    assert.ok(!/[A-Z]:[\\/]/.test(source), `固定本机路径: ${file.path}`);
    for (const match of source.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
      assert.ok(match[1].startsWith('.') || match[1].startsWith('node:') || match[1] === '@earendil-works/pi-coding-agent', `外部依赖: ${match[1]}`);
    }
  }
  execFileSync(process.execPath, ['--test', 'test/pi.test.mjs'], {
    stdio: 'inherit', windowsHide: true,
    env: { ...process.env, PI_MANAGER_TEST_ENTRY: pathToFileURL(join(staging, 'package', 'index.ts')).href },
  });
  console.log(`Validated independent package: ${packageFile}`);
} finally {
  rmSync(staging, { recursive: true, force: true });
}
