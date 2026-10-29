import {
  MODULE_ID, RARITIES, getSlotLayout, getRarity, rarityColor, getEffectText, boldMarkdown, escapeHTML as esc
} from "./core.js";
import { openAugment } from "./ui.js";

/** Tooltip body for an augment. Foundry draws it (data-tooltip-html), so it sits above all UI. */
function tooltipHTML(item) {
  const key = getRarity(item);
  const info = RARITIES[key];
  const uses = usesText(item);
  return `<div class="aug-tt rarity-${key || "none"}">
      <div class="aug-tt-head"><img src="${esc(item.img)}" alt=""><div>
        <strong>${esc(item.name)}</strong>
        <div class="aug-tt-meta">${info ? `<span class="aug-tt-pill">${info.label}</span>` : ""}${uses ? `<em>${uses}</em>` : ""}</div>
      </div></div>
      <p>${boldMarkdown(getEffectText(item))}</p>
      <div class="aug-tt-foot">Click to open</div>
    </div>`;
}

/** Per-rarity colours for the tooltip (Foundry cleans inline styles out of tooltip HTML). */
function ensureRarityStyles() {
  if (document.getElementById("aug-tt-rarity-styles")) return;
  const style = document.createElement("style");
  style.id = "aug-tt-rarity-styles";
  style.textContent = Object.entries(RARITIES).map(([k, r]) => `.aug-tt.rarity-${k}{--rarity:${r.color}}`).join("\n");
  document.head.append(style);
}

/**
 * A button at the bottom of the left-hand scene controls. It slides open a column of the selected
 * token's installed augments: hover for details, click to open the augment. Players only ever see
 * tokens they own (they can only select their own); with nothing selected they see their character.
 */

const STORE_KEY = `${MODULE_ID}.hudOpen`;
let isOpen = (() => {
  try { return sessionStorage.getItem(STORE_KEY) === "1"; } catch (e) { return false; }
})();
function saveOpen() {
  try { sessionStorage.setItem(STORE_KEY, isOpen ? "1" : "0"); } catch (e) { /* storage unavailable */ }
}

/* -------------------------------------------- */
/*  Content                                     */
/* -------------------------------------------- */

function hudGroups() {
  const groups = [];
  for (const token of canvas?.tokens?.controlled ?? []) {
    const actor = token.actor;
    if (!actor?.isOwner || groups.some(g => g.actor === actor)) continue;
    groups.push({ actor, img: token.document?.texture?.src ?? actor.img });
  }
  if (!groups.length && !game.user.isGM && game.user.character) {
    groups.push({ actor: game.user.character, img: game.user.character.img });
  }
  return groups;
}

function installed(actor) {
  return getSlotLayout(actor).filter(s => s.item && !s.overflow).map(s => s.item);
}

function contentHTML() {
  const groups = hudGroups();
  if (!groups.length) {
    return `<div class="aug-hud-note" data-tooltip="Select a token to see its augments"><i class="fas fa-hand-pointer" inert></i></div>`;
  }
  let i = 0;
  return groups.map(({ actor, img }) => {
    const items = installed(actor);
    const owner = groups.length > 1
      ? `<div class="aug-hud-owner" data-tooltip="${esc(actor.name)}"><img src="${esc(img)}" alt=""></div>` : "";
    const icons = items.length
      ? items.map(item => {
          const tt = esc(tooltipHTML(item));
          return `<button type="button" class="aug-hud-icon" data-uuid="${esc(item.uuid)}"
            style="--rarity:${rarityColor(item)};--i:${i++}" aria-label="${esc(item.name)}"
            data-tooltip-html="${tt}" data-tooltip="${tt}" data-tooltip-direction="RIGHT" data-tooltip-class="aug-hud-tooltip">
            <img src="${esc(item.img)}" alt=""></button>`;
        }).join("")
      : `<div class="aug-hud-note" data-tooltip="${esc(actor.name)} has no augments installed"><i class="fas fa-ban" inert></i></div>`;
    return owner + icons;
  }).join("");
}

function usesText(item) {
  const uses = item.system?.uses;
  const max = Number(uses?.max) || 0;
  if (!max) return "";
  const value = Math.max(0, Math.min(max, Number(uses.value ?? max - (Number(uses.spent) || 0))));
  return `${value} / ${max} uses`;
}

function hideTip() {
  try { game.tooltip?.deactivate?.(); } catch (e) { /* ignore */ }
}

/* -------------------------------------------- */
/*  Rendering                                   */
/* -------------------------------------------- */

function bindIcons(scroll) {
  for (const btn of scroll.querySelectorAll(".aug-hud-icon")) {
    // Belt and braces: ask Foundry's tooltip manager to show it, in case its own hover detection doesn't.
    btn.addEventListener("pointerenter", () => {
      try {
        if (game.tooltip?.element?.isConnected && game.tooltip.element === btn) return;
        game.tooltip?.activate?.(btn, {
          html: btn.dataset.tooltipHtml, direction: "RIGHT", cssClass: "aug-hud-tooltip"
        });
      } catch (e) { console.warn(`${MODULE_ID} | Tooltip failed`, e); }
    });
    btn.addEventListener("pointerleave", hideTip);
    btn.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      hideTip();
      openAugment(btn.dataset.uuid);
    });
  }
}

function setOpen(li, open, { instant = false } = {}) {
  isOpen = open;
  saveOpen();
  const toggle = li.querySelector(".aug-hud-toggle");
  const drawer = li.querySelector(".aug-hud-drawer");
  if (instant) drawer.classList.add("instant");
  drawer.classList.toggle("open", open);
  toggle.classList.toggle("open", open);
  toggle.setAttribute("aria-expanded", String(open));
  toggle.dataset.tooltip = open ? "Hide augments" : "Show augments";
  if (!open) hideTip();
  if (instant) requestAnimationFrame(() => requestAnimationFrame(() => drawer.classList.remove("instant")));
}

/** renderSceneControls hook: add the button and drawer to the left-hand column. */
export function injectHud(app, html) {
  if (!game.settings.get(MODULE_ID, "tokenControls")) return;
  ensureRarityStyles();
  const root = html instanceof HTMLElement ? html : (html?.[0] ?? document);
  const menu = root.querySelector?.("#scene-controls-layers")
    ?? document.querySelector("#scene-controls-layers")
    ?? root.querySelector?.(".main-controls");
  if (!menu) return;
  menu.querySelectorAll(".aug-hud-li").forEach(el => el.remove());

  const li = document.createElement("li");
  li.className = "aug-hud-li";
  // Match Foundry's own buttons exactly so the column never gets wider and pushes the tools column off.
  const sample = menu.querySelector("button.control, .scene-control, li > button");
  const size = sample?.getBoundingClientRect?.().width;
  if (size) li.style.setProperty("--aug-hud-size", `${Math.round(size)}px`);
  li.innerHTML = `
    <button type="button" class="control ui-control icon fa-solid fa-angles-down aug-hud-toggle"
      aria-label="Augments" aria-expanded="false" data-tooltip="Show augments"></button>
    <div class="aug-hud-drawer"><div class="aug-hud-clip"><div class="aug-hud-scroll">${contentHTML()}</div></div></div>`;
  menu.append(li);
  bindIcons(li.querySelector(".aug-hud-scroll"));
  setOpen(li, isOpen, { instant: true });

  li.querySelector(".aug-hud-toggle").addEventListener("click", event => {
    event.preventDefault();
    event.stopPropagation();
    if (!isOpen) refreshHud();
    setOpen(li, !isOpen);
  });
}

/** Rebuild the drawer contents (selection changed, augment installed or removed...). */
export function refreshHud() {
  const scroll = document.querySelector(".aug-hud-li .aug-hud-scroll");
  if (!scroll) return;
  hideTip();
  scroll.innerHTML = contentHTML();
  bindIcons(scroll);
}

export const queueHudRefresh = foundry.utils.debounce(refreshHud, 80);
