import { createContext } from 'react'
import type { User } from '@supabase/supabase-js'

export type Role = 'chefe' | 'vendedor' | 'estoquista' | 'financeiro'

export type Profile = {
  id: string
  email: string | null
  role: Role
  organization_id: string | null
}

export type AuthContextValue = {
  user: User | null
  profile: Profile | null
  role: Role | null
  organizationId: string | null
  loading: boolean
  signIn: (email: string, password: string) => Promise<void>
  signOut: () => Promise<void>
  refreshProfile: () => Promise<void>
}

export const AuthContext = createContext<AuthContextValue | undefined>(undefined)
