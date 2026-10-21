import type { ShTangledRepoPull } from '@atcute/tangled';

/**
 * Internal configuration state for a Tangled repository.
 * Reset on each `initRepo()` call.
 */
export interface TangledRepoConfig {
  repository: string;
  ownerDid: string;
  repoDid: string;
  repoName: string;
  knotRkey: string;
  knotHost: string;
  defaultBranch: string;
}

/**
 * Resolved reference to a Tangled repository's `sh.tangled.repo` record.
 */
export interface TangledRepoRef {
  knot: string;
  repoDid: string;
  name: string;
  rkey: string;
}

/**
 * Represents a Tangled pull request with resolved status,
 * combining the PR record with its latest status record.
 */
export interface TangledPull {
  uri: string;
  cid: string;
  rkey: string;
  record: ShTangledRepoPull.Main;
  status: TangledPullStatus;
}

export type TangledPullStatus = 'open' | 'closed' | 'merged';

/**
 * A label currently applied to a pull request.
 *
 * `key` is the AT-URI of the `sh.tangled.label.definition` record, `value` is
 * the stringified value of that label, and `name` is the definition's display
 * name used for matching against Renovate config (e.g. `rebaseLabel`).
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
