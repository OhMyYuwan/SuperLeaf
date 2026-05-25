# Security Policy

SuperLeaf handles local documents, collaboration state, user accounts, provider credentials, and AI workflow traffic. Please report security issues privately and avoid publishing exploit details before maintainers have had time to respond.

## Supported Versions

The project is pre-1.0. Security fixes are generally applied to the active `main` branch unless a maintainer announces a supported release branch.

## Reporting a Vulnerability

Use GitHub's private vulnerability reporting feature if it is enabled for this repository. If it is not available, open a minimal public issue asking for a private maintainer contact method. Do not include secrets, exploit payloads, private documents, or full reproduction data in a public issue.

Please include:

- Affected component: frontend, backend, collaboration server, setup script, documentation, or provider integration.
- Impact and attack scenario.
- Reproduction steps or proof of concept, if safe to share privately.
- Relevant versions, commit SHA, operating system, and browser.
- Whether credentials, documents, or user data may be exposed.

## What to Report

Security-sensitive areas include:

- Authentication and session handling.
- Provider API key storage or transmission.
- Cross-user project, document, annotation, workflow, or conversation access.
- Collaboration server authorization and Yjs document isolation.
- Server-side file access, path traversal, upload handling, or LaTeX compilation risks.
- Cross-site scripting or unsafe rendering in Markdown, LaTeX preview, comments, or agent output.

## Response Expectations

Maintainers will try to acknowledge valid reports promptly, reproduce the issue, and coordinate a fix before public disclosure. Exact timelines depend on maintainer availability and issue severity.

## Safe Research

Do not test against systems you do not own or have explicit permission to assess. Do not access, modify, delete, or disclose other users' documents, credentials, conversations, or project data.

