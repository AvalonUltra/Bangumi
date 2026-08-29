#!/usr/bin/env node

/*
 * Apply the IPA patch set, strictly.
 *
 * patch-package used to be run as `patch-package || echo ::warning::` because
 * packages/ipa/patches carries patches for packages the IPA dependency set does
 * not install (react-native-realtimeblurview belongs to the android/web sets).
 * That guaranteed a non-zero exit on every single run, which in turn meant a
 * genuinely broken patch was indistinguishable from the expected noise.
 *
 * Instead: drop the patches whose package is not installed -- provably nothing
 * to apply them to -- and then let any remaining failure fail the build.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const PATCH_DIRS = ['packages/ipa/patches', 'patches']

function notice(message) {
  console.log(`::notice::${message}`)
}

function fail(message) {
  console.error(`::error::${message}`)
  process.exit(1)
}

/** `@react-native-community+cameraroll+4.1.2.patch` -> `@react-native-community/cameraroll` */
function packageNameFromPatch(fileName) {
  const parts = fileName.replace(/\.patch$/, '').split('+')
  return parts[0].startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0]
}

function prune(dir) {
  if (!existsSync(dir)) return []

  const dropped = []

  for (const fileName of readdirSync(dir)) {
    if (!fileName.endsWith('.patch')) continue

    const packageName = packageNameFromPatch(fileName)
    if (existsSync(join('node_modules', packageName))) continue

    rmSync(join(dir, fileName))
    dropped.push(`${fileName} (${packageName} is not in the IPA dependency set)`)
  }

  return dropped
}

function main() {
  if (process.env.SOURCE_DIR) process.chdir(process.env.SOURCE_DIR)

  const patchDir = process.argv[2] || PATCH_DIRS[0]

  const dropped = PATCH_DIRS.flatMap(prune)
  if (dropped.length) {
    notice(`Skipped patches for packages this environment does not install:\n  ${dropped.join('\n  ')}`)
  }

  if (!existsSync(patchDir) || !readdirSync(patchDir).some(name => name.endsWith('.patch'))) {
    fail(`No patches left to apply in ${patchDir}; the IPA patch set should never be empty`)
  }

  try {
    execFileSync('./node_modules/.bin/patch-package', ['--patch-dir', patchDir, '--error-on-fail'], {
      stdio: 'inherit'
    })
  } catch {
    fail(
      `patch-package failed for ${patchDir}. A patch that targets an installed package did not ` +
        'apply -- the dependency moved underneath it. Refresh the patch, do not ignore this.'
    )
  }
}

main()
