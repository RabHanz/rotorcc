/**
 * The secrets screen decides whether a snapshot may leave the machine, so it is
 * tested from both sides: it must catch the obvious credential shapes, and it
 * must not cry wolf over ordinary transcript text. A screen nobody believes
 * gets switched off, and then it protects nothing.
 */
import { describe, expect, it } from 'vitest';

import { compilePatterns, invalidPatterns, maskExcerpt, scanText } from '../src/core/secrets.js';

const patterns = compilePatterns();

function hits(text: string): string[] {
  return scanText(text, 'fixture.jsonl', patterns).map((h) => h.patternId);
}

describe('secrets screen — must catch', () => {
  const positives: Array<[string, string]> = [
    ['private-key-block', '-----BEGIN RSA PRIVATE KEY-----\\nMIIEow...'],
    ['private-key-block', 'text before -----BEGIN OPENSSH PRIVATE KEY----- text after'],
    ['aws-access-key-id', 'aws_access_key_id = AKIAIOSFODNN7EXAMPLE'],
    ['aws-access-key-id', 'ASIAZZZZZZZZZZZZZZZZ appeared in the log'],
    ['github-token', 'GH_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789'],
    ['slack-token', 'xoxb-123456789012-abcdefghijklmnop'],
    // Google keys are the literal AIza followed by exactly 35 characters.
    ['google-api-key', 'key AIzaSyA1234567890abcdefghijklmnopqrstuv here'],
    ['live-secret-key', 'sk_live_4eC39HqLyjWDarjtT1zdp7dc'],
    ['openai-style-key', 'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789ABCD'],
    [
      'jwt',
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
    ],
    ['credential-assignment', 'SERVICE_API_KEY=8f2b91c4d7e6a05b3f1c9d8e7a6b5c4d'],
    ['credential-assignment', 'DATABASE_PASSWORD: hunter2hunter2hunter2'],
    ['credential-assignment', 'STRIPE_SECRET_KEY="rk_test_51H8xYzABCDEFGH"'],
  ];

  it.each(positives)('catches %s', (id, text) => {
    expect(hits(text)).toContain(id);
  });
});

describe('secrets screen — must not cry wolf', () => {
  const negatives: string[] = [
    'The assistant ran `git status` and found three modified files.',
    'export ANTHROPIC_API_KEY= # deliberately unset, see the README',
    'API_KEY=<your-key-here>',
    'SECRET_KEY=changeme',
    'PASSWORD=placeholder',
    'AWS_SECRET_ACCESS_KEY=xxxxxxxxxxxxxxxxxxxx',
    'TOKEN: "REDACTED"',
    'a long hex string of no particular meaning: 8f2b91c4d7e6a05b3f1c9d8e7a6b5c4d',
    'commit 1299c61a8f0e5b4c3d2a1908f7e6d5c4b3a29180 fixed the build',
    'the file is sk-something.md in the docs directory',
    'Read /home/dev/project/src/index.ts and reply with a summary of the exports.',
    'BEGIN was printed by the test harness',
    'password reset emails now use the new template',
    'SECRET=$MY_SECRET',
    'API_KEY={{ vault_lookup }}',
    // Found by running the screen over real transcripts: code that reads a
    // secret is not a secret, and an escaped newline is an empty value.
    "const SECRET = process.env['AUTH_SECRET'] ?? '';",
    'DB_PASSWORD = os.environ.get("DB_PASSWORD")',
    'api_key: config.credentials.apiKey',
    'ANTHROPIC_API_KEY=\\n54\\tCODEX_BIN=codex',
    'GITHUB_TOKEN=\\r\\nNEXT_LINE=value',
    'API_KEY=${SOME_OTHER_VARIABLE}',
    'SERVICE_SECRET=vault:secret/data/service#key',
  ];

  it.each(negatives)('leaves %s alone', (text) => {
    expect(hits(text)).toEqual([]);
  });
});

describe('secrets screen — configuration', () => {
  it('applies user patterns alongside the defaults', () => {
    const custom = compilePatterns(['INTERNAL-[0-9]{6}']);
    expect(scanText('ticket INTERNAL-123456 filed', 'f', custom).map((h) => h.patternId)).toEqual([
      'custom-1',
    ]);
  });

  it('skips a user pattern that is not a valid regex, rather than dying', () => {
    expect(() => compilePatterns(['([unclosed'])).not.toThrow();
    expect(compilePatterns(['([unclosed'])).toHaveLength(compilePatterns().length);
  });

  it('reports invalid user patterns so doctor can surface them', () => {
    expect(invalidPatterns(['ok', '([unclosed'])).toEqual(['([unclosed']);
  });
});

describe('maskExcerpt', () => {
  it('never reproduces the credential it found', () => {
    const secret = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
    const text = `token is ${secret} in the log`;
    const excerpt = maskExcerpt(text, text.indexOf(secret), secret.length);
    expect(excerpt).not.toContain(secret);
    expect(excerpt).toContain('chars');
  });
});
