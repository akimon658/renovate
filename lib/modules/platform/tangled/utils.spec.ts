import { partial } from '../../../../test/util.ts';
import { getPrBodyStruct } from '../pr-body.ts';
import type { TangledPull } from './types.ts';
import {
  rkeyFromUri,
  ticketNumberToPrNumber,
  tidToNumber,
  toRenovatePr,
} from './utils.ts';

function ticketRecord(overrides: Record<string, unknown> = {}): any {
  return {
    $type: 'org.tangled.track.ticket',
    title: {
      $type: 'org.tangled.markup.markdown#inline',
      text: 'Update dependency foo to v2',
    },
    body: {
      $type: 'org.tangled.markup.markdown',
      text: 'This PR updates foo.',
    },
    state: 'open',
    targetBranch: 'main',
    createdAt: '2025-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function patchRound(overrides: Record<string, unknown> = {}): any {
  return {
    $type: 'org.tangled.review.patch',
    ticket: '92',
    base: { oid: 'a'.repeat(40) },
    head: { oid: 'b'.repeat(40) },
    source: {
      repo: 'did:plc:repo',
      branch: 'renovate/foo-2.x',
    },
    createdAt: '2025-01-01T00:00:00.000Z',
    ...overrides,
  };
}

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

  describe('ticketNumberToPrNumber', () => {
    it('parses numeric ticket rkeys', () => {
      expect(ticketNumberToPrNumber('1')).toBe(1);
      expect(ticketNumberToPrNumber('92')).toBe(92);
    });

    it('falls back to TID decoding for legacy rkeys', () => {
      expect(ticketNumberToPrNumber('3lbvg3wn2cs2i')).toBe(
        tidToNumber('3lbvg3wn2cs2i'),
      );
    });
  });

  describe('rkeyFromUri', () => {
    it('extracts rkey from AT-URI', () => {
      expect(
        rkeyFromUri('at://did:plc:abc123/org.tangled.track.ticket/92'),
      ).toBe('92');
    });

    it('handles URI with trailing slash', () => {
      expect(rkeyFromUri('at://did:plc:abc123/collection/')).toBe('');
    });
  });

  describe('toRenovatePr', () => {
    const basePull: TangledPull = partial<TangledPull>({
      uri: 'at://did:plc:repo/org.tangled.track.ticket/92',
      cid: 'bafyreicid',
      rkey: '92',
      record: ticketRecord(),
      rounds: [patchRound()],
      status: 'open',
    });

    it('converts an open pull to a Renovate Pr', () => {
      const pr = toRenovatePr(basePull);
      expect(pr).not.toBeNull();
      expect(pr!.state).toBe('open');
      expect(pr!.title).toBe('Update dependency foo to v2');
      expect(pr!.sourceBranch).toBe('renovate/foo-2.x');
      expect(pr!.targetBranch).toBe('main');
      expect(pr!.createdAt).toBe('2025-01-01T00:00:00.000Z');
      expect(pr!.number).toBe(92);
    });

    it('converts a closed pull', () => {
      const pr = toRenovatePr(
        partial<TangledPull>({ ...basePull, status: 'closed' }),
      );
      expect(pr).not.toBeNull();
      expect(pr!.state).toBe('closed');
    });

    it('converts a merged pull', () => {
      const pr = toRenovatePr(
        partial<TangledPull>({ ...basePull, status: 'merged' }),
      );
      expect(pr).not.toBeNull();
      expect(pr!.state).toBe('merged');
    });

    it('returns null when source branch is missing', () => {
      const pr = toRenovatePr(
        partial<TangledPull>({
          ...basePull,
          record: ticketRecord({ targetBranch: 'main' }),
          rounds: [],
        }),
      );
      expect(pr).toBeNull();
    });

    it('returns null when target branch is missing', () => {
      const pull = partial<TangledPull>({
        ...basePull,
        record: ticketRecord({ targetBranch: undefined }),
      });
      const pr = toRenovatePr(pull);
      expect(pr).toBeNull();
    });

    it('extracts sha from the last round head', () => {
      const pr = toRenovatePr(basePull);
      expect(pr!.sha).toBe('b'.repeat(40));
    });

    it('falls back to an empty body when the record body is missing', () => {
      const pull = partial<TangledPull>({
        ...basePull,
        record: ticketRecord({ body: undefined }),
      });
      const pr = toRenovatePr(pull);
      expect(pr).not.toBeNull();
      expect(pr!.bodyStruct).toEqual(getPrBodyStruct(''));
    });

    it('includes sourceRepo from the latest round', () => {
      const pr = toRenovatePr(basePull);
      expect(pr!.sourceRepo).toBe('did:plc:repo');
    });
  });
});
