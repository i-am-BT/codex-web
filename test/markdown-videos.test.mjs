import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { marked } from 'marked';
import { normalizeAbsoluteLocalMp4Link } from '../message-media.mjs';

const serverSource = await readFile(new URL('../server.mjs', import.meta.url), 'utf8');
const cssSource = await readFile(new URL('../ui.css', import.meta.url), 'utf8');

class FakeClassList {
  constructor() { this.values = new Set(); }
  add(...values) { for (const value of values) this.values.add(value); }
  contains(value) { return this.values.has(value); }
}

class FakeElement {
  constructor(tagName = 'span') {
    this.tagName = tagName.toUpperCase();
    this.dataset = {};
    this.classList = new FakeClassList();
    this.attributes = new Map();
    this.children = [];
    this.nextElementSibling = null;
    this.textContent = '';
  }
  set className(value) {
    this.classList = new FakeClassList();
    for (const name of String(value || '').split(/\s+/).filter(Boolean)) this.classList.add(name);
  }
  get className() { return [...this.classList.values].join(' '); }
  set href(value) { this.attributes.set('href', String(value)); }
  get href() { return this.attributes.get('href') || ''; }
  set src(value) { this.attributes.set('src', String(value)); }
  get src() { return this.attributes.get('src') || ''; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) || null; }
  hasAttribute(name) { return this.attributes.has(name); }
  removeAttribute(name) { this.attributes.delete(name); }
  appendChild(child) { this.children.push(child); return child; }
  addEventListener() {}
  after(node) { this.nextElementSibling = node; }
  querySelector(selector) {
    if (selector === ':scope > video') return this.children.find((child) => child.tagName === 'VIDEO') || null;
    return null;
  }
}

function videoHelpers() {
  const start = serverSource.indexOf('function normalizeMarkdownLocalVideoTarget');
  const end = serverSource.indexOf('\nlet chatLinkMenu=null', start);
  assert.ok(start >= 0 && end > start, 'video helper source');
  const window = { marked };
  const document = { createElement: (tagName) => new FakeElement(tagName) };
  return new Function(
    'window',
    'document',
    `${serverSource.slice(start, end)}; return { enhanceMarkdownVideos, markdownLocalVideoTargets, nativeMessageVideoUrl, normalizeMarkdownLocalVideoTarget };`,
  )(window, document);
}

test('assistant MP4 links become message-authorized players without exposing a path in requests', () => {
  const { enhanceMarkdownVideos } = videoHelpers();
  const rawHtml = new FakeElement('a');
  rawHtml.dataset.linkUrl = '/root/raw-html.mp4';
  const first = new FakeElement('a');
  first.dataset.linkUrl = '/tmp/first%20clip.mp4';
  first.textContent = '第一段';
  const remote = new FakeElement('a');
  remote.dataset.linkUrl = 'https://example.com/remote.mp4';
  const second = new FakeElement('a');
  second.dataset.linkUrl = '/mnt/media/second.MP4';
  second.textContent = '第二段';
  const row = { dataset: {} };
  const body = {
    closest: () => row,
    querySelectorAll: () => [rawHtml, first, remote, second],
  };
  const markdown = [
    '<a href="/root/raw-html.mp4">raw html is not authorized</a>',
    '[第一段](/tmp/first%20clip.mp4)',
    '[远程](https://example.com/remote.mp4)',
    '[第二段](/mnt/media/second.MP4)',
  ].join('\n');
  const context = {
    threadId: '11111111-1111-1111-1111-111111111111',
    messageSeq: 42,
    generation: 7,
  };

  enhanceMarkdownVideos(body, context, markdown);

  assert.equal(rawHtml.nextElementSibling, null);
  assert.equal(remote.nextElementSibling, null);
  for (const [link, index] of [[first, 1], [second, 2]]) {
    const expected = `/api/native-sessions/${context.threadId}/messages/42/videos/${index}?generation=7`;
    assert.equal(link.href, expected);
    assert.equal(link.href.includes('path='), false);
    assert.equal(link.href.includes('.mp4'), false);
    assert.equal(link.dataset.messageMediaUrl, expected);
    assert.ok(link.classList.contains('markdownLocalVideoLink'));
    const wrapper = link.nextElementSibling;
    assert.ok(wrapper.classList.contains('markdownLocalVideo'));
    const video = wrapper.querySelector(':scope > video');
    assert.equal(video.src, expected);
    assert.equal(video.controls, true);
    assert.equal(video.playsInline, true);
    assert.equal(video.preload, 'metadata');
    assert.equal(video.hasAttribute('playsinline'), true);
  }

  enhanceMarkdownVideos(body, context, markdown);
  assert.equal(first.nextElementSibling.children.length, 1, 'enhancement stays idempotent');
  assert.equal(second.nextElementSibling.children.length, 1, 'enhancement stays idempotent');
});

test('browser and server use identical local MP4 candidate normalization', () => {
  const { normalizeMarkdownLocalVideoTarget, markdownLocalVideoTargets } = videoHelpers();
  const longUnicodePath = '/tmp/' + '视'.repeat(1364) + '.mp4';
  const cases = [
    '/tmp/.mp4',
    '/tmp/real.mp4',
    longUnicodePath,
    '/tmp/a/./b/../clip.mp4',
    '/tmp/first%20clip.mp4',
    '//server/share/video.mp4',
    './relative.mp4',
    '/tmp/video.mp4?download=1',
    '/tmp/video.mp4#preview',
    '/tmp/%E8%A7%86%E9%A2%91.mp4',
  ];
  for (const candidate of cases) {
    assert.equal(
      normalizeMarkdownLocalVideoTarget(candidate),
      normalizeAbsoluteLocalMp4Link(candidate),
      candidate,
    );
  }

  const markdown = cases.map((candidate, index) => `[${index}](${candidate})`).join('\n');
  assert.deepEqual(
    markdownLocalVideoTargets(markdown),
    cases.map((candidate) => normalizeAbsoluteLocalMp4Link(candidate)).filter(Boolean),
  );
});

test('video enhancement requires a persisted native message identity', () => {
  const { enhanceMarkdownVideos, markdownLocalVideoTargets, nativeMessageVideoUrl } = videoHelpers();
  const link = new FakeElement('a');
  link.dataset.linkUrl = '/data/render.mp4';
  const body = {
    closest: () => ({ dataset: {} }),
    querySelectorAll: () => [link],
  };
  const markdown = '[render](/data/render.mp4)\n[project](/opt/project/game.mp4)';

  assert.deepEqual(markdownLocalVideoTargets(markdown), ['/data/render.mp4', '/opt/project/game.mp4']);
  assert.equal(nativeMessageVideoUrl({ threadId: 'thread', messageSeq: 1, generation: 0 }, 1), '');
  enhanceMarkdownVideos(body, { threadId: 'thread', generation: 1 }, markdown);
  assert.equal(link.nextElementSibling, null, 'streaming message without seq has no player');
});

test('message video route reauthorizes against the assistant message and keeps raw paths out of the URL', () => {
  const routeStart = serverSource.indexOf("app.get('/api/native-sessions/:id/messages/:seq/videos/:index'");
  const routeEnd = serverSource.indexOf("\napp.get('/api/local-image'", routeStart);
  assert.ok(routeStart >= 0 && routeEnd > routeStart, 'message video route');
  const route = serverSource.slice(routeStart, routeEnd);

  assert.match(route, /requireAuth/);
  assert.match(route, /generation !== conversation\.generation/);
  assert.match(route, /message\.role !== 'assistant'/);
  assert.match(route, /extractVisibleAssistantMp4Links\(message\.content\)\[linkIndex - 1\]/);
  assert.match(route, /Object\.hasOwn\(req\.query, 'path'\)/);
  assert.match(route, /planMp4Response\(headRequest \? null : req\.headers\.range, video\.size\)/);
  assert.match(route, /'Cross-Origin-Resource-Policy': 'same-origin'/);
  assert.doesNotMatch(serverSource, /CODEX_WEB_LOCAL_MEDIA_ROOTS/);
  assert.match(serverSource, /link\.dataset\.messageMediaUrl=mediaUrl/);
  assert.match(serverSource, /window\.open\(openUrl\|\|markdownLocalFileProxyUrl\(url\)\|\|url/);
  assert.match(cssSource, /\.markdownBody \.markdownLocalVideo video[\s\S]*?aspect-ratio: 16 \/ 9[\s\S]*?border-radius: 8px/);
});
