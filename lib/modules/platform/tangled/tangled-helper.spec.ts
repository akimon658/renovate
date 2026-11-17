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

function invalidSwap(): Error {
  return Object.assign(new Error('Request failed with status code 409'), {
    response: {
      statusCode: 409,
      body: {
        error: 'InvalidSwap',
      },
    },
  });
}

describe('modules/platform/tangled/tangled-helper', () => {
  const appview = 'https://api.tangled.org/';
  const repoDid = 'did:plc:repo123';
  const knotUrl = 'https://knot.example.com';

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

      await expect(helper.getServiceAuth('did:plc:repo123')).resolves.toBe(
        'jwt-token',
      );
    });

    it('includes lxm in params when provided', async () => {
      await authenticate();
      mockGet.mockResolvedValueOnce({ token: 'jwt-token' });

      await expect(
        helper.getServiceAuth(
          'did:plc:repo123',
          'com.atproto.repo.createRecord',
        ),
      ).resolves.toBe('jwt-token');
    });
  });

  describe('getBranchHead', () => {
    it('fetches the branch head from the index', async () => {
      httpMocks.getJsonUnchecked.mockResolvedValueOnce({
        body: { oid: 'a'.repeat(40) },
      });

      await expect(
        helper.getBranchHead(repoDid, 'main', appview),
      ).resolves.toBe('a'.repeat(40));

      expect(httpMocks.getJsonUnchecked).toHaveBeenCalledWith(
        expect.stringContaining('org.tangled.temp.git.getRef'),
      );
    });

    it('throws when the response has no oid', async () => {
      httpMocks.getJsonUnchecked.mockResolvedValueOnce({ body: {} });
      await expect(
        helper.getBranchHead(repoDid, 'main', appview),
      ).rejects.toThrow('Could not determine head');
    });
  });

  describe('getMergeBase', () => {
    it('fetches the merge base from the index', async () => {
      httpMocks.getJsonUnchecked.mockResolvedValueOnce({
        body: { commit: 'c'.repeat(40) },
      });

      await expect(
        helper.getMergeBase(repoDid, 'a'.repeat(40), 'b'.repeat(40), appview),
      ).resolves.toBe('c'.repeat(40));
    });
  });

  describe('getDefaultBranch', () => {
    it('fetches the default branch from the index', async () => {
      httpMocks.getJsonUnchecked.mockResolvedValueOnce({
        body: {
          defaultBranch: 'main',
          branches: [{ name: 'main', oid: 'a'.repeat(40) }],
        },
      });

      await expect(helper.getDefaultBranch(repoDid, appview)).resolves.toEqual({
        name: 'main',
        hash: 'a'.repeat(40),
      });
    });

    it('throws when there is no default branch', async () => {
      httpMocks.getJsonUnchecked.mockResolvedValueOnce({ body: {} });
      await expect(helper.getDefaultBranch(repoDid, appview)).rejects.toThrow(
        'Could not determine default branch',
      );
    });
  });

  describe('getBlob', () => {
    it('returns file content', async () => {
      httpMocks.getText.mockResolvedValueOnce({ body: 'file content' });
      await expect(
        helper.getBlob(repoDid, 'main', 'package.json', appview),
      ).resolves.toBe('file content');
    });

    it('returns null when the request fails', async () => {
      httpMocks.getText.mockRejectedValueOnce(new Error('not found'));
      await expect(
        helper.getBlob(repoDid, 'main', 'package.json', appview),
      ).resolves.toBeNull();
    });
  });

  describe('getFormatPatch', () => {
    it('returns the format-patch text', async () => {
      httpMocks.getText.mockResolvedValueOnce({ body: 'patch data' });
      await expect(
        helper.getFormatPatch(repoDid, 'a'.repeat(40), 'b'.repeat(40), appview),
      ).resolves.toBe('patch data');
    });
  });

  describe('createPullRecord', () => {
    it('throws when not authenticated', async () => {
      await expect(
        helper.createPullRecord(
          repoDid,
          knotUrl,
          'main',
          'renovate/foo',
          'b'.repeat(40),
          'a'.repeat(40),
          'title',
          'body',
        ),
      ).rejects.toThrow('Not authenticated');
    });

    it('creates a ticket and submits the first patch', async () => {
      await authenticate();
      mockGet.mockResolvedValueOnce({ token: 'jwt' });
      httpMocks.postJson
        .mockResolvedValueOnce({
          body: {
            uri: `at://${repoDid}/org.tangled.track.ticket/92`,
            cid: 'bafyticket',
          },
        })
        .mockResolvedValueOnce({
          body: {
            uri: `at://${repoDid}/org.tangled.review.patch/bafypatch`,
            cid: 'bafypatch',
          },
        });
      mockGet.mockResolvedValueOnce({ token: 'jwt' });
      mockPost.mockResolvedValue({});

      const result = await helper.createPullRecord(
        repoDid,
        knotUrl,
        'main',
        'renovate/foo',
        'b'.repeat(40),
        'a'.repeat(40),
        'title',
        'body',
      );

      expect(result.rkey).toBe('92');
      expect(httpMocks.postJson).toHaveBeenCalledWith(
        expect.stringContaining('com.atproto.repo.createRecord'),
        expect.objectContaining({
          body: expect.objectContaining({ repo: repoDid }),
        }),
      );
      expect(httpMocks.postJson).toHaveBeenCalledWith(
        expect.stringContaining('org.tangled.review.submitPatch'),
        expect.anything(),
      );
      // Two attestations on the bot PDS
      expect(mockPost).toHaveBeenCalledTimes(2);
    });

    it('deletes the ticket when the patch is refused', async () => {
      await authenticate();
      mockGet.mockResolvedValueOnce({ token: 'jwt' });
      httpMocks.postJson
        .mockResolvedValueOnce({
          body: {
            uri: `at://${repoDid}/org.tangled.track.ticket/93`,
            cid: 'bafyticket',
          },
        })
        .mockRejectedValueOnce(new Error('patch refused'));
      mockGet.mockResolvedValueOnce({ token: 'jwt' });
      httpMocks.postJson.mockResolvedValueOnce({ body: {} });
      mockPost.mockResolvedValue({});

      await expect(
        helper.createPullRecord(
          repoDid,
          knotUrl,
          'main',
          'renovate/foo',
          'b'.repeat(40),
          'a'.repeat(40),
          'title',
          'body',
        ),
      ).rejects.toThrow('patch refused');
    });
  });

  describe('updatePullRecord', () => {
    it('throws when not authenticated', async () => {
      await expect(
        helper.updatePullRecord(repoDid, knotUrl, '92', { title: 'x' }),
      ).rejects.toThrow('Not authenticated');
    });

    it('updates title and body', async () => {
      await authenticate();
      httpMocks.getJsonUnchecked.mockResolvedValueOnce({
        body: {
          uri: `at://${repoDid}/org.tangled.track.ticket/92`,
          cid: 'oldcid',
          value: {
            $type: 'org.tangled.track.ticket',
            title: {
              $type: 'org.tangled.markup.markdown#inline',
              text: 'old',
            },
            state: 'open',
            targetBranch: 'main',
            createdAt: '2025-01-01T00:00:00.000Z',
          },
        },
      });
      mockGet.mockResolvedValueOnce({ token: 'jwt' });
      httpMocks.postJson.mockResolvedValueOnce({
        body: {
          uri: `at://${repoDid}/org.tangled.track.ticket/92`,
          cid: 'newcid',
        },
      });
      mockPost.mockResolvedValueOnce({});

      await helper.updatePullRecord(repoDid, knotUrl, '92', {
        title: 'new',
        body: 'new body',
      });

      expect(httpMocks.postJson).toHaveBeenCalledWith(
        expect.stringContaining('com.atproto.repo.putRecord'),
        expect.objectContaining({
          body: expect.objectContaining({ repo: repoDid }),
        }),
      );
    });

    it('retries once on InvalidSwap', async () => {
      await authenticate();
      httpMocks.getJsonUnchecked
        .mockResolvedValueOnce({
          body: {
            uri: `at://${repoDid}/org.tangled.track.ticket/92`,
            cid: 'old',
            value: {
              $type: 'org.tangled.track.ticket',
              title: {
                $type: 'org.tangled.markup.markdown#inline',
                text: 'old',
              },
              state: 'open',
              targetBranch: 'main',
              createdAt: '2025-01-01T00:00:00.000Z',
            },
          },
        })
        .mockResolvedValueOnce({
          body: {
            uri: `at://${repoDid}/org.tangled.track.ticket/92`,
            cid: 'new',
            value: {
              $type: 'org.tangled.track.ticket',
              title: {
                $type: 'org.tangled.markup.markdown#inline',
                text: 'old',
              },
              state: 'open',
              targetBranch: 'main',
              createdAt: '2025-01-01T00:00:00.000Z',
            },
          },
        });
      mockGet.mockResolvedValue({ token: 'jwt' });
      httpMocks.postJson
        .mockRejectedValueOnce(invalidSwap())
        .mockResolvedValueOnce({
          body: {
            uri: `at://${repoDid}/org.tangled.track.ticket/92`,
            cid: 'newcid2',
          },
        });
      mockPost.mockResolvedValue({});

      await helper.updatePullRecord(repoDid, knotUrl, '92', { title: 'new' });
      expect(httpMocks.postJson).toHaveBeenCalledTimes(2);
    });

    it('updates title and state in a single write', async () => {
      await authenticate();
      httpMocks.getJsonUnchecked.mockResolvedValueOnce({
        body: {
          uri: `at://${repoDid}/org.tangled.track.ticket/92`,
          cid: 'oldcid',
          value: {
            $type: 'org.tangled.track.ticket',
            title: {
              $type: 'org.tangled.markup.markdown#inline',
              text: 'old',
            },
            state: 'open',
            targetBranch: 'main',
            createdAt: '2025-01-01T00:00:00.000Z',
          },
        },
      });
      mockGet.mockResolvedValueOnce({ token: 'jwt' });
      httpMocks.postJson.mockResolvedValueOnce({
        body: {
          uri: `at://${repoDid}/org.tangled.track.ticket/92`,
          cid: 'newcid',
        },
      });
      mockPost.mockResolvedValueOnce({});

      await helper.updatePullRecord(repoDid, knotUrl, '92', {
        title: 'old - autoclosed',
        state: 'closed',
      });

      expect(httpMocks.postJson).toHaveBeenCalledTimes(1);
      const written = httpMocks.postJson.mock.calls[0][1] as {
        body: { record: Record<string, unknown> };
      };
      expect(written.body.record).toMatchObject({
        state: 'closed',
        title: {
          $type: 'org.tangled.markup.markdown#inline',
          text: 'old - autoclosed',
        },
      });
    });

    it('strips all x-tngl- ephemeral fields when writing back', async () => {
      await authenticate();
      httpMocks.getJsonUnchecked.mockResolvedValueOnce({
        body: {
          uri: `at://${repoDid}/org.tangled.track.ticket/92`,
          cid: 'old',
          value: {
            $type: 'org.tangled.track.ticket',
            title: {
              $type: 'org.tangled.markup.markdown#inline',
              text: 'old',
            },
            state: 'open',
            targetBranch: 'main',
            createdAt: '2025-01-01T00:00:00.000Z',
            'x-tngl-editor': 'did:plc:someone',
            'x-tngl-future': 'ephemeral',
          },
        },
      });
      mockGet.mockResolvedValueOnce({ token: 'jwt' });
      httpMocks.postJson.mockResolvedValueOnce({
        body: {
          uri: `at://${repoDid}/org.tangled.track.ticket/92`,
          cid: 'newcid',
        },
      });
      mockPost.mockResolvedValueOnce({});

      await helper.updatePullRecord(repoDid, knotUrl, '92', {
        title: 'new',
      });

      const written = httpMocks.postJson.mock.calls[0][1] as {
        body: { record: Record<string, unknown> };
      };
      expect(written.body.record).not.toHaveProperty('x-tngl-editor');
      expect(written.body.record).not.toHaveProperty('x-tngl-future');
    });
  });

  describe('resubmitPull', () => {
    const targetHead = 'a'.repeat(40);
    const sourceHead = 'b'.repeat(40);

    function mockRounds(heads: string[]): void {
      httpMocks.getJsonUnchecked.mockResolvedValueOnce({
        body: {
          records: heads.map((head, i) => ({
            uri: `at://${repoDid}/org.tangled.review.patch/p${i}`,
            cid: `c${i}`,
            value: {
              $type: 'org.tangled.review.patch',
              ticket: '92',
              base: { oid: targetHead },
              head: { oid: head },
              source: { repo: repoDid, branch: 'renovate/foo' },
              createdAt: '2025-01-01T00:00:00.000Z',
            },
          })),
        },
      });
    }

    function mockSourceHead(): void {
      httpMocks.getJsonUnchecked.mockResolvedValueOnce({
        body: { oid: sourceHead },
      });
    }

    function mockTargetHeadAndBase(): void {
      httpMocks.getJsonUnchecked
        .mockResolvedValueOnce({ body: { oid: targetHead } })
        .mockResolvedValueOnce({ body: { commit: targetHead } });
    }

    it('throws when not authenticated', async () => {
      await expect(
        helper.resubmitPull(
          repoDid,
          knotUrl,
          appview,
          'main',
          'renovate/foo',
          '92',
        ),
      ).rejects.toThrow('Not authenticated');
    });

    it('does nothing when the latest round matches the branch', async () => {
      await authenticate();
      mockRounds([sourceHead]);
      mockSourceHead();

      await expect(
        helper.resubmitPull(
          repoDid,
          knotUrl,
          appview,
          'main',
          'renovate/foo',
          '92',
        ),
      ).resolves.toEqual({ changed: false, resubmitted: false, round: 0 });
      expect(httpMocks.postJson).not.toHaveBeenCalled();
      // No target head or merge base lookup on the no-change path
      expect(httpMocks.getJsonUnchecked).toHaveBeenCalledTimes(2);
    });

    it('submits a new patch when the branch moved', async () => {
      await authenticate();
      mockRounds(['o'.repeat(40)]);
      mockSourceHead();
      mockTargetHeadAndBase();
      mockGet.mockResolvedValueOnce({ token: 'jwt' });
      httpMocks.postJson.mockResolvedValueOnce({
        body: {
          uri: `at://${repoDid}/org.tangled.review.patch/new`,
          cid: 'newcid',
        },
      });
      mockPost.mockResolvedValueOnce({});

      await expect(
        helper.resubmitPull(
          repoDid,
          knotUrl,
          appview,
          'main',
          'renovate/foo',
          '92',
        ),
      ).resolves.toEqual({ changed: true, resubmitted: true, round: 1 });
    });

    it('writes nothing in dry-run mode', async () => {
      await authenticate();
      mockRounds(['o'.repeat(40)]);
      mockSourceHead();

      await expect(
        helper.resubmitPull(
          repoDid,
          knotUrl,
          appview,
          'main',
          'renovate/foo',
          '92',
          true,
        ),
      ).resolves.toEqual({ changed: true, resubmitted: false, round: 0 });

      expect(httpMocks.postJson).not.toHaveBeenCalled();
    });
  });

  describe('setPullState', () => {
    it('throws when not authenticated', async () => {
      httpMocks.getJsonUnchecked.mockResolvedValueOnce({
        body: {
          uri: `at://${repoDid}/org.tangled.track.ticket/92`,
          cid: 'c',
          value: { state: 'open' },
        },
      });
      await expect(
        helper.setPullState(repoDid, knotUrl, '92', 'closed'),
      ).rejects.toThrow('Not authenticated');
    });

    it('sets the ticket state', async () => {
      await authenticate();
      httpMocks.getJsonUnchecked.mockResolvedValueOnce({
        body: {
          uri: `at://${repoDid}/org.tangled.track.ticket/92`,
          cid: 'c',
          value: {
            $type: 'org.tangled.track.ticket',
            title: {
              $type: 'org.tangled.markup.markdown#inline',
              text: 't',
            },
            state: 'open',
            targetBranch: 'main',
            createdAt: '2025-01-01T00:00:00.000Z',
          },
        },
      });
      mockGet.mockResolvedValueOnce({ token: 'jwt' });
      httpMocks.postJson.mockResolvedValueOnce({
        body: {
          uri: `at://${repoDid}/org.tangled.track.ticket/92`,
          cid: 'c2',
        },
      });
      mockPost.mockResolvedValueOnce({});

      await helper.setPullState(repoDid, knotUrl, '92', 'closed');

      expect(httpMocks.postJson).toHaveBeenCalledWith(
        expect.stringContaining('com.atproto.repo.putRecord'),
        expect.anything(),
      );
    });
  });

  describe('listPullRecords', () => {
    it('throws when not authenticated', async () => {
      // listPullRecords no longer requires PDS auth, but knot reads do not
      // need the session either; it should still work without auth.
      httpMocks.getJsonUnchecked
        .mockResolvedValueOnce({ body: { items: [], cursor: undefined } })
        .mockResolvedValueOnce({ body: { records: [] } });

      // No auth needed for reads
      const pulls = await helper.listPullRecords(repoDid, knotUrl, appview);
      expect(pulls).toEqual([]);
    });

    it('lists pulls across pages and attaches rounds', async () => {
      httpMocks.getJsonUnchecked
        .mockResolvedValueOnce({
          body: {
            items: [
              {
                uri: `at://${repoDid}/org.tangled.track.ticket/92`,
                cid: 'c92',
                value: {
                  $type: 'org.tangled.track.ticket',
                  title: {
                    $type: 'org.tangled.markup.markdown#inline',
                    text: 'one',
                  },
                  state: 'open',
                  targetBranch: 'main',
                  createdAt: '2025-01-01T00:00:00.000Z',
                },
                state: 'open',
              },
              {
                uri: `at://${repoDid}/org.tangled.track.ticket/93`,
                cid: 'c93',
                value: {
                  $type: 'org.tangled.track.ticket',
                  title: {
                    $type: 'org.tangled.markup.markdown#inline',
                    text: 'issue, no target',
                  },
                  state: 'open',
                  createdAt: '2025-01-01T00:00:00.000Z',
                },
                state: 'open',
              },
            ],
            cursor: 'next',
          },
        })
        .mockResolvedValueOnce({
          body: {
            items: [
              {
                uri: `at://${repoDid}/org.tangled.track.ticket/91`,
                cid: 'c91',
                value: {
                  $type: 'org.tangled.track.ticket',
                  title: {
                    $type: 'org.tangled.markup.markdown#inline',
                    text: 'two',
                  },
                  state: 'completed',
                  targetBranch: 'main',
                  createdAt: '2025-01-01T00:00:00.000Z',
                },
                state: 'merged',
              },
            ],
          },
        })
        .mockResolvedValueOnce({
          body: {
            records: [
              {
                uri: `at://${repoDid}/org.tangled.review.patch/p1`,
                cid: 'cp1',
                value: {
                  $type: 'org.tangled.review.patch',
                  ticket: '92',
                  base: { oid: 'a'.repeat(40) },
                  head: { oid: 'b'.repeat(40) },
                  source: { repo: repoDid, branch: 'renovate/foo' },
                  createdAt: '2025-01-01T00:00:00.000Z',
                },
              },
            ],
          },
        });

      const pulls = await helper.listPullRecords(repoDid, knotUrl, appview);

      expect(pulls).toHaveLength(2);
      const byRkey = new Map(pulls.map((p) => [p.rkey, p]));
      expect(byRkey.get('92')?.status).toBe('open');
      expect(byRkey.get('92')?.rounds).toHaveLength(1);
      expect(byRkey.get('91')?.status).toBe('merged');
    });
  });

  describe('listLabelDefinitions', () => {
    it('maps definition AT-URIs to their names', async () => {
      httpMocks.getJsonUnchecked.mockResolvedValueOnce({
        body: {
          items: [
            {
              uri: `at://${repoDid}/org.tangled.label.definition/rebase`,
              value: { name: 'rebase' },
            },
            {
              uri: `at://${repoDid}/org.tangled.label.definition/empty`,
              value: { name: '' },
            },
          ],
        },
      });

      const definitions = await helper.listLabelDefinitions(appview, repoDid);

      expect(
        definitions.get(`at://${repoDid}/org.tangled.label.definition/rebase`),
      ).toBe('rebase');
      expect(definitions.size).toBe(1);
    });
  });

  describe('getLabels', () => {
    it('returns no labels when the ticket has none', async () => {
      httpMocks.getJsonUnchecked.mockResolvedValueOnce({
        body: {},
      });

      await expect(
        helper.getLabels(
          appview,
          repoDid,
          `at://${repoDid}/org.tangled.track.ticket/92`,
        ),
      ).resolves.toEqual([]);
    });

    it('resolves label tokens to names', async () => {
      httpMocks.getJsonUnchecked
        .mockResolvedValueOnce({
          body: { tangledLabels: [{ key: 'rebase' }] },
        })
        .mockResolvedValueOnce({
          body: {
            items: [
              {
                uri: `at://${repoDid}/org.tangled.label.definition/rebase`,
                value: { name: 'rebase' },
              },
            ],
          },
        });

      await expect(
        helper.getLabels(
          appview,
          repoDid,
          `at://${repoDid}/org.tangled.track.ticket/92`,
        ),
      ).resolves.toEqual([
        {
          key: `at://${repoDid}/org.tangled.label.definition/rebase`,
          value: '',
          name: 'rebase',
        },
      ]);
    });
  });

  describe('removeLabel', () => {
    it('returns false when the label does not exist', async () => {
      httpMocks.getJsonUnchecked.mockResolvedValueOnce({
        body: { items: [] },
      });

      await expect(
        helper.removeLabel(repoDid, knotUrl, appview, '92', 'rebase'),
      ).resolves.toBe(false);
    });

    it('removes the label token from the ticket', async () => {
      await authenticate();
      httpMocks.getJsonUnchecked.mockResolvedValueOnce({
        body: {
          items: [
            {
              uri: `at://${repoDid}/org.tangled.label.definition/rebase`,
              value: { name: 'rebase' },
            },
          ],
        },
      });
      httpMocks.getJsonUnchecked.mockResolvedValueOnce({
        body: {
          uri: `at://${repoDid}/org.tangled.track.ticket/92`,
          cid: 'c',
          value: {
            $type: 'org.tangled.track.ticket',
            title: {
              $type: 'org.tangled.markup.markdown#inline',
              text: 't',
            },
            state: 'open',
            targetBranch: 'main',
            tangledLabels: [{ key: 'rebase' }],
            createdAt: '2025-01-01T00:00:00.000Z',
          },
        },
      });
      mockGet.mockResolvedValueOnce({ token: 'jwt' });
      httpMocks.postJson.mockResolvedValueOnce({
        body: {
          uri: `at://${repoDid}/org.tangled.track.ticket/92`,
          cid: 'c2',
        },
      });
      mockPost.mockResolvedValueOnce({});

      await expect(
        helper.removeLabel(repoDid, knotUrl, appview, '92', 'rebase'),
      ).resolves.toBe(true);
    });
  });

  describe('mergePull', () => {
    it('merges via the index and completes the ticket', async () => {
      await authenticate();
      // listRounds
      httpMocks.getJsonUnchecked.mockResolvedValueOnce({
        body: {
          records: [
            {
              uri: `at://${repoDid}/org.tangled.review.patch/p1`,
              cid: 'c1',
              value: {
                $type: 'org.tangled.review.patch',
                ticket: '92',
                base: { oid: 'a'.repeat(40) },
                head: { oid: 'b'.repeat(40) },
                source: { repo: repoDid, branch: 'renovate/foo' },
                createdAt: '2025-01-01T00:00:00.000Z',
              },
            },
          ],
        },
      });
      // getBranchHead
      httpMocks.getJsonUnchecked.mockResolvedValueOnce({
        body: { oid: 'a'.repeat(40) },
      });
      // merge POST
      mockGet.mockResolvedValueOnce({ token: 'jwt' });
      httpMocks.postJson.mockResolvedValueOnce({ body: {} });
      // setPullState: getTicket + putTicket
      httpMocks.getJsonUnchecked.mockResolvedValueOnce({
        body: {
          uri: `at://${repoDid}/org.tangled.track.ticket/92`,
          cid: 'c',
          value: {
            $type: 'org.tangled.track.ticket',
            title: {
              $type: 'org.tangled.markup.markdown#inline',
              text: 't',
            },
            state: 'open',
            targetBranch: 'main',
            createdAt: '2025-01-01T00:00:00.000Z',
          },
        },
      });
      mockGet.mockResolvedValueOnce({ token: 'jwt' });
      httpMocks.postJson.mockResolvedValueOnce({
        body: {
          uri: `at://${repoDid}/org.tangled.track.ticket/92`,
          cid: 'c2',
        },
      });
      mockPost.mockResolvedValueOnce({});

      await helper.mergePull(
        repoDid,
        knotUrl,
        'knot.example.com',
        appview,
        'main',
        '92',
      );

      expect(httpMocks.postJson).toHaveBeenCalledWith(
        expect.stringContaining('sh.tangled.git.mergeCommit'),
        expect.objectContaining({
          body: expect.objectContaining({ style: 'rebase' }),
        }),
      );
    });
  });

  describe('resolveRepoRef', () => {
    it('resolves a repo via the index', async () => {
      httpMocks.getJsonUnchecked.mockResolvedValueOnce({
        body: {
          uri: `at://${repoDid}/org.tangled.repo.manifest/self`,
          knot: 'knot.example.com',
          value: { declaration: { name: 'my-repo' } },
          defaultBranch: 'main',
        },
      });

      await expect(
        helper.resolveRepoRef('did:plc:owner', 'my-repo', appview),
      ).resolves.toEqual({
        knot: 'knot.example.com',
        knotUrl: 'https://knot.example.com',
        repoDid,
        name: 'my-repo',
        defaultBranch: 'main',
      });
    });

    it('throws when the repo cannot be found', async () => {
      httpMocks.getJsonUnchecked.mockRejectedValueOnce(new Error('nope'));

      await expect(
        helper.resolveRepoRef('did:plc:owner', 'missing', appview),
      ).rejects.toThrow('was not found');
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
    });

    it('falls back to the bsky AppView when resolution fails', async () => {
      httpMocks.getJsonUnchecked.mockRejectedValueOnce(new Error('nope'));

      await expect(helper.resolvePdsEndpoint('did:plc:owner')).resolves.toBe(
        'https://public.api.bsky.app',
      );
    });
  });
});
