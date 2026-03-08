import { Router } from 'express'
import { z } from 'zod'
import { withOrgRead } from '../db'
import { assertOrgMember, getAuthUser } from './authMiddleware'
import { getOrganizationId } from './getOrganizationId'

const router = Router()

const XAI_API_URL = 'https://api.x.ai/v1/responses'
const XAI_MODEL = 'grok-4-1-fast-reasoning'
const XAI_TIMEOUT_MS = 180_000

const salesChatMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().trim().min(1).max(4000),
})

const salesChatSchema = z.object({
  messages: z.array(salesChatMessageSchema).min(1).max(20),
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function getStringField(payload: unknown, field: string) {
  if (!isRecord(payload)) return null
  const value = payload[field]
  return typeof value === 'string' && value.trim() ? value : null
}

function extractXaiError(payload: unknown) {
  const rootMessage = getStringField(payload, 'message')
  if (rootMessage) return rootMessage
  if (!isRecord(payload)) return null
  const error = (payload as { error?: unknown }).error
  if (typeof error === 'string' && error.trim()) return error
  if (!isRecord(error)) return null
  const errorMessage = (error as { message?: unknown }).message
  return typeof errorMessage === 'string' && errorMessage.trim() ? errorMessage : null
}

function extractTextFromOutputPart(part: unknown) {
  if (!isRecord(part)) return null
  const text = part.text
  return typeof text === 'string' && text.trim() ? text.trim() : null
}

function extractTextFromOutputEntry(entry: unknown) {
  if (!isRecord(entry)) return []
  const content = entry.content
  if (!Array.isArray(content)) return []
  return content
    .map(extractTextFromOutputPart)
    .filter((chunk): chunk is string => chunk !== null)
}

function extractXaiText(payload: unknown) {
  const directOutputText = getStringField(payload, 'output_text')
  if (directOutputText) return directOutputText
  if (!isRecord(payload)) return null
  const output = payload.output
  if (!Array.isArray(output)) return null

  const chunks = output.flatMap(extractTextFromOutputEntry)
  return chunks.length > 0 ? chunks.join('\n\n') : null
}

function buildSalesAssistantPrompt() {
  return [
    'Você é o assistente de IA do ERP Vinte Enterprise.',
    'Responda sempre em português do Brasil.',
    'Seja objetivo, útil e claro.',
    'Quando faltar contexto, diga isso explicitamente em vez de inventar dados.',
    'Ajude o usuário com tarefas e dúvidas relacionadas ao fluxo comercial e de vendas.',
  ].join(' ')
}

async function fetchWithTimeout(input: string, init: RequestInit, timeoutMs: number) {
  const controller = new AbortController()
  const timeoutHandle = globalThis.setTimeout(() => controller.abort(), timeoutMs)

  try {
    return await fetch(input, {
      ...init,
      signal: controller.signal,
    })
  } finally {
    globalThis.clearTimeout(timeoutHandle)
  }
}

router.post('/ai/sales-chat', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const user = await getAuthUser(request.header('authorization'))

    await withOrgRead(organizationId, async (client) => {
      await assertOrgMember(client, organizationId, user.id)
    })

    const apiKey = process.env.XAI_API_KEY?.trim()
    if (!apiKey) {
      response.status(500).json({ error: 'XAI_API_KEY is missing in backend environment.' })
      return
    }

    const data = salesChatSchema.parse(request.body)
    const upstreamResponse = await fetchWithTimeout(
      XAI_API_URL,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: XAI_MODEL,
          store: false,
          input: [
            {
              role: 'developer',
              content: buildSalesAssistantPrompt(),
            },
            ...data.messages,
          ],
        }),
      },
      XAI_TIMEOUT_MS,
    )

    const payload = await upstreamResponse.json().catch(() => ({}))

    if (!upstreamResponse.ok) {
      response.status(502).json({
        error: extractXaiError(payload) ?? 'Falha ao consultar a API da xAI.',
      })
      return
    }

    const message = extractXaiText(payload)
    if (!message) {
      response.status(502).json({ error: 'A xAI não retornou uma mensagem válida.' })
      return
    }

    response.json({
      message,
      model: getStringField(payload, 'model') ?? XAI_MODEL,
      responseId: getStringField(payload, 'id'),
    })
  } catch (error) {
    if (error instanceof z.ZodError) {
      response.status(400).json({ error: 'Payload de chat inválido.' })
      return
    }

    if (error instanceof DOMException && error.name === 'AbortError') {
      response.status(504).json({ error: 'A consulta para a xAI excedeu o tempo limite.' })
      return
    }

    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

export const aiRoutes = router
