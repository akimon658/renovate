import { DateTime } from 'luxon';
import { logger } from '../../../logger/index.ts';
import type { BranchStatus } from '../../../types/index.ts';
import { parseJson } from '../../../util/common.ts';
import * as git from '../../../util/git/index.ts';
import { sanitize } from '../../../util/sanitize.ts';
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
import * as helper from './tangled-helper.ts';
import type { TangledPull, TangledRepoConfig } from './types.ts';
import { tidToNumber, toRenovatePr } from './utils.ts';

export const id = 'tangled';

let config: TangledRepoConfig = {} as any;
let cachedPrList: Pr[] | null = null;
// Map from derived PR number → AT-URI for lookup
const prNumberToUri = new Map<number, string>();
// Map from derived PR number → rkey (TID) for record operations
const prNumberToRkey = new Map<number, string>();

export function resetPlatform(): void {
  config = {} as any;
  cachedPrList = null;
  prNumberToUri.clear();
  prNumberToRkey.clear();
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

function buildPrCache(pulls: TangledPull[]): Pr[] {
  prNumberToUri.clear();
  prNumberToRkey.clear();

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

  return prs;
}

const platform: Platform = {
  async initPlatform({
    endpoint,
    username,
    password,
    gitAuthor,
  }: PlatformParams): Promise<PlatformResult> {
    if (!username || !password) {
      throw new Error(
        'Init: You must configure username (AT Protocol handle) and password (app password) for Tangled',
      );
    }

    if (!gitAuthor) {
      throw new Error('Init: You must configure gitAuthor for Tangled');
    }

    // Resolve handle to determine PDS service URL
    // AT Protocol handles can be on any PDS, so we use the handle to find it
    const pdsService = endpoint ?? 'https://bsky.social';

    let sessionInfo: { did: string; handle: string; pdsUrl: string };
    try {
      sessionInfo = await helper.createSession(pdsService, username, password);
    } catch (err) {
      logger.debug({ err }, 'Error authenticating with AT Protocol PDS');
      throw new Error('Init: Authentication failure');
    }

    logger.info(
      { did: sessionInfo.did, handle: sessionInfo.handle },
      'Authenticated with AT Protocol PDS',
    );

    return {
      endpoint: pdsService,
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

    // Look up the knot host from the sh.tangled.repo record
    const knotHost = await helper.getRepoKnotHost(ownerDid, repoName);
    config.knotHost = knotHost;

    // Get the repo DID from the knotserver
    const repoInfo = await helper.describeRepo(
      knotHost,
      `${ownerDid}/${repoName}`,
    );
    config.repoDid = repoInfo.repoDid;

    // Get the default branch
    const branchInfo = await helper.getDefaultBranch(
      knotHost,
      `${config.repoDid}/${repoName}`,
    );
    config.defaultBranch = branchInfo.name;

    logger.debug(
      {
        repository,
        ownerDid,
        repoDid: config.repoDid,
        knotHost,
        defaultBranch: config.defaultBranch,
      },
      'Tangled repo initialized',
    );

    // Initialize git with SSH URL
    const sshUrl = `git@${knotHost}:${ownerDid}/${repoName}`;
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
    cachedPrList = buildPrCache(pulls);
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
    const patchBuffer = await helper.compare(
      config.knotHost,
      `${config.repoDid}/${config.repoName}`,
      targetBranch,
      sourceBranch,
    );

    // Step 2: Compress the patch and upload as a blob
    const { gzipSync } = await import('node:zlib');
    const gzipped = gzipSync(patchBuffer);
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
      const patchBuffer = await helper.compare(
        config.knotHost,
        `${config.repoDid}/${config.repoName}`,
        pr.targetBranch!,
        pr.sourceBranch,
      );

      // Merge via the knotserver
      await helper.mergePull(
        config.knotHost,
        config.ownerDid,
        config.repoName,
        pr.targetBranch!,
        patchBuffer.toString('utf-8'),
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

  deleteLabel(_number: number, _label: string): Promise<void> {
    return Promise.resolve();
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

  massageMarkdown(prBody: string): string {
    return prBody;
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
