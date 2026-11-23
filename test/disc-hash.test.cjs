'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const script = new vm.Script(readFileSync(path.join(__dirname, '../rom-patcher-js/RomPatcher.webworker.disc.js'), 'utf8'));
const sliceBytes = 4 * 1024 * 1024;

function createWorker() {
	const messages = [];
	const self = { postMessage: message => messages.push(message) };
	script.runInNewContext({ self, Blob });
	return { hash: file => self.onmessage({ data: file }), messages };
}

async function check(blob, expected) {
	const worker = createWorker();
	await worker.hash(blob);
	assert.equal(worker.messages.at(-1).sha1, expected);
	const progress = worker.messages.slice(0, -1).map(message => message.progress);
	assert.equal(progress[0], 0);
	assert.equal(progress.at(-1), 100);
	assert.ok(progress.every((value, i) => Number.isInteger(value) && (!i || value > progress[i - 1])));
}

test('matches published SHA-1 vectors', async () => {
	await check(new Blob([]), 'da39a3ee5e6b4b0d3255bfef95601890afd80709');
	await check(new Blob(['abc']), 'a9993e364706816aba3e25717850c26c9cd0d89d');
	await check(new Blob(['a'.repeat(1000000)]), '34aa973cd4c4daa4f61eeb2bdbad27316534016f');
});

test('matches Node at padding, block and slice boundaries', async () => {
	const data = Buffer.alloc(sliceBytes + 65);
	for (let i = 0; i < data.length; i++) data[i] = (i * 17 + (i >>> 7)) & 255;
	for (const size of [55, 56, 63, 64, 65, 119, 120, sliceBytes - 1, sliceBytes, sliceBytes + 1, sliceBytes + 65]) {
		const bytes = data.subarray(0, size);
		await check(new Blob([bytes]), createHash('sha1').update(bytes).digest('hex'));
	}
});

test('hashes more than 512 MiB in bounded sequential reads', async () => {
	// Reuse one synthetic chunk, rather than allocating a disc-sized fixture.
	const data = Buffer.alloc(sliceBytes, 0x69);
	const chunk = new Blob([data]);
	const count = 128;
	const tail = Buffer.from('final partial block');
	const slices = Array(count).fill(chunk);
	const source = new Blob([...slices, tail]);
	const expected = createHash('sha1');
	for (let i = 0; i < count; i++) expected.update(data);
	expected.update(tail);

	let nextOffset = 0;
	class CheckedBlob extends Blob {
		slice(start, end) {
			assert.equal(start, nextOffset);
			assert.ok(end - start <= sliceBytes);
			nextOffset = end;
			return super.slice(start, end);
		}
	}
	await check(new CheckedBlob([source]), expected.digest('hex'));
	assert.equal(nextOffset, source.size);
});

test('reports a failed or incomplete read without a digest', async () => {
	for (const read of [() => Promise.reject(new Error('read failed')), () => Promise.resolve(new ArrayBuffer(0))]) {
		class UnreadableBlob extends Blob {
			slice() { return { arrayBuffer: read }; }
		}
		const worker = createWorker();
		await worker.hash(new UnreadableBlob(['data']));
		assert.equal(worker.messages.at(-1).error, true);
		assert.ok(worker.messages.every(message => !message.sha1));
	}
});

test('discards a stale read after a replacement selection', async () => {
	let finish;
	class DelayedBlob extends Blob {
		slice(start, end) {
			const slice = super.slice(start, end);
			return { arrayBuffer: () => new Promise(resolve => { finish = () => resolve(slice.arrayBuffer()); }) };
		}
	}
	const worker = createWorker();
	const first = worker.hash(new DelayedBlob(['old']));
	await worker.hash(new Blob(['abc']));
	finish();
	await first;
	const results = worker.messages.filter(message => message.sha1);
	assert.equal(results.length, 1);
	assert.equal(results[0].sha1, 'a9993e364706816aba3e25717850c26c9cd0d89d');
});
