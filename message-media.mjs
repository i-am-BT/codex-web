import {
  closeSync,
  constants,
  createReadStream,
  fstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
} from 'node:fs';
import path from 'node:path';
import { lexer, walkTokens } from 'marked';

export const DEFAULT_MESSAGE_MEDIA_MAX_BYTES = 1024 * 1024 * 1024;
export const DEFAULT_MESSAGE_MEDIA_MAX_PATH_BYTES = 4096;

const MAX_MP4_BOXES_PER_LEVEL = 16 * 1024;
const VERIFIED_MEDIA_HANDLES = new WeakSet();
const CONSUMED_MEDIA_HANDLES = new WeakSet();
const CLOSED_MEDIA_HANDLES = new WeakSet();

export class MessageMediaError extends Error {
  constructor(code, message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = 'MessageMediaError';
    this.code = code;
    this.statusCode = Number(options.statusCode) || 404;
  }
}

export function normalizeAbsoluteLocalMp4Link(value, options = {}) {
  const maxPathBytes = positiveSafeInteger(
    options.maxPathBytes,
    DEFAULT_MESSAGE_MEDIA_MAX_PATH_BYTES,
  );
  const raw = String(value || '').trim();
  if (!raw || Buffer.byteLength(raw, 'utf8') > maxPathBytes * 3) return '';
  if (!raw.startsWith('/') || raw.startsWith('//')) return '';
  if (raw.includes('\0') || /[\r\n]/.test(raw) || /[?#]/.test(raw)) return '';
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(raw)) return '';

  let decoded;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return '';
  }
  if (
    !decoded
    || decoded.includes('\0')
    || /[\r\n?#]/.test(decoded)
    || Buffer.byteLength(decoded, 'utf8') > maxPathBytes
    || !path.isAbsolute(decoded)
  ) return '';

  const lexicalPath = path.resolve(decoded);
  if (
    Buffer.byteLength(lexicalPath, 'utf8') > maxPathBytes
    || path.extname(lexicalPath).toLowerCase() !== '.mp4'
  ) return '';
  return lexicalPath;
}

export function extractAbsoluteLocalMp4Links(markdown, options = {}) {
  let tokens;
  try {
    tokens = lexer(String(markdown || ''));
  } catch {
    return [];
  }

  const links = [];
  walkTokens(tokens, (token) => {
    if (token?.type !== 'link') return;
    const filePath = normalizeAbsoluteLocalMp4Link(token.href, options);
    if (filePath) links.push(filePath);
  });
  return links;
}

export function visibleAssistantMessageMarkdown(value) {
  return stripNativeUiProtocolLines(normalizeAutomationHeartbeat(String(value || '')));
}

export function extractVisibleAssistantMp4Links(markdown, options = {}) {
  return extractAbsoluteLocalMp4Links(visibleAssistantMessageMarkdown(markdown), options);
}

export function openVerifiedMp4(filePath, options = {}) {
  const maxBytes = positiveSafeInteger(options.maxBytes, DEFAULT_MESSAGE_MEDIA_MAX_BYTES);
  const lexicalPath = normalizeAbsoluteLocalMp4Link(filePath, options);
  if (!lexicalPath) throw mediaError('invalid_path');

  let resolvedPath;
  try {
    resolvedPath = realpathSync(lexicalPath);
  } catch (cause) {
    throw mediaError('not_found', cause);
  }
  if (resolvedPath !== lexicalPath) throw mediaError('symlink_path');

  let fd = -1;
  try {
    const noFollow = Number(constants.O_NOFOLLOW) || 0;
    const nonBlock = Number(constants.O_NONBLOCK) || 0;
    fd = openSync(resolvedPath, constants.O_RDONLY | noFollow | nonBlock);
    const descriptorStats = fstatSync(fd, { bigint: true });
    if (!descriptorStats.isFile()) throw mediaError('not_regular_file');
    if (descriptorStats.size <= 0n) throw mediaError('empty_file');
    if (descriptorStats.size > BigInt(maxBytes)) throw mediaError('file_too_large');

    // Recheck the pathname after opening, then bind the verified inode to the
    // already-open descriptor. Streaming never reopens the caller's path.
    const currentResolvedPath = realpathSync(lexicalPath);
    const pathnameStats = statSync(currentResolvedPath, { bigint: true });
    if (
      currentResolvedPath !== lexicalPath
      || pathnameStats.dev !== descriptorStats.dev
      || pathnameStats.ino !== descriptorStats.ino
    ) throw mediaError('path_changed');

    const size = Number(descriptorStats.size);
    if (!hasIsoBmffVideoTrack(fd, size)) throw mediaError('invalid_mp4');

    const handle = Object.freeze({
      fd,
      filePath: resolvedPath,
      size,
    });
    VERIFIED_MEDIA_HANDLES.add(handle);
    return handle;
  } catch (error) {
    if (fd >= 0) {
      try { closeSync(fd); } catch {}
    }
    if (error instanceof MessageMediaError) throw error;
    throw mediaError('unavailable', error);
  }
}

export function planMp4Response(rangeHeader, size) {
  const fileSize = positiveSafeInteger(size, 0);
  if (!fileSize) throw new TypeError('MP4 size must be a positive safe integer');

  const rawRange = rangeHeader == null ? '' : String(rangeHeader).trim();
  if (!rawRange) return responsePlan(200, 0, fileSize - 1, fileSize);

  const match = /^bytes=(\d*)-(\d*)$/i.exec(rawRange);
  if (!match || (!match[1] && !match[2])) return unsatisfiedRangePlan(fileSize);

  let start;
  let end;
  if (!match[1]) {
    const suffixLength = decimalSafeInteger(match[2]);
    if (!suffixLength) return unsatisfiedRangePlan(fileSize);
    start = Math.max(0, fileSize - suffixLength);
    end = fileSize - 1;
  } else {
    start = decimalSafeInteger(match[1]);
    if (start === null || start >= fileSize) return unsatisfiedRangePlan(fileSize);
    if (match[2]) {
      end = decimalSafeInteger(match[2]);
      if (end === null || start > end) return unsatisfiedRangePlan(fileSize);
      end = Math.min(end, fileSize - 1);
    } else {
      end = fileSize - 1;
    }
  }

  return responsePlan(206, start, end, fileSize);
}

export function createVerifiedMp4Stream(handle, plan = null) {
  assertUsableMediaHandle(handle);
  const response = plan || planMp4Response('', handle.size);
  if (
    !response
    || ![200, 206].includes(response.statusCode)
    || !Number.isSafeInteger(response.start)
    || !Number.isSafeInteger(response.end)
    || response.start < 0
    || response.end < response.start
    || response.end >= handle.size
    || response.length !== response.end - response.start + 1
  ) throw new TypeError('A satisfiable MP4 response plan is required');

  CONSUMED_MEDIA_HANDLES.add(handle);
  try {
    const stream = createReadStream(handle.filePath, {
      fd: handle.fd,
      autoClose: true,
      emitClose: true,
      start: response.start,
      end: response.end,
    });
    stream.once('close', () => CLOSED_MEDIA_HANDLES.add(handle));
    return stream;
  } catch (error) {
    try { closeSync(handle.fd); } catch {}
    CLOSED_MEDIA_HANDLES.add(handle);
    throw error;
  }
}

export function closeVerifiedMp4(handle) {
  if (!VERIFIED_MEDIA_HANDLES.has(handle)) throw new TypeError('Verified MP4 handle required');
  if (CONSUMED_MEDIA_HANDLES.has(handle) || CLOSED_MEDIA_HANDLES.has(handle)) return false;
  CONSUMED_MEDIA_HANDLES.add(handle);
  try {
    closeSync(handle.fd);
  } finally {
    CLOSED_MEDIA_HANDLES.add(handle);
  }
  return true;
}

function hasIsoBmffVideoTrack(fd, fileSize) {
  let hasFileType = false;
  let hasVideoTrack = false;
  const valid = visitIsoBoxes(fd, 0, fileSize, (box) => {
    if (box.type === 'ftyp') {
      if (box.dataSize < 8) return false;
      hasFileType = true;
    } else if (box.type === 'moov') {
      const result = moovHasVideoTrack(fd, box.dataOffset, box.end);
      if (result === null) return false;
      hasVideoTrack = hasVideoTrack || result;
    }
    return true;
  });
  return valid && hasFileType && hasVideoTrack;
}

function moovHasVideoTrack(fd, start, end) {
  let hasVideo = false;
  const valid = visitIsoBoxes(fd, start, end, (box) => {
    if (box.type !== 'trak') return true;
    const result = trakHasVideoHandler(fd, box.dataOffset, box.end);
    if (result === null) return false;
    hasVideo = hasVideo || result;
    return true;
  });
  return valid ? hasVideo : null;
}

function trakHasVideoHandler(fd, start, end) {
  let hasVideo = false;
  const valid = visitIsoBoxes(fd, start, end, (box) => {
    if (box.type !== 'mdia') return true;
    const result = mdiaHasVideoHandler(fd, box.dataOffset, box.end);
    if (result === null) return false;
    hasVideo = hasVideo || result;
    return true;
  });
  return valid ? hasVideo : null;
}

function mdiaHasVideoHandler(fd, start, end) {
  let hasVideo = false;
  const valid = visitIsoBoxes(fd, start, end, (box) => {
    if (box.type !== 'hdlr') return true;
    if (box.dataSize < 12) return false;
    const handlerType = readExactlyAt(fd, 4, box.dataOffset + 8);
    if (!handlerType) return false;
    hasVideo = hasVideo || handlerType.toString('latin1') === 'vide';
    return true;
  });
  return valid ? hasVideo : null;
}

function visitIsoBoxes(fd, start, end, visitor) {
  let offset = start;
  let count = 0;
  while (offset < end) {
    if (count >= MAX_MP4_BOXES_PER_LEVEL) return false;
    const box = readIsoBoxHeader(fd, offset, end);
    if (!box || visitor(box) === false) return false;
    offset = box.end;
    count += 1;
  }
  return offset === end;
}

function readIsoBoxHeader(fd, offset, boundary) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(boundary) || boundary - offset < 8) return null;
  const base = readExactlyAt(fd, 8, offset);
  if (!base) return null;
  const size32 = base.readUInt32BE(0);
  const type = base.toString('latin1', 4, 8);
  let headerSize = 8;
  let size;
  if (size32 === 1) {
    const extended = readExactlyAt(fd, 8, offset + 8);
    if (!extended) return null;
    const largeSize = extended.readBigUInt64BE(0);
    if (largeSize > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    headerSize = 16;
    size = Number(largeSize);
  } else if (size32 === 0) {
    size = boundary - offset;
  } else {
    size = size32;
  }
  if (!Number.isSafeInteger(size) || size < headerSize || size > boundary - offset) return null;
  return {
    type,
    offset,
    end: offset + size,
    size,
    headerSize,
    dataOffset: offset + headerSize,
    dataSize: size - headerSize,
  };
}

function readExactlyAt(fd, length, position) {
  const buffer = Buffer.allocUnsafe(length);
  let offset = 0;
  while (offset < length) {
    const bytesRead = readSync(fd, buffer, offset, length - offset, position + offset);
    if (!bytesRead) return null;
    offset += bytesRead;
  }
  return buffer;
}

function normalizeAutomationHeartbeat(original) {
  const openTag = '<heartbeat>';
  const closeTag = '</heartbeat>';
  const start = original.indexOf(openTag);
  if (start < 0 || original.indexOf(openTag, start + openTag.length) >= 0) return original;
  const closeStart = original.indexOf(closeTag, start + openTag.length);
  if (closeStart < 0 || original.indexOf(closeTag, closeStart + closeTag.length) >= 0) return original;
  const end = closeStart + closeTag.length;
  const children = parseSimpleHeartbeatChildren(original.slice(start + openTag.length, closeStart));
  if (!children) return original;

  const automationIds = children.filter((item) => item.tag === 'automation_id');
  const decisions = children.filter((item) => item.tag === 'decision');
  const messages = children.filter((item) => item.tag === 'message');
  if (automationIds.length !== 1 || decisions.length !== 1 || messages.length !== 1) return original;
  const automationId = automationIds[0].text.trim();
  const decision = decisions[0].text.trim();
  const message = messages[0].text.trim();
  if (!automationId || !['NOTIFY', 'DONT_NOTIFY'].includes(decision) || !message) return original;

  let before = original.slice(0, start);
  let after = original.slice(end);
  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');
  while (beforeLines.length && !String(beforeLines.at(-1) || '').trim()) beforeLines.pop();
  while (afterLines.length && !String(afterLines[0] || '').trim()) afterLines.shift();
  const fenceStart = String(beforeLines.at(-1) || '').trim();
  const fenceEnd = String(afterLines[0] || '').trim();
  if (['```', '```xml'].includes(fenceStart) && fenceEnd === '```') {
    beforeLines.pop();
    afterLines.shift();
    before = beforeLines.join('\n');
    after = afterLines.join('\n');
  }
  if (!after.trim() && normalizeAutomationDuplicateText(before) === normalizeAutomationDuplicateText(message)) {
    return message;
  }
  return `${before}${message}${after}`.trim() || original;
}

function parseSimpleHeartbeatChildren(source) {
  const children = [];
  const pattern = /<(automation_id|decision|message)>([\s\S]*?)<\/\1>/g;
  let cursor = 0;
  let match;
  while ((match = pattern.exec(source))) {
    if (source.slice(cursor, match.index).trim()) return null;
    const text = decodeSimpleXmlText(match[2]);
    if (text === null) return null;
    children.push({ tag: match[1], text });
    cursor = match.index + match[0].length;
  }
  if (source.slice(cursor).trim()) return null;
  return children.length ? children : null;
}

function decodeSimpleXmlText(source) {
  if (source.includes('<')) return null;
  const entityPattern = /&(?:amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);/gi;
  if (source.replace(entityPattern, '').includes('&')) return null;
  let invalidEntity = false;
  const decoded = source.replace(entityPattern, (entity) => {
    if (entity[1] !== '#') {
      return {
        '&amp;': '&',
        '&lt;': '<',
        '&gt;': '>',
        '&quot;': '"',
        '&apos;': "'",
      }[entity.toLowerCase()];
    }
    const hex = entity.slice(1, 3).toLowerCase() === '#x';
    const digits = entity.slice(hex ? 3 : 2, -1);
    const code = Number.parseInt(digits, hex ? 16 : 10);
    if (!Number.isInteger(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
      invalidEntity = true;
      return '';
    }
    return String.fromCodePoint(code);
  });
  if (invalidEntity) return null;
  return decoded;
}

function normalizeAutomationDuplicateText(value) {
  return String(value || '')
    .trim()
    .replace(/[\*_`]/g, '')
    .replace(/[\t\n\r]/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();
}

function nativeUiProtocolLine(line, { allowPartial = false } = {}) {
  const source = String(line || '').trim();
  const opener = /^::git-[a-z0-9_-]+\{/i.exec(source);
  if (!opener) {
    if (!allowPartial || !source) return false;
    const prefix = '::git-';
    return prefix.startsWith(source.toLowerCase()) || /^::git-[a-z0-9_-]*$/i.test(source);
  }
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let index = opener[0].length - 1; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return !source.slice(index + 1).trim();
    }
  }
  return allowPartial && depth > 0;
}

function stripNativeUiProtocolLines(value) {
  const source = String(value || '').replace(/\r\n/g, '\n');
  if (!source) return '';
  const kept = [];
  let fence = null;
  let protocol = null;
  let protocolLines = [];
  let removed = false;
  for (const line of source.split('\n')) {
    if (protocol) {
      protocolLines.push(line);
      let closedAt = -1;
      for (let index = 0; index < line.length; index += 1) {
        const char = line[index];
        if (protocol.quote) {
          if (protocol.escaped) protocol.escaped = false;
          else if (char === '\\') protocol.escaped = true;
          else if (char === protocol.quote) protocol.quote = '';
          continue;
        }
        if (char === '"' || char === "'") protocol.quote = char;
        else if (char === '{') protocol.depth += 1;
        else if (char === '}') {
          protocol.depth -= 1;
          if (protocol.depth === 0) {
            closedAt = index;
            break;
          }
        }
      }
      if (closedAt < 0) continue;
      if (!line.slice(closedAt + 1).trim()) removed = true;
      else kept.push(...protocolLines);
      protocol = null;
      protocolLines = [];
      continue;
    }
    const trimmed = line.trim();
    const marker = /^(?:(`{3,})|(~{3,}))/.exec(trimmed);
    if (fence) {
      kept.push(line);
      const run = marker?.[1] || marker?.[2] || '';
      if (run && run[0] === fence.char && run.length >= fence.length) fence = null;
      continue;
    }
    if (marker) {
      kept.push(line);
      const run = marker[1] || marker[2];
      fence = { char: run[0], length: run.length };
      continue;
    }
    if (nativeUiProtocolLine(trimmed)) {
      removed = true;
      continue;
    }
    const opener = /^::git-[a-z0-9_-]+\{/i.exec(trimmed);
    if (opener) {
      protocol = { depth: 0, quote: '', escaped: false };
      protocolLines = [line];
      for (let index = opener[0].length - 1; index < trimmed.length; index += 1) {
        const char = trimmed[index];
        if (protocol.quote) {
          if (protocol.escaped) protocol.escaped = false;
          else if (char === '\\') protocol.escaped = true;
          else if (char === protocol.quote) protocol.quote = '';
          continue;
        }
        if (char === '"' || char === "'") protocol.quote = char;
        else if (char === '{') protocol.depth += 1;
        else if (char === '}') protocol.depth -= 1;
      }
      if (protocol.depth <= 0) {
        protocol = null;
        protocolLines = [];
      }
      continue;
    }
    kept.push(line);
  }
  if (protocol) kept.push(...protocolLines);
  if (!removed) return source;
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function responsePlan(statusCode, start, end, fileSize) {
  const length = end - start + 1;
  const headers = {
    'Accept-Ranges': 'bytes',
    'Content-Length': String(length),
  };
  if (statusCode === 206) headers['Content-Range'] = `bytes ${start}-${end}/${fileSize}`;
  return Object.freeze({
    statusCode,
    start,
    end,
    length,
    fileSize,
    headers: Object.freeze(headers),
  });
}

function unsatisfiedRangePlan(fileSize) {
  return Object.freeze({
    statusCode: 416,
    start: null,
    end: null,
    length: 0,
    fileSize,
    headers: Object.freeze({
      'Accept-Ranges': 'bytes',
      'Content-Range': `bytes */${fileSize}`,
      'Content-Length': '0',
    }),
  });
}

function decimalSafeInteger(value) {
  if (!/^\d+$/.test(String(value || ''))) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function positiveSafeInteger(value, fallback) {
  const number = Number(value);
  if (Number.isSafeInteger(number) && number > 0) return number;
  return fallback;
}

function assertUsableMediaHandle(handle) {
  if (!VERIFIED_MEDIA_HANDLES.has(handle)) throw new TypeError('Verified MP4 handle required');
  if (CONSUMED_MEDIA_HANDLES.has(handle) || CLOSED_MEDIA_HANDLES.has(handle)) {
    throw new TypeError('Verified MP4 handle has already been consumed');
  }
}

function mediaError(code, cause) {
  const messages = {
    invalid_path: '视频路径无效',
    not_found: '视频不存在或不可用',
    symlink_path: '视频路径不能包含软链接',
    not_regular_file: '视频不是普通文件',
    empty_file: '视频文件为空',
    file_too_large: '视频文件超过大小限制',
    path_changed: '视频文件在验证期间发生变化',
    invalid_mp4: '文件不是有效的 MP4 视频',
    unavailable: '视频不存在或不可用',
  };
  return new MessageMediaError(code, messages[code] || messages.unavailable, {
    statusCode: 404,
    cause,
  });
}
