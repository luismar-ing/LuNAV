import { fmtDay } from "./MissionSidebar";
import { fmtDuration } from "../lib/moonMap";
import { STRINGS } from "../lib/strings";
import type { Plan } from "../lib/contract";
import type { MissionPhase } from "../store/appStore";

/** Mission telemetry column of the journey (design B2): the plan's dates and the current phase, in mono. */
export function Telemetry({ plan, phase, scale }: { plan: Plan; phase: MissionPhase; scale: string }) {
  const rows: [string, string][] = [
    [STRINGS.telemetry.launch, fmtDay(plan.launch_utc)],
    [STRINGS.telemetry.arrival, fmtDay(plan.arrival_utc)],
    [STRINGS.telemetry.stay, STRINGS.planner.days(plan.window_days)],
    [STRINGS.telemetry.transit, fmtDuration(plan.transit_days * 24)], // A15: 3 d 6 h (noon launch, 00:00 UTC arrival)
    [STRINGS.telemetry.phase, STRINGS.mission.phases[phase === "overview" ? "launch" : phase]],
    [STRINGS.telemetry.scale, scale],
  ];
  return (
    <dl className="telemetry" data-testid="telemetry">
      {rows.map(([k, v]) => (
        <div key={k} className="telemetry-row">
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}
