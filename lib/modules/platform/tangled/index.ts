import { DateTime } from 'luxon';
import { GlobalConfig } from '../../../config/global.ts';
import { logger } from '../../../logger/index.ts';
import type { BranchStatus } from '../../../types/index.ts';
import { coerceArray } from '../../../util/array.ts';
import { parseJson } from '../../../util/common.ts';
import * as git from '../../../util/git/index.ts';
import { regEx } from '../../../util/regex.ts';
import { sanitize } from '../../../util/sanitize.ts';
import { ensureTrailingSlash } from '../../../util/url.ts';
import type {
  BranchStatusConfig,
  CreatePRConfig,
  EnsureCommentConfig,
  EnsureCommentRemovalConfig,
  EnsureIssueConfig,
  EnsureIssueResult,
  FindPRConfig,
  Issue,
  MergePRConfig,
  Platform,
  PlatformParams,
  PlatformResult,
  Pr,
  RepoParams,
  RepoResult,
  UpdatePrConfig,
} from '../types.ts';
import { repoFingerprint } from '../util.ts';
import { smartTruncate } from '../utils/pr-body.ts';
import * as helper from './tangled-helper.ts';
import type { TangledLabel, TangledPull, TangledRepoConfig } from './types.ts';
import { ticketNumberToPrNumber, toRenovatePr } from './utils.ts';

export const id = 'tangled';

const defaults = {
  appview: 'https://api.tangled.org/',
  sshHost: 'tangled.org',
  sshPort: 22,
};

let config: TangledRepoConfig = {} as any;
let cachedPrList: Pr[] | null = null;
// Map from derived PR number → AT-URI for lookup
const prNumberToUri = new Map<number, string>();
// Map from derived PR number → rkey (ticket number) for record operations
const prNumberToRkey = new Map<number, string>();
// Map from derived PR number → currently applied labels
const prNumberToLabels = new Map<number, TangledLabel[]>();

export function resetPlatform(): void {
  defaults.appview = 'https://api.tangled.org/';
  defaults.sshHost = 'tangled.org';
  defaults.sshPort = 22;
  config = {} as any;
  cachedPrList = null;
  prNumberToUri.clear();
  prNumberToRkey.clear();
  prNumberToLabels.clear();
  helper.resetHelper();
}

function matchesState(actual: string, expected: string): boolean {
  if (expected === 'all') {
    return true;
  }
  if (expected.startsWith('!')) {
    return actual !== expected.substring(1);
  }
  return actual === expected;
}

async function buildPrCache(pulls: TangledPull[]): Promise<Pr[]> {
  prNumberToUri.clear();
  prNumberToRkey.clear();
  prNumberToLabels.clear();

  const prs: Pr[] = [];
  for (const pull of pulls) {
    const pr = toRenovatePr(pull);
    if (pr) {
      prNumberToUri.set(pr.number, pull.uri);
      prNumberToRkey.set(pr.number, pull.rkey);
      prs.push(pr);
    }
  }

  // Labels live on the ticket itself; resolve names via the index.
  // Only open PRs need them, for rebase/keep-updated handling.
  // Failures are non-fatal.
  await Promise.all(
    prs
      .filter((pr) => pr.state === 'open')
      .map(async (pr) => {
        const uri = prNumberToUri.get(pr.number)!;
        try {
          const labels = coerceArray(
            await helper.getLabels(defaults.appview, config.repoDid, uri),
          );
          prNumberToLabels.set(pr.number, labels);
          pr.labels = labels.map((label) => label.name);
        } catch (err) {
          logger.debug(
            { err, prNumber: pr.number },
            'Failed to fetch PR labels',
          );
        }
      }),
  );

  return prs;
}

const platform: Platform = {
  async initPlatform({
    username,
    password,
    gitAuthor,
    tangledAppviewUrl,
    tangledSshHost,
    tangledSshPort,
  }: PlatformParams): Promise<PlatformResult> {
    if (!username || !password) {
      throw new Error(
        'Init: You must configure username (AT Protocol handle) and password (app password) for Tangled',
      );
    }

    if (!gitAuthor) {
      throw new Error('Init: You must configure gitAuthor for Tangled');
    }

    // The index (Bobbin) serves indexed reads (repos, pulls, git).
    defaults.appview = ensureTrailingSlash(
      tangledAppviewUrl ?? defaults.appview,
    );
    if (!regEx(/^https?:\/\//).test(defaults.appview)) {
      throw new Error(
        `Init: Invalid tangledAppviewUrl for Tangled: ${defaults.appview}`,
      );
    }

    // Git operations go over SSH to the knotserver hosting the repository.
    defaults.sshHost = (tangledSshHost ?? defaults.sshHost).trim();
    if (!defaults.sshHost || regEx(/[:@/\s]/).test(defaults.sshHost)) {
      throw new Error(
        `Init: Invalid tangledSshHost for Tangled: ${defaults.sshHost}`,
      );
    }
    defaults.sshPort = tangledSshPort ?? defaults.sshPort;
    if (
      !Number.isSafeInteger(defaults.sshPort) ||
      defaults.sshPort < 1 ||
      defaults.sshPort > 65535
    ) {
      throw new Error(
        `Init: Invalid tangledSshPort for Tangled: ${defaults.sshPort}`,
      );
    }

    // Resolve the bot account's handle to its PDS, so no PDS config is needed
    let sessionInfo: { did: string; handle: string; pdsUrl: string };
    try {
      const { pdsUrl } = await helper.resolvePdsForHandle(username);
      sessionInfo = await helper.createSession(pdsUrl, username, password);
    } catch (err) {
      logger.debug({ err }, 'Error authenticating with AT Protocol PDS');
      throw new Error('Init: Authentication failure');
    }

    logger.info(
      { did: sessionInfo.did, handle: sessionInfo.handle },
      'Authenticated with AT Protocol PDS',
    );

    return {
      endpoint: defaults.appview,
      renovateUsername: sessionInfo.handle,
      gitAuthor,
    };
  },

  async getRawFile(
    fileName: string,
    repoName?: string,
    branchOrTag?: string,
  ): Promise<string | null> {
    if (repoName && repoName !== config.repository) {
      logger.debug(
        { repoName },
        'getRawFile for different repo not supported on Tangled',
      );
      return null;
    }

    const ref = branchOrTag ?? config.defaultBranch;
    return await helper.getBlob(
      config.repoDid,
      ref,
      fileName,
      defaults.appview,
    );
  },

  async getJsonFile(
    fileName: string,
    repoName?: string,
    branchOrTag?: string,
  ): Promise<any> {
    const raw = await platform.getRawFile(fileName, repoName, branchOrTag);
    return parseJson(raw, fileName);
  },

  async initRepo({
    repository,
    cloneSubmodules,
    cloneSubmodulesFilter,
  }: RepoParams): Promise<RepoResult> {
    config = {} as any;
    config.repository = repository;
    cachedPrList = null;
    prNumberToUri.clear();
    prNumberToRkey.clear();

    // Parse repository identifier: "handle/repo-name"
    const parts = repository.split('/');
    if (parts.length !== 2) {
      throw new Error(
        `Invalid Tangled repository format: "${repository}". Expected "handle/repo-name"`,
      );
    }
    const [ownerHandle, repoName] = parts;
    config.repoName = repoName;

    // Resolve owner handle → DID
    const ownerDid = await helper.resolveHandle(ownerHandle);
    config.ownerDid = ownerDid;

    // Resolve the repository via the index
    const repoRef = await helper.resolveRepoRef(
      ownerDid,
      repoName,
      defaults.appview,
    );
    config.knotHost = repoRef.knot;
    config.knotUrl = repoRef.knotUrl;

    // The index API only accepts a repo DID, so we cannot continue without one
    if (!repoRef.repoDid) {
      throw new Error(`Could not determine repo DID for ${repository}`);
    }
    config.repoDid = repoRef.repoDid;

    // Get the default branch (prefer the value from repo resolution)
    if (repoRef.defaultBranch) {
      config.defaultBranch = repoRef.defaultBranch;
    } else {
      const branchInfo = await helper.getDefaultBranch(
        config.repoDid,
        defaults.appview,
      );
      config.defaultBranch = branchInfo.name;
    }

    logger.debug(
      {
        repository,
        ownerDid,
        repoDid: config.repoDid,
        knotHost: config.knotHost,
        defaultBranch: config.defaultBranch,
      },
      'Tangled repo initialized',
    );

    // Initialize git with an SSH URL. The DID form keeps working after
    // renames; see https://tangled.org/docs/reference/identifiers/
    const sshUrl =
      defaults.sshPort === 22
        ? `git@${defaults.sshHost}:${config.repoDid}`
        : `ssh://git@${defaults.sshHost}:${defaults.sshPort}/${config.repoDid}`;
    await git.initRepo({
      url: sshUrl,
      defaultBranch: config.defaultBranch,
      cloneSubmodules: !!cloneSubmodules,
      cloneSubmodulesFilter,
    });

    return {
      defaultBranch: config.defaultBranch,
      isFork: false,
      repoFingerprint: repoFingerprint(config.repoDid, config.knotHost),
    };
  },

  getRepos(): Promise<string[]> {
    logger.debug(
      'Tangled does not support autodiscovery - use repositories config',
    );
    return Promise.resolve([]);
  },

  async getPrList(): Promise<Pr[]> {
    if (cachedPrList) {
      return cachedPrList;
    }

    const pulls = await helper.listPullRecords(
      config.repoDid,
      config.knotUrl,
      defaults.appview,
    );
    cachedPrList = await buildPrCache(pulls);
    logger.debug(
      `Retrieved ${cachedPrList.length} PRs for ${config.repository}`,
    );
    return cachedPrList;
  },

  async getPr(number: number): Promise<Pr | null> {
    const prList = await platform.getPrList();
    return prList.find((p) => p.number === number) ?? null;
  },

  async findPr({
    branchName,
    prTitle: title,
    state = 'all',
  }: FindPRConfig): Promise<Pr | null> {
    logger.debug(`findPr(${branchName}, ${title!}, ${state})`);
    const prList = await platform.getPrList();
    const pr = prList.find((p) => {
      const branchMatches = p.sourceBranch === branchName;
      const stateMatches = matchesState(p.state, state);
      const titleMatches = !title || p.title === title;
      return branchMatches && stateMatches && titleMatches;
    });

    if (pr) {
      logger.debug(`Found PR #${pr.number}`);
    }
    return pr ?? null;
  },

  async getBranchPr(branchName: string): Promise<Pr | null> {
    return await platform.findPr({
      branchName,
      state: 'open',
    });
  },

  async createPr({
    sourceBranch,
    targetBranch,
    prTitle,
    prBody: rawBody,
  }: CreatePRConfig): Promise<Pr> {
    const body = sanitize(rawBody);

    logger.debug(
      `Creating pull request: ${prTitle} (${sourceBranch} => ${targetBranch})`,
    );

    // Resolve both branch heads from the index, then the merge base.
    // The knot fetches the head itself on submitPatch, so the branch must
    // already be pushed.
    const [sourceHead, targetHead] = await Promise.all([
      helper.getBranchHead(config.repoDid, sourceBranch, defaults.appview),
      helper.getBranchHead(config.repoDid, targetBranch, defaults.appview),
    ]);
    const base = await helper.getMergeBase(
      config.repoDid,
      targetHead,
      sourceHead,
      defaults.appview,
    );

    // Create the ticket and its first round on the knot.
    const result = await helper.createPullRecord(
      config.repoDid,
      config.knotUrl,
      targetBranch,
      sourceBranch,
      sourceHead,
      base,
      prTitle,
      body,
    );

    const number = ticketNumberToPrNumber(result.rkey);
    if (!Number.isSafeInteger(number) || number <= 0) {
      throw new Error(
        `Could not derive a PR number from ticket rkey "${result.rkey}"`,
      );
    }
    prNumberToUri.set(number, result.uri);
    prNumberToRkey.set(number, result.rkey);

    // Invalidate cache
    cachedPrList = null;

    const pr: Pr = {
      number,
      title: prTitle,
      state: 'open',
      sourceBranch,
      targetBranch,
      bodyStruct: (await import('../pr-body.ts')).getPrBodyStruct(body),
      createdAt: DateTime.utc().toISO(),
    };

    logger.info(
      { prNumber: number, prUri: result.uri },
      'Pull request created on Tangled',
    );

    return pr;
  },

  async updatePr({
    number,
    prTitle,
    prBody: rawBody,
    state,
  }: UpdatePrConfig): Promise<void> {
    logger.debug(`updatePr(${number})`);
    const rkey = prNumberToRkey.get(number);
    const uri = prNumberToUri.get(number);
    if (!rkey || !uri) {
      logger.warn({ number }, 'Cannot update PR - rkey/uri not found in cache');
      return;
    }

    // Update title/body/state with a single read-modify-write so a
    // concurrent InvalidSwap retry cannot leave a half-updated ticket
    // (e.g. "- autoclosed" title with state still open).
    const updates: {
      title?: string;
      body?: string;
      state?: 'open' | 'closed';
    } = {};
    if (prTitle) {
      updates.title = prTitle;
    }
    if (rawBody !== undefined) {
      updates.body = sanitize(rawBody);
    }
    if (state === 'closed' || state === 'open') {
      updates.state = state;
    }

    if (
      updates.title !== undefined ||
      updates.body !== undefined ||
      updates.state !== undefined
    ) {
      await helper.updatePullRecord(
        config.repoDid,
        config.knotUrl,
        rkey,
        updates,
      );
    }

    // Invalidate cache
    cachedPrList = null;
  },

  /**
   * Sync the PR's latest round with the source branch after it was updated.
   *
   * Tangled pull requests are patch snapshots: pushing to the source branch
   * does not update what reviewers see. Submitting a new patch when the
   * branch head moved is what makes rebases visible on the PR.
   */
  async refreshPr(number: number): Promise<void> {
    logger.debug(`refreshPr(${number})`);
    const rkey = prNumberToRkey.get(number);
    const uri = prNumberToUri.get(number);
    if (!rkey || !uri) {
      logger.warn(
        { number },
        'Cannot refresh PR - rkey/uri not found in cache',
      );
      return;
    }

    const pr = await platform.getPr(number);
    if (pr?.state !== 'open') {
      return;
    }
    // Fork-based PRs are same-repo only for merges; skip resubmit.
    if (pr.sourceRepo && pr.sourceRepo !== config.repoDid) {
      logger.debug({ number }, 'Skipping refresh of fork-based PR');
      return;
    }

    try {
      const result = await helper.resubmitPull(
        config.repoDid,
        config.knotUrl,
        defaults.appview,
        pr.targetBranch!,
        pr.sourceBranch,
        rkey,
        !!GlobalConfig.get('dryRun'),
      );
      if (result.changed) {
        if (result.resubmitted) {
          logger.info(
            { prNumber: number, round: result.round },
            'Resubmitted pull request on Tangled',
          );
          cachedPrList = null;
        } else {
          logger.info(`DRY-RUN: Would resubmit PR #${number} on Tangled`);
        }
      }
    } catch (err) {
      logger.warn({ err, number }, 'Failed to resubmit PR');
    }
  },

  async mergePr({ id: number }: MergePRConfig): Promise<boolean> {
    logger.debug(`mergePr(${number})`);
    const rkey = prNumberToRkey.get(number);
    const uri = prNumberToUri.get(number);
    if (!rkey || !uri) {
      logger.warn({ number }, 'Cannot merge PR - rkey/uri not found in cache');
      return false;
    }

    try {
      // Get the PR to find the target branch
      const pr = await platform.getPr(number);
      if (!pr) {
        logger.warn({ number }, 'Cannot merge PR - PR not found');
        return false;
      }

      // Merge via the index (rebase), then mark the ticket completed
      await helper.mergePull(
        config.repoDid,
        config.knotUrl,
        config.knotHost,
        defaults.appview,
        pr.targetBranch!,
        rkey,
      );

      // Invalidate cache
      cachedPrList = null;

      return true;
    } catch (err) {
      logger.warn({ err, number }, 'Failed to merge PR');
      return false;
    }
  },

  getBranchStatus(
    _branchName: string,
    _internalChecksAsSuccess: boolean,
  ): Promise<BranchStatus> {
    return Promise.resolve('green');
  },

  getBranchStatusCheck(
    _branchName: string,
    _context: string | null | undefined,
  ): Promise<BranchStatus | null> {
    return Promise.resolve(null);
  },

  setBranchStatus(_branchStatusConfig: BranchStatusConfig): Promise<void> {
    return Promise.resolve();
  },

  addReviewers(_number: number, _reviewers: string[]): Promise<void> {
    return Promise.resolve();
  },

  addAssignees(_number: number, _assignees: string[]): Promise<void> {
    return Promise.resolve();
  },

  async deleteLabel(number: number, label: string): Promise<void> {
    logger.debug(`deleteLabel(${number}, ${label})`);
    const rkey = prNumberToRkey.get(number);
    if (!rkey) {
      logger.warn({ number }, 'Cannot delete label - PR rkey not found');
      return;
    }

    const applied = coerceArray(prNumberToLabels.get(number));
    const target = applied.filter((entry) => entry.name === label);
    if (target.length === 0) {
      logger.debug({ number, label }, 'Label is not applied to the PR');
      return;
    }

    try {
      const removed = await helper.removeLabel(
        config.repoDid,
        config.knotUrl,
        defaults.appview,
        rkey,
        label,
      );
      if (removed) {
        prNumberToLabels.set(
          number,
          applied.filter((entry) => entry.name !== label),
        );
        // Invalidate the cache so the next read reflects the removal.
        cachedPrList = null;
      }
    } catch (err) {
      logger.warn({ err, number, label }, 'Failed to delete label');
    }
  },

  findIssue(_title: string): Promise<Issue | null> {
    return Promise.resolve(null);
  },

  getIssueList(): Promise<Issue[]> {
    return Promise.resolve([]);
  },

  ensureIssue(
    _issueConfig: EnsureIssueConfig,
  ): Promise<EnsureIssueResult | null> {
    return Promise.resolve(null);
  },

  ensureIssueClosing(_title: string): Promise<void> {
    return Promise.resolve();
  },

  ensureComment(_ensureComment: EnsureCommentConfig): Promise<boolean> {
    return Promise.resolve(true);
  },

  ensureCommentRemoval(_config: EnsureCommentRemovalConfig): Promise<void> {
    return Promise.resolve();
  },

  massageMarkdown(prBody: string, rebaseLabel = 'rebase'): string {
    // Tangled PR records live in the repository account on the knot, so only
    // Renovate can edit the body or title. Replace the unusable rebase/retry
    // checkbox with the label maintainers can apply instead.
    return smartTruncate(prBody, platform.maxBodyLength())
      .replace(
        'you tick the rebase/retry checkbox',
        `you add the _${rebaseLabel}_ label`,
      )
      .replace(
        'checking the rebase/retry box above',
        `adding the _${rebaseLabel}_ label`,
      )
      .replace(regEx(`\n---\n\n.*?<!-- rebase-check -->.*?\n`), '');
  },

  maxBodyLength(): number {
    return 1_000_000;
  },
};

/* oxlint-disable typescript/unbound-method */
export const {
  addAssignees,
  addReviewers,
  createPr,
  deleteLabel,
  ensureComment,
  ensureCommentRemoval,
  ensureIssue,
  ensureIssueClosing,
  findIssue,
  findPr,
  getBranchPr,
  getBranchStatus,
  getBranchStatusCheck,
  getIssueList,
  getJsonFile,
  getPr,
  getPrList,
  getRawFile,
  getRepos,
  initPlatform,
  initRepo,
  massageMarkdown,
  maxBodyLength,
  mergePr,
  refreshPr,
  setBranchStatus,
  updatePr,
} = platform;
