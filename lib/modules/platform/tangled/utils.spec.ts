import type { TangledPull } from './types.ts';
import { rkeyFromUri, tidToNumber, toRenovatePr } from './utils.ts';

describe('modules/platform/tangled/utils', () => {
  describe('tidToNumber', () => {
    it('converts a TID to a stable number', () => {
      const tid = '3lbvg3wn2cs2i';
      const result = tidToNumber(tid);
      expect(typeof result).toBe('number');
      expect(result).toBeGreaterThan(0);
      expect(Number.isSafeInteger(result)).toBe(true);
    });

    it('returns different numbers for different TIDs', () => {
      // These TIDs differ in higher-order bits (beyond the 10-bit clock ID)
      const a = tidToNumber('3lbvg3wn2cs2i');
      const b = tidToNumber('3lbvg3wn2ct2i');
      expect(a).not.toBe(b);
    });

    it('returns the same number for the same TID regardless of clock ID', () => {
      // TIDs that differ only in the lower 10 bits (clock ID)
      // should map to the same number after right-shifting by 10
      // Construct two TIDs that differ only in the last 2 base-32 chars
      // (10 bits = 2 base-32 digits)
      const base = '3lbvg3wn2cs';
      const a = tidToNumber(`${base}22`);
      const b = tidToNumber(`${base}23`);
      // They share the upper bits so after >> 10 they should be equal
      expect(a).toBe(b);
    });

    it('handles minimum TID', () => {
      const result = tidToNumber('2222222222222');
      expect(result).toBe(0);
    });
  });

  describe('rkeyFromUri', () => {
    it('extracts rkey from AT-URI', () => {
      expect(
        rkeyFromUri('at://did:plc:abc123/sh.tangled.repo.pull/3lbvg3wn2cs2i'),
      ).toBe('3lbvg3wn2cs2i');
    });

    it('handles URI with trailing slash', () => {
      expect(rkeyFromUri('at://did:plc:abc123/collection/')).toBe('');
    });
  });

  describe('toRenovatePr', () => {
    const basePull: TangledPull = {
      uri: 'at://did:plc:bot/sh.tangled.repo.pull/3lbvg3wn2cs2i',
      cid: 'bafyreiabc123',
      rkey: '3lbvg3wn2cs2i',
      record: {
        $type: 'sh.tangled.repo.pull',
        title: 'Update dependency foo to v2',
        body: 'This PR updates foo.',
        target: {
          repo: 'did:plc:repo123' as any,
          branch: 'main',
        },
        source: {
          branch: 'renovate/foo-2.x',
          repo: undefined as any,
        },
        rounds: [
          {
            patchBlob: {
              ref: { $link: 'bafyref123' },
              mimeType: 'application/gzip',
              size: 1024,
            } as any,
            createdAt: '2025-01-01T00:00:00.000Z',
          },
        ],
        createdAt: '2025-01-01T00:00:00.000Z',
      },
      status: 'open',
    };

    it('converts an open pull to a Renovate Pr', () => {
      const pr = toRenovatePr(basePull);
      expect(pr).not.toBeNull();
      expect(pr!.state).toBe('open');
      expect(pr!.title).toBe('Update dependency foo to v2');
      expect(pr!.sourceBranch).toBe('renovate/foo-2.x');
      expect(pr!.targetBranch).toBe('main');
      expect(pr!.createdAt).toBe('2025-01-01T00:00:00.000Z');
      expect(pr!.number).toBe(tidToNumber('3lbvg3wn2cs2i'));
    });

    it('converts a closed pull', () => {
      const pr = toRenovatePr({ ...basePull, status: 'closed' });
      expect(pr).not.toBeNull();
      expect(pr!.state).toBe('closed');
    });

    it('converts a merged pull', () => {
      const pr = toRenovatePr({ ...basePull, status: 'merged' });
      expect(pr).not.toBeNull();
      expect(pr!.state).toBe('merged');
    });

    it('returns null when source branch is missing', () => {
      const pull: TangledPull = {
        ...basePull,
        record: {
          ...basePull.record,
          source: { branch: '', repo: undefined as any },
        },
      };
      const pr = toRenovatePr(pull);
      expect(pr).toBeNull();
    });

    it('returns null when target branch is missing', () => {
      const pull: TangledPull = {
        ...basePull,
        record: {
          ...basePull.record,
          target: { repo: 'did:plc:repo' as any, branch: '' },
        },
      };
      const pr = toRenovatePr(pull);
      expect(pr).toBeNull();
    });

    it('extracts sha from the last round patchBlob ref', () => {
      const pr = toRenovatePr(basePull);
      expect(pr!.sha).toBe('bafyref123');
    });

    it('includes sourceRepo from pull record', () => {
      const pullWithSourceRepo: TangledPull = {
        ...basePull,
        record: {
          ...basePull.record,
          source: {
            branch: 'renovate/foo-2.x',
            repo: 'did:plc:forkrepo' as any,
          },
        },
      };
      const pr = toRenovatePr(pullWithSourceRepo);
      expect(pr!.sourceRepo).toBe('did:plc:forkrepo');
    });
  });
});
