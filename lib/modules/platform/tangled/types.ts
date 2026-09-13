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
