import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { VERSION } from '../src/index.ts';

describe('placeholder', () => {
  it('exports VERSION string', () => {
    assert.equal(typeof VERSION, 'string');
  });
});
