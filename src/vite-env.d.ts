/// <reference types="vite/client" />
/// <reference types="@webgpu/types" />

interface ImportMetaEnv {
  /** Set to "1" at build time (VITE_PERF=1) to include the ?perf=1 telemetry
   *  harness in a production bundle; otherwise it is dead-code-eliminated. */
  readonly VITE_PERF?: string;
}
