import { copyFileSync, chmodSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const args = process.argv.slice(2)

function readFlag(name) {
  const index = args.indexOf(name)
  if (index === -1) return null
  return args[index + 1] ?? null
}

function hasFlag(name) {
  return args.includes(name)
}

const target = readFlag('--target')
const outPath = readFlag('--out')
const release = !hasFlag('--debug')

function hostTarget() {
  const output = execFileSync('rustc', ['-vV'], { cwd: projectRoot, encoding: 'utf8' })
  const hostLine = output.split('\n').find((line) => line.startsWith('host: '))
  if (!hostLine) throw new Error('Unable to determine rustc host target')
  return hostLine.replace('host: ', '').trim()
}

const resolvedTarget = target ?? hostTarget()
const isWindowsTarget = resolvedTarget.includes('windows')
const binaryName = isWindowsTarget ? 'scanner-bin.exe' : 'scanner-bin'
const outputBinary = outPath ?? join(projectRoot, 'resources', binaryName)

execFileSync(
  'cargo',
  ['build', '--manifest-path', join(projectRoot, 'native', 'scanner-rs', 'Cargo.toml'), ...(release ? ['--release'] : []), '--target', resolvedTarget],
  { cwd: projectRoot, stdio: 'inherit' }
)

const profile = release ? 'release' : 'debug'
const builtBinary = join(projectRoot, 'native', 'scanner-rs', 'target', resolvedTarget, profile, binaryName)

if (!existsSync(builtBinary)) {
  throw new Error(`Built scanner not found at ${builtBinary}`)
}

mkdirSync(dirname(outputBinary), { recursive: true })
copyFileSync(builtBinary, outputBinary)

if (!isWindowsTarget) {
  chmodSync(outputBinary, 0o755)
}

console.log(`[Nerion] Scanner copied to ${outputBinary}`)
