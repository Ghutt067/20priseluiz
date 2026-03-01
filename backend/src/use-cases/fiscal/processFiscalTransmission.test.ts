import assert from 'node:assert/strict'
import test from 'node:test'
import type { PoolClient } from 'pg'
import { processFiscalTransmission } from './processFiscalTransmission'

type QueryResult = {
  rows: Array<Record<string, unknown>>
  rowCount?: number
}

function createClient(results: QueryResult[]) {
  let callCount = 0

  const client = {
    query: async () => {
      const next = results[callCount]
      callCount += 1

      if (!next) {
        throw new Error('Unexpected query call in test.')
      }

      return {
        rowCount: next.rowCount ?? next.rows.length,
        rows: next.rows,
      }
    },
  } as unknown as PoolClient

  return {
    client,
    getCallCount: () => callCount,
  }
}

test('processFiscalTransmission returns existing authorized transmission without provider call', async () => {
  const originalFetch = globalThis.fetch
  let fetchCalled = false

  globalThis.fetch = (async () => {
    fetchCalled = true
    throw new Error('Fetch should not be called for authorized transmission.')
  }) as typeof fetch

  try {
    const { client, getCallCount } = createClient([
      {
        rows: [
          {
            id: 'tx-1',
            transmissionStatus: 'authorized',
            transmissionProvider: 'plugnotas',
            providerReference: 'pn-123',
            responseCode: '100',
            responseMessage: 'Autorizado',
            documentId: 'doc-1',
            documentStatus: 'authorized',
            docType: 'nfe',
            environment: 'production',
            xml: '<xml/>',
            accessKey: 'chave-1',
          },
        ],
      },
    ])

    const result = await processFiscalTransmission(client, {
      organizationId: 'org-1',
      transmissionId: 'tx-1',
    })

    assert.equal(result.id, 'tx-1')
    assert.equal(result.status, 'authorized')
    assert.equal(result.provider, 'plugnotas')
    assert.equal(result.providerReference, 'pn-123')
    assert.equal(fetchCalled, false)
    assert.equal(getCallCount(), 1)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('processFiscalTransmission returns existing sent transmission without re-sending', async () => {
  const originalFetch = globalThis.fetch
  let fetchCalled = false

  globalThis.fetch = (async () => {
    fetchCalled = true
    throw new Error('Fetch should not be called for sent transmission.')
  }) as typeof fetch

  try {
    const { client, getCallCount } = createClient([
      {
        rows: [
          {
            id: 'tx-sent-1',
            transmissionStatus: 'sent',
            transmissionProvider: 'plugnotas',
            providerReference: 'pn-sent-1',
            responseCode: '202',
            responseMessage: 'Em processamento',
            documentId: 'doc-sent-1',
            documentStatus: 'draft',
            docType: 'nfe',
            environment: 'homologation',
            xml: '<xml/>',
            accessKey: null,
          },
        ],
      },
    ])

    const result = await processFiscalTransmission(client, {
      organizationId: 'org-1',
      transmissionId: 'tx-sent-1',
    })

    assert.equal(result.id, 'tx-sent-1')
    assert.equal(result.status, 'sent')
    assert.equal(result.provider, 'plugnotas')
    assert.equal(result.providerReference, 'pn-sent-1')
    assert.equal(fetchCalled, false)
    assert.equal(getCallCount(), 1)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('processFiscalTransmission sends queued document and updates transmission/document status', async () => {
  const originalFetch = globalThis.fetch

  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        status: 'autorizado',
        id: 'pn-456',
        accessKey: 'NFe123',
        code: '100',
        message: 'Autorizado',
      }),
      {
        status: 200,
        headers: {
          'content-type': 'application/json',
        },
      },
    )) as typeof fetch

  try {
    const { client, getCallCount } = createClient([
      {
        rows: [
          {
            id: 'tx-2',
            transmissionStatus: 'queued',
            transmissionProvider: 'plugnotas',
            providerReference: null,
            responseCode: null,
            responseMessage: null,
            documentId: 'doc-2',
            documentStatus: 'draft',
            docType: 'nfe',
            environment: 'homologation',
            xml: '<NFe>...</NFe>',
            accessKey: null,
          },
        ],
      },
      {
        rows: [
          {
            provider: 'plugnotas',
            environment: 'homologation',
            apiBaseUrl: 'https://plugnotas.exemplo',
            apiKey: 'api-key',
            companyApiKey: null,
            integrationId: 'integ-1',
            active: true,
          },
        ],
      },
      {
        rows: [
          {
            id: 'tx-2',
            status: 'authorized',
            provider: 'plugnotas',
            providerReference: 'pn-456',
            responseCode: '100',
            responseMessage: 'Autorizado',
          },
        ],
      },
      {
        rows: [],
      },
      {
        rows: [{ status: 'authorized' }],
      },
    ])

    const result = await processFiscalTransmission(client, {
      organizationId: 'org-1',
      transmissionId: 'tx-2',
    })

    assert.equal(result.id, 'tx-2')
    assert.equal(result.status, 'authorized')
    assert.equal(result.provider, 'plugnotas')
    assert.equal(result.providerReference, 'pn-456')
    assert.equal(result.documentId, 'doc-2')
    assert.equal(result.documentStatus, 'authorized')
    assert.equal(getCallCount(), 5)
  } finally {
    globalThis.fetch = originalFetch
  }
})
