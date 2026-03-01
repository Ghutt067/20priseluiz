import { test, expect } from '@playwright/test'

test.describe('auth shell smoke', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      globalThis.localStorage.clear()
      globalThis.sessionStorage.clear()
    })
  })

  test('signup and login screens render expected fields', async ({ page }) => {
    await page.goto('/signup')

    await expect(page.getByRole('heading', { name: 'Criar Conta' })).toBeVisible()
    await expect(page.getByLabel('Nome da Loja')).toBeVisible()
    await expect(page.getByLabel('E-mail')).toBeVisible()
    await expect(page.getByLabel('Senha')).toBeVisible()

    await page.getByRole('link', { name: 'Entrar' }).click()
    await expect(page).toHaveURL(/\/login$/)
    await expect(page.getByRole('heading', { name: 'Entrar' })).toBeVisible()
  })

  test('protected sales route redirects while unauthenticated', async ({ page }) => {
    await page.goto('/vendas')
    await expect(page).toHaveURL(/\/(signup|login)$/)
    await expect(
      page
        .getByRole('heading', { name: 'Criar Conta' })
        .or(page.getByRole('heading', { name: 'Entrar' })),
    ).toBeVisible()
  })

  test('protected purchases route redirects while unauthenticated', async ({ page }) => {
    await page.goto('/compras')
    await expect(page).toHaveURL(/\/(signup|login)$/)
    await expect(
      page
        .getByRole('heading', { name: 'Criar Conta' })
        .or(page.getByRole('heading', { name: 'Entrar' })),
    ).toBeVisible()
  })
})
