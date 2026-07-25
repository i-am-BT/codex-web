import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  clearCodexSkillsCache,
  listCodexSkillsUncached,
  parseFrontmatter,
  sanitizeSkillName,
} from '../skills-catalog.mjs';

test('parseFrontmatter reads skill name and description', () => {
  const source = [
    '---',
    "name: 'hatch-pet'",
    'description: "Create animated pets from references."',
    'metadata:',
    '  short-description: ignored nested',
    '---',
    '',
    '# Hatch Pet',
    '',
  ].join('\n');
  const parsed = parseFrontmatter(source);
  assert.equal(parsed.name, 'hatch-pet');
  assert.equal(parsed.description, 'Create animated pets from references.');
});

test('sanitizeSkillName strips dollar prefixes and invalid chars', () => {
  assert.equal(sanitizeSkillName('$ui-ux-pro-max'), 'ui-ux-pro-max');
  assert.equal(sanitizeSkillName('browser:control chrome'), 'browser:control-chrome');
});

test('listCodexSkillsUncached discovers skills without exposing absolute paths', async () => {
  clearCodexSkillsCache();
  const temporary = await mkdtemp(path.join(tmpdir(), 'codex-web-skills-'));
  const codexHome = path.join(temporary, '.codex');
  const home = temporary;
  const userSkill = path.join(codexHome, 'skills', 'demo-skill');
  const systemSkill = path.join(codexHome, 'skills', '.system', 'imagegen');
  const agentsSkill = path.join(home, '.agents', 'skills', 'agent-reach');
  await mkdir(userSkill, { recursive: true });
  await mkdir(systemSkill, { recursive: true });
  await mkdir(agentsSkill, { recursive: true });
  await writeFile(path.join(userSkill, 'SKILL.md'), [
    '---',
    'name: demo-skill',
    'description: Demo skill for slash menu.',
    '---',
    '# Demo',
    '',
  ].join('\n'));
  await writeFile(path.join(systemSkill, 'SKILL.md'), [
    '---',
    'name: imagegen',
    'description: Generate images.',
    '---',
    '# Imagegen',
    '',
  ].join('\n'));
  await writeFile(path.join(agentsSkill, 'SKILL.md'), [
    '---',
    'name: agent-reach',
    'description: Reach the internet.',
    '---',
    '# Agent Reach',
    '',
  ].join('\n'));

  const skills = listCodexSkillsUncached(codexHome, home);
  assert.ok(skills.some((item) => item.name === 'demo-skill'));
  assert.ok(skills.some((item) => item.name === 'imagegen'));
  assert.ok(skills.some((item) => item.name === 'agent-reach'));
  for (const skill of skills) {
    assert.equal(skill.invocation, '$' + skill.name);
    assert.equal('path' in skill, false);
    assert.equal('file' in skill, false);
    assert.match(skill.source, /^(user|agents|claude|plugins|system)$/);
    assert.ok(!String(skill.description || '').includes(temporary));
  }
});
