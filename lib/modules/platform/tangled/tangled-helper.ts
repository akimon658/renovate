import type {} from '@atcute/atproto';
import { Client, ok, simpleFetchHandler } from '@atcute/client';
import { PasswordSession } from '@atcute/password-session';
import type {
  OrgTangledReviewPatch,
  OrgTangledTrackTicket,
} from '@atcute/tangled';
import { isObject } from '@sindresorhus/is';
import { DateTime } from 'luxon';
import { logger } from '../../../logger/index.ts';
import { coerceArray } from '../../../util/array.ts';
import { TangledHttp } from '../../../util/http/tangled.ts';
import { regEx } from '../../../util/regex.ts';
import {
  ensureTrailingSlash,
  getQueryString,
  parseUrl,
} from '../../../util/url.ts';
import type {
  ResubmitPullResult,
  TangledLabel,
  TangledPull,
  TangledPullStatus,
  TangledRepoRef,
} from './types.ts';
import { rkeyFromUri } from './utils.ts';

const tangledHttp = new TangledHttp();

let session: PasswordSession | null = null;
let pdsClient: Client | null = null;
let botDid = '';
let botHandle = '';

/**
 * Base-32 sortable charset used by AT Protocol TIDs.
 */
const TID_CHARSET = '234567abcdefghijklmnopqrstuvwxyz';

/**
 * Generate a new TID (Timestamp-based ID) for use as a record key.
 */
function generateTid(): string {
  const timestamp = BigInt(Date.now()) * 1000n;
  const clockId = BigInt(Math.floor(Math.random() * 1024));
  const value = (timestamp << 10n) | clockId;

  let result = '';
  let remaining = value;
  for (let i = 0; i < 13; i++) {
    result = TID_CHARSET[parseInt((remaining & 31n).toString(), 10)] + result;
    remaining >>= 5n;
  }
  return result;
}

/**
 * Authenticate with the PDS using an app password.
 * Returns the bot's DID and handle.
 */
export async function createSession(
  service: string,
  identifier: string,
  password: string,
): Promise<{ did: string; handle: string; pdsUrl: string }> {
  session = await PasswordSession.login({
    service,
    identifier,
    password,
  });

  pdsClient = new Client({ handler: session });
  botDid = session.did;
  botHandle = session.session.handle;

  return {
    did: botDid,
    handle: botHandle,
    pdsUrl: session.dispatchUrl,
  };
}

/**
 * Get a service auth JWT for authenticating with a knotserver or index.
 */
export async function getServiceAuth(
  aud: string,
  lxm?: string,
): Promise<string> {
  if (!pdsClient) {
    throw new Error('Not authenticated - call createSession first');
  }

  const params: Record<string, unknown> = { aud };
  if (lxm) {
    params.lxm = lxm;
  }

  const result = await ok(
    pdsClient.get('com.atproto.server.getServiceAuth', {
      params: params as any,
    }),
  );
  return result.token;
}

function didFromAtUri(uri: string): string {
  return uri.split('/')[2];
}

function knotUrlFromHost(knotHost: string): string {
  return `https://${knotHost}`;
}

function didWebFromKnotHost(knotHost: string): string {
  return `did:web:${knotHost.replace(':', '%3A')}`;
}

/**
 * Authenticated write to a knot hosting a repo DID's records.
 *
 * The audience is the repo DID itself, bound to the XRPC method.
 */
async function knotPost<T>(
  repoDid: string,
  knotUrl: string,
  nsid: string,
  input: unknown,
): Promise<T> {
  const token = await getServiceAuth(repoDid, nsid);
  const url = `${knotUrl.replace(regEx(/\/$/), '')}/xrpc/${nsid}`;
  const res = await tangledHttp.postJson<T>(url, {
    body: input,
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });
  return res.body;
}

async function knotGetRecord(
  knotUrl: string,
  repoDid: string,
  collection: string,
  rkey: string,
): Promise<{ uri: string; cid?: string; value: any }> {
  const query = getQueryString({ repo: repoDid, collection, rkey });
  const url = `${knotUrl.replace(regEx(/\/$/), '')}/xrpc/com.atproto.repo.getRecord?${query}`;
  const res = await tangledHttp.getJsonUnchecked<{
    uri: string;
    cid?: string;
    value: any;
  }>(url);
  return res.body;
}

async function knotListRecords(
  knotUrl: string,
  repoDid: string,
  collection: string,
  limit = 100,
): Promise<{ uri: string; cid?: string; value: any }[]> {
  const records: { uri: string; cid?: string; value: any }[] = [];
  let cursor: string | undefined;
  do {
    const query = getQueryString({
      repo: repoDid,
      collection,
      limit,
      ...(cursor ? { cursor } : {}),
    });
    const url = `${knotUrl.replace(regEx(/\/$/), '')}/xrpc/com.atproto.repo.listRecords?${query}`;
    const res = await tangledHttp.getJsonUnchecked<{
      records: { uri: string; cid?: string; value: any }[];
      cursor?: string;
    }>(url);
    records.push(...res.body.records);
    cursor = res.body.cursor;
  } while (cursor);
  return records;
}

/**
 * Claim a knot-written record on the bot's own PDS, the way the web app
 * does, so the record is visible as the bot's own action.
 * Failures are non-fatal.
 */
async function attest(uri: string, cid: string): Promise<void> {
  if (!pdsClient) {
    throw new Error('Not authenticated');
  }
  try {
    await ok(
      pdsClient.post('com.atproto.repo.createRecord', {
        input: {
          repo: botDid as any,
          collection: 'org.tangled.graph.attestation' as any,
          rkey: generateTid() as any,
          record: {
            $type: 'org.tangled.graph.attestation',
            subject: { uri, cid },
            createdAt: DateTime.utc().toISO(),
          },
        },
      }),
    );
  } catch (err) {
    logger.debug({ err, uri }, 'Failed to attest knot-written record');
  }
}

/**
 * Get the branch head commit from the index.
 */
export async function getBranchHead(
  repoDid: string,
  branch: string,
  appview: string,
): Promise<string> {
  const query = getQueryString({ repo: repoDid, ref: `refs/heads/${branch}` });
  const url = `${ensureTrailingSlash(appview)}xrpc/org.tangled.temp.git.getRef?${query}`;
  const res = await tangledHttp.getJsonUnchecked<{ oid: string }>(url);
  if (!res.body?.oid) {
    throw new Error(`Could not determine head for branch "${branch}"`);
  }
  return res.body.oid;
}

/**
 * Get the merge base of two commits from the index.
 */
export async function getMergeBase(
  repoDid: string,
  base: string,
  head: string,
  appview: string,
): Promise<string> {
  const query = getQueryString({ repos: [repoDid], base, head });
  const url = `${ensureTrailingSlash(appview)}xrpc/org.tangled.temp.git.getMergeBase?${query}`;
  const res = await tangledHttp.getJsonUnchecked<{ commit: string }>(url);
  if (!res.body?.commit) {
    throw new Error('Could not determine merge base');
  }
  return res.body.commit;
}

/**
 * Get the default branch and its head from the index.
 */
export async function getDefaultBranch(
  repoDid: string,
  appview: string,
): Promise<{ name: string; hash: string }> {
  const query = getQueryString({ repo: repoDid, limit: 100 });
  const url = `${ensureTrailingSlash(appview)}xrpc/org.tangled.temp.git.listBranches?${query}`;
  const res = await tangledHttp.getJsonUnchecked<{
    defaultBranch?: string;
    branches?: { name: string; oid: string }[];
  }>(url);
  const name = res.body?.defaultBranch;
  if (!name) {
    throw new Error(`Could not determine default branch for ${repoDid}`);
  }
  const branch = res.body.branches?.find((b) => b.name === name);
  // Fall back to a direct ref lookup when the list omits the OID.
  const hash = branch?.oid ?? (await getBranchHead(repoDid, name, appview));
  return { name, hash };
}

/**
 * Read a file from a repository via the index blob endpoint.
 */
export async function getBlob(
  repoDid: string,
  ref: string,
  path: string,
  appview: string,
): Promise<string | null> {
  const query = getQueryString({ repo: repoDid, ref, path });
  const url = `${ensureTrailingSlash(appview)}xrpc/org.tangled.temp.git.getBlob?${query}`;

  try {
    const res = await tangledHttp.getText(url);
    return res.body;
  } catch {
    return null;
  }
}

/**
 * Get a format-patch between two commits from the index.
 */
export async function getFormatPatch(
  repoDid: string,
  from: string,
  to: string,
  appview: string,
): Promise<string> {
  const query = getQueryString({ repo: repoDid, from, to });
  const url = `${ensureTrailingSlash(appview)}xrpc/org.tangled.temp.git.formatPatch?${query}`;
  const res = await tangledHttp.getText(url);
  return res.body;
}

interface TicketRecordInput {
  title: string;
  body?: string;
  targetBranch: string;
}

function toTicketRecord(input: TicketRecordInput): Record<string, unknown> {
  const now = DateTime.utc().toISO();
  const record: Record<string, unknown> = {
    $type: 'org.tangled.track.ticket',
    title: {
      $type: 'org.tangled.markup.markdown#inline',
      text: input.title,
    },
    state: 'open',
    targetBranch: input.targetBranch,
    createdAt: now,
  };
  if (input.body?.trim()) {
    record.body = {
      $type: 'org.tangled.markup.markdown',
      text: input.body,
    };
  }
  return record;
}

/**
 * Create a pull request the way the web app does: a ticket on the repo,
 * then a patch from the merge base to the source head.
 */
export async function createPullRecord(
  repoDid: string,
  knotUrl: string,
  targetBranch: string,
  sourceBranch: string,
  sourceHead: string,
  base: string,
  title: string,
  body: string,
): Promise<{ uri: string; cid: string; rkey: string }> {
  if (!pdsClient) {
    throw new Error('Not authenticated');
  }

  const ticket = toTicketRecord({ title, body, targetBranch });
  const created = await knotPost<{ uri: string; cid: string }>(
    repoDid,
    knotUrl,
    'com.atproto.repo.createRecord',
    {
      repo: repoDid,
      collection: 'org.tangled.track.ticket',
      record: ticket,
    },
  );
  const rkey = rkeyFromUri(created.uri);

  try {
    const patch = await knotPost<{ uri: string; cid: string }>(
      repoDid,
      knotUrl,
      'org.tangled.review.submitPatch',
      {
        repo: repoDid,
        patch: {
          ticket: rkey,
          base: { oid: base },
          head: { oid: sourceHead },
          sourceRepo: repoDid,
          sourceBranch,
        },
      },
    );
    // Claim both records on the bot's PDS. Best-effort.
    await attest(created.uri, created.cid);
    await attest(patch.uri, patch.cid);
  } catch (err) {
    // Roll back the ticket when the patch is refused, mirroring tng-cli.
    try {
      const token = await getServiceAuth(
        repoDid,
        'com.atproto.repo.deleteRecord',
      );
      await tangledHttp.postJson(
        `${knotUrl.replace(regEx(/\/$/), '')}/xrpc/com.atproto.repo.deleteRecord`,
        {
          body: {
            repo: repoDid,
            collection: 'org.tangled.track.ticket',
            rkey,
          },
          headers: { Authorization: `Bearer ${token}` },
        },
      );
    } catch (deleteErr) {
      logger.debug(
        { err: deleteErr, rkey },
        'Failed to delete ticket after patch submission failed',
      );
    }
    throw err;
  }

  return { uri: created.uri, cid: created.cid, rkey };
}

/**
 * Read a ticket record from the knot, returning the record and its
 * current CID (used as a compare-and-swap precondition on writes).
 */
async function getTicketRecord(
  repoDid: string,
  knotUrl: string,
  rkey: string,
): Promise<{ record: Record<string, any>; cid?: string; uri: string }> {
  const res = await knotGetRecord(
    knotUrl,
    repoDid,
    'org.tangled.track.ticket',
    rkey,
  );
  return { record: res.value, cid: res.cid, uri: res.uri };
}

/**
 * Write a ticket record back to the knot.
 */
async function putTicketRecord(
  repoDid: string,
  knotUrl: string,
  rkey: string,
  record: Record<string, unknown>,
  swapRecord?: string,
): Promise<{ uri: string; cid: string }> {
  const clean = Object.fromEntries(
    Object.entries(record).filter(([key]) => !key.startsWith('x-tngl-')),
  );
  const res = await knotPost<{ uri: string; cid: string }>(
    repoDid,
    knotUrl,
    'com.atproto.repo.putRecord',
    {
      repo: repoDid,
      collection: 'org.tangled.track.ticket',
      rkey,
      record: clean,
      ...(swapRecord ? { swapRecord } : {}),
    },
  );
  return res;
}

/**
 * Returns whether an error is an AT Protocol `InvalidSwap` response, meaning
 * the record was modified since it was read.
 */
function isInvalidSwap(err: unknown): boolean {
  return isObject(err) && (err as { error?: string }).error === 'InvalidSwap';
}

/**
 * Update a pull request ticket (title/body).
 */
export async function updatePullRecord(
  repoDid: string,
  knotUrl: string,
  rkey: string,
  updates: { title?: string; body?: string },
): Promise<void> {
  if (!pdsClient) {
    throw new Error('Not authenticated');
  }
  for (let attempt = 0; ; attempt++) {
    const { record, cid } = await getTicketRecord(repoDid, knotUrl, rkey);

    if (updates.title !== undefined) {
      record.title = {
        $type: 'org.tangled.markup.markdown#inline',
        text: updates.title,
      };
    }
    if (updates.body !== undefined) {
      if (updates.body?.trim()) {
        record.body = {
          $type: 'org.tangled.markup.markdown',
          text: updates.body,
        };
      } else {
        delete record.body;
      }
    }

    try {
      const ref = await putTicketRecord(repoDid, knotUrl, rkey, record, cid);
      await attest(ref.uri, ref.cid);
      return;
    } catch (err) {
      if (attempt > 0 || !isInvalidSwap(err)) {
        throw err;
      }
      logger.debug(
        { err, rkey },
        'Pull request record changed concurrently, retrying update',
      );
    }
  }
}

/**
 * List patch rounds for a ticket, oldest first.
 */
async function listRounds(
  repoDid: string,
  knotUrl: string,
  ticket: string,
): Promise<OrgTangledReviewPatch.Main[]> {
  const records = await knotListRecords(
    knotUrl,
    repoDid,
    'org.tangled.review.patch',
  );
  const rounds: OrgTangledReviewPatch.Main[] = [];
  for (const rec of records) {
    const value = rec.value as OrgTangledReviewPatch.Main & {
      ticket?: string;
      createdAt?: string;
    };
    if (value?.ticket === ticket) {
      rounds.push(value);
    }
  }
  rounds.sort((a, b) =>
    String((a as { createdAt?: string }).createdAt ?? '').localeCompare(
      String((b as { createdAt?: string }).createdAt ?? ''),
    ),
  );
  return rounds;
}

/**
 * Sync a pull request's latest round with the current source branch.
 *
 * Compares the latest round's head with the source branch head from the
 * index. Submits a new patch when they differ. Safe to call on every run.
 */
export async function resubmitPull(
  repoDid: string,
  knotUrl: string,
  appview: string,
  targetBranch: string,
  sourceBranch: string,
  rkey: string,
  dryRun = false,
): Promise<ResubmitPullResult> {
  if (!dryRun && !pdsClient) {
    throw new Error('Not authenticated');
  }
  // Cheap checks first: read the rounds and the source branch head, and
  // return early when they already match. The merge base is only computed
  // when a new round will actually be submitted, keeping the common
  // no-change case to one knot read plus one index read.
  const rounds = await listRounds(repoDid, knotUrl, rkey);
  const latest = rounds.at(-1) as { head?: { oid?: string } } | undefined;
  const sourceHead = await getBranchHead(repoDid, sourceBranch, appview);

  if (latest?.head?.oid === sourceHead) {
    return {
      changed: false,
      resubmitted: false,
      round: rounds.length ? rounds.length - 1 : null,
    };
  }

  if (dryRun) {
    return {
      changed: true,
      resubmitted: false,
      round: rounds.length ? rounds.length - 1 : null,
    };
  }

  const targetHead = await getBranchHead(repoDid, targetBranch, appview);
  const base = await getMergeBase(repoDid, targetHead, sourceHead, appview);

  // submitPatch creates a new immutable record without a compare-and-swap
  // precondition, so there is nothing to retry on: concurrent submissions
  // simply append another round.
  const patch = await knotPost<{ uri: string; cid: string }>(
    repoDid,
    knotUrl,
    'org.tangled.review.submitPatch',
    {
      repo: repoDid,
      patch: {
        ticket: rkey,
        base: { oid: base },
        head: { oid: sourceHead },
        sourceRepo: repoDid,
        sourceBranch,
      },
    },
  );
  await attest(patch.uri, patch.cid);
  return { changed: true, resubmitted: true, round: rounds.length };
}

function mapTicketState(state: unknown): TangledPullStatus {
  if (state === 'completed' || state === 'merged') {
    return 'merged';
  }
  if (state === 'closed') {
    return 'closed';
  }
  return 'open';
}

/**
 * Set the state of a pull request ticket (open/closed/completed).
 */
export async function setPullState(
  repoDid: string,
  knotUrl: string,
  rkey: string,
  state: 'open' | 'closed' | 'completed',
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    const { record, cid } = await getTicketRecord(repoDid, knotUrl, rkey);
    record.state = state;
    try {
      const ref = await putTicketRecord(repoDid, knotUrl, rkey, record, cid);
      await attest(ref.uri, ref.cid);
      return;
    } catch (err) {
      if (attempt > 0 || !isInvalidSwap(err)) {
        throw err;
      }
      logger.debug({ err, rkey }, 'Ticket changed concurrently, retrying');
    }
  }
}

/**
 * List all pull requests (tickets with `targetBranch`) for a repository.
 *
 * Reads the ticket list from the index and patch rounds from the knot,
 * so every author's PRs are included.
 */
export async function listPullRecords(
  repoDid: string,
  knotUrl: string,
  appview: string,
): Promise<TangledPull[]> {
  const items: {
    uri: string;
    cid?: string;
    value: unknown;
    state?: string;
  }[] = [];
  let cursor: string | undefined;

  do {
    const query = getQueryString({
      subject: repoDid,
      limit: 100,
      ...(cursor ? { cursor } : {}),
    });
    const url = `${ensureTrailingSlash(appview)}xrpc/org.tangled.repo.listPulls?${query}`;
    const res = await tangledHttp.getJsonUnchecked<{
      items: {
        uri: string;
        cid?: string;
        value: unknown;
        state?: string;
      }[];
      cursor?: string;
    }>(url);
    items.push(...res.body.items);
    cursor = res.body.cursor;
  } while (cursor);

  // Fetch all patches once, grouped by ticket.
  const patchRecords = await knotListRecords(
    knotUrl,
    repoDid,
    'org.tangled.review.patch',
  );
  const byTicket = new Map<string, OrgTangledReviewPatch.Main[]>();
  for (const rec of patchRecords) {
    const value = rec.value as OrgTangledReviewPatch.Main & {
      ticket?: string;
    };
    const ticket = value?.ticket;
    if (!ticket) {
      continue;
    }
    const list = coerceArray(byTicket.get(ticket));
    list.push(value);
    byTicket.set(ticket, list);
  }
  for (const rounds of byTicket.values()) {
    rounds.sort((a, b) =>
      String((a as { createdAt?: string }).createdAt ?? '').localeCompare(
        String((b as { createdAt?: string }).createdAt ?? ''),
      ),
    );
  }

  const pulls: TangledPull[] = [];
  for (const item of items) {
    const rkey = rkeyFromUri(item.uri);
    const record = item.value as OrgTangledTrackTicket.Main & {
      targetBranch?: string;
      state?: string;
    };
    // Issues have no targetBranch; only pull requests are relevant.
    if (!record?.targetBranch) {
      continue;
    }
    pulls.push({
      uri: item.uri,
      cid: item.cid ?? '',
      rkey,
      record: record,
      rounds: coerceArray(byTicket.get(rkey)),
      status: mapTicketState(item.state ?? record.state),
    });
  }

  return pulls;
}

/**
 * List label definitions in a repository, returning a map of definition
 * AT-URI to display name.
 */
export async function listLabelDefinitions(
  appview: string,
  repoDid: string,
): Promise<Map<string, string>> {
  const definitions = new Map<string, string>();
  let cursor: string | undefined;

  do {
    const query = getQueryString({
      subject: repoDid,
      limit: 100,
      ...(cursor ? { cursor } : {}),
    });
    const url = `${ensureTrailingSlash(appview)}xrpc/org.tangled.label.listDefinitions?${query}`;
    const res = await tangledHttp.getJsonUnchecked<{
      items: { uri: string; value: { name?: string } }[];
      cursor?: string;
    }>(url);
    for (const item of res.body.items) {
      if (item.value?.name) {
        definitions.set(item.uri, item.value.name);
      }
    }
    cursor = res.body.cursor;
  } while (cursor);

  return definitions;
}

/**
 * Compute the labels currently applied to a pull request.
 *
 * Labels are stored on the ticket itself (`tangledLabels`), with
 * definitions owned by the repository.
 */
export async function getLabels(
  appview: string,
  repoDid: string,
  ticketUri: string,
): Promise<TangledLabel[]> {
  const query = getQueryString({ uri: ticketUri });
  const url = `${ensureTrailingSlash(appview)}xrpc/org.tangled.track.getTicketView?${query}`;
  let view: { tangledLabels?: { key: string }[] };
  try {
    const res = await tangledHttp.getJsonUnchecked<{
      tangledLabels?: { key: string }[];
    }>(url);
    view = res.body;
  } catch (err) {
    logger.debug({ err, ticketUri }, 'Failed to read ticket view for labels');
    return [];
  }

  const tokens = coerceArray(view.tangledLabels);
  if (tokens.length === 0) {
    return [];
  }

  const definitions = await listLabelDefinitions(appview, repoDid);
  // Index definitions by rkey for lookup from label tokens.
  const byRkey = new Map<string, { uri: string; name: string }>();
  for (const [uri, name] of definitions) {
    byRkey.set(rkeyFromUri(uri), { uri, name });
  }

  return tokens
    .map((token) => {
      const def = byRkey.get(token.key);
      if (!def) {
        return null;
      }
      return { key: def.uri, value: '', name: def.name };
    })
    .filter((label): label is TangledLabel => label !== null);
}

/**
 * Remove a label from a ticket by display name.
 */
export async function removeLabel(
  repoDid: string,
  knotUrl: string,
  appview: string,
  rkey: string,
  labelName: string,
): Promise<boolean> {
  const definitions = await listLabelDefinitions(appview, repoDid);
  const matchingRkeys = new Set<string>();
  for (const [uri, name] of definitions) {
    if (name === labelName) {
      matchingRkeys.add(rkeyFromUri(uri));
    }
  }
  if (matchingRkeys.size === 0) {
    return false;
  }

  for (let attempt = 0; ; attempt++) {
    const { record, cid } = await getTicketRecord(repoDid, knotUrl, rkey);
    const current = Array.isArray(record.tangledLabels)
      ? (record.tangledLabels as { key: string }[])
      : [];
    const filtered = current.filter((token) => !matchingRkeys.has(token.key));
    if (filtered.length === current.length) {
      return false;
    }
    record.tangledLabels = filtered;
    try {
      const ref = await putTicketRecord(repoDid, knotUrl, rkey, record, cid);
      await attest(ref.uri, ref.cid);
      return true;
    } catch (err) {
      if (attempt > 0 || !isInvalidSwap(err)) {
        throw err;
      }
      logger.debug({ err, rkey }, 'Ticket changed concurrently, retrying');
    }
  }
}

/**
 * Merge a pull request via the index, the way the web app's
 * "Rebase & merge" does, then mark the ticket completed.
 */
export async function mergePull(
  repoDid: string,
  knotUrl: string,
  knotHost: string,
  appview: string,
  targetBranch: string,
  rkey: string,
): Promise<void> {
  const rounds = await listRounds(repoDid, knotUrl, rkey);
  const latest = rounds.at(-1) as
    | {
        head?: { oid?: string };
        source?: { repo?: string };
      }
    | undefined;
  const head = latest?.head?.oid;
  if (!head) {
    throw new Error(`Pull request #${rkey} has no patch to merge`);
  }
  if (latest?.source?.repo && latest.source.repo !== repoDid) {
    throw new Error(
      `Pull request #${rkey} comes from another repo; merges are same-repo only`,
    );
  }

  const targetHead = await getBranchHead(repoDid, targetBranch, appview);

  const serviceAuthToken = await getServiceAuth(
    didWebFromKnotHost(knotHost),
    'org.tangled.git.receivePack',
  );

  const url = `${ensureTrailingSlash(appview)}xrpc/sh.tangled.git.mergeCommit`;
  await tangledHttp.postJson(url, {
    body: {
      target: {
        $type: 'sh.tangled.git.mergeCommit#target',
        repo: repoDid,
        branch: targetBranch,
        commit: targetHead,
      },
      source: {
        $type: 'sh.tangled.git.mergeCommit#source',
        repo: repoDid,
        commit: head,
      },
      style: 'rebase',
    },
    headers: {
      Authorization: `Bearer ${serviceAuthToken}`,
    },
  });

  await setPullState(repoDid, knotUrl, rkey, 'completed');
}

/**
 * Resolve an AT Protocol handle to a DID.
 */
export async function resolveHandle(handle: string): Promise<string> {
  const client = new Client({
    handler: simpleFetchHandler({ service: 'https://public.api.bsky.app' }),
  });

  const result = await ok(
    client.get('com.atproto.identity.resolveHandle', {
      params: { handle: handle as any },
    }),
  );
  return result.did;
}

/**
 * Default service used when the owner's PDS cannot be determined.
 */
const DEFAULT_SERVICE = 'https://public.api.bsky.app';

/**
 * AT Protocol DID document, limited to the fields we need.
 */
interface DidDocument {
  service?: {
    id?: string;
    type?: string;
    serviceEndpoint?: string;
  }[];
}

/**
 * Resolve the PDS endpoint for a DID using its DID document.
 */
export async function resolvePdsEndpoint(did: string): Promise<string> {
  let url: string;
  if (did.startsWith('did:plc:')) {
    url = `https://plc.directory/${did}`;
  } else if (did.startsWith('did:web:')) {
    const parts = did
      .slice('did:web:'.length)
      .split(':')
      .map((segment) => decodeURIComponent(segment));
    const host = parts[0];
    const path = parts.slice(1).join('/');
    url = path
      ? `https://${host}/${path}/did.json`
      : `https://${host}/.well-known/did.json`;
  } else {
    return DEFAULT_SERVICE;
  }

  try {
    const res = await tangledHttp.getJsonUnchecked<DidDocument>(url);
    const pds = res.body.service?.find((svc) => {
      if (svc.type === 'AtprotoPersonalDataServer') {
        return true;
      }
      return svc.id?.endsWith('#atproto_pds') ?? false;
    });
    return pds?.serviceEndpoint ?? DEFAULT_SERVICE;
  } catch (err) {
    logger.debug({ err, did }, 'Failed to resolve PDS endpoint for DID');
    return DEFAULT_SERVICE;
  }
}

/**
 * Resolve the PDS endpoint that hosts an account, given its handle.
 */
export async function resolvePdsForHandle(
  handle: string,
): Promise<{ did: string; pdsUrl: string }> {
  const did = await resolveHandle(handle);
  const pdsUrl = await resolvePdsEndpoint(did);
  return { did, pdsUrl };
}

/**
 * Resolve a repository via the index.
 *
 * Uses `org.tangled.repo.getRepoByName` on the appview, which returns the
 * repo DID (as the record URI authority), the knot host, and the manifest.
 */
export async function resolveRepoRef(
  ownerDid: string,
  repoName: string,
  appview: string,
): Promise<TangledRepoRef> {
  const query = getQueryString({ owner: ownerDid, name: repoName });
  const url = `${ensureTrailingSlash(appview)}xrpc/org.tangled.repo.getRepoByName?${query}`;
  let body: {
    uri: string;
    knot?: string;
    value?: { declaration?: { name?: string } };
    defaultBranch?: string;
  };
  try {
    const res = await tangledHttp.getJsonUnchecked<{
      uri: string;
      knot?: string;
      value?: { declaration?: { name?: string } };
      defaultBranch?: string;
    }>(url);
    body = res.body;
  } catch (err) {
    logger.debug({ err, ownerDid, repoName }, 'Failed to resolve repo');
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Tangled repository "${repoName}" was not found for ${ownerDid}: ${detail}`,
    );
  }

  if (!body?.uri) {
    throw new Error(
      `Tangled repository "${repoName}" was not found for ${ownerDid}`,
    );
  }

  const repoDid = didFromAtUri(body.uri);
  if (!repoDid) {
    throw new Error(`Could not determine repo DID for "${repoName}"`);
  }

  let knot = body.knot;
  let knotUrl = knot ? knotUrlFromHost(knot) : '';
  if (!knot) {
    // Fall back to the repo DID document, which names the knot as PDS.
    const pdsUrl = await resolvePdsEndpoint(repoDid);
    const parsed = parseUrl(pdsUrl);
    knot = parsed?.host ?? '';
    knotUrl = parsed ? `${parsed.protocol}//${parsed.host}` : '';
  }

  if (!knot) {
    throw new Error(
      `Could not determine knot host for repository "${repoName}"`,
    );
  }

  return {
    knot,
    knotUrl,
    repoDid,
    name: body.value?.declaration?.name ?? repoName,
    defaultBranch: body.defaultBranch,
  };
}

export function getBotDid(): string {
  return botDid;
}

export function getBotHandle(): string {
  return botHandle;
}

export function resetHelper(): void {
  session = null;
  pdsClient = null;
  botDid = '';
  botHandle = '';
}
