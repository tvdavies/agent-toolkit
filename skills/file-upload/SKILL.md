---
name: file-upload
description: Upload a local file such as a screenshot, screen recording, log, or HTML artifact to the user's public file host at files.myslop.app and return a permanent public URL. Use whenever a public link to a local file is needed, including for GitHub pull requests, Slack messages, or sharing HTML documents.
---

# File upload

Upload files to `https://files.myslop.app` and return the permanent public URL from the response body. Authenticate with `$FILE_HOST_TOKEN`. If it is unset, tell the user instead of guessing.

## Upload

```bash
curl -sS --fail-with-body -X PUT -T <path-to-file> \
  -H "X-Upload-Token: $FILE_HOST_TOKEN" \
  "https://files.myslop.app/<filename>"
```

- The response body is the permanent public URL (the server adds a random prefix, so the URL differs from the upload path — always use the returned URL, never construct it yourself).
- `<filename>` should be just the basename, URL-encoded if it contains spaces or special characters. Prefer descriptive kebab-case names since the filename is visible in the shared URL.
- Content-Type is inferred from the file extension server-side; pass an explicit `-H "Content-Type: ..."` only for unusual types.
- Uploaded HTML is served as a browsable page, so this works for sharing HTML artifacts/reports directly.
- Files are durable: they stay up until manually deleted from the `myslop-files` R2 bucket.

## After uploading

Share the returned URL directly (PR comment, Slack, etc.). Verify the upload succeeded via curl's exit code / `--fail-with-body` output rather than fetching the URL back.
