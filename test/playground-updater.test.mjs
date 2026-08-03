import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  compareVersions,
  injectIntegrationAssets,
  PlaygroundUpdater,
} from '../playground-updater.mjs';

test('playground updater builds into runtime and atomically activates the verified release', async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'codex-web-playground-updater-'));
  const runtimeDir = path.join(temporary, 'runtime');
  const packageDir = path.join(temporary, 'vendor', 'gpt-image-playground');
  const vendorDir = path.join(packageDir, 'app');
  const patchDir = path.join(packageDir, 'patches');
  const commandCalls = [];

  try {
    await mkdir(vendorDir, { recursive: true });
    await mkdir(patchDir, { recursive: true });
    await writeFile(path.join(packageDir, 'NOTICE.md'), '- Version: `0.7.1`\n- Commit: `eb91e4fb335ffee61f6b9db46d62ac8244c13d53`\n');
    await writeFile(path.join(vendorDir, 'sw.js'), 'self.registration.unregister();\n');
    await writeFile(path.join(vendorDir, 'codex-web-overrides.css'), '.codexWebUpdateButton { display: inline-flex; }\n');
    await writeFile(path.join(vendorDir, 'codex-web-integration.js'), 'void fetch("/api/playground-update/status");\n');
    await writeFile(path.join(patchDir, 'codex-web-v0.7.2.patch'), 'fixture patch\n');
    await mkdir(path.join(runtimeDir, 'current'), { recursive: true });
    await writeFile(
      path.join(runtimeDir, 'current', 'codex-web-version.json'),
      '{"tag":"v0.7.1","version":"0.7.1"}\n',
    );
    await writeFile(path.join(runtimeDir, 'current', 'old-hash.js'), 'old runtime asset\n');

    const runCommand = async (command, args, options) => {
      commandCalls.push([command, ...args]);
      if (command === 'git' && args[0] === 'clone') {
        await mkdir(args.at(-1), { recursive: true });
      }
      if (command === 'git' && args[0] === 'rev-parse') {
        return { stdout: 'aa789c3a11f1128e43d759cee2aadbf9afc3bc95\n', stderr: '' };
      }
      if (command === 'npm' && args[0] === 'run' && args[1] === 'build') {
        const dist = path.join(options.cwd, 'dist');
        await mkdir(path.join(dist, 'assets'), { recursive: true });
        await writeFile(
          path.join(dist, 'index.html'),
          '<!doctype html><html><head><title>GPT Image Playground</title><script type="module" src="./assets/main.js"></script></head><body></body></html>',
        );
        await writeFile(
          path.join(dist, 'assets', 'main.js'),
          'console.log("codex-web:playground-ready codex-web:image-prompt-applied /api/playground-config");',
        );
      }
      return { stdout: '', stderr: '' };
    };
    const updater = new PlaygroundUpdater({
      runtimeDir,
      vendorDir,
      patchDir,
      fetchImpl: async () => new Response(JSON.stringify({ tag_name: 'v0.7.2' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
      runCommand,
    });

    const started = await updater.startUpdate();
    assert.equal(started.status, 'updating');
    const status = await updater.waitForIdle();
    assert.equal(status.status, 'success');
    assert.equal(status.currentVersion, '0.7.2');
    assert.equal(status.currentSource, 'runtime');
    assert.equal(status.updateAvailable, false);
    assert.equal(commandCalls.filter(([command, action]) => command === 'git' && action === 'clone').length, 1);
    assert.ok(commandCalls.some((call) => call[0] === 'git' && call[1] === 'apply' && call[2] === '--check'));
    assert.ok(commandCalls.some((call) => call[0] === 'npm' && call[1] === 'test'));

    const activeIndex = await readFile(path.join(runtimeDir, 'current', 'index.html'), 'utf8');
    assert.match(activeIndex, /codex-web-overrides\.css/);
    assert.match(activeIndex, /codex-web-integration\.js/);
    assert.match(await readFile(path.join(runtimeDir, 'current', 'sw.js'), 'utf8'), /unregister/);
    assert.equal(await readFile(path.join(runtimeDir, 'previous', 'old-hash.js'), 'utf8'), 'old runtime asset\n');
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('playground updater keeps the active version when patch validation fails', async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'codex-web-playground-updater-failure-'));
  const runtimeDir = path.join(temporary, 'runtime');
  const packageDir = path.join(temporary, 'vendor', 'gpt-image-playground');
  const vendorDir = path.join(packageDir, 'app');
  const patchDir = path.join(packageDir, 'patches');

  try {
    await mkdir(path.join(runtimeDir, 'current'), { recursive: true });
    await mkdir(vendorDir, { recursive: true });
    await mkdir(patchDir, { recursive: true });
    await writeFile(
      path.join(runtimeDir, 'current', 'codex-web-version.json'),
      '{"tag":"v0.7.1","version":"0.7.1"}\n',
    );
    await writeFile(path.join(runtimeDir, 'current', 'active.js'), 'keep me\n');
    await writeFile(path.join(patchDir, 'codex-web-v0.7.2.patch'), 'fixture patch\n');

    const updater = new PlaygroundUpdater({
      runtimeDir,
      vendorDir,
      patchDir,
      fetchImpl: async () => new Response(JSON.stringify({ tag_name: 'v0.7.2' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
      runCommand: async (command, args) => {
        if (command === 'git' && args[0] === 'clone') await mkdir(args.at(-1), { recursive: true });
        if (command === 'git' && args[0] === 'rev-parse') {
          return { stdout: 'aa789c3a11f1128e43d759cee2aadbf9afc3bc95\n', stderr: '' };
        }
        if (command === 'git' && args[0] === 'apply' && args[1] === '--check') {
          throw new Error('patch does not apply');
        }
        return { stdout: '', stderr: '' };
      },
    });

    await updater.startUpdate();
    const status = await updater.waitForIdle();
    assert.equal(status.status, 'error');
    assert.equal(status.currentVersion, '0.7.1');
    assert.match(status.error, /patch does not apply/);
    assert.equal(await readFile(path.join(runtimeDir, 'current', 'active.js'), 'utf8'), 'keep me\n');
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('playground updater coalesces concurrent starts during async preflight', async () => {
  let releaseFetchCalls = 0;
  let updateCalls = 0;
  let releaseFetchResolve;
  let updateResolve;
  const releaseFetchGate = new Promise((resolve) => {
    releaseFetchResolve = resolve;
  });
  const updateGate = new Promise((resolve) => {
    updateResolve = resolve;
  });
  const updater = new PlaygroundUpdater({
    runtimeDir: path.join(tmpdir(), 'codex-web-playground-concurrent-runtime'),
    vendorDir: path.join(tmpdir(), 'codex-web-playground-concurrent-vendor'),
    patchDir: path.join(tmpdir(), 'codex-web-playground-concurrent-patches'),
  });
  updater.readCurrentVersion = async () => ({ version: '0.7.1', tag: 'v0.7.1', source: 'runtime' });
  updater.fetchLatestRelease = async ({ force = false } = {}) => {
    releaseFetchCalls += 1;
    assert.equal(force, true);
    await releaseFetchGate;
    return { version: '0.7.2', tag: 'v0.7.2' };
  };
  updater.performUpdate = async () => {
    updateCalls += 1;
    await updateGate;
    return { version: '0.7.2', tag: 'v0.7.2', updatedAt: '2026-07-31T00:00:00.000Z' };
  };

  const first = updater.startUpdate();
  const second = updater.startUpdate();
  let idleResolved = false;
  const idle = updater.waitForIdle().then((result) => {
    idleResolved = true;
    return result;
  });
  await Promise.resolve();
  assert.equal(releaseFetchCalls, 1);
  assert.equal(idleResolved, false);
  releaseFetchResolve();
  const started = await Promise.all([first, second]);
  assert.deepEqual(started.map((status) => status.status), ['updating', 'updating']);
  await Promise.resolve();
  assert.equal(idleResolved, false);
  updateResolve();
  const completed = await idle;
  assert.equal(completed.status, 'success');
  assert.equal(updateCalls, 1);
});

test('playground updater can force a release refresh without discarding its cache first', async () => {
  let releaseFetchCalls = 0;
  const updater = new PlaygroundUpdater({
    runtimeDir: path.join(tmpdir(), 'codex-web-playground-refresh-runtime'),
    vendorDir: path.join(tmpdir(), 'codex-web-playground-refresh-vendor'),
    patchDir: path.join(tmpdir(), 'codex-web-playground-refresh-patches'),
    fetchImpl: async () => {
      releaseFetchCalls += 1;
      const tag = releaseFetchCalls === 1 ? 'v0.7.2' : 'v0.7.3';
      return new Response(JSON.stringify({ tag_name: tag }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });
  updater.readCurrentVersion = async () => ({ version: '0.7.1', tag: 'v0.7.1', source: 'runtime' });

  assert.equal((await updater.getStatus()).latestVersion, '0.7.2');
  assert.equal((await updater.getStatus()).latestVersion, '0.7.2');
  assert.equal(releaseFetchCalls, 1);
  assert.equal((await updater.getStatus({ refresh: true })).latestVersion, '0.7.3');
  assert.equal(releaseFetchCalls, 2);
});

test('playground updater reads the served previous version while current is absent', async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'codex-web-playground-previous-'));
  const runtimeDir = path.join(temporary, 'runtime');
  const packageDir = path.join(temporary, 'vendor', 'gpt-image-playground');
  try {
    await mkdir(path.join(runtimeDir, 'previous'), { recursive: true });
    await mkdir(path.join(packageDir, 'app'), { recursive: true });
    await writeFile(
      path.join(runtimeDir, 'previous', 'codex-web-version.json'),
      '{"tag":"v0.7.2","version":"0.7.2"}\n',
    );
    await writeFile(path.join(packageDir, 'NOTICE.md'), '- Version: `0.7.1`\n');
    const updater = new PlaygroundUpdater({
      runtimeDir,
      vendorDir: path.join(packageDir, 'app'),
      patchDir: path.join(packageDir, 'patches'),
    });

    const current = await updater.readCurrentVersion();
    assert.equal(current.version, '0.7.2');
    assert.equal(current.source, 'runtime');
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('playground updater helpers accept only ordered stable versions and inject assets once', () => {
  assert.ok(compareVersions('0.7.2', '0.7.1') > 0);
  assert.equal(compareVersions('v0.7.2', '0.7.2'), 0);
  assert.ok(compareVersions('0.7.1', '0.7.2') < 0);

  const once = injectIntegrationAssets('<html><head></head><body></body></html>');
  const twice = injectIntegrationAssets(once);
  assert.equal((twice.match(/codex-web-overrides\.css/g) || []).length, 1);
  assert.equal((twice.match(/codex-web-integration\.js/g) || []).length, 1);
  assert.match(twice, /v=20260803-1/);
});

test('playground updater requires a patch made for the target version', async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'codex-web-playground-updater-patch-'));
  const patchDir = path.join(temporary, 'patches');
  try {
    await mkdir(patchDir, { recursive: true });
    await writeFile(path.join(patchDir, 'codex-web.patch'), 'generic old patch\n');
    await writeFile(path.join(patchDir, 'codex-web-v0.7.2.patch'), 'previous patch\n');
    const updater = new PlaygroundUpdater({
      runtimeDir: path.join(temporary, 'runtime'),
      vendorDir: path.join(temporary, 'vendor'),
      patchDir,
    });
    await assert.rejects(
      updater.resolvePatchFile('0.7.3'),
      /缺少 v0\.7\.3 的 Codex Web 生图工作台兼容补丁/,
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
