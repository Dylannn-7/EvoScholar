// Prepares the packaged app's writable workspace from the read-only install folder.
// Kept free of Electron so it can be tested with plain Node.
'use strict'
const { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } = require('node:fs')
const { basename, join, relative } = require('node:path')

// On each new app version: mirrored folders match the install exactly (stale files go away);
// merged paths are refreshed without deleting, because evolution adds prompts/system@g-*.md there.
const MIRRORED = ['python', 'sandbox', 'rulepacks/figures', 'rulepacks/writing']
const MERGED = ['evoscholar.config.json', 'prompts', '.dockerignore', 'scripts/setup-python.mjs', 'scripts/build-sandbox.mjs', 'scripts/requirements.txt']
// Genomes evolve with the user: only missing files are added. Skills are handled per skill below.
const USER_SEEDED = ['genomes']
const REVISION = /^SKILL@v\d+\.md$/

/** Returns the workspace root after seeding (first run) or refreshing app-owned files (new version). */
function prepareWorkspace ({ appDir, root, version }) {
  const marker = join(root, '.app-version')
  const previous = existsSync(marker) ? readFileSync(marker, 'utf8').trim() : ''
  mkdirSync(root, { recursive: true })
  const copy = (rel, overwrite) => {
    const from = join(appDir, rel)
    if (existsSync(from)) cpSync(from, join(root, rel), { recursive: true, force: overwrite, errorOnExist: false })
  }
  const upgraded = previous !== version
  if (upgraded) {
    for (const rel of MIRRORED) { rmSync(join(root, rel), { recursive: true, force: true }); copy(rel, true) }
    for (const rel of MERGED) copy(rel, true)
  }
  for (const rel of USER_SEEDED) copy(rel, false)
  seedSkills(appDir, root, upgraded)
  if (!existsSync(join(root, '.env'))) writeFileSync(join(root, '.env'), '')
  writeFileSync(marker, version)
  return root
}

/**
 * Bundled skills: new ones are added; on upgrade, built-in skills (no .source.json) take the new
 * SKILL.md and resources, while revision files (SKILL@vN.md) are never overwritten because genomes
 * pin them. Imported and forged skills are left alone.
 */
function seedSkills (appDir, root, upgraded) {
  const from = join(appDir, 'skills')
  if (!existsSync(from)) return
  for (const name of readdirSync(from)) {
    const src = join(from, name)
    const dest = join(root, 'skills', name)
    if (!statSync(src).isDirectory()) continue
    if (!existsSync(dest)) { cpSync(src, dest, { recursive: true }); continue }
    if (!upgraded || existsSync(join(dest, '.source.json'))) continue
    cpSync(src, dest, { recursive: true, force: true, filter: (file) => !(REVISION.test(basename(file)) && existsSync(join(dest, relative(src, file)))) })
  }
}

module.exports = { prepareWorkspace }
