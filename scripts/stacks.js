import { MODULE_ID, equippedBy } from "./core.js";

/** Stack counter for an augment (e.g. Redline), or null. max is resolved for the holder (PB). */
export function getStack(item) {
  const s = item?.flags?.[MODULE_ID]?.auto?.stack;
  if (!s) return null;
  const value = Number(item.flags[MODULE_ID].stackValue) || 0;
  let max = null;
  if (s.max === "@prof") max = Number(item.parent?.system?.attributes?.prof) || null;
  else if (s.max) max = Number(s.max) || null;
  return { ...s, value, max };
}

/** Set the stack count and update the speed effect and damage roll that scale with it. */
export async function setStackValue(item, value) {
  const s = getStack(item);
  if (!s) return null;
  if (!item.isOwner) {
    ui.notifications.warn(`You don't control ${item.name}.`);
    return null;
  }
  if (!equippedBy(item)) {
    ui.notifications.warn(`${item.name} isn't installed.`);
    return null;
  }
  let v = Math.max(0, Math.round(Number(value) || 0));
  if (s.max) v = Math.min(v, s.max);
  await item.update({ [`flags.${MODULE_ID}.stackValue`]: v }, { [MODULE_ID]: true });
  await applyStackValue(item, v);
  return v;
}

export async function applyStackValue(item, v) {
  const s = item.flags?.[MODULE_ID]?.auto?.stack;
  if (!s) return;
  const socketed = !!equippedBy(item);
  const opts = { [MODULE_ID]: true };
  if (s.effectId && s.speedPer) {
    const effect = item.effects.get(s.effectId);
    const mode = globalThis.CONST?.ACTIVE_EFFECT_MODES?.ADD ?? 2;
    if (effect) {
      await effect.update({
        changes: [{ key: "system.attributes.movement.walk", mode, value: String(s.speedPer * v), priority: null }],
        disabled: !(socketed && v > 0)
      }, opts);
    }
  }
  if (s.activityId && s.damage && item.system?.activities?.get?.(s.activityId)) {
    const formula = v ? `${v * s.damage.number}d${s.damage.denomination}` : "0";
    await item.update({
      [`system.activities.${s.activityId}.damage.parts`]: [{
        number: null, denomination: null, bonus: "", types: s.damage.type ? [s.damage.type] : [],
        custom: { enabled: true, formula }
      }]
    }, opts);
  }
}

/** Put live numbers into "per Redline" text: "move 5 feet per Redline" -> "move 15 feet (3 Redline)". */
export function fillStackText(text, stack) {
  if (!stack) return text;
  const N = stack.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const v = stack.value;
  return String(text)
    .replace(new RegExp(`(\\d+) (feet|ft\\.?) (?:per|for each) ${N}`, "gi"), (_, n) => `${Number(n) * v} feet (${v} ${stack.name})`)
    .replace(new RegExp(`(\\d+)d(\\d+) ((?:extra |additional )?(?:\\w+ )?)damage (?:per|for each) ${N}`, "gi"),
      (_, a, b, mid) => v ? `${Number(a) * v}d${b} ${mid}damage (${v} ${stack.name})` : `no ${mid}damage (0 ${stack.name})`);
}
