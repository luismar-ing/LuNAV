import { SyntheticBanner } from "../components/SyntheticBanner";
import { STRINGS } from "../lib/strings";
import { useApp } from "../store/appStore";
import { Tray } from "../panels2d/Tray";

/**
 * "Search and compare" panel of the Mission Planner (spec 8.0, reduced by decision A9): only the comparison tray of
 * the pinned plans. The arrival date, stay and site are chosen in the sidebar and on the Moon map; the site's own
 * panel opens from the site view ("Site details and sources").
 */
export function CompareView() {
  const manifest = useApp((s) => s.manifest);
  const energyModel = useApp((s) => s.energyModel);
  const setEnergyModel = useApp((s) => s.setEnergyModel);
  if (!manifest) return null;

  return (
    <>
      <SyntheticBanner manifest={manifest} />
      <section className="panel tray-area" aria-labelledby="tray-title">
        <div className="tray-head">
          <h2 id="tray-title" className="panel-title">
            {STRINGS.trayTitle}
          </h2>
          {/* T6.4.b: the illustrative battery lane under every time ribbon, on or off */}
          <button type="button" className="btn ghost" aria-pressed={energyModel} title={STRINGS.energy.title} onClick={() => setEnergyModel(!energyModel)}>
            <span aria-hidden="true">{energyModel ? "■" : "□"}</span> {STRINGS.energy.toggle}
          </button>
        </div>
        <Tray />
      </section>
    </>
  );
}
