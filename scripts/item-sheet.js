import { MODULE_ID, RARITIES, isAugment, getRarity, rarityColor, escapeHTML as esc } from "./core.js";
import { applyAutomation } from "./automation.js";
import { getRoot, confirmDialog } from "./ui.js";

/** Adds an "Augment" panel (rarity + automation) to the top of an augment's item sheet. */
export function injectItemSheet(app, html) {
  const item = app.item ?? app.document;
  if (!item || item.documentName !== "Item" || !isAugment(item)) return;
  const root = getRoot(app, html);
  if (!root) return;
  root.querySelectorAll(".augment-item-panel").forEach(el => el.remove());

  const target = root.querySelector('.tab[data-tab="description"]')
    ?? root.querySelector(".sheet-body")
    ?? root.querySelector(".window-content");
  if (!target) return;

  const editable = item.isOwner;
  const rarity = getRarity(item);
  const auto = item.flags?.[MODULE_ID]?.auto;
  const canAutomate = game.user.isGM && item.system?.activities !== undefined;

  const options = [`<option value="">None</option>`]
    .concat(Object.entries(RARITIES).map(([key, r]) => `<option value="${key}" ${key === rarity ? "selected" : ""}>${r.label}</option>`))
    .join("");

  const panel = document.createElement("div");
  panel.className = `augment-item-panel ${rarity ? `rarity-${rarity}` : ""}`;
  panel.style.setProperty("--rarity", rarityColor(item));
  panel.innerHTML = `
    <div class="augment-item-panel-row">
      <i class="fas fa-dna" inert></i>
      <label>Augment rarity
        <select class="augment-rarity-select" ${editable ? "" : "disabled"}>${options}</select>
      </label>
      ${canAutomate ? `<button type="button" class="augment-automate"><i class="fas fa-wand-magic-sparkles"></i> Build automation</button>` : ""}
    </div>
    ${auto?.summary?.length ? `<p class="augment-auto-summary"><strong>Automated:</strong> ${auto.summary.map(esc).join("; ")}</p>` : ""}`;
  target.prepend(panel);

  const select = panel.querySelector(".augment-rarity-select");
  for (const type of ["input", "change"]) select.addEventListener(type, event => event.stopPropagation());
  select.addEventListener("change", () => {
    if (select.value) item.setFlag(MODULE_ID, "rarity", select.value);
    else item.unsetFlag(MODULE_ID, "rarity");
  });

  panel.querySelector(".augment-automate")?.addEventListener("click", async event => {
    event.preventDefault();
    event.stopPropagation();
    const ok = await confirmDialog("Build automation",
      "<p>Read this augment's effect text and create uses, activities and effects from it?</p>" +
      "<p>Anything this button made before is replaced. Activities and effects you added by hand are kept.</p>");
    if (ok) await applyAutomation(item);
  });
}
