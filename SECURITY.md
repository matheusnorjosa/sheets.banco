# Security Policy

## Reporting a vulnerability

If you believe you've found a security issue in `sheets.banco`, **do not open a
public GitHub issue**. Please use one of the channels below so the report stays
private until a fix is available.

- **Preferred:** GitHub Security Advisories — open one at
  https://github.com/matheusnorjosa/sheets.banco/security/advisories/new.
  Only repository maintainers can see it.
- **Email fallback:** matheusnorjosa@gmail.com.

When reporting, please include:

- A description of the issue and the impact you observed.
- Steps to reproduce (URLs, payloads, commit/version if known).
- Any logs, screenshots, or proof-of-concept code that helps confirm the bug.

## Scope

In scope:

- The HTTP API at `sheets-banco-api.onrender.com` (`packages/api/`).
- The web dashboard at `sheets-banco-web.vercel.app` (`packages/web/`).
- The published JavaScript SDK (`packages/sdk/`).
- CI/CD configuration in `.github/`.

Out of scope:

- Vulnerabilities in third-party services we consume (Google Sheets API,
  Render, Vercel, Neon, Upstash) — please report those directly to the
  respective provider.
- Issues that require an attacker already in control of a user's account
  (cookie/session theft from the user's own machine, etc.).
- Reports based purely on outdated dependency advisories — Dependabot is
  enabled and already opens PRs automatically.

## Response

- We acknowledge reports within **5 business days**.
- We aim to ship a fix or mitigation within **30 days** for critical/high
  severity issues.
- Reporters are credited in the release notes unless they ask to remain
  anonymous.

Thanks for helping keep `sheets.banco` users safe.
