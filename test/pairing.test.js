import { describe, expect, it } from 'vitest';
import { VERIFY_URL } from '../src/constants.js';
import { safeVerifyUrl } from '../src/pairing.js';

const BASE = 'https://app.d20-loot-tracker.com/api/foundry';

describe('approval link', () => {
  it('keeps an https link on the app origin', () => {
    expect(safeVerifyUrl('https://app.d20-loot-tracker.com/foundry?code=ABCD-EFGH', BASE))
      .toBe('https://app.d20-loot-tracker.com/foundry?code=ABCD-EFGH');
  });

  it('allows the origin of the configured server', () => {
    expect(safeVerifyUrl('https://staging.example.test/foundry', 'https://staging.example.test/api/foundry'))
      .toBe('https://staging.example.test/foundry');
  });

  it('falls back to the app link for other origins, other schemes and junk', () => {
    for (const url of ['javascript:alert(1)', 'http://app.d20-loot-tracker.com/foundry', 'https://example.test/foundry', 'not a url', '', undefined]) {
      expect(safeVerifyUrl(url, BASE)).toBe(VERIFY_URL);
    }
  });
});
