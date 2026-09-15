# HTML Port Importer

A small, dependency-free Node.js tool for transferring an exact, normalized HTML source bundle into a dedicated directory and independently verifying it.

Requires Node.js 20 or newer on Linux with `/proc/self/fd` available (including Replit). Descriptor-relative traversal prevents verification and serving from following swapped path ancestors. Other operating systems are not supported.

## Simple fixture workflow

Run the importer from the repository root:

```sh
node import.mjs
```

This reads `fixtures/manifest.json`, validates the SHA-256 and byte length of
`fixtures/index.html`, `fixtures/style.css`, and `fixtures/app.js`, and copies
the exact files into `imported-app`. It does not write outside `imported-app`
and never executes the imported source.

Verify the imported files independently:

```sh
node verify.mjs
```

Success prints `PASS`. A missing file, extra file, changed hash, symlink,
non-regular file, or unsafe manifest path prints `FAIL` and exits nonzero.
Running `node import.mjs` again leaves an already-correct `imported-app`
unchanged.

The fixture is a harmless static page with the heading **Exact import test**.
Its **Test interaction** button displays **Interaction passed** when clicked.

Files created by the simple importer:

```text
imported-app/
├── app.js
├── index.html
└── style.css
```

Run all automated checks with:

```sh
npm test
```

## Install from GitHub

Pin installation to a full Git commit SHA. Replace `<FULL_COMMIT_SHA>` with the 40-character commit you reviewed:

```sh
git clone https://github.com/makerdan/html-port-importer.git
cd html-port-importer
git checkout <FULL_COMMIT_SHA>
```

Do not install from an unpinned branch or tag when exact transfer is required.

Installation into another Replit project has not been tested by this repository.

## Advanced exact-bundle import

Obtain the expected manifest SHA-256 through a separate trusted channel from the bundle and manifest:

```sh
node bin/import.mjs \
  --bundle fixtures/hello/bundle.json \
  --manifest fixtures/hello/manifest.json \
  --manifest-sha256 "$(sha256sum fixtures/hello/manifest.json | cut -d' ' -f1)" \
  --dest /tmp/imported-html
```

The importer validates the separately supplied manifest hash, validates the exact bundle hash and every file, stages the complete tree, verifies it, atomically reserves the destination, and atomically renames the stage over that importer-owned empty reservation. An existing destination is accepted only if it already matches exactly; that repeat operation does not modify it.

## Advanced independent verification

Keep any captured verification report outside the imported directory:

```sh
node bin/verify.mjs \
  --manifest fixtures/hello/manifest.json \
  --manifest-sha256 "$(sha256sum fixtures/hello/manifest.json | cut -d' ' -f1)" \
  --dest /tmp/imported-html > /tmp/import-verification.json
```

Successful output has `"status":"Verified"`. Verification detects missing, extra, changed, and symlinked files.

## Serve

Imported source is untrusted. Get explicit user approval before running or serving it. Import and source verification do not prove that the source behaves safely or correctly at runtime.

```sh
node bin/serve.mjs --root /tmp/imported-html --entrypoint index.html --port 8080
```

The server binds only to `127.0.0.1`, disables directory listings, serves the selected entrypoint at `/`, and rejects paths outside its root. Stop it with `Ctrl-C`.

## Exit codes

- `0`: operation completed and, for import/verify, exact source verification passed.
- `1`: validation, download, import, or verification failed.
- `2`: command usage was invalid.

## Bundle and manifest format

Both JSON documents use `"version": 1`. A bundle has an `entrypoint` and `files` containing relative `path` and strict canonical `base64`. A manifest has the SHA-256 of the exact `bundle.json` bytes, the same entrypoint, and each file's relative path, byte length, and SHA-256.

## Security boundaries

URL inputs must be public HTTPS destinations. Credentials, private/reserved DNS results, unsafe redirects, and HTTPS downgrades are rejected. DNS results used by the connection are the validated public addresses. Inputs, file counts, path lengths, download times, and total decoded bytes are bounded. The importer never executes source, installs its dependencies, or runs its package scripts.

The importer protects against untrusted bundle data and filesystem content. A separate hostile process running under the same operating-system user can still mutate that user's files; isolate imports from untrusted same-user processes.

The fixture manifest hash can be obtained locally with:

```sh
sha256sum fixtures/hello/manifest.json
```
