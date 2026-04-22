import { net, app } from 'electron'
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { createHmac } from 'node:crypto'
import * as path from 'node:path'
import * as os from 'node:os'

// ─── Lemon Squeezy config ─────────────────────────────────────────────────────
// https://docs.lemonsqueezy.com/api/license-keys
const LS_API = 'https://api.lemonsqueezy.com/v1/licenses'

// Numeric variant IDs from the LS dashboard — used to reliably tell subscription
// apart from lifetime when expires_at and subscription_id are both absent/null.
// Find them at: LemonSqueezy dashboard → Products → <product> → Variants → ID column.
const env = (import.meta as unknown as { env: Record<string, string> }).env
const MONTHLY_VARIANT_ID = env.VITE_MONTHLY_VARIANT_ID ? Number(env.VITE_MONTHLY_VARIANT_ID) : null
const LIFETIME_VARIANT_ID = env.VITE_LIFETIME_VARIANT_ID ? Number(env.VITE_LIFETIME_VARIANT_ID) : null

/** Determine subscription vs lifetime from a LemonSqueezy API response meta object. */
function detectLicenseType(meta: {
  variant_id?: number | null
  variant_name?: string | null
  subscription_id?: number | null
} | undefined, licenseKey: {
  expires_at?: string | null
} | undefined): 'subscription' | 'lifetime' {
  const variantId = meta?.variant_id ?? null

  // 1. Variant ID match against configured IDs — most reliable
  if (variantId !== null && MONTHLY_VARIANT_ID !== null && variantId === MONTHLY_VARIANT_ID) return 'subscription'
  if (variantId !== null && LIFETIME_VARIANT_ID !== null && variantId === LIFETIME_VARIANT_ID) return 'lifetime'

  // 2. subscription_id in meta — present for subscription purchases on some LS configs
  if (meta?.subscription_id != null) return 'subscription'

  // 3. expires_at on the license key — set to renewal date on some LS configs
  if (licenseKey?.expires_at != null) return 'subscription'

  // 4. variant_name keyword match — last resort
  const variantName = (meta?.variant_name ?? '').toLowerCase()
  if (/month|year|annual|week|subscript/.test(variantName)) return 'subscription'

  return 'lifetime'
}

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
  sig?: string            // HMAC-SHA256 of the above fields — tamper detection
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

// ─── HMAC tamper protection ───────────────────────────────────────────────────
// The key is derived from the app name + version (deterministic, not on disk).
// This blocks casual text-editor tampering; server revalidation is the real gate.
function getHmacKey(): string {
  return app.name
}

function computeSig(data: Omit<LicenseFile, 'sig'>): string {
  const payload = JSON.stringify({
    key: data.key,
    instanceId: data.instanceId,
    licenseType: data.licenseType,
    status: data.status,
    customerEmail: data.customerEmail,
    expiresAt: data.expiresAt,
    lastValidated: data.lastValidated,
  })
  return createHmac('sha256', getHmacKey()).update(payload).digest('hex')
}

function loadFile(): LicenseFile | null {
  try {
    const parsed = JSON.parse(readFileSync(getLicensePath(), 'utf-8')) as LicenseFile
    const { sig, ...rest } = parsed
    // Reject missing or invalid signatures — file was tampered with
    if (!sig || sig !== computeSig(rest)) return null
    return rest
  } catch {
    return null
  }
}

function saveFile(data: LicenseFile): void {
  const { sig: _discard, ...rest } = data
  const sig = computeSig(rest)
  writeFileSync(getLicensePath(), JSON.stringify({ ...rest, sig }, null, 2), 'utf-8')
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

  // Subscriptions: treat as expired once expiresAt passes + 2-day grace window.
  // The buffer covers: being offline when renewal posts, clock skew, and the user
  // renewing just before expiry but not yet having revalidated online.
  // revalidateLicense() on next online startup refreshes expiresAt automatically.
  const EXPIRY_GRACE_MS = 2 * 86_400_000  // 2 days
  const subscriptionExpired =
    f.licenseType === 'subscription' &&
    f.expiresAt != null &&
    new Date(f.expiresAt).getTime() + EXPIRY_GRACE_MS < Date.now()

  const active = !subscriptionExpired && f.status === 'active' && withinGrace(f.lastValidated)
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
      meta?: {
        variant_id?: number | null
        variant_name?: string
        customer_email?: string
        subscription_id?: number | null
      }
    }
    const data = (await res.json()) as ActivateResponse

    if (!res.ok || !data.activated) {
      return { ok: false, error: data.error ?? `Activation failed (HTTP ${res.status})` }
    }

    const licenseType = detectLicenseType(data.meta, data.license_key)

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
      meta?: { variant_id?: number | null; variant_name?: string; subscription_id?: number | null }
    }
    const data = (await res.json()) as ValidateResponse

    // Use the same priority chain as activateLicense.
    // If no signal fires (e.g. no variant IDs configured and all other fields null),
    // keep the cached licenseType so we don't accidentally downgrade a subscription.
    const detectedType = detectLicenseType(data.meta, data.license_key)
    const licenseType: 'subscription' | 'lifetime' =
      detectedType === 'subscription' ? 'subscription' : f.licenseType

    const updated: LicenseFile = {
      ...f,
      status: data.valid && data.license_key?.status === 'active' ? 'active' : 'inactive',
      licenseType,
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
