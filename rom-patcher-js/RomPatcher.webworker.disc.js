'use strict';

// SHA-1 as specified by RFC 3174 §6.1. The existing Web Crypto helper requires
// the entire ISO in memory. Each slice here ends on a 64-byte block boundary,
// except for the final slice, whose remaining bytes go into the padding block.
const SLICE_BYTES = 4 * 1024 * 1024;
const BLOCK_BYTES = 64;
let currentJob = 0;

function compressBlocks(data, hash, words) {
	for (let offset = 0; offset + BLOCK_BYTES <= data.byteLength; offset += BLOCK_BYTES) {
		for (let round = 0; round < 16; round++) {
			words[round] = data.getUint32(offset + round * 4, false);
		}
		for (let round = 16; round < 80; round++) {
			const combined = words[round - 3] ^ words[round - 8] ^ words[round - 14] ^ words[round - 16];
			words[round] = (combined << 1) | (combined >>> 31);
		}

		let a = hash[0], b = hash[1], c = hash[2], d = hash[3], e = hash[4];
		for (let round = 0; round < 80; round++) {
			let mix, constant;
			if (round < 20) {
				mix = (b & c) | (~b & d);
				constant = 0x5a827999;
			} else if (round < 40) {
				mix = b ^ c ^ d;
				constant = 0x6ed9eba1;
			} else if (round < 60) {
				mix = (b & c) | (b & d) | (c & d);
				constant = 0x8f1bbcdc;
			} else {
				mix = b ^ c ^ d;
				constant = 0xca62c1d6;
			}
			const next = (((a << 5) | (a >>> 27)) + mix + e + constant + words[round]) | 0;
			e = d;
			d = c;
			c = (b << 30) | (b >>> 2);
			b = a;
			a = next;
		}
		hash[0] += a;
		hash[1] += b;
		hash[2] += c;
		hash[3] += d;
		hash[4] += e;
	}
}

self.onmessage = async function ({ data: file }) {
	const job = ++currentJob;
	try {
		if (!(file instanceof Blob)) throw new TypeError('Expected a file');

		const hash = new Uint32Array([0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0]);
		const words = new Int32Array(80);
		const remainder = file.size % BLOCK_BYTES;
		const padding = new Uint8Array(remainder < 56 ? BLOCK_BYTES : 2 * BLOCK_BYTES);
		let lastProgress = 0;
		self.postMessage({ progress: 0 });

		for (let offset = 0; offset < file.size; offset += SLICE_BYTES) {
			const end = Math.min(offset + SLICE_BYTES, file.size);
			const slice = file.slice(offset, end);
			const buffer = typeof slice.arrayBuffer === 'function'
				? await slice.arrayBuffer()
				: new FileReaderSync().readAsArrayBuffer(slice);
			if (job !== currentJob) return;
			if (buffer.byteLength !== end - offset) throw new Error('Incomplete read');
			compressBlocks(new DataView(buffer), hash, words);
			if (end === file.size && remainder) {
				padding.set(new Uint8Array(buffer, buffer.byteLength - remainder));
			}
			const progress = Math.floor(end / file.size * 100);
			if (progress > lastProgress && progress < 100) {
				self.postMessage({ progress });
				lastProgress = progress;
			}
		}

		padding[remainder] = 0x80;
		const finalBlocks = new DataView(padding.buffer);
		// SHA-1 encodes the bit length as a big-endian 64-bit integer. The
		// upper word becomes nonzero at 512 MiB, well below a full GameCube ISO.
		finalBlocks.setUint32(padding.length - 8, Math.floor(file.size / 0x20000000), false);
		finalBlocks.setUint32(padding.length - 4, (file.size % 0x20000000) * 8, false);
		compressBlocks(finalBlocks, hash, words);
		const sha1 = Array.from(hash, word => word.toString(16).padStart(8, '0')).join('');
		self.postMessage({ progress: 100 });
		self.postMessage({ sha1 });
	} catch {
		if (job === currentJob) self.postMessage({ error: true });
	}
};
