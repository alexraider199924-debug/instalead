// Run: node generate-icons.js
// Creates placeholder PNG icons using pure Node.js (no canvas)

const fs = require('fs');
const path = require('path');

// Minimal valid PNG: 1x1 purple pixel
// Used to generate placeholder icons until proper ones are added
function createSimplePNG(size) {
  // PNG signature
  const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

  function chunk(type, data) {
    const buf = Buffer.concat([Buffer.from(type), data]);
    const crc = crc32(buf);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc >>> 0);
    return Buffer.concat([len, buf, crcBuf]);
  }

  // IHDR
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.writeUInt8(8, 8);  // bit depth
  ihdr.writeUInt8(2, 9);  // RGB color type
  ihdr.writeUInt8(0, 10); // compression
  ihdr.writeUInt8(0, 11); // filter
  ihdr.writeUInt8(0, 12); // interlace

  // IDAT - raw scanlines, each with filter byte 0
  const scanline = size * 3; // RGB bytes
  const raw = Buffer.alloc(size * (1 + scanline), 0);
  for (let y = 0; y < size; y++) {
    raw[y * (1 + scanline)] = 0; // filter
    for (let x = 0; x < size; x++) {
      const off = y * (1 + scanline) + 1 + x * 3;
      // Purple gradient
      raw[off]     = Math.round(124 + (x / size) * 30); // R
      raw[off + 1] = Math.round(58 - (y / size) * 20);  // G
      raw[off + 2] = Math.round(237 - (x / size) * 50); // B
    }
  }

  const zlib = require('zlib');
  const compressed = zlib.deflateSync(raw, { level: 9 });

  const iend = Buffer.alloc(0);

  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', compressed), chunk('IEND', iend)]);
}

// Simple CRC32
function crc32(buf) {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[i] = c;
  }
  let crc = 0xFFFFFFFF;
  for (const byte of buf) crc = table[(crc ^ byte) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

const dir = path.join(__dirname, 'icons');
fs.mkdirSync(dir, { recursive: true });

for (const size of [16, 48, 128]) {
  const png = createSimplePNG(size);
  fs.writeFileSync(path.join(dir, `icon${size}.png`), png);
  console.log(`Created icon${size}.png (${size}x${size})`);
}
console.log('Icons created!');
