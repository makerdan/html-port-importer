---
name: html-port-importer
description: Install and invoke the exact HTML source bundle importer and verifier.
---

# HTML Port Importer

Use this repository only to transfer an exact normalized HTML source bundle into a dedicated directory, verify that source, and optionally serve it after approval.

## Installation

1. Clone `https://github.com/makerdan/html-port-importer.git`.
2. Check out a reviewed, full 40-character Git commit SHA. Never install from a moving branch or unpinned tag when exact transfer is required.
3. Require Node.js 20 or newer on Linux with `/proc/self/fd` available, as on Replit. No package installation is needed. Report **Blocked** on unsupported operating systems.

## Import

Require all four values and do not infer the expected manifest hash from the downloaded manifest:

```sh
node bin/import.mjs --bundle <local-file-or-https-url> \
  --manifest <local-file-or-https-url> \
  --manifest-sha256 <expected-hash-from-separate-trusted-channel> \
  --dest <new-dedicated-directory>
```

Do not execute imported files, install their dependencies, or run their package scripts.

## Source verification

Run the verifier independently and keep its report outside the imported directory:

```sh
node bin/verify.mjs --manifest <local-file> \
  --manifest-sha256 <expected-hash> --dest <directory>
```

Only report **Verified** after this command exits 0 and returns `"status":"Verified"`. A download alone is not a successful import.

Report:

- **Verified**: the verifier ran and confirmed the exact manifest, file set, hashes, and entrypoint.
- **Failed**: the verifier ran and reported any disagreement.
- **Blocked**: required input, separate trusted hash, filesystem access, network access, or user approval is unavailable.

## Runtime verification

Source verification proves exact bytes only. It does not prove runtime behavior or safety. Obtain explicit user approval before serving imported code:

```sh
node bin/serve.mjs --root <directory> \
  --entrypoint <relative-path> --port <port>
```

Stop the server with `Ctrl-C`. Describe runtime observations separately from source verification.

## Stopping rules

- Stop if the expected manifest hash did not arrive through a channel separate from the download.
- Stop on any hash, path, file-set, size, redirect, DNS, symlink, or entrypoint failure.
- Stop rather than overwrite or delete an existing non-matching destination.
- Never claim this skill grants API access, guarantees Agent execution, or verifies runtime safety.