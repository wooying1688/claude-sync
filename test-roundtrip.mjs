// Round-trip checks for path tokenization, run against the real module shape.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const HOME = os.homedir();
const toPosix = (p) => p.split(path.sep).join("/");
const IS_WIN = path.sep === "\\";
const T_JSONWIN = "{{HOME_JSONWIN}}";
const T_WIN = "{{HOME_WIN}}";
const T_POSIX = "{{HOME_POSIX}}";
const homeJsonWin = HOME.split(path.sep).join("\\\\");
const homePosix = toPosix(HOME);

function tokenize(text, { home = HOME, sep = path.sep } = {}) {
	const jsonWin = home.split(sep).join("\\\\");
	const posix = home.split(sep).join("/");
	let t = text;
	t = t.split(jsonWin).join(T_JSONWIN);
	if (sep === "\\") t = t.split(home).join(T_WIN);
	t = t.split(posix).join(T_POSIX);
	return t;
}

function detokenize(text, { home = HOME, sep = path.sep } = {}) {
	const isWin = sep === "\\";
	const jsonWin = home.split(sep).join("\\\\");
	const posix = home.split(sep).join("/");
	let t = text;
	t = t.split(T_JSONWIN).join(isWin ? jsonWin : posix);
	t = t.split(T_WIN).join(isWin ? home : posix);
	t = t.split(T_POSIX).join(posix);
	return t;
}

let failures = 0;
const check = (name, actual, expected) => {
	const ok = actual === expected;
	if (!ok) failures++;
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
	if (!ok) console.log(`      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`);
};
const checkJson = (name, text) => {
	try {
		JSON.parse(text);
		console.log(`PASS  ${name}`);
	} catch (e) {
		failures++;
		console.log(`FAIL  ${name} — ${e.message}\n      ${text}`);
	}
};

// A realistic Windows settings.json: backslashes escaped for JSON.
const winSettings = JSON.stringify({ hooks: { fmt: `${HOME}\\bin\\fmt.exe` }, model: "claude-opus-5" }, null, 2);
checkJson("windows fixture is valid JSON to begin with", winSettings);

const stored = tokenize(winSettings);
check("home path is tokenized out of the store copy", stored.includes(HOME), false);
check("json-escaped spelling uses the JSONWIN token", stored.includes(T_JSONWIN), true);

// Same OS round-trip must be byte-identical.
check("windows -> windows round-trip is lossless", detokenize(stored), winSettings);
checkJson("windows -> windows result is valid JSON", detokenize(stored));

// Cross-OS: a mac pulling a store written on windows.
const MAC = "/Users/alex";
const onMac = detokenize(stored, { home: MAC, sep: "/" });
check("windows -> mac emits no stray backslash escape", /[^\\]\\[^\\"]/.test(onMac), false);
checkJson("windows -> mac result is valid JSON", onMac);
check("windows -> mac rewrote the home prefix", onMac.includes(MAC), true);

// Cross-OS the other direction: mac writes, windows pulls.
const macSettings = JSON.stringify({ hooks: { fmt: `${MAC}/bin/fmt` } }, null, 2);
const storedFromMac = tokenize(macSettings, { home: MAC, sep: "/" });
check("mac store uses the POSIX token", storedFromMac.includes(T_POSIX), true);
const onWin = detokenize(storedFromMac, { home: "C:\\Users\\alex", sep: "\\" });
checkJson("mac -> windows result is valid JSON", onWin);
check("mac -> windows uses forward slashes (legal in JSON and on win32)", onWin.includes("C:/Users/alex"), true);

// Non-JSON content (a hook shell script) must also survive.
const script = `#!/bin/sh\ncd ${HOME}/projects && echo done\n`;
check("plain-text round-trip is lossless", detokenize(tokenize(script)), script);

// Files with no home path must be untouched.
const neutral = '{"model":"claude-opus-5"}';
check("file without a home path is unchanged", tokenize(neutral), neutral);

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
