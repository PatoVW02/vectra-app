import { useState, useEffect, useCallback } from 'react'
import { LicenseInfo } from '../types'

export interface LicenseState {
  license: LicenseInfo | null   // null = still loading
  isPremium: boolean
  activate: (key: string) => Promise<{ ok: true; info: LicenseInfo } | { ok: false; error: string }>
  deactivate: () => Promise<void>
}

export function useLicense(): LicenseState {
  const [license, setLicense] = useState<LicenseInfo | null>(null)

  useEffect(() => {
    window.electronAPI.getLicense().then(setLicense)
  }, [])

  const activate = useCallback(async (key: string) => {
    const result = await window.electronAPI.activateLicense(key)
    if (result.ok) setLicense(result.info)
    return result
  }, [])

  const deactivate = useCallback(async () => {
    await window.electronAPI.deactivateLicense()
    setLicense({
      active: false, licenseType: null, maskedKey: null,
      customerEmail: null, expiresAt: null, lastValidated: null,
    })
  }, [])

  return {
    license,
    isPremium: license?.active === true,
    activate,
    deactivate,
  }
}
