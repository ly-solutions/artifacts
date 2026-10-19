# Contributing

Thanks for helping. Bug reports, documentation fixes and pull requests are all welcome.

## Before you start

- For a bug, open an issue with what you did, what you expected and what happened (logs help; remove tokens).
- For a feature, open an issue first and describe the job it does for you, so we can agree on the shape before code.
- Security problems go through private reporting, see [SECURITY.md](SECURITY.md).

## Development

Requirements: Node.js 22 or newer, `git`. Docker only for the image and compose checks.

```bash
npm ci
npm test          # node:test; S3 runs against an in-process fake that verifies SigV4 signatures
npm run lint      # oxlint
npm run dev       # server on :8080 with fs storage in ./data and no auth, restarts on change
node scripts/demo-seed.mjs   # example documents (ARTIFACTS_URL / ARTIFACTS_TOKEN)
```

Against a real S3 endpoint (CI uses MinIO):

```bash
docker run -d --name minio -p 127.0.0.1:9000:9000 -e MINIO_ROOT_USER=test -e MINIO_ROOT_PASSWORD=test-secret-123 \
  pgsty/minio:RELEASE.2026-08-04T00-00-00Z server /data
ARTIFACTS_TEST_S3_ENDPOINT=http://127.0.0.1:9000 ARTIFACTS_TEST_S3_BUCKET=artifacts-test ARTIFACTS_TEST_S3_ACCESS_KEY_ID=test \
  ARTIFACTS_TEST_S3_SECRET_ACCESS_KEY=test-secret-123 npm test
```

Helm: `helm lint --strict deploy/helm/artifacts -f deploy/helm/artifacts/ci/s3-values.yaml` (and the other files in
`ci/`). If you change `values.yaml`, update the values table in the chart README.

## Guidelines

- **No build step.** The server is plain ES modules on Node.js; the browser code is small, framework-free and
  optional (every page works without it).
- **Few dependencies.** Each new runtime dependency needs a reason; `node scripts/check-licenses.mjs` must pass
  (permissive licenses only).
- **Comments say why**, not what. Error messages say what to change.
- **Everything configurable is an environment variable**, documented in `docs/configuration.md` (a test checks).
- **Tests come with changes.** Storage changes go through the driver conformance suite in `test/storage.test.mjs`.
- **Security-sensitive paths** (content serving, auth, share links, storage keys) need a test for the refusal too.

## Commits and pull requests

- Use [Conventional Commits](https://www.conventionalcommits.org/): `feat(cli): …`, `fix(storage): …`, `docs: …`.
- Keep pull requests focused; describe what changed and how you checked it.
- Add a line to `CHANGELOG.md` under "Unreleased" for anything a user would notice.
- By contributing you agree that your contribution is licensed under the [Apache-2.0](LICENSE) license.

## Releases

Maintainers tag `vX.Y.Z` on `main`. The release workflow builds and pushes the multi-arch image to
`ghcr.io/ly-solutions/artifacts` and the Helm chart to `oci://ghcr.io/ly-solutions/charts`, and publishes the npm
package when an npm token is configured.
