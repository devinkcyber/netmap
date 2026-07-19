import { describe, it, expect } from 'vitest';
import { parseFrontmatter, setFrontmatterField, yamlScalar } from './vault';

const NOTE = `---
ip: 10.0.0.5
hostnames: [dc01.zsm.local]
status: unreviewed
---

# dc01

See [[10.0.0.6]] for the paired host.
`;

describe('parseFrontmatter', () => {
  it('reads scalar fields, lowercasing keys', () => {
    const fm = parseFrontmatter(NOTE);
    expect(fm.ip).toBe('10.0.0.5');
    expect(fm.status).toBe('unreviewed');
  });

  it('returns an empty object when there is no frontmatter', () => {
    expect(parseFrontmatter('# just a heading')).toEqual({});
  });
});

describe('setFrontmatterField', () => {
  it('updates an existing field, leaving the body byte-for-byte intact', () => {
    const out = setFrontmatterField(NOTE, 'status', 'owned');
    expect(out).toContain('status: owned');
    expect(out).not.toContain('status: unreviewed');
    expect(out).toContain('ip: 10.0.0.5'); // other frontmatter untouched
    expect(out).toContain('See [[10.0.0.6]] for the paired host.'); // wikilink + body untouched
  });

  it('inserts a new field into existing frontmatter without disturbing the rest', () => {
    const out = setFrontmatterField(NOTE, 'bloodhound_id', 'S-1-5-21');
    const fm = parseFrontmatter(out);
    expect(fm.bloodhound_id).toBe('S-1-5-21');
    expect(fm.ip).toBe('10.0.0.5');
  });

  it('prepends a frontmatter block when the note has none', () => {
    const out = setFrontmatterField('# no frontmatter here', 'status', 'reviewed');
    expect(out.startsWith('---\n')).toBe(true);
    expect(parseFrontmatter(out).status).toBe('reviewed');
  });
});

describe('yamlScalar', () => {
  it('leaves safe values unquoted', () => {
    expect(yamlScalar('Microsoft Windows Server 2019')).toBe('Microsoft Windows Server 2019');
    expect(yamlScalar('S-1-5-21-100')).toBe('S-1-5-21-100');
    expect(yamlScalar('')).toBe('');
  });

  it('quotes values with YAML-significant characters', () => {
    expect(yamlScalar('00:11:22:33:44:55')).toBe('"00:11:22:33:44:55"'); // MAC colons
    expect(yamlScalar('weird: os name')).toBe('"weird: os name"');
    expect(yamlScalar('- leading dash')).toBe('"- leading dash"');
  });

  it('escapes embedded double quotes', () => {
    const out = yamlScalar('say "hi"');
    expect(out.startsWith('"')).toBe(true);
    expect(out).toContain('\\"hi\\"');
  });

  it('round-trips a quoted value through parseFrontmatter', () => {
    const line = setFrontmatterField('# n', 'os', 'F5 BIG-IP: 15.1');
    expect(parseFrontmatter(line).os).toBe('F5 BIG-IP: 15.1');
  });
});
