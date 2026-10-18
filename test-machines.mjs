// The machine registry, size reporting, and naming a newly added computer.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { interactiveInit } from "./claude-sync.mjs";

const ROOT = process.env.MACHINES_ROOT || path.join(os.tmpdir(), "claude-sync-machines");
const TOOL = path.join(import.meta.dirname, "claude-sync.mjs");
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

const run = (claudeDir, syncDir, args) =>
	execFileSync(process.execPath, [TOOL, ...args], {
		encoding: "utf8",
		env: { ...process.env, CLAUDE_CONFIG_DIR: claudeDir, CLAUDE_SYNC_DIR: syncDir },
	});

const STORE = path.join(ROOT, "cloud", "store");

// ---- desktop pushes, laptop pulls ---------------------------------------
const D = path.join(ROOT, "desktop");
const dSync = path.join(ROOT, "desktop-sync");
write(D, "settings.json", JSON.stringify({ model: "claude-opus-5" }, null, 2));
write(D, "CLAUDE.md", "x".repeat(4096));
run(D, dSync, ["init", "--backend", "folder", "--path", STORE, "--machine", "desktop"]);
const pushOut = run(D, dSync, ["push"]);

check("push reports a per-file size", /\d+(\.\d+)?\s?(B|KB|MB)/.test(pushOut), pushOut.trim());
check("push reports a net total", /net/.test(pushOut), pushOut.trim());

const L = path.join(ROOT, "laptop");
const lSync = path.join(ROOT, "laptop-sync");
fs.mkdirSync(L, { recursive: true });
run(L, lSync, ["init", "--backend", "folder", "--path", STORE, "--machine", "laptop"]);
run(L, lSync, ["pull"]);

// ---- the registry sees both ---------------------------------------------
const machinesJson = JSON.parse(run(L, lSync, ["machines", "--json"]));
check("the store reports its own file count and size", machinesJson.store.files === 2 && machinesJson.store.bytes > 4096, JSON.stringify(machinesJson.store));
check("both machines are registered", machinesJson.machines.length === 2, JSON.stringify(machinesJson.machines.map((m) => m.machine)));

const desktop = machinesJson.machines.find((m) => m.machine === "desktop");
const laptop = machinesJson.machines.find((m) => m.machine === "laptop");
check("desktop recorded a push date", !!desktop?.lastPush, JSON.stringify(desktop));
check("desktop recorded no pull", desktop?.lastPull === null);
check("laptop recorded a pull date", !!laptop?.lastPull, JSON.stringify(laptop));
check("each machine records its byte total", desktop?.bytes > 4096 && laptop?.bytes > 4096, `${desktop?.bytes} / ${laptop?.bytes}`);
check("each machine records its platform", !!desktop?.platform && !!laptop?.platform);
check("machines have distinct ids", desktop.id !== laptop.id);

// One file per machine, so two machines never write the same file.
const recordFiles = fs.readdirSync(path.join(STORE, "machines"));
check("the registry is one file per machine", recordFiles.length === 2, recordFiles.join(", "));

// ---- the human-readable listing -----------------------------------------
const listing = run(L, lSync, ["machines"]);
check("the listing names both machines", /desktop/.test(listing) && /laptop/.test(listing), listing.trim());
check("the listing marks the current machine", /\*\s+laptop/.test(listing), listing.trim());
check("the listing shows relative sync times", /(just now|\dm ago|\dh ago)/.test(listing), listing.trim());
const verbose = run(L, lSync, ["machines", "--verbose"]);
check("--verbose adds platform detail", /node v/.test(verbose), verbose.trim());

// ---- size difference in status -------------------------------------------
write(L, "CLAUDE.md", "y".repeat(8192)); // local now larger than the store
const statusOut = run(L, lSync, ["status"]);
check("status reports a local total", /local:/.test(statusOut), statusOut.trim());
check("status reports a store total", /store:/.test(statusOut), statusOut.trim());
check("status reports the difference", /diff:\s*[+−]/.test(statusOut), statusOut.trim());
check("status shows a positive diff when local is bigger", /diff:\s*\+/.test(statusOut), statusOut.trim());
check("status lists the machines", /Machines \(2\)/.test(statusOut), statusOut.trim());

// A changed file shows its new size and the delta against the store copy.
const pushAfter = run(L, lSync, ["push", "--dry-run"]);
check("a modified file shows a signed delta", /upd.*[+−]\s?\d/.test(pushAfter.replace(/\x1b\[[0-9;]*m/g, "")), pushAfter.trim());

// ---- naming a newly added computer ---------------------------------------
const scripted = (answers) => {
	const queue = [...answers];
	return async (q) => {
		if (!queue.length) throw new Error(`unexpected extra prompt: ${q.replace(/\x1b\[[0-9;]*m/g, "").trim()}`);
		return queue.shift();
	};
};
const existing = [
	{ machine: "desktop", lastPush: new Date().toISOString() },
	{ machine: "laptop", lastPull: new Date().toISOString() },
];
const lookup = async () => existing;

// A fresh name is accepted.
const r1 = await interactiveInit(scripted(["3", "/tmp/store", "n", "n", "work-laptop"]), lookup);
check("a new computer can be named", r1.machine === "work-laptop", r1.machine);

// A name already in the sync is challenged, and declining re-prompts.
const r2 = await interactiveInit(scripted(["3", "/tmp/store", "n", "n", "desktop", "n", "desktop-2"]), lookup);
check("a duplicate name is refused and re-prompted", r2.machine === "desktop-2", r2.machine);

// ...but can be confirmed deliberately (e.g. a rebuilt machine).
const r3 = await interactiveInit(scripted(["3", "/tmp/store", "n", "n", "desktop", "y"]), lookup);
check("a duplicate name can be confirmed on purpose", r3.machine === "desktop", r3.machine);

// Matching is case-insensitive, since "Desktop" and "desktop" would confuse the log.
const r4 = await interactiveInit(scripted(["3", "/tmp/store", "n", "n", "DESKTOP", "n", "studio"]), lookup);
check("duplicate detection ignores case", r4.machine === "studio", r4.machine);

// With an empty sync there is nothing to collide with.
const r5 = await interactiveInit(scripted(["3", "/tmp/store", "n", "n", ""]), async () => []);
check("an empty name falls back to the hostname", r5.machine === os.hostname(), r5.machine);

// A failing lookup must not block setup.
const r6 = await interactiveInit(scripted(["3", "/tmp/store", "n", "n", "solo"]), async () => {
	throw new Error("store unreachable");
});
check("an unreachable store still allows naming", r6.machine === "solo", r6.machine);

// ---- renaming keeps the machine's history --------------------------------
const cfgPath = path.join(lSync, "config.json");
const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
const keptId = cfg.machineId;
cfg.machine = "laptop-renamed";
fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
run(L, lSync, ["push"]);
const after = JSON.parse(run(L, lSync, ["machines", "--json"]));
check("renaming does not add a second row", after.machines.length === 2, JSON.stringify(after.machines.map((m) => m.machine)));
check("the renamed machine keeps its id", after.machines.some((m) => m.id === keptId && m.machine === "laptop-renamed"), JSON.stringify(after.machines.map((m) => `${m.machine}:${m.id.slice(0, 6)}`)));
check("the renamed machine keeps its earlier pull date", !!after.machines.find((m) => m.id === keptId)?.lastPull);

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
