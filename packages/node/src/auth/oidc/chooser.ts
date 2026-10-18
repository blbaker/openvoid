// The sign-in picker shown when more than one provider is configured. No external assets (no
// stylesheet, no script, no font, no image) so it works with no network access beyond this app.
import { escapeHtml } from './util.ts';
import type { ProviderConfig } from './config.ts';

export function renderChooser(providers: ProviderConfig[], basePath: string, returnTo: string): string {
  const items = providers
    .map((provider) => {
      const href = `${basePath}/login/${encodeURIComponent(provider.name)}?returnTo=${encodeURIComponent(returnTo)}`;
      return `      <li><a href="${escapeHtml(href)}">${escapeHtml(provider.label)}</a></li>`;
    })
    .join('\n');
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Sign in</title>
    <style>
      body { font-family: system-ui, sans-serif; max-width: 22rem; margin: 4rem auto; padding: 0 1rem; color: #111; }
      h1 { font-size: 1.25rem; }
      ul { list-style: none; padding: 0; }
      li { margin: 0.5rem 0; }
      a { display: block; padding: 0.75rem 1rem; border: 1px solid #ccc; border-radius: 6px; text-decoration: none; color: inherit; }
      a:hover { background: #f5f5f5; }
    </style>
  </head>
  <body>
    <h1>Sign in</h1>
    <ul>
${items}
    </ul>
  </body>
</html>
`;
}
