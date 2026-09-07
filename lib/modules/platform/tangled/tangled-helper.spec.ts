const mockGet = vi.fn();
const mockPost = vi.fn();

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

vi.mock('../../../util/http/tangled.ts', () => {
  const instance = {
    getJsonUnchecked: vi.fn(),
    getText: vi.fn(),
    getBuffer: vi.fn(),
    postJson: vi.fn(),
  };
  return {
    TangledHttp: class MockTangledHttp {
      getJsonUnchecked = instance.getJsonUnchecked;
      getText = instance.getText;
      getBuffer = instance.getBuffer;
      postJson = instance.postJson;
    },
    _instance: instance,
  };
});

import { PasswordSession } from '@atcute/password-session';
import * as helper from './tangled-helper.ts';

describe('modules/platform/tangled/tangled-helper', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    helper.resetHelper();
  });

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
      vi.mocked(PasswordSession.login).mockResolvedValueOnce({
        did: 'did:plc:bot123',
        session: { handle: 'bot.test' },
        dispatchUrl: 'https://pds.example.com',
      } as any);

      await helper.createSession('https://bsky.social', 'bot.test', 'pass');

      expect(helper.getBotDid()).toBe('did:plc:bot123');
      expect(helper.getBotHandle()).toBe('bot.test');
    });
  });

  describe('resetHelper', () => {
    it('clears session state', async () => {
      vi.mocked(PasswordSession.login).mockResolvedValueOnce({
        did: 'did:plc:bot123',
        session: { handle: 'bot.test' },
        dispatchUrl: 'https://pds.example.com',
      } as any);

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
  });

  describe('uploadBlob', () => {
    it('throws when not authenticated', async () => {
      await expect(helper.uploadBlob(Buffer.from('test'))).rejects.toThrow(
        'Not authenticated',
      );
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
  });

  describe('updatePullRecord', () => {
    it('throws when not authenticated', async () => {
      await expect(
        helper.updatePullRecord('rkey', { title: 'new title' }),
      ).rejects.toThrow('Not authenticated');
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
  });

  describe('listPullRecords', () => {
    it('throws when not authenticated', async () => {
      await expect(helper.listPullRecords()).rejects.toThrow(
        'Not authenticated',
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

  describe('getRepoKnotHost', () => {
    it('returns the knot host from the repo record', async () => {
      mockGet.mockResolvedValueOnce({
        value: { knot: 'knot.example.com' },
      });

      const host = await helper.getRepoKnotHost('did:plc:owner', 'my-repo');
      expect(host).toBe('knot.example.com');
    });

    it('throws when knot field is missing', async () => {
      mockGet.mockResolvedValueOnce({
        value: {},
      });

      await expect(
        helper.getRepoKnotHost('did:plc:owner', 'my-repo'),
      ).rejects.toThrow('Could not determine knot host');
    });
  });
});
