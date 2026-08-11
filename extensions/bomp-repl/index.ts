// bomp-repl: user REPL backend switching (builtins, shells, Jupyter kernels).
// Self-contained extension directory — drag into any omp extensions dir to
// enable, drag out to disable. State lives in <agentDir>/bomp-repl.json.
// Shell/kernel backends need the patched omp build's api.registerEvalBackend;
// on a stock build they are disabled with a notice while builtins keep working.
export { default } from "./repl.ts";
