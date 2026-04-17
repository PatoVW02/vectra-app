import { ipcMain, dialog, shell, net, Notification, app } from 'electron'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { stat, readdir } from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { scanDirectoryStreaming } from './scanner'
import { loadSettings, saveSettings, patchSettings, VectraSettings } from './settings'
import { rebuildTrayMenu, scheduleBackgroundScan, stopBackgroundScan, runBackgroundScan, updateLastScanPath, setTrayVisibility, testNotification } from './background'
import { getLicenseInfo, activateLicense, revalidateLicense, deactivateLicense } from './license'
import { runAutoUpdateCheck, installDownloadedUpdateNow } from './updater'

const execFileAsync = promisify(execFile)

let cancelCurrentScan: (() => void) | null = null

// Ollama state — tracked per active request
let ollamaAbort: AbortController | null = null
let ollamaUserCancelled = false
const FREE_DELETE_LIMIT_PER_MONTH = 15

function currentMonthKey(): string {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  return `${now.getFullYear()}-${month}`
}

function formatSizeForPrompt(sizeKB: number): string {
  if (sizeKB > 1024 * 1024) return `${(sizeKB / 1024 / 1024).toFixed(1)} GB`
  if (sizeKB > 1024) return `${(sizeKB / 1024).toFixed(1)} MB`
  return `${sizeKB} KB`
}

// Known macOS path descriptions — gives the AI accurate context so it reasons
// correctly about what a path is and whether it is safe to delete.
function getMacOSPathContext(itemPath: string): string {
  const home = os.homedir()
  const normalized = itemPath.replace(/\/+$/, '')

  // Ordered most-specific → least-specific so the first match wins.
  const knownPaths: Array<{ match: string | RegExp; description: string }> = [

    // ── Root ─────────────────────────────────────────────────────────────────
    { match: '/', description: 'The root of the macOS filesystem. Deleting it would make the system completely non-functional.' },

    // ── Core OS ──────────────────────────────────────────────────────────────
    { match: '/System/Library', description: 'macOS system frameworks, kernel extensions, and low-level resources. Deleting anything here breaks the operating system.' },
    { match: '/System', description: 'Core macOS operating system managed by Apple. Nothing here should ever be deleted — the Mac would become unbootable.' },
    { match: '/bin', description: 'Fundamental UNIX shell commands (ls, cp, mv, bash). Required to boot and operate. Never delete.' },
    { match: '/sbin', description: 'System administration binaries used at boot by macOS daemons. Never delete.' },
    { match: '/usr/bin', description: 'Essential UNIX binaries used by macOS internals and developer tools (python3, ruby, git wrappers). Deleting breaks the shell environment.' },
    { match: '/usr/lib', description: 'Shared system libraries that macOS and apps link against at runtime. Removing causes crashes.' },
    { match: '/usr/local/Cellar', description: 'Homebrew package cellar (Intel Mac). Each subfolder is one installed Homebrew package. Deleting a subfolder uninstalls that package; deleting the whole folder removes all of them.' },
    { match: '/usr/local', description: 'User-installed UNIX tools such as Homebrew packages. Safer than /usr/bin but scripts and apps may depend on tools here.' },
    { match: '/usr', description: 'UNIX system resources including compilers, libraries, and command-line tools used by macOS and Xcode. Removing it breaks the system.' },
    { match: '/private/etc', description: 'System-wide config files (/etc/hosts, /etc/passwd, networking). Required for macOS to configure itself on every boot.' },
    { match: '/etc', description: 'Symlink to /private/etc — system-wide configuration files. Removing it breaks system configuration.' },
    { match: '/private/var', description: 'Variable system data: logs, caches, databases, runtime state. Many system services write here continuously.' },
    { match: '/var', description: 'Symlink to /private/var — dynamic system data managed by macOS.' },
    { match: '/private/tmp', description: 'OS-managed temporary files. macOS clears this automatically; individual tmp files are safe to delete.' },
    { match: '/private', description: 'Contains the real /etc, /var, and /tmp directories. Managed entirely by macOS.' },
    { match: '/cores', description: 'Crash core dump files. Individual dumps are safe to delete to recover space; the folder itself must stay.' },
    { match: '/Volumes', description: 'Mount point for connected drives and disk images. The folder must not be deleted; mounted drives inside it are independent.' },

    // ── System-wide Library ───────────────────────────────────────────────────
    { match: '/Library/Caches', description: 'System-wide app cache files. Safe to delete — apps and macOS recreate them automatically.' },
    { match: '/Library/Application Support', description: 'System-wide persistent app data. Deleting items here may break apps installed for all users.' },
    { match: '/Library/Logs', description: 'System-wide log files. Safe to delete — apps recreate logs as needed.' },
    { match: '/Library/Preferences', description: 'System-wide preference plists. Deleting an individual plist resets that service\'s settings; deleting the folder breaks many system services.' },
    { match: '/Library', description: 'System-wide support files, fonts, preferences, and extensions for all users. Many items are required by apps and system features.' },
    { match: '/Applications', description: 'Standard install location for all macOS apps. Deleting the folder removes every app; deleting a single .app uninstalls that app.' },

    // ── Homebrew (Apple Silicon) ──────────────────────────────────────────────
    { match: '/opt/homebrew/Cellar', description: 'Homebrew package cellar (Apple Silicon Mac). Each subfolder is one installed package. Deleting a subfolder uninstalls that package.' },
    { match: '/opt/homebrew', description: 'Homebrew package manager installation (Apple Silicon). Deleting this uninstalls all Homebrew packages and the package manager itself.' },

    // ── Users parent ─────────────────────────────────────────────────────────
    { match: '/Users', description: 'Parent of all user home directories on this Mac. Deleting it destroys every user account\'s personal data permanently.' },
    { match: /^\/Users\/[^/]+$/, description: 'A macOS user home directory containing every file, setting, and document for that account. Deleting it permanently destroys all that user\'s data.' },

    // ── This user's home ─────────────────────────────────────────────────────
    { match: home, description: 'Your personal home directory — documents, settings, and all personal files. Deleting it causes permanent, total data loss.' },

    // ── ~/Library — specific subdirs (most specific first) ────────────────────
    { match: `${home}/Library/Keychains`, description: 'Keychain files storing all saved passwords, certificates, and secure credentials. Deleting causes permanent loss of all saved passwords.' },
    { match: `${home}/Library/Mail`, description: 'Mail app local database and downloaded messages. Deleting removes all locally stored emails.' },
    { match: `${home}/Library/Messages`, description: 'iMessage and SMS conversation history synced from iPhone. Deleting permanently erases local message history.' },
    { match: `${home}/Library/Photos`, description: 'Photos app library — your entire photo and video collection. Deleting causes permanent data loss unless you have a backup.' },
    { match: `${home}/Library/Containers`, description: 'Sandboxed data containers for Mac App Store and sandboxed apps. Each subfolder holds one app\'s complete data (documents, databases, settings). Deleting a container resets or fully removes that app\'s data — use only if uninstalling the app or if the data is known to be regenerable.' },
    { match: `${home}/Library/Group Containers`, description: 'Shared data containers used by groups of related apps (e.g. iCloud-enabled app families). Deleting items here can break cross-app syncing and shared features.' },
    { match: `${home}/Library/Developer/Xcode/DerivedData`, description: 'Xcode\'s build cache — compiled object files and intermediate build products for all Xcode projects. Completely safe to delete; Xcode rebuilds everything automatically on the next build. Commonly 10–50 GB on an active developer machine.' },
    { match: `${home}/Library/Developer/Xcode/iOS DeviceSupport`, description: 'Device support files for physical iOS/iPadOS devices connected to Xcode. Can grow very large over time. Safe to delete; Xcode re-downloads them when you reconnect a device.' },
    { match: `${home}/Library/Developer/Xcode/watchOS DeviceSupport`, description: 'Device support files for Apple Watch connected to Xcode. Safe to delete; re-downloaded when device is reconnected.' },
    { match: `${home}/Library/Developer/CoreSimulator/Caches`, description: 'iOS/iPadOS Simulator cache. Safe to delete — regenerated automatically.' },
    { match: `${home}/Library/Developer/CoreSimulator`, description: 'iOS, iPadOS, and watchOS Simulator data including device files and app installs. Safe to delete if simulators are not in active use; Xcode re-downloads runtimes when needed.' },
    { match: `${home}/Library/Developer`, description: 'Developer tool data including Xcode build caches, device support files, and iOS Simulator data. Most contents are large and safely regenerable.' },
    { match: `${home}/Library/Application Support`, description: 'Persistent per-user app data: databases, saved states, user content created by apps. Deleting items here may cause permanent data loss or app resets.' },
    { match: `${home}/Library/Preferences`, description: 'Per-user .plist preference files. Deleting an individual plist resets that app\'s settings to defaults; the app recreates it on next launch.' },
    { match: `${home}/Library/Caches`, description: 'Per-user app cache files. Automatically regenerated — safe to delete to recover disk space.' },
    { match: `${home}/Library/Logs`, description: 'Log files from user-level apps. Safe to delete; apps recreate logs as needed.' },
    { match: `${home}/Library/Saved Application State`, description: 'Saved window and app states used by macOS to restore apps on reopen. Safe to delete; apps recreate these on next launch.' },
    { match: `${home}/Library/WebKit`, description: 'WebKit browser data (cookies, storage) for apps using the system WebView. Safe to delete; causes apps to lose web session state.' },
    { match: `${home}/Library/HTTPStorages`, description: 'HTTP cookie and storage data for apps using the system network stack. Safe to delete; apps will re-fetch data.' },
    { match: `${home}/Library`, description: 'Stores all per-user app support data, preferences, caches, and saved states. Deleting it resets or breaks every app for this user.' },

    // ── Personal folders ──────────────────────────────────────────────────────
    { match: `${home}/Desktop`, description: 'Files on the user\'s desktop. Contains personal data — deleting causes data loss.' },
    { match: `${home}/Documents`, description: 'Standard user documents folder. Contains personal files — deleting causes irreversible data loss.' },
    { match: `${home}/Downloads`, description: 'Files downloaded from the internet. May include important files not yet organized. Review before deleting.' },
    { match: `${home}/Movies`, description: 'Video files, Final Cut Pro / iMovie project libraries, and screen recordings. Personal media — deleting causes data loss.' },
    { match: `${home}/Music`, description: 'Music app / iTunes library including purchased music and playlists. Deleting removes your music library.' },
    { match: `${home}/Pictures`, description: 'Photos app library and image files. The Photos library contains your entire photo collection — deleting causes permanent data loss.' },
    { match: `${home}/Applications`, description: 'Apps installed only for this user (not system-wide). Deleting removes those apps for this user.' },
    { match: `${home}/Public`, description: 'Files shared with other users on this Mac via local file sharing. Generally safe to delete if sharing is not in use.' },
  ]

  for (const entry of knownPaths) {
    const hit = typeof entry.match === 'string'
      ? normalized === entry.match || normalized.startsWith(entry.match + '/')
      : entry.match.test(normalized)
    if (hit) return entry.description
  }

  // Generic fallbacks for common subtrees
  if (normalized.startsWith(`${home}/Library/Containers/`)) {
    const bundle = normalized.replace(`${home}/Library/Containers/`, '').split('/')[0]
    return `Sandboxed data container for the app with bundle ID "${bundle}". Contains that app's complete data. Deleting resets the app or removes its data entirely.`
  }
  if (normalized.startsWith(`${home}/Library/Caches/`)) {
    return 'An app cache directory inside the user Library. Regenerated automatically — safe to delete to recover disk space.'
  }
  if (normalized.startsWith(`${home}/Library/Application Support/`)) {
    return 'Persistent data for an app stored in the user Library Application Support folder. Deleting may cause data loss or reset the app.'
  }
  if (normalized.startsWith(`${home}/Library/`)) {
    return 'A subdirectory inside the user Library — stores per-user app data, preferences, or support files.'
  }
  if (normalized.startsWith('/Library/Caches/')) {
    return 'System-wide app cache. Safe to delete — recreated automatically.'
  }
  if (normalized.startsWith('/Library/')) {
    return 'A subdirectory inside the system Library — stores system-wide app support files, fonts, or configuration.'
  }

  return ''
}

/** Infer a human-readable app name from a macOS bundle ID or .app name. */
function inferAppName(name: string): string | null {
  // Strip .app suffix
  const withoutApp = name.endsWith('.app') ? name.slice(0, -4) : name

  // Looks like a bundle ID (e.g. com.docker.docker, net.whatsapp.WhatsApp)
  const isBundleId = /^[a-z]{2,6}\.[a-zA-Z][\w.-]+$/.test(withoutApp)
  if (isBundleId) {
    const parts = withoutApp.split('.')
    // Last segment, split camelCase into words
    const raw = parts[parts.length - 1]
    return raw.replace(/([A-Z])/g, ' $1').trim()
  }

  // Already a plain name (e.g. "Xcode", "com.apple.Safari" → take last segment)
  return null
}

/** Return a file-type hint for common extensions to help the AI give a better verdict. */
function getFileTypeHint(name: string, isDir: boolean): string {
  if (isDir) {
    const lower = name.toLowerCase()
    if (lower === 'node_modules')       return 'npm/yarn dependency directory — safe to delete; regenerated by running npm install.'
    if (lower === '.gradle')            return 'Gradle build cache — safe to delete; regenerated on next build.'
    if (lower === 'deriveddata')        return 'Xcode build cache — safe to delete; rebuilt automatically.'
    if (lower === '.build')             return 'Swift Package Manager build cache — safe to delete; rebuilt automatically.'
    if (lower === 'vendor')             return 'Third-party dependency directory (Go, PHP, Ruby) — safe to delete; regenerated by the package manager.'
    if (lower === 'target')             return 'Rust/Maven/Gradle build output directory — safe to delete; rebuilt automatically.'
    if (lower === 'dist' || lower === 'build' || lower === 'out')
      return 'Build output directory — safe to delete; regenerated by the build tool.'
    if (lower === '.cache')             return 'Tool or build cache directory — usually safe to delete.'
    if (lower === 'tmp' || lower === 'temp') return 'Temporary files directory — safe to delete.'
    return ''
  }
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  const hints: Record<string, string> = {
    dmg:      'macOS disk image installer — safe to delete once the app is installed.',
    pkg:      'macOS installer package — safe to delete after installation.',
    zip:      'ZIP archive — safe to delete once extracted.',
    'tar.gz': 'Compressed archive — safe to delete once extracted.',
    gz:       'Gzip-compressed file (usually a downloaded archive) — safe to delete once extracted.',
    tgz:      'Compressed tar archive — safe to delete once extracted.',
    log:      'Log file — safe to delete.',
    crash:    'Crash report — safe to delete.',
    tmp:      'Temporary file — safe to delete.',
    bak:      'Backup file — safe to delete if the original is intact.',
    old:      'Old/backup file — usually safe to delete.',
    ipa:      'iOS app archive — safe to delete if you no longer need this build.',
    xcarchive:'Xcode build archive for distribution. Can be large. Safe to delete if you no longer need this specific build for App Store submission or crash symbolication.',
    'dSYM':   'Xcode debug symbols — needed for crash report symbolication. Safe to delete if not needed.',
    bz2:      'BZip2-compressed archive — safe to delete once extracted.',
    xz:       'XZ-compressed archive — safe to delete once extracted.',
    iso:      'Disk image (CD/DVD/ISO) — safe to delete if contents are no longer needed.',
    img:      'Disk image — safe to delete if no longer needed.',
  }
  return hints[ext] ? `File type: ${hints[ext]}` : ''
}

async function pickOllamaModel(): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 5000)
  try {
    const res = await net.fetch('http://localhost:11434/api/tags', { signal: controller.signal })
    if (!res.ok) throw new Error(`Ollama responded with ${res.status}`)
    const data = (await res.json()) as { models?: { name: string }[] }
    const models = data.models ?? []
    if (models.length === 0) {
      throw new Error('No models installed in Ollama. Run: ollama pull llama3.2')
    }
    // Honour user's preferred model if it's installed
    const { preferredOllamaModel } = loadSettings()
    if (preferredOllamaModel) {
      const found = models.find(
        (m) => m.name === preferredOllamaModel || m.name.startsWith(preferredOllamaModel + ':')
      )
      if (found) return found.name
    }
    const preferred = ['llama3.2', 'llama3.1', 'llama3', 'mistral', 'gemma2', 'gemma']
    for (const pref of preferred) {
      const found = models.find((m) => m.name.startsWith(pref))
      if (found) return found.name
    }
    return models[0].name
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('ECONNREFUSED') || msg.includes('fetch') || msg.includes('Failed')) {
      throw new Error('Ollama is not running. Start it with: ollama serve')
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}

let pullAbort: AbortController | null = null

// ── App leftover detection ────────────────────────────────────────────────────

// Locations under ~/Library that commonly hold per-app data
const LEFTOVER_LOCATIONS = [
  path.join('Library', 'Application Support'),
  path.join('Library', 'Caches'),
  path.join('Library', 'Containers'),
  path.join('Library', 'Group Containers'),
  path.join('Library', 'Logs'),
  path.join('Library', 'Preferences'),  // .plist files
]

// Items starting with these are always system/Apple-owned — never flag them
const SYSTEM_PREFIXES = [
  'com.apple.', 'com.apple', 'apple',
  'systempreferences', 'loginitems', 'screensavers', 'savedapplicationstate',
  // Python runtimes (covers python2.x, python3.x, pythonXY, etc.)
  'python',
  // Symbol caches used by Xcode / developer tools
  'symbolsource',
]

// Apple-branded apps and services whose Library data should never be flagged,
// even if the .app is not present in the standard scan directories.
const APPLE_APP_NAMES = new Set([
  // Developer tools
  'xcode', 'instruments', 'simulator', 'iphonesimulator', 'realitycomposer', 'createml',
  'swift', 'swiftpm',
  // Pro media apps
  'garageband', 'logic', 'logicpro', 'finalcut', 'imovie', 'motion', 'compressor',
  'mainstage', 'soundtrack',
  // iWork
  'pages', 'numbers', 'keynote',
  // System apps
  'itunes', 'music', 'podcasts', 'books', 'ibooks', 'news', 'stocks',
  'photos', 'facetime', 'messages', 'mail', 'notes', 'reminders',
  'calendar', 'contacts', 'maps', 'shortcuts', 'automator',
  // iCloud / system services
  'icloud', 'mobiledocuments', 'clouddocs', 'cloudkit',
  // System UI / OS features
  'animoji', 'networkserviceproxy',
  // Developer / symbol caching
  'symbolsourcesymbols',
  // Python runtimes and virtual environments (installed by python.org or brew)
  'python', 'python3', 'python3.9', 'python3.10', 'python3.11', 'python3.12', 'python3.13',
  'virtualenv', 'virtualenvs', 'venv',
  // This app — never recommend deleting Vectra's own data
  'vectra',
  // Firebase / Google services
  'firestore',
  // Developer tools and version managers — never flagged even when not a .app
  'copilot', 'github', 'github-copilot', 'githubcopilot',
  'nvm', 'rbenv', 'pyenv', 'asdf', 'mise',
  'homebrew', 'linuxbrew',
  'npm', 'yarn', 'pnpm',
  'rustup', 'cargo',
  // VS Code and extensions — data is valid as long as VS Code itself is installed
  'code', 'vscode', 'visual', 'cursor', 'windsurf',
])

function addWords(ids: Set<string>, text: string) {
  // Add the full string plus every meaningful word (split on spaces and dots, min 4 chars)
  ids.add(text)
  for (const word of text.split(/[\s.]+/)) {
    if (word.length >= 4) ids.add(word)
  }
}

async function getInstalledAppIdentifiers(): Promise<Set<string>> {
  const ids = new Set<string>()
  const home = os.homedir()
  const appDirs = ['/Applications', path.join(home, 'Applications'), '/System/Applications']

  await Promise.allSettled(
    appDirs.map(async (dir) => {
      try {
        const entries = await readdir(dir)
        const apps = entries.filter((n) => n.endsWith('.app'))
        await Promise.allSettled(
          apps.map(async (app) => {
            // Add display name and each meaningful word in it
            const displayName = app.replace(/\.app$/, '').toLowerCase()
            addWords(ids, displayName)

            // Try to extract bundle identifier via plutil
            const plistPath = path.join(dir, app, 'Contents', 'Info.plist')
            try {
              const { stdout } = await execFileAsync(
                'plutil',
                ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', plistPath],
                { timeout: 1500 }
              )
              const bundleId = stdout.trim().toLowerCase()
              if (bundleId) {
                // Add full bundle ID and every segment
                addWords(ids, bundleId)
              }
            } catch {
              // plutil not available or plist malformed — display name words are enough
            }
          })
        )
      } catch {
        // directory does not exist
      }
    })
  )

  // Also scan VS Code extensions so their Application Support data is never flagged.
  // Extension folders are named: {publisher}.{name}-{version}  e.g. github.copilot-1.181.0
  const vscodeExtDirs = [
    path.join(home, '.vscode', 'extensions'),
    path.join(home, '.cursor', 'extensions'),
    path.join(home, '.windsurf', 'extensions'),
  ]
  await Promise.allSettled(
    vscodeExtDirs.map(async (extDir) => {
      try {
        const entries = await readdir(extDir)
        for (const name of entries) {
          // Strip the trailing version segment (last -semver) to get publisher.extname
          const withoutVersion = name.replace(/-\d+\.\d+.*$/, '').toLowerCase()
          addWords(ids, withoutVersion)
        }
      } catch {
        // directory does not exist or not readable
      }
    })
  )

  return ids
}

function isKnownApp(itemName: string, installedIds: Set<string>): boolean {
  // Strip .plist extension and lowercase for uniform comparison
  const name = itemName.toLowerCase().replace(/\.plist$/, '')
  if (!name) return true

  // Always skip system/Apple-owned items by prefix
  for (const prefix of SYSTEM_PREFIXES) {
    if (name.startsWith(prefix)) return true
  }

  // Always skip known Apple app names and their words
  if (APPLE_APP_NAMES.has(name)) return true
  // Also check if any word in a bundle-ID-style name matches an Apple app
  // e.g. "com.apple.garageband10" → already caught by com.apple prefix
  // e.g. "GarageBand" → caught above
  for (const word of name.split(/[\s.]+/)) {
    if (word.length >= 4 && APPLE_APP_NAMES.has(word)) return true
  }

  // Exact match against installed app identifiers (display names, bundle IDs, words)
  if (installedIds.has(name)) return true

  // For bundle-ID style names: check every dot-segment individually
  if (name.includes('.')) {
    for (const segment of name.split('.')) {
      if (segment.length >= 4 && installedIds.has(segment)) return true
    }
    // Prefix match: "com.google.chrome.helper" → matches "com.google.chrome"
    for (const id of installedIds) {
      if (name.startsWith(id + '.') || id.startsWith(name + '.')) return true
    }
  }

  return false
}

export interface AppLeftover {
  path: string
  name: string
  sizeKB: number
  location: string  // e.g. "Application Support"
}

async function findLeftoversInDir(
  dirPath: string,
  locationLabel: string,
  installedIds: Set<string>,
  minSizeKB: number
): Promise<AppLeftover[]> {
  const results: AppLeftover[] = []
  try {
    const entries = await readdir(dirPath, { withFileTypes: true })
    await Promise.allSettled(
      entries.map(async (entry) => {
        const name = entry.name
        if (isKnownApp(name, installedIds)) return

        const fullPath = path.join(dirPath, name)
        try {
          const { stdout } = await execFileAsync('du', ['-sk', fullPath], { timeout: 8000 })
          const sizeKB = parseInt(stdout.split('\t')[0], 10)
          if (!isNaN(sizeKB) && sizeKB >= minSizeKB) {
            results.push({ path: fullPath, name, sizeKB, location: locationLabel })
          }
        } catch {
          // couldn't stat — skip
        }
      })
    )
  } catch {
    // location doesn't exist or permission denied
  }
  return results
}

// ─────────────────────────────────────────────────────────────────────────────

export function registerIpcHandlers(): void {
  // ── Scanner ──────────────────────────────────────────────────────────────

  ipcMain.on('scan-start', (event, pathOrPaths: string | string[]) => {
    if (cancelCurrentScan) {
      cancelCurrentScan()
      cancelCurrentScan = null
    }
    const paths = Array.isArray(pathOrPaths) ? [...pathOrPaths] : [pathOrPaths]

    const send = (channel: string, data: unknown) => {
      if (!event.sender.isDestroyed()) event.sender.send(channel, data)
    }

    if (paths.length === 1) {
      // Single path — simple case, no coordination needed
      cancelCurrentScan = scanDirectoryStreaming(
        paths[0],
        (entry) => send('scan-entry', entry),
        (error) => { cancelCurrentScan = null; send('scan-done', error ?? null) }
      )
    } else {
      // Multiple paths — scan all in parallel so every root populates concurrently
      // (e.g. ~/Library and ~/Downloads appear in the treemap at the same time).
      const cancellers: Array<() => void> = []
      let completed = 0
      let doneSent = false

      const onDone = (error?: string) => {
        completed++
        if (!doneSent && (error || completed === paths.length)) {
          doneSent = true
          send('scan-done', error ?? null)
        }
      }

      for (const dirPath of paths) {
        cancellers.push(
          scanDirectoryStreaming(dirPath, (entry) => send('scan-entry', entry), onDone)
        )
      }

      cancelCurrentScan = () => { cancellers.forEach((c) => c()); cancelCurrentScan = null }
    }
  })

  ipcMain.on('scan-cancel', () => {
    if (cancelCurrentScan) { cancelCurrentScan(); cancelCurrentScan = null }
  })

  // ── File operations ───────────────────────────────────────────────────────

  ipcMain.handle('open-directory', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory'],
      title: 'Choose a folder to analyze'
    })
    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle('open-external', (_event, url: string) => {
    shell.openExternal(url)
  })

  ipcMain.handle('reveal-in-finder', (_event, filePath: string) => {
    shell.showItemInFolder(filePath)
  })

  ipcMain.handle('trash-entries', async (_event, paths: string[]) => {
    const home = os.homedir()
    const CONTENT_ONLY_DIRS = new Set([
      `${home}/Desktop`,
      `${home}/Downloads`,
      `${home}/Documents`,
      `${home}/Movies`,
      `${home}/Music`,
      `${home}/Pictures`,
    ])

    const prepErrors: string[] = []
    const expandedTargets: string[] = []

    for (const originalPath of paths) {
      const normalized = originalPath.replace(/\/+$/, '')
      if (!CONTENT_ONLY_DIRS.has(normalized)) {
        expandedTargets.push(originalPath)
        continue
      }

      try {
        const children = await readdir(normalized)
        for (const child of children) {
          expandedTargets.push(path.join(normalized, child))
        }
      } catch (err) {
        prepErrors.push(`Failed to access ${normalized}: ${String(err)}`)
      }
    }

    // Deduplicate exact duplicates while preserving order
    const seen = new Set<string>()
    const deduped: string[] = []
    for (const targetPath of expandedTargets) {
      if (seen.has(targetPath)) continue
      seen.add(targetPath)
      deduped.push(targetPath)
    }

    // Remove paths whose ancestor is also in the list — deleting the parent
    // already removes them, so trying to delete them separately causes "doesn't exist" errors.
    const effectivePaths = deduped.filter(p =>
      !deduped.some(other => other !== p && p.startsWith(other.endsWith('/') ? other : other + path.sep))
    )

    const requested = Math.max(0, effectivePaths.length)
    const premium = getLicenseInfo().active

    if (!premium) {
      const settingsAtStart = loadSettings()
      const monthKey = currentMonthKey()
      const usedAtStart = settingsAtStart.deleteQuota.monthKey === monthKey ? settingsAtStart.deleteQuota.used : 0
      const remaining = Math.max(0, FREE_DELETE_LIMIT_PER_MONTH - usedAtStart)

      if (remaining <= 0) {
        return `You've reached your free delete limit (${FREE_DELETE_LIMIT_PER_MONTH} per month). Upgrade to Premium for unlimited in-app deletes.`
      }
      if (requested > remaining) {
        return `You can delete ${remaining} more ${remaining === 1 ? 'item' : 'items'} this month on Free. Remove fewer items or upgrade to Premium for unlimited deletes.`
      }
    }

    const errors: string[] = []
    let deletedCount = 0
    for (const p of effectivePaths) {
      try {
        await shell.trashItem(p)
        deletedCount += 1
        _event.sender.send('trash-progress', { path: p, success: true })
      } catch (err) {
        const msg = String(err)
        errors.push(msg)
        _event.sender.send('trash-progress', { path: p, success: false, error: msg })
      }
    }

    if (!premium && deletedCount > 0) {
      const settings = loadSettings()
      const monthKey = currentMonthKey()
      const used = settings.deleteQuota.monthKey === monthKey ? settings.deleteQuota.used : 0
      patchSettings({
        deleteQuota: {
          monthKey,
          used: Math.min(FREE_DELETE_LIMIT_PER_MONTH, used + deletedCount),
        }
      })
    }

    const allErrors = [...prepErrors, ...errors]
    return allErrors.length === 0 ? null : allErrors.join('\n')
  })

  ipcMain.handle('get-item-stats', async (_event, filePath: string) => {
    try {
      const s = await stat(filePath)
      return {
        modified: s.mtime.toISOString(),
        created: s.birthtime.toISOString(),
        sizeBytes: s.size
      }
    } catch (err) {
      return { error: String(err) }
    }
  })

  // ── App leftover detection ────────────────────────────────────────────────

  ipcMain.handle('find-app-leftovers', async () => {
    const home = os.homedir()

    // Minimum size to report (1 MB = 1024 KB)
    const MIN_SIZE_KB = 1024

    const installedIds = await getInstalledAppIdentifiers()

    const allResults = await Promise.all(
      LEFTOVER_LOCATIONS.map((rel) => {
        const fullPath = path.join(home, rel)
        const label = rel.split(path.sep).pop() ?? rel
        return findLeftoversInDir(fullPath, label, installedIds, MIN_SIZE_KB)
      })
    )

    const flat = allResults.flat()
    // Deduplicate by path and sort largest first
    const seen = new Set<string>()
    const unique: AppLeftover[] = []
    for (const item of flat.sort((a, b) => b.sizeKB - a.sizeKB)) {
      if (!seen.has(item.path)) {
        seen.add(item.path)
        unique.push(item)
      }
    }
    return unique
  })

  // ── AI Analysis (Cloud or Ollama) ─────────────────────────────────────────

  // OpenAI config — set VITE_OPENAI_API_KEY in .env to enable cloud mode.
  const _aiEnv = (import.meta as unknown as { env: Record<string, string> }).env
  const OPENAI_API_KEY = _aiEnv.VITE_OPENAI_API_KEY ?? ''

  // Stored prompt template ID on OpenAI (model + system prompt configured there)
  const OPENAI_PROMPT_ID      = _aiEnv.VITE_OPENAI_PROMPT_ID ?? ''
  const OPENAI_PROMPT_VERSION = _aiEnv.VITE_OPENAI_PROMPT_VERSION ?? '1'

  /** Stream an OpenAI Responses API SSE response and emit ollama-token / ollama-done events. */
  async function streamResponsesAPI(
    body: ReadableStream<Uint8Array>,
    send: (ch: string, d: unknown) => void
  ): Promise<void> {
    const reader = body.getReader()
    const dec = new TextDecoder()
    let buf = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed || !trimmed.startsWith('data:')) continue
        const json = trimmed.slice(5).trim()
        if (!json) continue

        let obj: { type?: string; delta?: string; response?: { error?: { message?: string } } }
        try {
          obj = JSON.parse(json)
        } catch {
          continue  // partial / malformed line — skip and wait for next chunk
        }

        if (obj.type === 'response.output_text.delta' && obj.delta) {
          send('ollama-token', obj.delta)
        } else if (obj.type === 'response.completed') {
          send('ollama-done', null)
          return
        } else if (obj.type === 'response.failed') {
          throw new Error(obj.response?.error?.message ?? 'AI analysis failed')
        }
      }
    }
    send('ollama-done', null)
  }

  /** System-level persona for the AI — shared across cloud and Ollama. */
  const AI_SYSTEM_PROMPT = `You are a macOS storage expert built into a disk-cleaner app. Your job is to analyze a single file or folder and give the user a concise, accurate verdict on what it is and whether deleting it is safe. You reason strictly from the actual path provided — never assume a path is in a different location than stated.

Rules:
- Plain prose only. No markdown, no bullet points, no headings.
- 2-3 sentences maximum.
- End with exactly one line: RECOMMENDATION: DELETE  or  RECOMMENDATION: KEEP
- Your recommendation must be consistent with your explanation. Never say "risky" and then DELETE. Never say "safe" and then KEEP.`

  /** Build the user-turn prompt for a given disk item. */
  function buildAnalysisPrompt(payload: { path: string; name: string; isDir: boolean; sizeKB: number }): string {
    const pathContext = getMacOSPathContext(payload.path)
    return `Analyze this macOS disk item:

Name: ${payload.name}
Path: ${payload.path}
Type: ${payload.isDir ? 'Folder' : 'File'}
Size: ${formatSizeForPrompt(payload.sizeKB)}
${pathContext ? `Path context: ${pathContext}\n` : ''}
macOS path reference (use this to reason accurately — match the actual path above):
- /System  /usr  /bin  /sbin  /private/etc  /private/var → core OS. Never delete.
- /Library (system-level) → system app support, fonts, extensions. Usually required.
- /Applications → installed apps. Delete only if you want to uninstall.
- ~/Library/Containers/{bundle} → sandboxed app data. May contain important user data; only delete if the app is already uninstalled or the folder is extremely large and the app can rebuild it.
- ~/Library/Group Containers → shared data between app groups. Usually keep.
- ~/Library/Application Support/{app} → persistent app config and data. Usually keep; deleting resets the app.
- ~/Library/Preferences/{app}.plist → app preferences. Deleting resets settings only.
- ~/Library/Keychains → credentials and certificates. Never delete.
- ~/Library/Caches/{app} → regenerable cache. Safe to delete.
- ~/Library/Logs  /Library/Logs → log files. Safe to delete.
- ~/Library/Developer/Xcode/DerivedData → Xcode build cache. Safe to delete.
- ~/Library/Developer/CoreSimulator → iOS Simulator data. Large; safe to delete if not actively using simulators.
- node_modules  .gradle  target  build  dist (inside project folders) → build/dependency dirs. Safe to delete; regenerated by the build tool.
- ~/Documents  ~/Desktop  ~/Downloads  ~/Movies  ~/Music  ~/Pictures → personal files. Never delete.
- /Users → parent of all home folders. Never delete.

What is this item and is it safe to delete?`
  }

  /** Stream NDJSON from a ReadableStream and emit ollama-token / ollama-done IPC events. */
  async function streamNdjson(
    body: ReadableStream<Uint8Array>,
    send: (ch: string, d: unknown) => void
  ): Promise<void> {
    const reader = body.getReader()
    const dec = new TextDecoder()
    let buf = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        const obj = JSON.parse(line) as { response?: string; done?: boolean; error?: string }
        if (obj.error) throw new Error(obj.error)
        if (obj.response) send('ollama-token', obj.response)
        if (obj.done) { send('ollama-done', null); return }
      }
    }
    send('ollama-done', null)
  }

  ipcMain.on(
    'ollama-start',
    async (event, payload: { path: string; name: string; isDir: boolean; sizeKB: number }) => {
      // Cancel any in-progress request
      if (ollamaAbort) {
        ollamaUserCancelled = true
        ollamaAbort.abort()
        ollamaAbort = null
      }
      ollamaUserCancelled = false
      ollamaAbort = new AbortController()

      const send = (channel: string, data: unknown) => {
        if (!event.sender.isDestroyed()) event.sender.send(channel, data)
      }

      try {
        const aiMode = loadSettings().aiMode ?? 'cloud'

        if (aiMode === 'cloud') {
          // ── OpenAI Responses API (stored prompt template) ──────────────────
          if (!OPENAI_API_KEY) {
            throw new Error('Cloud AI is not configured. Set VITE_OPENAI_API_KEY in your .env file.')
          }

          send('ollama-model', 'Cloud AI')

          const res = await net.fetch('https://api.openai.com/v1/responses', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${OPENAI_API_KEY}`,
            },
            body: JSON.stringify({
              stream: true,
              prompt: {
                id:      OPENAI_PROMPT_ID,
                version: OPENAI_PROMPT_VERSION,
                variables: {
                  name:         payload.name,
                  path:         payload.path,
                  is_directory: payload.isDir ? 'true' : 'false',
                  size:         formatSizeForPrompt(payload.sizeKB),
                  path_context: getMacOSPathContext(payload.path),
                },
              },
            }),
            signal: ollamaAbort.signal
          })

          if (!res.ok || !res.body) {
            const errText = await res.text().catch(() => '')
            throw new Error(`OpenAI returned ${res.status}${errText ? ': ' + errText : ''}`)
          }
          await streamResponsesAPI(res.body, send)
        } else {
          // ── Ollama (local) path ────────────────────────────────────────────
          const prompt = buildAnalysisPrompt(payload)
          const model = await pickOllamaModel()
          if (ollamaUserCancelled) return

          send('ollama-model', model)

          const res = await net.fetch('http://localhost:11434/api/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model, prompt: `${AI_SYSTEM_PROMPT}\n\n${prompt}`, stream: true }),
            signal: ollamaAbort.signal
          })

          if (!res.ok || !res.body) throw new Error(`Ollama returned ${res.status}`)
          await streamNdjson(res.body, send)
        }
      } catch (err: unknown) {
        if (ollamaUserCancelled) return
        const msg = err instanceof Error ? err.message : String(err)
        send('ollama-done', msg)
      } finally {
        ollamaAbort = null
      }
    }
  )

  ipcMain.on('ollama-cancel', () => {
    if (ollamaAbort) {
      ollamaUserCancelled = true
      ollamaAbort.abort()
      ollamaAbort = null
    }
  })

  ipcMain.handle('get-ai-mode', () => loadSettings().aiMode ?? 'cloud')
  ipcMain.on('set-ai-mode', (_event, mode: 'cloud' | 'ollama') => {
    patchSettings({ aiMode: mode })
  })

  // ── Settings ───────────────────────────────────────────────────────────────
  ipcMain.handle('get-settings', () => loadSettings())
  ipcMain.handle('get-home-dir', () => os.homedir())
  ipcMain.handle('get-app-version', () => app.getVersion())
  ipcMain.handle('get-app-arch', () => process.arch)

  ipcMain.handle('save-settings', (_event, settings: VectraSettings) => {
    const prev = loadSettings()
    // Keep runtime-managed counters from the source of truth in main process,
    // so stale renderer state can't overwrite delete quota or scan history.
    const mergedSettings: VectraSettings = {
      ...settings,
      lastManualScanTime: prev.lastManualScanTime,
      lastManualScanFoundKB: prev.lastManualScanFoundKB,
      lastCleanedTime: prev.lastCleanedTime,
      lastCleanedKB: prev.lastCleanedKB,
      deleteQuota: prev.deleteQuota,
    }
    saveSettings(mergedSettings)
    if (settings.backgroundScan.enabled !== prev.backgroundScan.enabled ||
        settings.backgroundScan.intervalHours !== prev.backgroundScan.intervalHours) {
      if (settings.backgroundScan.enabled) scheduleBackgroundScan()
      else stopBackgroundScan()
    }
    if (settings.showMenuBarIcon !== prev.showMenuBarIcon) {
      setTrayVisibility(settings.showMenuBarIcon)
    }
    if (settings.autoUpdateEnabled && !prev.autoUpdateEnabled) {
      runAutoUpdateCheck('settings-enabled').catch(() => {})
    }
    rebuildTrayMenu()
  })

  ipcMain.handle('test-notification', () => testNotification())

  ipcMain.handle('check-for-updates', () => {
    return runAutoUpdateCheck('manual')
  })

  ipcMain.handle('install-update-now', () => {
    return installDownloadedUpdateNow()
  })

  ipcMain.handle('request-notification-permission', () => {
    // Showing a notification triggers the native macOS permission dialog on production builds.
    // If already authorized the notification simply appears; if denied the user sees nothing
    // and can fall back to opening System Settings manually.
    if (Notification.isSupported()) {
      new Notification({
        title: 'Vectra',
        body: "You'll be notified when background scans find space to reclaim."
      }).show()
    }
  })

  ipcMain.handle('mark-onboarding-complete', () => {
    patchSettings({ onboardingComplete: true })
  })

  ipcMain.handle('get-login-item', () => {
    return app.getLoginItemSettings().openAtLogin
  })

  ipcMain.handle('set-login-item', (_event, enable: boolean) => {
    app.setLoginItemSettings({ openAtLogin: enable, openAsHidden: enable })
  })

  ipcMain.handle('check-ollama', async () => {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 3000)
      const res = await net.fetch('http://localhost:11434/api/tags', { signal: controller.signal })
      clearTimeout(timer)
      if (!res.ok) return { installed: false }
      const data = await res.json() as { models?: { name: string }[] }
      return { installed: true, hasModels: (data.models?.length ?? 0) > 0 }
    } catch {
      return { installed: false }
    }
  })

  ipcMain.handle('get-ollama-models', async () => {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 4000)
      const res = await net.fetch('http://localhost:11434/api/tags', { signal: controller.signal })
      clearTimeout(timer)
      if (!res.ok) return { ok: false, models: [] }
      const data = await res.json() as {
        models?: Array<{ name: string; size: number; modified_at: string }>
      }
      return { ok: true, models: data.models ?? [] }
    } catch {
      return { ok: false, models: [] }
    }
  })

  ipcMain.on('pull-model', async (event, modelName: string) => {
    if (pullAbort) { pullAbort.abort(); pullAbort = null }
    pullAbort = new AbortController()

    const send = (channel: string, data: unknown) => {
      if (!event.sender.isDestroyed()) event.sender.send(channel, data)
    }

    const layerProgress = new Map<string, { total: number; completed: number }>()

    try {
      const res = await net.fetch('http://localhost:11434/api/pull', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: modelName, stream: true }),
        signal: pullAbort.signal
      })

      if (!res.ok || !res.body) {
        send('pull-done', { model: modelName, error: `Ollama returned ${res.status}` })
        return
      }

      const reader = res.body.getReader()
      const dec = new TextDecoder()
      let buf = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        const lines = buf.split('\n')
        buf = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.trim()) continue
          try {
            const obj = JSON.parse(line) as {
              status?: string; digest?: string; total?: number; completed?: number
            }
            if (obj.digest && obj.total) {
              layerProgress.set(obj.digest, { total: obj.total, completed: obj.completed ?? 0 })
            }
            const totalBytes = [...layerProgress.values()].reduce((s, v) => s + v.total, 0)
            const completedBytes = [...layerProgress.values()].reduce((s, v) => s + v.completed, 0)
            const progress = totalBytes > 0 ? Math.round((completedBytes / totalBytes) * 100) : null
            send('pull-progress', { model: modelName, progress, status: obj.status ?? '' })
            if (obj.status === 'success') {
              send('pull-done', { model: modelName, error: null })
              return
            }
          } catch { /* malformed line */ }
        }
      }
      send('pull-done', { model: modelName, error: null })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (!msg.includes('abort') && !msg.includes('AbortError')) {
        send('pull-done', { model: modelName, error: msg })
      }
    } finally {
      pullAbort = null
    }
  })

  ipcMain.on('cancel-pull', () => {
    if (pullAbort) { pullAbort.abort(); pullAbort = null }
  })

  // ── License ────────────────────────────────────────────────────────────────
  ipcMain.handle('license:get', () => getLicenseInfo())
  ipcMain.handle('license:activate', (_event, key: string) => activateLicense(key))
  ipcMain.handle('license:deactivate', () => deactivateLicense())

  // Silently re-validate on startup — updates cached status without blocking
  revalidateLicense().catch(() => {})

  ipcMain.handle('run-bg-scan', () => runBackgroundScan())

  ipcMain.on('update-last-scan-path', (_event, scanPath: string) => {
    updateLastScanPath(scanPath)
  })

  ipcMain.on('notify-manual-scan-done', (_event, foundKB: number) => {
    patchSettings({
      lastManualScanTime: Date.now(),
      lastManualScanFoundKB: foundKB,
      // Reset cleaned state so tray shows "Found" for the new scan
      lastCleanedTime: null,
      lastCleanedKB: 0
    })
    rebuildTrayMenu()
  })

  ipcMain.on('notify-cleaned', (_event, cleanedKB: number) => {
    patchSettings({ lastCleanedTime: Date.now(), lastCleanedKB: cleanedKB })
    rebuildTrayMenu()
  })
}
