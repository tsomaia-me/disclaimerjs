const fs = require('fs')
const path = require('path')
const https = require('https')
const http = require('http')

const placeHolderRegExp = /\[([a-zA-Z0-9]+)]/g
const urlRegExp = /^(?<prefix>(.*?\+)?)(?<protocol>(?:(.*?:\/\/)|(\/\/))?)(?:(?:(?<username>.*?)(?:[@:]))?)(?:(?:(?<password>.*?)@)?)(?:(?:(?<host>.*?)\/)?)(?:(?:(?<path>.*?)(?:[?#]|$))?)(?:(?:(?<query>.*?)(?:#|$))?)(?:(?:(?<fragment>.*?)$)?)$/
const repositoryOwnerAndNameRegExp = /(?:\/|^)(?<owner>.*?)(?:\/|\.git|$)(?<name>.*?)(?:\/|\.git|$)/
const readmeLicenseStartRegex = /(?:^[ ]*[#]+(?:.*?)(?:license|licence)[ ]*(?:(?:\n[ ]*[\-]+)?)|^(?:.*?)(?:license|licence)[ ]*\n[ ]*[\-])/mi
const readmeLicenseEndRegex = /(?:\s*[#]|^(?:.*?)\n[ ]*[\-]+)/m
const dotPathRegExp = /^(?<path>(?:\.[\/\\]|\.\.[\/\\])*)/
const protocolRegExp = /^((?:.*?):\/+)/
const supportedRepositories = new Set(['github.com', 'gitlab.com', 'bitbucket.org'])
const branchVariants = ['master', 'main']
const requestPromiseCache = {}
const MIT_LICENSE_APPROX_LENGTH_WITHOUT_COPYRIGHT = 1039


const remoteLicenseFilePathVariants = [
  'LICENSE',
  'LICENSE.md',
  'LICENSE.txt',
  'LICENCE',
  'LICENCE.md',
  'LICENCE.txt',
  'MIT.LICENSE',
  'MIT.LICENSE.md',
  'MIT.LICENSE.txt',
  'LICENSE-MIT',
  'LICENSE-MIT.md',
  'LICENSE-MIT.txt',
  'LICENCE',
  'LICENCE.md',
  'LICENCE.txt',
  'LICENCE',
  'LICENCE.md',
  'LICENCE.txt',
  'MIT.LICENCE',
  'MIT.LICENCE.md',
  'MIT.LICENCE.txt',
  'LICENCE-MIT',
  'LICENCE-MIT.md',
  'LICENCE-MIT.txt',
  'COPYING',
  'COPYING.md',
  'COPYING.txt',
  'MIT.COPYING',
  'MIT.COPYING.md',
  'MIT.COPYING.txt',
  'COPYING-MIT',
  'COPYING-MIT.md',
  'COPYING-MIT.txt',
  'License',
  'License.md',
  'License.txt',
  'Licence',
  'Licence.md',
  'Licence.txt',
  'Licence',
  'Licence.md',
  'Licence.txt',
  'Licence',
  'Licence.md',
  'Licence.txt',
  'Copying',
  'Copying.md',
  'Copying.txt',
  'license',
  'license.md',
  'license.txt',
  'licence',
  'licence.md',
  'licence.txt',
  'licence',
  'licence.md',
  'licence.txt',
  'licence',
  'licence.md',
  'licence.txt',
  'copying',
  'copying.md',
  'copying.txt',
]

const remoteReadmeFilePathVariants = [
  'README',
  'README.md',
  'Readme',
  'Readme.md',
  'readme',
  'readme.md',
]

const remoteNoticeFilePathVariants = [
  'NOTICE',
  'NOTICE.md',
  'NOTICE.txt',
  'CopyrightNotice.txt',
]

function execute(...args) {
  return generateBundle(resolveParameters(parseArguments(args)))
}

async function generateBundle({
  dir,
  cacheDir = '.disclaimer',
  remote,
  registry = 'https://registry.npmjs.org/',
  reporting = false,
  forceFresh = false,
}) {
  const packageJson = await readJsonFile(path.join(dir, 'package.json'))
  const nodeModulesPath = path.join(dir, 'node_modules')
  const cacheFilePath = path.join(cacheDir, 'disclaimer.cache.json')
  const packageJsonCacheFilePath = path.join(cacheDir, 'package.json.cache.json')

  if (!packageJson) {
    throw new Error(`package.json not found at: ${dir}`)
  }

  if (!(await directoryExists(nodeModulesPath))) {
    throw new Error(`node_modules not found at: ${dir}`)
  }

  if (!await directoryExists(cacheDir)) {
    await mkdir(cacheDir)
  }

  let cache = {}
  let packageJsonCache = {}

  if (!forceFresh && await fileExists(cacheFilePath)) {
    cache = (await readJsonFile(cacheFilePath)) ?? {}
  }

  if (!forceFresh && await fileExists(packageJsonCacheFilePath)) {
    packageJsonCache = (await readJsonFile(packageJsonCacheFilePath)) ?? {}
  }

  const packageInfos = await resolvePackageInfos(dir, {
    cache,
    packageJsonCache,
    remote,
    registry,
    reporting,
  })

  await Promise.all([
    writeJsonFile(cacheFilePath, packageInfos.reduce((record, packageInfo) => {
      record[packageInfo.id] = packageInfo

      return record
    }, {})),
    writeJsonFile(packageJsonCacheFilePath, packageJsonCache),
  ])

  process.stdout.write('\r')
}

async function resolvePackageInfo(root, context) {
  const cache = context.cache
  const packageJsonPath = path.join(root, 'package.json')
  let packageJson = await readJsonFile(packageJsonPath)
  let id

  if (packageJson.name && packageJson.version) {
    id = `${packageJson.name}@${packageJson.version}`

    if (cache.hasOwnProperty(id)) {
      const licenseText = cache[id].licenseText

      if (typeof licenseText === 'string') {
        return licenseText
      }
    }
  }

  if (lacksPackageJsonImportantInformation(packageJson)) {
    let remotePackageJson = await resolvePackageJson({
      root,
      packageJson,
      packageJsonCache: context.packageJsonCache,
      registry: context.registry,
    })
    let versionKeys

    if (remotePackageJson
      && !remotePackageJson.version
      && remotePackageJson.versions
      && (versionKeys = Object.keys(remotePackageJson.versions)).length === 1
    ) {
      remotePackageJson = {
        ...remotePackageJson,
        ...remotePackageJson.versions[versionKeys[0]],
      }
    }

    packageJson = {
      ...await resolveContainerPackageJson(root, packageJson),
      ...remotePackageJson,
      ...packageJson,
    }

    // if (!hasPackageJsonAnEssentialInformation(packageJson)) {
    //   return null
    // }
  }

  const {
    name,
    version,
    license,
    licenses,
    author,
    repository,
    homepage,
  } = packageJson
  id = `${packageJson.name}@${packageJson.version}`
  const repositoryUrl = resolveRepositoryUrl(packageJson)
  const searchOptions = {
    id,
    root,
    packageJson,
    repositoryUrl,
    repositoryDirectory: repository?.directory ?? '',
    urlTemplate: context.remote,
    registry: context.registry,
    cache: context.cache,
    packageJsonCache: context.packageJsonCache,
  }
  const [licenseText, noticeText, thirdPartyNoticeText] = await Promise.all([
    searchForLicenseText(searchOptions),
    searchForNoticeText(searchOptions),
    searchForThirdPartyNoticeText(searchOptions),
  ])

  return {
    id,
    name,
    version,
    author,
    license,
    licenses,
    repository,
    homepage,
    repositoryUrl,
    repositoryDirectory: repository?.directory ?? '',
    path: root,
    packageJson: !name ? packageJson : null,
    licenseText: licenseText,
    noticeText: noticeText,
    thirdPartyNoticeText: thirdPartyNoticeText,
  }
}

function lacksPackageJsonImportantInformation(packageJson) {
  return !packageJson.version
    || (!packageJson.license && !packageJson.licenses)
    || !packageJson.repository
    || !packageJson.author
}

function hasPackageJsonAnEssentialInformation(packageJson) {
  return !!packageJson.license
    || !!packageJson.repository
    || !!packageJson.homepage
    || !!packageJson.author
}

/** License Text Resolvers */

async function searchForLicenseText(context) {
  return searchForContent(context, [
    searchForCachedLicenseText,
    searchForLocalLicenseText,
    searchForRemoteLicenseText,
    searchForContainerLicenseText,
    searchForLocalLicenseTextInReadme,
    searchForRemotePackageJsonLicenseTextInReadme,
    searchForRemoteLicenseTextInReadme,
  ])
}

async function searchForCachedLicenseText({ id, packageJson, cache }) {
  if (cache.hasOwnProperty(id)) {
    const licenseText = cache[id].licenseText

    if (typeof licenseText === 'object' && licenseText.assembled) {
      return null
    }

    return licenseText
  }

  return null
}

async function searchForLocalLicenseText({ root }) {
  return await resolveContent(await searchForLicenseFiles(root))
}

async function searchForRemoteLicenseText(context) {
  const { licenses } = context.packageJson

  if (licenses && Array.isArray(licenses) && licenses.length === 1 && licenses[0].url) {
    try {
      const url = resolveLicenseUrl(licenses[0].url, context)

      const response = await request(url)

      if (response.headers['content-type'].split(';')[0].trim().toLowerCase() === 'text/plain') {
        return response.body
      }
    } catch (e) {
    }
  }

  return await searchForRemoteFileContent(
    branchVariants,
    remoteLicenseFilePathVariants,
    context,
  )
}

async function searchForLocalLicenseTextInReadme({ root }) {
  return await resolveLicenseTextUsingReadme(
    await resolveContent(
      await searchForReadmeFiles(root)
    )
  )
}

async function searchForRemotePackageJsonLicenseTextInReadme(context) {
  const packageJson = await resolveRemotePackageJson(context, true) // true means force-no-version

  if (packageJson?.readme) {
    return await resolveLicenseTextUsingReadme(packageJson?.readme ?? '')
  }

  return null
}

async function searchForRemoteLicenseTextInReadme(context) {
  return await resolveLicenseTextUsingReadme(
    await searchForRemoteFileContent(
      branchVariants,
      remoteReadmeFilePathVariants,
      context,
    )
  )
}

async function searchForContainerLicenseText(context) {
  return searchForContainerContent(searchForLicenseText, context)
}

/** End License Text Resolvers */


/** Notice Text Resolvers */

async function searchForNoticeText(context) {
  return await searchForContent(context, [
    searchForCachedNoticeText,
    searchForLocalNoticeText,
    searchForRemoteNoticeText,
    searchForContainerNoticeText,
  ])
}

async function searchForCachedNoticeText({ id, cache }) {
  if (cache.hasOwnProperty(id) && cache[id].noticeText) {
    return cache[id].noticeText
  }
}

async function searchForLocalNoticeText({ root }) {
  return await resolveContent(await searchForNoticeFiles(root))
}

async function searchForRemoteNoticeText(context) {
  return await searchForRemoteFileContent(
    branchVariants,
    remoteNoticeFilePathVariants,
    context,
  )
}

async function searchForContainerNoticeText(context) {
  return searchForContainerContent(searchForNoticeText, context)
}

/** Notice Text Resolvers */


/** Third Party Notice Text Resolvers */

async function searchForThirdPartyNoticeText(context) {
  return await searchForContent(context, [
    searchForCachedThirdPartyNoticeText,
    searchForLocalThirdPartyNoticeText,
    searchForContainerThirdPartyNoticeText,
  ])
}

async function searchForCachedThirdPartyNoticeText({ id, cache }) {
  if (cache.hasOwnProperty(id) && cache[id].thirdPartyNoticeText) {
    return cache[id].thirdPartyNoticeText
  }
}

async function searchForLocalThirdPartyNoticeText({ root }) {
  return await resolveContent(await searchForThirdPartyNoticeFiles(root))
}

async function searchForContainerThirdPartyNoticeText(context) {
  return searchForContainerContent(searchForThirdPartyNoticeText, context)
}

/** End Third Party Notice Text Resolvers */



async function resolvePackageJson(context, forceNoVersion) {
  const cachedPackageJson = resolveCachedPackageJson(context)

  if (cachedPackageJson) {
    return cachedPackageJson
  }

  return resolveRemotePackageJson(context, forceNoVersion)
}

function resolveCachedPackageJson({ root, packageJsonCache }) {
  const packageJsonPath = path.join(root, 'package.json')

  if (packageJsonCache.hasOwnProperty(packageJsonPath)) {
    return packageJsonCache[packageJsonPath]
  }

  return null
}

/**
 *
 * @param {string} packageJsonPath
 * @param packageJsonCache
 * @param forceNoVersion
 * @returns {Promise<null|*>}
 */
async function resolveRemotePackageJson({ root, packageJson, packageJsonCache, registry }, forceNoVersion) {
  const { name, version } = packageJson
  const packageJsonPath = path.join(root, 'package.json')

  if (!name || (name[0] !== '@' && name.includes('/'))) {
    return null
  }

  let url = urlJoin(registry, name)

  if (forceNoVersion !== true && version) {
    url += `/${version}`
  }

  try {
    const packageJson = JSON.parse(await requestText(url))

    if (packageJson) {
      packageJsonCache[packageJsonPath] = packageJson
    }

    return packageJson
  } catch (e) {
    return null
  }
}

function resolveLicenseUrl(url, { packageJson, urlTemplate }) {
  if (!urlTemplate) {
    return url
  }

  const { host, path } = parseUrl(url)

  if (host !== 'github.com' || !path) {
    return url
  }

  const [owner, name, _, branch, ...pathSegments] = trimLeft(path, '/').split('/')

  return replacePlaceholdersWithValues(urlTemplate, {
    packageName: packageJson.name,
    repositoryOwner: owner,
    repositoryName: name,
    branch: branch,
    filePath: pathSegments.join('/'),
  })
}

async function searchForRemoteFileContent(branchVariants, pathVariants, {
  packageJson,
  repositoryUrl,
  repositoryDirectory,
  urlTemplate,
}) {
  if (!repositoryUrl || !urlTemplate) {
    return ''
  }

  const { path: repositoryUrlPath } = parseUrl(repositoryUrl)
  const [owner, name] = trimLeft(repositoryUrlPath, '/').split('/')

  for (const basePath of (repositoryDirectory ? [repositoryDirectory, ''] : [''])) {
    for (const branchVariant of branchVariants) {
      for (const pathVariant of pathVariants) {
        const url = replacePlaceholdersWithValues(urlTemplate, {
          packageName: packageJson.name,
          repositoryOwner: owner,
          repositoryName: name,
          branch: branchVariant,
          filePath: basePath ? trimLeft(urlJoin(basePath, pathVariant), '/') : pathVariant,
        })

        try {
          return await requestText(url)
        } catch (e) {
        }
      }
    }
  }

  return ''
}

function resolveRepositoryUrl(packageJson) {
  let repositoryUrl = findRepositoryUrl(packageJson)

  if (!repositoryUrl) {
    return null
  }

  if (repositoryUrl.startsWith('git+')) {
    repositoryUrl = repositoryUrl.substr(4)
  }

  if (!repositoryUrl.startsWith('https://') && !repositoryUrl.startsWith('http://')) {
    repositoryUrl = repositoryUrl.replace(protocolRegExp, replaceFirstCapturedGroupWithHttpsProtocol)
  }

  if (repositoryUrl.endsWith('.git')) {
    repositoryUrl = repositoryUrl.substr(0, repositoryUrl.length - 4)
  }

  return repositoryUrl
}

function replaceFirstCapturedGroupWithHttpsProtocol(_, match) {
  return 'https://'
}

/**
 *
 * @param packageJson
 * @returns {null|string}
 */
function findRepositoryUrl(packageJson) {
  const { repository, homepage, author } = packageJson

  if (repository?.url) {
    return repository.url
  }

  if (homepage && includesSupportedRepositoryHost(homepage)) {
    return homepage
  }

  if (author?.url && includesSupportedRepositoryHost(author.url)) {
    return author.url
  }

  return null
}

function includesSupportedRepositoryHost(url) {
  const { host } = parseUrl(url)

  return supportedRepositories.has(host.toLowerCase())
}

function extractRepositoryOwnerAndName(url) {
  const { path } = parseUrl(url)
  const { owner = '', name = '' } = path.match(repositoryOwnerAndNameRegExp)?.groups ?? {}

  return {
    owner,
    name,
  }
}

function parseUrl(url) {
  const {
    prefix = '',
    protocol = '',
    username = '',
    password = '',
    host = '',
    path = '',
    query = '',
    fragment = '',
  } = url.match(urlRegExp)?.groups ?? {}

  return {
    prefix,
    protocol,
    username,
    password,
    host,
    path,
    query,
    fragment,
  }
}

async function resolveContent(variantPaths) {
  // In future, maybe it will accept second, predicate parameter,
  // That would be used to determine if variant content is acceptable or not.
  // This would be handful to check, fox example, if the content matches known license pattern.
  for (const variant of variantPaths) {
    try {
      const content = await readFile(variant)

      if (content) {
        return content
      }
    } catch (e) {
    }
  }

  return ''
}

async function searchForLicenseFiles(root) {
  return await getMatchedFilePaths(root, isLikeLicenseFileName)
}

async function searchForReadmeFiles(root) {
  return await getMatchedFilePaths(root, isLikReadmeFileName)
}

async function searchForNoticeFiles(root) {
  return await getMatchedFilePaths(root, isLikeNoticeFileName)
}

async function searchForThirdPartyNoticeFiles(root) {
  return await getMatchedFilePaths(root, isLikeThirdPartyNoticeFileName)
}

function isLikeLicenseFileName(name) {
  const ucName = name.toUpperCase()

  return ucName === 'LICENSE'
    || ucName === 'LICENCE'
    || ucName === 'COPYING'
    || ucName.startsWith('LICENSE.')
    || ucName.startsWith('LICENCE.')
    || ucName.endsWith('.LICENSE')
    || ucName.endsWith('.LICENCE')
}

function isLikReadmeFileName(name) {
  const ucName = name.toUpperCase()

  return ucName === 'README.md'
    || ucName === 'README'
}

function isLikeNoticeFileName(name) {
  const ucName = name.toUpperCase()

  return ucName === 'NOTICE'
    || ucName === 'COPYRIGHTNOTICE'
    || ucName.startsWith('NOTICE.')
    || ucName.startsWith('COPYRIGHTNOTICE.')
    || ucName.endsWith('.NOTICE')
    || ucName.endsWith('.COPYRIGHTNOTICE')
}

function isLikeThirdPartyNoticeFileName(name) {
  const ucName = name.toUpperCase()

  return ucName === 'THIRDPARTYLICENSE'
    || ucName === 'THIRDPARTYLICENSETEXT'
    || ucName === 'THIRDPARTYLICENSES'
    || ucName === 'THIRDPARTYLICENSESTEXT'
    || ucName === 'THIRDPARTYNOTICE'
    || ucName === 'THIRDPARTYNOTICETEXT'
    || ucName === 'THIRDPARTYNOTICES'
    || ucName === 'THIRDPARTYNOTICESTEXT'
    || ucName === '3RDPARTYLICENSE'
    || ucName === '3RDPARTYLICENSETEXT'
    || ucName === '3RDPARTYLICENSES'
    || ucName === '3RDPARTYLICENSESTEXT'
    || ucName === '3RDPARTYNOTICE'
    || ucName === '3RDPARTYNOTICETEXT'
    || ucName === '3RDPARTYNOTICES'
    || ucName === '3RDPARTYNOTICESTEXT'
    || ucName === '3RDPARTYNOTICE'
    || ucName === '3RDPARTYNOTICETEXT'
    || ucName === 'THIRDPARTYLICENSE'
    || ucName.startsWith('THIRDPARTYLICENSETEXT.')
    || ucName.endsWith('.THIRDPARTYLICENSETEXT')
    || ucName.startsWith('THIRDPARTYLICENSES.')
    || ucName.endsWith('.THIRDPARTYLICENSES')
    || ucName.startsWith('THIRDPARTYLICENSESTEXT.')
    || ucName.endsWith('.THIRDPARTYLICENSESTEXT')
    || ucName.startsWith('THIRDPARTYNOTICE.')
    || ucName.endsWith('.THIRDPARTYNOTICE')
    || ucName.startsWith('THIRDPARTYNOTICETEXT.')
    || ucName.endsWith('.THIRDPARTYNOTICETEXT')
    || ucName.startsWith('THIRDPARTYNOTICES.')
    || ucName.endsWith('.THIRDPARTYNOTICES')
    || ucName.startsWith('THIRDPARTYNOTICESTEXT.')
    || ucName.endsWith('.THIRDPARTYNOTICESTEXT')
    || ucName.startsWith('3RDPARTYLICENSE.')
    || ucName.endsWith('.3RDPARTYLICENSE')
    || ucName.startsWith('3RDPARTYLICENSETEXT.')
    || ucName.endsWith('.3RDPARTYLICENSETEXT')
    || ucName.startsWith('3RDPARTYLICENSES.')
    || ucName.endsWith('.3RDPARTYLICENSES')
    || ucName.startsWith('3RDPARTYLICENSESTEXT.')
    || ucName.endsWith('.3RDPARTYLICENSESTEXT')
    || ucName.startsWith('3RDPARTYNOTICE.')
    || ucName.endsWith('.3RDPARTYNOTICE')
    || ucName.startsWith('3RDPARTYNOTICETEXT.')
    || ucName.endsWith('.3RDPARTYNOTICETEXT')
    || ucName.startsWith('3RDPARTYNOTICES.')
    || ucName.endsWith('.3RDPARTYNOTICES')
    || ucName.startsWith('3RDPARTYNOTICESTEXT.')
    || ucName.endsWith('.3RDPARTYNOTICESTEXT')
    || ucName.startsWith('3RDPARTYNOTICE.')
    || ucName.endsWith('.3RDPARTYNOTICE')
    || ucName.startsWith('3RDPARTYNOTICETEXT.')
    || ucName.endsWith('.3RDPARTYNOTICETEXT')
}

async function resolvePackageInfos(root, context) {
  // const packageInfos = []
  const roots = await findPackageRoots(root)
  const promises = []
  const count = roots.length
  let processed = 0

  for (let i = 0; i < count; ++i) {
    const packageRoot = roots[i]
    promises.push(resolvePackageInfo(packageRoot, context).then(packageInfo => {
      ++processed
      const roundedPercent = Math.floor(processed / count * 100)
      process.stdout.write(`\rProcessing packages: ${roundedPercent < 100 ? `~${roundedPercent}` : roundedPercent}%`)
      return packageInfo
    }))

    // const packageInfo = await resolvePackageInfo(packageRoot, context, i, l)
    //
    // if (packageInfo) {
    //   packageInfos.push(packageInfo)
    // }
  }

  // return packageInfos

  const packageInfos = await Promise.all(promises)

  return packageInfos.filter(p => !!p)
}

async function getMatchedFilePaths(root, predicate) {
  const matchedFileNames = []

  for (const entry of await readdir(root)) {
    const entryPath = path.join(root, entry)

    if (!await fileExists(entryPath)) {
      continue
    }

    if (predicate(entry)) {
      matchedFileNames.push(entryPath)
    }
  }

  return matchedFileNames
}

async function findPackageRoots(root) {
  const packageJsons = []
  const promises = []

  for (const entry of await readdir(root)) {
    const entryPath = path.join(root, entry)

    if (entry === 'package.json') {
      packageJsons.push(root)
    } else {
      promises.push(
        directoryExists(entryPath)
          .then(exists => !exists ? [] : findPackageRoots(entryPath))
      )
    }
  }

  return [
    ...packageJsons,
    ...(await Promise.all(promises)).reduce(flatten, []),
  ]
}

function flatten(reductionArray, currentArray) {
  return [
    ...reductionArray,
    ...currentArray,
  ]
}

function getPackageJsonDependencies(packageJson) {
  return {
    ...packageJson.dependencies,
    ...packageJson.peerDependencies,
    ...packageJson.optionalDependencies,
    // ...packageJson.devDependencies,
  }
}

async function findPackageJson(name, version, paths, fallbackPath) {
  const packageJson = searchForPackageJsonInPaths(paths)

  if (packageJson) {
    return packageJson
  }

  return await searchForPackageJsonRecursively(name, version, fallbackPath)
}

async function searchForPackageJsonInPaths(name, version, targetPaths) {
  for (const targetPath of targetPaths) {
    const packageJson = await findPackageJsonAt(name, version, targetPath)

    if (packageJson) {
      return packageJson
    }
  }

  return null
}

async function searchForPackageJsonRecursively(name, version, root) {
  let packageJson = await findPackageJsonAt(name, version, root)

  if (packageJson) {
    return packageJson
  }

  for (const entry of await readdir(root)) {
    const packageJson = await findPackageJsonAt(name, version, path.join(root, entry))

    if (packageJson) {
      return packageJson
    }
  }

  return null
}

async function findPackageJsonAt(name, version, targetPath) {
  const packageJsonPath = path.join(targetPath, name, 'package.json')

  if (!await fileExists(packageJsonPath)) {
    return null
  }

  const packageJson = await readJsonFile(packageJsonPath)

  if (packageJson.name === name && packageJson.version === version) {
    return packageJson
  }

  return null
}

async function findNodeModulesPaths(root) {
  const nodeModulesPath = path.join(root, 'node_modules')

  if (!await directoryExists(nodeModulesPath)) {
    return []
  }

  return [
    nodeModulesPath,
    ...await findSubNodeModulePaths(nodeModulesPath),
  ]
}

async function findSubNodeModulePaths(root) {
  const nodeModulePaths = []

  for (const entry of await readdir(root)) {
    const entryPath = path.join(root, entry)

    if (!entry.startsWith('@')) {
      nodeModulePaths.push(...await findNodeModulesPaths(entryPath))
    } else {
      for (const subEntry of await readdir(entryPath)) {
        nodeModulePaths.push(...await findNodeModulesPaths(path.join(entryPath, subEntry)))
      }
    }
  }

  return nodeModulePaths
}

async function searchForContent(context, resolvers) {
  for (const resolver of resolvers) {
    const content = await resolver(context)

    if (content) {
      return content
    }
  }

  return ''
}

async function resolveContainerPackageJson(root, packageJson) {
  if (packageJson.main && typeof packageJson.main === 'string') {
    const dotPath = extractDotPath(packageJson.main)

    if (!dotPath || dotPath === '.' || dotPath === './') {
      return ''
    }

    const targetPath = path.join(root, extractDotPath(packageJson.main))
    const packageJsonPath = path.join(targetPath, 'package.json')

    if (await fileExists(packageJsonPath)) {
      return await readJsonFile(packageJsonPath)
    }
  }

  if (!packageJson.hasOwnProperty('_requiredBy')) {

  }

  return null
}

async function searchForContainerContent(resolver, { root, packageJson, remote, cache }) {
  if (packageJson.main && typeof packageJson.main === 'string') {
    const dotPath = extractDotPath(packageJson.main)

    if (!dotPath || dotPath === '.' || dotPath === './') {
      return ''
    }

    const targetPath = path.join(root, extractDotPath(packageJson.main))
    const packageJsonPath = path.join(targetPath, 'package.json')

    if (await fileExists(packageJsonPath)) {
      const parentPackageJson = await readJsonFile(packageJsonPath)
      const id = `${parentPackageJson.name}@${parentPackageJson.version}`

      return await resolver({
        id,
        root: targetPath,
        packageJson: parentPackageJson,
        repositoryUrl: resolveRepositoryUrl(packageJson),
        urlTemplate: remote,
        cache: cache,
      })
    }
  }

  return ''
}

/**
 *
 * @param {string} targetPath
 * @returns {Promise<boolean>}
 */
async function fileExists(targetPath) {
  try {
    return (await stat(targetPath)).isFile()
  } catch (e) {
    return false
  }
}

/**
 *
 * @param {string} targetPath
 * @returns {Promise<boolean>}
 */
async function directoryExists(targetPath) {
  try {
    return (await stat(targetPath)).isDirectory()
  } catch (e) {
    return false
  }
}

/**
 *
 * @param {string} targetPath
 * @returns {Promise<*>}
 */
async function readJsonFile(targetPath) {
  return JSON.parse(await readFile(targetPath))
}

/**
 *
 * @param {string} targetPath
 * @param {*} content
 * @returns {Promise<*>}
 */
async function writeJsonFile(targetPath, content) {
  return await writeFile(targetPath, JSON.stringify(content, void 0, 2))
}

/**
 *
 * @param {string} targetPath
 * @returns {Promise<string>}
 */
function readFile(targetPath) {
  return toPromise(fs.readFile, targetPath, {
    encoding: 'utf8',
  })
}

/**
 *
 * @param {string} targetPath
 * @param {string} content
 * @returns {Promise<string>}
 */
function writeFile(targetPath, content) {
  return toPromise(fs.writeFile, targetPath, content, {
    encoding: 'utf8',
  })
}

/**
 *
 * @param {string} targetPath
 * @returns {Promise<string>}
 */
function stat(targetPath) {
  return toPromise(fs.stat, targetPath)
}

/**
 *
 * @param {string} targetPath
 * @returns {Promise<Array<string>>}
 */
function readdir(targetPath) {
  return toPromise(fs.readdir, targetPath)
}

/**
 *
 * @param {string} targetPath
 * @returns {Promise<*>}
 */
function mkdir(targetPath) {
  return toPromise(fs.mkdir, targetPath)
}

/**
 *
 * @param {string} url
 * @returns {Promise<{ statusCode: number, statusMessage: string, headers: IncomingHttpHeaders, body: string }>|*}
 */
function request(url) {
  if (requestPromiseCache.hasOwnProperty(url)) {
    return requestPromiseCache[url]
  }

  const promise = new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http
    const request = client.request(url, response => {
      let acc = ''

      response.on('data', data => acc += data)
      response.on('error', error => reject({
        statusCode: response.statusCode,
        statusMessage: response.statusMessage,
        headers: response.headers,
        body: error,
      }))
      response.on('end', () => {
        if (response.statusCode >= 400 && response.statusCode <= 599) {
          reject({
            statusCode: response.statusCode,
            statusMessage: response.statusMessage,
            headers: response.headers,
            body: acc,
          })
        } else {
          resolve({
            statusCode: response.statusCode,
            statusMessage: response.statusMessage,
            headers: response.headers,
            body: acc,
          })
        }
      })
    })

    request.on('error', reject)
    request.end()
  })

  requestPromiseCache[url] = promise

  return promise
}

/**
 *
 * @param {string} url
 * @returns {Promise<string>}
 */
async function requestText(url) {
  const { body } = await request(url)

  return body
}

function toPromise(fn, ...args) {
  return new Promise((resolve, reject) => {
    fn(...args, (error, result) => {
      if (error) {
        return reject(error)
      }

      resolve(result)
    })
  })
}

function resolveParameters({ dir, cacheDir, remote, registry, reporting = false, forceFresh = false }) {
  return {
    dir: dir ?? process.cwd(),
    cacheDir,
    remote,
    registry,
    reporting,
    forceFresh,
  }
}

/**
 *
 * @param {Array<string>} args
 * @returns {*}
 */
function parseArguments(args) {
  return args.reduce((record, arg) => {
    let [key, value = true] = arg.split('=')

    if (key.startsWith('--')) {
      key = key.substr(2)
    }

    record[key] = value

    return record
  }, {})
}

/**
 *
 * @param {string} readme
 *
 * @returns {Promise<string>}
 */
async function resolveLicenseTextUsingReadme(readme) {
  const licenseText = readme
    ?.split(readmeLicenseStartRegex)[1]
    ?.split(readmeLicenseEndRegex)[0]
    ?.trim()

  if (!licenseText) {
    return ''
  }

  if (isPossiblyAnMITCopyright(licenseText)) {
    return {
      assembled: true,
      text: replacePlaceholdersWithValues(await readFile(path.join(__dirname, 'templates/MIT.template')), {
        copyright: licenseText,
      }).trim(),
    }
  }

  return licenseText
}

function isPossiblyAnMITCopyright(text) {
  return text.toUpperCase().includes('MIT')
    && text.length < MIT_LICENSE_APPROX_LENGTH_WITHOUT_COPYRIGHT
}

function replacePlaceholdersWithValues(template, parameters) {
  return template.replace(
    placeHolderRegExp,
    (_, name) => parameters.hasOwnProperty(name) ? parameters[name] : name,
  )
}

function trimLeft(value, chars) {
  const set = new Set([...chars])
  let from = 0

  for (let i = 0, l = value.length; i < l; ++i) {
    if (set.has(value[i])) {
      ++from
    } else {
      break
    }
  }

  return value.substr(from)
}

function trimRight(value, chars) {
  const set = new Set([...chars])
  let skipCount = 0

  for (let i = value.length - 1; i >= 0; --i) {
    if (set.has(value[i])) {
      ++skipCount
    } else {
      break
    }
  }

  return value.substr(0, value.length - skipCount)
}

function trim(value, chars) {
  return trimLeft(trimRight(value, chars), chars)
}

function extractDotPath(path) {
  return path.match(dotPathRegExp)?.groups?.path ?? ''
}

function urlJoin(base, ...segments) {
  let url = base

  for (let i = 0, l = segments.length; i < l; ++i) {
    url = `${trimRight(url, '/')}/${trimLeft(segments[i], '/')}`
  }

  return url
}

exports.execute = execute
