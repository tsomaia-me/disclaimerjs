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
const licenseTypesRegExp = /(apache|mit|isc|bsd)\s+license/ig
const licenseTypeRegExp = /(apache|mit|isc|bsd)\s+license/i
const supportedRepositories = new Set(['github.com', 'gitlab.com', 'bitbucket.org'])
const branchVariants = ['master', 'main']
const requestPromiseCache = {}
const APACHE_2_0_LICENSE_APPROX_LENGTH_WITHOUT_COPYRIGHT = 547
const ISC_LICENSE_APPROX_LENGTH_WITHOUT_COPYRIGHT = 696
const MIT_LICENSE_APPROX_LENGTH_WITHOUT_COPYRIGHT = 1022
const MIT_0_LICENSE_APPROX_LENGTH_WITHOUT_COPYRIGHT = 857
const licenseTemplatePaths = {
  APACHE_2_0: path.join(__dirname, 'templates/Apache-2.0.template'),
  CC_BY_3_0: path.join(__dirname, 'templates/CC-BY-3.0.template'),
  ISC: path.join(__dirname, 'templates/ISC.template'),
  MIT: path.join(__dirname, 'templates/MIT.template'),
  MIT_0: path.join(__dirname, 'templates/MIT-0.template'),
}

licenseTemplatePaths['Apache-2.0'] = licenseTemplatePaths.APACHE_2_0
licenseTemplatePaths['APACHE-2.0'] = licenseTemplatePaths.APACHE_2_0
licenseTemplatePaths['CC-BY-3.0'] = licenseTemplatePaths.CC_BY_3_0
licenseTemplatePaths['MIT-0'] = licenseTemplatePaths.MIT_0

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

const lookupTransitiveDevDependencies = [
  { target: 'webpack', exact: true },
  { target: 'babel', exact: true },
  { target: 'gulp', exact: true },
  { target: 'percel', exact: true },
  { target: 'browserify', exact: true },
  { target: 'grunt', exact: true },
  { target: 'typescript', exact: true },
  { target: 'flow', exact: true },
  { target: 'coffeescript', exact: true },
  { target: 'elm', exact: true },
  { target: 'clojurescript', exact: true },
  { target: 'purescript', exact: true },
  { target: 'sass', exact: true },
  { target: 'scss', exact: true },
  { target: 'less', exact: true },
  { target: 'postcss', exact: true },
  { target: 'react-css-modules', exact: true },
  { target: 'webassemblyjs', exact: true },

  { target: 'webpack-', exact: false },
  { target: '@webpack/', exact: false },
  { target: 'babel-', exact: false },
  { target: '@babel/', exact: false },
  { target: 'gulp-', exact: false },
  { target: '@gulp/', exact: false },
  { target: 'percel-', exact: false },
  { target: '@percel/', exact: false },
  { target: 'browserify-', exact: false },
  { target: '@browserify/', exact: false },
  { target: 'grunt-', exact: false },
  { target: '@grunt/', exact: false },
  { target: '@webassemblyjs/', exact: false },
]

let progress = ''

function log(...args) {
  process.stdout.write(`\r${args.map(String).join(' ')}\n`)

  if (progress) {
    process.stdout.write(progress)
  }
}

function execute(...args) {
  return generateBundle(resolveParameters(parseArguments(args)))
}

async function generateBundle({
  out,
  dir,
  cacheDir = '.disclaimer',
  remote,
  registry = 'https://registry.npmjs.org/',
  append,
  prepend,
  ignorePackages = '',
  ignorePaths = '',
  json = false,
  csv = false,
  txt = true,
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

  ignorePackages = new Set(!ignorePackages ? [] : ignorePackages.split(',').map(v => v.trim()))
  ignorePaths = new Set(!ignorePaths ? [] : ignorePaths.split(',').map(v => path.resolve(path.join(dir, v.trim()))))

  if (!forceFresh && await fileExists(cacheFilePath)) {
    cache = (await readJsonFile(cacheFilePath)) ?? {}
  }

  if (!forceFresh && await fileExists(packageJsonCacheFilePath)) {
    packageJsonCache = (await readJsonFile(packageJsonCacheFilePath)) ?? {}
  }

  const context = {
    cache,
    packageJsonCache,
    remote,
    registry,
    reporting,
    ignorePackages,
    ignorePaths,
  }

  const packageJsonFiles = await findPackageJsonFiles(dir, context)
  // const selectedDevDependencies = findWhiteListedTransitiveDevDependencies(
  //   packageJsonFiles,
  //   lookupTransitiveDevDependencies,
  // )
  //
  // await writeJsonFile('info.json', selectedDevDependencies)


  const packageInfos = await resolvePackageInfos(packageJsonFiles, context)

  const packageInfoMap = packageInfos.reduce((record, packageInfo) => {
    if (record.hasOwnProperty(packageInfo.id)) {
      const another = record[packageInfo.id]

      if (another.licenseText && !packageInfo.licenseText) {
        return record
      }

      if (another.noticeText && !packageInfo.noticeText) {
        return record
      }

      if (another.thirdPartyNoticeText && !packageInfo.thirdPartyNoticeText) {
        return record
      }

      if (another.repositoryUrl && !packageInfo.repositoryUrl) {
        return record
      }

      if (another.author && !packageInfo.author) {
        return record
      }

      if (another.maintainers && !packageInfo.maintainers) {
        return record
      }

      if (another.contributors && !packageInfo.contributors) {
        return record
      }
    }

    record[packageInfo.id] = packageInfo

    return record
  }, {})

  await Promise.all([
    writeJsonFile(cacheFilePath, packageInfoMap),
    writeJsonFile(packageJsonCacheFilePath, packageJsonCache),
  ])

  const normalizedPackageInfos = normalizePackageInfos(Object.values(packageInfoMap), context)

  if (json) {
    const outName = out ?? path.join(dir, 'ThirdPartyLicenses.json')
    await writeJsonFile(outName, normalizedPackageInfos)
  } else if (csv) {
    const outName = out ?? path.join(dir, 'ThirdPartyLicenses.csv')
    await writeFile(outName, formatCsv(normalizedPackageInfos))
  } else if (txt) {
    const outName = out ?? path.join(dir, 'ThirdPartyLicenses.txt')
    let content = ''

    if (prepend) {
      content = await readFile(prepend)
    }

    const generatedContent = formatTxt(normalizedPackageInfos)

    if (generatedContent) {
      if (content) {
        content += '\n\n\n'
      }

      content += generatedContent
    }

    if (append) {
      if (content) {
        content += '\n\n\n'
      }

      content += await readFile(append)
    }

    await writeFile(outName, content)
  }

  process.stdout.write('\r')
}

function formatTxt(normalizedPackageInfos) {
  return normalizedPackageInfos
    .map(formatPackageTxt)
    .join('\n\n\n---------------------------------------------------------------\n\n\n')
}

function formatPackageTxt({
  name,
  version,
  author,
  maintainers,
  contributors,
  repositoryUrl,
  licenseText,
  noticeText,
  thirdPartyNoticeText,
}) {
  let result = `This project may include the following software: ${name}`

  if (version != null) {
    result += `, version ${version}.`
  }

  if (repositoryUrl) {
    result += `\nThe source code of the software may be found at: ${repositoryUrl}`
  }

  if (author) {
    result += `\nAuthor of the software: ${author}`
  }

  if (maintainers && Array.isArray(maintainers) && maintainers.length > 0) {
    result += `\nMaintainers:\n${maintainers.join('\n')}\n`
  }

  if (contributors && Array.isArray(contributors) && contributors.length > 0) {
    result += `\nContributors:\n${contributors.join('\n')}\n`
  }

  if (licenseText || noticeText || thirdPartyNoticeText) {
    result += '\nSee the'

    if (licenseText) {
      result += ' license'
    }

    if (noticeText) {
      if (licenseText) {
        result += thirdPartyNoticeText ? ',' : ' and'
      }

      result += ' notice'
    }

    if (thirdPartyNoticeText) {
      if (licenseText || noticeText) {
        result += licenseText && noticeText ? ' and' : ','
      }

      result += ' third party notice'
    }

    result += `, associated with the software, below:`
  }

  if (licenseText) {
    result += `\n${licenseText}`
  }

  if (noticeText) {
    if (licenseText) {
      result += '\n'
    }

    result += `\n${noticeText}`
  }

  if (thirdPartyNoticeText) {
    if (noticeText) {
      result += '\n'
    }

    result += `\n${thirdPartyNoticeText}`
  }

  return result
}

function formatCsv(normalizedPackageInfos) {
  const headers = [
    'name',
    'version',
    'author',
    'maintainers',
    'contributors',
    'repositoryUrl',
    'licenseText',
    'noticeText',
    'thirdPartyNoticeText',
  ]

  return [
    headers.map(mapToJsonString).join(','),
    ...normalizedPackageInfos.map(item => Object.values({
      name: JSON.stringify(item.name),
      version: JSON.stringify(item.version),
      author: JSON.stringify(item.author),
      maintainers: JSON.stringify(item.maintainers.join('\n')),
      contributors: JSON.stringify(item.contributors.join('\n')),
      repositoryUrl: JSON.stringify(item.repositoryUrl),
      licenseText: JSON.stringify(item.licenseText),
      noticeText: JSON.stringify(item.noticeText),
      thirdPartyNoticeText: JSON.stringify(item.thirdPartyNoticeText),
    }).join(',')),
  ].join('\n')
}

function mapToJsonString(value) {
  return JSON.stringify(value)
}

function normalizePackageInfos(packageInfos, context) {
  return packageInfos
    .map(packageInfo => {
      if (!packageInfo.licenseText && context.reporting) {
        log(`No license text for ${packageInfo.id} (root: ${packageInfo.path})`)
      }

      return normalizePackageInfo(packageInfo, context)
    })
}

function normalizePackageInfo({
  id,
  name,
  version,
  author,
  maintainers,
  contributors,
  licenseList,
  repositoryUrl,
  repositoryDirectory,
  licenseText,
  noticeText,
  thirdPartyNoticeText,
}, context) {
  // const matches = licenseText.match(licenseTypesRegExp) ?? []
  // const licenseTypes = matches.map(match => match.match(licenseTypeRegExp)[1])
  //
  // for (const licenseType of licenseTypes) {
  //   const ucLicenseType = licenseType.toUpperCase()
  //
  //   if (licenseType && licenseList && licenseList.length > 0 && !licenseList.some(l => l.toUpperCase().includes(ucLicenseType))) {
  //     if (context.reporting) {
  //       log(`License text (${licenseType}) of ${id}, likely, does not match with license specified in package.json: ${licenseList.join(', ')}`)
  //     }
  //   }
  // }

  return {
    name,
    version,
    author: mapPersonInfoToName(author),
    maintainers: !maintainers || !Array.isArray(maintainers) ? [] : maintainers.map(mapPersonInfoToName),
    contributors: !contributors || !Array.isArray(contributors) ? [] : contributors.map(mapPersonInfoToName),
    repositoryUrl,
    licenseText,
    noticeText,
    thirdPartyNoticeText,
  }
}

function mapPersonInfoToName(info) {
  return typeof info === 'object' ? info.name : info
}

/**
 *
 * @param {Array<{ dirPath: string, packageJsonPath: string, packageJson: * }>} packageJsonFiles
 * @param {Array<{ target: string, exact: boolean }>} patterns
 */
function findWhiteListedTransitiveDevDependencies(packageJsonFiles, patterns) {
  const selectedDevDependencyMap = {}

  for (const { packageJson } of packageJsonFiles) {
    const devDependencies = packageJson.devDependencies

    if (devDependencies) {
      for (const devDependency of Object.keys(devDependencies)) {
        for (const pattern of patterns) {
          if (matchesDependencyPattern(devDependency, pattern)) {
            if (!selectedDevDependencyMap.hasOwnProperty(devDependency)) {
              selectedDevDependencyMap[devDependency] = {}
            }

            const value = devDependencies[devDependency]
            selectedDevDependencyMap[devDependency][value] = true // პირველადი ფილტრაცია, რის შედეგადაც კონკრეტული key@value არ გამერდება
          }
        }
      }
    }
  }

  // const selectedDevDependencies = Object.values(selectedDevDependencyMap)
  //
  // for (let i = 0, l = selectedDevDependencies.length; i < l; ++i) { // მეორეული ფილტრაცია, როდესაც შეწყობადი ვერსიებიდან უნდა დარჩეს ერთერთი
  //   const a = selectedDevDependencies[i]
  //
  //   for (let j = i + 1; j < l; ++j) {
  //     const b = selectedDevDependencies[j]
  //
  //     if (a.name)
  //   }
  // }

  return Object.keys(selectedDevDependencyMap).map(name => ({
    name,
    values: Object.keys(selectedDevDependencyMap[name]).sort(),
  }))
}

/**
 *
 * @param {string} name
 * @param {{target: string, exact: boolean}} pattern
 */
function matchesDependencyPattern(name, pattern) {
  if (pattern.exact) {
    return name === pattern.target
  }

  return name.startsWith(pattern.target)
}

async function resolvePackageInfo({ dirPath: root, packageJsonPath, packageJson }, context) {
  const cache = context.cache
  let id

  if (packageJson.name && packageJson.version) {
    id = `${packageJson.name}@${packageJson.version}`

    if (cache.hasOwnProperty(id)) {
      const item = cache[id]

      if (!item.assembled && item.licenseText) {
        return item
      }
    }
  }

  if (shouldIgnorePackageJson(packageJson)) {
    // if (context.reporting) {
    //   log(`Ignoring package.json at: ${packageJsonPath}`, JSON.stringify(packageJson))
    // }

    return null
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
      version: remotePackageJson?.version || packageJson?.version,
    }
  }

  const {
    name,
    version,
    license,
    licenses,
    author,
    maintainers,
    contributors,
    repository,
    homepage,
  } = packageJson
  id = `${packageJson.name}@${packageJson.version}`
  const repositoryUrl = resolveRepositoryUrl(packageJson)
  const licenseList = resolveLicenseList(packageJson)
  const searchOptions = {
    id,
    root,
    packageJson,
    repositoryUrl,
    licenseList,
    repositoryDirectory: repository?.directory ?? '',
    urlTemplate: context.remote,
    registry: context.registry,
    cache: context.cache,
    reporting: context.reporting,
    packageJsonCache: context.packageJsonCache,
  }
  const [licenseData, noticeText, thirdPartyNoticeText] = await Promise.all([
    searchForLicenseText(searchOptions),
    searchForNoticeText(searchOptions),
    searchForThirdPartyNoticeText(searchOptions),
  ])
  const licenseText = typeof licenseData === 'string' ? licenseData : licenseData.text

  return {
    id: id === 'undefined@undefined' ? `undefined:${root}` : id,
    name,
    version,
    author,
    maintainers: maintainers && Array.isArray(maintainers) ? maintainers : [],
    contributors: contributors && Array.isArray(contributors) ? contributors : [],
    license,
    licenses,
    licenseList,
    repository,
    homepage,
    repositoryUrl,
    repositoryDirectory: repository?.directory ?? '',
    path: root,
    assembled: typeof licenseData !== 'string',
    licenseText,
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

function shouldIgnorePackageJson(packageJson) {
  // If package.json does not specify name, why not ignore it?
  return !packageJson.name

  // // If package.json does not contain even one of the information below, then why not just ignore it?
  // return !packageJson.name
  //   && !packageJson.version
  //   && !packageJson.license
  //   && !packageJson.licenses
  //   && !packageJson.repository
  //   && !packageJson.homepage
  //   && !packageJson.author
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
    assembleLicenseText,
  ])
}

async function searchForCachedLicenseText({ id, assembled, cache }) {
  if (!assembled && cache.hasOwnProperty(id) && cache[id].licenseText) {
    return cache[id].licenseText
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

async function searchForLocalLicenseTextInReadme(context) {
  return await resolveLicenseTextUsingReadme(
    await resolveContent(
      await searchForReadmeFiles(context.root)
    ),
    context,
  )
}

async function searchForRemotePackageJsonLicenseTextInReadme(context) {
  const packageJson = await resolveRemotePackageJson(context, true) // true means force-no-version

  if (packageJson?.readme) {
    return await resolveLicenseTextUsingReadme(packageJson?.readme ?? '', context)
  }

  return null
}

async function searchForRemoteLicenseTextInReadme(context) {
  return await resolveLicenseTextUsingReadme(
    await searchForRemoteFileContent(
      branchVariants,
      remoteReadmeFilePathVariants,
      context,
    ),
    context,
  )
}

async function searchForContainerLicenseText(context) {
  return searchForContainerContent(searchForLicenseText, context)
}

async function assembleLicenseText({ id, repositoryUrl, packageJson, licenseList, reporting }) {
  const paths = licenseList
    .filter(type => {
      const ucType = type.toUpperCase()

      if (licenseTemplatePaths.hasOwnProperty(ucType)) {
        return true
      }

      if (reporting) {
        log(`Could not find ${type} license template for package: ${id}`)
      }

      return false
    })
    .map(type => licenseTemplatePaths[type.toUpperCase()])

  const templates = await Promise.all(paths.map(readFile))
  const fullYear = new Date().getFullYear()
  let licenseText

  if (packageJson.author) {
    const authorName = typeof packageJson.author === 'object' ? packageJson.author.name : packageJson.author
    licenseText = generateJoinedLicenseText(templates, authorName, fullYear, packageJson)

    if (licenseText && reporting) {
      log(`Auto-generated COPYRIGHT notice for ${id} using AUTHOR NAME and CURRENT YEAR`)
    }
  } else if (repositoryUrl) {
    const { path: repositoryPath } = parseUrl(repositoryUrl)
    const [owner] = trimLeft(repositoryPath, '/').split('/')
    licenseText = generateJoinedLicenseText(templates, owner, fullYear, packageJson)

    if (licenseText && reporting) {
      log(`Auto-generated COPYRIGHT notice for ${id} using REPOSITORY OWNER and CURRENT YEAR`)
    }
  }

  if (!licenseText) {
    return null
  }

  return {
    assembled: true,
    text: licenseText,
  }
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



async function resolvePackageJson(context, forceNoVersion = false) {
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
    version: packageJson.version,
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

async function resolvePackageInfos(packageJsonFiles, context) {
  const { ignorePackages } = context
  const filteredPackageJsonFiles = packageJsonFiles.filter(packageJsonFile => (
    !ignorePackages.has(packageJsonFile.packageJson.name)
    && !ignorePackages.has(packageJsonFile.id)
  ))
  const count = filteredPackageJsonFiles.length
  let processed = 0

  const packageInfos = await Promise.all(
    filteredPackageJsonFiles
      .filter(packageJsonFile => (
        !ignorePackages.has(packageJsonFile.packageJson.name)
        && !ignorePackages.has(packageJsonFile.id)
      ))
      .map(packageJsonFile => (
        resolvePackageInfo(packageJsonFile, context).then(packageInfo => {
          ++processed
          const roundedPercent = Math.floor(processed / count * 100)
          progress = `\rProcessing packages: ${roundedPercent < 100 ? `~${roundedPercent}` : roundedPercent}%`
          process.stdout.write(progress)

          return packageInfo
        })
      ))
  )

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

/**
 *
 * @param {string} root
 * @param context
 * @returns {Promise<{packageJson: *, dirPath: string, packageJsonPath: string}[]>}
 */
async function findPackageJsonFiles(root, context) {
  const packageRoots = await findPackageRoots(root, context)

  return await Promise.all(
    packageRoots.map(packageRoot => {
      const packageJsonPath = path.join(packageRoot, 'package.json')

      return readJsonFile(packageJsonPath).then(packageJson => ({
        id: `${packageJson.name}@${packageJson.version}`,
        dirPath: packageRoot,
        packageJsonPath,
        packageJson,
      }))
    })
  )
}

/**
 *
 * @param {string} root
 * @param context
 * @param isOrigin
 * @returns {Promise<Array<string>>}
 */
async function findPackageRoots(root, context, isOrigin = true) {
  const { ignorePaths } = context

  if (ignorePaths.has(path.resolve(root))) {
    return []
  }

  const paths = []
  const promises = []

  for (const entry of await readdir(root)) {
    const entryPath = path.join(root, entry)

    if (!isOrigin && entry === 'package.json') {
      paths.push(root)
    } else {
      promises.push(
        directoryExists(entryPath)
          .then(exists => {
            if (!exists || ignorePaths.has(path.resolve(entryPath))) {
              return []
            }

            return findPackageRoots(entryPath, context, false)
          })
      )
    }
  }

  return [
    ...paths,
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
  const variants = [
    packageJson.main,
    packageJson.module,
    packageJson.types,
    packageJson.typings,
    packageJson.esnext,
    packageJson.es2015,
  ].sort()

  for (const variant of variants) {
    if (variant && typeof variant === 'string') {
      const dotPath = extractDotPath(variant)

      if (!dotPath || dotPath === '.' || dotPath === './') {
        continue
      }

      const targetPath = path.join(root, dotPath)
      const packageJsonPath = path.join(targetPath, 'package.json')

      if (await fileExists(packageJsonPath)) {
        return await readJsonFile(packageJsonPath)
      }
    }

    if (!packageJson.hasOwnProperty('_requiredBy')) {

    }
  }

  return null
}

async function searchForContainerContent(resolver, {
  root,
  packageJson,
  remote,
  cache,
  registry,
  reporting,
  packageJsonCache,
}) {
  const variants = [
    packageJson.main,
    packageJson.module,
    packageJson.types,
    packageJson.typings,
    packageJson.esnext,
    packageJson.es2015,
  ].sort()

  for (const variant of variants) {
    if (variant && typeof variant === 'string') {
      const dotPath = extractDotPath(variant)

      if (!dotPath || dotPath === '.' || dotPath === './') {
        continue
      }

      const targetPath = path.join(root, dotPath)
      const packageJsonPath = path.join(targetPath, 'package.json')

      if (await fileExists(packageJsonPath)) {
        const parentPackageJson = await readJsonFile(packageJsonPath)
        const id = `${parentPackageJson.name}@${parentPackageJson.version}`

        return await resolver({
          id,
          root: targetPath,
          packageJson: parentPackageJson,
          repositoryUrl: resolveRepositoryUrl(packageJson) ?? resolveRepositoryUrl(parentPackageJson),
          repositoryDirectory: packageJson.repository?.directory ?? parentPackageJson.repository?.directory ?? '',
          urlTemplate: remote,
          cache,
          registry,
          reporting,
          packageJsonCache,
          licenseList: resolveLicenseList(packageJson) ?? resolveLicenseList(parentPackageJson),
        })
      }
    }
  }

  return ''
}

function resolveLicenseList(packageJson) {
  const { license, licenses } = packageJson
  const resolvedList = !licenses ? [] : licenses.map(mapLicenseDefinitionToType)

  if (license) {
    resolvedList.push(license) // @todo: Maybe parse license?
  }

  return resolvedList
}

function mapLicenseDefinitionToType(licenseDefinition) {
  return licenseDefinition.type
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

function resolveParameters({
  out,
  dir,
  cacheDir,
  remote,
  registry,
  append,
  prepend,
  ignorePackages,
  ignorePaths,
  json,
  csv,
  txt,
  reporting,
  forceFresh,
}) {
  return {
    out,
    dir: dir ?? process.cwd(),
    cacheDir,
    remote,
    registry,
    append,
    prepend,
    ignorePackages,
    ignorePaths,
    json,
    csv,
    txt,
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
 * @param packageJson
 * @returns {Promise<string>}
 */
async function resolveLicenseTextUsingReadme(readme, { packageJson }) {
  const licenseText = readme
    ?.split(readmeLicenseStartRegex)[1]
    ?.split(readmeLicenseEndRegex)[0]
    ?.trim()

  if (!licenseText) {
    return ''
  }

  const author = typeof packageJson.author === 'object' ? packageJson.author.name : packageJson.author

  if (isPossiblyAnApache2_0Copyright(licenseText)) {
    return {
      assembled: true,
      text: trim(replacePlaceholdersWithValues(await readFile(licenseTemplatePaths.APACHE_2_0), {
        copyright: licenseText,
        packageName: packageJson.name,
        version: packageJson.version,
        author,
      }), '\n')
    }
  }

  if (isPossiblyAnISCCopyright(licenseText)) {
    return {
      assembled: true,
      text: trim(replacePlaceholdersWithValues(await readFile(licenseTemplatePaths.ISC), {
        copyright: licenseText,
        packageName: packageJson.name,
        version: packageJson.version,
        author,
      }), '\n')
    }
  }

  if (isPossiblyAnMITCopyright(licenseText)) {
    return {
      assembled: true,
      text: trim(replacePlaceholdersWithValues(await readFile(licenseTemplatePaths.MIT), {
        copyright: licenseText,
        packageName: packageJson.name,
        version: packageJson.version,
        author,
      }), '\n')
    }
  }

  if (isPossiblyAnMIT0Copyright(licenseText)) {
    return {
      assembled: true,
      text: trim(replacePlaceholdersWithValues(await readFile(licenseTemplatePaths.MIT_0), {
        copyright: licenseText,
        packageName: packageJson.name,
        version: packageJson.version,
        author,
      }), '\n')
    }
  }

  return licenseText
}

function isPossiblyAnMITCopyright(text) {
  return text.toUpperCase().includes('MIT')
    && text.length < MIT_LICENSE_APPROX_LENGTH_WITHOUT_COPYRIGHT
}

function isPossiblyAnMIT0Copyright(text) {
  return (text.toUpperCase().includes('MIT-0') || text.toUpperCase().includes('MIT NO ATTRIBUTION'))
    && text.length < MIT_0_LICENSE_APPROX_LENGTH_WITHOUT_COPYRIGHT
}

function isPossiblyAnISCCopyright(text) {
  return text.toUpperCase().includes('ISC')
    && text.length < ISC_LICENSE_APPROX_LENGTH_WITHOUT_COPYRIGHT
}

function isPossiblyAnApache2_0Copyright(text) {
  return (text.toUpperCase().includes('APACHE 2.0')
    || text.toUpperCase().includes('APACHE-2.0')
    || text.toUpperCase().includes('APACHE_2.0'))
    && text.length < APACHE_2_0_LICENSE_APPROX_LENGTH_WITHOUT_COPYRIGHT
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

function generateJoinedLicenseText(templates, holder, year, packageJson) {
  return templates.map(template => replacePlaceholdersWithValues(template, {
    copyright: `Copyright (c) ${year} ${holder}`,
    year,
    packageName: packageJson.name,
    version: packageJson.version,
    author: holder,
  })).join('\n\n\n')
}

exports.execute = execute
