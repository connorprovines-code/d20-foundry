import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// ApplicationV2 renders each template part into exactly one HTML element; a second top-level
// element (a trailing <style>, say) makes the whole window fail to render.
const dir = new URL('../templates/', import.meta.url);

describe('templates', () => {
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.hbs'))) {
    it(`${file} renders a single root element`, () => {
      const src = readFileSync(new URL(file, dir), 'utf8').replace(/\{\{!--[\s\S]*?--\}\}/g, '').trim();
      const root = src.match(/^<([a-z]+)[\s>]/i)?.[1];
      expect(root).toBeTruthy();
      expect(src.endsWith(`</${root}>`)).toBe(true);
      expect(src.match(new RegExp(`<${root}[\\s>]`, 'g'))).toHaveLength(1);
      expect(src).not.toMatch(/<style[\s>]/i);
    });
  }
});
