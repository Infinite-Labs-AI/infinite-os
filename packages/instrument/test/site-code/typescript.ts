// TypeScript for the managed Next module's tests (test helper only; the published package never imports
// it, and `src/` stays free of external imports — `package-shape.test.ts`).
//
// The managed module is TypeScript that lands in a CUSTOMER'S project, so its tests compile it the way
// that project would: a strict type check against the DOM lib, then a transpile to run it.
import ts from "typescript"

/** Strict type errors of one module, checked against ES2020 + DOM like a browser app (no @types). */
export function strictTypeErrors(source: string, fileName = "infinite-analytics.ts"): string[] {
  const options: ts.CompilerOptions = {
    strict: true,
    noEmit: true,
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.ESNext,
    lib: ["lib.es2020.d.ts", "lib.dom.d.ts"],
    types: []
  }
  const host = ts.createCompilerHost(options)
  const readFile = host.readFile.bind(host)
  const getSourceFile = host.getSourceFile.bind(host)
  host.readFile = (name) => (name === fileName ? source : readFile(name))
  host.fileExists = ((exists) => (name: string) => name === fileName || exists(name))(host.fileExists.bind(host))
  host.getSourceFile = (name, languageVersion, onError, shouldCreate) =>
    name === fileName
      ? ts.createSourceFile(name, source, languageVersion, true)
      : getSourceFile(name, languageVersion, onError, shouldCreate)
  const program = ts.createProgram([fileName], options, host)
  return ts
    .getPreEmitDiagnostics(program)
    .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))
}

/** The module as CommonJS JavaScript (types stripped), to run in a vm. */
export function transpileToCommonJs(source: string): string {
  return ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
  }).outputText
}

/**
 * A package source file as `tsc -p tsconfig.build.json` emits it (the repo's ES2022 target, types erased),
 * in CommonJS so a test can load it: the bytes `Function.prototype.toString()` serialises for customers.
 */
export function transpileLikeBuild(source: string): string {
  return ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
}
