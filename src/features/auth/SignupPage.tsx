import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../../contexts/useAuth'

const apiUrl = import.meta.env.VITE_API_URL ?? 'http://localhost:4000'

export function SignupPage() {
  const { signIn } = useAuth()
  const navigate = useNavigate()
  const [storeName, setStoreName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    setError(null)
    setLoading(true)
    try {
      const response = await fetch(`${apiUrl}/auth/signup-chefe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ storeName, email, password }),
      })

      if (!response.ok) {
        const data = await response.json().catch(() => ({}))
        throw new Error(data.error ?? 'Falha ao criar conta.')
      }

      await signIn(email, password)
      navigate('/dashboard', { replace: true })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Falha ao criar conta.'
      setError(message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="page">
      <h1>Registro Corporativo</h1>
      
      <form className="card" onSubmit={handleSubmit}>
        <label>
          Nome da Organização
          <input
            type="text"
            value={storeName}
            onChange={(event) => setStoreName(event.target.value)}
            required
          />
        </label>
        <label>
          E-mail
          <input
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />
        </label>
        <label>
          Senha
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
        </label>
        
        <button type="submit" disabled={loading}>
          {loading ? 'Processando...' : 'Registrar organização'}
        </button>
      </form>
      <p className="subtitle">
        Já possui acesso? <a href="/login">Autenticar</a>
      </p>
    </div>
  )
}
