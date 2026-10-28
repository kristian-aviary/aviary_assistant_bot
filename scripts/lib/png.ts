import { crc32, deflateSync } from 'node:zlib';

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** Minimal RGBA PNG encoder: no dependency, deterministic output. */
export function encodePng(width: number, height: number, pixel: (x: number, y: number) => [number, number, number, number]): Buffer {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 4 + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = pixel(x, y);
      raw.set([r, g, b, a], row + 1 + x * 4);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const inCircle = (x: number, y: number, cx: number, cy: number, r: number) => (x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= r * r;

/** 192x192 full-colour placeholder: teal square, white disc. Design will supply the real icon. */
export function colorIcon(): Buffer {
  return encodePng(192, 192, (x, y) => (inCircle(x, y, 96, 96, 56) ? [255, 255, 255, 255] : [0x1f, 0x6f, 0x8b, 255]));
}

/** 32x32 transparent outline placeholder: white ring on transparent. */
export function outlineIcon(): Buffer {
  return encodePng(32, 32, (x, y) => {
    const ring = inCircle(x, y, 16, 16, 11) && !inCircle(x, y, 16, 16, 8);
    return ring ? [255, 255, 255, 255] : [0, 0, 0, 0];
  });
}
