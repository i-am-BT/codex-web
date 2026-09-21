import assert from 'node:assert/strict';
import { once } from 'node:events';
import {
  closeSync,
  fstatSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  MessageMediaError,
  closeVerifiedMp4,
  createVerifiedMp4Stream,
  extractAbsoluteLocalMp4Links,
  extractVisibleAssistantMp4Links,
  normalizeAbsoluteLocalMp4Link,
  openVerifiedMp4,
  planMp4Response,
  visibleAssistantMessageMarkdown,
} from '../message-media.mjs';

function mp4Box(type, payload = Buffer.alloc(0)) {
  const box = Buffer.alloc(8 + payload.length);
  box.writeUInt32BE(box.length, 0);
  box.write(type, 4, 4, 'latin1');
  payload.copy(box, 8);
  return box;
}

function validMp4(body = Buffer.from('message-media-fixture')) {
  const handler = mp4Box('hdlr', Buffer.concat([
    Buffer.alloc(8),
    Buffer.from('vide', 'latin1'),
  ]));
  return Buffer.concat([
    mp4Box('ftyp', Buffer.concat([
      Buffer.from('isom', 'latin1'),
      Buffer.alloc(4),
      Buffer.from('isommp42', 'latin1'),
    ])),
    mp4Box('moov', mp4Box('trak', mp4Box('mdia', handler))),
    mp4Box('mdat', body),
  ]);
}

async function readStream(stream) {
  const chunks = [];
  stream.on('data', (chunk) => chunks.push(chunk));
  await once(stream, 'close');
  return Buffer.concat(chunks);
}

function assertMediaError(fn, code) {
  assert.throws(fn, (error) => error instanceof MessageMediaError && error.code === code);
}

test('extractAbsoluteLocalMp4Links preserves rendered Markdown link order', () => {
  const markdown = [
    '[first](/tmp/one.mp4)',
    '[root](/root/render.mp4)',
    '[remote](https://example.com/not-local.mp4)',
    '- [second](/opt/videos/two.MP4)',
    '- [encoded](/mnt/media/three%20clip.mp4)',
    '[again](/tmp/one.mp4)',
    '[reference][video]',
    '',
    '[video]: /data/four.mp4',
  ].join('\n');

  assert.deepEqual(extractAbsoluteLocalMp4Links(markdown), [
    '/tmp/one.mp4',
    '/root/render.mp4',
    '/opt/videos/two.MP4',
    '/mnt/media/three clip.mp4',
    '/tmp/one.mp4',
    '/data/four.mp4',
  ]);
});

test('local MP4 link normalization rejects URLs, relative and ambiguous paths', () => {
  const invalid = [
    '',
    'relative/video.mp4',
    './relative.mp4',
    '../relative.mp4',
    'https://example.com/video.mp4',
    'file:///tmp/video.mp4',
    '//example.com/video.mp4',
    '/tmp/video.webm',
    '/tmp/video.mp4?download=1',
    '/tmp/video.mp4#t=1',
    '/tmp/bad\0video.mp4',
    '/tmp/bad%00video.mp4',
    '/tmp/bad%ZZvideo.mp4',
  ];
  for (const value of invalid) assert.equal(normalizeAbsoluteLocalMp4Link(value), '', value);
  assert.equal(normalizeAbsoluteLocalMp4Link('/tmp/a/../video.mp4'), '/tmp/video.mp4');
  assert.equal(normalizeAbsoluteLocalMp4Link('/tmp/视频.mp4'), '/tmp/视频.mp4');
  assert.equal(normalizeAbsoluteLocalMp4Link('/tmp/12345.mp4', { maxPathBytes: 8 }), '');

  const markdown = [
    '[relative](./video.mp4)',
    '[remote](https://example.com/video.mp4)',
    '<a href="/tmp/raw-html.mp4">raw</a>',
    '![not a video link](/tmp/poster.mp4)',
  ].join('\n');
  assert.deepEqual(extractAbsoluteLocalMp4Links(markdown), []);
});

test('visible assistant media extraction ignores hidden protocol links and unwraps heartbeat output', () => {
  const hiddenProtocol = [
    '::git-file{path="[hidden](/tmp/hidden.mp4)"}',
    '[visible](/tmp/visible.mp4)',
  ].join('\n');
  assert.equal(visibleAssistantMessageMarkdown(hiddenProtocol), '[visible](/tmp/visible.mp4)');
  assert.deepEqual(extractVisibleAssistantMp4Links(hiddenProtocol), ['/tmp/visible.mp4']);

  const heartbeat = [
    '<heartbeat>',
    '  <automation_id>daily-video</automation_id>',
    '  <decision>NOTIFY</decision>',
    '  <message>[result](/data/daily%20result.mp4)</message>',
    '</heartbeat>',
  ].join('\n');
  assert.equal(visibleAssistantMessageMarkdown(heartbeat), '[result](/data/daily%20result.mp4)');
  assert.deepEqual(extractVisibleAssistantMp4Links(heartbeat), ['/data/daily result.mp4']);

  const fenced = `before\n\n\`\`\`xml\n${heartbeat}\n\`\`\``;
  assert.equal(visibleAssistantMessageMarkdown(fenced), 'before\n[result](/data/daily%20result.mp4)');
});

test('openVerifiedMp4 validates the opened inode and streams only the planned bytes', async (t) => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'codex-web-message-media-'));
  let opened = null;
  t.after(() => {
    if (opened) {
      try { closeSync(opened.fd); } catch {}
    }
    rmSync(temporary, { recursive: true, force: true });
  });
  const fixture = validMp4(Buffer.from('abcdefghijklmnopqrstuvwxyz'));
  const filePath = path.join(temporary, 'fixture.mp4');
  writeFileSync(filePath, fixture);

  opened = openVerifiedMp4(filePath, { maxBytes: fixture.length });
  assert.equal(opened.filePath, filePath);
  assert.equal(opened.size, fixture.length);
  assert.ok(fstatSync(opened.fd).isFile());

  const plan = planMp4Response('bytes=8-19', opened.size);
  assert.equal(plan.statusCode, 206);
  assert.deepEqual(plan.headers, {
    'Accept-Ranges': 'bytes',
    'Content-Length': '12',
    'Content-Range': `bytes 8-19/${fixture.length}`,
  });
  assert.deepEqual(await readStream(createVerifiedMp4Stream(opened, plan)), fixture.subarray(8, 20));
  assert.throws(() => createVerifiedMp4Stream(opened, plan), /already been consumed/);
});

test('openVerifiedMp4 accepts a well-formed leading box before ftyp', (t) => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'codex-web-message-media-box-'));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const filePath = path.join(temporary, 'leading-free.mp4');
  const fixture = Buffer.concat([mp4Box('free'), validMp4()]);
  writeFileSync(filePath, fixture);
  const opened = openVerifiedMp4(filePath, { maxBytes: fixture.length });
  assert.equal(opened.size, fixture.length);
  assert.equal(closeVerifiedMp4(opened), true);
  assert.equal(closeVerifiedMp4(opened), false);
  assert.throws(() => fstatSync(opened.fd), /EBADF/);
});

test('openVerifiedMp4 rejects non-files, size violations, fake MP4 and symlinks', (t) => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'codex-web-message-media-invalid-'));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const validPath = path.join(temporary, 'valid.mp4');
  const fixture = validMp4();
  writeFileSync(validPath, fixture);

  const emptyPath = path.join(temporary, 'empty.mp4');
  writeFileSync(emptyPath, Buffer.alloc(0));
  assertMediaError(() => openVerifiedMp4(emptyPath), 'empty_file');

  const directoryPath = path.join(temporary, 'directory.mp4');
  mkdirSync(directoryPath);
  assertMediaError(() => openVerifiedMp4(directoryPath), 'not_regular_file');

  assertMediaError(() => openVerifiedMp4(validPath, { maxBytes: fixture.length - 1 }), 'file_too_large');

  const fakePath = path.join(temporary, 'fake.mp4');
  writeFileSync(fakePath, Buffer.from('this is not an ISO-BMFF file'));
  assertMediaError(() => openVerifiedMp4(fakePath), 'invalid_mp4');

  const forgedFileTypePath = path.join(temporary, 'forged-ftyp.mp4');
  writeFileSync(forgedFileTypePath, Buffer.concat([
    mp4Box('ftyp', Buffer.from('isom0000', 'latin1')),
    mp4Box('mdat', Buffer.from('not a video track')),
  ]));
  assertMediaError(() => openVerifiedMp4(forgedFileTypePath), 'invalid_mp4');

  const wrongExtension = path.join(temporary, 'valid.txt');
  writeFileSync(wrongExtension, fixture);
  assertMediaError(() => openVerifiedMp4(wrongExtension), 'invalid_path');

  const fileLink = path.join(temporary, 'file-link.mp4');
  symlinkSync(validPath, fileLink);
  assertMediaError(() => openVerifiedMp4(fileLink), 'symlink_path');

  const realDirectory = path.join(temporary, 'real-directory');
  const linkedDirectory = path.join(temporary, 'linked-directory');
  mkdirSync(realDirectory);
  writeFileSync(path.join(realDirectory, 'inside.mp4'), fixture);
  symlinkSync(realDirectory, linkedDirectory, 'dir');
  assertMediaError(() => openVerifiedMp4(path.join(linkedDirectory, 'inside.mp4')), 'symlink_path');

  assertMediaError(() => openVerifiedMp4(path.join(temporary, 'missing.mp4')), 'not_found');
});

test('planMp4Response covers full, open, suffix, clamped and unsatisfied ranges', () => {
  assert.deepEqual(planMp4Response(undefined, 10), {
    statusCode: 200,
    start: 0,
    end: 9,
    length: 10,
    fileSize: 10,
    headers: {
      'Accept-Ranges': 'bytes',
      'Content-Length': '10',
    },
  });
  assert.deepEqual(planMp4Response('bytes=3-', 10), {
    statusCode: 206,
    start: 3,
    end: 9,
    length: 7,
    fileSize: 10,
    headers: {
      'Accept-Ranges': 'bytes',
      'Content-Length': '7',
      'Content-Range': 'bytes 3-9/10',
    },
  });
  assert.equal(planMp4Response('bytes=-4', 10).start, 6);
  assert.equal(planMp4Response('bytes=0-999', 10).end, 9);

  for (const value of [
    'bytes=',
    'items=0-1',
    'bytes=0-1,4-5',
    'bytes=7-4',
    'bytes=10-',
    'bytes=-0',
    'bytes=999999999999999999999-',
  ]) {
    const plan = planMp4Response(value, 10);
    assert.equal(plan.statusCode, 416, value);
    assert.equal(plan.headers['Content-Range'], 'bytes */10');
    assert.equal(plan.headers['Content-Length'], '0');
  }
  assert.throws(() => planMp4Response('', 0), /positive safe integer/);
});

test('stream API accepts only its own open, unconsumed handles and satisfiable plans', () => {
  assert.throws(
    () => createVerifiedMp4Stream({ fd: 1, filePath: '/tmp/fake.mp4', size: 10 }),
    /Verified MP4 handle required/,
  );
  assert.throws(
    () => closeVerifiedMp4({ fd: 1, filePath: '/tmp/fake.mp4', size: 10 }),
    /Verified MP4 handle required/,
  );
});
