import { builtinModules, createRequire } from "node:module"
import {
    existsSync,
    readFileSync,
    statSync,
    mkdtempSync,
    mkdirSync,
    writeFileSync,
    symlinkSync,
    rmSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { execFileSync } from "node:child_process"
import path from "node:path"
import process from "node:process"
import { fileURLToPath, pathToFileURL } from "node:url"
import ts from "typescript"

const require = createRequire(import.meta.url)
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

const builtinNames = new Set([
    ...builtinModules,
    ...builtinModules.map((name) => name.replace(/^node:/, "")),
])

const requiredRepoFiles = [
    "dist/lib/v2/rpc.js",
    "dist/lib/v2/rpc.d.ts",
    "docs/compatibility.md",
    "dist/index.js",
    "dist/index.d.ts",
    "dist/tui.d.ts",
    "tui.tsx",
    "README.md",
    "LICENSE",
]

const requiredTarballFiles = [
    "dist/lib/v2/rpc.js",
    "dist/lib/v2/rpc.d.ts",
    "docs/compatibility.md",
    "package.json",
    "dist/index.js",
    "dist/index.d.ts",
    "dist/tui.d.ts",
    "tui.tsx",
    "README.md",
    "LICENSE",
]

const forbiddenTarballPatterns = [
    /^node_modules\//,
    /^index\.ts$/,
    /^tests\//,
    /^scripts\//,
    /^docs\/(?!compatibility\.md$)/,
    /^assets\//,
    /^notes\//,
    /^\.github\//,
    /^package-lock\.json$/,
    /^tsconfig\.json$/,
]

const packageInfoCache = new Map()

function fail(message) {
    console.error(`package verification failed: ${message}`)
    process.exit(1)
}

function assertRepoFilesExist() {
    for (const relativePath of requiredRepoFiles) {
        if (!existsSync(path.join(root, relativePath))) {
            fail(`missing required file: ${relativePath}`)
        }
    }
}

function assertPackageJsonShape() {
    const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"))

    if (pkg.main !== "./dist/index.js") {
        fail(`package.json main must remain ./dist/index.js, found ${pkg.main ?? "<missing>"}`)
    }

    if (pkg.exports?.["."]?.import !== "./dist/index.js") {
        fail("expected package.json exports['.'].import to be './dist/index.js'")
    }

    if (pkg.exports?.["./server"]?.import !== "./dist/index.js") {
        fail("expected package.json exports['./server'].import to be './dist/index.js'")
    }

    if (pkg.exports?.["./tui"]?.import !== "./tui.tsx") {
        fail("expected package.json exports['./tui'].import to be './tui.tsx'")
    }

    const files = Array.isArray(pkg.files) ? pkg.files : []
    for (const entry of [
        "dist/",
        "lib/",
        "tui.tsx",
        "docs/compatibility.md",
        "README.md",
        "LICENSE",
    ]) {
        if (!files.includes(entry)) {
            fail(`package.json files must include ${entry}`)
        }
    }
}

function getImportStatements(source) {
    const pattern = /^\s*import\s+([^\n;]+?)\s+from\s+["']([^"']+)["']/gm
    return Array.from(source.matchAll(pattern), (match) => ({
        clause: match[1].trim(),
        specifier: match[2],
    }))
}

function emittedImports(filePath) {
    const source = ts.createSourceFile(
        filePath,
        readFileSync(filePath, "utf8"),
        ts.ScriptTarget.Latest,
        true,
    )
    const imports = []
    const visit = (node) => {
        if (
            (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
            node.moduleSpecifier &&
            ts.isStringLiteral(node.moduleSpecifier)
        ) {
            imports.push({ specifier: node.moduleSpecifier.text, dynamic: false })
        }
        if (
            ts.isCallExpression(node) &&
            node.expression.kind === ts.SyntaxKind.ImportKeyword &&
            node.arguments.length === 1 &&
            ts.isStringLiteral(node.arguments[0])
        ) {
            imports.push({ specifier: node.arguments[0].text, dynamic: true })
        }
        ts.forEachChild(node, visit)
    }
    visit(source)
    return imports
}

function assertEmittedHostIsolation() {
    const entry = path.join(root, "dist/index.js")
    const lazy = emittedImports(entry).filter((item) => item.dynamic)
    if (lazy.length !== 2) fail("dual server facade must retain two lazy host imports")
    const visit = (file, forbidden, includeDynamic, seen = new Set()) => {
        if (seen.has(file)) return
        seen.add(file)
        for (const item of emittedImports(file)) {
            if (item.dynamic && !includeDynamic) continue
            if (forbidden(item.specifier))
                fail(`host graph imports incompatible dependency: ${item.specifier}`)
            if (item.specifier.startsWith(".")) {
                const target = path.resolve(path.dirname(file), item.specifier)
                if (!existsSync(target)) fail(`emitted host chunk missing: ${target}`)
                visit(target, forbidden, includeDynamic, seen)
            }
        }
    }
    visit(entry, () => true, false)
    const v2 = lazy.find((item) => /\/server-(?!v1-)[^/]+\.js$/.test(item.specifier))
    const v1 = lazy.find((item) => /\/server-v1-[^/]+\.js$/.test(item.specifier))
    if (!v1 || !v2) fail("missing independently emitted V1/V2 chunks")
    visit(
        path.resolve(path.dirname(entry), v2.specifier),
        (name) =>
            name.startsWith("@opencode-ai/") || name.startsWith("@opentui/") || name === "solid-js",
        true,
    )
    visit(
        path.resolve(path.dirname(entry), v1.specifier),
        (name) => name.startsWith("@opencode/"),
        true,
    )
}

async function assertEntrypointShapes() {
    const { default: definition } = await import(
        pathToFileURL(path.join(root, "dist/index.js")).href
    )
    if (
        definition.id !== "opencode-dcp" ||
        typeof definition.server !== "function" ||
        typeof definition.setup !== "function"
    ) {
        fail("default export must support both server() and setup()")
    }
    const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"))
    if (pkg.exports?.["./rpc"]?.import !== "./dist/lib/v2/rpc.js")
        fail("incorrect ./rpc export path")
    const { DcpRpc } = await import(pathToFileURL(path.join(root, "dist/lib/v2/rpc.js")).href)
    if (
        DcpRpc.id !== "opencode-dcp" ||
        !DcpRpc.methods.status ||
        !DcpRpc.methods.command ||
        !DcpRpc.events.notify
    ) {
        fail("portable RPC contract is incomplete")
    }
}

function getImportKind(clause) {
    if (clause.startsWith("type ")) return "type"
    if (clause.startsWith("* as ")) return "namespace"
    if (clause.startsWith("{")) return "named"
    if (clause.includes(",")) {
        const [, trailing = ""] = clause.split(",", 2)
        return trailing.trim().startsWith("* as ") ? "default+namespace" : "default+named"
    }
    return "default"
}

function getPackageName(specifier) {
    if (specifier.startsWith("@")) {
        const parts = specifier.split("/")
        return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : specifier
    }
    return specifier.split("/")[0]
}

function resolveLocalImport(importerPath, specifier) {
    const basePath = path.resolve(path.dirname(importerPath), specifier)
    const candidates = [
        basePath,
        `${basePath}.ts`,
        `${basePath}.tsx`,
        `${basePath}.js`,
        `${basePath}.mjs`,
        path.join(basePath, "index.ts"),
        path.join(basePath, "index.tsx"),
        path.join(basePath, "index.js"),
        path.join(basePath, "index.mjs"),
    ]

    for (const candidate of candidates) {
        if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
    }

    fail(`unable to resolve local import ${specifier} from ${path.relative(root, importerPath)}`)
}

function findPackageInfo(packageName, importerPath) {
    const cacheKey = `${packageName}::${path.dirname(importerPath)}`
    if (packageInfoCache.has(cacheKey)) {
        return packageInfoCache.get(cacheKey)
    }

    let entry
    try {
        entry = require.resolve(packageName, { paths: [path.dirname(importerPath)] })
    } catch {
        packageInfoCache.set(cacheKey, null)
        return null
    }

    let current = path.dirname(entry)
    while (true) {
        const manifest = path.join(current, "package.json")
        if (existsSync(manifest)) {
            const info = JSON.parse(readFileSync(manifest, "utf8"))
            packageInfoCache.set(cacheKey, info)
            return info
        }
        const parent = path.dirname(current)
        if (parent === current) {
            packageInfoCache.set(cacheKey, null)
            return null
        }
        current = parent
    }
}

function packageLooksCommonJs(pkg) {
    if (!pkg) return false
    if (pkg.type === "commonjs") return true

    const main = typeof pkg.main === "string" ? pkg.main : ""
    return /(?:^|\/)(cjs|umd)(?:\/|$)/.test(main) || main.endsWith(".cjs")
}

function validateRuntimeImportGraph() {
    const pending = [path.join(root, "index.ts"), path.join(root, "tui.tsx")]
    const seen = new Set()

    while (pending.length > 0) {
        const filePath = pending.pop()
        if (!filePath || seen.has(filePath)) continue
        seen.add(filePath)

        const source = readFileSync(filePath, "utf8")
        for (const entry of getImportStatements(source)) {
            if (entry.specifier.startsWith(".")) {
                pending.push(resolveLocalImport(filePath, entry.specifier))
                continue
            }

            if (entry.specifier === "jsonc-parser/lib/esm/main.js") {
                continue
            }

            const packageName = getPackageName(entry.specifier)
            if (builtinNames.has(packageName)) continue

            const kind = getImportKind(entry.clause)
            if (kind === "type" || kind === "namespace") continue

            const pkg = findPackageInfo(packageName, filePath)
            if (packageLooksCommonJs(pkg)) {
                fail(
                    `${path.relative(root, filePath)} uses ${kind} import from CommonJS-style package ${packageName}`,
                )
            }
        }
    }
}

function validatePackedFiles() {
    const output = execFileSync("npm", ["pack", "--dry-run", "--json"], {
        cwd: root,
        encoding: "utf8",
    })

    const [result] = JSON.parse(output)
    if (!result || !Array.isArray(result.files)) {
        fail("npm pack --dry-run --json did not return file metadata")
    }

    const packedPaths = result.files.map((file) => file.path)
    for (const required of requiredTarballFiles) {
        if (!packedPaths.includes(required)) {
            fail(`packed tarball is missing ${required}`)
        }
    }

    const forbidden = packedPaths.find((file) =>
        forbiddenTarballPatterns.some((pattern) => pattern.test(file)),
    )
    if (forbidden) {
        fail(`packed tarball contains forbidden path ${forbidden}`)
    }

    console.log(`package verification passed for ${result.name}@${result.version}`)
    console.log(`tarball entries: ${result.entryCount}`)
}

function smokeUnpackedPackage() {
    const temp = mkdtempSync(path.join(tmpdir(), "dcp-package-"))
    try {
        const [pack] = JSON.parse(
            execFileSync(
                "npm",
                ["pack", "--ignore-scripts", "--json", "--pack-destination", temp],
                { cwd: root, encoding: "utf8" },
            ),
        )
        execFileSync("tar", ["-xzf", path.join(temp, pack.filename), "-C", temp])
        // Reuse the installed dependency graph, but load implementation files from
        // the actual tarball. Clean consumer/host loading remains a separate test.
        symlinkSync(path.join(root, "node_modules"), path.join(temp, "package/node_modules"), "dir")
        const config = path.join(temp, "config/opencode")
        mkdirSync(config, { recursive: true })
        writeFileSync(
            path.join(config, "dcp.jsonc"),
            JSON.stringify({ enabled: true, autoUpdate: false, pruneNotification: "off" }),
        )
        const result = execFileSync(
            process.execPath,
            [
                "--import",
                "tsx",
                path.join(root, "scripts/smoke-package.mjs"),
                path.join(temp, "package"),
            ],
            {
                cwd: root,
                encoding: "utf8",
                timeout: 30000,
                env: {
                    ...process.env,
                    HOME: temp,
                    XDG_CONFIG_HOME: path.join(temp, "config"),
                    XDG_DATA_HOME: path.join(temp, "data"),
                    OPENCODE_CONFIG_DIR: "",
                    OPENCODE_SERVER_PASSWORD: "",
                    NODE_OPTIONS: "",
                },
            },
        )
        console.log(result.trim())
    } finally {
        rmSync(temp, { recursive: true, force: true })
    }
}

assertRepoFilesExist()
assertPackageJsonShape()
assertEmittedHostIsolation()
await assertEntrypointShapes()
validateRuntimeImportGraph()
validatePackedFiles()
smokeUnpackedPackage()
