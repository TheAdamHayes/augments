import { MODULE_ID, AUGMENT_PROPERTY, escapeHTML as esc } from "./core.js";

const DEFAULT_IMG = "icons/svg/biohazard.svg";

/**
 * Columns: Module | Rarity | Physical Description | Effect | Unlock Mechanism
 * Accepts tab-separated rows (pasted from Excel / Google Sheets) or markdown-style pipe tables.
 */
export function parseRows(text) {
  const rows = [];
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    let cells = line.includes("\t") ? line.split("\t") : line.split("|");
    cells = cells.map(c => c.trim().replace(/^"(.*)"$/s, "$1").trim());
    if (!line.includes("\t")) cells = cells.filter((c, i, arr) => !(c === "" && (i === 0 || i === arr.length - 1)));
    if (cells.every(c => /^:?-{2,}:?$/.test(c) || c === "")) continue; // markdown separator row
    if (cells[0]?.toLowerCase() === "module") continue; // header row
    const [name, tier = "", physical = "", effect = "", unlock = ""] = cells;
    if (name) rows.push({ name, tier, physical, effect, unlock });
  }
  return rows;
}

function describe(row) {
  const parts = [];
  if (row.physical) parts.push(`<p><em>${esc(row.physical)}</em></p>`);
  if (row.effect) parts.push(`<p><strong>Effect.</strong> ${esc(row.effect)}</p>`);
  const meta = [];
  if (row.tier) meta.push(`<strong>Tier:</strong> ${esc(row.tier)}`);
  if (row.unlock) meta.push(`<strong>Unlock:</strong> ${esc(row.unlock)}`);
  if (meta.length) parts.push(`<p>${meta.join("<br>")}</p>`);
  return parts.join("");
}

export async function importAugments(text, { folderName = "Augments", itemType = "equipment", updateExisting = true } = {}) {
  if (!game.user.isGM) return ui.notifications.warn("Only the GM can import augments.");
  const rows = parseRows(text);
  if (!rows.length) return ui.notifications.warn("No rows found. Paste rows with the module name in the first column.");

  let folder = game.folders.find(f => f.type === "Item" && f.name === folderName);
  folder ??= await Folder.create({ name: folderName, type: "Item", color: "#4a2a2a" });

  const existing = new Map(game.items.filter(i => i.folder?.id === folder.id).map(i => [i.name, i]));
  const toCreate = [];
  const toUpdate = [];

  for (const row of rows) {
    const flags = { [MODULE_ID]: { tier: row.tier, physical: row.physical, effect: row.effect, unlock: row.unlock } };
    const description = describe(row);
    const found = existing.get(row.name);
    if (found) {
      // Only text and tier are refreshed, so any activities, uses or effects you've added are kept.
      if (updateExisting) toUpdate.push({ _id: found.id, "system.description.value": description, flags });
      continue;
    }
    const system = { description: { value: description }, properties: [AUGMENT_PROPERTY] };
    if (itemType === "equipment") Object.assign(system, { type: { value: "trinket" }, equipped: false });
    toCreate.push({ name: row.name, type: itemType, img: DEFAULT_IMG, folder: folder.id, system, flags });
  }

  if (toCreate.length) await Item.createDocuments(toCreate);
  if (toUpdate.length) await Item.updateDocuments(toUpdate);
  ui.notifications.info(`Augments: created ${toCreate.length}, updated ${toUpdate.length} in the "${folder.name}" folder.`);
}

export async function openImporter() {
  if (!game.user.isGM) return ui.notifications.warn("Only the GM can import augments.");
  const content = `
    <p>Paste rows from your augment table. Columns: Module, Rarity, Physical Description, Effect, Unlock Mechanism.
    A header row is skipped automatically.</p>
    <textarea name="table" rows="14" style="width:100%;font-family:monospace;font-size:12px"></textarea>
    <div class="form-group"><label>Folder</label><input type="text" name="folder" value="Augments"></div>
    <div class="form-group"><label>Item type</label>
      <select name="itemType">
        <option value="equipment" selected>Equipment (Trinket), recommended</option>
        <option value="loot">Loot</option>
      </select></div>
    <div class="form-group"><label>Update augments that already exist</label>
      <input type="checkbox" name="update" checked></div>`;

  const DialogV2 = foundry.applications?.api?.DialogV2;
  let result;
  if (DialogV2) {
    result = await DialogV2.prompt({
      window: { title: "Import augments", resizable: true },
      position: { width: 640 },
      content,
      rejectClose: false,
      ok: {
        label: "Import", icon: "fas fa-file-import",
        callback: (event, button) => {
          const f = button.form.elements;
          return { text: f.table.value, folder: f.folder.value, itemType: f.itemType.value, update: f.update.checked };
        }
      }
    });
  } else {
    result = await Dialog.prompt({
      title: "Import augments", content, rejectClose: false,
      callback: html => {
        const form = (html[0] ?? html).querySelector("form") ?? (html[0] ?? html);
        const q = n => form.querySelector(`[name="${n}"]`);
        return { text: q("table").value, folder: q("folder").value, itemType: q("itemType").value, update: q("update").checked };
      }
    });
  }
  if (!result?.text) return;
  return importAugments(result.text, {
    folderName: result.folder?.trim() || "Augments", itemType: result.itemType, updateExisting: result.update
  });
}
