/** Markdown and HTML form lengths use UTF-16 code units. */
export const ARTIFACT_CONTENT_LIMIT = 50_000;
export const ARTIFACT_TITLE_LIMIT = 150;

// JSON can encode one code unit in six characters. Allow the title, request ID and object framing.
export const ARTIFACT_REVISION_BODY_LIMIT = 6 * (ARTIFACT_CONTENT_LIMIT + ARTIFACT_TITLE_LIMIT + 128) + 256;
