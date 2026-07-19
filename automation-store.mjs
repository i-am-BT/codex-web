import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

const AUTOMATION_VERSION = 1;
const AUTOMATION_FILE = 'automation.toml';
const VALID_STATUS = new Set(['ACTIVE', 'PAUSED']);
const VALID_REASONING = new Set(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
const VALID_NOTIFICATION = new Set(['always', 'failed_runs_only']);
const WEEKDAYS = new Set(['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']);

export class AutomationStore {
  constructor(codexHome) {
    this.root = path.join(codexHome, 'automations');
  }

  list() {
    if (!existsSync(this.root)) return [];
    return readdirSync(this.root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && validId(entry.name))
      .map((entry) => this.get(entry.name))
      .filter(Boolean)
      .filter((item) => item.status !== 'DELETED')
      .sort((left, right) => right.updatedAt - left.updatedAt);
  }

  get(id) {
    if (!validId(id)) return null;
    const file = path.join(this.root, id, AUTOMATION_FILE);
    if (!existsSync(file)) return null;
    try {
      const item = parseAutomationToml(readFileSync(file, 'utf8'));
      return item?.id === id ? item : null;
    } catch {
      return null;
    }
  }

  create(input) {
    const now = Date.now();
    const name = cleanText(input.name, 120, '自动化名称');
    const prompt = cleanText(input.prompt, 12000, '任务说明');
    const rrule = normalizeRrule(input.rrule);
    const id = this.availableId(name);
    const cwd = cleanOptionalText(input.cwd, 2048);
    const model = cleanOptionalText(input.model, 120);
    const reasoningEffort = cleanOptionalText(input.reasoningEffort, 24);
    const notificationPolicy = cleanOptionalText(input.notificationPolicy, 40);
    const status = VALID_STATUS.has(input.status) ? input.status : 'ACTIVE';
    if (reasoningEffort && !VALID_REASONING.has(reasoningEffort)) throw new Error('思考档位无效');
    if (notificationPolicy && !VALID_NOTIFICATION.has(notificationPolicy)) throw new Error('通知策略无效');

    const item = {
      version: AUTOMATION_VERSION,
      id,
      kind: 'cron',
      name,
      prompt,
      status,
      rrule,
      model: model || null,
      reasoningEffort: reasoningEffort || null,
      notificationPolicy: notificationPolicy || null,
      executionEnvironment: 'local',
      target: cwd ? null : { type: 'projectless' },
      cwds: cwd ? [cwd] : [],
      createdAt: now,
      updatedAt: now,
    };
    this.write(item);
    return item;
  }

  setStatus(id, status) {
    if (!VALID_STATUS.has(status)) throw new Error('自动化状态无效');
    const current = this.get(id);
    if (!current) return null;
    const item = { ...current, status, updatedAt: Date.now() };
    this.write(item);
    return item;
  }

  write(item) {
    if (!validId(item.id)) throw new Error('自动化 ID 无效');
    const directory = path.join(this.root, item.id);
    const target = path.join(directory, AUTOMATION_FILE);
    mkdirSync(directory, { recursive: true });
    const temporary = path.join(directory, `.${AUTOMATION_FILE}.tmp-${Date.now()}-${randomUUID()}`);
    writeFileSync(temporary, stringifyAutomationToml(item), 'utf8');
    try {
      renameSync(temporary, target);
    } catch (error) {
      rmSync(temporary, { force: true });
      throw error;
    }
  }

  availableId(name) {
    const base = slugify(name) || 'automation';
    if (!existsSync(path.join(this.root, base))) return base;
    for (let index = 2; index <= 20; index += 1) {
      const candidate = `${base}-${index}`;
      if (!existsSync(path.join(this.root, candidate))) return candidate;
    }
    return `${base}-${randomUUID().slice(0, 8)}`;
  }
}

export function buildAutomationRrule(input = {}) {
  const frequency = String(input.frequency || 'daily');
  if (frequency === 'hourly') {
    const interval = boundedInteger(input.interval, 1, 24, 1);
    return `FREQ=HOURLY;INTERVAL=${interval};BYMINUTE=0`;
  }
  const { hour, minute } = parseTime(input.time || '09:00');
  if (frequency === 'weekdays') {
    return `FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=${hour};BYMINUTE=${minute}`;
  }
  if (frequency === 'weekly') {
    const days = [...new Set((Array.isArray(input.days) ? input.days : [input.day || 'MO'])
      .map((day) => String(day || '').toUpperCase())
      .filter((day) => WEEKDAYS.has(day)))];
    if (!days.length) throw new Error('每周执行日期无效');
    return `FREQ=WEEKLY;BYDAY=${days.join(',')};BYHOUR=${hour};BYMINUTE=${minute}`;
  }
  if (frequency !== 'daily') throw new Error('执行频率无效');
  return `FREQ=DAILY;BYHOUR=${hour};BYMINUTE=${minute}`;
}

export function describeAutomationRrule(rrule) {
  const parts = parseRrule(rrule);
  const hour = String(Number(parts.BYHOUR || 0)).padStart(2, '0');
  const minute = String(Number(parts.BYMINUTE || 0)).padStart(2, '0');
  if (parts.FREQ === 'HOURLY') return `每 ${Number(parts.INTERVAL || 1)} 小时`;
  if (parts.FREQ === 'DAILY') return `每天 ${hour}:${minute}`;
  if (parts.FREQ === 'WEEKLY') {
    const days = String(parts.BYDAY || '').split(',').filter(Boolean);
    if (days.join(',') === 'MO,TU,WE,TH,FR') return `工作日 ${hour}:${minute}`;
    if (new Set(days).size === 7) return `每天 ${hour}:${minute}`;
    const labels = { MO: '周一', TU: '周二', WE: '周三', TH: '周四', FR: '周五', SA: '周六', SU: '周日' };
    return `${days.map((day) => labels[day] || day).join('、')} ${hour}:${minute}`;
  }
  return rrule;
}

export function nextAutomationRunAt(item, now = Date.now()) {
  if (!item || item.status !== 'ACTIVE') return null;
  const rule = parseRrule(item.rrule);
  if (rule.FREQ === 'HOURLY') {
    const intervalMs = boundedInteger(rule.INTERVAL, 1, 24, 1) * 60 * 60 * 1000;
    return Math.ceil((now + 1) / intervalMs) * intervalMs;
  }
  const hour = boundedInteger(rule.BYHOUR, 0, 23, 0);
  const minute = boundedInteger(rule.BYMINUTE, 0, 59, 0);
  const allowedDays = rule.FREQ === 'WEEKLY'
    ? String(rule.BYDAY || '').split(',').map((day) => weekdayNumber(day)).filter((day) => day !== null)
    : [];
  const date = new Date(now);
  for (let offset = 0; offset <= 8; offset += 1) {
    const candidate = new Date(date.getFullYear(), date.getMonth(), date.getDate() + offset, hour, minute, 0, 0);
    if (candidate.getTime() <= now) continue;
    if (allowedDays.length && !allowedDays.includes(candidate.getDay())) continue;
    return candidate.getTime();
  }
  return null;
}

export function decorateAutomation(item) {
  return {
    ...item,
    scheduleLabel: describeAutomationRrule(item.rrule),
    nextRunAt: nextAutomationRunAt(item),
  };
}

function parseAutomationToml(source) {
  const values = {};
  for (const rawLine of String(source || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^([a-z_]+)\s*=\s*(.+)$/i);
    if (!match) continue;
    values[match[1]] = parseTomlValue(match[2]);
  }
  if (Number(values.version || AUTOMATION_VERSION) !== AUTOMATION_VERSION) return null;
  if (!validId(values.id) || !['cron', 'heartbeat'].includes(values.kind) || !VALID_STATUS.has(values.status)) return null;
  if (values.kind === 'cron' && !Array.isArray(values.cwds)) return null;
  if (values.kind === 'heartbeat' && !String(values.target_thread_id || '').trim()) return null;
  const common = {
    version: AUTOMATION_VERSION,
    id: values.id,
    kind: values.kind,
    name: String(values.name || ''),
    prompt: String(values.prompt || ''),
    status: values.status,
    rrule: normalizeRrule(values.rrule),
    model: values.model ? String(values.model) : null,
    reasoningEffort: values.reasoning_effort ? String(values.reasoning_effort) : null,
    notificationPolicy: values.notification_policy ? String(values.notification_policy) : null,
    createdAt: Number(values.created_at || 0),
    updatedAt: Number(values.updated_at || 0),
  };
  return values.kind === 'heartbeat'
    ? { ...common, targetThreadId: String(values.target_thread_id) }
    : {
      ...common,
      executionEnvironment: values.execution_environment === 'worktree' ? 'worktree' : 'local',
      target: values.target && typeof values.target === 'object' ? values.target : null,
      cwds: values.cwds.map((cwd) => String(cwd)),
    };
}

function stringifyAutomationToml(item) {
  const lines = [
    `version = ${AUTOMATION_VERSION}`,
    `id = ${tomlString(item.id)}`,
    `kind = ${tomlString(item.kind || 'cron')}`,
    `name = ${tomlString(item.name)}`,
    `prompt = ${tomlString(item.prompt)}`,
    `status = ${tomlString(item.status)}`,
    `rrule = ${tomlString(normalizeRrule(item.rrule))}`,
  ];
  if (item.model) lines.push(`model = ${tomlString(item.model)}`);
  if (item.reasoningEffort) lines.push(`reasoning_effort = ${tomlString(item.reasoningEffort)}`);
  if (item.notificationPolicy) lines.push(`notification_policy = ${tomlString(item.notificationPolicy)}`);
  if (item.kind === 'heartbeat') {
    lines.push(`target_thread_id = ${tomlString(item.targetThreadId)}`);
  } else {
    lines.push(`execution_environment = ${tomlString(item.executionEnvironment || 'local')}`);
    if (item.target?.type === 'project') {
      lines.push(`target = { type = "project", project_id = ${tomlString(item.target.projectId)} }`);
    } else if (item.target?.type === 'projectless') {
      lines.push('target = { type = "projectless" }');
    }
    lines.push(`cwds = [${(item.cwds || []).map(tomlString).join(', ')}]`);
  }
  lines.push(`created_at = ${Number(item.createdAt)}`);
  lines.push(`updated_at = ${Number(item.updatedAt)}`);
  return `${lines.join('\n')}\n`;
}

function parseTomlValue(source) {
  const value = source.trim();
  if (value.startsWith('"')) return JSON.parse(value);
  if (value.startsWith('[')) return JSON.parse(value);
  if (value.startsWith('{')) {
    const object = {};
    const inner = value.slice(1, -1);
    for (const part of inner.split(',')) {
      const match = part.trim().match(/^([a-z_]+)\s*=\s*(.+)$/i);
      if (match) object[toCamelCase(match[1])] = parseTomlValue(match[2]);
    }
    return object;
  }
  if (/^-?\d+$/.test(value)) return Number(value);
  return value;
}

function parseRrule(rrule) {
  return Object.fromEntries(String(rrule || '').split(';').map((part) => part.split('=', 2)).filter((part) => part.length === 2));
}

function normalizeRrule(rrule) {
  const value = String(rrule || '').trim().replace(/^RRULE:/i, '').toUpperCase();
  if (!value.startsWith('FREQ=')) throw new Error('执行计划无效');
  return value;
}

function parseTime(value) {
  const match = String(value).match(/^(\d{1,2}):(\d{2})$/);
  if (!match) throw new Error('执行时间无效');
  const hour = boundedInteger(match[1], 0, 23, -1);
  const minute = boundedInteger(match[2], 0, 59, -1);
  if (hour < 0 || minute < 0) throw new Error('执行时间无效');
  return { hour, minute };
}

function boundedInteger(value, minimum, maximum, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number >= minimum && number <= maximum ? number : fallback;
}

function weekdayNumber(day) {
  return { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 }[day] ?? null;
}

function cleanText(value, maximum, label) {
  const text = String(value || '').trim();
  if (!text) throw new Error(`${label}不能为空`);
  if (text.length > maximum) throw new Error(`${label}过长`);
  return text;
}

function cleanOptionalText(value, maximum) {
  return String(value || '').trim().slice(0, maximum);
}

function tomlString(value) {
  return JSON.stringify(String(value));
}

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function validId(value) {
  return Boolean(value) && value !== '.' && value !== '..' && !String(value).includes('/') && !String(value).includes('\\');
}

function toCamelCase(value) {
  return value.replace(/_([a-z])/g, (_match, character) => character.toUpperCase());
}
