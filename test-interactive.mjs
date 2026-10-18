// Drives the interactive setup with scripted answers, so the path an end user
// actually takes on a fresh machine is covered.
import * as os from "node:os";
import * as path from "node:path";
import { interactiveInit, detectStores } from "./claude-sync.mjs";

const HOME = os.homedir();
let failures = 0;
const check = (name, cond, detail = "") => {
	if (!cond) failures++;
	console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond || !detail ? "" : `\n      ${detail}`}`);
};

// Replays answers in order; throws if the flow asks more questions than scripted.
const scripted = (answers) => {
	const queue = [...answers];
	return async (q) => {
		if (!queue.length) throw new Error(`unexpected extra prompt: ${q.replace(/\x1b\[[0-9;]*m/g, "").trim()}`);
		return queue.shift();
	};
};

const detected = detectStores();
console.log(`detected ${detected.length} cloud drive(s): ${detected.map((d) => d.label).join(", ") || "none"}`);

// 1) Pick the first detected drive, accept the suggested path.
if (detected.length) {
	const r = await interactiveInit(scripted(["1", "y", "desktop", "n"]));
	check("picking a detected drive yields a folder backend", r.backend.type === "folder", JSON.stringify(r.backend));
	check(
		"suggested path is <drive>/claude-sync",
		r.backend.path === path.join(detected[0].path, "claude-sync"),
		r.backend.path,
	);
	check("machine name is taken from input", r.machine === "desktop", r.machine);
	check("transcripts default to excluded", r.transcripts === false);
}

// 2) Decline the suggestion and type a custom folder.
if (detected.length) {
	const custom = path.join(os.tmpdir(), "my-claude-store");
	const r = await interactiveInit(scripted(["1", "n", custom, "", "y"]));
	check("declining the suggestion lets you type a path", r.backend.path === path.resolve(custom), r.backend.path);
	check("blank machine name falls back to hostname", r.machine === os.hostname(), r.machine);
	check("transcripts can be opted in", r.transcripts === true);
}

// 3) "Another folder" option, with ~ expansion.
const another = String(detected.length + 1);
const r3 = await interactiveInit(scripted([another, "~/claude-store", "laptop", "n"]));
check("'another folder' accepts a typed path", r3.backend.type === "folder", JSON.stringify(r3.backend));
check("a leading ~ is expanded to home", r3.backend.path === path.join(HOME, "claude-store"), r3.backend.path);

// 4) Git option with a remote.
const gitChoice = String(detected.length + 2);
const r4 = await interactiveInit(scripted([gitChoice, "git@github.com:me/ai-config.git", "desktop", "n"]));
check("git option yields a git backend", r4.backend.type === "git", JSON.stringify(r4.backend));
check("git remote is captured", r4.backend.remote === "git@github.com:me/ai-config.git", r4.backend.remote);

// 5) Git option with no remote yet (store stays local).
const r5 = await interactiveInit(scripted([gitChoice, "", "desktop", "n"]));
check("git with a blank remote is allowed", r5.backend.type === "git" && r5.backend.remote === null, JSON.stringify(r5.backend));

// 6) Invalid menu input is re-prompted rather than accepted.
const r6 = await interactiveInit(scripted(["99", "abc", "", gitChoice, "", "host", "n"]));
check("invalid menu choices are re-prompted", r6.backend.type === "git", JSON.stringify(r6.backend));

// 7) Transcript prompt only accepts an explicit yes.
const r7 = await interactiveInit(scripted([gitChoice, "", "h", "yes"]));
check("'yes' opts transcripts in", r7.transcripts === true);
const r8 = await interactiveInit(scripted([gitChoice, "", "h", "whatever"]));
check("an unclear transcript answer stays excluded", r8.transcripts === false);

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
