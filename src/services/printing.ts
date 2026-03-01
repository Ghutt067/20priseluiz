export type PrintPreset =
  | 'thermal_80mm'
  | 'thermal_58mm'
  | 'a4'
  | 'a5'
  | 'label_60x40'
  | 'label_40x25'
  | 'label_100x150'
  | 'jewelry_label'
  | 'exchange_voucher'
  | 'cash_closing'
  | 'cargo_manifest'

export const printPresetOptions: Array<{ value: PrintPreset; label: string }> = [
  { value: 'thermal_80mm', label: '80mm (Bobina)' },
  { value: 'thermal_58mm', label: '58mm (Bobina)' },
  { value: 'a4', label: 'A4 (Folha)' },
  { value: 'a5', label: 'A5 (Meia Folha)' },
  { value: 'label_60x40', label: '60x40mm (Gondola)' },
  { value: 'label_40x25', label: '40x25mm (Produto)' },
  { value: 'label_100x150', label: '100x150mm (Logistica)' },
  { value: 'jewelry_label', label: 'Etiqueta de Joia' },
  { value: 'exchange_voucher', label: 'Vale-Troca' },
  { value: 'cash_closing', label: 'Fechamento de Caixa' },
  { value: 'cargo_manifest', label: 'Romaneio de Carga' },
]

type PrintPresetConfig = {
  pageSize: string
  margin: string
  fontSize: string
}

const presetConfig: Record<PrintPreset, PrintPresetConfig> = {
  thermal_80mm: {
    pageSize: '80mm auto',
    margin: '4mm',
    fontSize: '11px',
  },
  thermal_58mm: {
    pageSize: '58mm auto',
    margin: '3mm',
    fontSize: '10px',
  },
  a4: {
    pageSize: 'A4 portrait',
    margin: '10mm',
    fontSize: '12px',
  },
  a5: {
    pageSize: 'A5 portrait',
    margin: '8mm',
    fontSize: '11px',
  },
  label_60x40: {
    pageSize: '60mm 40mm',
    margin: '2mm',
    fontSize: '10px',
  },
  label_40x25: {
    pageSize: '40mm 25mm',
    margin: '1.5mm',
    fontSize: '9px',
  },
  label_100x150: {
    pageSize: '100mm 150mm',
    margin: '3mm',
    fontSize: '11px',
  },
  jewelry_label: {
    pageSize: '50mm 22mm',
    margin: '1.5mm',
    fontSize: '8px',
  },
  exchange_voucher: {
    pageSize: '80mm auto',
    margin: '4mm',
    fontSize: '11px',
  },
  cash_closing: {
    pageSize: '80mm auto',
    margin: '4mm',
    fontSize: '11px',
  },
  cargo_manifest: {
    pageSize: 'A4 portrait',
    margin: '8mm',
    fontSize: '11px',
  },
}

export function isDesktopRuntime() {
  return globalThis.window !== undefined && '__TAURI__' in globalThis.window
}

export function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function buildPrintDocument(input: {
  title: string
  subtitle?: string
  preset: PrintPreset
  bodyHtml: string
  footerText?: string
}) {
  const config = presetConfig[input.preset]

  return `<!doctype html>
<html lang="pt-BR">
  <head>
    <meta charset="utf-8" />
    <title>${escapeHtml(input.title)}</title>
    <style>
      @page {
        size: ${config.pageSize};
        margin: ${config.margin};
      }
      * {
        box-sizing: border-box;
      }
      html,
      body {
        margin: 0;
        padding: 0;
        font-family: 'Segoe UI', Tahoma, sans-serif;
        color: #1f2937;
        font-size: ${config.fontSize};
      }
      body {
        padding: ${config.margin};
      }
      h1 {
        font-size: 1.1em;
        margin: 0 0 4px;
      }
      p {
        margin: 0;
      }
      .print-subtitle {
        color: #4b5563;
        margin-bottom: 8px;
      }
      .print-body {
        border: 1px solid #d1d5db;
        border-radius: 6px;
        padding: 8px;
      }
      .print-body pre {
        margin: 0;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        font-family: 'Cascadia Mono', 'Consolas', monospace;
      }
      .print-table {
        width: 100%;
        border-collapse: collapse;
      }
      .print-table th,
      .print-table td {
        border: 1px solid #d1d5db;
        padding: 4px 6px;
        text-align: left;
      }
      .print-footer {
        margin-top: 8px;
        color: #6b7280;
        font-size: 0.92em;
      }
    </style>
  </head>
  <body>
    <h1>${escapeHtml(input.title)}</h1>
    ${input.subtitle ? `<p class="print-subtitle">${escapeHtml(input.subtitle)}</p>` : ''}
    <div class="print-body">${input.bodyHtml}</div>
    ${input.footerText ? `<p class="print-footer">${escapeHtml(input.footerText)}</p>` : ''}
  </body>
</html>`
}

function popupFeaturesForPreset(preset: PrintPreset) {
  if (preset.startsWith('label_') || preset.startsWith('thermal_') || preset === 'jewelry_label') {
    return 'width=420,height=640'
  }
  if (preset === 'a4' || preset === 'cargo_manifest') {
    return 'width=980,height=900'
  }
  return 'width=840,height=760'
}

function waitForMs(durationMs: number) {
  return new Promise<void>((resolve) => {
    globalThis.window.setTimeout(() => resolve(), durationMs)
  })
}

function waitForAfterPrint(targetWindow: Window, timeoutMs = 1500) {
  return new Promise<void>((resolve) => {
    let resolved = false

    const finish = () => {
      if (resolved) return
      resolved = true
      targetWindow.removeEventListener('afterprint', finish)
      globalThis.window.clearTimeout(timer)
      resolve()
    }

    const timer = globalThis.window.setTimeout(() => {
      finish()
    }, timeoutMs)

    targetWindow.addEventListener('afterprint', finish)
  })
}

async function printLoadedIframe(iframe: HTMLIFrameElement) {
  await waitForMs(100)
  const targetWindow = iframe.contentWindow
  if (!targetWindow) {
    throw new Error('Nao foi possivel abrir a janela de impressão.')
  }

  targetWindow.focus()
  targetWindow.print()
  await waitForAfterPrint(targetWindow)
}

async function printWithIframe(documentHtml: string) {
  if (globalThis.document === undefined) {
    throw new Error('Impressao indisponivel neste ambiente.')
  }

  const blobUrl = globalThis.URL.createObjectURL(
    new Blob([documentHtml], { type: 'text/html;charset=utf-8' }),
  )

  await new Promise<void>((resolve, reject) => {
    const iframe = globalThis.document.createElement('iframe')
    iframe.style.position = 'fixed'
    iframe.style.right = '0'
    iframe.style.bottom = '0'
    iframe.style.width = '0'
    iframe.style.height = '0'
    iframe.style.border = '0'
    iframe.style.opacity = '0'

    const cleanup = () => {
      iframe.remove()
      globalThis.URL.revokeObjectURL(blobUrl)
    }

    iframe.onload = () => {
      void printLoadedIframe(iframe)
        .then(() => {
          cleanup()
          resolve()
        })
        .catch((error: unknown) => {
          cleanup()
          reject(error instanceof Error ? error : new Error('Falha ao imprimir documento.'))
        })
    }

    iframe.onerror = () => {
      cleanup()
      reject(new Error('Falha ao carregar documento para impressão.'))
    }

    iframe.src = blobUrl
    globalThis.document.body.appendChild(iframe)
  })
}

export async function printHtmlDocument(input: {
  title: string
  subtitle?: string
  preset: PrintPreset
  bodyHtml: string
  footerText?: string
}) {
  if (globalThis.window === undefined) {
    throw new Error('Impressao disponivel apenas no navegador ou app desktop.')
  }

  const documentHtml = buildPrintDocument(input)

  if (isDesktopRuntime()) {
    await printWithIframe(documentHtml)
    return {
      runtime: 'desktop' as const,
    }
  }

  const popup = globalThis.window.open('', '_blank', popupFeaturesForPreset(input.preset))
  if (!popup) {
    await printWithIframe(documentHtml)
    return {
      runtime: 'web' as const,
    }
  }

  const blobUrl = globalThis.URL.createObjectURL(
    new Blob([documentHtml], { type: 'text/html;charset=utf-8' }),
  )

  try {
    popup.location.href = blobUrl

    await new Promise<void>((resolve) => {
      globalThis.window.setTimeout(() => resolve(), 120)
    })

    popup.focus()
    popup.print()
    await waitForAfterPrint(popup)
    popup.close()
  } finally {
    globalThis.URL.revokeObjectURL(blobUrl)
  }

  return {
    runtime: 'web' as const,
  }
}
