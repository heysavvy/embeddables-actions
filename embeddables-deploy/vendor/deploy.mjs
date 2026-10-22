// Vendored from @embeddables/deploy@0.2.0 by scripts/vendor-deploy.sh. Do not edit by hand.
import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { gzipSync } from "node:zlib";
//#region src/batches.ts
const PART_OVERHEAD_BYTES = 512;
/**
* Splits the backend's buckets of missing content hashes into requests that
* each stay under the batch limit. A single file is at most 25 MB, so it
* always fits in a batch of its own.
*/
function planBatches(buckets, sizes) {
	const budget = 31195136;
	const batches = [];
	for (const bucket of buckets) {
		let current = [];
		let used = 0;
		for (const hash of bucket) {
			const size = sizes.get(hash);
			if (size === void 0) throw new Error(`Backend asked for unknown file ${hash}.`);
			const cost = size + PART_OVERHEAD_BYTES;
			if (current.length > 0 && used + cost > budget) {
				batches.push(current);
				current = [];
				used = 0;
			}
			current.push(hash);
			used += cost;
		}
		if (current.length > 0) batches.push(current);
	}
	return batches;
}
//#endregion
//#region src/errors.ts
/** A deploy step failed. `status` and `code` come from the backend's problem response when it sent one. */
var DeployError = class extends Error {
	status;
	code;
	constructor(message, options = {}) {
		super(message, { cause: options.cause });
		this.name = "DeployError";
		this.status = options.status ?? null;
		this.code = options.code ?? null;
	}
};
//#endregion
//#region src/files.ts
/** Cloudflare's hard per-file limit for static assets. */
const MAX_STATIC_ASSET_BYTES = 26214400;
/** Every regular file under `root`, as posix paths relative to it, sorted. Symlinks are skipped. */
async function listFiles(root) {
	const found = [];
	async function walk(dir) {
		for (const entry of await readdir(dir, { withFileTypes: true })) {
			const absolute = join(dir, entry.name);
			if (entry.isDirectory()) await walk(absolute);
			else if (entry.isFile()) found.push(relative(root, absolute).split(sep).join("/"));
		}
	}
	await walk(root);
	return found.sort();
}
/** Hashes one file at a time, so memory stays at the size of the largest file. */
async function readStaticFiles(clientDir) {
	const files = [];
	for (const path of await listFiles(clientDir)) {
		const absolutePath = join(clientDir, path);
		const bytes = await readFile(absolutePath);
		if (bytes.byteLength > 26214400) throw new DeployError(`Static file ${path} is larger than 25 MB. Serve large media from R2 instead.`, { code: "validation.file_too_large" });
		files.push({
			path: `/${path}`,
			absolutePath,
			contentHash: createHash("sha256").update(bytes).digest("hex"),
			size: bytes.byteLength
		});
	}
	return files;
}
//#endregion
//#region src/tar.ts
const BLOCK = 512;
const NAME_BYTES = 100;
const PREFIX_BYTES = 155;
const encoder = new TextEncoder();
/** A gzipped ustar archive. Paths over 100 bytes are split into the ustar `prefix` field. */
function gzipTar(entries) {
	return new Uint8Array(gzipSync(tar(entries)));
}
function tar(entries) {
	const size = entries.reduce((total, entry) => total + BLOCK + Math.ceil(entry.bytes.byteLength / BLOCK) * BLOCK, 2 * BLOCK);
	const out = new Uint8Array(size);
	let offset = 0;
	for (const entry of entries) {
		out.set(header(entry.path, entry.bytes.byteLength), offset);
		offset += BLOCK;
		out.set(entry.bytes, offset);
		offset += Math.ceil(entry.bytes.byteLength / BLOCK) * BLOCK;
	}
	return out;
}
function header(path, size) {
	const { name, prefix } = splitPath(path);
	const block = new Uint8Array(BLOCK);
	writeBytes(block, 0, name);
	writeOctal(block, 100, 8, 420);
	writeOctal(block, 108, 8, 0);
	writeOctal(block, 116, 8, 0);
	writeOctal(block, 124, 12, size);
	writeOctal(block, 136, 12, 0);
	block.fill(32, 148, 156);
	block[156] = 48;
	writeBytes(block, 257, encoder.encode("ustar\0"));
	writeBytes(block, 263, encoder.encode("00"));
	writeBytes(block, 345, prefix);
	const checksum = block.reduce((total, byte) => total + byte, 0);
	writeBytes(block, 148, encoder.encode(`${checksum.toString(8).padStart(6, "0")}\0 `));
	return block;
}
function splitPath(path) {
	const whole = encoder.encode(path);
	if (whole.byteLength <= NAME_BYTES) return {
		name: whole,
		prefix: /* @__PURE__ */ new Uint8Array()
	};
	for (let index = path.lastIndexOf("/"); index > 0; index = path.lastIndexOf("/", index - 1)) {
		const prefix = encoder.encode(path.slice(0, index));
		const name = encoder.encode(path.slice(index + 1));
		if (prefix.byteLength <= PREFIX_BYTES && name.byteLength <= NAME_BYTES && name.byteLength > 0) return {
			name,
			prefix
		};
	}
	throw new DeployError(`Path ${path} is too long for a tar archive.`, { code: "validation.failed" });
}
function writeBytes(block, offset, bytes) {
	block.set(bytes, offset);
}
function writeOctal(block, offset, length, value) {
	writeBytes(block, offset, encoder.encode(`${value.toString(8).padStart(length - 1, "0")}\0`));
}
//#endregion
//#region src/deploy.ts
const DEFAULT_API_ORIGIN = "https://backend.embeddables.com";
const DEFAULT_CONCURRENCY = 3;
const REQUEST_ATTEMPTS = 3;
/**
* Uploads a built app in three steps: a manifest of static files, the files
* the backend does not already have (in parallel batches), then the server
* modules. The same commit can be redeployed safely; unchanged files upload
* nothing.
*/
async function deployHostingApp(options) {
	const api = createApi(options);
	const idempotencyKey = randomUUID();
	const files = options.clientDir ? await readStaticFiles(options.clientDir) : [];
	const server = await readServerArchive(options.serverDir);
	const manifest = {};
	const byHash = /* @__PURE__ */ new Map();
	for (const file of files) {
		manifest[file.path] = {
			contentHash: file.contentHash,
			size: file.size
		};
		if (!byHash.has(file.contentHash)) byHash.set(file.contentHash, {
			absolutePath: file.absolutePath,
			size: file.size
		});
	}
	const session = await api.retryingJson("/hosting/v1/deploys/sessions", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"idempotency-key": idempotencyKey
		},
		body: JSON.stringify({
			appSlug: options.appSlug,
			branch: options.branch,
			sha: options.sha,
			committedAt: options.committedAt,
			manifest
		})
	});
	const sizes = new Map([...byHash].map(([hash, file]) => [hash, file.size]));
	const batches = planBatches(session.buckets, sizes);
	const batchPath = `/hosting/v1/deploys/sessions/${encodeURIComponent(session.sessionId)}/assets`;
	await runPool(batches, options.concurrency ?? DEFAULT_CONCURRENCY, async (batch) => {
		const form = new FormData();
		for (const hash of batch) {
			const file = byHash.get(hash);
			form.append(hash, new Blob([await readFile(file.absolutePath)]), hash);
		}
		await api.retrying(batchPath, {
			method: "POST",
			body: form
		});
	});
	return {
		...await api.retryingJson(`/hosting/v1/deploys/sessions/${encodeURIComponent(session.sessionId)}/finalize`, {
			method: "POST",
			headers: { "content-type": "application/gzip" },
			body: server
		}),
		totalFiles: files.length,
		uploadedFiles: batches.reduce((total, batch) => total + batch.length, 0)
	};
}
async function readServerArchive(serverDir) {
	const paths = await listFiles(serverDir);
	if (paths.length === 0) throw new DeployError(`No server modules found in ${serverDir}.`, { code: "validation.failed" });
	return gzipTar(await Promise.all(paths.map(async (path) => ({
		path: `server/${path}`,
		bytes: new Uint8Array(await readFile(join(serverDir, path)))
	}))));
}
function createApi(options) {
	const origin = (options.apiOrigin ?? "https://backend.embeddables.com").replace(/\/+$/, "");
	const fetchImpl = options.fetch ?? fetch;
	const sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
	const auth = { authorization: `Bearer ${options.deployKey}` };
	if (options.projectId) auth["x-project-id"] = options.projectId;
	async function send(path, init) {
		let response;
		try {
			response = await fetchImpl(`${origin}${path}`, {
				...init,
				headers: {
					...auth,
					...init.headers
				}
			});
		} catch (cause) {
			throw new DeployError(`Could not reach ${origin}.`, { cause });
		}
		if (!response.ok) throw await problem(response);
		return response;
	}
	return {
		/** Retries network failures, 429, and 5xx for retry-safe deploy operations. */
		async retrying(path, init) {
			for (let attempt = 1;; attempt++) try {
				return await send(path, init);
			} catch (error) {
				const status = error instanceof DeployError ? error.status : null;
				if (!(status === null || status === 429 || status >= 500) || attempt >= REQUEST_ATTEMPTS) throw error;
				await sleep(500 * 3 ** (attempt - 1));
			}
		},
		async retryingJson(path, init) {
			return await (await this.retrying(path, init)).json();
		}
	};
}
async function problem(response) {
	let body = {};
	try {
		body = await response.json();
	} catch {}
	const detail = typeof body.detail === "string" ? body.detail : null;
	const title = typeof body.title === "string" ? body.title : null;
	return new DeployError(detail ?? title ?? `Deploy request failed with ${response.status}.`, {
		status: response.status,
		code: typeof body.code === "string" ? body.code : void 0
	});
}
async function runPool(items, concurrency, task) {
	let next = 0;
	let failure = null;
	const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
		while (!failure && next < items.length) try {
			await task(items[next++]);
		} catch (error) {
			failure ??= { error };
		}
	});
	await Promise.all(workers);
	if (failure) throw failure.error;
}
//#endregion
export { DEFAULT_API_ORIGIN, DeployError, MAX_STATIC_ASSET_BYTES, deployHostingApp };

