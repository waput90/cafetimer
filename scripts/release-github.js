const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const repository = String(process.env.GITHUB_REPOSITORY || '').trim();
const [owner, repo, extra] = repository.split('/');
if (!owner || !repo || extra) throw new Error('GITHUB_REPOSITORY must use the owner/repository format.');
if (!process.env.GH_TOKEN) throw new Error('GH_TOKEN is required to publish a GitHub Release.');

const projectDir = path.resolve(__dirname, '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(projectDir, 'package.json'), 'utf8'));
const configPath = path.join(os.tmpdir(), `cafetimer-release-${process.pid}.json`);
const config = {
  ...packageJson.build,
  publish: [{ provider: 'github', owner, repo, releaseType: 'release' }]
};

try {
  fs.writeFileSync(configPath, JSON.stringify(config));
  execFileSync(process.execPath, [
    require.resolve('electron-builder/cli.js'),
    '--projectDir', projectDir,
    '--config', configPath,
    '--win', 'nsis',
    '--publish', 'always'
  ], { cwd: projectDir, env: process.env, stdio: 'inherit' });
} finally {
  fs.rmSync(configPath, { force: true });
}
