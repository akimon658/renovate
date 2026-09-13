const mockGet = vi.fn();
const mockPost = vi.fn();
const httpMocks = vi.hoisted(() => ({
  getJsonUnchecked: vi.fn(),
  getText: vi.fn(),
  getBuffer: vi.fn(),
  postJson: vi.fn(),
}));

vi.mock('@atcute/client', () => ({
  Client: class MockClient {
    get = mockGet;
    post = mockPost;
  },
  ok: vi.fn((promise: Promise<any>) => promise),
  simpleFetchHandler: vi.fn(),
}));

vi.mock('@atcute/password-session', () => ({
  PasswordSession: {
    login: vi.fn(),
  },
}));

vi.mock('../../../util/http/tangled.ts', () => ({
  TangledHttp: class MockTangledHttp {
    getJsonUnchecked = httpMocks.getJsonUnchecked;
    getText = httpMocks.getText;
    getBuffer = httpMocks.getBuffer;
    postJson = httpMocks.postJson;
  },
}));

import {
  PasswordSession,
  type PasswordSessionData,
} from '@atcute/password-session';
import { partial } from '../../../../test/util.ts';
import * as helper from './tangled-helper.ts';

function recordNotFound(): Error {
  return Object.assign(new Error('Record not found'), {
    error: 'RecordNotFound',
  });
}

describe('modules/platform/tangled/tangled-helper', () => {
  beforeEach(() => {
    helper.resetHelper();
  });

  async function authenticate(): Promise<void> {
    vi.mocked(PasswordSession.login).mockResolvedValueOnce(
      partial<PasswordSession>({
        did: 'did:plc:bot123',
        session: partial<PasswordSessionData>({ handle: 'bot.test' }),
        dispatchUrl: 'https://pds.example.com',
      }),
    );
    await helper.createSession('https://bsky.social', 'bot.test', 'pass');
  }

  describe('createSession', () => {
    it('authenticates and returns session info', async () => {
      const mockSession = {
        did: 'did:plc:bot123',
        session: { handle: 'bot.bsky.social' },
        dispatchUrl: 'https://pds.example.com',
      };
      vi.mocked(PasswordSession.login).mockResolvedValueOnce(
        mockSession as any,
      );

      const result = await helper.createSession(
        'https://bsky.social',
        'bot.bsky.social',
        'app-password',
      );

      expect(result).toEqual({
        did: 'did:plc:bot123',
        handle: 'bot.bsky.social',
        pdsUrl: 'https://pds.example.com',
      });
      expect(PasswordSession.login).toHaveBeenCalledWith({
        service: 'https://bsky.social',
        identifier: 'bot.bsky.social',
        password: 'app-password',
      });
    });
  });

  describe('getBotDid / getBotHandle', () => {
    it('returns empty strings before authentication', () => {
      expect(helper.getBotDid()).toBe('');
      expect(helper.getBotHandle()).toBe('');
    });

    it('returns values after authentication', async () => {
      const mockSession = {
        did: 'did:plc:bot123',
        session: { handle: 'bot.test' },
        dispatchUrl: 'https://pds.example.com',
      };
      vi.mocked(PasswordSession.login).mockResolvedValueOnce(
        mockSession as any,
      );

      await helper.createSession('https://bsky.social', 'bot.test', 'pass');

      expect(helper.getBotDid()).toBe('did:plc:bot123');
      expect(helper.getBotHandle()).toBe('bot.test');
    });
  });

  describe('resetHelper', () => {
    it('clears session state', async () => {
      const mockSession = {
        did: 'did:plc:bot123',
        session: { handle: 'bot.test' },
        dispatchUrl: 'https://pds.example.com',
      };
      vi.mocked(PasswordSession.login).mockResolvedValueOnce(
        mockSession as any,
      );

      await helper.createSession('https://bsky.social', 'bot.test', 'pass');
      helper.resetHelper();

      expect(helper.getBotDid()).toBe('');
      expect(helper.getBotHandle()).toBe('');
    });
  });

  describe('getServiceAuth', () => {
    it('throws when not authenticated', async () => {
      await expect(helper.getServiceAuth('aud')).rejects.toThrow(
        'Not authenticated',
      );
    });

    it('requests a service auth token', async () => {
      await authenticate();
      mockGet.mockResolvedValueOnce({ token: 'jwt-token' });

      await expect(
        helper.getServiceAuth('did:web:knot.example.com'),
      ).resolves.toBe('jwt-token');

      expect(mockGet).toHaveBeenCalledWith(
        'com.atproto.server.getServiceAuth',
        {
          params: { aud: 'did:web:knot.example.com' },
        },
      );
    });

    it('includes lxm in params when provided', async () => {
      await authenticate();
      mockGet.mockResolvedValueOnce({ token: 'jwt-token' });

      await expect(
        helper.getServiceAuth(
          'did:web:knot.example.com',
          'sh.tangled.repo.merge',
        ),
      ).resolves.toBe('jwt-token');

      expect(mockGet).toHaveBeenCalledWith(
        'com.atproto.server.getServiceAuth',
        {
          params: {
            aud: 'did:web:knot.example.com',
            lxm: 'sh.tangled.repo.merge',
          },
        },
      );
    });
  });

  describe('getDefaultBranch', () => {
    it('fetches default branch info from the knotserver', async () => {
      httpMocks.getJsonUnchecked.mockResolvedValueOnce({
        body: { name: 'main', hash: 'abc123' },
      });

      await expect(
        helper.getDefaultBranch('knot.example.com', 'did:plc:repo/my-repo'),
      ).resolves.toEqual({ name: 'main', hash: 'abc123' });

      expect(httpMocks.getJsonUnchecked).toHaveBeenCalledWith(
        expect.stringContaining(
          'https://knot.example.com/xrpc/sh.tangled.repo.getDefaultBranch?',
        ),
      );
    });
  });

  describe('describeRepo', () => {
    it('fetches repo info from the knotserver', async () => {
      httpMocks.getJsonUnchecked.mockResolvedValueOnce({
        body: {
          ownerDid: 'did:plc:owner',
          repoDid: 'did:plc:repo',
          rkey: 'my-repo',
        },
      });

      await expect(
        helper.describeRepo('knot.example.com', 'did:plc:owner/my-repo'),
      ).resolves.toEqual({
        ownerDid: 'did:plc:owner',
        repoDid: 'did:plc:repo',
        rkey: 'my-repo',
      });

      expect(httpMocks.getJsonUnchecked).toHaveBeenCalledWith(
        expect.stringContaining(
          'https://knot.example.com/xrpc/sh.tangled.repo.describeRepo?',
        ),
      );
    });
  });

  describe('getBlob', () => {
    it('returns file content from the knotserver', async () => {
      httpMocks.getText.mockResolvedValueOnce({ body: 'file content' });

      await expect(
        helper.getBlob(
          'knot.example.com',
          'did:plc:repo',
          'main',
          'package.json',
        ),
      ).resolves.toBe('file content');
    });

    it('returns null when the request fails', async () => {
      httpMocks.getText.mockRejectedValueOnce(new Error('not found'));

      await expect(
        helper.getBlob(
          'knot.example.com',
          'did:plc:repo',
          'main',
          'package.json',
        ),
      ).resolves.toBeNull();
    });
  });

  describe('compare', () => {
    it('returns the format-patch buffer', async () => {
      const buffer = Buffer.from('patch data');
      httpMocks.getBuffer.mockResolvedValueOnce({ body: buffer });

      await expect(
        helper.compare(
          'knot.example.com',
          'did:plc:repo/my-repo',
          'main',
          'renovate/foo-2.x',
        ),
      ).resolves.toEqual(buffer);
    });
  });

  describe('uploadBlob', () => {
    it('throws when not authenticated', async () => {
      await expect(helper.uploadBlob(Buffer.from('test'))).rejects.toThrow(
        'Not authenticated',
      );
    });

    it('uploads the blob and returns its reference', async () => {
      await authenticate();
      const blobRef = {
        ref: { $link: 'bafyblob' },
        mimeType: 'application/gzip',
        size: 100,
      };
      mockPost.mockResolvedValueOnce({ blob: blobRef });

      await expect(helper.uploadBlob(Buffer.from('data'))).resolves.toEqual(
        blobRef,
      );

      expect(mockPost).toHaveBeenCalledWith('com.atproto.repo.uploadBlob', {
        input: expect.any(Blob),
      });
    });
  });

  describe('createPullRecord', () => {
    it('throws when not authenticated', async () => {
      await expect(
        helper.createPullRecord(
          'did:plc:repo',
          'main',
          'renovate/dep',
          'title',
          'body',
          {
            ref: { $link: 'bafyref' },
            mimeType: 'application/gzip',
            size: 100,
          },
        ),
      ).rejects.toThrow('Not authenticated');
    });

    it('creates a pull record', async () => {
      await authenticate();
      mockPost.mockResolvedValueOnce({
        uri: 'at://did:plc:bot/sh.tangled.repo.pull/tid123',
        cid: 'bafycid',
      });

      const result = await helper.createPullRecord(
        'did:plc:repo',
        'main',
        'renovate/foo-2.x',
        'title',
        'body',
        { ref: { $link: 'bafyref' }, mimeType: 'application/gzip', size: 100 },
      );

      expect(result.uri).toBe('at://did:plc:bot/sh.tangled.repo.pull/tid123');
      expect(result.cid).toBe('bafycid');
      expect(result.rkey).toMatch(/^[234567abcdefghijklmnopqrstuvwxyz]{13}$/);

      const { input } = mockPost.mock.calls[0][1];
      expect(input.record).toMatchObject({
        $type: 'sh.tangled.repo.pull',
        title: 'title',
        body: 'body',
        target: { repo: 'did:plc:repo', branch: 'main' },
        source: { branch: 'renovate/foo-2.x', repo: undefined },
      });
    });

    it('omits empty body and sets fork repo when provided', async () => {
      await authenticate();
      mockPost.mockResolvedValueOnce({
        uri: 'at://did:plc:bot/sh.tangled.repo.pull/tid123',
        cid: 'bafycid',
      });

      await helper.createPullRecord(
        'did:plc:repo',
        'main',
        'renovate/foo-2.x',
        'title',
        '',
        { ref: { $link: 'bafyref' }, mimeType: 'application/gzip', size: 100 },
        'did:plc:fork',
      );

      const { input } = mockPost.mock.calls[0][1];
      expect(input.record).toMatchObject({
        title: 'title',
        target: { repo: 'did:plc:repo', branch: 'main' },
        source: { branch: 'renovate/foo-2.x', repo: 'did:plc:fork' },
      });
      expect(input.record.body).toBeUndefined();
    });
  });

  describe('updatePullRecord', () => {
    it('throws when not authenticated', async () => {
      await expect(
        helper.updatePullRecord('rkey', { title: 'new title' }),
      ).rejects.toThrow('Not authenticated');
    });

    it('updates title and body', async () => {
      await authenticate();
      mockGet.mockResolvedValueOnce({
        value: { title: 'old title', body: 'old body' },
      });
      mockPost.mockResolvedValueOnce({});

      await helper.updatePullRecord('rkey', {
        title: 'new title',
        body: 'new body',
      });

      const { input } = mockPost.mock.calls[0][1];
      expect(input.record).toEqual({
        title: 'new title',
        body: 'new body',
      });
    });

    it('updates title only', async () => {
      await authenticate();
      mockGet.mockResolvedValueOnce({
        value: { title: 'old title', body: 'old body' },
      });
      mockPost.mockResolvedValueOnce({});

      await helper.updatePullRecord('rkey', { title: 'new title' });

      const { input } = mockPost.mock.calls[0][1];
      expect(input.record).toEqual({
        title: 'new title',
        body: 'old body',
      });
    });

    it('updates body only and removes it when empty', async () => {
      await authenticate();
      mockGet.mockResolvedValueOnce({
        value: { title: 'old title', body: 'old body' },
      });
      mockPost.mockResolvedValueOnce({});

      await helper.updatePullRecord('rkey', { body: '' });

      const { input } = mockPost.mock.calls[0][1];
      expect(input.record).toEqual({
        title: 'old title',
        body: undefined,
      });
      expect(input.record.body).toBeUndefined();
    });
  });

  describe('setPullStatus', () => {
    it('throws when not authenticated', async () => {
      await expect(
        helper.setPullStatus(
          'at://did:plc:bot/sh.tangled.repo.pull/tid',
          'sh.tangled.repo.pull.status.closed',
        ),
      ).rejects.toThrow('Not authenticated');
    });

    it('creates a status record', async () => {
      await authenticate();
      mockPost.mockResolvedValueOnce({});

      await helper.setPullStatus(
        'at://did:plc:bot/sh.tangled.repo.pull/tid',
        'sh.tangled.repo.pull.status.closed',
      );

      expect(mockPost).toHaveBeenCalledWith('com.atproto.repo.createRecord', {
        input: {
          repo: 'did:plc:bot123',
          collection: 'sh.tangled.repo.pull.status',
          record: {
            $type: 'sh.tangled.repo.pull.status',
            pull: 'at://did:plc:bot/sh.tangled.repo.pull/tid',
            status: 'sh.tangled.repo.pull.status.closed',
          },
        },
      });
    });
  });

  describe('listPullRecords', () => {
    it('throws when not authenticated', async () => {
      await expect(helper.listPullRecords()).rejects.toThrow(
        'Not authenticated',
      );
    });

    it('lists pulls across pages and resolves statuses', async () => {
      await authenticate();
      mockGet
        .mockResolvedValueOnce({
          records: [
            {
              uri: 'at://did:plc:bot/sh.tangled.repo.pull/tid1',
              cid: 'c1',
              value: { title: 'one' },
            },
            {
              uri: 'at://did:plc:bot/sh.tangled.repo.pull/tid2',
              cid: 'c2',
              value: { title: 'two' },
            },
            {
              uri: 'at://did:plc:bot/sh.tangled.repo.pull/tid3',
              cid: 'c3',
              value: { title: 'three' },
            },
          ],
          cursor: 'next',
        })
        .mockResolvedValueOnce({
          records: [
            {
              uri: 'at://did:plc:bot/sh.tangled.repo.pull/tid4',
              cid: 'c4',
              value: { title: 'four' },
            },
          ],
        })
        .mockResolvedValueOnce({
          records: [
            {
              uri: 'at://did:plc:bot/sh.tangled.repo.pull.status/s1',
              cid: 's1',
              value: {
                pull: 'at://did:plc:bot/sh.tangled.repo.pull/tid1',
                status: 'sh.tangled.repo.pull.status.closed',
              },
            },
            {
              uri: 'at://did:plc:bot/sh.tangled.repo.pull.status/s2',
              cid: 's2',
              value: {
                pull: 'at://did:plc:bot/sh.tangled.repo.pull/tid2',
                status: 'sh.tangled.repo.pull.status.merged',
              },
            },
          ],
          cursor: 'status-next',
        })
        .mockResolvedValueOnce({
          records: [
            {
              uri: 'at://did:plc:bot/sh.tangled.repo.pull.status/s3',
              cid: 's3',
              value: {
                pull: 'at://did:plc:bot/sh.tangled.repo.pull/tid3',
                status: 'sh.tangled.repo.pull.status.open',
              },
            },
            {
              uri: 'at://did:plc:bot/sh.tangled.repo.pull.status/s4',
              cid: 's4',
              value: {
                pull: 'at://did:plc:bot/sh.tangled.repo.pull/tid3',
                status: 'sh.tangled.repo.pull.status.open',
              },
            },
          ],
        });

      const pulls = await helper.listPullRecords();

      expect(pulls).toHaveLength(4);
      const statusByRkey = new Map(pulls.map((p) => [p.rkey, p.status]));
      expect(statusByRkey.get('tid1')).toBe('closed');
      expect(statusByRkey.get('tid2')).toBe('merged');
      expect(statusByRkey.get('tid3')).toBe('open');
      expect(statusByRkey.get('tid4')).toBe('open');

      expect(mockGet).toHaveBeenNthCalledWith(
        2,
        'com.atproto.repo.listRecords',
        { params: expect.objectContaining({ cursor: 'next' }) },
      );
      expect(mockGet).toHaveBeenNthCalledWith(
        4,
        'com.atproto.repo.listRecords',
        { params: expect.objectContaining({ cursor: 'status-next' }) },
      );
    });
  });

  describe('mergePull', () => {
    it('merges a pull via the knotserver', async () => {
      await authenticate();
      mockGet.mockResolvedValueOnce({ token: 'jwt-token' });
      httpMocks.postJson.mockResolvedValueOnce({});

      await helper.mergePull(
        'knot.example.com',
        'did:plc:repo',
        'did:plc:owner',
        'my-repo',
        'main',
        'patch',
      );

      expect(mockGet).toHaveBeenCalledWith(
        'com.atproto.server.getServiceAuth',
        {
          params: {
            aud: 'did:web:knot.example.com',
            lxm: 'sh.tangled.repo.merge',
          },
        },
      );
      expect(httpMocks.postJson).toHaveBeenCalledWith(
        'https://knot.example.com/xrpc/sh.tangled.repo.merge',
        {
          body: {
            repo: 'did:plc:repo',
            did: 'did:plc:owner',
            name: 'my-repo',
            branch: 'main',
            patch: 'patch',
          },
          headers: { Authorization: 'Bearer jwt-token' },
        },
      );
    });
  });

  describe('resolveHandle', () => {
    it('resolves a handle to a DID', async () => {
      mockGet.mockResolvedValueOnce({ did: 'did:plc:resolved' });

      const did = await helper.resolveHandle('user.bsky.social');
      expect(did).toBe('did:plc:resolved');
    });
  });

  describe('resolvePdsEndpoint', () => {
    it('resolves a did:plc through the PLC directory', async () => {
      httpMocks.getJsonUnchecked.mockResolvedValueOnce({
        body: {
          service: [
            {
              id: '#atproto_pds',
              type: 'AtprotoPersonalDataServer',
              serviceEndpoint: 'https://pds.example.com',
            },
          ],
        },
      });

      await expect(helper.resolvePdsEndpoint('did:plc:owner')).resolves.toBe(
        'https://pds.example.com',
      );

      expect(httpMocks.getJsonUnchecked).toHaveBeenCalledWith(
        'https://plc.directory/did:plc:owner',
      );
    });

    it('resolves a did:web through its DID document', async () => {
      httpMocks.getJsonUnchecked.mockResolvedValueOnce({
        body: {
          service: [
            {
              id: '#atproto_pds',
              type: 'AtprotoPersonalDataServer',
              serviceEndpoint: 'https://web-pds.example.com',
            },
          ],
        },
      });

      await expect(
        helper.resolvePdsEndpoint('did:web:example.com'),
      ).resolves.toBe('https://web-pds.example.com');

      expect(httpMocks.getJsonUnchecked).toHaveBeenCalledWith(
        'https://example.com/.well-known/did.json',
      );
    });

    it('resolves a did:web with path segments', async () => {
      httpMocks.getJsonUnchecked.mockResolvedValueOnce({
        body: {
          service: [
            {
              id: '#atproto_pds',
              type: 'AtprotoPersonalDataServer',
              serviceEndpoint: 'https://web-pds.example.com',
            },
          ],
        },
      });

      await expect(
        helper.resolvePdsEndpoint('did:web:example.com:user:alice'),
      ).resolves.toBe('https://web-pds.example.com');

      expect(httpMocks.getJsonUnchecked).toHaveBeenCalledWith(
        'https://example.com/user/alice/did.json',
      );
    });

    it('resolves a did:web with an encoded port', async () => {
      httpMocks.getJsonUnchecked.mockResolvedValueOnce({
        body: {
          service: [
            {
              id: '#atproto_pds',
              type: 'AtprotoPersonalDataServer',
              serviceEndpoint: 'https://web-pds.example.com',
            },
          ],
        },
      });

      await expect(
        helper.resolvePdsEndpoint('did:web:example.com%3A3000'),
      ).resolves.toBe('https://web-pds.example.com');

      expect(httpMocks.getJsonUnchecked).toHaveBeenCalledWith(
        'https://example.com:3000/.well-known/did.json',
      );
    });

    it('falls back to the bsky AppView when resolution fails', async () => {
      httpMocks.getJsonUnchecked.mockRejectedValueOnce(new Error('nope'));

      await expect(helper.resolvePdsEndpoint('did:plc:owner')).resolves.toBe(
        'https://public.api.bsky.app',
      );
    });

    it('falls back without a request for unsupported DID methods', async () => {
      await expect(helper.resolvePdsEndpoint('did:key:z6Mk')).resolves.toBe(
        'https://public.api.bsky.app',
      );

      expect(httpMocks.getJsonUnchecked).not.toHaveBeenCalled();
    });

    it('matches a PDS service by its type', async () => {
      httpMocks.getJsonUnchecked.mockResolvedValueOnce({
        body: {
          service: [
            {
              type: 'AtprotoPersonalDataServer',
              serviceEndpoint: 'https://typed-pds.example.com',
            },
          ],
        },
      });

      await expect(helper.resolvePdsEndpoint('did:plc:owner')).resolves.toBe(
        'https://typed-pds.example.com',
      );
    });

    it('matches a PDS service by a fully-qualified id', async () => {
      httpMocks.getJsonUnchecked.mockResolvedValueOnce({
        body: {
          service: [
            {
              id: 'did:plc:owner#atproto_pds',
              serviceEndpoint: 'https://fq-pds.example.com',
            },
          ],
        },
      });

      await expect(helper.resolvePdsEndpoint('did:plc:owner')).resolves.toBe(
        'https://fq-pds.example.com',
      );
    });

    it('ignores services that are not the PDS', async () => {
      httpMocks.getJsonUnchecked.mockResolvedValueOnce({
        body: {
          service: [
            {
              type: 'AtprotoLabeler',
              serviceEndpoint: 'https://labeler.example.com',
            },
            {
              id: 'did:plc:owner#atproto_pds',
              serviceEndpoint: 'https://pds.example.com',
            },
          ],
        },
      });

      await expect(helper.resolvePdsEndpoint('did:plc:owner')).resolves.toBe(
        'https://pds.example.com',
      );
    });

    it('falls back when no PDS service is present', async () => {
      httpMocks.getJsonUnchecked.mockResolvedValueOnce({ body: {} });

      await expect(helper.resolvePdsEndpoint('did:plc:owner')).resolves.toBe(
        'https://public.api.bsky.app',
      );
    });
  });

  describe('resolveRepoRef', () => {
    it('resolves a repo whose rkey matches its name', async () => {
      mockGet.mockResolvedValueOnce({
        value: {
          knot: 'knot.example.com',
          repoDid: 'did:plc:repo',
          name: 'my-repo',
        },
      });

      await expect(
        helper.resolveRepoRef('did:plc:owner', 'my-repo'),
      ).resolves.toEqual({
        knot: 'knot.example.com',
        repoDid: 'did:plc:repo',
        name: 'my-repo',
        rkey: 'my-repo',
      });

      expect(mockGet).toHaveBeenCalledWith('com.atproto.repo.getRecord', {
        params: {
          repo: 'did:plc:owner',
          collection: 'sh.tangled.repo',
          rkey: 'my-repo',
        },
      });
    });

    it('falls back to the requested name when the record has no name', async () => {
      mockGet.mockResolvedValueOnce({
        value: { knot: 'knot.example.com', repoDid: 'did:plc:repo' },
      });

      await expect(
        helper.resolveRepoRef('did:plc:owner', 'my-repo'),
      ).resolves.toEqual({
        knot: 'knot.example.com',
        repoDid: 'did:plc:repo',
        name: 'my-repo',
        rkey: 'my-repo',
      });
    });

    it('falls back to listRecords when the name is not the rkey', async () => {
      mockGet.mockRejectedValueOnce(recordNotFound()).mockResolvedValueOnce({
        records: [
          {
            uri: 'at://did:plc:owner/sh.tangled.repo/tid123',
            cid: 'c1',
            value: { name: 'other-repo', knot: 'knot.example.com' },
          },
          {
            uri: 'at://did:plc:owner/sh.tangled.repo/tid456',
            cid: 'c2',
            value: {
              name: 'my-repo',
              knot: 'knot.example.com',
              repoDid: 'did:plc:repo',
            },
          },
        ],
      });

      await expect(
        helper.resolveRepoRef('did:plc:owner', 'my-repo'),
      ).resolves.toEqual({
        knot: 'knot.example.com',
        repoDid: 'did:plc:repo',
        name: 'my-repo',
        rkey: 'tid456',
      });
    });

    it('paginates listRecords while searching', async () => {
      mockGet
        .mockRejectedValueOnce(recordNotFound())
        .mockResolvedValueOnce({
          records: [
            {
              uri: 'at://did:plc:owner/sh.tangled.repo/tid1',
              cid: 'c1',
              value: { name: 'other', knot: 'knot.example.com' },
            },
          ],
          cursor: 'next',
        })
        .mockResolvedValueOnce({
          records: [
            {
              uri: 'at://did:plc:owner/sh.tangled.repo/tid2',
              cid: 'c2',
              value: { name: 'my-repo', knot: 'knot.example.com' },
            },
          ],
        });

      await expect(
        helper.resolveRepoRef('did:plc:owner', 'my-repo'),
      ).resolves.toEqual({
        knot: 'knot.example.com',
        repoDid: '',
        name: 'my-repo',
        rkey: 'tid2',
      });

      expect(mockGet).toHaveBeenNthCalledWith(
        3,
        'com.atproto.repo.listRecords',
        {
          params: {
            repo: 'did:plc:owner',
            collection: 'sh.tangled.repo',
            limit: 100,
            cursor: 'next',
          },
        },
      );
    });

    it('throws when the repo cannot be found', async () => {
      mockGet
        .mockRejectedValueOnce(recordNotFound())
        .mockResolvedValueOnce({ records: [] });

      await expect(
        helper.resolveRepoRef('did:plc:owner', 'missing'),
      ).rejects.toThrow('Tangled repository "missing" was not found');
    });

    it('falls back to listRecords when the direct record was renamed', async () => {
      mockGet
        .mockResolvedValueOnce({
          value: {
            knot: 'knot.example.com',
            repoDid: 'did:plc:repo',
            name: 'new-name',
          },
        })
        .mockResolvedValueOnce({
          records: [
            {
              uri: 'at://did:plc:owner/sh.tangled.repo/my-repo',
              cid: 'c1',
              value: {
                name: 'my-repo',
                knot: 'knot.example.com',
                repoDid: 'did:plc:repo',
              },
            },
          ],
        });

      await expect(
        helper.resolveRepoRef('did:plc:owner', 'my-repo'),
      ).resolves.toEqual({
        knot: 'knot.example.com',
        repoDid: 'did:plc:repo',
        name: 'my-repo',
        rkey: 'my-repo',
      });

      expect(mockGet).toHaveBeenNthCalledWith(
        2,
        'com.atproto.repo.listRecords',
        expect.anything(),
      );
    });

    it('rethrows non-RecordNotFound errors from the direct lookup', async () => {
      mockGet.mockRejectedValueOnce(
        Object.assign(new Error('boom'), { status: 500 }),
      );

      await expect(
        helper.resolveRepoRef('did:plc:owner', 'my-repo'),
      ).rejects.toThrow('boom');

      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('throws when the direct record is null', async () => {
      mockGet.mockResolvedValueOnce({ value: null });

      await expect(
        helper.resolveRepoRef('did:plc:owner', 'my-repo'),
      ).rejects.toThrow('Could not determine knot host');
    });

    it('throws when the knot field is missing', async () => {
      mockGet.mockResolvedValueOnce({
        value: { name: 'my-repo' },
      });

      await expect(
        helper.resolveRepoRef('did:plc:owner', 'my-repo'),
      ).rejects.toThrow('Could not determine knot host');
    });
  });
});
