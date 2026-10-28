# Release preparation

The source download is a local CLI project for macOS, Node.js, Codex CLI, and
Google Chrome. It is not a hosted shopping app. Keep GitHub private until the
public release has been reviewed.

## Build and inspect

1. Run `npm test`, `npm run typecheck`, `npm run lint`, and `npm run build`.
2. Run `npm run release:source`.
3. Inspect the archive with `tar -tzf releases/grocery-cart-agent-0.1.0.tar.gz`.
4. Extract it into a fresh folder and run `npm ci`, then repeat the checks.
5. Follow `manual-test-runbook.md` for a supervised live smoke with your own
   accounts. Offline checks do not establish live cart reliability.

The packaging script uses an explicit source allowlist and includes working
files, so uncommitted improvements appear in the download. Only files known
to Git or untracked and not ignored are eligible. Add new runtime files to the
allowlist when needed. Download archives include neither Git history nor local
run output. Source archives and checksums are written to ignored `releases/`.

## Before publishing

- Confirm the MIT `LICENSE` and package license metadata are included.
- Review current source and examples, plus any screenshots intended for the
  personal site. Name, ZIP, and recipe examples are intentionally retained.
- If making the existing GitHub repository public, scan its full history for
  credentials and runtime artifacts. Removing a tracked file does not remove
  historical copies. A source download does not contain those copies.
- Commit the reviewed source and synchronize GitHub before linking the project.
- Describe it as experimental, list the installation requirements, and state
  that users authenticate with their own accounts and supervise cart runs.
- Publish the inspected archive and its matching SHA-256 checksum together.

Keep run diagnostics local: they can contain recipe input, storefront text,
cart response bodies, account context, and browser-session details. Review and
redact individual files before using them as public examples.
