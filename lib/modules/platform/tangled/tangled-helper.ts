import { gunzipSync, gzipSync } from 'node:zlib';
import type {} from '@atcute/atproto';
import { Client, ok, simpleFetchHandler } from '@atcute/client';
import { PasswordSession } from '@atcute/password-session';
import type {
  ShTangledLabelDefinition,
  ShTangledLabelOp,
  ShTangledRepoPull,
} from '@atcute/tangled';
import { isObject, isTruthy } from '@sindresorhus/is';
import { DateTime } from 'luxon';
import { logger } from '../../../logger/index.ts';
import { coerceArray } from '../../../util/array.ts';
import { TangledHttp } from '../../../util/http/tangled.ts';
import { ensureTrailingSlash, getQueryString } from '../../../util/url.ts';
import type {
  ResubmitPullResult,
  TangledLabel,
  TangledLabelOperand,
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
 * TIDs encode a microsecond timestamp in the upper 53 bits
 * and a random clock ID in the lower 10 bits.
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
 * Get a service auth JWT for authenticating with a knotserver.
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

/**
 * Get the default branch info from a knotserver.
 */
export async function getDefaultBranch(
  knotHost: string,
  repo: string,
): Promise<{ name: string; hash: string }> {
  const query = getQueryString({ repo });
  const url = `https://${knotHost}/xrpc/sh.tangled.repo.getDefaultBranch?${query}`;
  const res = await tangledHttp.getJsonUnchecked<{
    name: string;
    hash: string;
  }>(url);
  return res.body;
}

/**
 * Get repository description from a knotserver.
 */
export async function describeRepo(
  knotHost: string,
  repoDid: string,
): Promise<{ ownerDid: string; repoDid: string; rkey: string }> {
  const query = getQueryString({ repoDid });
  const url = `https://${knotHost}/xrpc/sh.tangled.repo.describeRepo?${query}`;
  const res = await tangledHttp.getJsonUnchecked<{
    ownerDid: string;
    repoDid: string;
    rkey: string;
  }>(url);
  return res.body;
}

/**
 * Read a file from a repository via the knotserver blob endpoint.
 */
export async function getBlob(
  knotHost: string,
  repoDid: string,
  ref: string,
  path: string,
): Promise<string | null> {
  const query = getQueryString({ repo: repoDid, ref, path, raw: 'true' });
  const url = `https://${knotHost}/xrpc/sh.tangled.repo.blob?${query}`;

  try {
    const res = await tangledHttp.getText(url);
    return res.body;
  } catch {
    return null;
  }
}

/**
 * Get a format-patch comparing two revisions from the knotserver.
 *
 * The knotserver returns JSON (`sh.tangled.repo.compare`), with the raw
 * format-patch series in the `patch` field. This is the value Tangled's
 * appview gzips and stores as the pull's `patchBlob`.
 */
export async function compare(
  knotHost: string,
  repo: string,
  rev1: string,
  rev2: string,
): Promise<string> {
  const query = getQueryString({ repo, rev1, rev2 });
  const url = `https://${knotHost}/xrpc/sh.tangled.repo.compare?${query}`;
  const res = await tangledHttp.getJsonUnchecked<{ patch: string }>(url);
  return res.body.patch;
}

/**
 * Upload a blob to the PDS.
 */
export async function uploadBlob(
  data: Buffer,
): Promise<{ ref: { $link: string }; mimeType: string; size: number }> {
  if (!pdsClient) {
    throw new Error('Not authenticated');
  }

  const result = await ok(
    pdsClient.post('com.atproto.repo.uploadBlob', {
      input: new Blob([data as BlobPart], { type: 'application/gzip' }),
    }),
  );
  return result.blob;
}

/**
 * Create a pull request record in the bot's PDS.
 */
export async function createPullRecord(
  targetRepoDid: string,
  targetBranch: string,
  sourceBranch: string,
  title: string,
  body: string,
  patchBlob: { ref: { $link: string }; mimeType: string; size: number },
  sourceRepoDid?: string,
): Promise<{ uri: string; cid: string; rkey: string }> {
  if (!pdsClient) {
    throw new Error('Not authenticated');
  }

  const rkey = generateTid();
  const now = DateTime.utc().toISO();

  const record: ShTangledRepoPull.Main = {
    $type: 'sh.tangled.repo.pull',
    title,
    body: body || undefined,
    target: {
      repo: targetRepoDid as any,
      branch: targetBranch,
    },
    source: {
      branch: sourceBranch,
      repo: sourceRepoDid as any,
    },
    rounds: [
      {
        patchBlob: patchBlob as any,
        createdAt: now,
      },
    ],
    createdAt: now,
  };

  const result = await ok(
    pdsClient.post('com.atproto.repo.putRecord', {
      input: {
        repo: botDid as any,
        collection: 'sh.tangled.repo.pull' as any,
        rkey: rkey as any,
        record,
      },
    }),
  );

  return { uri: result.uri, cid: result.cid, rkey };
}

/**
 * Read one of the bot's own pull request records, returning the record and its
 * current CID (used as a compare-and-swap precondition on writes).
 */
async function getPullRecord(
  rkey: string,
): Promise<{ record: ShTangledRepoPull.Main; cid: string | undefined }> {
  if (!pdsClient) {
    throw new Error('Not authenticated');
  }

  const existing = await ok(
    pdsClient.get('com.atproto.repo.getRecord', {
      params: {
        repo: botDid as any,
        collection: 'sh.tangled.repo.pull' as any,
        rkey: rkey as any,
      },
    }),
  );

  return {
    record: existing.value as ShTangledRepoPull.Main,
    cid: existing.cid,
  };
}

/**
 * Write a pull request record back to the bot's PDS.
 *
 * When `swapRecord` is given, the write only succeeds if the stored record
 * still has that CID, so a concurrent writer cannot silently clobber changes.
 */
async function putPullRecord(
  rkey: string,
  record: ShTangledRepoPull.Main,
  swapRecord?: string,
): Promise<void> {
  /* v8 ignore next -- unreachable: callers read the record first, which authenticates */
  if (!pdsClient) {
    throw new Error('Not authenticated');
  }

  await ok(
    pdsClient.post('com.atproto.repo.putRecord', {
      input: {
        repo: botDid as any,
        collection: 'sh.tangled.repo.pull' as any,
        rkey: rkey as any,
        record,
        ...(swapRecord ? { swapRecord: swapRecord as any } : {}),
      },
    }),
  );
}

/**
 * Returns whether an error is an AT Protocol `InvalidSwap` response, meaning
 * the record was modified since it was read.
 */
function isInvalidSwap(err: unknown): boolean {
  return isObject(err) && (err as { error?: string }).error === 'InvalidSwap';
}

/**
 * Update a pull request record (title/body).
 */
export async function updatePullRecord(
  rkey: string,
  updates: { title?: string; body?: string },
): Promise<void> {
  // Retry once when another writer changed the record between our read and
  // write, so the update is not lost.
  for (let attempt = 0; ; attempt++) {
    const { record, cid } = await getPullRecord(rkey);

    if (updates.title !== undefined) {
      record.title = updates.title;
    }
    if (updates.body !== undefined) {
      record.body = updates.body || undefined;
    }

    try {
      await putPullRecord(rkey, record, cid);
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
 * Read the format-patch stored in a pull request round.
 *
 * Blob data lives on the bot's PDS and is fetched through the public
 * `com.atproto.sync.getBlob` endpoint.
 */
async function getStoredPatch(
  round: ShTangledRepoPull.Round | undefined,
): Promise<string | null> {
  const cid = (round?.patchBlob as { ref?: { $link?: string } } | undefined)
    ?.ref?.$link;
  const pdsUrl = session?.dispatchUrl;
  if (!cid || !pdsUrl) {
    return null;
  }

  const query = getQueryString({ did: botDid, cid });
  const url = `${ensureTrailingSlash(pdsUrl)}xrpc/com.atproto.sync.getBlob?${query}`;
  try {
    const res = await tangledHttp.getBuffer(url);
    return gunzipSync(Buffer.from(res.body)).toString('utf-8');
  } catch (err) {
    logger.debug({ err, cid }, 'Failed to read stored pull request patch');
    return null;
  }
}

/**
 * Sync a pull request's latest round with the current source branch.
 *
 * Tangled pull requests are snapshots: pushing to the source branch does not
 * update the diff reviewers see. Resubmitting appends a new round containing a
 * fresh format-patch of the current branch. This is a no-op when the latest
 * round already represents the branch, so it is safe to call on every run.
 */
export async function resubmitPull(
  knotHost: string,
  repoDid: string,
  targetBranch: string,
  sourceBranch: string,
  rkey: string,
  dryRun = false,
): Promise<ResubmitPullResult> {
  const patch = await compare(knotHost, repoDid, targetBranch, sourceBranch);

  // Upload the patch once so retries reuse the same blob.
  let blobRef:
    { ref: { $link: string }; mimeType: string; size: number } | undefined;

  // Retry once when another writer changed the record between our read and
  // write, so the new round is not lost.
  for (let attempt = 0; ; attempt++) {
    const { record, cid } = await getPullRecord(rkey);
    const rounds = coerceArray(record.rounds);

    // Skip when the latest round already represents the current branch.
    const storedPatch = await getStoredPatch(rounds.at(-1));
    if (storedPatch === patch) {
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

    blobRef ??= await uploadBlob(gzipSync(Buffer.from(patch, 'utf-8')));
    const updated: ShTangledRepoPull.Main = {
      ...record,
      rounds: [
        ...rounds,
        { patchBlob: blobRef as any, createdAt: DateTime.utc().toISO() },
      ],
    };

    try {
      await putPullRecord(rkey, updated, cid);
      return { changed: true, resubmitted: true, round: rounds.length };
    } catch (err) {
      if (attempt > 0 || !isInvalidSwap(err)) {
        throw err;
      }
      logger.debug(
        { err, rkey },
        'Pull request record changed concurrently, retrying resubmit',
      );
    }
  }
}

/**
 * Set the status of a pull request (open/closed/merged).
 */
export async function setPullStatus(
  pullUri: string,
  status:
    | 'sh.tangled.repo.pull.status.open'
    | 'sh.tangled.repo.pull.status.closed'
    | 'sh.tangled.repo.pull.status.merged',
): Promise<void> {
  if (!pdsClient) {
    throw new Error('Not authenticated');
  }

  await ok(
    pdsClient.post('com.atproto.repo.createRecord', {
      input: {
        repo: botDid as any,
        collection: 'sh.tangled.repo.pull.status' as any,
        record: {
          $type: 'sh.tangled.repo.pull.status',
          pull: pullUri,
          status,
        },
      },
    }),
  );
}

/**
 * List all pull request records created by the bot.
 */
export async function listPullRecords(): Promise<TangledPull[]> {
  if (!pdsClient) {
    throw new Error('Not authenticated');
  }

  const pulls: TangledPull[] = [];
  let cursor: string | undefined;

  do {
    const result = await ok(
      pdsClient.get('com.atproto.repo.listRecords', {
        params: {
          repo: botDid as any,
          collection: 'sh.tangled.repo.pull' as any,
          limit: 100,
          ...(cursor ? { cursor } : {}),
        },
      }),
    );

    for (const rec of result.records) {
      const rkey = rkeyFromUri(rec.uri);
      pulls.push({
        uri: rec.uri,
        cid: rec.cid,
        rkey,
        record: rec.value as ShTangledRepoPull.Main,
        status: 'open',
      });
    }

    cursor = result.cursor;
  } while (cursor);

  // Fetch status records to resolve current status
  const statusMap = new Map<string, TangledPullStatus>();
  let statusCursor: string | undefined;

  do {
    const statusResult: {
      records: { uri: string; cid: string; value: unknown }[];
      cursor?: string;
    } = await ok(
      pdsClient.get('com.atproto.repo.listRecords', {
        params: {
          repo: botDid as any,
          collection: 'sh.tangled.repo.pull.status' as any,
          limit: 100,
          ...(statusCursor ? { cursor: statusCursor } : {}),
        },
      }),
    );

    for (const rec of statusResult.records) {
      const statusRecord = rec.value as {
        pull: string;
        status?: string;
      };
      const pullUri = statusRecord.pull;
      const st = statusRecord.status;

      if (st === 'sh.tangled.repo.pull.status.closed') {
        statusMap.set(pullUri, 'closed');
      } else if (st === 'sh.tangled.repo.pull.status.merged') {
        statusMap.set(pullUri, 'merged');
      } else if (
        st === 'sh.tangled.repo.pull.status.open' &&
        !statusMap.has(pullUri)
      ) {
        statusMap.set(pullUri, 'open');
      }
    }

    statusCursor = statusResult.cursor;
  } while (statusCursor);

  for (const pull of pulls) {
    const resolvedStatus = statusMap.get(pull.uri);
    if (resolvedStatus) {
      pull.status = resolvedStatus;
    }
  }

  return pulls;
}

/**
 * List label operations for a pull request via the appview.
 *
 * Label ops live in the PDS of whoever applied them, so they cannot be read
 * from the bot's own records. The appview (Bobbin) aggregates them.
 */
export async function listLabelOps(
  appview: string,
  subject: string,
): Promise<ShTangledLabelOp.Main[]> {
  const ops: ShTangledLabelOp.Main[] = [];
  let cursor: string | undefined;

  do {
    const query = getQueryString({
      subject,
      limit: 100,
      ...(cursor ? { cursor } : {}),
    });
    const url = `${ensureTrailingSlash(appview)}xrpc/sh.tangled.label.listOps?${query}`;
    const res = await tangledHttp.getJsonUnchecked<{
      items: { value: ShTangledLabelOp.Main }[];
      cursor?: string;
    }>(url);
    ops.push(...res.body.items.map((item) => item.value));
    cursor = res.body.cursor;
  } while (cursor);

  return ops;
}

/**
 * List a label author's definitions, returning a map of definition AT-URI
 * to display name.
 */
export async function listLabelDefinitions(
  appview: string,
  authorDid: string,
): Promise<Map<string, string>> {
  const definitions = new Map<string, string>();
  let cursor: string | undefined;

  do {
    const query = getQueryString({
      subject: authorDid,
      limit: 100,
      ...(cursor ? { cursor } : {}),
    });
    const url = `${ensureTrailingSlash(appview)}xrpc/sh.tangled.label.listDefinitions?${query}`;
    const res = await tangledHttp.getJsonUnchecked<{
      items: { uri: string; value: ShTangledLabelDefinition.Main }[];
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
 * Compute the labels currently applied to a pull request by replaying its
 * label operations in chronological order and resolving each definition.
 */
export async function getLabels(
  appview: string,
  subject: string,
): Promise<TangledLabel[]> {
  const ops = await listLabelOps(appview, subject);
  if (ops.length === 0) {
    return [];
  }

  // Replay add/delete operations in the order they were performed. Parse the
  // timestamps rather than comparing the raw strings, since they carry
  // different UTC offsets.
  const applied = new Map<string, string>();
  for (const op of [...ops].sort(
    (a, b) =>
      DateTime.fromISO(a.performedAt).toMillis() -
      DateTime.fromISO(b.performedAt).toMillis(),
  )) {
    for (const operand of coerceArray(op.delete)) {
      applied.delete(operand.key);
    }
    for (const operand of coerceArray(op.add)) {
      applied.set(operand.key, operand.value);
    }
  }
  if (applied.size === 0) {
    return [];
  }

  // Definition names live in their author's records, queried per author.
  const names = new Map<string, string>();
  const authors = new Set(
    [...applied.keys()].map((uri) => uri.split('/')[2]).filter(isTruthy),
  );
  await Promise.all(
    [...authors].map(async (author) => {
      const definitions = await listLabelDefinitions(appview, author);
      for (const [uri, name] of definitions) {
        names.set(uri, name);
      }
    }),
  );

  return [...applied.entries()].map(([key, value]) => ({
    key,
    value,
    name: names.get(key) ?? rkeyFromUri(key),
  }));
}

/**
 * Write a label operation (add/delete) to the bot's own PDS.
 */
export async function createLabelOp(
  subject: string,
  add: TangledLabelOperand[],
  remove: TangledLabelOperand[],
): Promise<void> {
  if (!pdsClient) {
    throw new Error('Not authenticated');
  }

  await ok(
    pdsClient.post('com.atproto.repo.createRecord', {
      input: {
        repo: botDid as any,
        collection: 'sh.tangled.label.op' as any,
        record: {
          $type: 'sh.tangled.label.op',
          subject,
          add,
          delete: remove,
          performedAt: DateTime.utc().toISO(),
        },
      },
    }),
  );
}

/**
 * Merge a pull request via the knotserver.
 */
export async function mergePull(
  knotHost: string,
  repoDid: string,
  ownerDid: string,
  repoRkey: string,
  targetBranch: string,
  patch: string,
): Promise<void> {
  const serviceAuthToken = await getServiceAuth(
    `did:web:${knotHost}`,
    'sh.tangled.repo.merge',
  );

  const url = `https://${knotHost}/xrpc/sh.tangled.repo.merge`;
  await tangledHttp.postJson(url, {
    body: {
      repo: repoDid,
      did: ownerDid,
      name: repoRkey,
      branch: targetBranch,
      patch,
    },
    headers: {
      Authorization: `Bearer ${serviceAuthToken}`,
    },
  });
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
 *
 * `did:plc` DIDs are resolved via the PLC directory; `did:web` DIDs via
 * their well-known DID document. Falls back to the bsky AppView when the
 * document cannot be fetched.
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
 *
 * The handle is resolved to a DID, then the DID document is used to find the
 * PDS service URL, so no PDS configuration is required.
 */
export async function resolvePdsForHandle(
  handle: string,
): Promise<{ did: string; pdsUrl: string }> {
  const did = await resolveHandle(handle);
  const pdsUrl = await resolvePdsEndpoint(did);
  return { did, pdsUrl };
}

/**
 * Build a repository reference from a raw `sh.tangled.repo` record value.
 */
function toRepoRef(
  value: unknown,
  fallbackName: string,
  rkey: string,
): TangledRepoRef {
  const record = value as { knot?: string; name?: string; repoDid?: string };
  if (!record?.knot) {
    throw new Error(
      `Could not determine knot host for repository "${fallbackName}"`,
    );
  }
  return {
    knot: record.knot,
    repoDid: record.repoDid ?? '',
    name: record.name ?? fallbackName,
    rkey,
  };
}

/**
 * Returns whether an error is an AT Protocol `RecordNotFound` response.
 */
function isRecordNotFound(err: unknown): boolean {
  return (
    isObject(err) && (err as { error?: string }).error === 'RecordNotFound'
  );
}

/**
 * Resolve the `sh.tangled.repo` record for a repository.
 *
 * Repository records use an arbitrary rkey: older repositories use the
 * repository name, while newer ones use a TID with the display name stored
 * in the record's `name` field. We first attempt a direct lookup by name,
 * then fall back to listing records and matching on `name`.
 */
export async function resolveRepoRef(
  ownerDid: string,
  repoName: string,
): Promise<TangledRepoRef> {
  const pds = await resolvePdsEndpoint(ownerDid);
  const client = new Client({
    handler: simpleFetchHandler({ service: pds }),
  });

  // Fast path: legacy repositories use the name as the rkey
  let direct: { value: unknown } | null = null;
  try {
    direct = await ok(
      client.get('com.atproto.repo.getRecord', {
        params: {
          repo: ownerDid as any,
          collection: 'sh.tangled.repo' as any,
          rkey: repoName as any,
        },
      }),
    );
  } catch (err) {
    if (!isRecordNotFound(err)) {
      throw err;
    }
    logger.debug(
      { err, ownerDid, repoName },
      'Direct sh.tangled.repo lookup missed, falling back to listRecords',
    );
  }

  if (direct) {
    const directName = (direct.value as { name?: string } | null)?.name;
    // The rkey may point at a renamed record whose name no longer matches
    if (!directName || directName === repoName) {
      return toRepoRef(direct.value, repoName, repoName);
    }
  }

  // Fallback: repository records may use a TID rkey
  let cursor: string | undefined;
  do {
    const result = await ok(
      client.get('com.atproto.repo.listRecords', {
        params: {
          repo: ownerDid as any,
          collection: 'sh.tangled.repo' as any,
          limit: 100,
          ...(cursor ? { cursor } : {}),
        },
      }),
    );

    for (const rec of result.records) {
      const value = rec.value as { name?: string };
      if (value.name === repoName) {
        return toRepoRef(value, repoName, rkeyFromUri(rec.uri));
      }
    }

    cursor = result.cursor;
  } while (cursor);

  throw new Error(
    `Tangled repository "${repoName}" was not found for ${ownerDid}`,
  );
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
