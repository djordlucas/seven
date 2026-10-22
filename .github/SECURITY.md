# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in Seven, **please do not** open a public issue.

Use GitHub's private vulnerability reporting: go to the [Security](https://github.com/djordlucas/seven/security) tab
and click **"Report a vulnerability"**. This creates a private advisory visible only to you and me.

Include as much detail as possible:
- Steps to reproduce the issue
- Impact assessment
- Potential mitigation or fix

I will acknowledge receipt within 48 hours.

## Scope

This policy applies to the Seven source code and its Docker image.

## Not In Scope

- **The VM's lack of a permission model.** Code the agent writes can read and write any file, run any command and
  reach any URL the seven process can. That is the design (see `docs/vm.md`), not a vulnerability. Run seven in its
  container.
- Vulnerabilities in dependencies (report to the upstream project)
- npm packages the agent chooses to install

## Preferred Languages

English or French.
