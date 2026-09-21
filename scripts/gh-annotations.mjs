/**
 * A node:test reporter that turns every failing test into a GitHub annotation.
 *
 * Why this exists: job logs on GitHub Actions need an authenticated request to
 * read, but annotations are public. When the Windows leg of CI first failed,
 * all the public record said was "Process completed with exit code 1" — the
 * failure was invisible to anyone reading the run without a token, including
 * the tooling that watches it. With this reporter, the test name and the
 * assertion message appear on the run page, on pull requests, and through the
 * public API.
 *
 * Used alongside the normal `spec` reporter; see `test:ci` in package.json.
 */

import path from 'node:path';

/** Workflow-command escaping, from the GitHub Actions toolkit. */
const escapeData = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const escapeProperty = (s) => escapeData(s).replace(/:/g, '%3A').replace(/,/g, '%2C');

export default async function* githubAnnotations(source) {
  for await (const event of source) {
    if (event.type !== 'test:fail') continue;
    const { name, details, file, line } = event.data;
    const error = details?.error;
    // node:test wraps assertion failures; the useful message is on the cause.
    const message = error?.cause?.message ?? error?.message ?? String(error);
    const props = [`title=${escapeProperty(name)}`];
    if (file) {
      // GitHub links an annotation to source only when the path is relative to
      // the repository root, with forward slashes.
      const absolute = file.replace(/^file:\/\/\/?/, '');
      const relative = path.relative(process.cwd(), absolute).split(path.sep).join('/');
      props.push(`file=${escapeProperty(relative)}`);
    }
    if (line) props.push(`line=${line}`);
    yield `::error ${props.join(',')}::${escapeData(message.slice(0, 900))}\n`;
  }
}
