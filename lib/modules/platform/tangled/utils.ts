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
 */
export function tidToNumber(tid: string): number {
  let n = 0n;
  for (const c of tid) {
    n = n * 32n + BigInt(TID_CHARSET.indexOf(c));
  }
  return parseInt((n >> 10n).toString(), 10);
}

/**
 * Extract the rkey (TID) from an AT-URI.
 * AT-URI format: at://did:plc:xxx/collection/rkey
 */
export function rkeyFromUri(uri: string): string {
  return uri.split('/').pop()!;
}

/**
 * Convert a TangledPull to Renovate's Pr type.
 */
export function toRenovatePr(pull: TangledPull): Pr | null {
  if (!pull.record.source?.branch || !pull.record.target.branch) {
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

  return {
    number: tidToNumber(pull.rkey),
    title: pull.record.title,
    state,
    sourceBranch: pull.record.source.branch,
    targetBranch: pull.record.target.branch,
    bodyStruct: getPrBodyStruct(pull.record.body ?? ''),
    createdAt: pull.record.createdAt,
    sourceRepo: pull.record.source.repo,
    sha: (
      pull.record.rounds.at(-1) as
        | { patchBlob?: { ref?: { $link?: string } } }
        | undefined
    )?.patchBlob?.ref?.$link as LongCommitSha | undefined,
  };
}
