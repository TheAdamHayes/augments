import { MODULE_ID, getEffectText, escapeHTML as esc } from "./core.js";
import { setOverrideLookup, stableHash } from "./automation.js";

/**
 * Human review of augments: "checked" marks and hand edits from the audit window.
 * Stored in one world setting keyed by augment name, so they apply to the Items-folder augment and
 * every character's copy, and survive deleting and re-importing an augment.
 *
 * Entry: { checked, checkedAt, checkedBy, checkedSig, textHash, override, editedAt }
 */

const KEY = "reviews";
export const nameKey = name => String(name ?? "").trim().toLowerCase();
export const textHash = text => stableHash(String(text ?? "").replace(/\*\*/g, "").replace(/\s+/g, " ").trim());

/** What an augment builds, independent of item ids, for "changed since you checked it". */
export function buildSig(result) {
  return stableHash(JSON.stringify([result?.summary ?? [], (result?.reminders ?? []).map(r => r.text)]));
}

export function allReviews() {
  try { return game.settings.get(MODULE_ID, KEY) ?? {}; } catch (e) { return {}; }
}

export function getReview(itemOrName) {
  const name = typeof itemOrName === "string" ? itemOrName : itemOrName?.name;
  return allReviews()[nameKey(name)] ?? null;
}

async function writeReview(name, patch) {
  const all = foundry.utils.deepClone(allReviews());
  const key = nameKey(name);
  const entry = { ...(all[key] ?? {}), ...patch };
  for (const [k, v] of Object.entries(entry)) if (v === null || v === undefined || v === false) delete entry[k];
  if (!entry.checked && !entry.override) delete all[key];
  else all[key] = entry;
  await game.settings.set(MODULE_ID, KEY, all);
  return all[key] ?? null;
}

export function setChecked(item, checked, result) {
  return writeReview(item.name, checked
    ? { checked: true, checkedAt: Date.now(), checkedBy: game.user.name, checkedSig: buildSig(result), textHash: textHash(getEffectText(item)) }
    : { checked: null, checkedAt: null, checkedBy: null, checkedSig: null });
}

export function setOverride(item, override) {
  return writeReview(item.name, override
    ? { override, editedAt: Date.now(), textHash: textHash(getEffectText(item)) }
    : { override: null, editedAt: null });
}

/** Checked or edited by hand: batch tools ask before touching these. */
export function isProtected(item) {
  const r = getReview(item);
  return !!(r?.checked || r?.override);
}

/** Review status for the audit row. result = what the item builds now. */
export function reviewState(item, result) {
  const r = getReview(item);
  if (!r) return { checked: false, edited: false, stale: false, textChanged: false };
  return {
    checked: !!r.checked,
    edited: !!r.override,
    stale: !!r.checked && !!r.checkedSig && r.checkedSig !== buildSig(result),
    textChanged: !!r.textHash && r.textHash !== textHash(getEffectText(item)),
    checkedBy: r.checkedBy, checkedAt: r.checkedAt
  };
}

// Hand edits are applied by the reader every time an augment is built.
setOverrideLookup(item => getReview(item)?.override ?? null);

/* -------------------------------------------- */
/*  Backup to a file                            */
/* -------------------------------------------- */

export function exportReviews() {
  const save = foundry.utils?.saveDataToFile ?? globalThis.saveDataToFile;
  const data = { module: MODULE_ID, kind: "augment-reviews", exported: new Date().toISOString(), reviews: allReviews() };
  const stamp = new Date().toISOString().slice(0, 10);
  save(JSON.stringify(data, null, 1), "application/json", `augment-reviews-${stamp}.json`);
}

/** Merge a reviews file into this world. Entries in the file win. Returns how many were read. */
export async function importReviewsFile(file) {
  const text = await file.text();
  const data = JSON.parse(text);
  const incoming = data?.reviews ?? data;
  if (!incoming || typeof incoming !== "object") throw new Error("That file doesn't contain augment reviews.");
  const all = { ...foundry.utils.deepClone(allReviews()), ...incoming };
  await game.settings.set(MODULE_ID, KEY, all);
  return Object.keys(incoming).length;
}

/* -------------------------------------------- */
/*  Asking before batch changes                 */
/* -------------------------------------------- */

/**
 * Before a batch rebuild: if any of `items` were checked or edited by hand, ask what to do.
 * Returns "all" (update them too), "skip" (leave them alone) or null (cancel everything).
 */
export async function confirmProtected(items, { verb = "rebuild" } = {}) {
  const names = [...new Set(items.filter(isProtected).map(i => i.name))].sort();
  if (!names.length) return "all";
  const list = names.slice(0, 12).map(n => {
    const r = getReview(n);
    return `<li>${esc(n)} <em>(${[r?.checked ? "checked" : "", r?.override ? "edited" : ""].filter(Boolean).join(", ")})</em></li>`;
  }).join("") + (names.length > 12 ? `<li>and ${names.length - 12} more</li>` : "");
  const content = `<p>You've checked or edited ${names.length === 1 ? "this augment" : `these ${names.length} augments`} by hand.
      Their automation would change if you ${verb} ${names.length === 1 ? "it" : "them"}. Your hand edits are kept either way.</p>
    <ul class="aug-protect-list">${list}</ul>`;
  const DialogV2 = foundry.applications?.api?.DialogV2;
  if (DialogV2) {
    return DialogV2.wait({
      window: { title: "Hand-checked augments", icon: "fas fa-user-check" },
      content, rejectClose: false,
      buttons: [
        { action: "skip", label: "Skip them", icon: "fas fa-forward", default: true },
        { action: "all", label: `${verb[0].toUpperCase()}${verb.slice(1)} them too`, icon: "fas fa-arrows-rotate" },
        { action: "cancel", label: "Cancel", icon: "fas fa-xmark" }
      ]
    }).then(r => (r === "cancel" || !r ? null : r));
  }
  return new Promise(resolve => new Dialog({
    title: "Hand-checked augments", content,
    buttons: {
      skip: { label: "Skip them", callback: () => resolve("skip") },
      all: { label: `${verb[0].toUpperCase()}${verb.slice(1)} them too`, callback: () => resolve("all") },
      cancel: { label: "Cancel", callback: () => resolve(null) }
    },
    default: "skip", close: () => resolve(null)
  }).render(true));
}
