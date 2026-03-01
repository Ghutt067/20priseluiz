/**
 * Generates a printable HTML document in a new window for PDF export via browser print dialog.
 * Works in all modern browsers without external dependencies.
 */
export function exportPdf(options: {
  title: string
  header?: string[]
  rows?: unknown[][]
  htmlContent?: string
  orientation?: 'portrait' | 'landscape'
}) {
  const { title, header, rows, htmlContent, orientation = 'portrait' } = options
  const win = window.open('', '_blank')
  if (!win) return

  let tableHtml = ''
  if (header && rows) {
    const thead = header.map((h) => `<th>${esc(h)}</th>`).join('')
    const tbody = rows
      .map((row) => `<tr>${row.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`)
      .join('')
    tableHtml = `<table><thead><tr>${thead}</tr></thead><tbody>${tbody}</tbody></table>`
  }

  const body = htmlContent ?? tableHtml

  win.document.write(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <title>${esc(title)}</title>
  <style>
    @page { size: ${orientation}; margin: 12mm 10mm; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, 'Segoe UI', sans-serif; font-size: 10px; color: #1a1a1a; padding: 8px; }
    h1 { font-size: 14px; font-weight: 600; margin-bottom: 2px; }
    .meta { font-size: 9px; color: #888; margin-bottom: 10px; }
    table { width: 100%; border-collapse: collapse; font-size: 9px; }
    th { background: #f5f5f5; text-align: left; padding: 4px 6px; border-bottom: 1.5px solid #ccc; font-weight: 600; font-size: 8.5px; text-transform: uppercase; letter-spacing: 0.3px; }
    td { padding: 3px 6px; border-bottom: 0.5px solid #e5e5e5; }
    tr:nth-child(even) { background: #fafafa; }
    .footer { margin-top: 12px; font-size: 8px; color: #999; text-align: right; }
    @media print { body { padding: 0; } }
  </style>
</head>
<body>
  <h1>${esc(title)}</h1>
  <div class="meta">Gerado em ${new Date().toLocaleString('pt-BR')} — VinteEnterprise</div>
  ${body}
  <div class="footer">Página gerada automaticamente</div>
  <script>window.onload=function(){window.print()}</` + `script>
</body>
</html>`)
  win.document.close()
}

function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
