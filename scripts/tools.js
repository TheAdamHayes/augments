import { MODULE_ID, AUGMENT_PROPERTY, RARITIES, isAugment, isSocketGrant, equippedBy, syncSocketState } from "./core.js";
import { planAutomation, commitPlan } from "./automation.js";

/** Every augment item: the world's Items directory plus everything carried by actors. */
export function allAugmentItems() {
  return [...game.items, ...game.actors.contents.flatMap(a => a.items.contents)].filter(isAugment);
}

/** An augment's data rewritten as a Feature (same id, flags, effects, uses and activities). */
function featureData(item) {
  const original = item.toObject();
  const data = foundry.utils.deepClone(original);
  const sys = original.system ?? {};
  data.type = "feat";
  data.system = {
    description: sys.description,
    source: sys.source,
    identifier: sys.identifier,
    uses: sys.uses,
    activities: sys.activities ?? {},
    properties: Array.from(new Set([...(sys.properties ?? []).filter(p => p === AUGMENT_PROPERTY), AUGMENT_PROPERTY])),
    type: { value: "", subtype: "" }
  };
  foundry.utils.setProperty(data, `flags.${MODULE_ID}.isAugment`, true);
  return { original, data };
}

/**
 * Convert several augments on the same parent (an actor, or the world) in one delete and one
 * create. Ids are kept, so sockets still point at them. On failure the originals are restored.
 */
async function convertBatch(items, parent) {
  const pairs = items.map(featureData);
  const options = { keepId: true, augmentsSkipSync: true };
  if (parent) options.parent = parent;
  const Cls = Item.implementation;
  await Cls.deleteDocuments(items.map(i => i.id), parent ? { parent } : {});
  try {
    await Cls.createDocuments(pairs.map(p => p.data), options);
  } catch (err) {
    console.error(`${MODULE_ID} | Converting failed, restoring the originals.`, err);
    await Cls.createDocuments(pairs.map(p => p.original), options);
    throw err;
  }
  return items.length;
}

/** Recreate one augment as a Feature with the same id. */
export async function convertToFeature(item) {
  if (item.type === "feat") return item;
  const parent = item.parent ?? null;
  await convertBatch([item], parent);
  return parent ? parent.items.get(item.id) : game.items.get(item.id);
}

/** Run tasks with a small amount of parallelism. */
async function pool(list, size, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(size, list.length) }, async () => {
    while (i < list.length) {
      const item = list[i++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}

function progressBar(label) {
  let note = null;
  try { note = ui.notifications.info(label, { progress: true }); } catch (e) { /* older Foundry */ }
  return {
    set(pct, message) {
      try { note?.update?.({ pct, message }); } catch (e) { /* ignore */ }
    }
  };
}

function downloadBackup(items) {
  const save = foundry.utils?.saveDataToFile ?? globalThis.saveDataToFile;
  if (!save) return;
  const data = items.map(i => ({ parent: i.parent?.uuid ?? null, item: i.toObject() }));
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
  save(JSON.stringify(data, null, 1), "application/json", `augments-backup-${stamp}.json`);
}

/**
 * Bring every existing augment up to the current rules. GM only.
 * Augments whose automation hasn't changed are skipped, so running it again is quick.
 */
export async function updateAllAugments({ convert = true, backup = true } = {}) {
  if (!game.user.isGM) return ui.notifications.warn("Only the GM can update all augments.");
  const start = allAugmentItems();
  if (backup) downloadBackup(start);
  const bar = progressBar(`Augments: updating ${start.length} augments...`);
  let converted = 0, rebuilt = 0, skipped = 0, failed = 0;

  // 1. Convert to Features, one batch per character (and one for the Items folder).
  if (convert) {
    const groups = new Map();
    for (const item of start) {
      if (item.type === "feat") continue;
      const key = item.parent ?? null;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    }
    for (const [parent, items] of groups) {
      try { converted += await convertBatch(items, parent); }
      catch (err) { failed += items.length; }
    }
  }
  bar.set(0.2, "Augments: rebuilding automation...");

  // 2. Rebuild automation, several at a time, skipping anything already up to date.
  const items = allAugmentItems();
  let done = 0;
  await pool(items, 6, async item => {
    try {
      if (item.system?.activities === undefined) { skipped++; return; }
      const plan = planAutomation(item);
      if (plan.unchanged) skipped++;
      else {
        await commitPlan(item, plan);
        rebuilt++;
      }
      if (item.parent?.documentName === "Actor") await syncSocketState(item, !!equippedBy(item));
    } catch (err) {
      failed++;
      console.error(`${MODULE_ID} | Couldn't update ${item.name}`, err);
    }
    done++;
    bar.set(0.2 + 0.8 * (done / items.length), `Augments: ${done} / ${items.length}`);
  });

  bar.set(1, "Augments: done");
  const parts = [`${rebuilt} rebuilt`, `${skipped} already up to date`];
  if (convert) parts.push(`${converted} converted to Features`);
  if (failed) parts.push(`${failed} failed (see console)`);
  ui.notifications[failed ? "warn" : "info"](`Augments: ${parts.join(", ")}.`);
}

export async function openUpdateAll() {
  if (!game.user.isGM) return ui.notifications.warn("Only the GM can update all augments.");
  const count = allAugmentItems().length;
  const content = `<p>Rebuild automation on all <strong>${count}</strong> augments (Items folder and every character) using the current rules.</p>
    <p>Spent uses, stack counts, sockets and anything you added by hand are kept.</p>
    <div class="form-group"><label>Convert to Features (hides them from inventory readers like Argon)</label>
      <input type="checkbox" name="convert" checked></div>
    <div class="form-group"><label>Download a backup file first</label>
      <input type="checkbox" name="backup" checked></div>`;
  const DialogV2 = foundry.applications?.api?.DialogV2;
  let result;
  if (DialogV2) {
    result = await DialogV2.prompt({
      window: { title: "Update all augments" }, content, rejectClose: false,
      ok: { label: "Update all", icon: "fas fa-arrows-rotate", callback: (event, button) => ({ convert: button.form.elements.convert.checked, backup: button.form.elements.backup.checked }) }
    });
  } else {
    result = await Dialog.prompt({
      title: "Update all augments", content, rejectClose: false,
      callback: html => {
        const root = html[0] ?? html;
        return { convert: root.querySelector('[name="convert"]').checked, backup: root.querySelector('[name="backup"]').checked };
      }
    });
  }
  if (result) await updateAllAugments(result);
}

/**
 * GM: create one master "extra socket" item per rarity in an "Augment Sockets" folder.
 * Drag one onto a character (sheet or DNA tab) to give them an extra socket that holds that
 * rarity or lower. Existing ones are left alone, so it's safe to click again.
 */
export async function createSocketItems() {
  if (!game.user.isGM) return ui.notifications.warn("Only the GM can create socket items.");
  let folder = game.folders.find(f => f.type === "Item" && f.name === "Augment Sockets");
  folder ??= await Folder.create({ name: "Augment Sockets", type: "Item", color: "#2a3a4a" });
  const have = new Set(game.items.filter(isSocketGrant).map(i => i.flags[MODULE_ID].socketGrant.rarity));
  const order = Object.keys(RARITIES);
  const data = Object.entries(RARITIES).filter(([key]) => !have.has(key)).map(([key, r]) => {
    const allowed = order.slice(0, order.indexOf(key) + 1).map(k => RARITIES[k].label).join(", ");
    return {
      name: `${r.label} Augment Socket`,
      type: "feat",
      img: "icons/svg/upgrade.svg",
      folder: folder.id,
      sort: order.indexOf(key) * 100,
      system: {
        type: { value: "", subtype: "" },
        description: { value: `<p>Grants one extra augment socket. It holds <strong>${r.label}</strong> augments or lower (${allowed}).</p>` }
      },
      flags: { [MODULE_ID]: { socketGrant: { rarity: key } } }
    };
  });
  if (data.length) await Item.implementation.createDocuments(data);
  ui.notifications.info(data.length
    ? `Augments: created ${data.length} socket items in "Augment Sockets". Drag one onto a character to give them an extra socket.`
    : "Augments: all five socket items already exist.");
}
