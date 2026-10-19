# Security

## Supported versions

artifacts is in `0.x`: fixes land on `main` and in the next release. Use the latest release.

## Reporting a vulnerability

Please report security problems privately, through GitHub's private vulnerability reporting: open the repository's
**Security** tab and choose **Report a vulnerability**. Do not open a public issue or pull request for them.

Include what you found, the commit or release it applies to, how to reproduce it, and what an attacker gains. We will
acknowledge the report within a few working days, keep you informed while we fix it, and credit you in the release
notes unless you ask us not to.

## Scope

The boundaries that matter most:

- **Published HTML is hostile by assumption.** Documents are served from `/a/{slug}/raw` and `/s/{token}/raw` with
  a CSP `sandbox` without `allow-same-origin`. A document that reads cookies, calls the API, escapes the sandbox,
  or runs script in the reader or catalog pages is a vulnerability.
- **Authentication and roles:** bearer tokens (editor and viewer), session cookies, the OIDC flow (state, nonce,
  PKCE, ID token verification), and the trusted-proxy mode, which must ignore user headers from addresses outside
  `ARTIFACTS_PROXY_TRUSTED_CIDRS`.
- **Share links:** a link must open exactly one artifact, read-only, only while sharing is on and only within its
  generation and expiry. Refusals must not reveal whether an artifact exists.
- **Cross-site requests:** cookie-authenticated writes are accepted only from the server's own origin.
- **Storage keys:** no request may make the server read or write outside its layout (`meta/`, `content/`,
  `system/`).
- **The importer** runs `git` on a repository you point it at; treat repositories you import like code you run.

Tokens and secrets in tests and in `compose.yaml` are fixtures for local use and grant nothing; reports about them
are not needed.

## Hardening checklist for operators

- Set `ARTIFACTS_PUBLIC_URL` to an `https://` address so cookies are `Secure`.
- Generate tokens with `openssl rand -hex 32`; give agents editor tokens and dashboards viewer tokens.
- Keep `ARTIFACTS_CONTENT_CONNECT_SRC` empty unless documents must call a cookie-free API.
- Restrict the bucket credentials to the prefix the server uses.
