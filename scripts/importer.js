import {
  MODULE_ID, AUGMENT_PROPERTY, RARITIES, normalizeRarity, isAugment, equippedBy, addBanner,
  boldMarkdown, stripMarkdown, escapeHTML as esc
} from "./core.js";
import { analyzeEffect, automationData, applyAutomation } from "./automation.js";
import { DEFAULT_ICON, buildIconIndex, createIconPicker } from "./icons.js";

/**
 * Accepts rows pasted from a spreadsheet, a doc or a markdown table, with or without a header:
 *   Name | Rarity | Physical Description | Effect | Unlock Mechanism
 * Columns can be separated by tabs, pipes, or runs of 2+ spaces. The rarity column is found by
 * looking for a known rarity word, so a name that got split across cells is joined back up.
 */
export function parseRows(text) {
  const rows = [];
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    let cells;
    if (line.includes("\t")) cells = line.split("\t");
    else if (line.includes("|")) cells = line.split("|");
    else cells = line.split(/\s{2,}/);
    cells = cells.map(c => c.trim().replace(/^"(.*)"$/s, "$1").trim());
    while (cells.length && cells[0] === "") cells.shift();
    while (cells.length && cells[cells.length - 1] === "") cells.pop();
    if (!cells.length || cells.every(c => /^:?-{2,}:?$/.test(c))) continue;
    if (/^(module|name|augment)$/i.test(cells[0]) && /rarity|tier/i.test(cells[1] ?? "")) continue;

    const rarityIndex = cells.findIndex((c, i) => i > 0 && i < 4 && normalizeRarity(stripMarkdown(c)));
    let name, tier, physical, effect, unlock;
    if (rarityIndex > 0) {
      name = cells.slice(0, rarityIndex).join(" ");
      tier = cells[rarityIndex];
      [physical = "", effect = "", unlock = ""] = cells.slice(rarityIndex + 1);
    } else {
      [name, tier = "", physical = "", effect = "", unlock = ""] = cells;
    }
    name = stripMarkdown(name);
    tier = stripMarkdown(tier);
    if (name) rows.push({ name, rarity: normalizeRarity(tier), tierText: tier, physical, effect, unlock });
  }
  return rows;
}

function describe(row) {
  const parts = [];
  if (row.physical) parts.push(`<p><em>${boldMarkdown(row.physical)}</em></p>`);
  if (row.effect) parts.push(`<p><strong>Effect.</strong> ${boldMarkdown(row.effect)}</p>`);
  const meta = [];
  const rarityLabel = RARITIES[row.rarity]?.label ?? row.tierText;
  if (rarityLabel) meta.push(`<strong>Rarity:</strong> ${esc(rarityLabel)}`);
  if (row.unlock) meta.push(`<strong>Unlock:</strong> ${boldMarkdown(row.unlock)}`);
  if (meta.length) parts.push(`<p>${meta.join("<br>")}</p>`);
  return parts.join("");
}

const nameKey = name => String(name ?? "").trim().toLowerCase();

/**
 * Import or re-import augments, matched by name. Updates the master copy in the folder AND every
 * copy in an actor's inventory. Automation is rebuilt when the effect text changed (or if forced).
 */
export async function importAugments(text, {
  folderName = "Augments", itemType = "equipment", updateExisting = true,
  automate = true, rebuildExisting = false, autoIcons = true
} = {}) {
  if (!game.user.isGM) return ui.notifications.warn("Only the GM can import augments.");
  const rows = parseRows(text);
  if (!rows.length) return ui.notifications.warn("No rows found. Paste rows with the augment name in the first column.");

  let folder = game.folders.find(f => f.type === "Item" && f.name === folderName);
  folder ??= await Folder.create({ name: folderName, type: "Item", color: "#4a2a2a" });

  let picker = null;
  if (autoIcons) {
    ui.notifications.info("Augments: scanning icons, this takes a few seconds the first time.");
    picker = createIconPicker(await buildIconIndex());
  }

  const masters = new Map(game.items.filter(i => i.folder?.id === folder.id).map(i => [nameKey(i.name), i]));
  const copies = new Map();
  for (const actor of game.actors) {
    for (const item of actor.items) {
      if (!isAugment(item)) continue;
      const key = nameKey(item.name);
      if (!copies.has(key)) copies.set(key, []);
      copies.get(key).push(item);
    }
  }

  const toCreate = [];
  const toRebuild = [];
  let updatedMasters = 0, updatedCopies = 0, automatedCount = 0;

  for (const row of rows) {
    const key = nameKey(row.name);
    const description = describe(row);
    const master = masters.get(key);

    if (!master) {
      const img = picker ? picker.pick(row) : DEFAULT_ICON;
      const system = { description: { value: description }, properties: [AUGMENT_PROPERTY] };
      if (itemType === "equipment") Object.assign(system, { type: { value: "trinket" }, equipped: false });
      const flags = { [MODULE_ID]: { rarity: row.rarity, physical: row.physical, effect: row.effect, unlock: row.unlock } };
      const data = { name: row.name, type: itemType, img, folder: folder.id, system, flags };
      if (automate) {
        const auto = automationData(analyzeEffect(row.effect, { name: row.name, img }), itemType);
        foundry.utils.mergeObject(system, auto.system);
        data.effects = auto.effects;
        flags[MODULE_ID].auto = auto.flag;
        if (auto.flag.summary.length) automatedCount++;
      }
      toCreate.push(data);
    }

    if (!updateExisting) continue;
    for (const item of [...(master ? [master] : []), ...(copies.get(key) ?? [])]) {
      const effectChanged = (item.flags?.[MODULE_ID]?.effect ?? "") !== row.effect;
      const holder = item.parent ? equippedBy(item) : null;
      const update = {
        name: row.name,
        "system.description.value": holder ? addBanner(description, holder.name) : description,
        [`flags.${MODULE_ID}.rarity`]: row.rarity,
        [`flags.${MODULE_ID}.physical`]: row.physical,
        [`flags.${MODULE_ID}.effect`]: row.effect,
        [`flags.${MODULE_ID}.unlock`]: row.unlock
      };
      if (picker && (!item.img || item.img === DEFAULT_ICON)) update.img = picker.pick(row);
      await item.update(update);
      if (item.parent) updatedCopies++; else updatedMasters++;
      if (automate && item.system?.activities !== undefined && (effectChanged || rebuildExisting)) toRebuild.push(item);
    }
  }

  if (toCreate.length) await Item.createDocuments(toCreate, { keepEmbeddedIds: true });
  for (const item of toRebuild) await applyAutomation(item, null, { quiet: true });

  const parts = [`created ${toCreate.length} (${automatedCount} automated)`, `updated ${updatedMasters} in "${folder.name}"`];
  if (updatedCopies) parts.push(`updated ${updatedCopies} carried by characters`);
  if (toRebuild.length) parts.push(`rebuilt automation on ${toRebuild.length}`);
  ui.notifications.info(`Augments: ${parts.join(", ")}.`);
}

export async function openImporter() {
  if (!game.user.isGM) return ui.notifications.warn("Only the GM can import augments.");
  const content = `
    <p>Paste rows from your augment table: Name, Rarity, Physical Description, Effect, Unlock Mechanism.
    Tabs, pipes or wide spaces between columns all work, and a header row is skipped.</p>
    <textarea name="table" rows="14" style="width:100%;font-family:monospace;font-size:12px"></textarea>
    <div class="form-group"><label>Folder</label><input type="text" name="folder" value="Augments"></div>
    <div class="form-group"><label>Item type</label>
      <select name="itemType">
        <option value="equipment" selected>Equipment (Trinket), recommended</option>
        <option value="loot">Loot (no automation)</option>
      </select></div>
    <div class="form-group"><label>Automate from effect text</label><input type="checkbox" name="automate" checked></div>
    <div class="form-group"><label>Pick icons automatically</label><input type="checkbox" name="autoIcons" checked></div>
    <div class="form-group"><label>Update existing augments (including copies characters carry)</label><input type="checkbox" name="update" checked></div>
    <div class="form-group"><label>Rebuild automation even if the effect is unchanged</label><input type="checkbox" name="rebuild"></div>`;

  const read = get => ({
    text: get("table").value, folder: get("folder").value, itemType: get("itemType").value,
    automate: get("automate").checked, autoIcons: get("autoIcons").checked,
    update: get("update").checked, rebuild: get("rebuild").checked
  });

  const DialogV2 = foundry.applications?.api?.DialogV2;
  let result;
  if (DialogV2) {
    result = await DialogV2.prompt({
      window: { title: "Import augments", resizable: true },
      position: { width: 680 },
      content,
      rejectClose: false,
      ok: { label: "Import", icon: "fas fa-file-import", callback: (event, button) => read(n => button.form.elements[n]) }
    });
  } else {
    result = await Dialog.prompt({
      title: "Import augments", content, rejectClose: false,
      callback: html => {
        const root = html[0] ?? html;
        return read(n => root.querySelector(`[name="${n}"]`));
      }
    });
  }
  if (!result?.text) return;
  return importAugments(result.text, {
    folderName: result.folder?.trim() || "Augments", itemType: result.itemType,
    updateExisting: result.update, automate: result.automate, rebuildExisting: result.rebuild, autoIcons: result.autoIcons
  });
}
