/**
 * Pure-JS animated-GIF frame decoder.
 *
 * Why this exists
 * ───────────────
 * renderer.js used to pre-decode GIF frames with the WebCodecs `ImageDecoder`
 * API. In Chrome 151+ that API was reworked: `ImageDecoder.track`, `.image`,
 * `.update()` and `.getFrameMetadata()` are gone, replaced by a metadata-only
 * `ImageDecoder.tracks` set (FrameTrackSet/FrameTrack expose frameCount,
 * animated, repetitionCount but no way to select or read a frame). The old code
 * therefore threw `TypeError: Cannot read properties of undefined (reading
 * 'countFrames')`, the catch swallowed it, `gifState[id].frames` stayed null,
 * and every GIF was painted as a static first frame.
 *
 * The `<img>` fallback cannot repair that either: `ctx.drawImage(img)` of an
 * animated image always renders frame 0, never the frame the element is
 * currently displaying. Measured: an `<img>` whose on-screen pixels alternate
 * red→blue→blue→red over 3.6 s still yields `[252,0,0]` from drawImage on every
 * call. So the frames have to be decoded here, straight from the byte stream.
 *
 * The decoder is pure — no DOM — and returns one fully-composited RGBA buffer
 * per frame, which the renderer turns into a canvas via putImageData(). It
 * handles:
 *   • global and per-frame local color tables
 *   • disposal methods 2 (restore to background) and 3 (restore to previous)
 *     applied only to the rectangle the previous sub-image covered
 *   • per-frame transparency
 *   • interlaced images (4-pass row reorder)
 *   • arbitrary sub-image offsets (frames need not cover the logical screen)
 *
 * Frame delays are the GIF Graphic Control Extension delays in centiseconds;
 * values below 3 cs are clamped to 100 ms, matching Chrome's handling of the
 * 0/1/2 cs sentinel values.
 */

export const GIF_DATA_PREFIX = 'data:image/gif';

/**
 * Decode a `data:` URL into bytes.
 * @param {string} dataUrl
 * @returns {Uint8Array}
 */
export function dataUrlToBytes(dataUrl) {
  const comma = dataUrl.indexOf(',');
  if (comma < 0) throw new Error('not a data: URL');
  const meta = dataUrl.slice(0, comma);
  const payload = dataUrl.slice(comma + 1);
  const bin = meta.endsWith(';base64') ? atob(payload) : decodeURIComponent(payload);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i) & 0xff;
  return out;
}

/**
 * LZW-decode one GIF image's compressed data into a flat array of color-table
 * indices. The stream is laid out LSB-first, packed back to back.
 *
 * @param {number} minCodeSize  GIF's LZW minimum code size (1..11, code width)
 * @param {Uint8Array|number[]} data  concatenated sub-block payloads
 * @returns {number[]} pixel indices
 */
export function lzwDecode(minCodeSize, data) {
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  const MAX_CODES = 4096;

  // table[code] = array of indices; gen[] is a generation stamp so a CLEAR code
  // only has to re-initialise the literals instead of clearing 4096 slots.
  const table = new Array(MAX_CODES);
  const gen = new Int32Array(MAX_CODES);
  let stamp = 1;
  let codeSize = minCodeSize + 1;
  let nextCode = eoi + 1;

  const reset = () => {
    stamp++;
    codeSize = minCodeSize + 1;
    nextCode = eoi + 1;
    for (let i = 0; i < clear; i++) { table[i] = [i]; gen[i] = stamp; }
  };
  reset();

  const out = [];
  let prev = -1;
  let entry = null;
  let pos = 0;
  let buf = 0;
  let nBits = 0;

  for (;;) {
    while (nBits < codeSize) {
      if (pos >= data.length) return out;
      buf |= (data[pos++] & 0xff) << nBits;
      nBits += 8;
    }
    const code = buf & ((1 << codeSize) - 1);
    buf >>>= codeSize;
    nBits -= codeSize;

    if (code === clear) { reset(); prev = -1; entry = null; continue; }
    if (code === eoi) break;

    let cur;
    if (prev < 0) {
      // First code after a CLEAR must be a literal.
      cur = gen[code] === stamp ? table[code] : null;
      if (!cur) { reset(); continue; }
    } else if (gen[code] === stamp) {
      cur = table[code];
    } else if (code === nextCode) {
      // KwK: the code for the entry we are about to create.
      cur = entry.concat([entry[0]]);
    } else {
      break; // malformed stream — keep what we have
    }

    for (let i = 0; i < cur.length; i++) out.push(cur[i]);

    if (prev >= 0) {
      const next = entry.concat([cur[0]]);
      table[nextCode] = next;
      gen[nextCode] = stamp;
      nextCode++;
      // The decoder adds dictionary entries one step behind the encoder
      // (encoder adds entry N when emitting code X; decoder adds entry N when
      // reading code X+1).  The encoder checks `next_code > 2^w` where
      // next_code = N+1; the decoder must check `nextCode >= 2^w` where
      // nextCode = N — these are equivalent for integers.
      if (codeSize < 12 && nextCode >= 1 << codeSize) codeSize++;
    }
    entry = cur;
    prev = code;
  }
  return out;
}

/**
 * Row order of an interlaced GIF image of `h` rows: the stream stores the
 * passes back to back, so index `i` of the returned array is the source row
 * that belongs at output row `i`.
 */
function interlaceRows(h) {
  // GIF89a Appendix E. Passes are contiguous in the stream, so index i of the
  // returned array is the output row that the stream's i-th row belongs to.
  const rows = new Array(h);
  const passes = [[0, 8], [4, 8], [2, 4], [1, 2]];
  let src = 0;
  for (const [start, step] of passes) {
    for (let y = start; y < h; y += step) rows[src++] = y;
  }
  return rows;
}

/**
 * Parse a GIF byte stream into per-frame, fully-composited RGBA frames.
 *
 * @param {Uint8Array} bytes
 * @returns {{width:number, height:number, frames:Uint8ClampedArray[], durations:number[]}}
 *   `frames[i]` is `width*height*4` bytes, already with the previous frame's
 *   disposal applied, ready for putImageData().
 * @throws {Error} if the bytes are not a GIF
 */
export function parseGif(bytes) {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (u.length < 13 ||
      !(u[0] === 0x47 && u[1] === 0x49 && u[2] === 0x46 && u[3] === 0x38)) {
    throw new Error('not a GIF');
  }
  // Header is "GIF8" + a two-character revision, so the revision is "7a" or "9a".
  const version = String.fromCharCode(u[4], u[5]);
  if (version !== '7a' && version !== '9a') throw new Error('unsupported GIF version ' + version);

  let p = 6;
  // Bounds-checked reads: without these a truncated stream would spin reading
  // garbage forever, because the sub-block loops only stop on a zero length.
  const u8 = () => { if (p >= u.length) throw new Error('GIF truncated'); return u[p++]; };
  const u16 = () => {
    if (p + 1 >= u.length) throw new Error('GIF truncated');
    const v = u[p] | (u[p + 1] << 8);
    p += 2;
    return v;
  };
  const skip = (n) => {
    if (p + n > u.length) throw new Error('GIF truncated');
    p += n;
  };
  const readColors = (count) => {
    const cols = new Array(count);
    for (let i = 0; i < count; i++) cols[i] = [u8(), u8(), u8()];
    return cols;
  };
  const readSubBlocks = () => {
    const out = [];
    for (;;) {
      const n = u8();
      if (n === 0) break;
      for (let i = 0; i < n; i++) out.push(u8());
    }
    return out;
  };
  const skipSubBlocks = () => {
    for (;;) {
      const n = u8();
      if (n === 0) break;
      skip(n);
    }
  };

  const width = u16();
  const height = u16();
  const packed = u8();
  const bgIndex = u8();
  u8(); // pixel aspect ratio — unused
  // The Global Color Table follows the screen descriptor fields; the size field
  // encodes 2**(field+1) entries, so field 7 => 256 colours.
  const gct = (packed & 0x80) ? readColors(1 << ((packed & 0x07) + 1)) : null;

  const bg = (gct && bgIndex < gct.length) ? gct[bgIndex] : [0, 0, 0];

  const frames = [];
  const durations = [];

  let canvas = null;      // composited RGBA, width*height*4
  let prevBeforeDraw = null;  // canvas as it stood before the previous frame drew
  let prevRect = null;    // {x,y,w,h} covered by the previous sub-image
  let prevDisposal = 0;
  let disposal = 0;
  let delay = 0;
  let transparent = -1;

  const fillBg = () => {
    const out = new Uint8ClampedArray(width * height * 4);
    for (let i = 0, n = width * height; i < n; i++) {
      out[i * 4] = bg[0]; out[i * 4 + 1] = bg[1]; out[i * 4 + 2] = bg[2]; out[i * 4 + 3] = 255;
    }
    return out;
  };
  canvas = fillBg();

  const restoreRect = (rect, src) => {
    const x0 = Math.max(0, rect.x), y0 = Math.max(0, rect.y);
    const x1 = Math.min(width, rect.x + rect.w), y1 = Math.min(height, rect.y + rect.h);
    for (let y = y0; y < y1; y++) {
      let row = (y * width + x0) * 4;
      let srow = ((rect.y + (y - y0)) * width + (rect.x + (x0 - rect.x))) * 4;
      for (let x = x0; x < x1; x++, row += 4, srow += 4) {
        canvas[row] = src[srow]; canvas[row + 1] = src[srow + 1];
        canvas[row + 2] = src[srow + 2]; canvas[row + 3] = src[srow + 3];
      }
    }
  };

  const fillRectBg = (rect) => {
    const x0 = Math.max(0, rect.x), y0 = Math.max(0, rect.y);
    const x1 = Math.min(width, rect.x + rect.w), y1 = Math.min(height, rect.y + rect.h);
    for (let y = y0; y < y1; y++) {
      let o = (y * width + x0) * 4;
      for (let x = x0; x < x1; x++, o += 4) {
        canvas[o] = bg[0]; canvas[o + 1] = bg[1]; canvas[o + 2] = bg[2]; canvas[o + 3] = 255;
      }
    }
  };

  for (;;) {
    const block = u8();
    if (block === 0x3b) break;                    // trailer

    if (block === 0x2c) {                         // image descriptor
      // GIF89a §20: left, top, width, height, packed fields.
      const x = u16(), y = u16();
      const w = u16(), h = u16();
      const ip = u8();
      // packed: bit 7 local-colour-table flag, bit 6 interlace, bits 0-2 size.
      const lct = (ip & 0x80) ? readColors(1 << ((ip & 0x07) + 1)) : null;
      const interlaced = (ip & 0x40) !== 0;
      const colors = lct || gct;
      if (!colors) throw new Error('GIF image has no color table');

      const minCode = u8();
      const data = readSubBlocks();
      const indices = lzwDecode(minCode, data);

      // Snapshot before this frame draws: frame N's disposal 3 must be able to
      // restore the canvas to exactly this state.
      const beforeDraw = canvas.slice();
      if (prevDisposal === 2 && prevRect) fillRectBg(prevRect);
      else if (prevDisposal === 3 && prevRect) restoreRect(prevRect, prevBeforeDraw);

      // Write the sub-image. Transparent indices are skipped; rows outside the
      // logical screen are dropped.
      const rowMap = interlaced ? interlaceRows(h) : null;
      const rowOff = new Array(h);
      for (let r = 0; r < h; r++) {
        const sy = y + (rowMap ? rowMap[r] : r);
        rowOff[r] = (sy >= 0 && sy < height) ? (sy * width) * 4 : -1;
      }
      for (let r = 0; r < h; r++) {
        const off = rowOff[r];
        if (off < 0) continue;
        const irow = r * w;
        for (let col = 0; col < w; col++) {
          const idx = indices[irow + col];
          if (transparent >= 0 && idx === transparent) continue;
          if (idx === undefined || idx >= colors.length) continue;
          const c = colors[idx];
          if (!c) continue;
          const sx = x + col;
          if (sx < 0 || sx >= width) continue;
          const o = off + sx * 4;
          canvas[o] = c[0]; canvas[o + 1] = c[1]; canvas[o + 2] = c[2]; canvas[o + 3] = 255;
        }
      }

      frames.push(canvas.slice());
      durations.push(delay >= 3 ? delay * 10 : 100);

      prevBeforeDraw = beforeDraw;
      prevRect = { x, y, w, h };
      prevDisposal = disposal;
      disposal = 0; delay = 0; transparent = -1;
      continue;
    }

    if (block === 0x21) {                         // extension introducer
      const label = u8();
      if (label === 0xf9) {                       // graphic control extension
        u8();                                     // block size (always 4)
        const gce = u8();
        // packed: disposal method in bits 2-4, transparency flag in bit 0.
        disposal = (gce >>> 2) & 0x07;
        delay = u16();                            // centiseconds
        // The colour-index byte is always present, even when the flag is clear.
        const tIndex = u8();
        transparent = (gce & 0x01) ? tIndex : -1;
        u8();                                     // block terminator
      } else if (label === 0x01) {                // plaintext screen
        skip(4); skipSubBlocks();
      } else {                                    // application / comment
        skipSubBlocks();
      }
      continue;
    }

    // Unknown block type: swallow one sub-block chunk and carry on rather than
    // aborting the whole image.
    const n = u8();
    if (n) skip(n);
  }

  return { width, height, frames, durations };
}

/**
 * Decode every frame of a GIF data URL.
 *
 * @param {string} dataUrl  `data:image/gif...`
 * @returns {Promise<null|{width:number, height:number, frames:Uint8ClampedArray[], durations:number[]}>}
 *   null when the bytes are not a decodable multi-frame GIF (renderer.js then
 *   falls back to painting the static first frame through an `<img>`).
 */
export async function decodeGifFrames(dataUrl) {
  if (!dataUrl || !dataUrl.startsWith(GIF_DATA_PREFIX)) return null;
  try {
    const r = parseGif(dataUrlToBytes(dataUrl));
    if (!r.frames.length) return null;
    return r;
  } catch (_) {
    return null;
  }
}
