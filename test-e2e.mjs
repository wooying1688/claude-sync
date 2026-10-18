// End-to-end: machine A pushes, machine B pulls, through a folder backend.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = process.env.E2E_ROOT || path.join(os.tmpdir(), "claude-sync-e2e");
const TOOL = path.join(import.meta.dirname, "claude-sync.mjs");
const A = path.join(ROOT, "a-claude");
const B = path.join(ROOT, "b-claude");
const STORE = path.join(ROOT, "cloud", "claude-sync");

fs.rmSync(ROOT, { recursive: true, force: true });

const write = (base, rel, content) => {
	const p = path.join(base, rel);
	fs.mkdirSync(path.dirname(p), { recursive: true });
	fs.writeFileSync(p, content);
};

// Realistic settings.json — JSON.stringify produces correctly escaped backslashes.
const settings = {
	enabledPlugins: { "claude-mem@thedotmack": true },
	model: "claude-opus-5",
	hooks: { PostToolUse: [{ command: path.join(os.homedir(), "bin", "fmt.exe") }] },
};
write(A, "settings.json", JSON.stringify(settings, null, 2));
write(A, "CLAUDE.md", "# Global instructions\n");
write(A, "commands/test.md", "Run the suite\n");
write(A, "skills/my-skill/SKILL.md", "---\nname: my-skill\n---\nBody\n");
write(A, "projects/myproj/memory/MEMORY.md", "- [Role](user_role.md)\n");
write(A, "plugins/known_marketplaces.json", JSON.stringify({ thedotmack: { source: "github" } }, null, 2));
// Must never leave machine A:
write(A, ".credentials.json", JSON.stringify({ access_token: "ya29.AAAAAAAAAAAAAAAAAAAAAAAAAAAA" }));
write(A, "commands/leaky.md", "ANTHROPIC_API_KEY=sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA\n");
write(A, "skills/synced/bucket/builtin/SKILL.md", "builtin\n");
write(A, "projects/myproj/sess.jsonl", "{}\n");
write(A, "plugins/marketplaces/big/payload.bin", Buffer.alloc(150_000, 7));
fs.mkdirSync(B, { recursive: true });

const run = (claudeDir, syncDir, args) =>
	execFileSync(process.execPath, [TOOL, ...args], {
		encoding: "utf8",
		env: { ...process.env, CLAUDE_CONFIG_DIR: claudeDir, CLAUDE_SYNC_DIR: syncDir },
	});

let failures = 0;
const check = (name, cond, detail = "") => {
	if (!cond) failures++;
	console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond || !detail ? "" : `\n      ${detail}`}`);
};

const syncA = path.join(ROOT, "a-sync");
const syncB = path.join(ROOT, "b-sync");

run(A, syncA, ["init", "--backend", "folder", "--path", STORE, "--machine", "desktop-A"]);
const pushOut = run(A, syncA, ["push"]);
check("push reports the withheld secret file", /withheld/.test(pushOut));
check("push did not copy the leaky file", !fs.existsSync(path.join(STORE, "payload/claude/commands/leaky.md")));
check("push did not copy credentials", !fs.existsSync(path.join(STORE, "payload/claude/.credentials.json")));
check("push did not copy the plugin payload", !fs.existsSync(path.join(STORE, "payload/claude/plugins/marketplaces")));
check("push did not copy the synced skills bucket", !fs.existsSync(path.join(STORE, "payload/claude/skills/synced")));
check("push did not copy transcripts", !fs.existsSync(path.join(STORE, "payload/claude/projects/myproj/sess.jsonl")));
check("store holds no literal home path", !fs.readFileSync(path.join(STORE, "payload/claude/settings.json"), "utf8").includes(os.homedir()));

run(B, syncB, ["init", "--backend", "folder", "--path", STORE, "--machine", "laptop-B"]);
run(B, syncB, ["pull"]);

for (const rel of ["settings.json", "CLAUDE.md", "commands/test.md", "skills/my-skill/SKILL.md", "projects/myproj/memory/MEMORY.md"])
	check(`B received ${rel}`, fs.existsSync(path.join(B, rel)));
check("B did not receive credentials", !fs.existsSync(path.join(B, ".credentials.json")));
check("B did not receive the leaky file", !fs.existsSync(path.join(B, "commands/leaky.md")));

const bRaw = fs.readFileSync(path.join(B, "settings.json"), "utf8");
let bParsed = null;
try {
	bParsed = JSON.parse(bRaw);
	console.log("PASS  B's settings.json is valid JSON");
} catch (e) {
	failures++;
	console.log(`FAIL  B's settings.json is valid JSON — ${e.message}\n      ${bRaw}`);
}
check("B's settings.json is byte-identical to A's", bRaw === fs.readFileSync(path.join(A, "settings.json"), "utf8"));
check("B's hook path points at B's home", bParsed?.hooks?.PostToolUse?.[0]?.command?.includes(os.homedir().split(path.sep).join("/")) ||
	bParsed?.hooks?.PostToolUse?.[0]?.command?.includes(os.homedir()), bParsed?.hooks?.PostToolUse?.[0]?.command);
check("B kept the enabledPlugins declaration", bParsed?.enabledPlugins?.["claude-mem@thedotmack"] === true);

// Idempotence: a second push/pull should change nothing.
const push2 = run(A, syncA, ["push"]);
check("second push is a no-op", !/added|updated/.test(push2.replace(/unchanged/g, "")), push2.trim());
const pull2 = run(B, syncB, ["pull"]);
check("second pull is a no-op", !/\badded\b|\bupdated\b/.test(pull2), pull2.trim());

// Logs must record both machines.
const logOut = run(B, syncB, ["log"]);
check("log shows machine A's push", /desktop-A/.test(logOut), logOut);
check("log shows machine B's pull", /laptop-B/.test(logOut));
check("log is shared through the store", fs.existsSync(path.join(STORE, "logs", "sync-log.jsonl")));

const entries = fs.readFileSync(path.join(STORE, "logs", "sync-log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
check("log records per-file detail", entries[0].files.some((f) => f.file === "settings.json"));
check("log records why a file was withheld", entries[0].files.some((f) => f.action === "skipped" && /API key/.test(f.reason || "")));
const detail = run(B, syncB, ["log", "--files", entries[0].id]);
check("log --files drills into one run", /settings\.json/.test(detail), detail);

// Pull creates a restorable backup when it overwrites.
write(B, "CLAUDE.md", "# locally edited\n");
run(B, syncB, ["pull"]);
const backupsOut = run(B, syncB, ["backups"]);
check("a backup was created for the overwrite", /file\(s\)/.test(backupsOut), backupsOut);
check("pull restored the store version over the local edit", fs.readFileSync(path.join(B, "CLAUDE.md"), "utf8") === "# Global instructions\n");
const backupId = backupsOut.split("\n").map((l) => l.trim()).find((l) => /^\d{4}-/.test(l))?.split(/\s+/)[0];
run(B, syncB, ["backups", "--restore", backupId]);
check("backups --restore brings the local edit back", fs.readFileSync(path.join(B, "CLAUDE.md"), "utf8") === "# locally edited\n");

// status should surface drift in both directions.
const statusOut = run(B, syncB, ["status"]);
check("status reports pending pull after the restore", /pending pull/.test(statusOut) && /CLAUDE\.md/.test(statusOut), statusOut);

// dry-run must not write.
write(B, "commands/new.md", "fresh\n");
run(B, syncB, ["push", "--dry-run"]);
check("dry-run push wrote nothing to the store", !fs.existsSync(path.join(STORE, "payload/claude/commands/new.md")));

console.log(failures ? `\n${failures} check(s) failed` : `\nall checks passed  (store: ${STORE})`);
process.exit(failures ? 1 : 0);
