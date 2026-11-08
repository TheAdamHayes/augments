import {
  MODULE_ID, SOCKET, RARITIES, getRarity, rarityColor, equippedBy, isAugment, registerSocketHandler,
  escapeHTML as esc
, reminderMode, firstToday, gmUserIds } from "./core.js";
import { getStack, setStackValue, fillStackText } from "./stacks.js";
import { describeChanges } from "./automation.js";

const TAG_ICONS = {
  "Movement": "fa-person-running",
  "Opportunity attacks": "fa-shield-halved",
  "Forced movement": "fa-up-down-left-right",
  "Target": "fa-crosshairs",
  "Allies": "fa-users",
  "Damage rules": "fa-burst",
  "Advantage": "fa-dice-d20",
  "Stealth": "fa-user-secret",
  "Cover": "fa-shield",
  "Resource": "fa-battery-half",
  "Stacks": "fa-layer-group",
  "Rule": "fa-scroll"
};

/* -------------------------------------------- */
/*  Card content                                */
/* -------------------------------------------- */

function targetEffectsOf(item) {
  return item.effects.filter(e => !e.transfer && e.flags?.[MODULE_ID]?.kind === "target");
}

function durationLabel(effect) {
  const d = effect.duration ?? {};
  if (d.seconds) return d.seconds % 60 ? `${d.seconds} sec` : `${d.seconds / 60} min`;
  if (d.rounds) return `${d.rounds} round${d.rounds === 1 ? "" : "s"}`;
  if (d.turns) return `${d.turns} turn${d.turns === 1 ? "" : "s"}`;
  return "";
}

function stackHTML(stack) {
  const max = stack.max;
  const pips = max && max <= 10
    ? `<span class="aug-chat-stack-pips">${Array.from({ length: max }, (_, i) => `<span class="${i < stack.value ? "full" : ""}"></span>`).join("")}</span>`
    : "";
  return `<div class="aug-chat-stack">
      <span class="aug-chat-stack-label"><i class="fas fa-layer-group" inert></i> ${esc(stack.name)}</span>
      ${pips}
      <span class="aug-chat-stack-value">${stack.value}${max ? ` / ${max}` : ""}${stack.unit ? ` ${stack.unit}` : ""}</span>
      <span class="aug-chat-stack-buttons">
        <button type="button" data-aug-action="stack-dec" data-tooltip="${stack.step ? `Spend ${stack.step} ${stack.unit ?? ""}` : "Remove one"}">−</button>
        <button type="button" data-aug-action="stack-inc" data-tooltip="${stack.step ? `Add ${stack.step} ${stack.unit ?? ""}` : "Add one"}">+</button>
        <button type="button" data-aug-action="stack-reset" data-tooltip="Lose all">0</button>
      </span>
    </div>`;
}

function reminderHTML(reminder, stack) {
  const tags = reminder.tags.map(t => `<span class="aug-tag"><i class="fas ${TAG_ICONS[t] ?? "fa-scroll"}" inert></i> ${esc(t)}</span>`).join("");
  return `<li><span class="aug-tags">${tags}</span><p>${esc(fillStackText(reminder.text, stack))}</p></li>`;
}

export function effectHTML(effect) {
  const detail = [describeChanges(effect), durationLabel(effect)].filter(Boolean).join(", ");
  return `<div class="aug-chat-effect" draggable="true" data-effect-uuid="${esc(effect.uuid)}"
      data-tooltip="Drag onto a token or a character sheet">
      <img src="${esc(effect.img)}" alt="">
      <span class="aug-chat-effect-text"><strong>${esc(effect.name)}</strong>${detail ? `<span>${esc(detail)}</span>` : ""}</span>
      <button type="button" data-aug-action="apply-targets" data-effect-uuid="${esc(effect.uuid)}"
        data-tooltip="Apply to your targeted tokens"><i class="fas fa-crosshairs" inert></i></button>
    </div>`;
}

/**
 * Build the card. timing = "start" | "end" for turn prompts (stack rules only).
 * Returns null when there's nothing worth posting.
 */
export function buildCardHTML(item, { timing = null, remember = "full", onlyRemember = false } = {}) {
  const auto = item.flags?.[MODULE_ID]?.auto ?? {};
  const stack = !onlyRemember && equippedBy(item) ? getStack(item) : null;
  let reminders = remember === "none" ? [] : (auto.reminders ?? []);
  if (timing) reminders = reminders.filter(r => r.tags.includes("Stacks"));
  const effects = timing || onlyRemember ? [] : targetEffectsOf(item);
  if (!reminders.length && !stack && !effects.length) return null;

  const info = RARITIES[getRarity(item)];
  const sub = timing === "end" ? "End of turn: update your stacks"
    : timing === "start" ? "Start of turn: update your stacks"
    : "Augment";
  return `<div class="aug-chat" style="--rarity:${rarityColor(item)}" data-item-uuid="${esc(item.uuid)}">
      <header>
        <img src="${esc(item.img)}" alt="">
        <span class="aug-chat-title"><strong>${esc(item.name)}</strong><span>${esc(sub)}</span></span>
        ${info ? `<span class="augment-rarity-pill">${info.label}</span>` : ""}
      </header>
      ${stack ? stackHTML(stack) : ""}
      ${!reminders.length ? "" : remember === "collapsed"
        ? `<details class="aug-chat-fold"><summary>Remember (${reminders.length}, shown earlier today)</summary><ul class="aug-chat-reminders">${reminders.map(r => reminderHTML(r, stack)).join("")}</ul></details>`
        : `<div class="aug-chat-section">Remember</div><ul class="aug-chat-reminders">${reminders.map(r => reminderHTML(r, stack)).join("")}</ul>`}
      ${effects.length ? `<div class="aug-chat-section">Effects for others <em>drag onto a token or sheet</em></div>${effects.map(effectHTML).join("")}` : ""}
    </div>`;
}

/** force: posted because someone asked (a "Post reminders" button), so the reminder setting doesn't apply. */
export async function postAugmentCard(item, { timing = null, whisper = null, force = false } = {}) {
  const mode = force ? "all" : reminderMode();
  const hasRules = (item.flags?.[MODULE_ID]?.auto?.reminders ?? []).some(r => !timing || r.tags.includes("Stacks"));
  let remember = "full";
  if (mode === "off" || mode === "gm") remember = "none";
  else if (mode === "daily" && hasRules && !firstToday(`card.${timing ?? "use"}.${item.uuid}`)) remember = "collapsed";
  const Msg = ChatMessage.implementation ?? ChatMessage;
  const speaker = Msg.getSpeaker({ actor: item.parent?.documentName === "Actor" ? item.parent : null });
  const flags = { [MODULE_ID]: { card: true, itemUuid: item.uuid } };
  let msg = null;
  const content = buildCardHTML(item, { timing, remember });
  if (content) {
    const data = { content, speaker, flags };
    if (whisper?.length) data.whisper = whisper;
    msg = await Msg.create(data);
  }
  // GM only: the rules go to the GM in a separate whisper.
  if (mode === "gm" && hasRules) {
    const gmCard = buildCardHTML(item, { timing, onlyRemember: true });
    if (gmCard) msg = (await Msg.create({ content: gmCard, speaker, flags, whisper: gmUserIds() })) ?? msg;
  }
  return msg;
}

/* -------------------------------------------- */
/*  Card interaction                            */
/* -------------------------------------------- */

function refreshStackDisplay(card, item) {
  const stack = getStack(item);
  const box = card.querySelector(".aug-chat-stack");
  if (!stack || !box) return;
  box.querySelector(".aug-chat-stack-value").textContent = `${stack.value}${stack.max ? ` / ${stack.max}` : ""}${stack.unit ? ` ${stack.unit}` : ""}`;
  box.querySelectorAll(".aug-chat-stack-pips span").forEach((p, i) => p.classList.toggle("full", i < stack.value));
}

export function bindCard(message, html) {
  const root = html instanceof HTMLElement ? html : html?.[0];
  const card = root?.querySelector?.(".aug-chat");
  if (!card || card.dataset.bound) return;
  card.dataset.bound = "true";

  for (const btn of card.querySelectorAll("[data-aug-action]")) {
    btn.addEventListener("click", async event => {
      event.preventDefault();
      event.stopPropagation();
      const item = await fromUuid(card.dataset.itemUuid);
      if (!item) return ui.notifications.warn("That augment no longer exists.");
      const action = btn.dataset.augAction;
      if (action === "apply-targets") return applyToTargets(btn.dataset.effectUuid);
      const stack = getStack(item);
      if (!stack) return;
      const step = Number(stack.step) || 1;
      const next = action === "stack-inc" ? stack.value + step : action === "stack-dec" ? stack.value - step : 0;
      const v = await setStackValue(item, next);
      if (v !== null) {
        refreshStackDisplay(card, item);
        ui.notifications.info(`${item.name}: ${v} ${stack.name}.`);
      }
    });
  }

  for (const el of card.querySelectorAll(".aug-chat-effect[draggable]")) {
    el.addEventListener("dragstart", event => {
      event.dataTransfer.setData("text/plain", JSON.stringify({ type: "ActiveEffect", uuid: el.dataset.effectUuid, augments: true }));
    });
  }
}

/** Effect rows inside other cards (trigger prompts): drag onto a token, or apply to your targets. */
export function bindEffectRows(card) {
  for (const btn of card.querySelectorAll('.aug-chat-effect [data-aug-action="apply-targets"]')) {
    btn.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      applyToTargets(btn.dataset.effectUuid);
    });
  }
  for (const el of card.querySelectorAll(".aug-chat-effect[draggable]")) {
    el.addEventListener("dragstart", event => {
      event.dataTransfer.setData("text/plain", JSON.stringify({ type: "ActiveEffect", uuid: el.dataset.effectUuid, augments: true }));
    });
  }
}

/* -------------------------------------------- */
/*  Applying effects to other creatures         */
/* -------------------------------------------- */

function effectDataFor(effect) {
  const data = effect.toObject();
  delete data._id;
  data.transfer = false;
  data.disabled = false;
  data.origin = effect.parent?.uuid ?? null;
  data.duration = {
    ...(data.duration ?? {}),
    startTime: game.time.worldTime,
    combat: game.combat?.id ?? null,
    startRound: game.combat?.round ?? null,
    startTurn: game.combat?.turn ?? null
  };
  foundry.utils.setProperty(data, `flags.${MODULE_ID}.applied`, true);
  return data;
}

export async function applyEffectToActor(effectUuid, actor) {
  const effect = await fromUuid(effectUuid);
  if (!effect || !actor) return;
  if (actor.isOwner) {
    await ActiveEffect.implementation.create(effectDataFor(effect), { parent: actor });
    return ui.notifications.info(`${effect.name} applied to ${actor.name}.`);
  }
  if (!game.users.activeGM) return ui.notifications.warn(`A GM needs to be online to apply effects to ${actor.name}.`);
  game.socket.emit(SOCKET, { action: "applyEffect", userId: game.user.id, effectUuid, actorUuid: actor.uuid });
  ui.notifications.info(`${effect.name} sent to ${actor.name}.`);
}

async function applyToTargets(effectUuid) {
  const targets = [...game.user.targets];
  if (!targets.length) return ui.notifications.warn("Target one or more tokens first (T while hovering a token).");
  for (const token of targets) if (token.actor) await applyEffectToActor(effectUuid, token.actor);
}

/** GM side: apply an effect a player dragged onto someone they don't own. */
registerSocketHandler("applyEffect", async msg => {
  if (game.user !== game.users.activeGM) return;
  const user = game.users.get(msg.userId);
  const effect = await fromUuid(msg.effectUuid);
  const actor = await fromUuid(msg.actorUuid);
  if (!user || !effect || !actor) return;
  const source = effect.parent;
  if (!user.isGM && !source?.testUserPermission?.(user, "OWNER")) return;
  await ActiveEffect.implementation.create(effectDataFor(effect), { parent: actor });
});

/** Dropping one of our effects onto a token on the canvas. */
export function onDropCanvasData(canvas, data) {
  if (data?.type !== "ActiveEffect" || !data.augments) return;
  const tokens = canvas.tokens.placeables.filter(t => t.visible && t.bounds?.contains?.(data.x, data.y));
  const token = tokens.at(-1);
  if (!token?.actor) {
    ui.notifications.warn("Drop the effect onto a token.");
    return false;
  }
  applyEffectToActor(data.uuid, token.actor);
  return false;
}

/* -------------------------------------------- */
/*  Turn prompts for stacks                     */
/* -------------------------------------------- */

function promptsFor(actor, timing) {
  const whisper = game.users.filter(u => actor.testUserPermission(u, "OWNER")).map(u => u.id);
  for (const item of actor.items) {
    if (!isAugment(item) || equippedBy(item) !== actor) continue;
    const stack = item.flags?.[MODULE_ID]?.auto?.stack;
    if (!stack) continue;
    const wanted = stack.timing === timing || (timing === "end" && stack.loseText && stack.timing !== "start");
    if (wanted) postAugmentCard(item, { timing, whisper });
  }
}

export function onUpdateCombat(combat, changes) {
  if (game.user !== game.users.activeGM) return;
  if (!changes || (!("turn" in changes) && !("round" in changes))) return;
  const prevId = combat.previous?.combatantId;
  const prev = prevId ? combat.combatants.get(prevId) : null;
  if (prev?.actor) promptsFor(prev.actor, "end");
  if (combat.combatant?.actor) promptsFor(combat.combatant.actor, "start");
}
