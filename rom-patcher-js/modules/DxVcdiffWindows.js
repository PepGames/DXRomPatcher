/* Decode DX's independently checksummed xdelta windows with Rom Patcher JS's default VCDIFF decoder. */
'use strict';

const DxVcdiffWindows = (() => {
	const MiB = 1024 * 1024;
	// The four released bundles use at most 72,276,127 source bytes and 8 MiB of output per window.
	const MAX_SOURCE = 72 * MiB;
	const MAX_TARGET = 8 * MiB;
	const MAX_DELTA = 16 * MiB;
	const MAX_INT = 0x7fffffff; // The upstream decoder reads signed 31-bit lengths.
	const FILE_HEADER = Uint8Array.of(0xd6, 0xc3, 0xc4, 0, 0);

	function invalid(reason) {
		throw new Error('Invalid or unsupported DX patch: ' + reason);
	}

	// The address cache uses these same two reader methods as the upstream parser.
	class Reader {
		constructor(bytes, start = 0, end = bytes.length) {
			this.bytes = bytes;
			this.offset = start;
			this.end = end;
		}
		readU8() {
			if (this.offset >= this.end) invalid('truncated section');
			return this.bytes[this.offset++];
		}
		read7BitEncodedInt() {
			let value = 0;
			for (let i = 0; i < 5; i++) {
				const byte = this.readU8();
				value = value * 128 + (byte & 127);
				if (value > MAX_INT) invalid('integer exceeds decoder range');
				if (!(byte & 128)) return value;
			}
			invalid('invalid integer');
		}
		skip(count) {
			if (count > this.end - this.offset) invalid('truncated section');
			this.offset += count;
		}
	}

	function* windows(bytes, sourceSize) {
		if (!(bytes instanceof Uint8Array) || !Number.isSafeInteger(sourceSize) || sourceSize < 0) {
			throw new TypeError('Expected VCDIFF patch bytes and a source size.');
		}
		const reader = new Reader(bytes);
		for (let i = 0; i < 4; i++) {
			if (reader.readU8() !== FILE_HEADER[i]) invalid('not a version 0 VCDIFF file');
		}
		const header = reader.readU8();
		if (header & ~VCD_APPHEADER) invalid('custom code table or secondary compression');
		if (header & VCD_APPHEADER) reader.skip(reader.read7BitEncodedInt());

		while (reader.offset < reader.end) {
			const start = reader.offset;
			const flags = reader.readU8();
			if (flags !== VCD_ADLER32 && flags !== (VCD_SOURCE | VCD_ADLER32)) {
				invalid('expected an independent window with an Adler-32 checksum');
			}
			const hasSource = (flags & VCD_SOURCE) !== 0;
			const sourceLength = hasSource ? reader.read7BitEncodedInt() : 0;
			const positionField = reader.offset;
			const sourcePosition = hasSource ? reader.read7BitEncodedInt() : 0;
			if (sourceLength > MAX_SOURCE || sourcePosition + sourceLength > sourceSize) invalid('source range');
			const deltaField = reader.offset;
			const deltaLength = reader.read7BitEncodedInt();
			const end = reader.offset + deltaLength;
			if (deltaLength > MAX_DELTA || end > reader.end) invalid('delta length');

			const targetLength = reader.read7BitEncodedInt();
			if (!targetLength || targetLength > MAX_TARGET) invalid('target length');
			if (reader.readU8() !== 0) invalid('compressed section');
			const dataLength = reader.read7BitEncodedInt();
			const instructionLength = reader.read7BitEncodedInt();
			const addressLength = reader.read7BitEncodedInt();
			const checksum = reader.readU8() * 0x1000000 + reader.readU8() * 0x10000 +
				reader.readU8() * 0x100 + reader.readU8();
			const instructions = reader.offset + dataLength;
			const addresses = instructions + instructionLength;
			if (addresses + addressLength !== end) invalid('inconsistent section lengths');
			yield { start, end, hasSource, sourceLength, sourcePosition, positionField, deltaField, targetLength,
				checksum, dataLength, instructions, addresses };
			reader.offset = end;
		}
	}

	function inspect(bytes, sourceSize) {
		let totalBytes = 0, windowCount = 0, maxSourceBytes = 0, maxTargetBytes = 0;
		for (const window of windows(bytes, sourceSize)) {
			checkInstructions(bytes, window);
			totalBytes += window.targetLength;
			if (totalBytes > MAX_INT) invalid('output exceeds the supported disc size');
			windowCount++;
			maxSourceBytes = Math.max(maxSourceBytes, window.sourceLength);
			maxTargetBytes = Math.max(maxTargetBytes, window.targetLength);
		}
		if (!windowCount) invalid('no output windows');
		return { totalBytes, windowCount, maxSourceBytes, maxTargetBytes };
	}

	// Verify where the upstream default code table will read and write before decoding.
	function checkInstructions(bytes, w) {
		const instructions = new Reader(bytes, w.instructions, w.addresses);
		const addresses = new Reader(bytes, w.addresses, w.end);
		const cache = new VCD_AdressCache(4, 3);
		cache.reset(addresses);
		let produced = 0, dataUsed = 0;
		while (instructions.offset < instructions.end) {
			const code = VCD_DEFAULT_CODE_TABLE[instructions.readU8()];
			for (const instruction of code) {
				if (instruction.type === VCD_NOOP) continue;
				const size = instruction.size || instructions.read7BitEncodedInt();
				if (size > w.targetLength - produced) invalid('instruction exceeds target window');
				if (instruction.type === VCD_COPY) {
					const here = w.sourceLength + produced;
					const address = cache.decodeAddress(here, instruction.mode);
					if (address < 0 || address >= here || (address < w.sourceLength && size > w.sourceLength - address)) {
						invalid('copy outside source or produced target');
					}
				} else {
					dataUsed += instruction.type === VCD_RUN ? 1 : size;
				}
				produced += size;
			}
		}
		if (produced !== w.targetLength || dataUsed !== w.dataLength || addresses.offset !== addresses.end) {
			invalid('instruction totals do not match the window');
		}
	}

	function decodeWindow(source, bytes, w) {
		// Keep the original delta, checksum and source length. Only its absolute
		// source position changes: the sliced file starts at that position.
		const prefix = bytes.subarray(w.start, w.positionField);
		const delta = bytes.subarray(w.deltaField, w.end);
		const deltaStart = FILE_HEADER.length + prefix.length + (w.hasSource ? 1 : 0);
		const mini = new Uint8Array(deltaStart + delta.length);
		mini.set(FILE_HEADER);
		mini.set(prefix, FILE_HEADER.length);
		// A zero byte in the initialized buffer encodes the rebased source position.
		mini.set(delta, deltaStart);

		const decoder = new VCDIFF(new BinFile(mini.buffer));
		const output = decoder.apply(new BinFile(source), false)._u8array;
		// Upstream's optional checksum branch expects a global adler32 function.
		// Use its shipped calculator explicitly, including when the expected sum is zero.
		if (output.length !== w.targetLength ||
			HashCalculator.adler32(output.buffer, output.byteOffset, output.byteLength) !== w.checksum) {
			invalid('output window checksum mismatch');
		}
		return output;
	}

	async function readAndDecode(inputFile, bytes, w) {
		let source;
		try {
			source = w.sourceLength
				? await inputFile.slice(w.sourcePosition, w.sourcePosition + w.sourceLength).arrayBuffer()
				: new ArrayBuffer(0);
			if (source.byteLength !== w.sourceLength) throw new Error('Incomplete source slice');
		} catch (cause) {
			const error = new Error('The source disc could not be read.');
			error.name = 'NotReadableError';
			error.cause = cause;
			throw error;
		}
		return decodeWindow(source, bytes, w);
	}

	async function apply(inputFile, bytes, writeChunk, onProgress) {
		const { totalBytes } = inspect(bytes, inputFile.size);
		let producedBytes = 0;
		if (onProgress) onProgress({ totalBytes, producedBytes });
		for (const window of windows(bytes, inputFile.size)) {
			const chunk = await readAndDecode(inputFile, bytes, window);
			await writeChunk(chunk);
			producedBytes += window.targetLength;
			if (onProgress) onProgress({ totalBytes, producedBytes });
		}
		return { totalBytes, producedBytes };
	}

	return { inspect, apply };
})();
