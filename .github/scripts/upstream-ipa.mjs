#!/usr/bin/env node

import { appendFileSync, createReadStream, existsSync, readFileSync, statSync } from 'node:fs'

const upstreamRepo = 'czy0729/Bangumi'
const semverTagPattern = /^\d+\.\d+\.\d+$/
const apiBase = 'https://api.github.com'
const apiVersion = '2022-11-28'

/**
 * How many of the newest upstream tags to consider. Only the newest tag used to
 * be looked at, so a tag that landed while an earlier build was failing never
 * got an IPA at all -- it was simply skipped forever.
 */
const tagScanLimit = Number(process.env.TAG_SCAN_LIMIT || 5)

/** GitHub returns 5xx often enough that a single unlucky call should not fail a build. */
const maxAttempts = Number(process.env.GITHUB_API_ATTEMPTS || 4)

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2))

  if (command === 'resolve') {
    await resolveCommand(options)
    return
  }

  if (command === 'upload') {
    await uploadCommand(options)
    return
  }

  throw new Error(
    'Usage: upstream-ipa.mjs <resolve|upload> [--tag <x.y.z>] [--ipa <path>] [--sha <path>] [--metadata <path>]'
  )
}

async function resolveCommand(options) {
  const requestedTag = (options.tag || process.env.REQUESTED_TAG || '').trim()
  const forceRebuild = isTruthy(process.env.FORCE_REBUILD)
  const tags = await listUpstreamSemverTags()

  if (requestedTag && !semverTagPattern.test(requestedTag)) {
    throw new Error(`Upstream tag must match x.y.z, got: ${requestedTag}`)
  }

  if (requestedTag && !tags.includes(requestedTag)) {
    throw new Error(`Upstream tag not found in ${upstreamRepo}: ${requestedTag}`)
  }

  const altStorePath = options.altStore || 'alt_store.json'
  const candidates = requestedTag ? [requestedTag] : tags.slice(0, tagScanLimit)

  let target = null
  let unpublished = null

  for (const candidate of candidates) {
    const built = await hasBuiltAssets(candidate)
    const published = altStoreHasVersion(altStorePath, candidate)
    console.log(
      `${candidate}: ${built ? 'built' : 'no IPA assets'}, ${published ? 'in the AltStore source' : 'not in the AltStore source'}`
    )

    if (!built) {
      target = { tag: candidate, shouldBuild: true }
      break
    }

    // Built but never published: a previous run died between the upload and
    // the commit. Newest such tag wins, and it is fixed without a rebuild.
    if (!published && !unpublished) unpublished = candidate
  }

  if (!target) target = { tag: unpublished || candidates[0], shouldBuild: false }

  const tag = target.tag
  const shouldBuild = forceRebuild || target.shouldBuild
  const altStoreNeedsUpdate = shouldBuild || !altStoreHasVersion(altStorePath, tag)

  setOutput('tag', tag)
  setOutput('release_tag', releaseTagFor(tag))
  setOutput('asset_name', ipaAssetName(tag))
  setOutput('sha_name', `${ipaAssetName(tag)}.sha256`)
  setOutput('metadata_name', `${ipaAssetName(tag)}.metadata.json`)
  setOutput('should_build', String(shouldBuild))
  setOutput('altstore_needs_update', String(altStoreNeedsUpdate))

  console.log(`Target upstream tag: ${tag}`)
  console.log(`Build IPA: ${shouldBuild}${forceRebuild ? ' (forced)' : ''}`)
  console.log(`Update AltStore source: ${altStoreNeedsUpdate}`)
}

async function uploadCommand(options) {
  const tag = requiredOption(options, 'tag')
  const ipaPath = requiredOption(options, 'ipa')
  const shaPath = requiredOption(options, 'sha')
  const metadataPath = (options.metadata || '').trim()

  if (!semverTagPattern.test(tag)) {
    throw new Error(`Upstream tag must match x.y.z, got: ${tag}`)
  }

  ensureFile(ipaPath)
  ensureFile(shaPath)
  if (metadataPath) ensureFile(metadataPath)

  const repo = targetRepo()
  const assetName = ipaAssetName(tag)
  const shaName = `${assetName}.sha256`
  const metadataName = `${assetName}.metadata.json`
  const release = await ensureRelease(repo, tag, releaseTagFor(tag))
  const assets = await listReleaseAssets(repo, release.id)
  const forceRebuild = isTruthy(process.env.FORCE_REBUILD)

  const present = new Set(assets.map(asset => asset.name))
  if (present.has(assetName) && present.has(shaName) && !forceRebuild) {
    console.log(`Release already has ${assetName} and ${shaName}; leaving them unchanged.`)
    return
  }

  const replacing = new Set([assetName, shaName, metadataName])
  for (const asset of assets.filter(asset => replacing.has(asset.name))) {
    await deleteReleaseAsset(repo, asset.id)
  }

  await uploadAsset(release.upload_url, ipaPath, assetName, 'application/octet-stream')
  await uploadAsset(release.upload_url, shaPath, shaName, 'text/plain; charset=utf-8')
  if (metadataPath) {
    await uploadAsset(release.upload_url, metadataPath, metadataName, 'application/json')
  }

  console.log(`Uploaded ${assetName}, ${shaName}${metadataPath ? `, ${metadataName}` : ''}`)
  console.log(`Release URL: ${release.html_url}`)
}

/** True when the release for this tag already carries both required assets. */
async function hasBuiltAssets(tag) {
  const release = await getReleaseByTag(targetRepo(), releaseTagFor(tag))
  if (!release) return false

  const assets = await listReleaseAssets(targetRepo(), release.id)
  const names = new Set(assets.map(asset => asset.name))

  return names.has(ipaAssetName(tag)) && names.has(`${ipaAssetName(tag)}.sha256`)
}

/**
 * The AltStore source is the actual deliverable, so "already built" is not the
 * same question as "already published". Reading the committed file keeps a run
 * that uploaded assets but died before committing recoverable on the next run.
 */
function altStoreHasVersion(path, version) {
  if (!existsSync(path)) return false

  try {
    const source = JSON.parse(readFileSync(path, 'utf8'))
    return (source.apps || []).some(app =>
      (app.versions || []).some(entry => entry.version === version)
    )
  } catch (error) {
    console.log(`::warning::Could not read ${path} (${error.message}); assuming it needs an update.`)
    return false
  }
}

async function listUpstreamSemverTags() {
  const tags = []

  for (let page = 1; page <= 20; page += 1) {
    const pageTags = await githubJson(`/repos/${upstreamRepo}/tags?per_page=100&page=${page}`)
    if (!Array.isArray(pageTags)) {
      throw new Error('Unexpected GitHub tags response')
    }

    tags.push(...pageTags.map(tag => tag.name).filter(name => semverTagPattern.test(name)))

    if (pageTags.length < 100) {
      break
    }
  }

  const uniqueTags = [...new Set(tags)]
  uniqueTags.sort(compareSemverDesc)

  if (!uniqueTags.length) {
    throw new Error(`No semantic version tags found in ${upstreamRepo}`)
  }

  return uniqueTags
}

async function ensureRelease(repo, upstreamTag, releaseTag) {
  const existing = await getReleaseByTag(repo, releaseTag)
  const payload = {
    name: releaseName(upstreamTag),
    body: releaseBody(upstreamTag),
    prerelease: false,
    draft: false,
    make_latest: 'false'
  }

  if (existing) {
    return githubJson(`/repos/${repo}/releases/${existing.id}`, { method: 'PATCH', body: payload })
  }

  return githubJson(`/repos/${repo}/releases`, {
    method: 'POST',
    body: { tag_name: releaseTag, ...payload }
  })
}

async function getReleaseByTag(repo, tag) {
  return githubJson(`/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`, { allow404: true })
}

async function listReleaseAssets(repo, releaseId) {
  return githubJson(`/repos/${repo}/releases/${releaseId}/assets?per_page=100`)
}

async function deleteReleaseAsset(repo, assetId) {
  await githubJson(`/repos/${repo}/releases/assets/${assetId}`, {
    method: 'DELETE',
    expectJson: false
  })
}

async function uploadAsset(uploadUrlTemplate, filePath, name, contentType) {
  const uploadUrl = `${uploadUrlTemplate.replace(/\{.*$/, '')}?name=${encodeURIComponent(name)}`
  const size = statSync(filePath).size

  await withRetry(`upload ${name}`, async () => {
    const response = await fetch(uploadUrl, {
      method: 'POST',
      headers: githubHeaders({ 'Content-Type': contentType, 'Content-Length': String(size) }),
      body: createReadStream(filePath),
      duplex: 'half'
    })

    if (!response.ok) {
      throw new HttpError(response.status, `GitHub upload failed (${response.status}): ${await response.text()}`)
    }
  })
}

async function githubJson(path, options = {}) {
  const { method = 'GET', body, allow404 = false, expectJson = true } = options

  return withRetry(`${method} ${path}`, async () => {
    const response = await fetch(`${apiBase}${path}`, {
      method,
      headers: githubHeaders(body ? { 'Content-Type': 'application/json' } : {}),
      body: body ? JSON.stringify(body) : undefined
    })

    if (allow404 && response.status === 404) return null

    if (!response.ok) {
      throw new HttpError(
        response.status,
        `GitHub API ${method} ${path} failed (${response.status}): ${await response.text()}`
      )
    }

    if (!expectJson || response.status === 204) return null

    return response.json()
  })
}

class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

function isRetryable(error) {
  if (error instanceof HttpError) return error.status === 429 || error.status >= 500
  return true // network-level failure
}

async function withRetry(label, run) {
  let lastError

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await run()
    } catch (error) {
      lastError = error
      if (attempt === maxAttempts || !isRetryable(error)) break

      const delay = 2 ** attempt * 500
      console.log(`Retrying ${label} in ${delay}ms (attempt ${attempt}/${maxAttempts}): ${error.message}`)
      await new Promise(resolve => setTimeout(resolve, delay))
    }
  }

  throw lastError
}

function githubHeaders(extra = {}) {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${githubToken()}`,
    'X-GitHub-Api-Version': apiVersion,
    ...extra
  }
}

function parseArgs(argv) {
  const [command, ...rest] = argv
  const options = {}

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index]

    if (!arg.startsWith('--')) {
      throw new Error(`Unexpected argument: ${arg}`)
    }

    const equalsIndex = arg.indexOf('=')
    if (equalsIndex > -1) {
      options[camelCase(arg.slice(2, equalsIndex))] = arg.slice(equalsIndex + 1)
      continue
    }

    const key = camelCase(arg.slice(2))
    const value = rest[index + 1]
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for --${arg.slice(2)}`)
    }

    options[key] = value
    index += 1
  }

  return { command, options }
}

function camelCase(name) {
  return name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())
}

function compareSemverDesc(left, right) {
  const leftParts = left.split('.').map(Number)
  const rightParts = right.split('.').map(Number)

  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) {
      return rightParts[index] - leftParts[index]
    }
  }

  return 0
}

function releaseBody(tag) {
  const runUrl = process.env.GITHUB_RUN_ID
    ? `${process.env.GITHUB_SERVER_URL}/${targetRepo()}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : null

  return [
    `Automated unsigned IPA build for upstream Bangumi tag \`${tag}\`.`,
    `Source: https://github.com/${upstreamRepo}/tree/${tag}`,
    `Source archive: https://github.com/${upstreamRepo}/archive/refs/tags/${tag}.zip`,
    'The IPA is intentionally unsigned and should be signed by your sideloading tool or a later signing workflow.',
    runUrl ? `Build run: ${runUrl}` : null
  ]
    .filter(Boolean)
    .join('\n\n')
}

function releaseName(tag) {
  return `Bangumi ${tag} unsigned IPA`
}

function releaseTagFor(tag) {
  return `upstream-${tag}`
}

function ipaAssetName(tag) {
  return `Bangumi-${tag}-unsigned.ipa`
}

function targetRepo() {
  const repo = process.env.GITHUB_REPOSITORY
  if (!repo) {
    throw new Error('GITHUB_REPOSITORY is required')
  }
  return repo
}

function githubToken() {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN
  if (!token) {
    throw new Error('GITHUB_TOKEN is required')
  }
  return token
}

function requiredOption(options, name) {
  const value = (options[name] || '').trim()
  if (!value) {
    throw new Error(`--${name} is required`)
  }
  return value
}

function isTruthy(value) {
  return ['1', 'true', 'yes'].includes(String(value || '').toLowerCase())
}

function ensureFile(filePath) {
  if (!existsSync(filePath)) {
    throw new Error(`File does not exist: ${filePath}`)
  }

  if (!statSync(filePath).isFile()) {
    throw new Error(`Path is not a file: ${filePath}`)
  }
}

function setOutput(name, value) {
  const outputPath = process.env.GITHUB_OUTPUT
  if (outputPath) {
    appendFileSync(outputPath, `${name}=${value}\n`)
  }
}

main().catch(error => {
  console.error(`::error::${error.message}`)
  process.exit(1)
})
