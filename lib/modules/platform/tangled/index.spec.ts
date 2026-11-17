import { git } from '~test/util.ts';
import { GlobalConfig } from '../../../config/global.ts';
import { repoFingerprint } from '../util.ts';
import * as tangled from './index.ts';
import * as helper from './tangled-helper.ts';
import type { TangledPull, TangledRepoRef } from './types.ts';

vi.mock('../../../util/git/index.ts');
vi.mock('./tangled-helper.ts');

const helperMock = vi.mocked(helper);

const mockRkey = '92';
const mockPrNumber = 92;

function mockTicketRecord(overrides?: Record<string, unknown>): any {
  return {
    $type: 'org.tangled.track.ticket',
    title: {
      $type: 'org.tangled.markup.markdown#inline',
      text: 'Update dependency foo to v2',
    },
    body: {
      $type: 'org.tangled.markup.markdown',
      text: 'PR body text',
    },
    state: 'open',
    targetBranch: 'main',
    createdAt: '2025-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function mockRound(overrides?: Record<string, unknown>): any {
  return {
    $type: 'org.tangled.review.patch',
    ticket: mockRkey,
    base: { oid: 'a'.repeat(40) },
    head: { oid: 'b'.repeat(40) },
    source: {
      repo: 'did:plc:repo123',
      branch: 'renovate/foo-2.x',
    },
    createdAt: '2025-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function mockPull(overrides?: Partial<TangledPull>): TangledPull {
  return {
    uri: `at://did:plc:repo123/org.tangled.track.ticket/${mockRkey}`,
    cid: 'bafyreicid',
    rkey: mockRkey,
    record: mockTicketRecord(),
    rounds: [mockRound()],
    status: 'open',
    ...overrides,
  };
}

describe('modules/platform/tangled/index', () => {
  beforeEach(async () => {
    tangled.resetPlatform();
    GlobalConfig.reset();

    helperMock.getLabels.mockResolvedValue([]);

    helperMock.resubmitPull.mockResolvedValue({
      changed: false,
      resubmitted: false,
      round: 0,
    });

    helperMock.resolvePdsForHandle.mockResolvedValue({
      did: 'did:plc:bot123',
      pdsUrl: 'https://pds.example.com',
    });

    helperMock.createSession.mockResolvedValue({
      did: 'did:plc:bot123',
      handle: 'renovate-bot.bsky.social',
      pdsUrl: 'https://pds.example.com',
    });

    await tangled.initPlatform({
      username: 'renovate-bot.bsky.social',
      password: 'app-password',
      gitAuthor: 'Renovate Bot <renovate@example.com>',
    });
  });

  async function initFakeRepo(
    repoRef?: Partial<TangledRepoRef>,
    defaultBranch?: string,
  ): Promise<void> {
    helperMock.resolveHandle.mockResolvedValueOnce('did:plc:owner');
    helperMock.resolveRepoRef.mockResolvedValueOnce({
      knot: 'knot.example.com',
      knotUrl: 'https://knot.example.com',
      repoDid: 'did:plc:repo123',
      name: 'my-repo',
      defaultBranch: defaultBranch ?? 'main',
      ...repoRef,
    });
    helperMock.getDefaultBranch.mockResolvedValueOnce({
      name: defaultBranch ?? 'main',
      hash: 'abc123',
    });

    await tangled.initRepo({
      repository: 'owner.bsky.social/my-repo',
    });
  }

  describe('initPlatform()', () => {
    it('should throw if no username', async () => {
      await expect(tangled.initPlatform({ password: 'pass' })).rejects.toThrow(
        'username',
      );
    });

    it('should throw if no password', async () => {
      await expect(tangled.initPlatform({ username: 'user' })).rejects.toThrow(
        'password',
      );
    });

    it('should throw if no gitAuthor', async () => {
      await expect(
        tangled.initPlatform({
          username: 'user',
          password: 'pass',
        }),
      ).rejects.toThrow('gitAuthor');
    });

    it('should throw on invalid tangledAppviewUrl', async () => {
      await expect(
        tangled.initPlatform({
          username: 'user',
          password: 'pass',
          gitAuthor: 'User <user@example.com>',
          tangledAppviewUrl: 'api.tangled.org',
        }),
      ).rejects.toThrow('Invalid tangledAppviewUrl');
    });

    it('should throw on invalid tangledSshHost', async () => {
      await expect(
        tangled.initPlatform({
          username: 'user',
          password: 'pass',
          gitAuthor: 'User <user@example.com>',
          tangledSshHost: 'git@knot.example.com',
        }),
      ).rejects.toThrow('Invalid tangledSshHost');
    });

    it('should throw on invalid tangledSshPort', async () => {
      await expect(
        tangled.initPlatform({
          username: 'user',
          password: 'pass',
          gitAuthor: 'User <user@example.com>',
          tangledSshPort: 0,
        }),
      ).rejects.toThrow('Invalid tangledSshPort');
    });

    it('should apply custom tangled settings', async () => {
      const result = await tangled.initPlatform({
        username: 'user',
        password: 'pass',
        gitAuthor: 'User <user@example.com>',
        tangledAppviewUrl: 'https://bobbin.example.com',
        tangledSshHost: 'knot.example.com',
        tangledSshPort: 2222,
      });

      expect(result.endpoint).toBe('https://bobbin.example.com/');
    });

    it('should authenticate and return platform info', async () => {
      const result = await tangled.initPlatform({
        username: 'renovate-bot.bsky.social',
        password: 'app-password',
        gitAuthor: 'Renovate Bot <renovate@example.com>',
      });

      expect(result).toEqual({
        endpoint: 'https://api.tangled.org/',
        renovateUsername: 'renovate-bot.bsky.social',
        gitAuthor: 'Renovate Bot <renovate@example.com>',
      });
    });

    it('should resolve the PDS from the handle', async () => {
      const result = await tangled.initPlatform({
        username: 'user',
        password: 'pass',
        gitAuthor: 'User <user@example.com>',
      });

      expect(helperMock.resolvePdsForHandle).toHaveBeenCalledWith('user');
      expect(result.endpoint).toBe('https://api.tangled.org/');
      expect(helperMock.createSession).toHaveBeenCalledWith(
        'https://pds.example.com',
        'user',
        'pass',
      );
    });

    it('should ignore the generic endpoint option', async () => {
      const result = await tangled.initPlatform({
        endpoint: 'https://custom-tangled.example.com',
        username: 'user',
        password: 'pass',
        gitAuthor: 'User <user@example.com>',
      });

      expect(result.endpoint).toBe('https://api.tangled.org/');
    });

    it('should throw on auth failure', async () => {
      helperMock.createSession.mockRejectedValueOnce(new Error('Auth failed'));
      await expect(
        tangled.initPlatform({
          username: 'user',
          password: 'bad',
          gitAuthor: 'User <user@example.com>',
        }),
      ).rejects.toThrow('Authentication failure');
    });

    it('should throw when the PDS cannot be resolved', async () => {
      helperMock.resolvePdsForHandle.mockRejectedValueOnce(new Error('nope'));
      await expect(
        tangled.initPlatform({
          username: 'user',
          password: 'pass',
          gitAuthor: 'User <user@example.com>',
        }),
      ).rejects.toThrow('Authentication failure');
    });
  });

  describe('initRepo()', () => {
    it('should initialize a repo', async () => {
      await initFakeRepo();

      expect(helperMock.resolveHandle).toHaveBeenCalledWith(
        'owner.bsky.social',
      );
      expect(helperMock.resolveRepoRef).toHaveBeenCalledWith(
        'did:plc:owner',
        'my-repo',
        'https://api.tangled.org/',
      );
      expect(git.initRepo).toHaveBeenCalledWith(
        expect.objectContaining({
          url: 'git@tangled.org:did:plc:repo123',
          defaultBranch: 'main',
        }),
      );
    });

    it('should return repo result', async () => {
      helperMock.resolveHandle.mockResolvedValueOnce('did:plc:owner');
      helperMock.resolveRepoRef.mockResolvedValueOnce({
        knot: 'knot.example.com',
        knotUrl: 'https://knot.example.com',
        repoDid: 'did:plc:repo123',
        name: 'my-repo',
        defaultBranch: 'main',
      });
      helperMock.getDefaultBranch.mockResolvedValueOnce({
        name: 'main',
        hash: 'abc123',
      });

      const result = await tangled.initRepo({
        repository: 'owner.bsky.social/my-repo',
      });

      expect(result).toEqual({
        defaultBranch: 'main',
        isFork: false,
        repoFingerprint: repoFingerprint('did:plc:repo123', 'knot.example.com'),
      });
    });

    it('should throw on invalid repository format', async () => {
      await expect(
        tangled.initRepo({ repository: 'invalid-format' }),
      ).rejects.toThrow('Invalid Tangled repository format');
    });

    it('should use the default branch from repo resolution', async () => {
      await initFakeRepo({}, 'develop');

      expect(git.initRepo).toHaveBeenCalledWith(
        expect.objectContaining({
          defaultBranch: 'develop',
        }),
      );
    });

    it('should fall back to getDefaultBranch when missing', async () => {
      helperMock.resolveHandle.mockResolvedValueOnce('did:plc:owner');
      helperMock.resolveRepoRef.mockResolvedValueOnce({
        knot: 'knot.example.com',
        knotUrl: 'https://knot.example.com',
        repoDid: 'did:plc:repo123',
        name: 'my-repo',
      });
      helperMock.getDefaultBranch.mockResolvedValueOnce({
        name: 'main',
        hash: 'abc123',
      });

      const result = await tangled.initRepo({
        repository: 'owner.bsky.social/my-repo',
      });

      expect(result.defaultBranch).toBe('main');
      expect(helperMock.getDefaultBranch).toHaveBeenCalledWith(
        'did:plc:repo123',
        'https://api.tangled.org/',
      );
    });

    it('should use the configured SSH host for git operations', async () => {
      await tangled.initPlatform({
        username: 'user',
        password: 'pass',
        gitAuthor: 'User <user@example.com>',
        tangledSshHost: 'knot.example.com',
      });

      await initFakeRepo();

      expect(git.initRepo).toHaveBeenCalledWith(
        expect.objectContaining({
          url: 'git@knot.example.com:did:plc:repo123',
        }),
      );
    });

    it('should use an ssh:// URL for a non-default SSH port', async () => {
      await tangled.initPlatform({
        username: 'user',
        password: 'pass',
        gitAuthor: 'User <user@example.com>',
        tangledSshHost: 'knot.example.com',
        tangledSshPort: 2222,
      });

      await initFakeRepo();

      expect(git.initRepo).toHaveBeenCalledWith(
        expect.objectContaining({
          url: 'ssh://git@knot.example.com:2222/did:plc:repo123',
        }),
      );
    });

    it('should throw when the repo DID cannot be determined', async () => {
      helperMock.resolveHandle.mockResolvedValueOnce('did:plc:owner');
      helperMock.resolveRepoRef.mockResolvedValueOnce({
        knot: 'knot.example.com',
        knotUrl: 'https://knot.example.com',
        repoDid: '',
        name: 'my-repo',
      });

      await expect(
        tangled.initRepo({ repository: 'owner.bsky.social/my-repo' }),
      ).rejects.toThrow('Could not determine repo DID');
    });
  });

  describe('getRepos()', () => {
    it('should return empty array', async () => {
      const repos = await tangled.getRepos();
      expect(repos).toEqual([]);
    });
  });

  describe('getRawFile()', () => {
    it('should fetch file content from the index', async () => {
      await initFakeRepo();
      helperMock.getBlob.mockResolvedValueOnce('file content');

      const result = await tangled.getRawFile('package.json');
      expect(result).toBe('file content');
      expect(helperMock.getBlob).toHaveBeenCalledWith(
        'did:plc:repo123',
        'main',
        'package.json',
        'https://api.tangled.org/',
      );
    });

    it('should return null for different repo', async () => {
      await initFakeRepo();
      const result = await tangled.getRawFile('package.json', 'other/repo');
      expect(result).toBeNull();
    });

    it('should use the provided branch or tag', async () => {
      await initFakeRepo();
      helperMock.getBlob.mockResolvedValueOnce('file content');

      const result = await tangled.getRawFile(
        'package.json',
        undefined,
        'v1.0.0',
      );
      expect(result).toBe('file content');
      expect(helperMock.getBlob).toHaveBeenCalledWith(
        'did:plc:repo123',
        'v1.0.0',
        'package.json',
        'https://api.tangled.org/',
      );
    });
  });

  describe('getJsonFile()', () => {
    it('should parse raw file content as JSON', async () => {
      await initFakeRepo();
      helperMock.getBlob.mockResolvedValueOnce('{"foo":"bar"}');

      const result = await tangled.getJsonFile('renovate.json');
      expect(result).toEqual({ foo: 'bar' });
    });
  });

  describe('getPrList()', () => {
    it('should return cached PR list', async () => {
      await initFakeRepo();
      const pull = mockPull();
      helperMock.listPullRecords.mockResolvedValueOnce([pull]);

      const list1 = await tangled.getPrList();
      const list2 = await tangled.getPrList();

      expect(list1).toHaveLength(1);
      expect(list2).toHaveLength(1);
      // Should only call once due to caching
      expect(helperMock.listPullRecords).toHaveBeenCalledTimes(1);
    });

    it('should skip pulls that cannot be converted', async () => {
      await initFakeRepo();
      const invalidPull = mockPull({
        rkey: '93',
        uri: 'at://did:plc:repo123/org.tangled.track.ticket/93',
        record: mockTicketRecord({ targetBranch: undefined }),
        rounds: [],
      });
      helperMock.listPullRecords.mockResolvedValueOnce([
        mockPull(),
        invalidPull,
      ]);

      const list = await tangled.getPrList();
      expect(list).toHaveLength(1);
      expect(list[0].number).toBe(mockPrNumber);
    });

    it('enriches open PRs with labels from the index', async () => {
      await initFakeRepo();
      helperMock.listPullRecords.mockResolvedValueOnce([mockPull()]);
      helperMock.getLabels.mockResolvedValueOnce([
        {
          key: 'at://did:plc:repo123/org.tangled.label.definition/rebase',
          value: '',
          name: 'rebase',
        },
      ]);

      const list = await tangled.getPrList();
      expect(list[0].labels).toEqual(['rebase']);
      expect(helperMock.getLabels).toHaveBeenCalledWith(
        'https://api.tangled.org/',
        'did:plc:repo123',
        expect.stringContaining('org.tangled.track.ticket'),
      );
    });

    it('ignores label lookup failures', async () => {
      await initFakeRepo();
      helperMock.listPullRecords.mockResolvedValueOnce([mockPull()]);
      helperMock.getLabels.mockRejectedValueOnce(new Error('appview down'));

      const list = await tangled.getPrList();
      expect(list[0].labels).toBeUndefined();
    });
  });

  describe('getPr()', () => {
    it('should return a PR by number', async () => {
      await initFakeRepo();
      helperMock.listPullRecords.mockResolvedValueOnce([mockPull()]);

      const pr = await tangled.getPr(mockPrNumber);
      expect(pr).not.toBeNull();
      expect(pr!.number).toBe(mockPrNumber);
      expect(pr!.title).toBe('Update dependency foo to v2');
    });

    it('should return null for unknown number', async () => {
      await initFakeRepo();
      helperMock.listPullRecords.mockResolvedValueOnce([]);

      const pr = await tangled.getPr(999);
      expect(pr).toBeNull();
    });
  });

  describe('findPr()', () => {
    it('should find a PR by branch name', async () => {
      await initFakeRepo();
      helperMock.listPullRecords.mockResolvedValueOnce([mockPull()]);

      const pr = await tangled.findPr({
        branchName: 'renovate/foo-2.x',
        state: 'open',
      });
      expect(pr).not.toBeNull();
      expect(pr!.sourceBranch).toBe('renovate/foo-2.x');
    });

    it('should filter by state', async () => {
      await initFakeRepo();
      helperMock.listPullRecords.mockResolvedValueOnce([
        mockPull({ status: 'closed' }),
      ]);

      const pr = await tangled.findPr({
        branchName: 'renovate/foo-2.x',
        state: 'open',
      });
      expect(pr).toBeNull();
    });

    it('should match with state "all"', async () => {
      await initFakeRepo();
      helperMock.listPullRecords.mockResolvedValueOnce([
        mockPull({ status: 'closed' }),
      ]);

      const pr = await tangled.findPr({
        branchName: 'renovate/foo-2.x',
        state: 'all',
      });
      expect(pr).not.toBeNull();
    });

    it('should support negated state', async () => {
      await initFakeRepo();
      helperMock.listPullRecords.mockResolvedValueOnce([
        mockPull({ status: 'open' }),
      ]);

      const pr = await tangled.findPr({
        branchName: 'renovate/foo-2.x',
        state: '!open',
      });
      expect(pr).toBeNull();
    });

    it('should filter by title', async () => {
      await initFakeRepo();
      helperMock.listPullRecords.mockResolvedValueOnce([mockPull()]);

      const pr = await tangled.findPr({
        branchName: 'renovate/foo-2.x',
        prTitle: 'Wrong title',
        state: 'all',
      });
      expect(pr).toBeNull();
    });

    it('should match by title', async () => {
      await initFakeRepo();
      helperMock.listPullRecords.mockResolvedValueOnce([mockPull()]);

      const pr = await tangled.findPr({
        branchName: 'renovate/foo-2.x',
        prTitle: 'Update dependency foo to v2',
        state: 'all',
      });
      expect(pr).not.toBeNull();
    });
  });

  describe('getBranchPr()', () => {
    it('should find open PR for branch', async () => {
      await initFakeRepo();
      helperMock.listPullRecords.mockResolvedValueOnce([mockPull()]);

      const pr = await tangled.getBranchPr('renovate/foo-2.x');
      expect(pr).not.toBeNull();
      expect(pr!.sourceBranch).toBe('renovate/foo-2.x');
    });
  });

  describe('createPr()', () => {
    it('should create a pull request', async () => {
      await initFakeRepo();
      helperMock.getBranchHead
        .mockResolvedValueOnce('b'.repeat(40))
        .mockResolvedValueOnce('a'.repeat(40));
      helperMock.getMergeBase.mockResolvedValueOnce('a'.repeat(40));
      helperMock.createPullRecord.mockResolvedValueOnce({
        uri: `at://did:plc:repo123/org.tangled.track.ticket/${mockRkey}`,
        cid: 'bafycid',
        rkey: mockRkey,
      });

      const pr = await tangled.createPr({
        sourceBranch: 'renovate/foo-2.x',
        targetBranch: 'main',
        prTitle: 'Update foo',
        prBody: 'PR body',
      });

      expect(pr?.title).toBe('Update foo');
      expect(pr?.sourceBranch).toBe('renovate/foo-2.x');
      expect(pr?.targetBranch).toBe('main');
      expect(pr?.state).toBe('open');
      expect(pr?.number).toBe(mockPrNumber);

      expect(helperMock.getBranchHead).toHaveBeenCalledWith(
        'did:plc:repo123',
        'renovate/foo-2.x',
        'https://api.tangled.org/',
      );
      expect(helperMock.getMergeBase).toHaveBeenCalledWith(
        'did:plc:repo123',
        'a'.repeat(40),
        'b'.repeat(40),
        'https://api.tangled.org/',
      );
      expect(helperMock.createPullRecord).toHaveBeenCalledWith(
        'did:plc:repo123',
        'https://knot.example.com',
        'main',
        'renovate/foo-2.x',
        'b'.repeat(40),
        'a'.repeat(40),
        'Update foo',
        'PR body',
      );
    });
  });

  describe('updatePr()', () => {
    it('should update title and body', async () => {
      await initFakeRepo();
      helperMock.listPullRecords.mockResolvedValueOnce([mockPull()]);
      // Populate the cache
      await tangled.getPrList();

      await tangled.updatePr({
        number: mockPrNumber,
        prTitle: 'New title',
        prBody: 'New body',
      });

      expect(helperMock.updatePullRecord).toHaveBeenCalledWith(
        'did:plc:repo123',
        'https://knot.example.com',
        mockRkey,
        {
          title: 'New title',
          body: 'New body',
        },
      );
    });

    it('should close a PR', async () => {
      await initFakeRepo();
      helperMock.listPullRecords.mockResolvedValueOnce([mockPull()]);
      await tangled.getPrList();

      await tangled.updatePr({
        number: mockPrNumber,
        prTitle: 'title',
        state: 'closed',
      });

      expect(helperMock.setPullState).toHaveBeenCalledWith(
        'did:plc:repo123',
        'https://knot.example.com',
        mockRkey,
        'closed',
      );
    });

    it('should warn when PR number is unknown', async () => {
      await initFakeRepo();
      helperMock.listPullRecords.mockResolvedValueOnce([]);
      await tangled.getPrList();

      await tangled.updatePr({
        number: 999,
        prTitle: 'title',
      });

      expect(helperMock.updatePullRecord).not.toHaveBeenCalled();
    });

    it('should update body only', async () => {
      await initFakeRepo();
      helperMock.listPullRecords.mockResolvedValueOnce([mockPull()]);
      await tangled.getPrList();

      await tangled.updatePr({
        number: mockPrNumber,
        prTitle: '',
        prBody: 'New body',
      });

      expect(helperMock.updatePullRecord).toHaveBeenCalledWith(
        'did:plc:repo123',
        'https://knot.example.com',
        mockRkey,
        {
          body: 'New body',
        },
      );
    });

    it('should skip record update when there is nothing to update', async () => {
      await initFakeRepo();
      helperMock.listPullRecords.mockResolvedValueOnce([mockPull()]);
      await tangled.getPrList();

      await tangled.updatePr({
        number: mockPrNumber,
        prTitle: '',
      });

      expect(helperMock.updatePullRecord).not.toHaveBeenCalled();
      expect(helperMock.setPullState).not.toHaveBeenCalled();
    });
  });

  describe('refreshPr()', () => {
    it('resubmits the PR when the branch diff changed', async () => {
      await initFakeRepo();
      helperMock.listPullRecords.mockResolvedValueOnce([mockPull()]);
      await tangled.getPrList();
      helperMock.resubmitPull.mockResolvedValueOnce({
        changed: true,
        resubmitted: true,
        round: 1,
      });

      await tangled.refreshPr!(mockPrNumber);

      expect(helperMock.resubmitPull).toHaveBeenCalledWith(
        'did:plc:repo123',
        'https://knot.example.com',
        'https://api.tangled.org/',
        'main',
        'renovate/foo-2.x',
        mockRkey,
        false,
      );
    });

    it('does not write when the PR already matches the branch', async () => {
      await initFakeRepo();
      helperMock.listPullRecords.mockResolvedValueOnce([mockPull()]);
      await tangled.getPrList();

      await tangled.refreshPr!(mockPrNumber);

      expect(helperMock.resubmitPull).toHaveBeenCalledTimes(1);
    });

    it('skips PRs that are not open', async () => {
      await initFakeRepo();
      helperMock.listPullRecords.mockResolvedValueOnce([
        mockPull({ status: 'closed' }),
      ]);
      await tangled.getPrList();

      await tangled.refreshPr!(mockPrNumber);

      expect(helperMock.resubmitPull).not.toHaveBeenCalled();
    });

    it('skips fork-based PRs', async () => {
      await initFakeRepo();
      const pull = mockPull();
      pull.rounds = [
        mockRound({
          source: { repo: 'did:plc:forkrepo', branch: 'renovate/foo-2.x' },
        }),
      ];
      helperMock.listPullRecords.mockResolvedValueOnce([pull]);
      await tangled.getPrList();

      await tangled.refreshPr!(mockPrNumber);

      expect(helperMock.resubmitPull).not.toHaveBeenCalled();
    });

    it('warns when the PR is unknown', async () => {
      await initFakeRepo();
      helperMock.listPullRecords.mockResolvedValueOnce([]);
      await tangled.getPrList();

      await tangled.refreshPr!(mockPrNumber);

      expect(helperMock.resubmitPull).not.toHaveBeenCalled();
    });

    it('passes the dry-run flag through', async () => {
      await initFakeRepo();
      GlobalConfig.set({ dryRun: 'full' });
      helperMock.listPullRecords.mockResolvedValueOnce([mockPull()]);
      await tangled.getPrList();
      helperMock.resubmitPull.mockResolvedValueOnce({
        changed: true,
        resubmitted: false,
        round: 0,
      });

      await tangled.refreshPr!(mockPrNumber);

      expect(helperMock.resubmitPull).toHaveBeenCalledWith(
        'did:plc:repo123',
        'https://knot.example.com',
        'https://api.tangled.org/',
        'main',
        'renovate/foo-2.x',
        mockRkey,
        true,
      );
    });

    it('does not throw when resubmitting fails', async () => {
      await initFakeRepo();
      helperMock.listPullRecords.mockResolvedValueOnce([mockPull()]);
      await tangled.getPrList();
      helperMock.resubmitPull.mockRejectedValueOnce(new Error('knot error'));

      await expect(tangled.refreshPr!(mockPrNumber)).resolves.toBeUndefined();
    });
  });

  describe('mergePr()', () => {
    it('should merge a PR', async () => {
      await initFakeRepo();
      helperMock.listPullRecords.mockResolvedValueOnce([mockPull()]);
      await tangled.getPrList();

      helperMock.mergePull.mockResolvedValueOnce();

      const result = await tangled.mergePr({ id: mockPrNumber });
      expect(result).toBe(true);

      expect(helperMock.mergePull).toHaveBeenCalledWith(
        'did:plc:repo123',
        'https://knot.example.com',
        'knot.example.com',
        'https://api.tangled.org/',
        'main',
        mockRkey,
      );
    });

    it('should return false when PR is unknown', async () => {
      await initFakeRepo();
      helperMock.listPullRecords.mockResolvedValueOnce([]);
      await tangled.getPrList();

      const result = await tangled.mergePr({ id: 999 });
      expect(result).toBe(false);
    });

    it('should return false on merge failure', async () => {
      await initFakeRepo();
      helperMock.listPullRecords.mockResolvedValueOnce([mockPull()]);
      await tangled.getPrList();

      helperMock.mergePull.mockRejectedValueOnce(new Error('merge conflict'));

      const result = await tangled.mergePr({ id: mockPrNumber });
      expect(result).toBe(false);
    });

    it('should return false when the PR disappears from the list', async () => {
      await initFakeRepo();
      helperMock.getBranchHead
        .mockResolvedValueOnce('b'.repeat(40))
        .mockResolvedValueOnce('a'.repeat(40));
      helperMock.getMergeBase.mockResolvedValueOnce('a'.repeat(40));
      helperMock.createPullRecord.mockResolvedValueOnce({
        uri: `at://did:plc:repo123/org.tangled.track.ticket/${mockRkey}`,
        cid: 'bafycid',
        rkey: mockRkey,
      });
      await tangled.createPr({
        sourceBranch: 'renovate/foo-2.x',
        targetBranch: 'main',
        prTitle: 'Update foo',
        prBody: 'PR body',
      });

      helperMock.listPullRecords.mockResolvedValueOnce([]);

      const result = await tangled.mergePr({ id: mockPrNumber });
      expect(result).toBe(false);
    });
  });

  describe('deleteLabel()', () => {
    it('warns when the PR is unknown', async () => {
      await initFakeRepo();
      helperMock.listPullRecords.mockResolvedValueOnce([]);
      await tangled.getPrList();

      await expect(tangled.deleteLabel(999, 'rebase')).resolves.toBeUndefined();
      expect(helperMock.removeLabel).not.toHaveBeenCalled();
    });

    it('does nothing when the label is not applied', async () => {
      await initFakeRepo();
      helperMock.listPullRecords.mockResolvedValueOnce([mockPull()]);
      await tangled.getPrList();

      await tangled.deleteLabel(mockPrNumber, 'rebase');

      expect(helperMock.removeLabel).not.toHaveBeenCalled();
    });

    it('removes an applied label', async () => {
      await initFakeRepo();
      helperMock.listPullRecords.mockResolvedValueOnce([mockPull()]);
      helperMock.getLabels.mockResolvedValueOnce([
        {
          key: 'at://did:plc:repo123/org.tangled.label.definition/rebase',
          value: '',
          name: 'rebase',
        },
      ]);
      await tangled.getPrList();

      helperMock.removeLabel.mockResolvedValueOnce(true);

      await tangled.deleteLabel(mockPrNumber, 'rebase');

      expect(helperMock.removeLabel).toHaveBeenCalledWith(
        'did:plc:repo123',
        'https://knot.example.com',
        'https://api.tangled.org/',
        mockRkey,
        'rebase',
      );
    });

    it('swallows label removal failures', async () => {
      await initFakeRepo();
      helperMock.listPullRecords.mockResolvedValueOnce([mockPull()]);
      helperMock.getLabels.mockResolvedValueOnce([
        { key: 'definition', value: '', name: 'rebase' },
      ]);
      await tangled.getPrList();
      helperMock.removeLabel.mockRejectedValueOnce(new Error('nope'));

      await expect(
        tangled.deleteLabel(mockPrNumber, 'rebase'),
      ).resolves.toBeUndefined();
    });
  });

  describe('getBranchStatus()', () => {
    it('should return green', async () => {
      const status = await tangled.getBranchStatus('branch', true);
      expect(status).toBe('green');
    });
  });

  describe('getBranchStatusCheck()', () => {
    it('should return null', async () => {
      const status = await tangled.getBranchStatusCheck('branch', 'context');
      expect(status).toBeNull();
    });
  });

  describe('stub methods', () => {
    it('setBranchStatus resolves', async () => {
      await expect(
        tangled.setBranchStatus({
          branchName: 'branch',
          context: 'ctx',
          description: 'desc',
          state: 'green',
        }),
      ).resolves.toBeUndefined();
    });

    it('addReviewers resolves', async () => {
      await expect(tangled.addReviewers(1, ['user'])).resolves.toBeUndefined();
    });

    it('addAssignees resolves', async () => {
      await expect(tangled.addAssignees(1, ['user'])).resolves.toBeUndefined();
    });

    it('findIssue returns null', async () => {
      await expect(tangled.findIssue('title')).resolves.toBeNull();
    });

    it('getIssueList returns empty', async () => {
      await expect(tangled.getIssueList()).resolves.toEqual([]);
    });

    it('ensureIssue returns null', async () => {
      await expect(
        tangled.ensureIssue({ title: 't', body: 'b' }),
      ).resolves.toBeNull();
    });

    it('ensureIssueClosing resolves', async () => {
      await expect(
        tangled.ensureIssueClosing('title'),
      ).resolves.toBeUndefined();
    });

    it('ensureComment returns true', async () => {
      await expect(
        tangled.ensureComment({
          number: 1,
          topic: 'topic',
          content: 'content',
        }),
      ).resolves.toBe(true);
    });

    it('ensureCommentRemoval resolves', async () => {
      await expect(
        tangled.ensureCommentRemoval({
          type: 'by-topic',
          number: 1,
          topic: 'topic',
        }),
      ).resolves.toBeUndefined();
    });

    it('massageMarkdown removes the rebase checkbox', () => {
      const body =
        '**Rebasing**: Whenever PR becomes conflicted, or you tick the rebase/retry checkbox.\n\n---\n\n - [ ] <!-- rebase-check -->If you want to rebase/retry this PR, check this box\n\n';

      const result = tangled.massageMarkdown(body);

      expect(result).not.toContain('<!-- rebase-check -->');
      expect(result).toContain('you add the _rebase_ label');
    });

    it('massageMarkdown uses a custom rebase label', () => {
      const result = tangled.massageMarkdown(
        'you tick the rebase/retry checkbox',
        'retry',
      );
      expect(result).toBe('you add the _retry_ label');
    });

    it('massageMarkdown rewrites the edited-PR notice', () => {
      const result = tangled.massageMarkdown(
        'checking the rebase/retry box above',
      );
      expect(result).toBe('adding the _rebase_ label');
    });

    it('maxBodyLength returns large number', () => {
      expect(tangled.maxBodyLength()).toBe(1_000_000);
    });
  });
});
