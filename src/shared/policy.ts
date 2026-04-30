import type { DiskEntry } from '../renderer/types'
import { detectRuntimePlatform, getPlatformInfo, type AppPlatform } from './platform'

function getEnvVar(name: string): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const env = (globalThis as any)?.process?.env
    const value = env?.[name]
    return typeof value === 'string' && value.length > 0 ? value : null
  } catch {
    return null
  }
}

function detectHomeDir(platform: AppPlatform): string | null {
  if (platform === 'windows') {
    const userProfile = getEnvVar('USERPROFILE')
    if (userProfile) return userProfile.replace(/\\+/g, '\\')
    const drive = getEnvVar('HOMEDRIVE')
    const path = getEnvVar('HOMEPATH')
    return drive && path ? `${drive}${path}` : null
  }

  return getEnvVar('HOME')
}

function normalizeMacPath(itemPath: string): string {
  return itemPath.replace(/\/+$/, '') || '/'
}

function normalizeWindowsPath(itemPath: string): string {
  const normalized = itemPath.replace(/\//g, '\\').replace(/\\+$/, '')
  if (/^[a-z]:$/i.test(normalized)) return `${normalized}\\`
  return normalized
}

export function normalizePathForPlatform(itemPath: string, platform: AppPlatform = detectRuntimePlatform()): string {
  return platform === 'windows' ? normalizeWindowsPath(itemPath) : normalizeMacPath(itemPath)
}

function lower(itemPath: string): string {
  return itemPath.toLowerCase()
}

function getMacQuickFolderPath(folder: string, homeDir: string): string {
  if (folder.startsWith('/')) return folder
  if (folder === 'Trash') return `${homeDir}/.Trash`
  if (folder === 'Downloads' || folder === 'Desktop') return `${homeDir}/${folder}`
  return `${homeDir}/Library/${folder}`
}

function getWindowsQuickFolderPath(folder: string, homeDir: string): string {
  if (/^[a-z]:(\\|\/)/i.test(folder) || /^[a-z]:$/i.test(folder)) return folder
  switch (folder) {
    case 'Temp':
      return `${homeDir}\\AppData\\Local\\Temp`
    case 'Logs':
      return `${homeDir}\\AppData\\Local\\Logs`
    case 'Downloads':
      return `${homeDir}\\Downloads`
    case 'Desktop':
      return `${homeDir}\\Desktop`
    case 'Recycle Bin':
      return 'C:\\$Recycle.Bin'
    case 'AppData Local Temp':
      return `${homeDir}\\AppData\\Local\\Temp`
    case 'AppData Local Packages':
      return `${homeDir}\\AppData\\Local\\Packages`
    case 'AppData Roaming':
      return `${homeDir}\\AppData\\Roaming`
    default:
      return `${homeDir}\\AppData\\Local\\${folder}`
  }
}

export function resolveQuickFolderPath(
  folder: string,
  homeDir: string | null,
  platform: AppPlatform = detectRuntimePlatform()
): string | null {
  if (!homeDir) return null
  return platform === 'windows'
    ? getWindowsQuickFolderPath(folder, homeDir)
    : getMacQuickFolderPath(folder, homeDir)
}

export function getDefaultQuickScanFolders(platform: AppPlatform = detectRuntimePlatform()): string[] {
  return [...getPlatformInfo(platform).quickScanDefaults]
}

export function getQuickScanRootPath(homeDir: string | null, platform: AppPlatform = detectRuntimePlatform()): string | null {
  if (!homeDir) return null
  return platform === 'windows' ? `${homeDir}\\AppData\\Local` : `${homeDir}/Library`
}

export function isAppleMetadata(entry: DiskEntry, platform: AppPlatform = detectRuntimePlatform()): boolean {
  const lowerName = entry.name.toLowerCase()
  if (platform === 'windows') {
    return lowerName === 'thumbs.db' || lowerName === 'desktop.ini'
  }

  const appleMetadataNames = new Set([
    '.ds_store',
    '.spotlight-v100',
    '.fseventsd',
    '.temporaryitems',
    '.trashes',
    '.documentrevisions-v100',
    '.volumesicon.icns',
    '.apdisk',
  ])

  if (appleMetadataNames.has(lowerName)) return true
  return !entry.isDir && entry.name.startsWith('._')
}

const DEV_DEPENDENCY_NAMES = new Set([
  'node_modules', 'venv', '.venv', 'env', '__pycache__', '.tox', '.m2', '.gradle',
  'vendor', 'target', '.build', 'pods', '.stack-work', 'bower_components'
])

export function isDevDependency(entry: DiskEntry, platform: AppPlatform = detectRuntimePlatform()): boolean {
  if (!DEV_DEPENDENCY_NAMES.has(entry.name.toLowerCase())) return false
  const pathValue = lower(normalizePathForPlatform(entry.path, platform))

  const blockedPrefixes = platform === 'windows'
    ? ['c:\\windows\\', 'c:\\program files\\', 'c:\\program files (x86)\\', 'c:\\programdata\\']
    : ['/opt/', '/usr/', '/system/', '/library/', '/applications/', '/developer/', '/private/', '/bin/', '/sbin/']

  if (blockedPrefixes.some((prefix) => pathValue.startsWith(prefix))) return false

  const managedSubstrings = platform === 'windows'
    ? ['\\appdata\\local\\programs\\', '\\appdata\\roaming\\code\\', '\\program files\\', '\\windowsapps\\']
    : ['/.nvm/', '/.vscode/', '/.rbenv/', '/.pyenv/', '/.asdf/', '/homebrew/', '.app/contents/', '/shipit/', '/.npm/', '/.copilot/', '/go/pkg/', '/application support/', '/library/python/', '/library/containers/']

  return !managedSubstrings.some((segment) => pathValue.includes(segment))
}

export function isCleanable(entry: DiskEntry, platform: AppPlatform = detectRuntimePlatform()): boolean {
  if (isAppleMetadata(entry, platform)) return false
  const cleanableNames = platform === 'windows'
    ? new Set(['temp', 'tmp', 'logs', 'cache', 'caches'])
    : new Set(['.cache', '.trash', '.tmp', 'tmp', 'temp', '.temp', 'logs', 'deriveddata'])

  if (!entry.isDir) return false
  if (!cleanableNames.has(entry.name.toLowerCase())) return false

  const pathValue = lower(normalizePathForPlatform(entry.path, platform))
  if (platform === 'windows') {
    return !(
      pathValue.startsWith('c:\\windows\\')
      || pathValue.startsWith('c:\\program files\\')
      || pathValue.startsWith('c:\\program files (x86)\\')
      || pathValue.includes('\\onedrive\\')
    )
  }

  return !(
    pathValue.startsWith('/opt/')
    || pathValue.startsWith('/usr/')
    || pathValue.startsWith('/system/')
    || pathValue.startsWith('/library/')
    || pathValue.startsWith('/applications/')
    || pathValue.startsWith('/developer/')
    || pathValue.startsWith('/private/')
    || pathValue.startsWith('/bin/')
    || pathValue.startsWith('/sbin/')
    || pathValue.includes('/library/containers/')
  )
}

export function isCriticalPath(itemPath: string, platform: AppPlatform = detectRuntimePlatform(), explicitHomeDir?: string | null): boolean {
  const homeDir = explicitHomeDir ?? detectHomeDir(platform)
  const normalized = normalizePathForPlatform(itemPath, platform)
  const pathValue = lower(normalized)

  if (platform === 'windows') {
    const home = lower(homeDir ?? 'c:\\users\\__unknown__')
    const exact = new Set([
      'c:\\',
      'c:\\windows',
      'c:\\program files',
      'c:\\program files (x86)',
      'c:\\programdata',
      'c:\\users',
      home,
      `${home}\\documents`,
      `${home}\\downloads`,
      `${home}\\desktop`,
      `${home}\\pictures`,
      `${home}\\music`,
      `${home}\\videos`,
      `${home}\\appdata`,
      `${home}\\appdata\\local`,
      `${home}\\appdata\\roaming`,
      'c:\\$recycle.bin',
    ])
    if (exact.has(pathValue)) return true
    return (
      pathValue.startsWith('c:\\windows\\')
      || pathValue.startsWith('c:\\program files\\')
      || pathValue.startsWith('c:\\program files (x86)\\')
      || pathValue.startsWith('c:\\programdata\\microsoft\\')
      || /c:\\users\\[^\\]+$/.test(pathValue)
      || pathValue.includes('\\onedrive\\')
    )
  }

  const home = homeDir ?? '/Users/__unknown__'
  const contentOnlyRoots = [
    `${home}/Desktop`,
    `${home}/Documents`,
    `${home}/Downloads`,
    `${home}/Movies`,
    `${home}/Music`,
    `${home}/Pictures`,
    `${home}/.Trash`,
    `${home}/Library/Caches`,
    `${home}/Library/Logs`,
    `${home}/Library/HTTPStorages`,
    `${home}/Library/Saved Application State`,
    `${home}/Library/WebKit`,
  ]

  const blockedExact = new Set([
    '/',
    '/Users',
    '/System',
    '/System/Library',
    '/Library',
    '/Applications',
    '/bin',
    '/lib',
    '/sbin',
    '/usr',
    '/usr/bin',
    '/usr/lib',
    '/usr/local',
    '/etc',
    '/var',
    '/private',
    '/private/etc',
    '/private/var',
    '/private/tmp',
    '/Volumes',
    '/Network',
    '/cores',
    home,
    `${home}/Library`,
    `${home}/Applications`,
    `${home}/Library/Application Support`,
    `${home}/Library/Containers`,
    `${home}/Library/Preferences`,
    `${home}/Library/CloudStorage`,
    `${home}/Library/Keychains`,
    ...contentOnlyRoots,
  ])

  if (blockedExact.has(normalized)) return true

  return (
    normalized.startsWith('/System/')
    || normalized.startsWith('/Library/')
    || normalized.startsWith('/usr/')
    || normalized.startsWith('/var/')
    || normalized.startsWith('/private/')
    || normalized.startsWith('/sbin/')
    || normalized.startsWith('/bin/')
    || normalized.startsWith('/lib/')
    || /^\/Users\/[^/]+$/.test(normalized)
    || /^\/Users\/[^/]+\/Library\/(Containers|CloudStorage|Keychains|Mobile Documents|Mail|Messages|Safari)\//.test(normalized)
  )
}

export function isContentOnlyProtectedRoot(itemPath: string, platform: AppPlatform = detectRuntimePlatform(), explicitHomeDir?: string | null): boolean {
  const homeDir = explicitHomeDir ?? detectHomeDir(platform)
  const normalized = normalizePathForPlatform(itemPath, platform)
  const pathValue = lower(normalized)

  if (platform === 'windows') {
    const home = lower(homeDir ?? 'c:\\users\\__unknown__')
    return (
      pathValue === `${home}\\desktop`
      || pathValue === `${home}\\downloads`
      || pathValue === `${home}\\documents`
      || pathValue === `${home}\\pictures`
      || pathValue === `${home}\\music`
      || pathValue === `${home}\\videos`
      || pathValue === `${home}\\appdata\\local\\temp`
      || pathValue === 'c:\\$recycle.bin'
    )
  }

  return /^\/Users\/[^/]+\/(Desktop|Downloads|Documents|Movies|Music|Pictures|\.Trash)$/.test(normalized)
    || /^\/Users\/[^/]+\/Library\/(Caches|Logs|HTTPStorages|Saved Application State|WebKit)$/.test(normalized)
}
