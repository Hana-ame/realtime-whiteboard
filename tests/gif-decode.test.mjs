/**
 * Tests for src/js/gif.js — pure-JS animated-GIF frame decoder.
 *
 * Validates structure, error handling, and basic pixel content.
 * Full pixel-level comparison against PIL ground truth is done by
 * /tmp/giftest/compare.mjs.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  GIF_DATA_PREFIX,
  dataUrlToBytes,
  lzwDecode,
  parseGif,
  decodeGifFrames,
} from '../src/js/gif.js';

const HERE = '/tmp/giftest';

function loadAsset(name) {
  return readFileSync(`${HERE}/${name}.gif`);
}

function toDataURL(bytes) {
  return `data:image/gif;base64,${Buffer.from(bytes).toString('base64')}`;
}

function allPixels(buf, r, g, b, a = 255) {
  for (let i = 0; i < buf.length; i += 4) {
    if (buf[i] !== r || buf[i + 1] !== g || buf[i + 2] !== b || buf[i + 3] !== a)
      return false;
  }
  return true;
}

// ── dataUrlToBytes ──────────────────────────────────────────────────────────

describe('dataUrlToBytes', () => {
  test('decodes base64 payload', () => {
    const bin = Buffer.from('GIF89a\x01\x00\x01\x00\x80\x00\x00\x00\x00\x00\xff\xff\xff\x00\x00\x00\x2c\x01\x00\x00\x00\x01\x00\x01\x00\x00\x02\x02\x44\x01\x00\x3b').toString('binary');
    const b64 = Buffer.from(bin, 'binary').toString('base64');
    const result = dataUrlToBytes(`data:image/gif;base64,${b64}`);
    assert.equal(result[0], 0x47);
    assert.equal(result[1], 0x49);
    assert.equal(result[2], 0x46);
  });

  test('decodes percent-encoded payload', () => {
    const hex = '474946383961';
    const pct = Buffer.from(hex, 'hex').toString('binary').split('').map(c => '%' + c.charCodeAt(0).toString(16)).join('');
    const result = dataUrlToBytes(`data:image/gif,${pct}`);
    assert.equal(result[0], 0x47);
    assert.equal(result[1], 0x49);
  });

  test('throws on non-data URL', () => {
    assert.throws(() => dataUrlToBytes('not a data url'));
  });
});

// ── lzwDecode ──────────────────────────────────────────────────────────────

describe('lzwDecode', () => {
  test('decodes all-zeros stream (minCodeSize=2)', () => {
    const basic = loadAsset('basic');
    let p = 6 + 7 + 24;
    if (basic[p] === 0x21 && basic[p + 1] === 0xff) { p += 2; while (basic[p] > 0) { p += 1 + basic[p]; } p++; }
    if (basic[p] === 0x21 && basic[p + 1] === 0xf9) { p += 2; while (basic[p] > 0) { p += 1 + basic[p]; } p++; }
    if (basic[p] === 0x2c) {
      p += 10; // 0x2c + 2+2+2+2+1 bytes
      const mc = basic[p++];
      const data = [];
      while (basic[p] > 0) { const sz = basic[p]; data.push(...Array.from(basic.slice(p + 1, p + 1 + sz))); p += 1 + sz; }
      const indices = lzwDecode(mc, new Uint8Array(data));
      assert.equal(indices.length, 64);
      assert.ok(indices.every(v => v === 0), 'all 64 indices should be 0');
    }
  });

  test('handles EOI correctly', () => {
    // CLEAR, 0, 1, EOI → [0, 1]
    const result = lzwDecode(2, new Uint8Array([68, 10]));
    assert.deepEqual(result, [0, 1]);
  });

  test('returns empty array for empty input', () => {
    assert.deepEqual(lzwDecode(2, new Uint8Array(0)), []);
  });

  test('handles truncated stream gracefully', () => {
    const result = lzwDecode(2, new Uint8Array([4]));
    assert.ok(Array.isArray(result));
  });
});

// ── parseGif ───────────────────────────────────────────────────────────────

describe('parseGif', () => {
  test('basic: two solid frames, global palette', () => {
    const result = parseGif(new Uint8Array(loadAsset('basic')));
    assert.equal(result.width, 8);
    assert.equal(result.height, 8);
    assert.equal(result.frames.length, 2);
    assert.equal(result.durations.length, 2);
    assert.equal(result.frames[0].length, 8 * 8 * 4);
    assert.equal(result.frames[1].length, 8 * 8 * 4);
    assert.ok(allPixels(result.frames[0], 255, 0, 0));
    assert.ok(allPixels(result.frames[1], 0, 0, 255));
    assert.equal(result.durations[0], 100);
    assert.equal(result.durations[1], 100);
  });

  test('interlace: correct dimensions and frame count', () => {
    const result = parseGif(new Uint8Array(loadAsset('interlace')));
    assert.equal(result.width, 8);
    assert.equal(result.height, 16);
    assert.equal(result.frames.length, 2);
    assert.equal(result.frames[0].length, 8 * 16 * 4);
  });

  test('transparency: frame count and structure', () => {
    const result = parseGif(new Uint8Array(loadAsset('transp')));
    assert.equal(result.frames.length, 2);
    assert.ok(allPixels(result.frames[0], 255, 0, 0));
  });

  test('disposal2: frame count and structure', () => {
    const result = parseGif(new Uint8Array(loadAsset('disposal2')));
    assert.equal(result.frames.length, 3);
  });

  test('disposal3: frame count and structure', () => {
    const result = parseGif(new Uint8Array(loadAsset('disposal3')));
    assert.equal(result.frames.length, 4);
  });

  test('local colour table: frame count and structure', () => {
    const result = parseGif(new Uint8Array(loadAsset('lct')));
    assert.equal(result.frames.length, 2);
    assert.ok(allPixels(result.frames[0], 255, 0, 0));
  });

  test('subimg: frame count and structure', () => {
    const result = parseGif(new Uint8Array(loadAsset('subimg')));
    assert.equal(result.frames.length, 3);
  });

  test('mincode2: small min code size', () => {
    const result = parseGif(new Uint8Array(loadAsset('mincode2')));
    assert.equal(result.width, 4);
    assert.equal(result.height, 4);
    assert.equal(result.frames.length, 1);
    assert.equal(result.frames[0].length, 4 * 4 * 4);
  });

  test('throws on non-GIF data', () => {
    assert.throws(() => parseGif(new Uint8Array([1, 2, 3])));
    assert.throws(() => parseGif(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x78, 0x61])));
  });

  test('throws on truncated GIF', () => {
    assert.throws(() => parseGif(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])));
  });
});

// ── decodeGifFrames ────────────────────────────────────────────────────────

describe('decodeGifFrames', () => {
  test('decodes a basic GIF via data: URL', async () => {
    const url = toDataURL(loadAsset('basic'));
    const result = await decodeGifFrames(url);
    assert.ok(result);
    assert.equal(result.frames.length, 2);
    assert.equal(result.width, 8);
    assert.equal(result.height, 8);
  });

  test('returns null for non-GIF data URL', async () => {
    const result = await decodeGifFrames('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+h/n8Hgf8fPwD+0N5j1gAAAAZJREFUeNpiYvz/XwAGFQ4q30e1iQAAAABJRU5ErkJggg==');
    assert.equal(result, null);
  });

  test('returns null for empty URL', async () => {
    assert.equal(await decodeGifFrames(null), null);
    assert.equal(await decodeGifFrames(''), null);
  });

  test('returns null for malformed GIF', async () => {
    assert.equal(await decodeGifFrames('data:image/gif;base64,AAA'), null);
  });
});

// ── end-to-end: all assets parse without errors ───────────────────────────

describe('end-to-end: all assets parse', () => {
  const assets = ['basic', 'interlace', 'transp', 'disposal2', 'disposal3', 'lct', 'subimg', 'mincode2'];

  for (const name of assets) {
    test(`${name}: parses without error`, () => {
      const result = parseGif(new Uint8Array(loadAsset(name)));
      assert.ok(result.frames.length > 0);
      for (let i = 0; i < result.frames.length; i++) {
        assert.equal(result.frames[i].length, result.width * result.height * 4);
      }
    });
  }
});
