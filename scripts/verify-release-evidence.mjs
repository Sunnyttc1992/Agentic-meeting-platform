import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const args = new Set(process.argv.slice(2))
const previewArg = [...args].find((item) => item.startsWith('--preview='))
const previewPort = previewArg ? Number(previewArg.slice('--preview='.length)) : null

if (args.has('--help')) {
  console.log('Usage: npm run verify:release [-- --preview=4173] [--allow-dirty]')
  console.log('Runs automated release checks and prints a secret-free JSON evidence record.')
  process.exit(0)
}
if (previewArg && (!Number.isSafeInteger(previewPort) || previewPort < 1024 || previewPort > 65535)) {
  throw new Error('--preview must name a TCP port from 1024 through 65535.')
}

function command(file, commandArgs) {
  const started = performance.now()
  const isWindowsNpmShim = process.platform === 'win32' && file.toLowerCase().endsWith('.cmd')
  const executable = isWindowsNpmShim ? (process.env.ComSpec ?? 'cmd.exe') : file
  const args = isWindowsNpmShim ? ['/d', '/s', '/c', file, ...commandArgs] : commandArgs
  const result = spawnSync(executable, args, {
    cwd: root,
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
  })
  return Object.freeze({
    command: [file, ...commandArgs].join(' '),
    passed: result.status === 0 && !result.error,
    exitCode: result.status,
    durationMs: Math.round(performance.now() - started),
  })
}

async function previewCheck(port) {
  if (port === null) return Object.freeze({ requested: false })
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 5_000)
  try {
    const response = await fetch(`http://127.0.0.1:${port}/`, { signal: controller.signal, redirect: 'error' })
    return Object.freeze({
      requested: true,
      url: `http://127.0.0.1:${port}/`,
      passed: response.status === 200 && response.headers.get('cache-control') === 'no-store',
      status: response.status,
      shellCacheControl: response.headers.get('cache-control') ?? null,
    })
  } catch {
    return Object.freeze({ requested: true, url: `http://127.0.0.1:${port}/`, passed: false, status: null, shellCacheControl: null })
  } finally {
    clearTimeout(timeout)
  }
}

const manualGates = Object.freeze([
  'Named Windows production host and service account approval',
  'PostgreSQL TLS, encrypted backup, restore, scheduler, alert, and operational-owner evidence',
  'Microsoft Entra tenant/application registration and production validation',
  'Microsoft Teams administrator approval and connection configuration',
  'Signed real-meeting external-model approval packet and secret-manager configuration',
  'Approved participant notice, retention, legal-hold, and support/escalation process',
  'Security-owner release approval and protected operations record',
])

const trackedWorktree = [
  command('git', ['diff', '--quiet']),
  command('git', ['diff', '--cached', '--quiet']),
]
const checks = [
  command(npm, ['run', 'test']),
  command(npm, ['run', 'build']),
  command(npm, ['run', 'test:sites']),
]
const artifacts = [
  'dist/client/index.html',
  'dist/server/index.js',
  'dist/.openai/hosting.json',
].map((path) => Object.freeze({ path, present: existsSync(join(root, path)) }))
const preview = await previewCheck(previewPort)
const commit = command('git', ['rev-parse', 'HEAD'])
const releaseCommit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', shell: false, windowsHide: true }).stdout.trim() || null
const clean = trackedWorktree.every((item) => item.passed)
const automatedPassed = checks.every((item) => item.passed) && artifacts.every((item) => item.present)
const previewPassed = !preview.requested || preview.passed
const technicalChecksPassed = automatedPassed && previewPassed && commit.passed
const evidence = Object.freeze({
  schema: 'meeting-ledger-release-evidence-v1',
  generatedAt: new Date().toISOString(),
  releaseCommit,
  trackedWorktreeClean: clean,
  automatedChecks: checks,
  buildArtifacts: artifacts,
  loopbackPreview: preview,
  manualGates: manualGates.map((gate) => Object.freeze({ gate, status: 'organization-action-required' })),
  verdict: clean && technicalChecksPassed
    ? 'technical-evidence-passed; production-launch-gates-remain'
    : technicalChecksPassed
      ? 'technical-checks-passed; release-blocked-by-dirty-worktree'
      : 'technical-evidence-failed',
  commitLookup: Object.freeze({ passed: commit.passed }),
})
console.log(JSON.stringify(evidence, null, 2))

if ((!args.has('--allow-dirty') && !clean) || !technicalChecksPassed) process.exitCode = 1

