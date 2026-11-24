// Keep directory indexing, preview classification and raw responses in sync.
const IMAGE_MIME_TYPES = Object.freeze({
  ".png": "image/png",
  ".apng": "image/apng",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
});

module.exports = { IMAGE_MIME_TYPES };
