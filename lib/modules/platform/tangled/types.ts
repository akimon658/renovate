import type {
  OrgTangledReviewPatch,
  OrgTangledTrackTicket,
} from '@atcute/tangled';

/**
 * Internal configuration state for a Tangled repository.
 * Reset on each `initRepo()` call.
 */
export interface TangledRepoConfig {
  repository: string;
  ownerDid: string;
  repoDid: string;
  repoName: string;
  knotHost: string;
  knotUrl: string;
  defaultBranch: string;
}

/**
 * Resolved reference to a Tangled repository.
 */
export interface TangledRepoRef {
  knot: string;
  knotUrl: string;
  repoDid: string;
  name: string;
  defaultBranch?: string;
}

/**
 * A single `org.tangled.review.patch` round.
 */
export type TangledPatch = OrgTangledReviewPatch.Main;

/**
 * A single `org.tangled.track.ticket` record acting as a pull request
 * (i.e. with `targetBranch` set).
 */
export type TangledTicket = OrgTangledTrackTicket.Main;

/**
 * Represents a Tangled pull request with resolved status,
 * combining the ticket record with its patch rounds.
 */
export interface TangledPull {
  uri: string;
  cid: string;
  /** Ticket record key: the pull number shown on tangled.org (e.g. "92"). */
  rkey: string;
  record: TangledTicket;
  rounds: TangledPatch[];
  status: TangledPullStatus;
}

export type TangledPullStatus = 'open' | 'closed' | 'merged';

/**
 * A label currently applied to a pull request.
 *
 * `key` is the AT-URI of the `org.tangled.label.definition` record,
 * `value` is unused in the new record format (kept for compatibility),
 * and `name` is the definition's display name used for matching against
 * Renovate config (e.g. `rebaseLabel`).
 */
export interface TangledLabel {
  key: string;
  value: string;
  name: string;
}

/**
 * A label operation operand, identifying a label definition and its value.
 */
export interface TangledLabelOperand {
  key: string;
  value: string;
}

/**
 * Result of syncing a pull request's latest round with its source branch.
 */
export interface ResubmitPullResult {
  /** Whether the branch diff differs from the PR's latest round. */
  changed: boolean;
  /** Whether a new round was written (always false in dry-run mode). */
  resubmitted: boolean;
  /** Index of the latest round (0-based), or null when there are no rounds. */
  round: number | null;
}
