import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  ImagePromptLibrary,
} from '../image-prompt-library.mjs';

const BUILTIN_REVISION = 'a'.repeat(40);
const UPDATED_REVISION = 'b'.repeat(40);

test('downloads a pinned GitHub revision and reloads it from runtime cache', async () => {
  const fixture = await createFixture();
  const requested = [];
  const updatedCases = caseData([{ id: 2, prompt: 'updated prompt' }, { id: 3, prompt: 'second prompt' }]);
  const updatedStyles = styleData([{ id: 'template-2', title: { zh: '新模板' } }], 2);
  const fetchImpl = async (url) => {
    requested.push(url);
    if (url.includes('/commits/main')) return jsonResponse({ sha: UPDATED_REVISION });
    if (url.endsWith('/data/cases.json')) return jsonResponse(updatedCases);
    if (url.endsWith('/data/style-library.json')) return jsonResponse(updatedStyles);
    return jsonResponse({}, 404);
  };

  try {
    const library = new ImagePromptLibrary({
      ...fixture,
      builtInRevision: BUILTIN_REVISION,
      fetchImpl,
      autoSync: false,
      now: () => new Date('2026-07-17T05:30:00.000Z'),
    });
    assert.equal(library.getLibrary().sync.source, 'bundled');

    const status = await library.sync({ reason: 'test' });
    assert.equal(status.revision, UPDATED_REVISION);
    assert.equal(status.source, 'github');
    assert.equal(status.status, 'ready');
    assert.equal(status.updatedAt, '2026-07-17T05:30:00.000Z');
    assert.equal(library.getLibrary().totalCases, 2);
    assert.equal(library.getLibrary().totalTemplates, 1);
    assert.match(library.getLibrary().imageBaseUrl, new RegExp(UPDATED_REVISION));
    assert.ok(requested.some((url) => url.includes(`/${UPDATED_REVISION}/data/cases.json`)));
    assert.ok(requested.some((url) => url.includes(`/${UPDATED_REVISION}/data/style-library.json`)));

    const state = JSON.parse(await readFile(path.join(fixture.cacheDir, 'state.json'), 'utf8'));
    assert.equal(state.revision, UPDATED_REVISION);
    assert.equal(state.reason, 'test');

    const restored = new ImagePromptLibrary({
      ...fixture,
      builtInRevision: BUILTIN_REVISION,
      fetchImpl: async () => {
        throw new Error('cache restore must not access the network');
      },
      autoSync: false,
    });
    assert.equal(restored.getLibrary().sync.source, 'github');
    assert.equal(restored.getLibrary().revision, UPDATED_REVISION);
    assert.equal(restored.getLibrary().cases[0].prompt, 'updated prompt');
  } finally {
    await rm(fixture.temporary, { recursive: true, force: true });
  }
});

test('keeps the active library when a GitHub update is invalid', async () => {
  const fixture = await createFixture();
  const library = new ImagePromptLibrary({
    ...fixture,
    builtInRevision: BUILTIN_REVISION,
    fetchImpl: async (url) => {
      if (url.includes('/commits/main')) return jsonResponse({ sha: UPDATED_REVISION });
      if (url.endsWith('/data/cases.json')) return jsonResponse(caseData([]));
      return jsonResponse(styleData([]));
    },
    autoSync: false,
    now: () => new Date('2026-07-17T06:00:00.000Z'),
  });

  try {
    await assert.rejects(library.sync({ reason: 'test-invalid' }), /提示词数据为空/);
    const active = library.getLibrary();
    assert.equal(active.revision, BUILTIN_REVISION);
    assert.equal(active.totalCases, 1);
    assert.equal(active.sync.source, 'bundled');
    assert.equal(active.sync.status, 'error');
    assert.match(active.sync.error, /提示词数据为空/);
  } finally {
    await rm(fixture.temporary, { recursive: true, force: true });
  }
});

test('checks GitHub without downloading data when the revision is unchanged', async () => {
  const fixture = await createFixture();
  const requested = [];
  const library = new ImagePromptLibrary({
    ...fixture,
    builtInRevision: BUILTIN_REVISION,
    fetchImpl: async (url) => {
      requested.push(url);
      return jsonResponse({ sha: BUILTIN_REVISION });
    },
    autoSync: false,
    now: () => new Date('2026-07-17T06:30:00.000Z'),
  });

  try {
    const status = await library.sync({ reason: 'test-current' });
    assert.equal(status.status, 'ready');
    assert.equal(status.source, 'bundled');
    assert.equal(status.checkedAt, '2026-07-17T06:30:00.000Z');
    assert.deepEqual(requested, [
      'https://api.github.com/repos/freestylefly/awesome-gpt-image-2/commits/main',
    ]);
  } finally {
    await rm(fixture.temporary, { recursive: true, force: true });
  }
});

test('sends an optional GitHub token only to the API origin', async () => {
  const fixture = await createFixture();
  const requests = [];
  const library = new ImagePromptLibrary({
    ...fixture,
    builtInRevision: BUILTIN_REVISION,
    githubToken: 'test-github-token',
    fetchImpl: async (url, options) => {
      requests.push({ url, authorization: options.headers.Authorization });
      if (url.includes('/commits/main')) return jsonResponse({ sha: UPDATED_REVISION });
      if (url.endsWith('/data/cases.json')) return jsonResponse(caseData([{ id: 2, prompt: 'updated' }]));
      return jsonResponse(styleData([{ id: 'template-2' }]));
    },
    autoSync: false,
  });

  try {
    await library.sync({ reason: 'test-token' });
    assert.equal(requests[0].authorization, 'Bearer test-github-token');
    assert.equal(requests[1].authorization, undefined);
    assert.equal(requests[2].authorization, undefined);
  } finally {
    await rm(fixture.temporary, { recursive: true, force: true });
  }
});

test('retries an automatic sync after a transient startup failure', async () => {
  const fixture = await createFixture();
  let attempts = 0;
  const library = new ImagePromptLibrary({
    ...fixture,
    builtInRevision: BUILTIN_REVISION,
    fetchImpl: async () => {
      attempts += 1;
      if (attempts === 1) {
        const error = new TypeError('fetch failed');
        error.cause = { code: 'ENETDOWN' };
        throw error;
      }
      return jsonResponse({ sha: BUILTIN_REVISION });
    },
    autoSync: true,
    intervalMs: 20,
    logger: { warn() {} },
  });

  try {
    library.start();
    await waitFor(() => attempts >= 2 && library.getStatus().status === 'ready');
    assert.ok(attempts >= 2);
    assert.equal(library.getStatus().error, '');
  } finally {
    library.stop();
    await rm(fixture.temporary, { recursive: true, force: true });
  }
});

async function createFixture() {
  const temporary = await mkdtemp(path.join(tmpdir(), 'codex-web-image-prompts-'));
  const vendorDir = path.join(temporary, 'vendor');
  await mkdir(vendorDir, { recursive: true });
  const casesFile = path.join(vendorDir, 'cases.json');
  const stylesFile = path.join(vendorDir, 'styles.json');
  await writeFile(casesFile, JSON.stringify(caseData([{ id: 1, prompt: 'bundled prompt' }])), 'utf8');
  await writeFile(stylesFile, JSON.stringify(styleData([{ id: 'template-1', title: { zh: '内置模板' } }])), 'utf8');
  return {
    temporary,
    cacheDir: path.join(temporary, 'runtime', 'image-prompts'),
    casesFile,
    stylesFile,
  };
}

function caseData(cases) {
  return {
    repository: 'https://github.com/freestylefly/awesome-gpt-image-2',
    cases,
  };
}

function styleData(templates, version = 1) {
  return {
    version,
    categories: [{ value: 'UI & Interfaces', title: { zh: 'UI 与界面' } }],
    styles: [],
    scenes: [],
    templates,
  };
}

function jsonResponse(value, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return value;
    },
  };
}

async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
