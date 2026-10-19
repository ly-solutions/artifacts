---
name: artifacts
description: Publish, find, update and share documents in the team's artifacts catalog (versioned HTML/Markdown pages with a reader and share links) through the `artifacts` CLI. Use before writing any report, plan, review, spec, incident analysis, research note or other document someone will read — first to check whether one already exists, then to publish it or to add a new version of the existing one under the same slug. Also use when someone asks for a link to a document, wants an earlier document updated, asks what was already written on a topic, or asks to share a document with someone outside the team.
---

# Artifacts catalog

The catalog keeps documents that people and agents publish: each has a stable address (`/a/<slug>`),
a version history, metadata (title, tags, task, link, conversation) and optional share links.

The `artifacts` CLI talks to it. It is configured by the environment:

- `ARTIFACTS_URL` — the server; `ARTIFACTS_TOKEN` — your token.
- `ARTIFACTS_SESSION` — your conversation id, if the workspace set it; every publish is linked to it.
- `ARTIFACTS_AUTHOR` — how you are recorded as the author (falls back to git `user.name`).

If `artifacts whoami` fails, report that the catalog is not configured instead of guessing a URL or token.
Never print the token.

## 1. Find before you write

A new document on a topic that already has one splits the history and leaves readers with two half-truths.
Search first, every time:

```bash
artifacts find "checkout incident"          # words match title, tags and text
artifacts find --tag postmortem             # by tag
artifacts find --task PROJ-123              # by task
artifacts find --session "$ARTIFACTS_SESSION"   # what this conversation already published
```

Read a hit before deciding: `artifacts get <slug> --format markdown` (or `--format html`), and
`artifacts versions <slug>` for its history.

- Same subject → **update it** (section 3). This includes "v2", "final", "updated", "draft 2" and
  "for the new quarter" of the same document.
- Genuinely different document (another system, another incident, another audience) → publish a new one.

## 2. Publish a new document

```bash
artifacts publish --file report.md --title "Checkout incident, 14 March" \
  --description "Why payments failed for 40 minutes and what we changed" \
  --tags "incident,payments" --task PROJ-123
```

- `--file` takes Markdown (`.md`) or HTML. An HTML **fragment** (no `<html>`) and Markdown get the
  catalog's typography with light and dark themes; a full HTML document is shown exactly as written.
- Add `--markdown source.md` next to an HTML `--file` to keep an editable source with the page.
- Local images (`<img src="./chart.png">`, `![](chart.png)`) are embedded automatically (2 MB each, 8 MB total).
- Scripts run in a sandbox without network access; charts from cdnjs/jsdelivr work, calls to APIs do not.
- The command prints the document's address. Give that link to the person.

If the server answers that a document with this title exists, it lists the candidates. Update the
right one with its slug. Use `--new` only when you are sure it is a different document.

## 3. Update a document: same slug, new version

```bash
artifacts publish --slug checkout-incident-k3x9q2 --file report.md --note "added the timeline and follow-ups"
```

- Always the same `--slug`; never a new document named "… v2". The address stays the same and readers see
  the newest version, with the previous ones one click away.
- `--note` is one line saying what changed; it shows in the version list.
- The title, tags, task and link you do not pass stay as they were.
- If several agents may edit at once, pass `--base-version N` (the version you read). A conflict means
  someone published in between: read the new version, merge, publish again.

## 4. Change metadata without a new version

```bash
artifacts meta <slug> --title "Better title" --add-tag security --remove-tag draft
artifacts meta <slug> --task PROJ-456        # or --no-task
artifacts meta <slug> --link https://git.example.com/org/repo/pull/42
```

## 5. Share outside the team — only when asked

Documents are private to people who can sign in to the catalog. A share link opens one document
read-only without signing in, so create one only when a person explicitly asks for it:

```bash
artifacts share <slug> --expires 7d      # prints the link
artifacts unshare <slug>                 # every link issued before stops working
```

## What not to put in a document

Secrets, tokens, passwords, private keys, personal data that the reader does not need. Documents are kept
with their full history: deleting text in a new version does not remove it from the old one. If a secret
was published, tell a person; it must be rotated, and the artifact deleted with `artifacts delete <slug> --yes`.

## Reporting back

Give the person the link and one sentence on what the document is. Mention when you updated an existing
document instead of creating one, and which version you published.
