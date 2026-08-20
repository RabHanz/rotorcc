/**
 * `rotorcc accounts …` — the account management surface.
 *
 * Every command here has a `--json` form and every one of them reports what it
 * refused to do as clearly as what it did. Two conventions hold throughout:
 *
 *   - **Unknown headroom prints the word `unknown`**, in the table and in the
 *     JSON alike, with the reason. `null` in JSON, never `0`.
 *   - **A destructive command names what it is about to destroy** and requires
 *     `--yes` when the answer is not obviously recoverable.
 *
 * Nothing in this file prints a credential. `accounts export` is the one
 * command that moves credential bytes, and it says what it is doing in a way
 * that cannot be mistaken for a metadata dump.
 */
import { existsSync, readFileSync } from 'node:fs';

import type { Config } from '../config/schema.js';
import { AccountManager } from '../accounts/manager.js';
import { writeJsonAtomic } from '../accounts/atomic.js';
import {
  type Secret,
  asSecret,
  classifyCredential,
  credentialDiagnostics,
  credentialFingerprint,
} from '../accounts/credentials.js';
import { importFromCswap } from '../accounts/importCswap.js';
import { MappingStore } from '../accounts/mappings.js';
import {
  type Roster,
  type RosterSlot,
  nextFreeSlot,
  normaliseAlias,
  resolveIdentifier,
  slotLabel,
  slots,
  swapSlots,
} from '../accounts/roster.js';
import { findUnclaimed, purgeUnclaimed } from '../accounts/unclaimed.js';
import { claudeCredentialsPath, claudeGlobalConfigPath } from '../core/paths.js';
import { selectTarget, type Strategy } from '../accounts/select.js';
import { switchAccount } from '../accounts/switch.js';
import { accountJson, formatBinding, windowLines } from '../core/usage.js';
import { formatAge } from '../accounts/manager.js';

export interface AccountsContext {
  config: Config;
  manager: AccountManager;
  dryRun: boolean;
  json: boolean;
  yes: boolean;
  out: (line: string) => void;
}

/** `rotorcc accounts` / `accounts list`. */
export async function listAccounts(ctx: AccountsContext, force = false): Promise<number> {
  const reading = await ctx.manager.readUsage({ force });

  if (ctx.json) {
    ctx.out(
      JSON.stringify(
        {
          activeAccount: reading.activeAccountNumber,
          activeDetection: reading.activeDetectionReason ?? null,
          observedAt: reading.observedAt,
          // `accountJson` is the one shape every --json surface emits. It nulls
          // what was never measured — never 0, never 100 — and its `windows`
          // array ALWAYS carries `5h` and `7d`, so a consumer never has to
          // guess whether a missing window meant "empty" or "not reported".
          accounts: reading.accounts.map((a) => ({
            ...accountJson(a),
            // Kept for consumers written against the previous shape: `window`
            // was the binding window's name and still is.
            window: accountJson(a).bindingWindow,
          })),
        },
        null,
        2,
      ),
    );
    return 0;
  }

  if (reading.accounts.length === 0) {
    ctx.out('rotorcc manages no accounts yet.');
    ctx.out('');
    ctx.out('  rotorcc accounts add                    capture the login Claude Code is using now');
    ctx.out(
      "  rotorcc accounts import --from-cswap    bring across an existing switcher's accounts",
    );
    return 0;
  }

  ctx.out('  how much of each window has been SPENT');
  ctx.out('');
  for (const account of reading.accounts) {
    const marker = account.active ? '>' : ' ';
    const label = account.alias ?? account.email ?? `account ${account.number}`;
    const tags =
      (account.disabled === true ? ' [disabled]' : '') +
      (account.kind === 'api-key' ? ' [api-key]' : '');
    const age =
      account.usageAgeMs === null || account.usageAgeMs === undefined
        ? ''
        : ` · ${formatAge(account.usageAgeMs)} old`;

    // BOTH windows for every account. Which one binds is said on the row and
    // again beside the window it names — never instead of the other number,
    // because a 99%-spent 5-hour window and a spent week look identical when
    // only one of them is on screen.
    ctx.out(
      `  ${marker} ${String(account.number).padEnd(3)} ${label.slice(0, 30).padEnd(30)} ` +
        `${formatBinding(account)}${age}${tags}`,
    );
    for (const line of windowLines(account)) ctx.out(line);
  }

  if (reading.activeAccountNumber === null && reading.activeDetectionReason !== undefined) {
    ctx.out('');
    ctx.out(`  active account not identified: ${reading.activeDetectionReason}`);
  }
  return 0;
}

/** `rotorcc accounts add` — capture the login Claude Code is using right now. */
export async function addAccount(
  ctx: AccountsContext,
  options: { slot?: number; email?: string; alias?: string },
): Promise<number> {
  const live = await ctx.manager.credentials.readActive();
  if (live.kind === 'unreadable') {
    ctx.out(`cannot add: the live credential could not be read — ${live.detail}`);
    return 1;
  }
  if (live.kind === 'absent') {
    ctx.out('cannot add: there is no Claude Code credential on this machine.');
    ctx.out('Log in with Claude Code first, then run this again.');
    return 1;
  }
  if (live.degraded) {
    // These bytes may be a superseded generation. Stashing them would create a
    // slot holding a refresh token that is already spent — an account that
    // looks fine until the first time it is needed.
    ctx.out('cannot add: the live credential was read from a fallback backend and may be stale.');
    ctx.out('Adding it could store a credential that is already superseded. Retry in a moment.');
    return 1;
  }

  const roster = ctx.manager.roster.read();
  const fingerprint = credentialFingerprint(live.value);
  for (const existing of slots(roster)) {
    const stash = await ctx.manager.credentials.readStash(existing.slot, existing.email);
    if (stash.kind === 'found' && credentialFingerprint(stash.value) === fingerprint) {
      ctx.out(
        `this login is already slot ${existing.slot} (${slotLabel(existing)}); nothing to do`,
      );
      return 0;
    }
  }

  const config = ctx.manager.credentials.readGlobalConfig();
  const identity = config?.oauthAccount ?? null;
  const identityRecord =
    typeof identity === 'object' && identity !== null ? (identity as Record<string, unknown>) : {};

  const email =
    options.email ??
    (typeof identityRecord.emailAddress === 'string' ? identityRecord.emailAddress : undefined) ??
    (typeof identityRecord.email === 'string' ? identityRecord.email : undefined);
  if (email === undefined || email === '') {
    ctx.out("cannot add: could not determine this login's email from Claude Code's config.");
    ctx.out('Pass it explicitly:  rotorcc accounts add --email you@example.com');
    return 1;
  }

  const slot = options.slot ?? nextFreeSlot(roster);
  if (roster.accounts[String(slot)] !== undefined && !ctx.yes) {
    ctx.out(`slot ${slot} is already taken by ${roster.accounts[String(slot)]?.email ?? '?'}.`);
    ctx.out('Pass --yes to overwrite it, or choose another with --slot.');
    return 1;
  }

  let alias = '';
  if (options.alias !== undefined) alias = normaliseAlias(options.alias);

  if (ctx.dryRun) {
    ctx.out(`DRY RUN — would add ${email} as slot ${slot}. Nothing was written.`);
    return 0;
  }

  await ctx.manager.credentials.writeStash(slot, email, live.value);
  if (identity !== null) ctx.manager.credentials.writeAccountIdentity(slot, email, identity);
  ctx.manager.roster.update((r) => {
    r.accounts[String(slot)] = {
      email,
      uuid: typeof identityRecord.accountUuid === 'string' ? identityRecord.accountUuid : '',
      organizationUuid:
        typeof identityRecord.organizationUuid === 'string' ? identityRecord.organizationUuid : '',
      organizationName:
        typeof identityRecord.organizationName === 'string' ? identityRecord.organizationName : '',
      added: new Date().toISOString(),
      alias,
      disabled: false,
      kind: classifyCredential(live.value) === 'api-key' ? 'api-key' : 'oauth',
    };
    r.activeSlot = slot;
  });

  ctx.out(`added ${email} as slot ${slot}${alias === '' ? '' : ` (alias "${alias}")`}`);
  return 0;
}

/** `rotorcc accounts add-token [TOKEN|-]` — register a setup token or API key. */
export async function addToken(
  ctx: AccountsContext,
  options: { token?: string; slot?: number; email?: string; alias?: string },
): Promise<number> {
  let raw = options.token;
  if (raw === undefined || raw === '-') {
    // Reading from stdin is the recommended path and the default when no
    // argument is given: a token on the command line is visible in the shell
    // history and in `ps` output for every user on the machine.
    raw = readAllStdin();
  }
  const token = (raw ?? '').trim();
  if (token === '') {
    ctx.out('no token supplied. Pipe one in:  echo "$TOKEN" | rotorcc accounts add-token -');
    return 1;
  }

  const kind = classifyCredential(token);
  let credential: Secret;
  if (kind === 'api-key') {
    credential = asSecret(token);
  } else if (kind === 'oauth') {
    credential = asSecret(token);
  } else if (token.startsWith('sk-ant-oat')) {
    // A bare setup token. Wrap it in the credential envelope Claude Code reads.
    credential = asSecret(JSON.stringify({ claudeAiOauth: { accessToken: token, scopes: [] } }));
  } else {
    ctx.out('that does not look like a setup token, an API key, or a credential object.');
    ctx.out('Expected an sk-ant-oat… token, an sk-ant-api… key, or a credentials JSON object.');
    return 1;
  }

  const roster = ctx.manager.roster.read();
  const slot = options.slot ?? nextFreeSlot(roster);
  const isApiKey = kind === 'api-key';
  const email = options.email ?? `${isApiKey ? 'api-key' : 'setup-token'}-${slot}@token.local`;

  if (roster.accounts[String(slot)] !== undefined && !ctx.yes) {
    ctx.out(`slot ${slot} is already taken. Pass --yes to overwrite it, or choose --slot.`);
    return 1;
  }
  if (ctx.dryRun) {
    ctx.out(
      `DRY RUN — would register a ${isApiKey ? 'managed API key' : 'setup token'} as slot ${slot}.`,
    );
    return 0;
  }

  await ctx.manager.credentials.writeStash(slot, email, credential);
  ctx.manager.roster.update((r) => {
    r.accounts[String(slot)] = {
      email,
      uuid: '',
      organizationUuid: '',
      organizationName: '',
      added: new Date().toISOString(),
      alias: options.alias === undefined ? '' : normaliseAlias(options.alias),
      disabled: false,
      kind: isApiKey ? 'api-key' : 'oauth',
    };
  });

  ctx.out(`registered slot ${slot} (${email})`);
  if (isApiKey) {
    ctx.out(
      'note: API-key accounts bill per token and have no quota window, so rotorcc will never ' +
        'rotate onto this one automatically. Name it explicitly to use it.',
    );
  }
  return 0;
}

export async function removeAccount(ctx: AccountsContext, identifier: string): Promise<number> {
  const found = requireSlot(ctx, identifier);
  if (found === null) return 1;
  if (!ctx.yes) {
    ctx.out(`this removes slot ${found.slot} (${slotLabel(found)}) and its stored credential.`);
    ctx.out(
      'If this is the only copy of that login, you will have to log in again to get it back.',
    );
    ctx.out('Re-run with --yes to confirm.');
    return 1;
  }
  if (ctx.dryRun) {
    ctx.out(`DRY RUN — would remove slot ${found.slot} (${slotLabel(found)}).`);
    return 0;
  }
  await ctx.manager.credentials.deleteStash(found.slot, found.email);
  ctx.manager.credentials.deleteAccountIdentity(found.slot, found.email);
  ctx.manager.cache.forget(found.slot);
  ctx.manager.roster.update((r) => {
    delete r.accounts[String(found.slot)];
    if (r.activeSlot === found.slot) r.activeSlot = null;
  });
  ctx.out(`removed slot ${found.slot}`);
  return 0;
}

export function setAlias(ctx: AccountsContext, identifier: string, alias: string): number {
  const found = requireSlot(ctx, identifier);
  if (found === null) return 1;
  if (alias === '--unset') {
    ctx.manager.roster.update((r) => {
      const entry = r.accounts[String(found.slot)];
      if (entry !== undefined) entry.alias = '';
    });
    ctx.out(`cleared the alias on slot ${found.slot}`);
    return 0;
  }
  let normalised: string;
  try {
    normalised = normaliseAlias(alias);
  } catch (err) {
    ctx.out((err as Error).message);
    return 1;
  }
  const clash = slots(ctx.manager.roster.read()).find(
    (s) => s.alias === normalised && s.slot !== found.slot,
  );
  if (clash !== undefined) {
    ctx.out(`"${normalised}" is already slot ${clash.slot}'s alias`);
    return 1;
  }
  ctx.manager.roster.update((r) => {
    const entry = r.accounts[String(found.slot)];
    if (entry !== undefined) entry.alias = normalised;
  });
  ctx.out(`slot ${found.slot} is now "${normalised}"`);
  return 0;
}

export function setDisabled(ctx: AccountsContext, identifier: string, disabled: boolean): number {
  const found = requireSlot(ctx, identifier);
  if (found === null) return 1;
  ctx.manager.roster.update((r) => {
    const entry = r.accounts[String(found.slot)];
    if (entry !== undefined) entry.disabled = disabled;
  });
  ctx.out(
    disabled
      ? `slot ${found.slot} is held out of automatic rotation (you can still switch to it by name)`
      : `slot ${found.slot} is back in automatic rotation`,
  );
  return 0;
}

/** `accounts swap <a> <b>` — exchange two slots' numbers, credentials and all. */
export async function swapAccounts(
  ctx: AccountsContext,
  aRef: string,
  bRef: string,
): Promise<number> {
  const a = requireSlot(ctx, aRef);
  const b = requireSlot(ctx, bRef);
  if (a === null || b === null) return 1;
  if (a.slot === b.slot) {
    ctx.out('those are the same slot');
    return 1;
  }
  if (ctx.dryRun) {
    ctx.out(`DRY RUN — would swap slots ${a.slot} and ${b.slot}.`);
    return 0;
  }

  // Move the credentials first. The stash is keyed by (slot, email), so a
  // roster swap without moving the bytes would leave each slot pointing at the
  // other's credential — a switch would then activate the wrong account while
  // reporting the right one.
  const stashA = await ctx.manager.credentials.readStash(a.slot, a.email);
  const stashB = await ctx.manager.credentials.readStash(b.slot, b.email);
  if (stashA.kind === 'unreadable' || stashB.kind === 'unreadable') {
    ctx.out("refusing to swap: one of those slots' credentials could not be read.");
    return 1;
  }
  const identityA = ctx.manager.credentials.readAccountIdentity(a.slot, a.email);
  const identityB = ctx.manager.credentials.readAccountIdentity(b.slot, b.email);

  // Ordered so that no failure can lose a credential.
  //
  // Write BOTH new copies first and verify them; only then update the roster;
  // only then delete the old copies. At every instant in that sequence the
  // credential exists in at least one place the roster or this function can
  // still find, so the worst outcome is a duplicate — which the cleanup below,
  // or a later swap, removes — rather than a slot whose bytes are gone.
  //
  // Doing the deletes before the roster write, as this used to, meant a throw
  // in the middle left a stash file at a (slot, email) the roster had never
  // heard of and nothing would ever reference or clean up again.
  try {
    if (stashA.kind === 'found') {
      await ctx.manager.credentials.writeStash(b.slot, a.email, stashA.value);
    }
    if (stashB.kind === 'found') {
      await ctx.manager.credentials.writeStash(a.slot, b.email, stashB.value);
    }
    if (identityA !== null)
      ctx.manager.credentials.writeAccountIdentity(b.slot, a.email, identityA);
    if (identityB !== null)
      ctx.manager.credentials.writeAccountIdentity(a.slot, b.email, identityB);

    // Verify before committing to the roster. A write that silently did not
    // land would otherwise be discovered at the next switch, which is the worst
    // possible moment.
    if (stashA.kind === 'found') {
      const check = await ctx.manager.credentials.readStash(b.slot, a.email);
      if (check.kind !== 'found') throw new Error(`slot ${b.slot} did not receive its credential`);
    }
    if (stashB.kind === 'found') {
      const check = await ctx.manager.credentials.readStash(a.slot, b.email);
      if (check.kind !== 'found') throw new Error(`slot ${a.slot} did not receive its credential`);
    }
  } catch (err) {
    // Roll the new copies back off. The originals were never touched, so the
    // machine is exactly where it started.
    await ctx.manager.credentials.deleteStash(b.slot, a.email);
    await ctx.manager.credentials.deleteStash(a.slot, b.email);
    ctx.manager.credentials.deleteAccountIdentity(b.slot, a.email);
    ctx.manager.credentials.deleteAccountIdentity(a.slot, b.email);
    ctx.out(`swap failed and was undone: ${(err as Error).message.slice(0, 160)}`);
    return 1;
  }

  try {
    ctx.manager.roster.update((r) => swapSlots(r, a.slot, b.slot));
  } catch (err) {
    // Inside the guard too. A roster write can legitimately fail — it refuses a
    // torn file rather than overwriting it — and leaving the duplicated stashes
    // behind would put a credential at a (slot, email) the roster has never
    // heard of, which nothing would ever reference or clean up.
    await ctx.manager.credentials.deleteStash(b.slot, a.email);
    await ctx.manager.credentials.deleteStash(a.slot, b.email);
    ctx.manager.credentials.deleteAccountIdentity(b.slot, a.email);
    ctx.manager.credentials.deleteAccountIdentity(a.slot, b.email);
    ctx.out(`swap failed and was undone: ${(err as Error).message.slice(0, 160)}`);
    return 1;
  }

  // Only now are the originals redundant. A failure past this point leaves a
  // stale copy at the old key, which is untidy but harmless — the roster no
  // longer points at it and the next swap overwrites it.
  await ctx.manager.credentials.deleteStash(a.slot, a.email);
  await ctx.manager.credentials.deleteStash(b.slot, b.email);
  ctx.manager.credentials.deleteAccountIdentity(a.slot, a.email);
  ctx.manager.credentials.deleteAccountIdentity(b.slot, b.email);

  ctx.manager.cache.forget(a.slot);
  ctx.manager.cache.forget(b.slot);
  ctx.out(`swapped slots ${a.slot} and ${b.slot}`);
  return 0;
}

/** `accounts move <ref> <slot>` — put an account in a specific slot. */
export async function moveAccount(
  ctx: AccountsContext,
  identifier: string,
  target: number,
): Promise<number> {
  const found = requireSlot(ctx, identifier);
  if (found === null) return 1;
  if (found.slot === target) {
    ctx.out(`slot ${target} is already where that account is`);
    return 0;
  }
  const roster = ctx.manager.roster.read();
  const occupant = roster.accounts[String(target)];
  if (occupant !== undefined) return swapAccounts(ctx, String(found.slot), String(target));

  if (ctx.dryRun) {
    ctx.out(`DRY RUN — would move slot ${found.slot} to slot ${target}.`);
    return 0;
  }
  const stash = await ctx.manager.credentials.readStash(found.slot, found.email);
  if (stash.kind === 'unreadable') {
    ctx.out("refusing to move: that slot's credential could not be read.");
    return 1;
  }
  if (stash.kind === 'found') {
    await ctx.manager.credentials.writeStash(target, found.email, stash.value);
  }
  const identity = ctx.manager.credentials.readAccountIdentity(found.slot, found.email);
  if (identity !== null)
    ctx.manager.credentials.writeAccountIdentity(target, found.email, identity);
  await ctx.manager.credentials.deleteStash(found.slot, found.email);
  ctx.manager.credentials.deleteAccountIdentity(found.slot, found.email);

  ctx.manager.roster.update((r) => {
    const entry = r.accounts[String(found.slot)];
    if (entry === undefined) return;
    r.accounts[String(target)] = entry;
    delete r.accounts[String(found.slot)];
    if (r.activeSlot === found.slot) r.activeSlot = target;
  });
  ctx.manager.cache.forget(found.slot);
  ctx.out(`moved slot ${found.slot} to slot ${target}`);
  return 0;
}

/** `rotorcc accounts import --from-cswap`. */
export async function importAccounts(
  ctx: AccountsContext,
  options: { from?: string; overwrite?: boolean },
): Promise<number> {
  const report = await importFromCswap({
    roster: ctx.manager.roster,
    credentials: ctx.manager.credentials,
    ...(options.from !== undefined ? { from: options.from } : {}),
    dryRun: ctx.dryRun,
    ...(options.overwrite !== undefined ? { overwrite: options.overwrite } : {}),
  });

  if (ctx.json) {
    ctx.out(JSON.stringify(report, null, 2));
    return report.imported.length > 0 || report.alreadyPresent.length > 0 ? 0 : 1;
  }

  if (report.storePath === null) {
    for (const skip of report.skipped) ctx.out(skip.reason);
    return 1;
  }
  ctx.out(`${ctx.dryRun ? 'DRY RUN — reading' : 'imported from'} ${report.storePath}`);
  for (const entry of report.imported) {
    ctx.out(`  slot ${entry.slot}  ${entry.email}  ${entry.note}`);
  }
  for (const slot of report.alreadyPresent) {
    ctx.out(`  slot ${slot}  already in rotorcc's roster, left alone (--overwrite to replace)`);
  }
  for (const skip of report.skipped) {
    ctx.out(`  ${skip.slot === null ? '' : `slot ${skip.slot}  `}skipped: ${skip.reason}`);
  }
  if (report.imported.length === 0 && report.alreadyPresent.length === 0) {
    ctx.out('nothing was imported.');
    return 1;
  }
  ctx.out('');
  ctx.out(
    ctx.dryRun
      ? 'Nothing was written. Re-run without --dry-run to actually import.'
      : 'rotorcc now has its own copies. The source store was not modified and is not read again.',
  );
  return 0;
}

/**
 * `rotorcc accounts export <path>` — write a portable copy.
 *
 * This DOES move credential bytes, and says so twice, because an export file
 * left in a repository is the shape of every credential leak there has ever
 * been. It is written 0600 and the message names the file.
 */
export async function exportAccounts(ctx: AccountsContext, path: string): Promise<number> {
  if (!ctx.yes) {
    ctx.out(`This writes REAL CREDENTIALS for every managed account into ${path}.`);
    ctx.out('Anyone who reads that file can act as those accounts. It is not encrypted.');
    ctx.out('Re-run with --yes if that is what you want.');
    return 1;
  }
  const roster = ctx.manager.roster.read();
  const bundle: {
    version: 1;
    exportedAt: string;
    accounts: Array<Record<string, unknown>>;
  } = { version: 1, exportedAt: new Date().toISOString(), accounts: [] };

  for (const slot of slots(roster)) {
    const stash = await ctx.manager.credentials.readStash(slot.slot, slot.email);
    if (stash.kind !== 'found') {
      ctx.out(`  slot ${slot.slot}: no readable credential, exported as metadata only`);
    }
    bundle.accounts.push({
      slot: slot.slot,
      email: slot.email,
      uuid: slot.uuid,
      organizationUuid: slot.organizationUuid,
      organizationName: slot.organizationName,
      alias: slot.alias,
      disabled: slot.disabled,
      kind: slot.kind,
      credential: stash.kind === 'found' ? String(stash.value) : null,
      identity: ctx.manager.credentials.readAccountIdentity(slot.slot, slot.email),
    });
  }

  if (ctx.dryRun) {
    ctx.out(`DRY RUN — would write ${bundle.accounts.length} account(s) to ${path}.`);
    return 0;
  }
  writeJsonAtomic(path, bundle, { mode: 0o600 });
  ctx.out(`wrote ${bundle.accounts.length} account(s) to ${path} (mode 0600)`);
  ctx.out('That file contains live credentials. Move it somewhere safe and delete it when done.');
  return 0;
}

export async function importBundle(ctx: AccountsContext, path: string): Promise<number> {
  if (!existsSync(path)) {
    ctx.out(`${path} does not exist`);
    return 1;
  }
  let bundle: { accounts?: Array<Record<string, unknown>> };
  try {
    bundle = JSON.parse(readFileSync(path, 'utf8')) as {
      accounts?: Array<Record<string, unknown>>;
    };
  } catch (err) {
    ctx.out(`${path} is not valid JSON: ${(err as Error).message.slice(0, 120)}`);
    return 1;
  }
  const entries = bundle.accounts ?? [];
  let count = 0;
  for (const entry of entries) {
    const slot = Number(entry.slot);
    const email = typeof entry.email === 'string' ? entry.email : '';
    if (!Number.isInteger(slot) || email === '') continue;
    const existing = ctx.manager.roster.read().accounts[String(slot)];
    if (existing !== undefined && !ctx.yes) {
      ctx.out(`  slot ${slot} already exists; --yes to overwrite. Skipped.`);
      continue;
    }
    if (ctx.dryRun) {
      ctx.out(`  DRY RUN — would import slot ${slot} (${email})`);
      count += 1;
      continue;
    }
    if (typeof entry.credential === 'string' && entry.credential !== '') {
      await ctx.manager.credentials.writeStash(slot, email, asSecret(entry.credential));
    }
    if (entry.identity !== undefined && entry.identity !== null) {
      ctx.manager.credentials.writeAccountIdentity(slot, email, entry.identity);
    }
    ctx.manager.roster.update((r) => {
      r.accounts[String(slot)] = {
        email,
        uuid: typeof entry.uuid === 'string' ? entry.uuid : '',
        organizationUuid: typeof entry.organizationUuid === 'string' ? entry.organizationUuid : '',
        organizationName: typeof entry.organizationName === 'string' ? entry.organizationName : '',
        added: new Date().toISOString(),
        alias: typeof entry.alias === 'string' ? entry.alias : '',
        disabled: entry.disabled === true,
        kind: entry.kind === 'api-key' ? 'api-key' : 'oauth',
      };
    });
    count += 1;
  }
  ctx.out(`${ctx.dryRun ? 'would import' : 'imported'} ${count} account(s) from ${path}`);
  return count > 0 ? 0 : 1;
}

/** `rotorcc switch [ref] [--strategy ...]`. */
export async function switchCommand(
  ctx: AccountsContext,
  options: { identifier?: string; strategy?: Strategy; force?: boolean },
): Promise<number> {
  const roster = ctx.manager.roster.read();
  let target: RosterSlot | null = null;
  let reason = '';

  if (options.identifier !== undefined && options.identifier !== '') {
    target = requireSlot(ctx, options.identifier);
    if (target === null) return 1;
    reason = 'named explicitly';
  } else {
    const reading = await ctx.manager.readUsage({ force: options.force ?? false });
    const selection = selectTarget(reading, {
      strategy: options.strategy ?? 'best',
      activeNumber: reading.activeAccountNumber,
      minHeadroomPct: ctx.config.minTargetHeadroomPct,
    });
    if (selection.chosen === null) {
      if (ctx.json) ctx.out(JSON.stringify({ ok: false, reason: selection.reason }, null, 2));
      else ctx.out(selection.reason);
      return 3;
    }
    const found = slots(roster).find((s) => s.slot === selection.chosen?.number);
    if (found === undefined) {
      ctx.out('the chosen account is no longer in the roster');
      return 1;
    }
    target = found;
    reason = selection.reason;
  }

  const result = await switchAccount({
    roster: ctx.manager.roster,
    credentials: ctx.manager.credentials,
    target,
    dryRun: ctx.dryRun,
    // The same environment the credential store reads and writes through.
    // Left to default, the switch would take Claude Code's advisory locks in
    // one home while moving credentials in another — which is to say, take no
    // useful lock at all.
    env: ctx.manager.credentials.env,
  });

  if (ctx.json) {
    ctx.out(JSON.stringify({ ...result, selection: reason }, null, 2));
    return result.ok ? 0 : 1;
  }
  ctx.out(result.detail);
  if (reason !== '') ctx.out(`  (${reason})`);
  for (const warning of result.warnings) ctx.out(`  warning: ${warning}`);
  return result.ok ? 0 : 1;
}

/** `rotorcc map|unmap` — bind a directory to an account. */
export function mapCommand(
  ctx: AccountsContext,
  options: { identifier?: string; path?: string },
): number {
  const store = new MappingStore(ctx.manager.accountsDir);
  if (options.identifier === undefined) {
    const list = store.list();
    if (ctx.json) {
      ctx.out(JSON.stringify(list, null, 2));
      return 0;
    }
    if (list.length === 0) {
      ctx.out('no directory is mapped to an account');
      return 0;
    }
    for (const entry of list) ctx.out(`  ${String(entry.slot).padEnd(4)} ${entry.path}`);
    return 0;
  }
  const found = requireSlot(ctx, options.identifier);
  if (found === null) return 1;
  const path = store.set(options.path ?? process.cwd(), found.slot);
  ctx.out(`${path} → slot ${found.slot} (${slotLabel(found)})`);
  return 0;
}

export function unmapCommand(ctx: AccountsContext, path?: string): number {
  const store = new MappingStore(ctx.manager.accountsDir);
  const target = path ?? process.cwd();
  ctx.out(store.unset(target) ? `unmapped ${target}` : `${target} was not mapped`);
  return 0;
}

/**
 * `rotorcc accounts unclaimed [--purge <id>]` — orphaned-credential recovery.
 *
 * Nothing else in rotorcc surfaces these. They are the residue of a switch or a
 * swap that died between writing a credential and updating the roster, and the
 * only two honest things to do with one are "put it back" and "delete it on
 * purpose". Both need an operator to see it first, which is what this is.
 */
export function unclaimedAccounts(ctx: AccountsContext, options: { purge?: string } = {}): number {
  const roster = ctx.manager.roster.read();

  if (options.purge !== undefined) return purgeOneUnclaimed(ctx, roster, options.purge);

  const entries = findUnclaimed(ctx.manager.accountsDir, roster);

  if (ctx.json) {
    ctx.out(
      JSON.stringify(
        {
          accountsDir: ctx.manager.accountsDir,
          unclaimed: entries,
          // Said in the JSON as well as on screen: a consumer that treats an
          // empty list as "the store is clean" would be wrong on macOS.
          keychainNotEnumerated: process.platform === 'darwin',
        },
        null,
        2,
      ),
    );
    return 0;
  }

  if (entries.length === 0) {
    ctx.out('no orphaned credentials: every stored credential belongs to an account in the roster');
    if (process.platform === 'darwin') {
      ctx.out('');
      ctx.out(
        '  note: this scans the credential FILES only. On macOS a stash can also live in the',
      );
      ctx.out(
        '  Keychain, and there is no way to list those without a prompt, so an orphan held only',
      );
      ctx.out('  in the Keychain would not appear here.');
    }
    return 0;
  }

  ctx.out(`${entries.length} orphaned credential(s) in ${ctx.manager.accountsDir}:`);
  ctx.out('');
  for (const entry of entries) {
    ctx.out(`  ${entry.id}`);
    ctx.out(
      `      slot ${entry.slot ?? '?'}   ${entry.email ?? 'login unknown'}` +
        (entry.emailIsExact ? '' : ' (from the filename, so possibly approximate)'),
    );
    ctx.out(`      ${entry.detail}`);
    // "expired" vs "expires" is the difference between an operator purging a
    // dead credential and purging a working login that only needed moving back.
    // An orphan minutes old has an expiry in the FUTURE.
    const expiry =
      entry.accessTokenExpiresAt === null
        ? ''
        : `   access token ${Date.parse(entry.accessTokenExpiresAt) <= Date.now() ? 'expired' : 'expires'} ` +
          entry.accessTokenExpiresAt.slice(0, 16).replace('T', ' ');
    ctx.out(`      ${entry.kind}   ${entry.fingerprint ?? 'no fingerprint'}${expiry}`);
    ctx.out(
      `      last written ${entry.modifiedAt?.slice(0, 16).replace('T', ' ') ?? 'unknown'}` +
        (entry.ageMs === null ? '' : ` (${formatAge(entry.ageMs)} ago)`) +
        `, ${entry.files.length} file(s), ${entry.bytes} bytes`,
    );
    ctx.out('');
  }
  ctx.out('These are real logins. Two ways to deal with one:');
  ctx.out('');
  ctx.out('  put it back      rotorcc accounts import-bundle …, or re-add the login and switch');
  ctx.out('  delete it        rotorcc accounts unclaimed --purge <id> --yes');
  ctx.out('');
  ctx.out('There is no bulk purge, and there will not be one.');
  if (process.platform === 'darwin') {
    ctx.out('');
    ctx.out(
      '  note: credential FILES only — a Keychain-held orphan cannot be listed without a prompt.',
    );
  }
  return 0;
}

function purgeOneUnclaimed(ctx: AccountsContext, roster: Roster, id: string): number {
  const entries = findUnclaimed(ctx.manager.accountsDir, roster);
  const entry = entries.find((candidate) => candidate.id === id);
  if (entry === undefined) {
    ctx.out(`nothing unclaimed matches "${id}".`);
    if (entries.length > 0) {
      ctx.out('These are the ids that exist:');
      for (const candidate of entries) ctx.out(`  ${candidate.id}`);
    }
    ctx.out('');
    ctx.out('Ids are exact. There is no pattern matching here on purpose.');
    return 1;
  }

  // Enumerate, then require confirmation — the same shape as `accounts remove`,
  // for the same reason: a credential is not recoverable from a mistake.
  if (!ctx.yes) {
    ctx.out(`this deletes ${entry.files.length} file(s):`);
    for (const file of entry.files) ctx.out(`  ${file}`);
    ctx.out('');
    ctx.out(
      `That is a real login (${entry.email ?? 'unknown'}, ${entry.fingerprint ?? 'no fingerprint'}). ` +
        'If it is the only copy, it is gone.',
    );
    ctx.out(`Re-run with --yes:  rotorcc accounts unclaimed --purge ${entry.id} --yes`);
    return 1;
  }
  if (ctx.dryRun) {
    ctx.out(
      `DRY RUN — would delete ${entry.files.length} file(s) for ${entry.id}. Nothing written.`,
    );
    return 0;
  }

  const result = purgeUnclaimed(ctx.manager.accountsDir, roster, entry.id);
  if (!result.ok) {
    ctx.out(result.detail);
    return 1;
  }
  for (const file of result.removed) ctx.out(`  removed  ${file}`);
  ctx.out(`purged ${entry.id}`);
  return 0;
}

/**
 * `rotorcc accounts --token-status` — where each credential came from, and what
 * state its token is in.
 *
 * rotorcc already reads three separate stores to work out what is active. This
 * shows what it found in each, which is the difference between "my account will
 * not switch" and "the keychain answered and the file is a generation behind".
 *
 * **No token is ever printed.** Fingerprints, states, expiries and store names
 * only — see `credentialDiagnostics`, which is the only thing allowed to turn a
 * credential into words.
 */
export async function tokenStatus(ctx: AccountsContext): Promise<number> {
  const store = ctx.manager.credentials;
  const active = await store.readActive();
  const now = Date.now();

  const live =
    active.kind === 'found'
      ? {
          state: 'found' as const,
          source: LIVE_SOURCE_LABELS[active.backend],
          path: liveSourcePath(active.backend, store.env),
          degraded: active.degraded,
          ...credentialDiagnostics(active.value, now),
        }
      : { state: active.kind, detail: active.kind === 'unreadable' ? active.detail : null };

  const detected = await ctx.manager.detectActiveSlot();

  const stashes = [];
  for (const slot of slots(ctx.manager.roster.read())) {
    const stash = await store.readStash(slot.slot, slot.email);
    stashes.push({
      slot: slot.slot,
      email: slot.email,
      alias: slot.alias === '' ? null : slot.alias,
      active: detected.slot === slot.slot,
      source:
        stash.kind === 'found'
          ? stash.backend === 'keychain'
            ? 'macOS Keychain (rotorcc item)'
            : 'rotorcc credential file'
          : null,
      state: stash.kind,
      detail: stash.kind === 'unreadable' ? stash.detail : null,
      ...(stash.kind === 'found' ? credentialDiagnostics(stash.value, now) : {}),
    });
  }

  if (ctx.json) {
    ctx.out(
      JSON.stringify(
        { live, activeSlot: detected.slot, activeDetection: detected.reason, accounts: stashes },
        null,
        2,
      ),
    );
    return 0;
  }

  ctx.out('LIVE CREDENTIAL — what Claude Code will use on its next launch');
  if (live.state !== 'found') {
    ctx.out(
      `  ${live.state === 'absent' ? 'none: no Claude Code credential on this machine' : `unreadable: ${live.detail ?? ''}`}`,
    );
  } else {
    ctx.out(`  source        ${live.source}`);
    ctx.out(`                ${live.path}`);
    ctx.out(`  kind          ${live.kind}`);
    ctx.out(`  fingerprint   ${live.fingerprint ?? 'none'}`);
    ctx.out(`  token         ${describeTokenState(live.tokenState, live.expiresInSeconds)}`);
    ctx.out(
      `  refresh       ${live.refreshable ? 'a refresh token is present' : 'NO refresh token — this login cannot be renewed'}`,
    );
    if (live.subscriptionType !== null) ctx.out(`  plan          ${live.subscriptionType}`);
    if (live.degraded) {
      ctx.out(
        '  DEGRADED      read from a fallback store, so it may be a generation behind. rotorcc',
      );
      ctx.out('                will refuse to refresh or capture it in this state.');
    }
  }
  ctx.out('');
  ctx.out(`  active slot   ${detected.slot ?? 'not identified'} — ${detected.reason}`);
  ctx.out('');

  ctx.out('STORED CREDENTIALS — one per managed account');
  if (stashes.length === 0) ctx.out('  rotorcc manages no accounts yet.');
  for (const entry of stashes) {
    const label = entry.alias ?? entry.email;
    ctx.out(`  ${entry.active ? '>' : ' '} ${String(entry.slot).padEnd(3)} ${label}`);
    if (entry.state !== 'found') {
      ctx.out(
        `        ${entry.state === 'absent' ? 'no stored credential — re-add this account' : `unreadable: ${entry.detail ?? ''}`}`,
      );
      continue;
    }
    ctx.out(`        source       ${entry.source ?? 'unknown'}`);
    ctx.out(`        kind         ${entry.kind ?? 'unknown'}   ${entry.fingerprint ?? ''}`);
    ctx.out(
      `        token        ${describeTokenState(entry.tokenState ?? 'not-an-oauth-login', entry.expiresInSeconds ?? null)}`,
    );
    ctx.out(
      `        refresh      ${entry.refreshable === true ? 'present' : 'NONE — this login cannot be renewed'}`,
    );
  }
  ctx.out('');
  ctx.out('No token is printed here, ever. Fingerprints are truncated hashes of the refresh');
  ctx.out('token, which is what makes two generations of one login compare equal.');
  return 0;
}

const LIVE_SOURCE_LABELS: Record<'keychain' | 'file' | 'config', string> = {
  keychain: 'macOS Keychain (Claude Code item)',
  file: "Claude Code's credentials file",
  config: "Claude Code's global config (primaryApiKey)",
};

function liveSourcePath(backend: 'keychain' | 'file' | 'config', env: NodeJS.ProcessEnv): string {
  switch (backend) {
    case 'keychain':
      return 'service "Claude Code-credentials"';
    case 'file':
      return claudeCredentialsPath(env);
    case 'config':
      return claudeGlobalConfigPath(env);
  }
}

function describeTokenState(state: string, expiresInSeconds: number | null): string {
  const relative =
    expiresInSeconds === null
      ? ''
      : expiresInSeconds >= 0
        ? ` (${formatAge(expiresInSeconds * 1000)} left)`
        : ` (${formatAge(-expiresInSeconds * 1000)} ago)`;
  switch (state) {
    case 'valid':
      return `valid${relative}`;
    case 'expiring-soon':
      return `expiring within five minutes${relative} — rotorcc will refresh it on the next poll`;
    case 'expired':
      return `EXPIRED${relative} — rotorcc will refresh it on the next poll`;
    case 'no-expiry-recorded':
      return 'no expiry recorded (a setup token, or a shape rotorcc does not parse)';
    default:
      return 'not an OAuth login — nothing to expire';
  }
}

function requireSlot(ctx: AccountsContext, identifier: string): RosterSlot | null {
  const result = resolveIdentifier(ctx.manager.roster.read(), identifier);
  if (result.kind === 'found') return result.slot;
  if (result.kind === 'ambiguous') {
    ctx.out(
      `"${identifier}" matches more than one account: ` +
        result.matches.map((m) => `slot ${m.slot}`).join(', '),
    );
    ctx.out('Use the slot number.');
    return null;
  }
  ctx.out(`no account matches "${identifier}"`);
  return null;
}

function readAllStdin(): string {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}
