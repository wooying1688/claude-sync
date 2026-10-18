#!/usr/bin/env node
// claude-sync — multi-machine sync for Claude Code config, with reviewable sync logs.
// Zero dependencies. Node 18+.

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
	createCipheriv,
	createDecipheriv,
	createHash,
	createHmac,
	hkdfSync,
	randomBytes,
	randomUUID,
	scryptSync,
} from "node:crypto";
import { execFileSync } from "node:child_process";
import * as readline from "node:readline/promises";

const HOME = os.homedir();
// Claude Code honors CLAUDE_CONFIG_DIR for non-default config locations.
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR
	? path.resolve(process.env.CLAUDE_CONFIG_DIR)
	: path.join(HOME, ".claude");
const TOOL_DIR = process.env.CLAUDE_SYNC_DIR
	? path.resolve(process.env.CLAUDE_SYNC_DIR)
	: path.join(HOME, ".claude-sync");
const CONFIG_PATH = path.join(TOOL_DIR, "config.json");
const BACKUP_DIR = path.join(TOOL_DIR, "backups");
const GIT_STORE = path.join(TOOL_DIR, "store");
const HOME_TOKEN = "{{HOME}}";

// ---------------------------------------------------------------- manifest

// Only these ever leave the machine. Payload dirs are deliberately absent:
// plugins/ content is rebuilt from known_marketplaces.json on each machine.
const INCLUDE = [
	"settings.json",
	"CLAUDE.md",
	"keybindings.json",
	"commands/**",
	"agents/**",
	"hooks/**",
	"skills/**",
	"plugins/known_marketplaces.json",
	"plugins/installed_plugins.json",
	"plugins/plugin-directory-bindings.json",
	"projects/*/memory/**",
];

// Denylist always wins over INCLUDE.
const EXCLUDE = [
	// secrets / auth — never sync
	".credentials.json",
	"**/.credentials.json",
	"mcp-needs-auth-cache.json",
	"**/auth.json",
	"**/*credential*",
	"**/*.pem",
	"**/*.key",
	"**/.env",
	"**/.env.*",
	// auto-managed buckets (re-downloaded by Claude Code itself)
	"skills/synced/**",
	"plugins/synced/**",
	"plugins/data/**",
	// bulk / machine-local / ephemeral
	"cache/**",
	"backups/**",
	"downloads/**",
	"session-env/**",
	"sessions/**",
	"shell-snapshots/**",
	"file-history/**",
	"ide/**",
	"state/**",
	".last-cleanup",
	"plugins/cache/**",
	"plugins/marketplaces/**",
	"plugins/.last_inuse_sweep",
	"plugins/*cache*.json",
	// generic junk
	"**/node_modules/**",
	"**/.git/**",
	"**/__pycache__/**",
	"**/*.pyc",
	"**/*.log",
	"**/*.sqlite",
	"**/*.sqlite3",
	"**/*.db",
	"**/.DS_Store",
];

// Transcripts are opt-in: large, unmergeable, and contain full conversation text.
const TRANSCRIPTS = ["projects/*/*.jsonl"];

// Files whose absolute paths get tokenized so they port across machines.
const REWRITE = new Set(["settings.json", "keybindings.json"]);

function ruleToRegex(rule) {
	let out = "";
	for (let i = 0; i < rule.length; i++) {
		const c = rule[i];
		if (c === "*") {
			if (rule[i + 1] === "*") {
				out += ".*";
				i++;
				if (rule[i + 1] === "/") i++;
			} else {
				out += "[^/]*";
			}
		} else if (c === "?") out += "[^/]";
		else out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	}
	return new RegExp(`^${out}$`, "i");
}

const INCLUDE_RE = INCLUDE.map(ruleToRegex);
const EXCLUDE_RE = EXCLUDE.map(ruleToRegex);
const TRANSCRIPT_RE = TRANSCRIPTS.map(ruleToRegex);

function classify(rel, { transcripts }) {
	if (EXCLUDE_RE.some((re) => re.test(rel))) return { sync: false, reason: "excluded" };
	if (TRANSCRIPT_RE.some((re) => re.test(rel)))
		return transcripts ? { sync: true } : { sync: false, reason: "transcript (opt-in)" };
	if (INCLUDE_RE.some((re) => re.test(rel))) return { sync: true };
	return { sync: false, reason: "not in allowlist" };
}

// ---------------------------------------------------------------- secrets

// Fail-closed: a file tripping these is skipped, never written to the store.
const SECRET_PATTERNS = [
	[/\bsk-ant-[A-Za-z0-9_-]{16,}/, "Anthropic API key"],
	[/\bsk-[A-Za-z0-9]{32,}/, "OpenAI-style API key"],
	[/\bnvapi-[A-Za-z0-9_-]{16,}/, "NVIDIA API key"],
	[/\bgh[pousr]_[A-Za-z0-9]{20,}/, "GitHub token"],
	[/\bxox[abprs]-[A-Za-z0-9-]{10,}/, "Slack token"],
	[/\bAKIA[0-9A-Z]{16}\b/, "AWS access key id"],
	[/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "private key"],
	[/\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\./, "JWT"],
	[/"(?:access|refresh|id)_token"\s*:\s*"[^"]{16,}"/i, "OAuth token field"],
];

function scanSecrets(buf) {
	if (buf.includes(0)) return null; // binary
	const text = buf.toString("utf8");
	for (const [re, label] of SECRET_PATTERNS) {
		const m = re.exec(text);
		if (m) {
			const line = text.slice(0, m.index).split("\n").length;
			return { label, line };
		}
	}
	return null;
}

// ---------------------------------------------------------------- util

const log = {
	info: (m) => console.log(`  ${m}`),
	ok: (m) => console.log(`  \x1b[32m✔\x1b[0m ${m}`),
	warn: (m) => console.log(`  \x1b[33m⚠\x1b[0m ${m}`),
	err: (m) => console.error(`  \x1b[31m✖\x1b[0m ${m}`),
	dim: (m) => console.log(`  \x1b[2m${m}\x1b[0m`),
	head: (m) => console.log(`\n\x1b[1m${m}\x1b[0m`),
};

function fail(message) {
	log.err(message);
	process.exit(1);
}

function toPosix(p) {
	return p.split(path.sep).join("/");
}

function sha256(buf) {
	return createHash("sha256").update(buf).digest("hex").slice(0, 16);
}

function walk(root, rel = "") {
	const abs = path.join(root, rel);
	let entries;
	try {
		entries = fs.readdirSync(abs, { withFileTypes: true });
	} catch {
		return [];
	}
	const out = [];
	for (const e of entries) {
		const childRel = rel ? `${rel}/${e.name}` : e.name;
		if (e.isDirectory()) out.push(...walk(root, childRel));
		else if (e.isFile()) out.push(childRel);
	}
	return out;
}

function writeAtomic(dest, buf) {
	fs.mkdirSync(path.dirname(dest), { recursive: true });
	const tmp = `${dest}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, buf);
	fs.renameSync(tmp, dest);
}

function readIfExists(p) {
	try {
		return fs.readFileSync(p);
	} catch {
		return null;
	}
}

// Home paths appear in three incompatible spellings, and collapsing them into one
// token loses the information needed to rebuild a *valid* file on the other OS:
// a bare "\" is not a legal JSON escape, so Windows->macOS must not emit one.
const IS_WIN = path.sep === "\\";
const T_JSONWIN = "{{HOME_JSONWIN}}"; // C:\\Users\x  — backslashes escaped for JSON
const T_WIN = "{{HOME_WIN}}"; // C:\Users\x   — raw backslashes
const T_POSIX = "{{HOME_POSIX}}"; // C:/Users/x   — forward slashes (valid everywhere)

const homeJsonWin = HOME.split(path.sep).join("\\\\");
const homePosix = toPosix(HOME);

function tokenize(buf) {
	let t = buf.toString("utf8");
	t = t.split(homeJsonWin).join(T_JSONWIN); // must precede the raw form
	if (IS_WIN) t = t.split(HOME).join(T_WIN);
	t = t.split(homePosix).join(T_POSIX);
	return Buffer.from(t, "utf8");
}

function detokenize(buf) {
	let t = buf.toString("utf8");
	// On a POSIX host every spelling resolves to the forward-slash home.
	t = t.split(T_JSONWIN).join(IS_WIN ? homeJsonWin : homePosix);
	t = t.split(T_WIN).join(IS_WIN ? HOME : homePosix);
	t = t.split(T_POSIX).join(homePosix);
	t = t.split(HOME_TOKEN).join(homePosix); // stores written before v1 tokens
	return Buffer.from(t, "utf8");
}

// ---------------------------------------------------------------- crypto

// Envelope encryption: a random 32-byte data key encrypts the files, and a
// passphrase-derived key encrypts the data key. The wrapped data key lives in
// the store, so any machine that knows the passphrase can read what the others
// wrote, and the passphrase can change without re-encrypting every file.
const KDF_DEFAULTS = { name: "scrypt", N: 1 << 16, r: 8, p: 1, keyLen: 32 };
const SCRYPT_MAXMEM = 256 * 1024 * 1024; // N=2^16,r=8 needs ~64MB; Node defaults to 32MB
const AAD_KEYRING = Buffer.from("claude-sync/keyring/v1");
const AAD_LOG = Buffer.from("claude-sync/log/v1");
const IV_LEN = 12;
const TAG_LEN = 16;

function deriveKek(passphrase, salt, kdf = KDF_DEFAULTS) {
	if (kdf.name !== "scrypt") fail(`unsupported key-derivation function in store: ${kdf.name}`);
	// NFKC so the same typed passphrase derives the same key on every platform.
	return scryptSync(passphrase.normalize("NFKC"), salt, kdf.keyLen ?? 32, {
		N: kdf.N,
		r: kdf.r,
		p: kdf.p,
		maxmem: SCRYPT_MAXMEM,
	});
}

// Separate keys for content and for filename HMACs, so one never doubles as the other.
function subkey(dataKey, label) {
	return Buffer.from(hkdfSync("sha256", dataKey, Buffer.alloc(0), Buffer.from(label), 32));
}

function seal(key, plaintext, aad) {
	const iv = randomBytes(IV_LEN); // fresh per write — never reused with this key
	const cipher = createCipheriv("aes-256-gcm", key, iv);
	if (aad) cipher.setAAD(aad);
	const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
	return Buffer.concat([iv, cipher.getAuthTag(), ct]);
}

function unseal(key, blob, aad) {
	if (blob.length < IV_LEN + TAG_LEN) throw new Error("ciphertext is truncated");
	const decipher = createDecipheriv("aes-256-gcm", key, blob.subarray(0, IV_LEN));
	if (aad) decipher.setAAD(aad);
	decipher.setAuthTag(blob.subarray(IV_LEN, IV_LEN + TAG_LEN));
	// Throws if the key is wrong or a single byte was altered.
	return Buffer.concat([decipher.update(blob.subarray(IV_LEN + TAG_LEN)), decipher.final()]);
}

function keyringPath(cfg) {
	return path.join(storeDir(cfg), "keyring.json");
}

function createKeyring(passphrase) {
	const salt = randomBytes(16);
	const dataKey = randomBytes(32);
	const kek = deriveKek(passphrase, salt);
	return {
		keyring: {
			v: 1,
			kdf: { ...KDF_DEFAULTS, salt: salt.toString("base64") },
			wrapped: seal(kek, dataKey, AAD_KEYRING).toString("base64"),
		},
		dataKey,
	};
}

function unwrapKeyring(keyring, passphrase) {
	const { salt, ...kdf } = keyring.kdf;
	const kek = deriveKek(passphrase, Buffer.from(salt, "base64"), kdf);
	try {
		return unseal(kek, Buffer.from(keyring.wrapped, "base64"), AAD_KEYRING);
	} catch {
		fail("wrong passphrase for this store (nothing was changed)");
	}
}

// Deterministic so the same file maps to the same store entry on every machine
// and every run; keyed so the store never reveals which files you have.
function blobName(pathKey, rel) {
	return `${createHmac("sha256", pathKey).update(rel, "utf8").digest("hex")}.bin`;
}

// [uint16 relLen][rel][content] — the real path travels inside the ciphertext.
function packEntry(rel, content) {
	const relBuf = Buffer.from(rel, "utf8");
	if (relBuf.length > 0xffff) fail(`path too long to encrypt: ${rel}`);
	const header = Buffer.alloc(2);
	header.writeUInt16BE(relBuf.length, 0);
	return Buffer.concat([header, relBuf, content]);
}

function unpackEntry(buf) {
	const relLen = buf.readUInt16BE(0);
	return { rel: buf.subarray(2, 2 + relLen).toString("utf8"), content: buf.subarray(2 + relLen) };
}

const dataKeyCachePath = () => path.join(TOOL_DIR, "datakey");

async function hiddenPrompt(label) {
	if (!process.stdin.isTTY) fail("a passphrase is required; set CLAUDE_SYNC_PASSPHRASE or run in a terminal");
	process.stdout.write(label);
	process.stdin.setRawMode(true);
	process.stdin.resume();
	process.stdin.setEncoding("utf8");
	let value = "";
	try {
		return await new Promise((resolve, reject) => {
			const onData = (chunk) => {
				for (const ch of chunk) {
					if (ch === "\u0003") {
						process.stdin.off("data", onData);
						reject(new Error("cancelled"));
						return;
					}
					if (ch === "\r" || ch === "\n") {
						process.stdin.off("data", onData);
						resolve(value);
						return;
					}
					if (ch === "\u007f" || ch === "\b") {
						if (value.length) {
							value = value.slice(0, -1);
							process.stdout.write("\b \b");
						}
						continue;
					}
					value += ch;
					process.stdout.write("•");
				}
			};
			process.stdin.on("data", onData);
		});
	} finally {
		process.stdin.setRawMode(false);
		process.stdin.pause();
		process.stdout.write("\n");
	}
}

// Resolve the data key: cached locally, else from the passphrase (env or prompt).
async function resolveKeys(cfg, { confirm = false, askPassphrase = hiddenPrompt } = {}) {
	if (!cfg.encryption?.enabled) return null;

	const cached = readIfExists(dataKeyCachePath());
	if (cached && cached.length === 32) return expandKeys(cached);

	const raw = readIfExists(keyringPath(cfg));
	let dataKey;
	if (raw) {
		const passphrase = process.env.CLAUDE_SYNC_PASSPHRASE || (await askPassphrase("Passphrase for this store: "));
		if (!passphrase) fail("no passphrase given");
		dataKey = unwrapKeyring(JSON.parse(raw.toString("utf8")), passphrase);
	} else {
		// First encrypted push: mint the keyring.
		let passphrase = process.env.CLAUDE_SYNC_PASSPHRASE;
		if (!passphrase) {
			passphrase = await askPassphrase("Choose a passphrase for this store: ");
			if (!passphrase) fail("no passphrase given");
			if (confirm) {
				const again = await askPassphrase("Confirm passphrase: ");
				if (again !== passphrase) fail("passphrases did not match");
			}
		}
		if (passphrase.length < 8) fail("use a passphrase of at least 8 characters");
		const created = createKeyring(passphrase);
		fs.mkdirSync(path.dirname(keyringPath(cfg)), { recursive: true });
		writeAtomic(keyringPath(cfg), Buffer.from(`${JSON.stringify(created.keyring, null, 2)}\n`, "utf8"));
		dataKey = created.dataKey;
		log.dim("created an encrypted store — keep this passphrase, it cannot be recovered");
	}

	// Cached so routine push/pull do not re-prompt. This is no weaker than the
	// plaintext config already sitting in ~/.claude: it guards the cloud copy,
	// not this machine.
	writeAtomic(dataKeyCachePath(), dataKey);
	try {
		fs.chmodSync(dataKeyCachePath(), 0o600);
	} catch {}
	return expandKeys(dataKey);
}

function expandKeys(dataKey) {
	return {
		dataKey,
		content: subkey(dataKey, "claude-sync/content/v1"),
		paths: subkey(dataKey, "claude-sync/paths/v1"),
		log: subkey(dataKey, "claude-sync/log/v1"),
	};
}

// ---------------------------------------------------------------- store access

function storeMetaPath(cfg) {
	return path.join(storeDir(cfg), "store.json");
}

function readStoreMeta(cfg) {
	const raw = readIfExists(storeMetaPath(cfg));
	return raw ? JSON.parse(raw.toString("utf8")) : null;
}

function writeStoreMeta(cfg) {
	if (readStoreMeta(cfg)) return;
	writeAtomic(
		storeMetaPath(cfg),
		Buffer.from(`${JSON.stringify({ version: 1, encrypted: !!cfg.encryption?.enabled }, null, 2)}\n`, "utf8"),
	);
}

// Refuse to read an encrypted store as plaintext, or vice versa.
function assertStoreMatchesConfig(cfg) {
	const meta = readStoreMeta(cfg);
	if (!meta) return;
	const wantEncrypted = !!cfg.encryption?.enabled;
	if (meta.encrypted === wantEncrypted) return;
	fail(
		meta.encrypted
			? "this store is encrypted, but encryption is off locally — re-run init with --encrypt"
			: "this store is NOT encrypted, but encryption is on locally — use a new store, or re-run init without --encrypt",
	);
}

// One interface over both layouts, so push/pull/status need no crypto awareness.
function openStore(cfg, keys) {
	const root = storeDir(cfg);
	if (!keys) {
		const base = path.join(root, "payload", "claude");
		return {
			readAll() {
				const map = new Map();
				for (const rel of walk(base)) {
					const buf = readIfExists(path.join(base, rel));
					if (buf) map.set(rel, buf);
				}
				return map;
			},
			write(rel, buf) {
				writeAtomic(path.join(base, rel), buf);
			},
		};
	}

	const base = path.join(root, "payload");
	return {
		readAll() {
			const map = new Map();
			for (const name of walk(base)) {
				if (!name.endsWith(".bin")) continue;
				const blob = readIfExists(path.join(base, name));
				if (!blob) continue;
				let plain;
				try {
					plain = unseal(keys.content, blob, Buffer.from(name));
				} catch {
					log.warn(`skipping unreadable store entry ${name} (wrong key or tampered)`);
					continue;
				}
				const { rel, content } = unpackEntry(plain);
				map.set(rel, Buffer.from(content));
			}
			return map;
		},
		write(rel, buf) {
			const name = blobName(keys.paths, rel);
			writeAtomic(path.join(base, name), seal(keys.content, packEntry(rel, buf), Buffer.from(name)));
		},
	};
}

// ---------------------------------------------------------------- config

function loadConfig({ required = true } = {}) {
	const raw = readIfExists(CONFIG_PATH);
	if (!raw) {
		if (required) fail("Not configured yet. Run: claude-sync init --help");
		return null;
	}
	return JSON.parse(raw.toString("utf8"));
}

function saveConfig(cfg) {
	writeAtomic(CONFIG_PATH, Buffer.from(`${JSON.stringify(cfg, null, 2)}\n`, "utf8"));
}

function storeDir(cfg) {
	return cfg.backend.type === "git" ? GIT_STORE : cfg.backend.path;
}

function payloadDir(cfg) {
	return path.join(storeDir(cfg), "payload", "claude");
}

// ---------------------------------------------------------------- backends

function git(args, cwd) {
	return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

// Supplied per-command so the store can commit on a machine with no global
// git identity, without ever writing to the user's own git config.
function gitIdentity(cwd) {
	const configured = (key) => {
		try {
			return !!git(["config", "--get", key], cwd);
		} catch {
			return false;
		}
	};
	const args = [];
	if (!configured("user.name")) args.push("-c", "user.name=claude-sync");
	if (!configured("user.email")) args.push("-c", "user.email=claude-sync@localhost");
	return args;
}

const backends = {
	folder: {
		prepare(cfg) {
			const dir = storeDir(cfg);
			if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
			return { reachable: true };
		},
		refresh() {},
		finalize() {
			log.dim("folder backend: your cloud client (Dropbox/OneDrive/Drive/Box) uploads from here");
		},
	},
	git: {
		prepare(cfg) {
			if (!fs.existsSync(path.join(GIT_STORE, ".git"))) {
				fs.mkdirSync(GIT_STORE, { recursive: true });
				git(["init", "-q", "-b", "main"], GIT_STORE);
				if (cfg.backend.remote) git(["remote", "add", "origin", cfg.backend.remote], GIT_STORE);
				writeAtomic(path.join(GIT_STORE, ".gitattributes"), Buffer.from("* text=auto eol=lf\n"));
			}
			return { reachable: true };
		},
		refresh(cfg) {
			if (!cfg.backend.remote) return;
			try {
				git(["fetch", "origin", "main"], GIT_STORE);
				git(["reset", "--hard", "FETCH_HEAD"], GIT_STORE);
			} catch (e) {
				log.warn(`could not fetch from remote: ${firstLine(e)}`);
			}
		},
		finalize(cfg, message) {
			// Explicit pathspecs only — never a bare `git add .`. -A so deletions
			// are staged too, and only for paths this tool owns.
			const owned = ["payload", "logs", ".gitattributes"].filter((p) => fs.existsSync(path.join(GIT_STORE, p)));
			if (owned.length) git(["add", "-A", "--", ...owned], GIT_STORE);
			if (!git(["diff", "--cached", "--name-only"], GIT_STORE)) {
				log.dim("git backend: nothing to commit");
				return;
			}
			git([...gitIdentity(GIT_STORE), "commit", "-q", "-m", message], GIT_STORE);
			if (!cfg.backend.remote) {
				log.warn("no remote configured — commit is local only");
				return;
			}
			try {
				git(["push", "-q", "-u", "origin", "main"], GIT_STORE);
				log.ok("pushed to remote");
			} catch (e) {
				log.warn(`push failed: ${firstLine(e)}`);
			}
		},
	},
};

function firstLine(e) {
	return String(e.stderr || e.message || e).trim().split("\n")[0];
}

// ---------------------------------------------------------------- sync log

function logPath(cfg) {
	return path.join(storeDir(cfg), "logs", "sync-log.jsonl");
}

// Each line is independent, so appending stays safe from several machines, and
// an encrypted log can still be appended to without rewriting what is there.
function appendLog(cfg, entry, keys) {
	const p = logPath(cfg);
	fs.mkdirSync(path.dirname(p), { recursive: true });
	const json = JSON.stringify(entry);
	const line = keys ? seal(keys.log, Buffer.from(json, "utf8"), AAD_LOG).toString("base64") : json;
	fs.appendFileSync(p, `${line}\n`, "utf8");
}

function readLog(cfg, keys) {
	const raw = readIfExists(logPath(cfg));
	if (!raw) return [];
	const out = [];
	for (const line of raw.toString("utf8").split("\n")) {
		if (!line.trim()) continue;
		try {
			if (keys) out.push(JSON.parse(unseal(keys.log, Buffer.from(line, "base64"), AAD_LOG).toString("utf8")));
			else out.push(JSON.parse(line));
		} catch {
			out.push({ id: "????????", op: "?", machine: "(unreadable)", at: new Date(0).toISOString(), counts: {}, files: [] });
		}
	}
	return out;
}

// ---------------------------------------------------------------- engine

function localFiles(cfg) {
	const opts = { transcripts: !!cfg.include?.transcripts };
	const out = [];
	for (const rel of walk(CLAUDE_DIR)) {
		const verdict = classify(rel, opts);
		if (verdict.sync) out.push(rel);
	}
	return out.sort();
}

function doPush(cfg, keys, { dryRun }) {
	backends[cfg.backend.type].prepare(cfg);
	assertStoreMatchesConfig(cfg);
	const store = openStore(cfg, keys);
	const current = store.readAll();
	const actions = [];

	for (const rel of localFiles(cfg)) {
		let buf = readIfExists(path.join(CLAUDE_DIR, rel));
		if (!buf) continue;

		const secret = scanSecrets(buf);
		if (secret) {
			actions.push({ file: rel, action: "skipped", reason: `${secret.label} at line ${secret.line}` });
			continue;
		}
		if (REWRITE.has(rel)) buf = tokenize(buf);

		const existing = current.get(rel);
		if (existing && sha256(existing) === sha256(buf)) {
			actions.push({ file: rel, action: "unchanged" });
			continue;
		}
		if (!dryRun) store.write(rel, buf);
		actions.push({ file: rel, action: existing ? "updated" : "added", bytes: buf.length });
	}
	if (!dryRun) writeStoreMeta(cfg);
	return actions;
}

function doPull(cfg, keys, { dryRun, prune }) {
	backends[cfg.backend.type].prepare(cfg);
	backends[cfg.backend.type].refresh(cfg);
	assertStoreMatchesConfig(cfg);

	const incoming = openStore(cfg, keys).readAll();
	if (!incoming.size) fail("the store has no files yet — run push on the machine you want to copy from");

	const actions = [];
	const backupId = new Date().toISOString().replace(/[:.]/g, "-");
	const backupRoot = path.join(BACKUP_DIR, backupId);

	for (const rel of [...incoming.keys()].sort()) {
		let buf = incoming.get(rel);
		if (REWRITE.has(rel)) buf = detokenize(buf);

		const target = path.join(CLAUDE_DIR, rel);
		const existing = readIfExists(target);
		if (existing && sha256(existing) === sha256(buf)) {
			actions.push({ file: rel, action: "unchanged" });
			continue;
		}
		if (!dryRun) {
			if (existing) writeAtomic(path.join(backupRoot, rel), existing);
			writeAtomic(target, buf);
		}
		actions.push({ file: rel, action: existing ? "updated" : "added", bytes: buf.length });
	}

	if (prune) {
		for (const rel of localFiles(cfg)) {
			if (incoming.has(rel)) continue;
			if (!dryRun) {
				const existing = readIfExists(path.join(CLAUDE_DIR, rel));
				if (existing) writeAtomic(path.join(backupRoot, rel), existing);
				fs.rmSync(path.join(CLAUDE_DIR, rel), { force: true });
			}
			actions.push({ file: rel, action: "deleted" });
		}
	}

	const touched = actions.some((a) => a.action !== "unchanged");
	return { actions, backupId: touched && !dryRun ? backupId : null };
}

function summarize(actions) {
	const counts = {};
	for (const a of actions) counts[a.action] = (counts[a.action] || 0) + 1;
	return counts;
}

function printActions(actions, { verbose }) {
	const counts = summarize(actions);
	const parts = Object.entries(counts).map(([k, v]) => `${v} ${k}`);
	log.info(parts.length ? parts.join(", ") : "no files matched");
	const notable = actions.filter((a) => a.action !== "unchanged");
	for (const a of verbose ? actions : notable) {
		const tag =
			a.action === "skipped"
				? `\x1b[33mskip\x1b[0m`
				: a.action === "deleted"
					? `\x1b[31mdel \x1b[0m`
					: a.action === "unchanged"
						? `\x1b[2msame\x1b[0m`
						: `\x1b[32m${a.action === "added" ? "add " : "upd "}\x1b[0m`;
		log.dim(`  ${tag} ${a.file}${a.reason ? `  — ${a.reason}` : ""}`);
	}
	const skipped = actions.filter((a) => a.action === "skipped");
	if (skipped.length) log.warn(`${skipped.length} file(s) withheld — secret-like content, not synced`);
}

// ------------------------------------------------- storage discovery / setup

// Candidate locations for the store. Anything the OS already syncs for you is a
// valid home for the files; nothing here needs an API key or an OAuth flow.
export function detectStores() {
	const candidates = [
		["OneDrive", process.env.OneDrive, process.env.OneDriveConsumer, process.env.OneDriveCommercial, path.join(HOME, "OneDrive")],
		["Dropbox", process.env.DROPBOX, path.join(HOME, "Dropbox")],
		["Google Drive", path.join(HOME, "Google Drive"), path.join(HOME, "GoogleDrive"), path.join(HOME, "My Drive"), "G:\\My Drive"],
		["Box", path.join(HOME, "Box"), path.join(HOME, "Box Sync")],
		["iCloud Drive", path.join(HOME, "Library", "Mobile Documents", "com~apple~CloudDocs")],
	];

	const found = [];
	const seen = new Set();
	for (const [label, ...paths] of candidates) {
		for (const p of paths) {
			if (!p) continue;
			const resolved = path.resolve(p);
			if (seen.has(resolved) || !fs.existsSync(resolved)) continue;
			seen.add(resolved);
			found.push({ label, path: resolved });
			break;
		}
	}

	// macOS puts every mounted cloud provider under one roof.
	const cloudStorage = path.join(HOME, "Library", "CloudStorage");
	if (fs.existsSync(cloudStorage)) {
		for (const name of fs.readdirSync(cloudStorage)) {
			const resolved = path.join(cloudStorage, name);
			if (seen.has(resolved)) continue;
			seen.add(resolved);
			found.push({ label: name.replace(/-.*$/, ""), path: resolved });
		}
	}
	return found;
}

// `ask` is injected by the tests; the CLI builds a readline-backed one.
export async function interactiveInit(ask) {
	let rl = null;
	if (!ask) {
		if (!process.stdin.isTTY || !process.stdout.isTTY) {
			log.err("init needs an interactive terminal to ask where to store your files.");
			log.info("");
			log.info("Run it in your own terminal, or pass the location directly:");
			log.info('  claude-sync init --backend folder --path "<dir your cloud drive syncs>"');
			log.info("  claude-sync init --backend git --remote <git-url>");
			process.exit(1);
		}
		rl = readline.createInterface({ input: process.stdin, output: process.stdout });
		ask = (q) => rl.question(q);
	}

	try {
		console.log("\n\x1b[1mWhere should your Claude Code files be stored?\x1b[0m");
		log.dim("Any folder your cloud client already syncs works — no API keys, no sign-in.\n");

		const detected = detectStores();
		const choices = detected.map((d) => ({
			...d,
			kind: "folder",
			shown: `${d.label}  \x1b[2m${path.join(d.path, "claude-sync")}\x1b[0m`,
		}));
		choices.push({ kind: "folder", shown: "Another folder (NAS, USB drive, any path I type)" });
		choices.push({ kind: "git", shown: "A git repo (GitHub/GitLab — full history and diffs)" });

		choices.forEach((c, i) => console.log(`  ${i + 1}) ${c.shown}`));
		if (!detected.length) log.dim("\n  (no cloud drives auto-detected on this machine)");

		let pick = null;
		while (!pick) {
			const answer = (await ask(`\nChoose 1-${choices.length}: `)).trim();
			const n = Number(answer);
			if (Number.isInteger(n) && n >= 1 && n <= choices.length) pick = choices[n - 1];
			else log.warn(`enter a number between 1 and ${choices.length}`);
		}

		let backend;
		if (pick.kind === "git") {
			let url = "";
			while (!url) {
				url = (await ask("Git remote URL (blank = keep the store local for now): ")).trim();
				if (!url) {
					log.dim("no remote — the store will be a local git repo; attach one later with: claude-sync remote --url <url>");
					break;
				}
			}
			backend = { type: "git", remote: url || null };
		} else {
			let dir = pick.path ? path.join(pick.path, "claude-sync") : "";
			if (!dir) {
				while (!dir) dir = (await ask("Folder to store your Claude files in: ")).trim();
			} else {
				const confirm = (await ask(`Store at ${dir}? [Y/n] `)).trim().toLowerCase();
				if (confirm === "n" || confirm === "no") {
					dir = "";
					while (!dir) dir = (await ask("Folder to store your Claude files in: ")).trim();
				}
			}
			backend = { type: "folder", path: path.resolve(dir.replace(/^~(?=[/\\])/, HOME)) };
		}

		const machineDefault = os.hostname();
		const machine = (await ask(`Name for this machine [${machineDefault}]: `)).trim() || machineDefault;

		log.dim("\nSession transcripts are your full conversation history: large, and not mergeable");
		log.dim("across machines. They are excluded unless you ask for them.");
		const wantTranscripts = (await ask("Include session transcripts? [y/N] ")).trim().toLowerCase();
		const transcripts = wantTranscripts === "y" || wantTranscripts === "yes";

		log.dim("\nEncryption scrambles the files before they leave this machine, so whoever");
		log.dim("holds the store — Dropbox, OneDrive, GitHub — only ever sees ciphertext.");
		log.dim("You will need the passphrase on every machine. It cannot be recovered.");
		const wantEncryption = (await ask("Encrypt the stored files? [Y/n] ")).trim().toLowerCase();
		const encrypt = !(wantEncryption === "n" || wantEncryption === "no");

		return { backend, machine, transcripts, encrypt };
	} finally {
		if (rl) rl.close();
	}
}

// ---------------------------------------------------------------- commands

const commands = {
	async init(args) {
		const existing = loadConfig({ required: false });
		if (existing && !args.force)
			fail(`already configured (store: ${storeDir(existing)}). Re-run with --force to reconfigure.`);

		// No --backend means the user did not tell us where to put things, so ask.
		let chosen;
		if (!args.backend) {
			chosen = await interactiveInit();
		} else {
			const type = args.backend;
			if (!["folder", "git"].includes(type))
				fail('--backend must be "folder" (any synced drive or path) or "git"');
			if (type === "folder" && (!args.path || args.path === true))
				fail("--path is required for the folder backend");
			if (type === "git" && !args.remote) log.warn("no --remote given; the git store will stay local");
			chosen = {
				backend:
					type === "folder"
						? { type, path: path.resolve(String(args.path).replace(/^~(?=[/\\])/, HOME)) }
						: { type, remote: args.remote === true ? null : args.remote || null },
				machine: args.machine && args.machine !== true ? args.machine : os.hostname(),
				transcripts: !!args.transcripts,
				encrypt: !!args.encrypt,
			};
		}

		const cfg = {
			version: 1,
			backend: chosen.backend,
			machine: chosen.machine,
			include: { transcripts: chosen.transcripts },
			encryption: { enabled: !!chosen.encrypt, cipher: "aes-256-gcm", kdf: "scrypt" },
			created: new Date().toISOString(),
		};
		backends[cfg.backend.type].prepare(cfg);

		// An existing store decides the matter: joining an encrypted one requires
		// encryption, and vice versa.
		const meta = readStoreMeta(cfg);
		if (meta && meta.encrypted !== cfg.encryption.enabled) {
			cfg.encryption.enabled = meta.encrypted;
			log.warn(`this store is already ${meta.encrypted ? "encrypted" : "unencrypted"} — matching it`);
		}
		saveConfig(cfg);

		log.info("");
		log.ok(`storing your Claude files in: ${storeDir(cfg)}`);
		if (cfg.backend.type === "folder")
			log.dim("your cloud client syncs that folder — nothing else to set up");
		log.dim(`machine: ${cfg.machine}   transcripts: ${cfg.include.transcripts ? "included" : "excluded"}`);
		log.dim(`encryption: ${cfg.encryption.enabled ? "on (AES-256-GCM)" : "off"}`);
		log.dim(`config:  ${CONFIG_PATH}`);
		log.info("");
		log.info("Next:  claude-sync push          (send this machine's config to the store)");
		log.info("       claude-sync pull          (on your other machines)");
	},

	remote(args) {
		const cfg = loadConfig();
		if (cfg.backend.type !== "git") fail(`remote only applies to the git backend (current: ${cfg.backend.type})`);
		const url = args.url || args._url;
		if (!url || url === true) fail("usage: claude-sync remote --url <git-url>");
		backends.git.prepare(cfg);
		const existing = (() => {
			try {
				return git(["remote", "get-url", "origin"], GIT_STORE);
			} catch {
				return null;
			}
		})();
		git(existing ? ["remote", "set-url", "origin", url] : ["remote", "add", "origin", url], GIT_STORE);
		cfg.backend.remote = url;
		saveConfig(cfg);
		log.ok(`${existing ? "updated" : "added"} remote origin → ${url}`);
		log.info("Next: claude-sync push");
	},

	async push(args) {
		const cfg = loadConfig();
		const started = Date.now();
		backends[cfg.backend.type].prepare(cfg);
		const keys = await resolveKeys(cfg, { confirm: true });
		log.head(`Pushing from ${cfg.machine} → ${cfg.backend.type}${keys ? " (encrypted)" : ""}`);
		const actions = doPush(cfg, keys, { dryRun: args["dry-run"] });
		printActions(actions, { verbose: args.verbose });

		if (args["dry-run"]) {
			log.warn("dry run — nothing written");
			return;
		}
		const entry = {
			id: randomUUID().slice(0, 8),
			op: "push",
			machine: cfg.machine,
			at: new Date().toISOString(),
			backend: cfg.backend.type,
			durationMs: Date.now() - started,
			counts: summarize(actions),
			files: actions.filter((a) => a.action !== "unchanged"),
		};
		appendLog(cfg, entry, keys);
		backends[cfg.backend.type].finalize(cfg, `claude-sync push from ${cfg.machine} (${entry.id})`);
		cfg.lastPush = entry.at;
		saveConfig(cfg);
		log.ok(`push complete (${entry.id})`);
	},

	async pull(args) {
		const cfg = loadConfig();
		const started = Date.now();
		backends[cfg.backend.type].prepare(cfg);
		backends[cfg.backend.type].refresh(cfg);
		const keys = await resolveKeys(cfg);
		log.head(`Pulling into ${cfg.machine} ← ${cfg.backend.type}${keys ? " (encrypted)" : ""}`);
		const { actions, backupId } = doPull(cfg, keys, { dryRun: args["dry-run"], prune: args.prune });
		printActions(actions, { verbose: args.verbose });

		if (args["dry-run"]) {
			log.warn("dry run — nothing written");
			return;
		}
		if (backupId) log.dim(`backup: ${path.join(BACKUP_DIR, backupId)}`);
		const entry = {
			id: randomUUID().slice(0, 8),
			op: "pull",
			machine: cfg.machine,
			at: new Date().toISOString(),
			backend: cfg.backend.type,
			durationMs: Date.now() - started,
			backupId,
			counts: summarize(actions),
			files: actions.filter((a) => a.action !== "unchanged"),
		};
		appendLog(cfg, entry, keys);
		if (cfg.backend.type === "git") backends.git.finalize(cfg, `claude-sync pull log from ${cfg.machine} (${entry.id})`);
		cfg.lastPull = entry.at;
		saveConfig(cfg);
		log.ok(`pull complete (${entry.id})`);
		if (actions.some((a) => a.file === "plugins/known_marketplaces.json" && a.action !== "unchanged"))
			log.info("marketplaces changed — run /plugin in Claude Code to install the plugins they declare");
	},

	async status() {
		const cfg = loadConfig();
		backends[cfg.backend.type].prepare(cfg);
		const keys = await resolveKeys(cfg);
		log.head(`claude-sync status — ${cfg.machine}`);
		log.info(`backend:   ${cfg.backend.type}  (${cfg.backend.path || cfg.backend.remote || "local only"})`);
		log.info(`store:     ${storeDir(cfg)}`);
		log.info(`encrypted: ${keys ? "yes — AES-256-GCM, passphrase-derived key" : "no"}`);
		log.info(`last push: ${cfg.lastPush || "never"}`);
		log.info(`last pull: ${cfg.lastPull || "never"}`);

		const pending = doPush(cfg, keys, { dryRun: true });
		log.head("Local → store (pending push)");
		printActions(pending, { verbose: false });

		const incoming = openStore(cfg, keys).readAll();
		if (incoming.size) {
			const drift = [];
			for (const rel of [...incoming.keys()].sort()) {
				let buf = incoming.get(rel);
				if (REWRITE.has(rel)) buf = detokenize(buf);
				const local = readIfExists(path.join(CLAUDE_DIR, rel));
				if (!local) drift.push({ file: rel, action: "added" });
				else if (sha256(local) !== sha256(buf)) drift.push({ file: rel, action: "updated" });
			}
			log.head("Store → local (pending pull)");
			printActions(drift, { verbose: false });
		}
	},

	async log(args) {
		const cfg = loadConfig();
		const keys = await resolveKeys(cfg);
		let entries = readLog(cfg, keys);
		if (args.machine) entries = entries.filter((e) => e.machine === args.machine);
		if (args.op) entries = entries.filter((e) => e.op === args.op);
		if (args.since) {
			const since = new Date(args.since).getTime();
			entries = entries.filter((e) => new Date(e.at).getTime() >= since);
		}

		if (args.files) {
			const entry = entries.find((e) => e.id === args.files);
			if (!entry) fail(`no sync-log entry with id ${args.files}`);
			log.head(`${entry.op} ${entry.id} — ${entry.machine} — ${entry.at}`);
			for (const f of entry.files) log.dim(`  ${f.action.padEnd(9)} ${f.file}${f.reason ? `  — ${f.reason}` : ""}`);
			if (!entry.files.length) log.dim("  (no files changed)");
			return;
		}
		if (args.json) {
			console.log(JSON.stringify(entries, null, 2));
			return;
		}

		const limit = Number(args.limit || 20);
		const recent = entries.slice(-limit).reverse();
		log.head(`Sync log — ${entries.length} entr${entries.length === 1 ? "y" : "ies"} (showing ${recent.length})`);
		log.dim("  id        op     machine              when                  changes");
		for (const e of recent) {
			const changes = Object.entries(e.counts || {})
				.filter(([k]) => k !== "unchanged")
				.map(([k, v]) => `${v} ${k}`)
				.join(", ") || "none";
			log.info(
				`${e.id.padEnd(9)} ${e.op.padEnd(6)} ${String(e.machine).slice(0, 20).padEnd(20)} ` +
					`${e.at.replace("T", " ").slice(0, 19)}   ${changes}`,
			);
		}
		log.dim("\n  drill into one run:  claude-sync log --files <id>");
	},

	backups(args) {
		if (args.restore) {
			const root = path.join(BACKUP_DIR, args.restore);
			if (!fs.existsSync(root)) fail(`no backup named ${args.restore}`);
			const files = walk(root);
			for (const rel of files) writeAtomic(path.join(CLAUDE_DIR, rel), fs.readFileSync(path.join(root, rel)));
			log.ok(`restored ${files.length} file(s) from ${args.restore}`);
			return;
		}
		if (!fs.existsSync(BACKUP_DIR)) return log.info("no backups yet");
		log.head("Backups (created before each pull)");
		for (const id of fs.readdirSync(BACKUP_DIR).sort().reverse())
			log.info(`${id}   ${walk(path.join(BACKUP_DIR, id)).length} file(s)`);
		log.dim("\n  restore:  claude-sync backups --restore <id>");
	},

	doctor() {
		const cfg = loadConfig({ required: false });
		log.head("claude-sync doctor");
		log.info(`node:       ${process.version}`);
		log.info(`home:       ${HOME}`);
		log.info(`claude dir: ${CLAUDE_DIR} ${fs.existsSync(CLAUDE_DIR) ? "" : "(missing!)"}`);
		log.info(`config:     ${cfg ? CONFIG_PATH : "not configured"}`);
		if (cfg) {
			const dir = storeDir(cfg);
			log.info(`store:      ${dir} ${fs.existsSync(dir) ? "(reachable)" : "(MISSING — is your cloud drive mounted?)"}`);
			log.info(`transcripts: ${cfg.include?.transcripts ? "included" : "excluded (opt-in)"}`);
			if (cfg.encryption?.enabled) {
				const haveKeyring = fs.existsSync(keyringPath(cfg));
				const cached = readIfExists(dataKeyCachePath());
				log.info("encryption: on — AES-256-GCM, contents and filenames");
				log.info(`  keyring:  ${haveKeyring ? keyringPath(cfg) : "not created yet (first push will make it)"}`);
				log.info(`  key:      ${cached?.length === 32 ? "cached locally, no passphrase needed" : "will prompt for the passphrase"}`);
			} else {
				log.info("encryption: off — files are readable by whoever can read the store");
			}
		}

		const files = cfg ? localFiles(cfg) : localFiles({ include: {} });
		let bytes = 0;
		for (const rel of files) {
			try {
				bytes += fs.statSync(path.join(CLAUDE_DIR, rel)).size;
			} catch {}
		}
		log.head(`Would sync ${files.length} file(s), ${(bytes / 1024).toFixed(1)} KB`);
		for (const rel of files.slice(0, 40)) log.dim(`  ${rel}`);
		if (files.length > 40) log.dim(`  … and ${files.length - 40} more`);

		log.head("Withheld for safety");
		const withheld = [];
		for (const rel of files) {
			const buf = readIfExists(path.join(CLAUDE_DIR, rel));
			const s = buf && scanSecrets(buf);
			if (s) withheld.push(`${rel} — ${s.label} at line ${s.line}`);
		}
		if (withheld.length) withheld.forEach((w) => log.warn(w));
		else log.ok("no secret-like content in the allowlisted set");
		log.dim(`  always excluded: .credentials.json, auth tokens, plugin payloads (${"559 MB class"}), caches, sessions`);
	},
};

// ---------------------------------------------------------------- cli

const HELP = `
claude-sync — multi-machine sync for Claude Code config

  Syncs the portable declarations (settings, enabled plugins, marketplaces,
  user skills/commands/agents/hooks, per-project memory) — not the GB of
  re-fetchable plugin payload, and never your credentials.

Usage
  claude-sync init                                   asks where to store your files
  claude-sync init --backend folder --path <dir>     or name it outright: any synced dir
  claude-sync init --backend git --remote <url>      or a GitHub/GitLab repo
      [--machine <name>] [--transcripts] [--encrypt] [--force]

  Encryption (--encrypt) seals file contents AND filenames with AES-256-GCM
  before anything leaves the machine, under a key derived from a passphrase you
  choose. The passphrase cannot be recovered. Set CLAUDE_SYNC_PASSPHRASE to
  avoid the prompt in scripts.

  claude-sync remote --url <git-url>                 attach/change the git remote later

  claude-sync push      [--dry-run] [--verbose]      local  → store
  claude-sync pull      [--dry-run] [--verbose] [--prune]   store → local (backs up first)
  claude-sync status                                 what differs in each direction
  claude-sync log       [--limit N] [--machine M] [--op push|pull] [--since DATE] [--json]
  claude-sync log       --files <id>                 per-file detail for one run
  claude-sync backups   [--restore <id>]             pre-pull backups
  claude-sync doctor                                 paths, scope, secret check
`;

function parseArgs(argv) {
	const args = {};
	const rest = [];
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a.startsWith("--")) {
			const key = a.slice(2);
			const next = argv[i + 1];
			if (!next || next.startsWith("--")) args[key] = true;
			else {
				args[key] = next;
				i++;
			}
		} else rest.push(a);
	}
	return { args, rest };
}

// Only drive the CLI when run directly, so tests can import the pieces above.
const invokedDirectly =
	process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));

if (invokedDirectly) {
	const { args, rest } = parseArgs(process.argv.slice(2));
	const cmd = rest[0];

	if (!cmd || args.help || cmd === "help") {
		console.log(HELP);
		process.exit(0);
	}
	if (!commands[cmd]) {
		log.err(`unknown command: ${cmd}`);
		console.log(HELP);
		process.exit(1);
	}
	try {
		const result = commands[cmd](args);
		if (result instanceof Promise) result.catch((e) => fail(firstLine(e)));
	} catch (e) {
		fail(firstLine(e));
	}
}
