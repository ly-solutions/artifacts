# Storage and migration

## Drivers

| Driver | Use it for | Replicas |
|---|---|---|
| `s3` | Everything real: AWS S3, MinIO, Ceph RGW, Cloudflare R2, Garage, SeaweedFS, any cloud object storage | any number |
| `fs` | A laptop, a single small VM, tests | one |

Both implement the same five calls (`get`, `head`, `put` with `If-Match` / `If-None-Match`, `delete`, `list`,
plus `check` for readiness), in [`src/storage`](../src/storage). The S3 driver signs requests with SigV4 itself
(about 150 lines, no SDK), so it has no dependencies to audit or update.

The sibling project [ly-solutions/boards](https://github.com/ly-solutions/boards) uses the same object-store
surface, the same conditional-write semantics and the same variable names with its own prefix
(`BOARDS_S3_BUCKET`, `BOARDS_DATA_DIR`, …), so both can live in one bucket under different prefixes.

## Layout

```
<prefix>meta/<slug>.json                          manifest: metadata and the list of versions
<prefix>content/<slug>/<versionId>/index.html     a version's page
<prefix>content/<slug>/<versionId>/document.md    a version's Markdown source (optional)
<prefix>system/secret.json                        generated signing key, when ARTIFACTS_SECRET is unset
```

A manifest looks like this (abridged):

```json
{
  "schema": 1,
  "slug": "checkout-latency-incident-14-march-vtto3m",
  "title": "Checkout latency incident, 14 March",
  "tags": ["incident", "payments"],
  "task": "PROJ-342",
  "session": "conv-31c7",
  "public": false,
  "share": { "gen": 2 },
  "createdAt": "2026-10-19T20:12:31Z",
  "updatedAt": "2026-10-19T20:12:32Z",
  "versions": [
    { "id": "20261019T201231Z-1f0e2d", "createdAt": "…", "author": "Ada", "note": null, "html": true, "markdown": false, "bytes": 2210, "sha256": "…" },
    { "id": "20261019T201232Z-9c41ab", "createdAt": "…", "author": "Ada", "note": "added the timeline", "html": true, "markdown": false, "bytes": 2817, "sha256": "…" }
  ]
}
```

### Why versions are objects plus a manifest

- **Immutable content.** A version's files are written once, under a unique id, with `If-None-Match: *`. They can
  be cached, replicated and backed up like static files, and an object lock or retention policy can protect them.
- **One small mutable object per artifact.** Publishing appends to the manifest with a compare-and-swap on its
  ETag (`If-Match`). Two agents publishing to the same slug at once both succeed: the loser of the swap re-reads
  and appends again, so versions are numbered in order and none is lost.
- **Cheap listing.** All manifests sit in one prefix, so one `ListObjectsV2` page returns a thousand artifacts with
  their ETags; the in-memory index re-reads only manifests whose ETag changed.
- **Not bucket versioning,** which is missing on several S3-compatible stores and on a filesystem, keeps deleted
  documents around as delete markers, and cannot attach an author and a note to a version.

An interrupted publish can leave a content object without a manifest entry. It is unreachable and harmless; a
lifecycle rule on `content/` objects older than a day that no manifest references, or a periodic cleanup job,
can reclaim it.

### Consistency

S3 has strong read-after-write consistency, so every replica sees a manifest as soon as it is written. Search
results on other replicas lag by at most `ARTIFACTS_INDEX_REFRESH` (10 s by default); reading an artifact by slug
always goes to storage.

For stores without conditional PUT, set `ARTIFACTS_S3_CONDITIONAL_WRITES=off` and run a single replica.

### Stores without atomic preconditions

Some S3-compatible stores check `If-None-Match` and `If-Match` correctly when requests arrive one at a time,
but let several overlapping writes to the same key all succeed. One such store, measured in 2026, is
Selectel object storage in ru-3. 8 simultaneous creates of one new key gave 7 or 8 successes, and 8
simultaneous updates carrying the same ETag all succeeded. Without protection, two concurrent publishes of one
document both report success and one version is lost.

The S3 driver therefore sends conditional writes to one key one after another inside the process, so the store
only sees sequential preconditions. Writes to different keys and unconditional writes still run in parallel.
That covers one process. Two processes still race, so on such a store:

- run **one replica**;
- deploy with **`strategy: Recreate`** so the old and the new pod never overlap (Helm: `strategy.type: Recreate`).

Check your store before running more than one replica:

```sh
artifacts storage-check                       # the store from ARTIFACTS_* variables
artifacts storage-check --storage s3://bucket/prefix --parallel 16
```

It writes two temporary objects under `system/` and removes them again. It exits 0 when exactly one of N
overlapping creates and exactly one of N overlapping updates win, and 1 otherwise, with the counts in its report.
AWS S3 and MinIO pass.

### Stores with slow reads

Some stores start sending an object only after seconds while HEAD and listings stay fast. One example is Selectel
ru-3, measured in 2026 at about 4 s per GET whatever the size, against 0.1–0.3 s for HEAD and LIST. The s3 driver
keeps a read cache in memory (`ARTIFACTS_CACHE_MB`, 128 MiB by default):

- version content is written once and served from memory without asking the store;
- manifests are revalidated with a HEAD and served from memory while the ETag is unchanged;
- documents published through the replica are cached as they are written.

Index build at start reads every current version, so it also fills the cache. Raise
`ARTIFACTS_INDEX_CONCURRENCY` to shorten that start on a slow store.

### Backups

Copy the bucket or prefix with any tool (`aws s3 sync`, `rclone`, `mc mirror`, provider replication), or use
`artifacts migrate --from s3://bucket/prefix --to /backup/dir` which copies every object.

## Migrating from a git repository

Teams often start by committing documents to a repository, one folder per document. `artifacts migrate` replays
that history:

```bash
export ARTIFACTS_S3_ENDPOINT=https://s3.example.com ARTIFACTS_S3_ACCESS_KEY_ID=… ARTIFACTS_S3_SECRET_ACCESS_KEY=…
artifacts migrate --from-git https://git.example.com/team/docs.git --to s3://artifacts/prod/ --dry-run
artifacts migrate --from-git https://git.example.com/team/docs.git --to s3://artifacts/prod/
```

Expected layout of the repository (the folder name is `--dir`, default `artifacts`):

```
artifacts/<slug>/index.html    every commit that changed it becomes a version, oldest first
artifacts/<slug>/document.md   optional; read at the same commit as the page
artifacts/<slug>/meta.yaml     title, description, author, task, tags, public, key, createdAt, updatedAt, link
```

- Commit trailers `Author:` and `Note:` become the version's author and note; otherwise the commit author is used.
- Each version keeps its **commit sha as the version id**, so `?v=<sha>` links resolve after the move. To keep
  new versions git-shaped too (for a reader that only accepts hex ids), set `ARTIFACTS_VERSION_ID=sha`.
- Commits that only touched `meta.yaml` are not versions.
- A document with `public: true` and a `key` keeps answering its old `/a/<slug>?k=<key>` link until sharing is
  turned off. Private documents do not keep their old keys.
- The import is idempotent: version objects are keyed by sha, and artifacts that already have a manifest are
  skipped unless `--overwrite`. `--only slug,slug` imports a subset; `--ref` picks a branch or tag.
- Folders without `meta.yaml` or with an invalid slug are reported as skipped.

The command prints a report and exits non-zero if any artifact failed:

```json
{ "artifacts": 214, "versions": 655, "skipped": [{ "slug": "broken", "reason": "no meta.yaml" }], "failed": [] }
```

`--to` also accepts a directory (`--to ./data`), and `--from <storage>` copies between any two stores, e.g. from
the `fs` driver of a trial to S3.
