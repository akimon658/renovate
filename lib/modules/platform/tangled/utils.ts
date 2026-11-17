import { isString } from '@sindresorhus/is';
import { regEx } from '../../../util/regex.ts';
import type { LongCommitSha } from '../../../util/schema-utils/git.ts';
import { getPrBodyStruct } from '../pr-body.ts';
import type { Pr } from '../types.ts';
import type { TangledPull } from './types.ts';

/**
 * Base-32 sortable charset used by AT Protocol TIDs.
 */
const TID_CHARSET = '234567abcdefghijklmnopqrstuvwxyz';

/**
 * Convert a TID string to a numeric identifier.
 *
 * TIDs are base-32 sortable encoded 64-bit values where the upper 53 bits
 * are a microsecond timestamp and the lower 10 bits are a clock ID.
 * We right-shift by 10 to extract the timestamp, which fits safely
 * within JavaScript's Number.MAX_SAFE_INTEGER.
 *
 * Kept as a fallback for pre-2026-10-28 pull records whose rkey is a TID.
 */
export function tidToNumber(tid: string): number {
  let n = 0n;
  for (const c of tid) {
    const digit = TID_CHARSET.indexOf(c);
    if (digit < 0) {
      throw new Error(`Invalid TID character: ${c}`);
    }
    n = n * 32n + BigInt(digit);
  }
  return parseInt((n >> 10n).toString(), 10);
}

/**
 * Convert a ticket rkey to a Renovate PR number.
 *
 * Since the 2026-10-28 record format, ticket rkeys are sequential numbers
 * ("1", "2", ...) per repository. Older `sh.tangled.repo.pull` rkeys are
 * TIDs, handled via `tidToNumber` for best-effort compatibility.
 */
export function ticketNumberToPrNumber(rkey: string): number {
  const parsed = parseInt(rkey, 10);
  if (Number.isSafeInteger(parsed) && String(parsed) === rkey) {
    return parsed;
  }
  // Fallback for legacy TID rkeys
  if (regEx(/^[234567abcdefghijklmnopqrstuvwxyz]{13}$/).test(rkey)) {
    return tidToNumber(rkey);
  }
  // Unparseable rkeys must not collide with real ticket numbers
  return 0;
}

/**
 * Extract the rkey from an AT-URI.
 * AT-URI format: at://did:plc:xxx/collection/rkey
 */
export function rkeyFromUri(uri: string): string {
  return uri.split('/').pop()!;
}

/**
 * Extract plain text from a new-format markdown field.
 *
 * `org.tangled.track.ticket` stores `title` as
 * `org.tangled.markup.markdown#inline` and `body` as
 * `org.tangled.markup.markdown`, while the legacy format used plain
 * strings. Accept both.
 */
export function ticketText(
  field: string | { text?: string } | null | undefined,
): string {
  if (!field) {
    return '';
  }
  if (isString(field)) {
    return field;
  }
  return field.text ?? '';
}

/**
 * Convert a TangledPull to Renovate's Pr type.
 */
export function toRenovatePr(pull: TangledPull): Pr | null {
  const record = pull.record as unknown as {
    source?: { branch?: string; repo?: string };
    target?: { branch?: string; repo?: string };
    targetBranch?: string;
    title?: string | { text?: string };
    body?: string | { text?: string };
    createdAt?: string;
  };

  // New format: target branch lives on the ticket itself, source branch on
  // the latest patch round. Legacy format embedded both in the record.
  const targetBranch = record.target?.branch ?? record.targetBranch;
  let sourceBranch = record.source?.branch;
  let sourceRepo = record.source?.repo;

  const latestRound = pull.rounds?.at(-1) as
    | {
        source?: { branch?: string; repo?: string };
        head?: { oid?: string };
      }
    | undefined;
  sourceBranch ??= latestRound?.source?.branch;
  sourceRepo ??= latestRound?.source?.repo;

  if (!sourceBranch || !targetBranch) {
    return null;
  }

  let state: string;
  if (pull.status === 'open') {
    state = 'open';
  } else if (pull.status === 'merged') {
    state = 'merged';
  } else {
    state = 'closed';
  }

  const title = ticketText(record.title);
  const body = ticketText(record.body);

  const number = ticketNumberToPrNumber(pull.rkey);
  if (!Number.isSafeInteger(number) || number <= 0) {
    return null;
  }

  return {
    number,
    title,
    state,
    sourceBranch,
    targetBranch,
    bodyStruct: getPrBodyStruct(body),
    createdAt: record.createdAt,
    sourceRepo,
    sha: latestRound?.head?.oid as LongCommitSha | undefined,
  };
}
