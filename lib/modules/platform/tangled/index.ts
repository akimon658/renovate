import { DateTime } from 'luxon';
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
import { tidToNumber, toRenovatePr } from './utils.ts';

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
// Map from derived PR number → rkey (TID) for record operations
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
    // Only include PRs targeting the current repository
    if (pull.record.target.repo !== config.repoDid) {
      continue;
    }

    const pr = toRenovatePr(pull);
    if (pr) {
      prNumberToUri.set(pr.number, pull.uri);
      prNumberToRkey.set(pr.number, pull.rkey);
      prs.push(pr);
    }
  }

  // Labels are stored as operations in each actor's PDS and aggregated by the
  // appview, so they need a separate lookup. Only open PRs need them, for
  // rebase/keep-updated handling. Failures are non-fatal.
  await Promise.all(
    prs
      .filter((pr) => pr.state === 'open')
      .map(async (pr) => {
        const uri = prNumberToUri.get(pr.number)!;
        try {
          const labels = coerceArray(
            await helper.getLabels(defaults.appview, uri),
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

    // The Bobbin API appview serves indexed reads (e.g. labels).
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
    return await helper.getBlob(config.knotHost, config.repoDid, ref, fileName);
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

    // Resolve the sh.tangled.repo record from the owner's PDS
    const repoRef = await helper.resolveRepoRef(ownerDid, repoName);
    config.knotHost = repoRef.knot;

    // The knot API only accepts a repo DID, so we cannot continue without one
    if (!repoRef.repoDid) {
      throw new Error(`Could not determine repo DID for ${repository}`);
    }

    // Get the canonical repo DID and rkey from the knotserver
    const repoInfo = await helper.describeRepo(repoRef.knot, repoRef.repoDid);
    config.repoDid = repoInfo.repoDid || repoRef.repoDid;
    config.knotRkey = repoInfo.rkey || repoRef.rkey || repoName;

    // Get the default branch
    const branchInfo = await helper.getDefaultBranch(
      repoRef.knot,
      config.repoDid,
    );
    config.defaultBranch = branchInfo.name;

    logger.debug(
      {
        repository,
        ownerDid,
        repoDid: config.repoDid,
        knotHost: repoRef.knot,
        defaultBranch: config.defaultBranch,
      },
      'Tangled repo initialized',
    );

    // Initialize git with an SSH URL to the configured knotserver host.
    const sshUrl =
      defaults.sshPort === 22
        ? `git@${defaults.sshHost}:${ownerDid}/${config.knotRkey}`
        : `ssh://git@${defaults.sshHost}:${defaults.sshPort}/${ownerDid}/${config.knotRkey}`;
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

    const pulls = await helper.listPullRecords();
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
    const pr = prList.find(
      (p) =>
        p.sourceBranch === branchName &&
        matchesState(p.state, state) &&
        (!title || p.title === title),
    );

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

    // Step 1: Get the format-patch from the knotserver
    const patch = await helper.compare(
      config.knotHost,
      config.repoDid,
      targetBranch,
      sourceBranch,
    );

    // Step 2: Compress the patch and upload as a blob
    const { gzipSync } = await import('node:zlib');
    const gzipped = gzipSync(Buffer.from(patch, 'utf-8'));
    const blobRef = await helper.uploadBlob(gzipped);

    // Step 3: Create the pull record in the PDS
    const result = await helper.createPullRecord(
      config.repoDid,
      targetBranch,
      sourceBranch,
      prTitle,
      body,
      blobRef,
    );

    const number = tidToNumber(result.rkey);
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

    // Update title/body if needed
    const updates: { title?: string; body?: string } = {};
    if (prTitle) {
      updates.title = prTitle;
    }
    if (rawBody !== undefined) {
      updates.body = sanitize(rawBody);
    }

    if (updates.title || updates.body !== undefined) {
      await helper.updatePullRecord(rkey, updates);
    }

    // Update status if closing
    if (state === 'closed') {
      await helper.setPullStatus(uri, 'sh.tangled.repo.pull.status.closed');
    }

    // Invalidate cache
    cachedPrList = null;
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
      // Get the PR to find the source branch
      const pr = await platform.getPr(number);
      if (!pr) {
        logger.warn({ number }, 'Cannot merge PR - PR not found');
        return false;
      }

      // Get the patch from the knotserver
      const patch = await helper.compare(
        config.knotHost,
        config.repoDid,
        pr.targetBranch!,
        pr.sourceBranch,
      );

      // Merge via the knotserver
      await helper.mergePull(
        config.knotHost,
        config.repoDid,
        config.ownerDid,
        config.knotRkey,
        pr.targetBranch!,
        patch,
      );

      // Set PR status to merged
      await helper.setPullStatus(uri, 'sh.tangled.repo.pull.status.closed');

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
    const uri = prNumberToUri.get(number);
    if (!uri) {
      logger.warn({ number }, 'Cannot delete label - PR URI not found');
      return;
    }

    const applied = coerceArray(prNumberToLabels.get(number));
    const target = applied.filter((entry) => entry.name === label);
    if (target.length === 0) {
      logger.debug({ number, label }, 'Label is not applied to the PR');
      return;
    }

    try {
      await helper.createLabelOp(
        uri,
        [],
        target.map((entry) => ({ key: entry.key, value: entry.value })),
      );
      prNumberToLabels.set(
        number,
        applied.filter((entry) => entry.name !== label),
      );
      // Invalidate the cache so the next read reflects the removal.
      cachedPrList = null;
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
    // Tangled PR records live in the author's PDS, so only Renovate can edit
    // the body or title. Replace the unusable rebase/retry checkbox with the
    // label maintainers can apply instead.
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
  setBranchStatus,
  updatePr,
} = platform;
