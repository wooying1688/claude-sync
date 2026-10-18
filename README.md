# claude-sync

Keeps your Claude Code setup identical across machines, stored on whatever drive you
already use — Dropbox, OneDrive, Google Drive, Box, a NAS, or a GitHub/GitLab repo —
end-to-end encrypted, with an append-only log of every file that moved.

Single file, zero dependencies, Node 18+. Copy `claude-sync.mjs` to any machine and run it.

## What it syncs, and why so little

`~/.claude` is ~565 MB here, but only about 4 KB of it is actually portable. The rest is
re-fetchable payload or machine-local state. claude-sync syncs the **declarations**, and each
machine rebuilds the payload from them.

| Synced | Why |
| --- | --- |
| `settings.json` | model, prefs, and `enabledPlugins` — the list of what you want installed |
| `plugins/known_marketplaces.json` | where those plugins come from |
| `plugins/installed_plugins.json`, `plugins/plugin-directory-bindings.json` | plugin declarations |
| `CLAUDE.md`, `keybindings.json` | your global instructions and key bindings |
| `commands/`, `agents/`, `hooks/` | anything you authored |
| `skills/` | your own skills (the auto-managed `skills/synced/` bucket is skipped) |
| `projects/*/memory/` | per-project memory files |

| Never synced | Why |
| --- | --- |
| `.credentials.json`, `mcp-needs-auth-cache.json`, `auth.json`, `*.pem`, `*.key`, `.env*` | auth material — must not reach a third-party drive |
| `plugins/cache/`, `plugins/marketplaces/` | ~559 MB of re-fetchable payload |
| `plugins/synced/`, `skills/synced/` | Anthropic re-downloads these automatically |
| `projects/*/*.jsonl` | session transcripts: large, unmergeable, full conversation text (opt in with `--transcripts`) |
| `cache/`, `sessions/`, `session-env/`, `shell-snapshots/`, `backups/`, `downloads/`, `file-history/`, `ide/`, `state/` | machine-local and regenerated |

Three further safeguards:

- **Secret scanning.** Every file is scanned before it is written to the store. Anything
  carrying an API key, token, JWT or private key is **withheld**, and the reason is recorded in
  the log. An allowlisted file is not trusted blindly. This runs whether or not encryption is
  on, so a key never reaches the store even in ciphertext.
- **Encryption at rest.** With `--encrypt`, contents and filenames are sealed before they leave
  the machine — see [Encryption](#encryption).
- **Path portability.** Absolute home paths in `settings.json` / `keybindings.json` become
  tokens in the store and are expanded to the local home on pull. Windows, macOS and Linux
  spellings round-trip without producing invalid JSON.

## Install

```bash
git clone https://github.com/<you>/claude-sync.git
cd claude-sync
npm install -g .      # gives you a `claude-sync` command
```

Or skip installing and run the file directly — it has no dependencies:

```bash
node claude-sync.mjs <command>
```

## Setup

Just run `init`. It asks where you want your Claude files kept, listing the cloud drives it
finds on the machine:

```
$ claude-sync init

Where should your Claude Code files be stored?
  Any folder your cloud client already syncs works — no API keys, no sign-in.

  1) OneDrive  C:\Users\you\OneDrive\claude-sync
  2) Dropbox   C:\Users\you\Dropbox\claude-sync
  3) Another folder (NAS, USB drive, any path I type)
  4) A git repo (GitHub/GitLab — full history and diffs)

Choose 1-4: 1
Store at C:\Users\you\OneDrive\claude-sync? [Y/n] y
Name for this machine [DESKTOP-ABC]: desktop

Session transcripts are your full conversation history: large, and not mergeable
across machines. They are excluded unless you ask for them.
Include session transcripts? [y/N] n

Encryption scrambles the files before they leave this machine, so whoever
holds the store — Dropbox, OneDrive, GitHub — only ever sees ciphertext.
You will need the passphrase on every machine. It cannot be recovered.
Encrypt the stored files? [Y/n] y

  ✔ storing your Claude files in: C:\Users\you\OneDrive\claude-sync
```

It detects OneDrive, Dropbox, Google Drive, Box, iCloud Drive, and anything under macOS's
`~/Library/CloudStorage`. Pick "another folder" for a NAS, a USB stick, or any path at all.

Then push, and pull on your other machines:

```bash
claude-sync push          # on the machine whose setup you want to keep
claude-sync pull          # on every other machine
```

For scripted or unattended installs, name the location up front instead of being asked:

```bash
claude-sync init --backend folder --path "D:\Sync\claude-sync" --machine work-laptop --encrypt
claude-sync init --backend git --remote git@github.com:you/ai-config.git --encrypt
claude-sync init --backend git            # local git store now, attach a remote later
claude-sync remote --url git@github.com:you/ai-config.git
```

`--machine <name>` labels this machine in the log (defaults to the hostname), `--transcripts`
opts session transcripts in, `--encrypt` turns on encryption, and `--force` reconfigures an
existing install.

Because the folder backend just writes files, your existing Dropbox/OneDrive/Drive/Box client
does the uploading — no API keys, no OAuth, no extra service.

## Encryption

Transit is already encrypted without any help: Dropbox, OneDrive, Drive and Box all upload
over TLS, and git pushes travel over HTTPS or SSH. The gap that matters is **at rest** — by
default your files sit readable on someone else's server, visible to that provider and to
anyone who gets into the account.

So claude-sync encrypts **before the files leave your machine**. The provider only ever holds
ciphertext, which covers at-rest and in-transit together.

```
~/.claude/settings.json          ->  payload/9f2c…a71b.bin   (AES-256-GCM)
~/.claude/skills/mine/SKILL.md   ->  payload/4e81…0c3d.bin
logs/sync-log.jsonl              ->  one sealed envelope per line
```

- **AES-256-GCM** for every file, so tampering is detected rather than silently applied — a
  single flipped bit makes that entry fail to open, and the rest still sync.
- **Filenames are encrypted too.** Blobs are named by a keyed HMAC, so the store never reveals
  which skills, plugins or projects you have. That matters because project directory names are
  derived from local paths and carry your username. The real path travels inside the ciphertext.
- **scrypt** (N=65536, r=8, p=1) derives a key from your passphrase, so guessing it is slow.
- **Envelope encryption.** A random 32-byte data key encrypts the files; your passphrase
  encrypts the data key. The wrapped data key lives in the store, so every machine that knows
  the passphrase can read what the others wrote.
- **Separate subkeys** (HKDF) for contents, filenames and the log, so no key does two jobs.
- **Fresh random nonce per write**, never reused.

Set it up with `--encrypt`, or answer yes to the prompt. On other machines, `init --encrypt`
and the passphrase is all you need — the data key is unwrapped from the store.

```bash
claude-sync init --backend folder --path "...\claude-sync" --encrypt
export CLAUDE_SYNC_PASSPHRASE='…'    # optional, for scripts; otherwise you are prompted
```

After the first unlock the data key is cached at `~/.claude-sync/datakey` (mode 0600) so
routine `push`/`pull` do not ask again.

**What this does and does not protect.** It protects the copy in the cloud: the provider,
other people with account access, and anyone reading the synced folder see nothing useful. It
does **not** protect against someone who already has your machine — your real config sits
unencrypted in `~/.claude` regardless, so a locally cached key is no additional exposure.

**The passphrase cannot be recovered.** There is no reset and no escrow. Lose it and the store
is unreadable; you would start a new one from a machine that still has its config.

Encrypted and unencrypted stores are not interchangeable. `init` adopts whichever mode an
existing store already uses, and a mismatch is refused rather than guessed at.

## Daily use

```bash
node claude-sync.mjs push                 # local  -> store
node claude-sync.mjs pull                 # store  -> local (backs up first)
node claude-sync.mjs status               # what differs, in both directions
node claude-sync.mjs push --dry-run       # preview without writing
node claude-sync.mjs pull --prune         # also delete local files absent from the store
```

After a pull that changed `known_marketplaces.json`, run `/plugin` in Claude Code to install
the plugins the new declarations ask for.

## Sync logs

Every run appends one line to `<store>/logs/sync-log.jsonl` — encrypted per line when
encryption is on, which keeps it appendable from several machines without rewriting what is
already there. The log lives in the store, so it is shared: each machine sees what every other
machine did.

```bash
node claude-sync.mjs log                        # recent runs, newest first
node claude-sync.mjs log --limit 50
node claude-sync.mjs log --machine laptop
node claude-sync.mjs log --op push
node claude-sync.mjs log --since 2026-10-01
node claude-sync.mjs log --json                 # full detail for scripting
node claude-sync.mjs log --files <id>           # per-file list for one run
```

```
Sync log — 4 entries (showing 4)
  id        op     machine              when                  changes
  66eb514d  pull   desktop-A            2026-10-18 03:16:09   1 updated
  554856e5  push   laptop-B             2026-10-18 03:16:08   1 updated
  1b8a46f9  pull   laptop-B             2026-10-18 03:16:08   3 added
  eae060e9  push   desktop-A            2026-10-18 03:16:07   3 added
```

Each entry records the operation, machine, timestamp, backend, duration, per-file actions
(`added` / `updated` / `deleted` / `skipped` with the reason), and the backup id for pulls.

## Safety

- **Pull backs up first.** Anything it would overwrite is copied to
  `~/.claude-sync/backups/<timestamp>/`.
  `claude-sync backups` lists them; `claude-sync backups --restore <id>` puts them back.
- **Deletes are opt-in.** Pull only adds and updates unless you pass `--prune`.
- **Writes are atomic** (temp file then rename), so an interrupted run cannot leave a
  half-written config.
- **Git staging is explicit** — the tool stages only the paths it owns, never `git add .`,
  and supplies its own commit identity without touching your global git config.

## Commands

| Command | Purpose |
| --- | --- |
| `init` | ask where to store your files (and whether to encrypt), then configure it |
| `init --backend folder --path <dir>` | configure a cloud-drive or local folder store directly |
| `init --backend git --remote <url>` | configure a git store directly |
| `remote --url <git-url>` | attach or change the git remote later |
| `push [--dry-run] [--verbose]` | copy local config to the store |
| `pull [--dry-run] [--verbose] [--prune]` | apply the store to local config |
| `status` | pending changes in both directions |
| `log [...]` | review what has been synced |
| `backups [--restore <id>]` | list or restore pre-pull backups |
| `doctor` | resolved paths, sync scope, size, encryption state, secret check |

## Environment

| Variable | Effect |
| --- | --- |
| `CLAUDE_CONFIG_DIR` | non-default Claude Code config dir (honored by Claude Code too) |
| `CLAUDE_SYNC_DIR` | where claude-sync keeps its config, key cache and backups (default `~/.claude-sync`) |
| `CLAUDE_SYNC_PASSPHRASE` | store passphrase, for unattended runs instead of the prompt |

## Tests

```bash
npm test                    # all four suites, 79 checks

node test-roundtrip.mjs     # path tokenization, including cross-OS (13 checks)
node test-interactive.mjs   # the setup prompts, with scripted answers (20 checks)
node test-crypto.mjs        # encryption, wrong passphrase, tampering, leakage (30 checks)
node test-e2e.mjs           # two-machine push/pull through a folder backend (31 checks)
```

The crypto suite asserts the adversarial cases, not just the happy path: that a wrong
passphrase is refused and writes nothing, that a flipped ciphertext bit is detected, that a
fresh machine can decrypt from the passphrase alone, and that the store leaks neither file
contents nor skill, plugin or project names.
