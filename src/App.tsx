import Header from "./components/Header";
import RidgelineStage from "./components/RidgelineStage";

// EXPERIMENT (branch experiment/ridgeline-mono): the homepage is temporarily the
// monochrome ridgeline study instead of the warm-dusk road journey. Swap
// RidgelineStage back to RoadStage to restore the production scene.
export default function App() {
  return (
    <>
      <Header />
      <RidgelineStage />
    </>
  );
}
