import { MODULE_ID, AUGMENT_PROPERTY, isAugment, equippedBy, syncSocketState } from "./core.js";
import { applyAutomation } from "./automation.js";

/** Every augment item: the world's Items directory plus everything carried by actors. */
export function allAugmentItems() {
  return [...game.items, ...game.actors.contents.flatMap(a => a.items.contents)].filter(isAugment);
}

/**
 * Recreate an augment as a Feature with the same id (so socket assignments still point at it).
 * Keeps name, image, description, uses, activities, effects and all module flags.
 */
export async function convertToFeature(item) {
  if (item.type === "feat") return item;
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
  const parent = item.parent ?? null;
  const options = { keepId: true, augmentsSkipSync: true };
  if (parent) options.parent = parent;

  await item.delete();
  try {
    return await Item.implementation.create(data, options);
  } catch (err) {
    console.error(`${MODULE_ID} | Converting ${original.name} failed, restoring it.`, err);
    await Item.implementation.create(original, options);
    throw err;
  }
}

/** Bring every existing augment up to the current rules. GM only. */
export async function updateAllAugments({ convert = true } = {}) {
  if (!game.user.isGM) return ui.notifications.warn("Only the GM can update all augments.");
  const items = allAugmentItems();
  ui.notifications.info(`Augments: updating ${items.length} augments...`);
  let converted = 0, rebuilt = 0, failed = 0;
  for (const original of items) {
    try {
      let item = original;
      if (convert && item.type !== "feat") {
        item = await convertToFeature(item);
        converted++;
      }
      if (item.system?.activities !== undefined) {
        await applyAutomation(item, null, { quiet: true });
        rebuilt++;
      }
      if (item.parent?.documentName === "Actor") await syncSocketState(item, !!equippedBy(item));
    } catch (err) {
      failed++;
      console.error(`${MODULE_ID} | Couldn't update ${original.name}`, err);
    }
  }
  const msg = `Augments: ${rebuilt} rebuilt${convert ? `, ${converted} converted to Features` : ""}${failed ? `, ${failed} failed (see console)` : ""}.`;
  ui.notifications[failed ? "warn" : "info"](msg);
}

export async function openUpdateAll() {
  if (!game.user.isGM) return ui.notifications.warn("Only the GM can update all augments.");
  const count = allAugmentItems().length;
  const content = `<p>Rebuild automation on all <strong>${count}</strong> augments (Items folder and every character) using the current rules.</p>
    <p>Spent uses, stack counts, sockets and anything you added by hand are kept.</p>
    <div class="form-group"><label>Convert to Features (hides them from inventory readers like Argon)</label>
      <input type="checkbox" name="convert" checked></div>`;
  const DialogV2 = foundry.applications?.api?.DialogV2;
  let result;
  if (DialogV2) {
    result = await DialogV2.prompt({
      window: { title: "Update all augments" }, content, rejectClose: false,
      ok: { label: "Update all", icon: "fas fa-arrows-rotate", callback: (event, button) => ({ convert: button.form.elements.convert.checked }) }
    });
  } else {
    result = await Dialog.prompt({
      title: "Update all augments", content, rejectClose: false,
      callback: html => ({ convert: (html[0] ?? html).querySelector('[name="convert"]').checked })
    });
  }
  if (result) await updateAllAugments(result);
}
