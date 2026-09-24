import { beforeEach } from 'vitest';
import { installFoundry } from './foundry.js';

// Every test starts from fresh globals; tests that need another system reinstall.
beforeEach(() => {
  installFoundry();
});
