/**
 * The secrets screen.
 *
 * rotorcc copies transcripts to a machine-local git store unconditionally —
 * those bytes are already on that disk, and refusing to back them up protects
 * nothing. What it will not do is push them somewhere new. So the screen runs
 * over the delta of each snapshot, and a hit blocks the MIRROR only, loudly.
 *
 * The patterns aim at credential shapes that are unmistakable, not at anything
 * that merely looks entropic. A screen that cries wolf gets switched off, and a
 * screen that is off protects nothing either.
 */

export interface SecretPattern {
  id: string;
  regex: RegExp;
  description: string;
}

export const DEFAULT_PATTERNS: SecretPattern[] = [
  {
    id: 'private-key-block',
    regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/,
    description: 'PEM private key block',
  },
  {
    id: 'aws-access-key-id',
    regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
    description: 'AWS access key id',
  },
  {
    id: 'github-token',
    regex: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/,
    description: 'GitHub personal access or app token',
  },
  {
    id: 'slack-token',
    regex: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/,
    description: 'Slack token',
  },
  {
    id: 'google-api-key',
    regex: /\bAIza[0-9A-Za-z_-]{35}\b/,
    description: 'Google API key',
  },
  {
    id: 'live-secret-key',
    regex: /\bsk_live_[0-9A-Za-z]{16,}\b/,
    description: 'live secret key (Stripe-style prefix)',
  },
  {
    id: 'openai-style-key',
    regex: /\bsk-[A-Za-z0-9](?:[A-Za-z0-9_-]{30,})\b/,
    description: 'sk- prefixed provider key',
  },
  {
    id: 'jwt',
    regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
    description: 'signed JSON web token',
  },
  {
    id: 'credential-assignment',
    // NAME=value where NAME reads like a credential and the value is long
    // enough to be a real one. Placeholders and obvious redactions are excluded
    // so the screen stays believable; a screen nobody believes gets turned off.
    regex: new RegExp(
      String.raw`\b[A-Z0-9_]{0,40}(?:API_KEY|SECRET_KEY|ACCESS_KEY|ACCESS_TOKEN|AUTH_TOKEN|REFRESH_TOKEN|PRIVATE_KEY|PASSWORD|PASSWD|SECRET|CREDENTIALS?)\s*[=:]\s*["']?` +
        String.raw`(?!(?:x{4,}|X{4,}|\*{3,}|\.{3,}|redacted|REDACTED|changeme|CHANGEME|your[-_]|example|EXAMPLE|placeholder|PLACEHOLDER|null|None|true|false)[^A-Za-z0-9]?)` +
        String.raw`[^\s"',;<>{}$]{12,}`,
    ),
    description: 'credential-shaped assignment with a real-looking value',
  },
];

export interface SecretHit {
  patternId: string;
  description: string;
  /** File the hit was found in, relative to the snapshot root. */
  file: string;
  /** Byte offset within the scanned chunk. */
  offset: number;
  /** A short, already-masked excerpt, safe to log. */
  excerpt: string;
}

export function maskExcerpt(text: string, index: number, patternLength: number): string {
  const start = Math.max(0, index - 12);
  const raw = text.slice(start, index + Math.min(patternLength, 24) + 12);
  return raw
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[A-Za-z0-9_-]{12,}/g, (token) => `${token.slice(0, 4)}…${token.length}chars`);
}

export function compilePatterns(extra: string[] = []): SecretPattern[] {
  const compiled: SecretPattern[] = [...DEFAULT_PATTERNS];
  extra.forEach((source, index) => {
    try {
      compiled.push({
        id: `custom-${index + 1}`,
        regex: new RegExp(source),
        description: `user pattern ${JSON.stringify(source)}`,
      });
    } catch {
      // A bad user regex must not disable the whole screen; it is reported by
      // `rotorcc doctor` instead.
    }
  });
  return compiled;
}

export function invalidPatterns(extra: string[]): string[] {
  return extra.filter((source) => {
    try {
      new RegExp(source);
      return false;
    } catch {
      return true;
    }
  });
}

/** Scan one chunk of text. Returns every distinct pattern that matched. */
export function scanText(text: string, file: string, patterns: SecretPattern[]): SecretHit[] {
  const hits: SecretHit[] = [];
  for (const pattern of patterns) {
    const match = pattern.regex.exec(text);
    if (match !== null && match.index >= 0) {
      hits.push({
        patternId: pattern.id,
        description: pattern.description,
        file,
        offset: match.index,
        excerpt: maskExcerpt(text, match.index, match[0].length),
      });
    }
  }
  return hits;
}
