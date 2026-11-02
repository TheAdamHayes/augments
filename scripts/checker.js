import { parseSave, parseHeal, concentrationRequired, imposedConditions } from "./automation.js";

/**
 * Checks an augment's automation against its effect text and flags likely mistakes.
 * Pure functions (no Foundry calls), so they can run in the review window and in tests.
 *
 * Status, from best to worst:
 *   "clean"     every sentence was automated, nothing suspicious
 *   "reminders" automated where possible, some rules left as chat reminders (expected)
 *   "check"     something in the text looks like it should have been automated but wasn't
 *   "text"      nothing could be automated; it's reminders only
 */

const ABILITY_SAVE = /\b(strength|dexterity|constitution|intelligence|wisdom|charisma) (?:saving throw|save)s?\b/gi;
const AREA = /(\d+)-foot(?:-|\s)(radius|cone|line|cube|sphere|cylinder|emanation)/i;

function clean(text) {
  return String(text ?? "").replace(/\*\*/g, "").replace(/\s+/g, " ").replace(/(\d+)\s*ft\.?/g, "$1 feet").trim();
}

function rolledDice(result) {
  const out = [];
  for (const a of result.activities ?? []) {
    for (const p of a.damage?.parts ?? []) {
      if (p.number && p.denomination) out.push(`${p.number}d${p.denomination}`);
      if (p.custom?.enabled) out.push(...(p.custom.formula.match(/\d+d\d+/g) ?? []));
    }
    if (a.healing?.custom?.formula) out.push(...(a.healing.custom.formula.match(/\d+d\d+/g) ?? []));
    if (a.healing?.number && a.healing?.denomination) out.push(`${a.healing.number}d${a.healing.denomination}`);
    if (a.roll?.formula) out.push(...(a.roll.formula.match(/\d+d\d+/g) ?? []));
  }
  if (result.stack?.damage) out.push(`${result.stack.damage.number}d${result.stack.damage.denomination}`);
  if (result.stack?.formula) out.push(...(result.stack.formula.match(/\d+d\d+/g) ?? []));
  return out;
}

/** Returns { status, flags: [{ code, message }] } for one augment. */
export function checkAutomation(effectText, result) {
  const text = clean(effectText);
  const flags = [];
  const flag = (code, message) => { if (!flags.some(f => f.code === code)) flags.push({ code, message }); };
  const acts = result.activities ?? [];
  const effects = result.effects ?? [];
  const has = type => acts.some(a => a.activation?.type === type);

  // Dice written in the text that no roll uses (ignoring dice that are reductions or rerolls).
  const rolled = rolledDice(result);
  for (const m of text.matchAll(/(\d+d\d+)/g)) {
    const before = text.slice(Math.max(0, m.index - 40), m.index);
    if (/\b(?:reduce|reduces|reduced|reroll|roll a|instead of|by)\s*$/i.test(before) || /\breduc/i.test(before)) continue;
    const i = rolled.indexOf(m[1]);
    if (i >= 0) rolled.splice(i, 1);
    else flag("dice", `"${m[1]}" in the text isn't rolled by anything`);
  }

  // Two different damage instances squashed into one roll.
  for (const a of acts) {
    const parts = a.damage?.parts ?? [];
    if (parts.length > 1) flag("merged", `"${a.name}" rolls ${parts.length} damage dice together; check they happen at the same time`);
  }

  // A save forced on someone else, with no save roll built.
  const save = parseSave(text);
  if (save && !acts.some(a => a.type === "save")) flag("save", `Forces a ${save.toUpperCase()} save, but no save roll is built`);

  if (AREA.test(text) && !acts.some(a => a.target?.template)) flag("area", `Mentions a ${text.match(AREA)[0]} area, but no template is set`);
  if (concentrationRequired(text) && !acts.some(a => a.duration?.concentration)) flag("concentration", "Needs concentration, but it isn't set");
  const grantsTemp = /\d+d\d+[^.]{0,30}temporary hit points|temporary hit points equal to (?:\d+d\d+|PB)|\bPB temporary hit points/i.test(text);
  if (grantsTemp && !acts.some(a => a.type === "heal" && a.healing?.types?.includes("temphp"))) flag("temphp", "Gives temporary hit points, but no roll for them");
  if (parseHeal(text) && !acts.some(a => a.type === "heal" && a.healing?.types?.includes("healing"))) flag("healing", "Restores hit points, but no healing roll is built");

  // Limited uses written in the text but not read.
  if (/\b(?:uses?|times|once|twice|banks?|charges?)\b[^.;]{0,30}\bper (?:short|long) rest\b/i.test(text) && !result.uses) flag("uses", "Says uses per rest, but no uses were set");

  // Action types written in the text with no matching activity.
  if (/\bas a bonus action\b|\buse your bonus action\b/i.test(text) && !has("bonus")) flag("bonus", "Is a bonus action, but none is built");
  if (/\b(?:use|uses|using) (?:your|its) reaction\b|\bas a reaction\b/i.test(text) && !has("reaction")) flag("reaction", "Mentions a reaction, but none is built");
  if (/\b(?:as an|as a magic|take the magic|take the utilize|use your) action\b/i.test(text) && !acts.some(a => a.activation?.type === "action")) {
    flag("action", "Is an action, but none is built");
  }

  // Conditions put on a creature, with no effect carrying that condition.
  for (const cond of imposedConditions(text)) {
    if (!effects.some(e => e.statuses?.includes(cond))) flag(`condition-${cond}`, `Applies ${cond}, but no effect carries it`);
  }

  const autoActs = acts.filter(a => !(a.type === "utility" && a.activation?.type === "special" && !a.consumption?.targets?.length && !a.effects?.length));
  const textOnly = !autoActs.length && !effects.length && !result.uses && !result.stack;
  const status = textOnly ? "text" : flags.length ? "check" : (result.reminders?.length ? "reminders" : "clean");
  return { status, flags };
}
