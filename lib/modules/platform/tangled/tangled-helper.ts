import type {} from '@atcute/atproto';
import { Client, ok, simpleFetchHandler } from '@atcute/client';
import { PasswordSession } from '@atcute/password-session';
import type { ShTangledRepoPull } from '@atcute/tangled';
import { DateTime } from 'luxon';
import { TangledHttp } from '../../../util/http/tangled.ts';
import { getQueryString } from '../../../util/url.ts';
import type { TangledPull, TangledPullStatus } from './types.ts';
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
 */
export async function compare(
  knotHost: string,
  repo: string,
  rev1: string,
  rev2: string,
): Promise<Buffer> {
  const query = getQueryString({ repo, rev1, rev2 });
  const url = `https://${knotHost}/xrpc/sh.tangled.repo.compare?${query}`;
  const res = await tangledHttp.getBuffer(url);
  return Buffer.from(res.body);
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
 * Update a pull request record (title/body).
 */
export async function updatePullRecord(
  rkey: string,
  updates: { title?: string; body?: string },
): Promise<void> {
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

  const record = existing.value as ShTangledRepoPull.Main;
  if (updates.title !== undefined) {
    record.title = updates.title;
  }
  if (updates.body !== undefined) {
    record.body = updates.body || undefined;
  }

  await ok(
    pdsClient.post('com.atproto.repo.putRecord', {
      input: {
        repo: botDid as any,
        collection: 'sh.tangled.repo.pull' as any,
        rkey: rkey as any,
        record,
      },
    }),
  );
}

/**
 * Set the status of a pull request (open/closed/merged).
 */
export async function setPullStatus(
  pullUri: string,
  status:
    | 'sh.tangled.repo.pull.status.open'
    | 'sh.tangled.repo.pull.status.closed',
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
 * Merge a pull request via the knotserver.
 */
export async function mergePull(
  knotHost: string,
  ownerDid: string,
  repoName: string,
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
      did: ownerDid,
      name: repoName,
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
 * Look up the knot host for a repository by resolving the sh.tangled.repo
 * record from the owner's PDS.
 */
export async function getRepoKnotHost(
  ownerDid: string,
  repoRkey: string,
): Promise<string> {
  const client = new Client({
    handler: simpleFetchHandler({
      service: 'https://public.api.bsky.app',
    }),
  });

  const result = await ok(
    client.get('com.atproto.repo.getRecord', {
      params: {
        repo: ownerDid as any,
        collection: 'sh.tangled.repo' as any,
        rkey: repoRkey as any,
      },
    }),
  );

  const record = result.value as { knot?: string };
  if (!record.knot) {
    throw new Error(
      `Could not determine knot host for ${ownerDid}/${repoRkey}`,
    );
  }
  return record.knot;
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
