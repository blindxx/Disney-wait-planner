import type { ParkId } from "@disney-wait-planner/shared";

export default function Home() {
  const currentPark: ParkId = "DL";

  return (
    <div>
      <h1 className="title">Disney Wait Planner</h1>
      <p className="subtitle">
        Plan your perfect day at {currentPark === "DL" ? "Disneyland" : "California Adventure"}
      </p>
    </div>
  );
}
