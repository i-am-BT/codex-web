import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { homedir, tmpdir } from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DREAM_SKIN_DIR = path.join(ROOT, 'vendor', 'codex-dream-skin');
const SOURCE_FILE = path.join(DREAM_SKIN_DIR, 'background-generation-prompts.md');
const OUTPUT_DIR = path.join(DREAM_SKIN_DIR, 'wallpapers');
const CODEX_HOME = path.resolve(process.env.CODEX_HOME || path.join(homedir(), '.codex'));
const CONFIG_FILE = path.resolve(process.env.CODEX_CONFIG_FILE || path.join(CODEX_HOME, 'config.toml'));
const ENV_FILE = path.resolve(process.env.CODEX_ENV_FILE || path.join(CODEX_HOME, '.env'));
const force = process.argv.includes('--force');
const requested = process.argv.slice(2).filter((value) => /^skin-0[1-8]$/.test(value));

if (!existsSync(SOURCE_FILE)) throw new Error(`Dream Skin prompt source not found: ${SOURCE_FILE}`);
if (!existsSync(CONFIG_FILE)) throw new Error(`Codex config not found: ${CONFIG_FILE}`);

const concepts = readConcepts(readFileSync(SOURCE_FILE, 'utf8'));
const selected = requested.length ? concepts.filter((concept) => requested.includes(concept.id)) : concepts;
const provider = readProvider();
mkdirSync(OUTPUT_DIR, { recursive: true });

for (const concept of selected) {
  const destination = path.join(OUTPUT_DIR, `${concept.id}.jpg`);
  if (existsSync(destination) && !force) {
    console.log(`${concept.id}: already exists`);
    continue;
  }
  console.log(`${concept.id}: generating ${concept.name}`);
  const image = await generateImage(provider, concept.prompt);
  const extension = image[0] === 0xff && image[1] === 0xd8 ? 'jpg' : 'png';
  const stamp = `${process.pid}-${Date.now()}-${concept.id}`;
  const source = path.join(tmpdir(), `codex-dream-skin-${stamp}.${extension}`);
  const cropped = path.join(tmpdir(), `codex-dream-skin-${stamp}-cropped.jpg`);
  const finished = path.join(tmpdir(), `codex-dream-skin-${stamp}-finished.jpg`);
  writeFileSync(source, image, { mode: 0o600 });
  try {
    runSips(['-c', '864', '1536', source, '--out', cropped]);
    runSips(['-z', '1440', '2560', '-s', 'format', 'jpeg', '-s', 'formatOptions', '92', cropped, '--out', finished]);
    renameSync(finished, destination);
  } finally {
    if (existsSync(source)) unlinkSync(source);
    if (existsSync(cropped)) unlinkSync(cropped);
    if (existsSync(finished)) unlinkSync(finished);
  }
  console.log(`${concept.id}: saved ${path.relative(ROOT, destination)}`);
}

function readConcepts(source) {
  const headings = [...source.matchAll(/^## (skin-0[1-8])｜([^\n]+)$/gm)];
  return headings.map((heading, index) => {
    const body = source.slice(heading.index + heading[0].length, headings[index + 1]?.index ?? source.length);
    const prompt = body.match(/```text\r?\n([\s\S]*?)\r?\n```/)?.[1]?.trim() || '';
    return { id: heading[1], name: heading[2].trim(), prompt };
  }).filter((concept) => concept.prompt);
}

function readProvider() {
  const config = readFileSync(CONFIG_FILE, 'utf8');
  const providerName = process.env.DREAM_SKIN_PROVIDER
    || config.match(/^model_provider\s*=\s*"([^"]+)"/m)?.[1]
    || '';
  if (!providerName) throw new Error('Codex model_provider is not configured');
  const escaped = providerName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const header = new RegExp(`^\\[model_providers\\.${escaped}\\]\\s*$`, 'm').exec(config);
  const tail = header ? config.slice(header.index + header[0].length) : '';
  const nextTable = tail.search(/^\s*\[/m);
  const block = nextTable === -1 ? tail : tail.slice(0, nextTable);
  const baseUrl = block.match(/^base_url\s*=\s*"([^"]+)"/m)?.[1] || '';
  const envKey = block.match(/^env_key\s*=\s*"([^"]+)"/m)?.[1] || `${providerName.toUpperCase()}_API_KEY`;
  const bearerToken = block.match(/^experimental_bearer_token\s*=\s*"([^"]+)"/m)?.[1] || '';
  const apiKey = process.env[envKey] || readEnv(ENV_FILE, envKey) || bearerToken;
  if (!baseUrl) throw new Error(`Provider ${providerName} has no base_url`);
  if (!apiKey) throw new Error(`Provider credential ${envKey} is not configured`);
  return {
    apiKey,
    endpoint: `${baseUrl.replace(/\/+$/, '')}/images/generations`,
    model: process.env.DREAM_SKIN_MODEL || 'gpt-image-2',
  };
}

function readEnv(file, key) {
  if (!existsSync(file)) return '';
  const line = readFileSync(file, 'utf8').split(/\r?\n/).find((item) => item.match(/^\s*([^#=]+?)\s*=/)?.[1] === key);
  if (!line) return '';
  const value = line.slice(line.indexOf('=') + 1).trim();
  if (value.startsWith('"') && value.endsWith('"')) {
    try { return JSON.parse(value); } catch {}
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
  return value;
}

async function generateImage(provider, prompt) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 600000);
  try {
    const response = await fetch(provider.endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${provider.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: provider.model,
        prompt: `${prompt}\n\nReturn exactly one standalone wallpaper image. No UI, no text, no logo, no watermark.`,
        n: 1,
        size: '1536x1024',
        quality: 'high',
        response_format: 'b64_json',
      }),
      signal: controller.signal,
    });
    const body = await response.text();
    if (!response.ok) throw new Error(`Image API HTTP ${response.status}: ${body.slice(0, 500)}`);
    const payload = JSON.parse(body);
    const first = payload.data?.[0];
    if (first?.b64_json) return Buffer.from(first.b64_json.replace(/^data:image\/\w+;base64,/, ''), 'base64');
    if (first?.url) {
      const imageResponse = await fetch(first.url, { signal: controller.signal });
      if (!imageResponse.ok) throw new Error(`Image download HTTP ${imageResponse.status}`);
      return Buffer.from(await imageResponse.arrayBuffer());
    }
    throw new Error('Image API returned neither b64_json nor url');
  } finally {
    clearTimeout(timeout);
  }
}

function runSips(args) {
  const result = spawnSync('/usr/bin/sips', args, { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || 'sips failed');
}
