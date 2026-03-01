export function searchProducts(
  query: string,
  warehouseId: string,
  signal?: AbortSignal,
) {
  const params = new URLSearchParams({ query, warehouseId })
  return fetch(`/products/search?${params.toString()}`, { signal }).then(
    async (response) => {
      if (!response.ok) {
        const data = await response.json().catch(() => ({}))
        throw new Error(data.error ?? 'Falha ao buscar produtos.')
      }
      return response.json() as Promise<
        Array<{
          id: string
          name: string
          price: string | number
          image_url: string | null
          stock_available: string | number
        }>
      >
    },
  )
}
