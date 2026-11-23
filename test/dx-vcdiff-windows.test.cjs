'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { inflateRawSync } = require('node:zlib');

const root = path.join(__dirname, '..');
const context = vm.createContext({ Uint8Array, ArrayBuffer, DataView });
for (const name of ['BinFile', 'HashCalculator', 'RomPatcher.format.vcdiff', 'DxVcdiffWindows']) {
	const file = path.join(root, 'rom-patcher-js', 'modules', name + '.js');
	vm.runInContext(readFileSync(file, 'utf8'), context, { filename: file });
}
const { decoder, Bin, Vcd, Parser } = vm.runInContext(
	'({ decoder: DxVcdiffWindows, Bin: BinFile, Vcd: VCDIFF, Parser: VCDIFF_Parser })', context
);

function adler(bytes) {
	let a = 1, b = 0;
	for (let start = 0; start < bytes.length; start += 5552) {
		const end = Math.min(bytes.length, start + 5552);
		for (let i = start; i < end; i++) { a += bytes[i]; b += a; }
		a %= 65521;
		b %= 65521;
	}
	return (b * 65536 + a) >>> 0;
}

function encoded(value) {
	const result = [value % 128];
	while ((value = Math.floor(value / 128))) result.unshift(128 + value % 128);
	return result;
}

const header = [0xd6, 0xc3, 0xc4, 0, 0];
function windowBytes({ source, instructions, addresses = [], data, target }) {
	const sum = adler(Buffer.from(target));
	const delta = [...encoded(target.length), 0, ...encoded(data.length), ...encoded(instructions.length),
		...encoded(addresses.length), sum >>> 24, sum >>> 16 & 255, sum >>> 8 & 255, sum & 255,
		...Buffer.from(data), ...instructions, ...addresses];
	const dictionary = source ? [5, ...encoded(source.length), ...encoded(source.position)] : [4];
	return [...dictionary, ...encoded(delta.length), ...delta];
}

const source = new Blob(['0123456789abcdef']);
const first = windowBytes({ source: { position: 10, length: 6 }, instructions: [20, 3, 20],
	addresses: [1, 10], data: 'XY', target: 'bcdeXYXYXY' });
const last = windowBytes({ instructions: [0, 3, 2], data: '!a', target: '!!!a' });
const fixture = Uint8Array.from([...header, ...first, ...last]);

test('matches upstream for rebased source COPY, overlapping target COPY, ADD and RUN', async () => {
	const reference = new Vcd(new Bin(fixture.buffer)).apply(new Bin(await source.arrayBuffer()), false)._u8array;
	const written = [], calls = [], progress = [];
	const file = { size: source.size, slice(start, end) { calls.push([start, end]); return source.slice(start, end); } };
	const result = await decoder.apply(file, fixture, async chunk => {
		await new Promise(resolve => setImmediate(resolve));
		written.push(Buffer.from(chunk));
	}, value => progress.push([value.totalBytes, value.producedBytes, written.length]));
	assert.deepEqual({ ...result }, { totalBytes: 14, producedBytes: 14 });
	assert.deepEqual(calls, [[10, 16]]);
	assert.deepEqual(progress, [[14, 0, 0], [14, 10, 1], [14, 14, 2]]);
	assert.equal(Buffer.concat(written).toString(), 'bcdeXYXYXY!!!a');
	assert.deepEqual(Buffer.concat(written), Buffer.from(reference));
});

test('rejects unsupported, truncated and inconsistent windows before writing', async () => {
	const badCases = [];
	for (const [offset, value] of [[0, 0], [3, 1], [4, 1], [5, 6], [5, 1], [6, 90], [7, 30], [10, 1]]) {
		const changed = fixture.slice();
		changed[offset] = value;
		badCases.push(changed);
	}
	badCases.push(fixture.subarray(0, fixture.length - 1));
	const badSize = windowBytes({ instructions: [2], data: 'x', target: 'xy' });
	badCases.push(Uint8Array.from([...header, ...badSize]));
	const badAddress = windowBytes({ source: { position: 0, length: 4 }, instructions: [20],
		addresses: [1], data: '', target: 'abcd' });
	badCases.push(Uint8Array.from([...header, ...badAddress]));
	for (const bytes of badCases) {
		let writes = 0;
		await assert.rejects(decoder.apply(source, bytes, () => { writes++; }), /Invalid or unsupported DX patch/);
		assert.equal(writes, 0);
	}
});

test('rejects checksum mismatches before the affected chunk, propagates read and write errors', async () => {
	const changed = fixture.slice();
	changed[changed.length - 4] ^= 1; // Change RUN/ADD data, preserving the declared checksum and section lengths.
	let written = 0;
	await assert.rejects(decoder.apply(source, changed, chunk => { written += chunk.length; }), /checksum mismatch/);
	assert.equal(written, 10);
	const badSource = { size: source.size, slice() { return new Blob([]); } };
	await assert.rejects(decoder.apply(badSource, fixture, () => assert.fail()), { name: 'NotReadableError' });
	const progress = [];
	await assert.rejects(decoder.apply(source, fixture, () => { throw new Error('disk full'); },
		value => progress.push(value.producedBytes)), /disk full/);
	assert.deepEqual(progress, [0]);
});

// The shipped assets each have one deflated local entry, with the sizes present in its header.
function releasePatch(version) {
	const archive = readFileSync(path.join(root, 'DXPatch', 'DX_3_0_' + version + '.zip'));
	assert.equal(archive.readUInt32LE(0), 0x04034b50);
	assert.equal(archive.readUInt16LE(8), 8);
	const start = 30 + archive.readUInt16LE(26) + archive.readUInt16LE(28);
	return inflateRawSync(archive.subarray(start, start + archive.readUInt32LE(18)));
}

for (const version of ['0', '1', '2', 'b']) {
	test('release 3.0.' + version + ' has bounded, supported windows and matches upstream on a synthetic source', async () => {
		const patch = releasePatch(version);
		assert.deepEqual({ ...decoder.inspect(patch, 1459978240) }, { totalBytes: 1459978240, windowCount: 175,
			maxSourceBytes: 72276127, maxTargetBytes: 8388608 });

		// Keep the real first two instruction streams. Independently decode them against
		// generated source data, then regenerate their checksums in a test-only patch copy.
		const parser = new Parser(new Bin(Uint8Array.from(patch).buffer));
		parser.seek(5);
		parser.skip(parser.read7BitEncodedInt());
		const windows = [];
		for (let i = 0; i < 2; i++) {
			const win = parser.decodeWindowHeader();
			windows.push({ check: parser.offset - 4, end: win.sourcePosition + win.sourceLength,
				target: win.targetWindowLength });
			parser.skip(win.addRunDataLength + win.instructionsLength + win.addressesLength);
		}
		const two = Uint8Array.from(patch.subarray(0, parser.offset));
		const input = new Uint8Array(Math.max(...windows.map(w => w.end)));
		for (let i = 0; i < input.length; i++) input[i] = (i * 31 + (i >>> 12)) & 255;
		const expected = new Vcd(new Bin(two.buffer)).apply(new Bin(input.buffer), false)._u8array;
		let offset = 0;
		const view = new DataView(two.buffer);
		for (const win of windows) {
			view.setUint32(win.check, adler(expected.subarray(offset, offset + win.target)), false);
			offset += win.target;
		}
		offset = 0;
		await decoder.apply(new Blob([input]), two, chunk => {
			assert.deepEqual(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength),
				Buffer.from(expected.buffer, offset, chunk.length));
			offset += chunk.length;
		});
		assert.equal(offset, expected.length);
	});
}

test('release 3.0.2 decodes its largest source span at its original disc offset', async () => {
	const patch = releasePatch('2');
	const parser = new Parser(new Bin(Uint8Array.from(patch).buffer));
	parser.seek(5);
	parser.skip(parser.read7BitEncodedInt());
	let largest;
	while (!parser.isEOF()) {
		const start = parser.offset;
		const win = parser.decodeWindowHeader();
		const checksumOffset = parser.offset - 4;
		parser.skip(win.addRunDataLength + win.instructionsLength + win.addressesLength);
		if (!largest || win.sourceLength > largest.win.sourceLength) {
			largest = { win, start, end: parser.offset, checksumOffset };
		}
	}
	const { win, start, end, checksumOffset } = largest;
	assert.equal(win.sourceLength, 72276127);
	assert.equal(win.sourcePosition, 458181271);

	const single = new Uint8Array(header.length + end - start);
	single.set(header);
	single.set(patch.subarray(start, end), header.length);
	const byteAt = index => (index * 13 + (index >>> 15)) & 255;
	// Upstream reads absolute indices. Provide generated bytes at those indices without a disc-sized array.
	const virtual = { _u8array: new Proxy({}, { get: (_target, index) => byteAt(Number(index)) }) };
	const expected = new Vcd(new Bin(single.buffer)).apply(virtual, false)._u8array;
	new DataView(single.buffer).setUint32(header.length + checksumOffset - start, adler(expected), false);
	let reads = 0;
	const source = { size: 1459978240, slice(from, to) {
		assert.equal(from, win.sourcePosition);
		assert.equal(to, from + win.sourceLength);
		reads++;
		return { async arrayBuffer() {
			const bytes = new Uint8Array(to - from);
			for (let i = 0; i < bytes.length; i++) bytes[i] = byteAt(from + i);
			return bytes.buffer;
		} };
	} };
	let writes = 0;
	await decoder.apply(source, single, chunk => {
		assert.deepEqual(Buffer.from(chunk.buffer), Buffer.from(expected.buffer));
		writes++;
	});
	assert.equal(reads, 1);
	assert.equal(writes, 1);
});
