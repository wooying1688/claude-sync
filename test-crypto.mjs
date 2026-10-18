// Encryption checks: correctness, and the adversarial cases that matter —
// wrong passphrase, tampered bytes, and whether the store leaks anything.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = process.env.CRYPTO_ROOT || path.join(os.tmpdir(), "claude-sync-crypto");
const TOOL = path.join(import.meta.dirname, "claude-sync.mjs");
const PASS = "correct horse battery staple";

fs.rmSync(ROOT, { recursive: true, force: true });

let failures = 0;
const check = (name, cond, detail = "") => {
	if (!cond) failures++;
	console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond || !detail ? "" : `\n      ${detail}`}`);
};

const write = (base, rel, content) => {
	const p = path.join(base, rel);
	fs.mkdirSync(path.dirname(p), { recursive: true });
	fs.writeFileSync(p, content);
};

const run = (claudeDir, syncDir, args, { pass = PASS, expectFail = false } = {}) => {
	try {
		const out = execFileSync(process.execPath, [TOOL, ...args], {
			encoding: "utf8",
			env: {
				...process.env,
				CLAUDE_CONFIG_DIR: claudeDir,
				CLAUDE_SYNC_DIR: syncDir,
				...(pass === null ? {} : { CLAUDE_SYNC_PASSPHRASE: pass }),
			},
		});
		if (expectFail) {
			failures++;
			console.log(`FAIL  expected '${args.join(" ")}' to fail, but it succeeded\n      ${out.trim()}`);
		}
		return out;
	} catch (e) {
		const text = `${e.stdout || ""}${e.stderr || ""}`;
		if (!expectFail) {
			failures++;
			console.log(`FAIL  '${args.join(" ")}' failed unexpectedly\n      ${text.trim().split("\n").slice(-3).join("\n      ")}`);
		}
		return text;
	}
};

// ---- machine A: encrypted push -------------------------------------------
const A = path.join(ROOT, "a-claude");
const aSync = path.join(ROOT, "a-sync");
const STORE = path.join(ROOT, "cloud", "store");

const SECRET_TEXT = "my-very-distinctive-instruction-xyzzy-42";
write(A, "settings.json", JSON.stringify({ model: "claude-opus-5", enabledPlugins: { "data@synced": true } }, null, 2));
write(A, "CLAUDE.md", `# ${SECRET_TEXT}\n`);
write(A, "skills/secret-skill/SKILL.md", "---\nname: secret-skill\n---\nbody\n");
write(A, "projects/C--Users-someone/memory/MEMORY.md", "- [Role](user_role.md)\n");

run(A, aSync, ["init", "--backend", "folder", "--path", STORE, "--machine", "A", "--encrypt"]);
const pushOut = run(A, aSync, ["push"]);
check("push reports it is encrypting", /encrypted/.test(pushOut), pushOut.trim());

// ---- the store must not leak content, names, or paths ---------------------
const storeFiles = [];
const walkAll = (dir) => {
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) walkAll(p);
		else storeFiles.push(p);
	}
};
walkAll(STORE);
const allBytes = Buffer.concat(storeFiles.map((f) => fs.readFileSync(f)));

check("store holds a keyring", storeFiles.some((f) => f.endsWith("keyring.json")));
check("file contents are not readable in the store", !allBytes.includes(SECRET_TEXT), "plaintext found in store!");
check("'enabledPlugins' does not appear in the store", !allBytes.includes("enabledPlugins"));
check("filenames are opaque — no SKILL.md in any path", !storeFiles.some((f) => /SKILL\.md|CLAUDE\.md|settings\.json/.test(f)));
check("skill names are not exposed as paths", !storeFiles.some((f) => f.includes("secret-skill")));
check("project paths (which carry a username) are not exposed", !storeFiles.some((f) => f.includes("C--Users-someone")));
check("blobs are named as opaque hex", storeFiles.filter((f) => f.endsWith(".bin")).every((f) => /[0-9a-f]{64}\.bin$/.test(f)));
check("the sync log is encrypted too", !fs.readFileSync(path.join(STORE, "logs", "sync-log.jsonl")).includes("settings.json"));
check("store.json records that it is encrypted", JSON.parse(fs.readFileSync(path.join(STORE, "store.json"), "utf8")).encrypted === true);

// ---- machine B: same passphrase round-trips -------------------------------
const B = path.join(ROOT, "b-claude");
const bSync = path.join(ROOT, "b-sync");
fs.mkdirSync(B, { recursive: true });
run(B, bSync, ["init", "--backend", "folder", "--path", STORE, "--machine", "B", "--encrypt"]);
run(B, bSync, ["pull"]);

check("B decrypted CLAUDE.md", fs.readFileSync(path.join(B, "CLAUDE.md"), "utf8") === `# ${SECRET_TEXT}\n`);
check(
	"B decrypted settings.json byte-for-byte",
	fs.readFileSync(path.join(B, "settings.json"), "utf8") === fs.readFileSync(path.join(A, "settings.json"), "utf8"),
);
check("B recovered the real nested path", fs.existsSync(path.join(B, "skills/secret-skill/SKILL.md")));
check("B recovered the project memory path", fs.existsSync(path.join(B, "projects/C--Users-someone/memory/MEMORY.md")));

const bLog = run(B, bSync, ["log"]);
check("B can read the shared encrypted log", /\bA\b/.test(bLog) && /push/.test(bLog), bLog.trim());

// ---- wrong passphrase must fail cleanly ----------------------------------
const C = path.join(ROOT, "c-claude");
const cSync = path.join(ROOT, "c-sync");
fs.mkdirSync(C, { recursive: true });
run(C, cSync, ["init", "--backend", "folder", "--path", STORE, "--machine", "C", "--encrypt"], { pass: "wrong-passphrase" });
const wrongOut = run(C, cSync, ["pull"], { pass: "wrong-passphrase", expectFail: true });
check("wrong passphrase is rejected", /wrong passphrase/i.test(wrongOut), wrongOut.trim().split("\n").slice(-2).join(" "));
check("wrong passphrase wrote no files", !fs.existsSync(path.join(C, "CLAUDE.md")));

// ---- tampering must be detected ------------------------------------------
const D = path.join(ROOT, "d-claude");
const dSync = path.join(ROOT, "d-sync");
fs.mkdirSync(D, { recursive: true });
const tamperStore = path.join(ROOT, "cloud-tamper");
fs.cpSync(STORE, tamperStore, { recursive: true });
const victim = [];
walkAll.length; // keep linter quiet
(function collect(dir) {
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) collect(p);
		else if (p.endsWith(".bin")) victim.push(p);
	}
})(tamperStore);
const target = victim[0];
const bytes = fs.readFileSync(target);
bytes[bytes.length - 1] ^= 0xff; // flip one bit of ciphertext
fs.writeFileSync(target, bytes);

run(D, dSync, ["init", "--backend", "folder", "--path", tamperStore, "--machine", "D", "--encrypt"]);
const tamperOut = run(D, dSync, ["pull"]);
check("a tampered blob is detected and skipped", /unreadable store entry|tampered/i.test(tamperOut), tamperOut.trim());
check("the other files still decrypt", fs.readdirSync(D).length > 0);

// ---- an encrypted store cannot be read as plaintext ----------------------
const E = path.join(ROOT, "e-claude");
const eSync = path.join(ROOT, "e-sync");
fs.mkdirSync(E, { recursive: true });
// init matches the store's mode automatically, so force a mismatch in config.
run(E, eSync, ["init", "--backend", "folder", "--path", STORE, "--machine", "E"]);
const eCfgPath = path.join(eSync, "config.json");
const eCfg = JSON.parse(fs.readFileSync(eCfgPath, "utf8"));
check("init adopted the store's encrypted mode", eCfg.encryption.enabled === true, JSON.stringify(eCfg.encryption));
eCfg.encryption.enabled = false;
fs.writeFileSync(eCfgPath, JSON.stringify(eCfg, null, 2));
const mismatchOut = run(E, eSync, ["pull"], { pass: null, expectFail: true });
check("reading an encrypted store as plaintext is refused", /encrypted/i.test(mismatchOut), mismatchOut.trim().split("\n").slice(-2).join(" "));

// ---- plaintext store stays plaintext (no silent mode change) -------------
const F = path.join(ROOT, "f-claude");
const fSync = path.join(ROOT, "f-sync");
const plainStore = path.join(ROOT, "cloud-plain");
write(F, "CLAUDE.md", "# plain\n");
run(F, fSync, ["init", "--backend", "folder", "--path", plainStore, "--machine", "F"], { pass: null });
run(F, fSync, ["push"], { pass: null });
check(
	"an unencrypted store is still readable as files",
	fs.existsSync(path.join(plainStore, "payload", "claude", "CLAUDE.md")),
);
const gSync = path.join(ROOT, "g-sync");
const G = path.join(ROOT, "g-claude");
fs.mkdirSync(G, { recursive: true });
run(G, gSync, ["init", "--backend", "folder", "--path", plainStore, "--machine", "G", "--encrypt"], { pass: null });
const gCfg = JSON.parse(fs.readFileSync(path.join(gSync, "config.json"), "utf8"));
check("asking for encryption on a plaintext store does not silently encrypt", gCfg.encryption.enabled === false, JSON.stringify(gCfg.encryption));

// ---- idempotence under encryption ---------------------------------------
const push2 = run(A, aSync, ["push"]);
check("a second encrypted push changes nothing", !/\badded\b|\bupdated\b/.test(push2), push2.trim());
const pull2 = run(B, bSync, ["pull"]);
check("a second encrypted pull changes nothing", !/\badded\b|\bupdated\b/.test(pull2), pull2.trim());

// ---- passphrase caching --------------------------------------------------
check("the data key is cached locally", fs.existsSync(path.join(aSync, "datakey")));
check("the cached key is 32 bytes", fs.statSync(path.join(aSync, "datakey")).size === 32);
const noPass = run(A, aSync, ["status"], { pass: null });
check("a cached key means no passphrase is needed", /encrypted:\s*yes/i.test(noPass), noPass.trim().split("\n").slice(0, 6).join(" "));

// ---- a fresh machine with only the passphrase (no cache) -----------------
const H = path.join(ROOT, "h-claude");
const hSync = path.join(ROOT, "h-sync");
fs.mkdirSync(H, { recursive: true });
run(H, hSync, ["init", "--backend", "folder", "--path", STORE, "--machine", "H", "--encrypt"]);
fs.rmSync(path.join(hSync, "datakey"), { force: true });
run(H, hSync, ["pull"]);
check("a new machine can decrypt with the passphrase alone", fs.readFileSync(path.join(H, "CLAUDE.md"), "utf8").includes(SECRET_TEXT));

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
