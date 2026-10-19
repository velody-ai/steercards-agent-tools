# Images and card artifacts

Use images for inline Markdown screenshots/photos. Use card artifacts for a file tree such as Markdown reports, HTML demos and supporting assets. Public URLs can be opened by anyone who knows them; do not treat a stored artifact as private merely because metadata access requires a key.

## Inline images

Describe `create_image_upload` and prepare metadata from **local bytes**: file name, supported MIME, size, base64 SHA-256 and stable `clientRequestId`. PUT those bytes to the returned URL with exactly the returned headers, then `complete_image_upload`. Preparation URLs expire after ten minutes. MCP does not accept local file paths or base64 binary payloads in place of this transfer.

Use the returned stable Markdown/URL when updating a freshly read card description. Completion does not edit a card. `get_image` supplies metadata and a short-lived download URL; do not save that temporary URL in a permanent document. Client vision support is separate from metadata access.

On uncertainty call `get_image_upload`. A ready image is reusable; completion is idempotent. Completed images cannot be cancelled. A different file under the same request ID conflicts. Source-workspace deletion or eventual reference cleanup can invalidate public images.

## Artifact text and trees

- Read `list_artifacts` for paths and tree revision; it omits bodies. `get_artifact` returns text plus file revision, or image metadata. `get_artifact_url` avoids reading the body when only a link is needed.
- `write_artifact`: UTF-8 text up to 1 MiB, `expectedRevision:null` for creation or the current file revision for replacement, plus stable request ID. It publishes immediately.
- Folder creation, move, delete and batch upload use current **tree revision**. Parents must exist. Path moves invalidate old URLs and do not rewrite links in files.
- For paths use normalized relative `/` segments. Traversal, empty segments and reserved characters are rejected. Describe the tool and retain the server's path/MIME validation.
- A card's artifact limits currently include 200 entries, 100 MiB total, 1 MiB/text file and 10 MiB/raster image. Verify current errors/limits when they matter. Request JSON has a separate 7 MiB limit for escaped text.

## Binary or multiple artifact files

1. Read the tree and compare destination paths.
2. Prepare `create_artifact_upload` with extension-matching MIME, size, **base64** SHA-256 for each file, expected tree revision, explicit replacement choice and request ID.
3. PUT each original file using returned URL/method/headers. Send **no Agent Key or app cookies to storage**; do not rewrite signed URL host/port.
4. Complete the batch; verify `ready` and the resulting tree. Files publish atomically, not partially.

For uncertain text/structure writes inspect `get_artifact_request`. For batch uncertainty inspect `get_artifact_upload`: ready reuses the original result, verifying needs status observation, pending may resume PUT/completion. Rejected/cancelled/expired batches require a corrected new request against current state. A ready batch cannot be cancelled to undo publication.

409 means compare current file/tree against the intended content; do not automatically substitute fresh revisions. Preserve original request IDs/payloads for exact retries. The execution environment must reach both MCP and signed storage URLs.

HTML artifacts execute in a sandbox without same-origin privileges. Cookie/localStorage/service-worker assumptions may fail. Verify the actual public preview if execution behavior matters; saving bytes alone does not prove a demo runs.
