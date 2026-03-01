import assert from 'node:assert/strict'
import test from 'node:test'
import { PlugNotasAdapter } from './plugnotasAdapter'

const baseConfig = {
  provider: 'plugnotas' as const,
  environment: 'homologation' as const,
  apiBaseUrl: 'https://plugnotas.exemplo.com',
  apiKey: 'api-key',
  companyApiKey: null,
  integrationId: 'integration-1',
  active: true,
}

function resolveRequestUrl(input: URL | RequestInfo) {
  if (typeof input === 'string') {
    return input
  }

  if (input instanceof URL) {
    return input.toString()
  }

  return input.url
}

test('PlugNotasAdapter rejects transmission when document XML is missing', async () => {
  const adapter = new PlugNotasAdapter()

  await assert.rejects(
    () =>
      adapter.sendDocument({
        config: baseConfig,
        document: {
          id: 'doc-1',
          docType: 'nfe',
          environment: 'homologation',
          xml: null,
        },
      }),
    {
      message: 'Documento fiscal sem XML para transmitir ao provedor.',
    },
  )
})

test('PlugNotasAdapter rejects transmission when API key is missing', async () => {
  const adapter = new PlugNotasAdapter()

  await assert.rejects(
    () =>
      adapter.sendDocument({
        config: {
          ...baseConfig,
          apiKey: null,
          companyApiKey: null,
        },
        document: {
          id: 'doc-1',
          docType: 'nfce',
          environment: 'homologation',
          xml: '<xml/>',
        },
      }),
    {
      message: 'Configure a API key da PlugNotas antes de transmitir documentos fiscais.',
    },
  )
})

test('PlugNotasAdapter maps successful authorized response', async () => {
  const adapter = new PlugNotasAdapter()
  const originalFetch = globalThis.fetch

  const calls: Array<{ url: string; method?: string }> = []

  globalThis.fetch = (async (input, init) => {
    const url = resolveRequestUrl(input)

    calls.push({
      url,
      method: init?.method,
    })

    return new Response(
      JSON.stringify({
        status: 'autorizado',
        id: 'pn-123',
        accessKey: 'NFe0001',
        code: '100',
        message: 'Autorizado',
      }),
      {
        status: 200,
        headers: {
          'content-type': 'application/json',
        },
      },
    )
  }) as typeof fetch

  try {
    const result = await adapter.sendDocument({
      config: {
        ...baseConfig,
        apiBaseUrl: null,
        apiKey: null,
        companyApiKey: 'company-key',
      },
      document: {
        id: 'doc-2',
        docType: 'nfe',
        environment: 'production',
        xml: '<NFe>ok</NFe>',
      },
    })

    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, 'https://api.plugnotas.com.br/nfe')
    assert.equal(calls[0].method, 'POST')

    assert.equal(result.provider, 'plugnotas')
    assert.equal(result.status, 'authorized')
    assert.equal(result.providerReference, 'pn-123')
    assert.equal(result.accessKey, 'NFe0001')
    assert.equal(result.responseCode, '100')
    assert.equal(result.responseMessage, 'Autorizado')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('PlugNotasAdapter maps non-ok response to error status', async () => {
  const adapter = new PlugNotasAdapter()
  const originalFetch = globalThis.fetch

  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        code: '422',
        message: 'XML inválido',
        id: 'pn-error-1',
      }),
      {
        status: 422,
        headers: {
          'content-type': 'application/json',
        },
      },
    )) as typeof fetch

  try {
    const result = await adapter.sendDocument({
      config: baseConfig,
      document: {
        id: 'doc-3',
        docType: 'nfce',
        environment: 'homologation',
        xml: '<NFCe>bad</NFCe>',
      },
    })

    assert.equal(result.status, 'error')
    assert.equal(result.providerReference, 'pn-error-1')
    assert.equal(result.responseCode, '422')
    assert.equal(result.responseMessage, 'XML inválido')
  } finally {
    globalThis.fetch = originalFetch
  }
})
