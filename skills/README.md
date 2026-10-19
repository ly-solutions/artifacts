# Agent skills

`artifacts/SKILL.md` teaches a coding agent to use the catalog well: search before writing, publish,
update the same slug instead of making copies, read versions, change metadata, and share only on request.
It is plain Markdown with YAML front matter, the format Claude Code reads; other agents can load the same
text as instructions.

## Install

The skill calls the `artifacts` CLI, so install that first (`npm install -g @ly-solutions/artifacts`, or run
`npx @ly-solutions/artifacts`) and set `ARTIFACTS_URL` and `ARTIFACTS_TOKEN` in the agent's environment.

Then pick one:

- **Claude Code plugin.** This repository is a plugin marketplace:
  `/plugin marketplace add ly-solutions/artifacts`, then `/plugin install artifacts@ly-solutions-artifacts`.
- **Personal skill.** Copy the folder: `cp -r skills/artifacts ~/.claude/skills/`.
- **Project skill.** Commit it into a repository: `.claude/skills/artifacts/SKILL.md`.
- **Other agents.** Add the body of `SKILL.md` to the agent's instructions (`AGENTS.md` or similar).

Agent workspaces such as harnessly set `ARTIFACTS_SESSION` per conversation, so every document an agent
publishes links back to the conversation it came from. See `docs/integrations/harnessly.md`.
