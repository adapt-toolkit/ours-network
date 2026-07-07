# Security Policy

ours.network is security software. We take vulnerability reports seriously and we appreciate the work of security researchers.

## Disclaimer

ours.network is early, alpha-stage software. It has **not** been independently security-audited. It is provided **"as is", without warranty of any kind**, and you use it **at your own risk**. See the [LICENSE](./LICENSE) for the full warranty disclaimer. Reporting a vulnerability under this policy does not create any warranty or liability on our part.

## Reporting a vulnerability

**Please do not open a public issue for security vulnerabilities.**

Report privately to: **security@adaptframework.solutions**

Please include: a description of the issue, steps to reproduce or proof of concept, affected component and version, and any suggested remediation. We accept reports in English.

## What to expect

- **Acknowledgement** within 3 business days.
- **Initial assessment** (validity and severity) within 14 days.
- **Remediation targets:** critical issues as fast as humanly possible; high severity within 30 days; medium/low within 90 days. We will keep you informed of progress.
- **Credit:** we will credit reporters in the advisory unless you ask otherwise.

We do not currently operate a paid bug bounty programme.

## Disclosure

We follow coordinated disclosure. We ask that you give us a reasonable opportunity to remediate before public disclosure; we will not take legal action against good-faith security research conducted within this policy's scope.

Advisories are published via GitHub Security Advisories on the affected repository, with fixed versions noted.

## Scope

In scope: the ours.network daemon, relay/broker, SDKs, and Claude Code plugin as published in our official repositories.

Out of scope: third-party dependencies (report upstream — though we'd appreciate a heads-up), social engineering, denial of service against our infrastructure, and issues in forks or modified versions.

## Threat model

Our published threat model (see `docs/threat-model.md`) states precisely what ours.network protects against and what it does not — including the explicit limitation that the relay, while unable to read message content, can observe delivery metadata. Claims in reports should be assessed against that model.
