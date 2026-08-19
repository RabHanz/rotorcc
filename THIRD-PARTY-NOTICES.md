# Third-party notices

rotorcc ships no bundled third-party code. Its one runtime dependency is
[zod](https://github.com/colinhacks/zod) (MIT).

This file exists for a different reason: **attribution for work rotorcc
learned from**.

## claude-swap

rotorcc's account subsystem — how Claude Code's credentials are stored and
swapped, which locks must be held while doing it, where the quota lives and how
its windows are shaped — was developed by studying **claude-swap**, an MIT-licensed
project by **Onur Cetinkol**.

- Repository: <https://github.com/realiti4/claude-swap>
- Licence: MIT
- Copyright (c) Onur Cetinkol

rotorcc is an independent implementation in TypeScript, not a port of
claude-swap's source, and it is not affiliated with, endorsed by, or derived
from that project's branding. But several things in it are not independent
discoveries and it would be dishonest to present them as such. Specifically,
the following were learned from claude-swap and are reflected in rotorcc's
`src/accounts/`:

| What | Where in rotorcc |
| --- | --- |
| Claude Code's config/credential path resolution, including the `~/.claude.json` vs `<config-home>/.config.json` asymmetry | `src/core/paths.ts` |
| The `proper-lockfile` directory-lock protocol Claude Code uses, the two credential locks and their acquisition order, and the 60s/10s staleness values | `src/accounts/ccLock.ts` |
| That Claude Code reads the macOS Keychain before the plaintext credentials file, and that OAuth and managed API keys are separate auth axes that must be mutually cleared | `src/accounts/credentials.ts` |
| That MCP OAuth state and plugin secrets are machine-shared rather than account-scoped, and must be composed from the live copy on activation | `src/accounts/credentials.ts` |
| The OAuth token endpoint, the usage endpoint, the `anthropic-beta` header value, the public client id, and the shape of the usage response including per-model `limits` entries | `src/accounts/oauth.ts` |
| That a refresh token is one-time, so a credential read from a lagging backend must never be refreshed | `src/accounts/oauth.ts`, `src/accounts/credentials.ts` |
| The pace / projected-exhaustion idea for weekly windows | `src/core/burn.ts` |

Several of these are load-bearing safety properties that are not obvious and
would most likely have been discovered the expensive way. The credit is owed.

### MIT License (claude-swap)

```
MIT License

Copyright (c) Onur Cetinkol

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Anthropic

rotorcc talks to two Anthropic endpoints using the operator's own credentials.
It is not an Anthropic product and is not affiliated with or endorsed by
Anthropic. "Claude" and "Claude Code" are Anthropic's.
