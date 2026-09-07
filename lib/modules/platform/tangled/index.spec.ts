import { git } from '~test/util.ts';
import { repoFingerprint } from '../util.ts';
import * as tangled from './index.ts';
import * as helper from './tangled-helper.ts';
import type { TangledPull } from './types.ts';
import { tidToNumber } from './utils.ts';

vi.mock('../../../util/git/index.ts');
vi.mock('./tangled-helper.ts');

const helperMock = vi.mocked(helper);

const mockRkey = '3lbvg3wn2cs2i';
const mockPrNumber = tidToNumber(mockRkey);

function mockPull(overrides?: Partial<TangledPull>): TangledPull {
  return {
    uri: `at://did:plc:bot/sh.tangled.repo.pull/${mockRkey}`,
    cid: 'bafyreicid',
    rkey: mockRkey,
    record: {
      $type: 'sh.tangled.repo.pull',
      title: 'Update dependency foo to v2',
      body: 'PR body text',
      target: {
        repo: 'did:plc:repo123',
        branch: 'main',
      },
      source: {
        branch: 'renovate/foo-2.x',
        repo: undefined as any,
      },
      rounds: [
        {
          patchBlob: {
            $type: 'blob',
            ref: { $link: 'bafyref' },
            mimeType: 'application/gzip',
            size: 1024,
          },
          createdAt: '2025-01-01T00:00:00.000Z',
        },
      ],
      createdAt: '2025-01-01T00:00:00.000Z',
    },
    status: 'open',
    ...overrides,
  };
}

describe('modules/platform/tangled/index', () => {
  beforeEach(async () => {
    tangled.resetPlatform();

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

  async function initFakeRepo(): Promise<void> {
    helperMock.resolveHandle.mockResolvedValueOnce('did:plc:owner');
    helperMock.getRepoKnotHost.mockResolvedValueOnce('knot.example.com');
    helperMock.describeRepo.mockResolvedValueOnce({
      ownerDid: 'did:plc:owner',
      repoDid: 'did:plc:repo123',
      rkey: 'my-repo',
    });
    helperMock.getDefaultBranch.mockResolvedValueOnce({
      name: 'main',
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

    it('should authenticate and return platform info', async () => {
      const result = await tangled.initPlatform({
        username: 'renovate-bot.bsky.social',
        password: 'app-password',
        gitAuthor: 'Renovate Bot <renovate@example.com>',
      });

      expect(result).toEqual({
        endpoint: 'https://bsky.social',
        renovateUsername: 'renovate-bot.bsky.social',
        gitAuthor: 'Renovate Bot <renovate@example.com>',
      });
    });

    it('should use custom endpoint', async () => {
      const result = await tangled.initPlatform({
        endpoint: 'https://custom-pds.example.com',
        username: 'user',
        password: 'pass',
        gitAuthor: 'User <user@example.com>',
      });

      expect(result.endpoint).toBe('https://custom-pds.example.com');
      expect(helperMock.createSession).toHaveBeenCalledWith(
        'https://custom-pds.example.com',
        'user',
        'pass',
      );
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
  });

  describe('initRepo()', () => {
    it('should initialize a repo', async () => {
      await initFakeRepo();

      expect(helperMock.resolveHandle).toHaveBeenCalledWith(
        'owner.bsky.social',
      );
      expect(helperMock.getRepoKnotHost).toHaveBeenCalledWith(
        'did:plc:owner',
        'my-repo',
      );
      expect(git.initRepo).toHaveBeenCalledWith(
        expect.objectContaining({
          url: 'git@knot.example.com:did:plc:owner/my-repo',
          defaultBranch: 'main',
        }),
      );
    });

    it('should return repo result', async () => {
      helperMock.resolveHandle.mockResolvedValueOnce('did:plc:owner');
      helperMock.getRepoKnotHost.mockResolvedValueOnce('knot.example.com');
      helperMock.describeRepo.mockResolvedValueOnce({
        ownerDid: 'did:plc:owner',
        repoDid: 'did:plc:repo123',
        rkey: 'my-repo',
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
  });

  describe('getRepos()', () => {
    it('should return empty array', async () => {
      const repos = await tangled.getRepos();
      expect(repos).toEqual([]);
    });
  });

  describe('getRawFile()', () => {
    it('should fetch file content from knotserver', async () => {
      await initFakeRepo();
      helperMock.getBlob.mockResolvedValueOnce('file content');

      const result = await tangled.getRawFile('package.json');
      expect(result).toBe('file content');
      expect(helperMock.getBlob).toHaveBeenCalledWith(
        'knot.example.com',
        'did:plc:repo123',
        'main',
        'package.json',
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
        'knot.example.com',
        'did:plc:repo123',
        'v1.0.0',
        'package.json',
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

    it('should filter PRs by target repo', async () => {
      await initFakeRepo();
      const matchingPull = mockPull();
      const otherPull = mockPull({
        rkey: '3lbvg3wn2cs2j',
        uri: 'at://did:plc:bot/sh.tangled.repo.pull/3lbvg3wn2cs2j',
        record: {
          ...mockPull().record,
          target: {
            repo: 'did:plc:other-repo',
            branch: 'main',
          },
        },
      });
      helperMock.listPullRecords.mockResolvedValueOnce([
        matchingPull,
        otherPull,
      ]);

      const list = await tangled.getPrList();
      expect(list).toHaveLength(1);
      expect(list[0].number).toBe(mockPrNumber);
    });

    it('should skip pulls that cannot be converted', async () => {
      await initFakeRepo();
      const invalidPull = mockPull({
        rkey: '3lbvg3wn2cs2k',
        uri: 'at://did:plc:bot/sh.tangled.repo.pull/3lbvg3wn2cs2k',
        record: {
          ...mockPull().record,
          source: { branch: '', repo: undefined as any },
        },
      });
      helperMock.listPullRecords.mockResolvedValueOnce([
        mockPull(),
        invalidPull,
      ]);

      const list = await tangled.getPrList();
      expect(list).toHaveLength(1);
      expect(list[0].number).toBe(mockPrNumber);
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
      helperMock.compare.mockResolvedValueOnce(Buffer.from('patch data'));
      helperMock.uploadBlob.mockResolvedValueOnce({
        ref: { $link: 'bafyblob' },
        mimeType: 'application/gzip',
        size: 100,
      });
      helperMock.createPullRecord.mockResolvedValueOnce({
        uri: `at://did:plc:bot/sh.tangled.repo.pull/${mockRkey}`,
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

      expect(helperMock.compare).toHaveBeenCalledWith(
        'knot.example.com',
        'did:plc:repo123/my-repo',
        'main',
        'renovate/foo-2.x',
      );
      expect(helperMock.uploadBlob).toHaveBeenCalled();
      expect(helperMock.createPullRecord).toHaveBeenCalledWith(
        'did:plc:repo123',
        'main',
        'renovate/foo-2.x',
        'Update foo',
        'PR body',
        { ref: { $link: 'bafyblob' }, mimeType: 'application/gzip', size: 100 },
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

      expect(helperMock.updatePullRecord).toHaveBeenCalledWith(mockRkey, {
        title: 'New title',
        body: 'New body',
      });
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

      expect(helperMock.setPullStatus).toHaveBeenCalledWith(
        `at://did:plc:bot/sh.tangled.repo.pull/${mockRkey}`,
        'sh.tangled.repo.pull.status.closed',
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

      expect(helperMock.updatePullRecord).toHaveBeenCalledWith(mockRkey, {
        body: 'New body',
      });
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
      expect(helperMock.setPullStatus).not.toHaveBeenCalled();
    });
  });

  describe('mergePr()', () => {
    it('should merge a PR', async () => {
      await initFakeRepo();
      helperMock.listPullRecords.mockResolvedValueOnce([mockPull()]);
      await tangled.getPrList();

      helperMock.compare.mockResolvedValueOnce(Buffer.from('merge patch'));
      helperMock.mergePull.mockResolvedValueOnce();

      const result = await tangled.mergePr({ id: mockPrNumber });
      expect(result).toBe(true);

      expect(helperMock.mergePull).toHaveBeenCalledWith(
        'knot.example.com',
        'did:plc:owner',
        'my-repo',
        'main',
        'merge patch',
      );
      expect(helperMock.setPullStatus).toHaveBeenCalledWith(
        `at://did:plc:bot/sh.tangled.repo.pull/${mockRkey}`,
        'sh.tangled.repo.pull.status.closed',
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

      helperMock.compare.mockRejectedValueOnce(new Error('merge conflict'));

      const result = await tangled.mergePr({ id: mockPrNumber });
      expect(result).toBe(false);
    });

    it('should return false when the PR disappears from the list', async () => {
      await initFakeRepo();
      helperMock.compare.mockResolvedValueOnce(Buffer.from('patch data'));
      helperMock.uploadBlob.mockResolvedValueOnce({
        ref: { $link: 'bafyblob' },
        mimeType: 'application/gzip',
        size: 100,
      });
      helperMock.createPullRecord.mockResolvedValueOnce({
        uri: `at://did:plc:bot/sh.tangled.repo.pull/${mockRkey}`,
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

    it('deleteLabel resolves', async () => {
      await expect(tangled.deleteLabel(1, 'label')).resolves.toBeUndefined();
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

    it('massageMarkdown returns input', () => {
      expect(tangled.massageMarkdown('**bold**')).toBe('**bold**');
    });

    it('maxBodyLength returns large number', () => {
      expect(tangled.maxBodyLength()).toBe(1_000_000);
    });
  });
});
