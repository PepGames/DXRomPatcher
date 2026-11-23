'use strict';

// Each worker owns a single run. Its lock keeps other tabs from deleting a live result.
// After disposal/crash, a completed result gets an hour for a native download to finish.
// Partial results have no marker and can be reclaimed immediately after their lock is gone.
const storageDirectory = 'dx-patcher-output-v1';
const jobNamePattern = /^job-[a-f0-9]{32}$/;
const markerPattern = /^keep-until-(\d{13})$/;
const downloadGrace = 60 * 60 * 1000;
let started = false;
let disposed = false;
let releaseLease;
const lease = new Promise(resolve => { releaseLease = resolve; });
let refreshRetention = null;
let discardOutput = null;

function checkActive() {
	if (disposed) throw new DOMException('Patch run was cancelled.', 'AbortError');
}

function storageUnavailable() {
	return new Error('This browser cannot store a large patched ISO on disk. Try an up-to-date browser in a regular tab with local storage enabled.');
}

function describeError(error) {
	switch (error?.name) {
		case 'QuotaExceededError':
			return 'There is not enough browser storage for the patched ISO. Free space on this device, then try Apply patch again.';
		case 'SecurityError':
		case 'NotAllowedError':
			return 'The browser denied access to local storage. Try a regular tab with local storage enabled.';
		case 'NotSupportedError':
			return storageUnavailable().message;
		case 'UnknownError':
		case 'NoModificationAllowedError':
		case 'InvalidStateError':
			return 'The browser could not finish using local storage for the patched ISO. Try a regular tab with local storage enabled and free space for a 1.46 GB output, then retry.';
		case 'NotReadableError':
			return 'The source or output could not be read. Make the ISO available on this device and try again.';
		default:
			return error?.message || 'The patched ISO could not be written. Check available storage, then try again.';
	}
}

async function ownedDirectory(create) {
	if (!navigator.storage?.getDirectory || !navigator.locks?.request) throw storageUnavailable();
	const root = await navigator.storage.getDirectory();
	try {
		return await root.getDirectoryHandle(storageDirectory, { create });
	} catch (error) {
		if (!create && error.name === 'NotFoundError') return null;
		throw error;
	}
}

async function sweep(directory) {
	if (!directory) return;
	for await (const [name, handle] of directory.entries()) {
		if (handle.kind !== 'directory' || !jobNamePattern.test(name)) continue;
		// Never wait for another patch or for a tab holding a live Save link.
		await navigator.locks.request(storageDirectory + '/' + name, { ifAvailable: true }, async lock => {
			if (!lock) return;
			try {
				const job = await directory.getDirectoryHandle(name);
				for await (const entry of job.keys()) {
					const marker = markerPattern.exec(entry);
					if (marker && Number(marker[1]) > Date.now()) return;
				}
				await directory.removeEntry(name, { recursive: true });
			} catch (error) {
				// Concurrent sweeps or a browser download can remove/hold the entry.
				// A later visit can finish reclamation without interfering with this run.
				if (error.name !== 'NotFoundError') console.warn('DX temporary output cleanup deferred:', error.name);
			}
		});
	}
}

async function writeOutput(job, request) {
	importScripts(...[
		'./modules/BinFile.js', './modules/HashCalculator.js',
		'./modules/RomPatcher.format.vcdiff.js', './modules/DxVcdiffWindows.js'
	].map(file => file + self.location.search));
	const source = request.source;
	const patch = request.patch;
	const outputName = request.outputName;
	if (!(source instanceof Blob) || !(patch instanceof Uint8Array) || typeof outputName !== 'string'
		|| !/\.iso$/i.test(outputName) || /[\\/]/.test(outputName)) {
		throw new Error('The patcher received an invalid source, patch, or output name.');
	}
	const handle = await job.getFileHandle(outputName, { create: true });
	let totalBytes = null;
	let offset = 0;
	let access = null;
	let stream = null;
	try {
		if (typeof handle.createSyncAccessHandle === 'function') {
			try {
				access = await handle.createSyncAccessHandle();
			} catch (error) {
				// Some WebKit backends expose the method but report UnknownError on open.
				if (!['NotSupportedError', 'UnknownError'].includes(error.name) || typeof handle.createWritable !== 'function') throw error;
			}
		}
		if (!access) {
			if (typeof handle.createWritable !== 'function') throw storageUnavailable();
			stream = await handle.createWritable();
		}
		await DxVcdiffWindows.apply(source, patch, async chunk => {
			checkActive();
			if (offset === 0 && access) await access.truncate(totalBytes);
			if (offset + chunk.byteLength > totalBytes) throw new Error('The DX patch exceeds its declared output size.');
			if (access) {
				let written = 0;
				while (written < chunk.byteLength) {
					const count = access.write(chunk.subarray(written), { at: offset + written });
					if (!Number.isInteger(count) || count < 1) {
						throw new DOMException('Could not write the output window.', 'QuotaExceededError');
					}
					written += count;
				}
			} else {
				await stream.write(chunk);
			}
			offset += chunk.byteLength;
		}, progress => {
			totalBytes = progress.totalBytes;
			self.postMessage({ type: 'progress', producedBytes: progress.producedBytes, totalBytes });
		});
		checkActive();
		if (offset !== totalBytes) throw new Error('The patch did not produce the complete ISO.');
		if (access) {
			await access.flush();
			await access.close();
			access = null;
		} else {
			await stream.close();
			stream = null;
		}
		const file = await handle.getFile();
		if (file.size !== totalBytes) throw new Error('The browser could not store the complete patched ISO.');
		return file;
	} catch (error) {
		// A failed disk backend can also reject close/abort. Keep the original reason.
		if (access) {
			try { await access.close(); } catch {}
		}
		if (stream) {
			try { await stream.abort(); } catch {}
		}
		throw error;
	}
}

async function apply(request) {
	const directory = await ownedDirectory(true);
	await sweep(directory);
	checkActive();
	const name = 'job-' + crypto.randomUUID().replace(/-/g, '');
	await navigator.locks.request(storageDirectory + '/' + name, async () => {
		const job = await directory.getDirectoryHandle(name, { create: true });
		let published = false;
		let discarded = false;
		let removing = null;
		let marker = '';
		let pending = Promise.resolve();
		function retain() {
			pending = pending.catch(() => {}).then(async () => {
				const next = 'keep-until-' + (Date.now() + downloadGrace);
				if (next === marker) return;
				await job.getFileHandle(next, { create: true });
				const old = marker;
				marker = next;
				if (old) await job.removeEntry(old);
			});
			return pending;
		}
		try {
			const file = await writeOutput(job, request);
			request = null;
			checkActive();
			await retain();
			checkActive();
			self.postMessage({ type: 'done', file, size: file.size });
			published = true;
			refreshRetention = retain;
			discardOutput = () => {
				if (removing || disposed) return;
				refreshRetention = null;
				removing = pending.catch(() => {}).then(async () => {
					// Unlink the one result first. A failed unlink leaves its bytes and Save link intact.
					try {
						await job.removeEntry(file.name);
					} catch (error) {
						if (error.name !== 'NotFoundError') throw error;
					}
					discarded = true;
					await directory.removeEntry(name, { recursive: true }).catch(() => {});
					self.postMessage({ type: 'discarded' });
					releaseLease();
				}).catch(() => {
					refreshRetention = retain;
					self.postMessage({ type: 'discardError', message: 'The browser could not remove the temporary ISO. Let any download finish, then try clearing the temporary copy again.' });
				}).finally(() => { removing = null; });
			};
			await lease;
		} finally {
			discardOutput = null;
			refreshRetention = null;
			if (removing) await removing;
			if (published && !discarded) {
				await retain().catch(() => {});
			} else if (!published) {
				await directory.removeEntry(name, { recursive: true }).catch(() => {});
			}
		}
	});
}

self.onmessage = ({ data }) => {
	if (data?.type === 'dispose') {
		disposed = true;
		releaseLease();
		return;
	}
	if (data?.type === 'retain') {
		if (refreshRetention) refreshRetention().catch(() => {});
		return;
	}
	if (data?.type === 'discard') {
		if (discardOutput) discardOutput();
		return;
	}
	if (started || (data?.type !== 'apply' && data?.type !== 'cleanup')) return;
	started = true;
	const isApply = data.type === 'apply';
	const task = isApply ? apply(data) : ownedDirectory(false).then(sweep);
	task.catch(error => {
		if (isApply && !disposed) self.postMessage({ type: 'error', message: describeError(error) });
	}).finally(() => self.close());
};
