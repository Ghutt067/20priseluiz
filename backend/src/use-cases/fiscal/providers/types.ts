export type FiscalProviderName = 'plugnotas'

export type FiscalProviderConfigRecord = {
  provider: FiscalProviderName
  environment: 'production' | 'homologation'
  apiBaseUrl: string | null
  apiKey: string | null
  companyApiKey: string | null
  integrationId: string | null
  active: boolean
}

export type FiscalTransmissionDocument = {
  id: string
  docType: 'nfe' | 'nfce' | 'nfse'
  environment: 'production' | 'homologation'
  xml: string | null
}

export type FiscalProviderSendResult = {
  provider: FiscalProviderName
  status: 'sent' | 'authorized' | 'rejected' | 'error'
  providerReference: string | null
  responseCode: string | null
  responseMessage: string | null
  requestPayload: unknown
  responsePayload: unknown
  accessKey: string | null
}

export interface FiscalProviderAdapter {
  sendDocument(input: {
    config: FiscalProviderConfigRecord
    document: FiscalTransmissionDocument
  }): Promise<FiscalProviderSendResult>
}
