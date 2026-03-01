import type { PoolClient } from 'pg'
import { XMLParser } from 'fast-xml-parser'
import { increaseNullBatchStockLevel } from '../core/stockLevelMutations'

type ImportarXmlCompraInput = {
  organizationId: string
  xml: string
  warehouseId?: string | null
}

function normalizeArray<T>(value: T | T[] | undefined): T[] {
  if (!value) return []
  return Array.isArray(value) ? value : [value]
}

export async function importarXmlCompra(client: PoolClient, input: ImportarXmlCompraInput) {
  const parser = new XMLParser({ ignoreAttributes: false })
  const parsed = parser.parse(input.xml)

  const nfe = parsed?.nfeProc?.NFe ?? parsed?.NFe
  const infNFe = nfe?.infNFe
  if (!infNFe) {
    throw new Error('XML invalido ou nao suportado.')
  }

  const emit = infNFe.emit
  const supplierName = emit?.xNome ?? 'Fornecedor'
  const supplierCnpj = emit?.CNPJ ?? emit?.CPF ?? null
  const supplierIe = emit?.IE ?? null

  const importResult = await client.query(
    `insert into xml_imports (organization_id, status, raw_xml)
     values ($1, 'processed', $2)
     returning id`,
    [input.organizationId, input.xml],
  )

  const xmlImportId = importResult.rows[0].id as string

  let supplierId: string | null = null
  if (supplierCnpj) {
    const existingSupplier = await client.query(
      'select id from suppliers where organization_id = $1 and cpf_cnpj = $2',
      [input.organizationId, supplierCnpj],
    )

    if (existingSupplier.rowCount) {
      supplierId = existingSupplier.rows[0].id
    } else {
      const supplierInsert = await client.query(
        `insert into suppliers (organization_id, person_type, name, legal_name, cpf_cnpj, ie, active)
         values ($1, 'legal', $2, $2, $3, $4, true)
         returning id`,
        [input.organizationId, supplierName, supplierCnpj, supplierIe],
      )

      supplierId = supplierInsert.rows[0].id
    }
  }

  await client.query(
    'update xml_imports set supplier_id = $1 where id = $2',
    [supplierId, xmlImportId],
  )

  let warehouseId = input.warehouseId ?? null
  if (!warehouseId) {
    const warehouseResult = await client.query(
      'select id from warehouses where organization_id = $1 order by created_at limit 1',
      [input.organizationId],
    )

    if (warehouseResult.rowCount) {
      warehouseId = warehouseResult.rows[0].id
    } else {
      const warehouseInsert = await client.query(
        `insert into warehouses (organization_id, name)
         values ($1, 'Deposito Principal')
         returning id`,
        [input.organizationId],
      )
      warehouseId = warehouseInsert.rows[0].id
    }
  }

  if (!warehouseId) {
    throw new Error('Depósito não encontrado para importar XML de compra.')
  }

  const details = normalizeArray(infNFe.det)

  for (const det of details) {
    const prod = det?.prod ?? {}
    const sku = prod.cProd ?? null
    const description = prod.xProd ?? 'Produto'
    const quantity = Number(prod.qCom ?? 0)
    const unitCost = Number(prod.vUnCom ?? 0)
    const ncm = prod.NCM ?? null

    let productId: string | null = null
    if (sku) {
      const existingProduct = await client.query(
        'select id from products where organization_id = $1 and sku = $2',
        [input.organizationId, sku],
      )

      if (existingProduct.rowCount) {
        productId = existingProduct.rows[0].id
      } else {
        const productInsert = await client.query(
          `insert into products
            (organization_id, sku, name, product_type, ncm, uom, price, cost, active)
           values ($1, $2, $3, 'product', $4, 'UN', $5, $5, true)
           returning id`,
          [input.organizationId, sku, description, ncm, unitCost],
        )
        productId = productInsert.rows[0].id
      }
    }

    if (productId && quantity > 0) {
      await client.query(
        `insert into stock_movements
          (organization_id, product_id, warehouse_id, movement_type, quantity, unit_cost, reason, ref_table, ref_id)
         values ($1, $2, $3, 'in', $4, $5, 'Importacao XML', 'xml_imports', $6)`,
        [input.organizationId, productId, warehouseId, quantity, unitCost, xmlImportId],
      )

      await increaseNullBatchStockLevel({
        client,
        organizationId: input.organizationId,
        productId,
        warehouseId,
        quantity,
      })
    }

    await client.query(
      `insert into xml_import_items
        (organization_id, xml_import_id, product_id, description, quantity, unit_cost)
       values ($1, $2, $3, $4, $5, $6)`,
      [
        input.organizationId,
        xmlImportId,
        productId,
        description,
        quantity,
        unitCost,
      ],
    )
  }

  return { xmlImportId, supplierId, warehouseId }
}
