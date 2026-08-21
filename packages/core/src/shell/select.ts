export * as ShellSelect from "./select.js"

import path from "path"
import { readFile } from "fs/promises"
import { statSync } from "fs"
import { Context, Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "@opencode-ai/util/effect/app-node"
import { FSUtil } from "@opencode-ai/util/fs-util"
import { Global } from "@opencode-ai/util/global"
import { State } from "../state.js"
import { which } from "../util/which.js"

const META: Record<string, { login?: boolean; ps?: boolean }> = {
  bash: { login: true },
  dash: { login: true },
  fish: { login: true },
  ksh: { login: true },
  powershell: { ps: true },
  pwsh: { ps: true },
  sh: { login: true },
  zsh: { login: true },
}

// Generated command syntax and permission scanning do not currently support these shell dialects.
const UNCONVENTIONAL = new Set(["fish", "nu"])

export type Item = {
  path: string
  name: string
  acceptable: boolean
}

export const Options = Schema.Struct({
  gitbash: Schema.optional(Schema.String),
})
export type Options = typeof Options.Type

type Data = {
  shell?: string
}

export type Draft = {
  configure: (shell: string) => void
}

export interface Interface extends State.Transformable<Draft> {
  readonly preferred: () => Effect.Effect<string>
  readonly conventional: () => Effect.Effect<string>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ShellSelect") {}

function stat(file: string) {
  return statSync(file, { throwIfNoEntry: false }) ?? undefined
}

function findExecutable(name: string, bin?: string) {
  return which(name, undefined, bin)
}

function full(file: string, options?: Options, bin?: string) {
  if (process.platform !== "win32") return file
  const shell = FSUtil.windowsPath(file)
  if (path.win32.dirname(shell) !== ".") {
    if (shell.startsWith("/") && name(shell) === "bash") return gitbash(options, bin) || shell
    return shell
  }
  if (name(shell) === "bash") return gitbash(options, bin) || findExecutable(shell, bin) || shell
  return findExecutable(shell, bin) || shell
}

function meta(file: string) {
  return META[name(file)]
}

function isConventional(file: string) {
  return !UNCONVENTIONAL.has(name(file))
}

function rooted(file: string) {
  return path.isAbsolute(FSUtil.windowsPath(file))
}

function resolve(file: string, options?: Options, bin?: string) {
  const shell = full(file, options, bin)
  if (rooted(shell)) {
    if (stat(shell)?.isFile()) return shell
    return
  }
  return findExecutable(shell, bin) ?? undefined
}

function win(options?: Options, bin?: string) {
  return Array.from(
    new Set(
      [
        findExecutable("pwsh", bin),
        findExecutable("powershell", bin),
        gitbash(options, bin),
        process.env.COMSPEC || "cmd.exe",
      ]
        .filter((item): item is string => Boolean(item))
        .map((file) => full(file, options, bin)),
    ),
  )
}

async function unix() {
  const text = await readFile("/etc/shells", "utf8").catch(() => "")
  if (text) return Array.from(new Set(text.split("\n").filter((line) => line.trim() && !line.startsWith("#"))))
  return ["/bin/bash", "/bin/zsh", "/bin/sh"]
}

function select(file: string | undefined, options?: Options, opts?: { conventional?: boolean }, bin?: string) {
  if (file && (!opts?.conventional || isConventional(file))) {
    const shell = resolve(file, options, bin)
    if (shell) return shell
  }
  if (process.platform === "win32") return win(options, bin)[0]
  return fallback(bin)
}

export function gitbash(options?: Options, bin?: string) {
  if (process.platform !== "win32") return
  if (options?.gitbash) return options.gitbash
  const git = findExecutable("git", bin)
  if (!git) return
  const file = path.join(git, "..", "..", "bin", "bash.exe")
  if (stat(file)?.size) return file
}

function fallback(bin?: string) {
  if (process.platform === "darwin") return "/bin/zsh"
  const bash = findExecutable("bash", bin)
  if (bash) return bash
  return "/bin/sh"
}

export function name(file: string) {
  if (process.platform === "win32") return path.win32.parse(FSUtil.windowsPath(file)).name.toLowerCase()
  return path.basename(file).toLowerCase()
}

export function login(file: string) {
  return meta(file)?.login === true
}

export function ps(file: string) {
  return meta(file)?.ps === true
}

function info(file: string, options?: Options, bin?: string): Item {
  const item = full(file, options, bin)
  const n = name(item)
  return {
    path: item,
    name: resolve(n, options, bin) ? n : item,
    acceptable: isConventional(item),
  }
}

export function args(file: string, command: string) {
  const n = name(file)
  if (n === "nu" || n === "fish") return ["-c", command]
  if (n === "zsh" || n === "bash") return ["-c", command]
  if (n === "cmd") return ["/c", command]
  if (ps(file)) return ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command]
  return ["-c", command]
}

let defaultPreferred: { bin?: string; value: string } | undefined
let defaultConventional: { bin?: string; value: string } | undefined

export function preferred(configShell?: string, options?: Options, bin?: string) {
  if (configShell) return select(configShell, options, undefined, bin)
  if (options?.gitbash) return select(process.env.SHELL, options, undefined, bin)
  const cached = defaultPreferred
  if (cached && cached.bin === bin) return cached.value
  const value = select(process.env.SHELL, undefined, undefined, bin) ?? fallback(bin)
  defaultPreferred = { bin, value }
  return value
}
preferred.reset = () => {
  defaultPreferred = undefined
}

export function conventional(configShell?: string, options?: Options, bin?: string) {
  if (configShell) return select(configShell, options, { conventional: true }, bin)
  if (options?.gitbash) return select(process.env.SHELL, options, { conventional: true }, bin)
  const cached = defaultConventional
  if (cached && cached.bin === bin) return cached.value
  const value = select(process.env.SHELL, undefined, { conventional: true }, bin) ?? fallback(bin)
  defaultConventional = { bin, value }
  return value
}
conventional.reset = () => {
  defaultConventional = undefined
}

/** @deprecated Use `conventional` instead. */
export const acceptable = conventional

export async function list(options?: Options, bin?: string): Promise<Item[]> {
  const shells = process.platform === "win32" ? win(options, bin) : await unix()
  return shells.filter((shell) => resolve(shell, options, bin)).map((shell) => info(shell, options, bin))
}

const layer = (options?: Options) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const global = yield* Global.Service
      const state = State.create<Data, Draft>({
        name: "shell-select",
        initial: () => ({}),
        draft: (draft) => ({
          configure: (shell) => {
            draft.shell = shell
          },
        }),
      })
      return Service.of({
        transform: state.transform,
        reload: state.reload,
        preferred: () => Effect.sync(() => preferred(state.get().shell, options, global.bin)),
        conventional: () => Effect.sync(() => conventional(state.get().shell, options, global.bin)),
      })
    }),
  )

export function configured(options?: Options) {
  return makeLocationNode({ service: Service, layer: layer(options), deps: [Global.node] })
}

export const node = configured()
