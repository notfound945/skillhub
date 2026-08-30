import { chmod, mkdir, mkdtemp, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { SkillHubClient } from '../clients/skillhub-client'
import { InventoryStore } from '../stores/inventory-store'
import { CliError } from '../shared/errors'
import { EXIT } from '../shared/constants'
import { extractZip } from '../platform/archive'
import { readBoundedResponseBody } from '../platform/download'
import { canonicalizeExistingPath, pathExists } from '../platform/paths'
import { snapshotSkillDirectory } from './skill-fingerprint'
import type { AgentCandidate } from '../agents/types'
import type { ResolveResponse } from '../clients/skillhub-client'

export interface InstallOptions {
  registry: string
  token?: string | undefined
  namespace: string
  slug: string
  version?: string | undefined
  targets: AgentCandidate[]
  force: boolean
  home?: string | undefined
  resolved?: ResolveResponse | undefined
}

async function preflightInstallTargets(
  targets: AgentCandidate[],
  slug: string,
  force: boolean
): Promise<Array<{ target: AgentCandidate; skillDir: string }>> {
  const seenSkillDirs = new Set<string>()
  const preparedTargets: Array<{ target: AgentCandidate; skillDir: string }> = []

  for (const target of targets) {
    const canonicalRootDir = await canonicalizeExistingPath(target.rootDir)
    const canonicalSkillDir = join(canonicalRootDir, slug)
    if (seenSkillDirs.has(canonicalSkillDir)) {
      throw new CliError(`multiple install targets resolve to ${canonicalSkillDir}`, EXIT.usage, {
        path: canonicalSkillDir,
        next: 'select only one target for this directory'
      })
    }
    seenSkillDirs.add(canonicalSkillDir)

    const skillDir = join(target.rootDir, slug)
    if (await pathExists(skillDir) && !force) {
      throw new CliError(`skill already installed at ${skillDir}`, EXIT.filesystem, {
        path: skillDir,
        next: 'pass --force to overwrite'
      })
    }
    preparedTargets.push({ target, skillDir })
  }

  return preparedTargets
}

export async function installSkill(options: InstallOptions): Promise<{ installed: Array<{ agent: string; dir: string }> }> {
  const preparedTargets = await preflightInstallTargets(options.targets, options.slug, options.force)
  const client = new SkillHubClient(options.registry, options.token)
  const resolved = options.resolved ?? await client.resolve(options.namespace, options.slug, options.version)
  const response = await client.download(options.namespace, options.slug, resolved.version)
  const buffer = await readBoundedResponseBody(response)

  const installed: Array<{ agent: string; dir: string }> = []
  const store = new InventoryStore(options.home)

  for (const { target, skillDir } of preparedTargets) {
    await mkdir(target.rootDir, { recursive: true })
    const tempDir = await mkdtemp(join(target.rootDir, `.${options.slug}.install-`))
    let movedIntoPlace = false

    try {
      await extractZip(buffer, tempDir)
      await prepareInstalledExecutables(tempDir)

      const installedAt = new Date().toISOString()
      const snapshot = await snapshotSkillDirectory(tempDir)
      const metaDir = join(tempDir, '.skillhub')
      await mkdir(metaDir, { recursive: true })
      await writeFile(join(metaDir, 'metadata.json'), JSON.stringify({
        registry: options.registry,
        namespace: options.namespace,
        slug: options.slug,
        version: resolved.version,
        fingerprint: resolved.fingerprint,
        files: snapshot.files,
        source: 'skillhub',
        agent: target.agent,
        installedAt
      }, null, 2))

      if (await pathExists(skillDir) && !options.force) {
        throw new CliError(`skill already installed at ${skillDir}`, EXIT.filesystem, {
          path: skillDir,
          next: 'pass --force to overwrite'
        })
      }

      const backupDir = `${skillDir}.skillhub-backup-${process.pid}-${Date.now()}`
      let backupCreated = false
      try {
        if (await pathExists(skillDir)) {
          await rename(skillDir, backupDir)
          backupCreated = true
        }
        await rename(tempDir, skillDir)
        movedIntoPlace = true

        await store.replaceTargetAtInstallDir(options.registry, options.namespace, options.slug, resolved.version, {
          agent: target.agent,
          rootDir: target.rootDir,
          installDir: skillDir,
          installedAt
        }, resolved.fingerprint)

        if (backupCreated) await rm(backupDir, { recursive: true, force: true }).catch(() => {})
      } catch (error) {
        if (movedIntoPlace) {
          await rm(skillDir, { recursive: true, force: true }).catch(() => {})
          movedIntoPlace = false
        }
        if (backupCreated) await rename(backupDir, skillDir).catch(() => {})
        if (!options.force && await pathExists(skillDir)) {
          throw new CliError(`skill already installed at ${skillDir}`, EXIT.filesystem, {
            path: skillDir,
            next: 'pass --force to overwrite'
          })
        }
        throw error
      }
    } finally {
      if (!movedIntoPlace) {
        await rm(tempDir, { recursive: true, force: true }).catch(() => {})
      }
    }

    installed.push({ agent: target.agent, dir: skillDir })
  }

  return { installed }
}

/**
 * ZIP extraction does not reliably preserve Unix executable bits across the
 * registry upload/download path. Restore the executable bits for the managed
 * package entrypoints before the installation is moved into place.
 */
async function prepareInstalledExecutables(skillDir: string): Promise<void> {
  if (process.platform === 'win32') return

  const executablePaths: string[] = []
  const updateScript = join(skillDir, 'update.sh')
  if (await pathExists(updateScript)) executablePaths.push(updateScript)

  const binDir = join(skillDir, 'bin')
  if (await pathExists(binDir)) {
    const entries = await readdir(binDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) executablePaths.push(join(binDir, entry.name))
    }
  }

  for (const executablePath of executablePaths) {
    await chmod(executablePath, 0o755)
  }
}
