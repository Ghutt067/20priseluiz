import { useEffect, useMemo, useRef, useState } from 'react'
import type { User } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase'
import { AuthContext, type AuthContextValue, type Profile } from './authContextStore'

const orgStorageKey = 'vinteenterprise.organizationId'

export function AuthProvider({ children }: Readonly<{ children: React.ReactNode }>) {
  const [user, setUser] = useState<User | null>(null)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [loading, setLoading] = useState(true)
  const profileLoadRef = useRef<Promise<void> | null>(null)

  const loadProfile = async (userId: string) => {
    const { data, error } = await supabase
      .from('profiles')
      .select('id, email, role, organization_id')
      .eq('id', userId)
      .single()

    if (error || !data) {
      setProfile(null)
      globalThis.localStorage.removeItem(orgStorageKey)
      return
    }

    setProfile(data as Profile)
    if (data.organization_id) {
      globalThis.localStorage.setItem(orgStorageKey, data.organization_id)
      return
    }

    globalThis.localStorage.removeItem(orgStorageKey)
  }

  useEffect(() => {
    let mounted = true
    const init = async () => {
      const { data } = await supabase.auth.getSession()
      if (!mounted) return
      setUser(data.session?.user ?? null)
      if (data.session?.user) {
        await loadProfile(data.session.user.id)
      } else {
        setProfile(null)
        globalThis.localStorage.removeItem(orgStorageKey)
      }
      setLoading(false)
    }

    void init()

    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null)
      if (session?.user) {
        const promise = loadProfile(session.user.id)
        profileLoadRef.current = promise
        void promise
      } else {
        setProfile(null)
        globalThis.localStorage.removeItem(orgStorageKey)
        profileLoadRef.current = null
      }
    })

    return () => {
      mounted = false
      listener.subscription.unsubscribe()
    }
  }, [])

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      profile,
      role: profile?.role ?? null,
      organizationId: profile?.organization_id ?? null,
      loading,
      signIn: async (email, password) => {
        const { error } = await supabase.auth.signInWithPassword({ email, password })
        if (error) throw error
        if (profileLoadRef.current) {
          await profileLoadRef.current
        }
      },
      signOut: async () => {
        await supabase.auth.signOut()
      },
      refreshProfile: async () => {
        if (user) await loadProfile(user.id)
      },
    }),
    [user, profile, loading],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
