#!/usr/bin/env node

import * as fs from "fs"
import * as json from "@ts-common/json"
import * as jsonParser from "@ts-common/json-parser"
import * as path from "path"
import * as it from "@ts-common/iterator"
import * as sm from "@ts-common/string-map"
import * as semver from "semver"
import * as cp from "child_process"
import * as process from "process"

const nodeModules = "node_modules"

interface Dependencies {
  readonly [name: string]: string|undefined
}

interface PackageJson {
  readonly name: string
  readonly version: string
  readonly dependencies?: Dependencies
  readonly devDependencies?: Dependencies
}

const allDependencies = (p: PackageJson): Dependencies => ({
  ...p.dependencies,
  ...p.devDependencies
})

const readPackageJson = (file: string): PackageJson =>
  jsonParser.parse(file, fs.readFileSync(file).toString()) as PackageJson

interface VersionLocation {
  readonly version: string
  readonly location: string
  readonly dependencies: Dependencies
}

const packages = (p: string): Iterable<sm.Entry<VersionLocation>> =>
  fs.existsSync(p) ?
    it.flatMap(
      fs.readdirSync(p, { withFileTypes: true }),
      d => {
        if (!d.isDirectory()) {
          return []
        }
        const dir = path.join(p, d.name)
        const pj = path.join(dir, "package.json")
        if (fs.existsSync(pj)) {
          const j = readPackageJson(pj)
          return [sm.entry(
            j.name,
            {
              version: j.version,
              location: dir,
              dependencies: j.dependencies || {}
            }
          )]
        }
        return packages(dir)
      }
    ) :
    []

const reportInfo = (info: string) => console.log(`info: ${info}`)

const exec = (title: string, cmd: string, options?: cp.SpawnOptions): string => {
  reportInfo(title)
  const result = cp.spawnSync(cmd, { ...options, shell: true, stdio: "pipe" })
  console.error(result.stderr.toString())
  return result.stdout.toString()
}

const main = (): number => {
  const current = path.resolve(".")

  const packageJson = readPackageJson(path.join(current, "package.json"))

  let dependencies = allDependencies(packageJson)

  if (dependencies === undefined || !json.isObject(dependencies)) {
    return 0
  }

  const localPackages = sm.stringMap(packages(path.join(current, "..", "..")))

  const errors: string[] = []

  const reportError = (error: string) => {
    errors.push(error)
    console.error(`error : ${error}`)
  }

  const p = sm.stringMap(packages(path.join(current, nodeModules)))

  const packagesToInstall: string[] = []

  const bindDependencies = (d: Dependencies): Dependencies => {
    let additionalDependencies: Dependencies = {}
    for (const [name, version] of sm.entries(d)) {
      const versionLocation = p[name]
      if (versionLocation === undefined || !semver.satisfies(versionLocation.version, version)) {
        const nameVersion = `${name}@${version}`
        const npmView = `npm view ${name} versions --json`
        const versions = jsonParser.parse(
          npmView,
          exec(`searching for ${nameVersion}...`, npmView)
        ) as ReadonlyArray<string>
        if (versions.find(v => semver.satisfies(v, version)) !== undefined) {
          packagesToInstall.push(nameVersion)
        } else {
          const local = localPackages[name]
          if (local === undefined || !semver.satisfies(local.version, version)) {
            reportError(`${nameVersion} is not found`)
          } else {
            const tgz = `${name.replace("@", "").replace("/", "-")}-${local.version}.tgz`
            const pathTgz = path.join(local.location, tgz)
            if (!fs.existsSync(pathTgz)) {
              exec(
                `packing ${nameVersion} from ${local.location} ...`,
                `npm pack`,
                { cwd: local.location }
              )
            }
            packagesToInstall.push(pathTgz)
            additionalDependencies = { ...additionalDependencies, ...local.dependencies }
          }
        }
      }
    }
    return additionalDependencies
  }

  while (Object.entries(dependencies).length > 0) {
    dependencies = bindDependencies(dependencies)
  }

  if (errors.length === 0 && packagesToInstall.length > 0) {
    reportInfo("packages:")
    for (const i of packagesToInstall) {
      reportInfo(`  ${i}`)
    }
    const list = packagesToInstall.join(" ")
    exec(
      `saving packages to package-lock.json ...`,
      `npm install ${list} --no-save --package-lock-only`
    )
    /*
    exec(
      `installing all packages...`,
      "npm ci"
    )
    */
  }

  return errors.length === 0 ? 0 : 1
}

process.exit(main())
