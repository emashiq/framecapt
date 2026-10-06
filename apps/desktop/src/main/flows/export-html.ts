/** What one step contributes to the HTML guide. */
export interface GuideHtmlStep {
  caption: string;
  /** PNG bytes: the step with the pointer ring burned in. */
  png: Uint8Array;
}

export interface GuideHtmlInput {
  title: string;
  /** "7 October 2026": already formatted by the caller. */
  generated: string;
  steps: readonly GuideHtmlStep[];
}

/** Text for an HTML text node or a double-quoted attribute: nothing a person typed can become markup. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const STYLE = `
:root { color-scheme: light dark; --bg: #f8fafc; --fg: #0f172a; --muted: #64748b; --line: #e2e8f0; --accent: #4f46e5; --card: #ffffff; }
@media (prefers-color-scheme: dark) { :root { --bg: #0b0f1a; --fg: #e2e8f0; --muted: #94a3b8; --line: #1e293b; --accent: #818cf8; --card: #111827; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 920px; margin: 0 auto; padding: 40px 20px 64px; }
h1 { margin: 0 0 4px; font-size: 1.9rem; line-height: 1.2; letter-spacing: -0.01em; }
.meta { margin: 0 0 32px; color: var(--muted); font-size: 0.9rem; }
ol { list-style: none; margin: 0; padding: 0; display: grid; gap: 28px; }
li { background: var(--card); border: 1px solid var(--line); border-radius: 14px; overflow: hidden; }
.step { display: flex; align-items: baseline; gap: 12px; padding: 16px 18px 12px; }
.num { flex: none; min-width: 2rem; height: 2rem; border-radius: 999px; background: var(--accent); color: #fff; font-weight: 600; font-size: 0.9rem; display: inline-grid; place-items: center; }
.caption { margin: 0; font-size: 1.05rem; }
.caption.empty { color: var(--muted); }
img { display: block; width: 100%; height: auto; border-top: 1px solid var(--line); }
@media print { body { background: #fff; color: #000; } li { break-inside: avoid; border-color: #ccc; } }
`;

/**
 * One self-contained HTML page: inline CSS, the pictures as `data:` URIs, no script and no
 * address of any kind that the page would load (its own Content-Security-Policy forbids it).
 * Every piece of text a person typed goes through `escapeHtml`.
 */
export function buildGuideHtml(input: GuideHtmlInput): string {
  const title = escapeHtml(input.title);
  const items = input.steps
    .map((step, index) => {
      const number = index + 1;
      const caption = step.caption.trim();
      const label = caption === '' ? `Step ${number}` : `Step ${number}: ${caption}`;
      const text =
        caption === ''
          ? `<p class="caption empty">Step ${number}</p>`
          : `<p class="caption">${escapeHtml(caption)}</p>`;
      const data = Buffer.from(step.png).toString('base64');
      return `<li><div class="step"><span class="num">${number}</span>${text}</div><img alt="${escapeHtml(label)}" src="data:image/png;base64,${data}"></li>`;
    })
    .join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">
<title>${title}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<h1>${title}</h1>
<p class="meta">${input.steps.length} ${input.steps.length === 1 ? 'step' : 'steps'} · Created with FrameCapt on ${escapeHtml(input.generated)}</p>
<ol>
${items}
</ol>
</main>
</body>
</html>
`;
}
