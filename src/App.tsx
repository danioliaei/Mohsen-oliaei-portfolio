import { lazy, Suspense } from "react";
import Header from "./components/Header";

/* Code-split the WebGPU hero off the first-paint critical path: the renderer pulls in
   ridgeline.ts, all the WGSL, the filament-geometry builder and `motion`, so eagerly
   importing it put the whole scene in the initial bundle. Lazy-loading it lets the HTML +
   Header (the wordmark/nav) paint immediately while the renderer chunk streams in — the
   real "better phone loading" win (it removes bytes from the critical path rather than
   adding a baked asset to it; see HYBRID.md). The fallback is a bare black stage so there
   is no flash before the canvas mounts (the page is black either way). */
const RidgelineStage = lazy(() => import("./components/RidgelineStage"));

export default function App() {
  return (
    <>
      <Header />
      <Suspense fallback={<div className="ridge-stage" aria-hidden="true" />}>
        <RidgelineStage />
      </Suspense>
    </>
  );
}
