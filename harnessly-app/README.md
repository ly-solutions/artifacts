# «Документы»: the harnessly app of this catalog

A [harnessly](https://github.com/ly-solutions/harnessly) app package for this service: the agent finds, reads and
shares documents with the MCP tools of [`/mcp`](../docs/mcp.md) (`doc_find`, `doc_show`, `doc_versions`,
`doc_share`), and the person gets «Документы» in «Приложения» with the latest documents they may read. Publishing
stays with the hub, which owns the rights.

- `harnessly/app.json`: the manifest (`trust: sandboxed`, targets `app` and `chat`).
- `.mcp.json`: the `docs` server, `${install:artifactsUrl}/mcp`, signed in with the platform's token (`auth: platform`).
- `instructions.md`, `skills/documents/`: how the agent works with documents (in Russian, the product's language).
- `ui/`: the app's home; `evals/`: cases for `harnessly app eval`.

## Put it into an organization

1. Run the service with `ARTIFACTS_AUTH=harnessly` ([the harnessly integration](../docs/integrations/harnessly.md)).
   The hub has `HUB_ARTIFACTS_URL`, `HUB_ARTIFACTS_ACCESS_TOKEN` and, when it reaches the service by an internal
   address, `HUB_ARTIFACTS_PUBLIC_URL`: the address machines and browsers reach.
2. An organization admin adds an «Приложение» item to the environment: this repository, folder `harnessly-app`. The
   machines put the service's address in place of `${install:artifactsUrl}`; without one the app is not configured
   and not shown.
3. «В организации» → «Выключено у всех» takes the menu item and the tools away from everybody; documents and links
   to them stay.

## Check

```sh
harnessly app validate ./harnessly-app --strict
harnessly app eval ./harnessly-app
```
