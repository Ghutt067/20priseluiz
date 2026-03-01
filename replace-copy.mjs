import fs from 'fs'
import path from 'path'

function walk(dir) {
  fs.readdirSync(dir, { withFileTypes: true }).forEach(e => {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p)
    else if (p.endsWith('.tsx')) {
      let c = fs.readFileSync(p, 'utf8')
      let b = c

      // Simple string replacements without regex special chars to avoid parse errors
      c = c.replaceAll('Buscar por nome, e-mail ou telefone...', 'Buscar contato')
      c = c.replaceAll('Buscar por cliente ou nº pedido...', 'Buscar pedido')
      c = c.replaceAll('Localizar produto por nome, código ou SKU...', 'Buscar produto')
      c = c.replaceAll('Buscar cliente por nome ou telefone...', 'Buscar cliente')
      c = c.replaceAll('Cond. pagamento (ex: à vista, 30/60/90)', 'Condição de pagamento')
      c = c.replaceAll('Colar do Excel (product_id[TAB]quantidade)', 'Importar via Excel')
      c = c.replaceAll('Colar do Excel (product_id[TAB]contado)', 'Importar via Excel')
      c = c.replaceAll('Checklist (uma linha por item)', 'Itens do checklist')
      c = c.replaceAll('Descreva o relato com ao menos 10 caracteres...', 'Descreva o relato')
      c = c.replaceAll('placeholder="UUID"', 'placeholder="Código"')
      c = c.replaceAll('placeholder="UUID do produto"', 'placeholder="Código do produto"')
      c = c.replaceAll('placeholder="UUID da organização"', 'placeholder="Código da organização"')
      c = c.replaceAll('Payload JSON (opcional)', 'Dados avançados (opcional)')
      c = c.replaceAll('placeholder="<?xml version=&quot;1.0&quot; ...>"', '')

      if (c !== b) {
        fs.writeFileSync(p, c)
        console.log('Fixed:', p)
      }
    }
  })
}

walk('src/features')
