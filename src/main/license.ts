import { net, app } from 'electron'
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

// ─── Lemon Squeezy config ─────────────────────────────────────────────────────
// After creating your Lemon Squeezy store + products, fill these in:
// https://docs.lemonsqueezy.com/api/license-keys
const LS_API = 'https://api.lemonsqueezy.com/v1/licenses'

// How many days the app works offline after last successful validation
const GRACE_PERIOD_DAYS = 7

// ─── Types ────────────────────────────────────────────────────────────────────
interface LicenseFile {
  key: string
  instanceId: string
  licenseType: 'subscription' | 'lifetime'
  status: 'active' | 'inactive' | 'expired' | 'disabled'
  customerEmail: string | null
  expiresAt: string | null
  lastValidated: string   // ISO date
}

export interface LicenseInfo {
  active: boolean
  licenseType: 'subscription' | 'lifetime' | null
  maskedKey: string | null    // e.g. "ABCD-****-****-WXYZ"
  customerEmail: string | null
  expiresAt: string | null
  lastValidated: string | null
}

// ─── Disk helpers ─────────────────────────────────────────────────────────────
function getLicensePath(): string {
  return path.join(app.getPath('userData'), 'license.json')
}

function loadFile(): LicenseFile | null {
  try {
    return JSON.parse(readFileSync(getLicensePath(), 'utf-8')) as LicenseFile
  } catch {
    return null
  }
}

function saveFile(data: LicenseFile): void {
  writeFileSync(getLicensePath(), JSON.stringify(data, null, 2), 'utf-8')
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function maskKey(key: string): string {
  const parts = key.split('-')
  if (parts.length >= 4) return `${parts[0]}-****-****-${parts[parts.length - 1]}`
  return key.slice(0, 4) + '-****-' + key.slice(-4)
}

function withinGrace(lastValidated: string): boolean {
  return Date.now() - new Date(lastValidated).getTime() < GRACE_PERIOD_DAYS * 86_400_000
}

// ─── Public API ───────────────────────────────────────────────────────────────

/** Returns current license state (reads from disk only — no network). */
export function getLicenseInfo(): LicenseInfo {
  const f = loadFile()
  if (!f) return { active: false, licenseType: null, maskedKey: null, customerEmail: null, expiresAt: null, lastValidated: null }
  const active = f.status === 'active' && withinGrace(f.lastValidated)
  return {
    active,
    licenseType: f.licenseType,
    maskedKey: maskKey(f.key),
    customerEmail: f.customerEmail,
    expiresAt: f.expiresAt,
    lastValidated: f.lastValidated,
  }
}

/** Activate a new license key against the Lemon Squeezy API. */
export async function activateLicense(rawKey: string): Promise<
  { ok: true; info: LicenseInfo } | { ok: false; error: string }
> {
  const key = rawKey.trim().toUpperCase()
  const instanceName = `${os.hostname()} – ${os.userInfo().username}`

  try {
    const res = await net.fetch(`${LS_API}/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ license_key: key, instance_name: instanceName }),
    })

    type ActivateResponse = {
      activated?: boolean
      error?: string
      license_key?: { status: string; expires_at: string | null }
      instance?: { id: string }
      meta?: { variant_name?: string; customer_email?: string }
    }
    const data = (await res.json()) as ActivateResponse

    if (!res.ok || !data.activated) {
      return { ok: false, error: data.error ?? `Activation failed (HTTP ${res.status})` }
    }

    const variantName = (data.meta?.variant_name ?? '').toLowerCase()
    const licenseType: 'subscription' | 'lifetime' =
      variantName.includes('month') || variantName.includes('subscri') ? 'subscription' : 'lifetime'

    const file: LicenseFile = {
      key,
      instanceId: data.instance!.id,
      licenseType,
      status: data.license_key?.status === 'active' ? 'active' : 'inactive',
      customerEmail: data.meta?.customer_email ?? null,
      expiresAt: data.license_key?.expires_at ?? null,
      lastValidated: new Date().toISOString(),
    }
    saveFile(file)
    return { ok: true, info: getLicenseInfo() }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Network error — check your internet connection' }
  }
}

/** Re-validate existing license against the server. Falls back to cached state on network error. */
export async function revalidateLicense(): Promise<LicenseInfo> {
  const f = loadFile()
  if (!f) return getLicenseInfo()

  try {
    const res = await net.fetch(`${LS_API}/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ license_key: f.key, instance_id: f.instanceId }),
    })

    type ValidateResponse = {
      valid?: boolean
      license_key?: { status: string; expires_at: string | null }
      meta?: { variant_name?: string }
    }
    const data = (await res.json()) as ValidateResponse

    const variantName = (data.meta?.variant_name ?? '').toLowerCase()
    const updated: LicenseFile = {
      ...f,
      status: data.valid && data.license_key?.status === 'active' ? 'active' : 'inactive',
      licenseType:
        variantName.includes('month') || variantName.includes('subscri')
          ? 'subscription'
          : f.licenseType,
      expiresAt: data.license_key?.expires_at ?? f.expiresAt,
      lastValidated: new Date().toISOString(),
    }
    saveFile(updated)
  } catch {
    // Network error — grace period still applies to the existing file
  }

  return getLicenseInfo()
}

/** Deactivate license on the server then remove local file. */
export async function deactivateLicense(): Promise<void> {
  const f = loadFile()
  if (f) {
    try {
      await net.fetch(`${LS_API}/deactivate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ license_key: f.key, instance_id: f.instanceId }),
      })
    } catch { /* best-effort */ }
  }
  try { unlinkSync(getLicensePath()) } catch { /* already gone */ }
}
