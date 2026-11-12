import {
  MODULE_ID, RARITIES, isAugment, equippedBy, getRarity, getEffectText, effectFromDescription, effectKey,
  describeAugmentHTML, addBanner, stripBanner, versionOf, historyWith, HISTORY_MAX, escapeHTML as esc
} from "./core.js";
import { planAutomation, applyAutomation } from "./automation.js";
import { checkAutomation } from "./checker.js";
import { isProtected, confirmProtected, getReview, nameKey } from "./review.js";
import { suggestFormatting, applySuggestions, wordDiff, editExcerpt } from "./style.js";

/**
 * "Change augment": edit an augment's text, see straight away what the module would build from it,
 * get formatting suggestions in the style of the official books, and go back to older versions.
 * Saving rebuilds the automation (asking first for hand-checked augments).
 *
 * Also: editing an augment's description anywhere else (the item sheet) records a version and
 * rebuilds its automation from the new text.
 */

const AppV2 = foundry.applications?.api?.ApplicationV2;
const STYLE_KEY = `${MODULE_ID}.changeStyle`;
const STATUS = {
  clean: ["Fully automated", "Everything in the text is automated."],
  reminders: ["Automated, with reminders", "What can be automated is; the rest is posted as reminders in chat."],
  check: ["Worth a look", "Something in the text looks like it should be automated but isn't."],
  text: ["Text only", "Nothing here can be automated; it's posted as a reminder."]
};

/** Every copy of an augment: the Items-sidebar one and the ones characters carry. */
export function augmentFamily(item) {
  const key = nameKey(item.name);
  const all = [...game.items.contents, ...game.actors.contents.flatMap(a => a.items.contents)];
  return all.filter(i => isAugment(i) && nameKey(i.name) === key);
}

/**
 * Put the edited parts (physical description, effect, rarity and unlock lines) into the existing
 * description, keeping everything else where it was: GM notes, secrets, pictures, other paragraphs.
 */
export function mergeDescription(oldHtml, managedHtml) {
  const div = document.createElement("div");
  div.innerHTML = stripBanner(oldHtml ?? "");
  const blocks = [...div.children];
  const text = b => b.textContent.trim();
  const isPhysical = b => b.tagName === "P" && b.children.length === 1 && b.firstElementChild.tagName === "EM" && text(b) === b.firstElementChild.textContent.trim();
  const isMeta = b => /^(?:Rarity|Tier|Unlock):/i.test(text(b));
  const start = blocks.findIndex(b => /^Effect\.(\s|$)/i.test(text(b)));
  const managed = new Set();
  if (start >= 0) {
    // The effect runs to the Rarity/Unlock lines, as the editor reads it; secret blocks inside it stay as they are.
    let i = start;
    for (; i < blocks.length; i++) {
      if (i > start && isMeta(blocks[i])) break;
      if (blocks[i].classList?.contains("secret")) continue;
      managed.add(blocks[i]);
    }
    for (; i < blocks.length && isMeta(blocks[i]); i++) managed.add(blocks[i]);
    const phys = blocks.slice(0, start).reverse().find(isPhysical);
    if (phys) managed.add(phys);
  } else {
    // Not in the importer's layout: everything except secrets is replaced.
    for (const b of blocks) if (!b.classList?.contains("secret")) managed.add(b);
  }
  // Rebuild: anything before the first edited part, the edited parts, then everything else in order.
  const firstManaged = blocks.findIndex(b => managed.has(b));
  const before = firstManaged < 0 ? blocks : blocks.slice(0, firstManaged).filter(b => !managed.has(b));
  const after = firstManaged < 0 ? [] : blocks.slice(firstManaged).filter(b => !managed.has(b));
  return [...before.map(b => b.outerHTML), managedHtml, ...after.map(b => b.outerHTML)].join("");
}

/** What the module builds, compared without wording differences. */
function buildLines(result) {
  return (result?.summary ?? []).filter(s => !/^\d+ reminders? in chat$/.test(s));
}
const sameBuild = (a, b) => JSON.stringify(buildLines(a).map(s => s.toLowerCase())) === JSON.stringify(buildLines(b).map(s => s.toLowerCase()));

function previewFor(item, effect) {
  try {
    const result = planAutomation(item, effect).result;
    return { result, check: checkAutomation(effect, result) };
  } catch (err) {
    console.warn(`${MODULE_ID} | Change augment couldn't read the text`, err);
    return { result: { summary: [], reminders: [], activities: [], effects: [] }, check: { status: "text", flags: [{ message: `Couldn't read this text: ${err.message}` }] }, error: err };
  }
}

const changeWindowId = item => `augments-change-${String(item.uuid).replace(/[^A-Za-z0-9_-]/g, "-")}`;

let spellCache = null;
async function spellNames() {
  if (spellCache) return spellCache;
  const set = new Set(game.items.filter(i => i.type === "spell").map(i => i.name.toLowerCase()));
  for (const pack of game.packs.filter(p => p.documentName === "Item")) {
    try { for (const e of await pack.getIndex({ fields: ["type"] })) if (e.type === "spell") set.add(String(e.name).toLowerCase()); }
    catch (err) { /* a pack that can't be indexed just adds nothing */ }
  }
  return (spellCache = set);
}

const when = at => at ? new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "before tracking began";
const diffHTML = (a, b) => wordDiff(a, b).map(p => p.type === "same" ? esc(p.text) : `<${p.type === "add" ? "ins" : "del"}>${esc(p.text)}</${p.type === "add" ? "ins" : "del"}>`).join("");

export const ChangeAugment = AppV2 ? class ChangeAugment extends AppV2 {
  static DEFAULT_OPTIONS = {
    classes: ["augments-change"],
    tag: "div",
    window: { title: "Change augment", icon: "fas fa-pen-to-square", resizable: true },
    position: { width: 1060, height: 780 }
  };

  constructor(item, options = {}) {
    super({ id: changeWindowId(item), ...options });
    this.item = item;
    this.saved = versionOf(item);
    this.draft = { ...this.saved };
    this.base = previewFor(item, this.saved.effect).result;
    this.tab = "auto";
    this.style = (() => { try { return localStorage.getItem(STYLE_KEY) || "2024"; } catch (e) { return "2024"; } })();
    this.suggestions = null;
    this.picked = new Set();
    this.compare = null;
    this.loadedFrom = null;
  }

  get title() { return `Change augment: ${this.item.name}`; }

  async _renderHTML() {
    const it = this.item;
    const copies = augmentFamily(it).filter(i => i !== it).length;
    const rarity = RARITIES[getRarity(it)]?.label ?? "";
    const laidOut = !!it.flags?.[MODULE_ID]?.effect || !!effectFromDescription(it.system?.description?.value ?? "");
    const review = getReview(it);
    return `<div class="aug-chg">
      <header class="aug-chg-head">
        <img src="${esc(it.img)}" alt="">
        <div><h2>${esc(it.name)}</h2>
          <span>${[rarity, it.parent ? `carried by ${esc(it.parent.name)}` : "Items sidebar", copies ? `${copies} other cop${copies === 1 ? "y" : "ies"}` : ""].filter(Boolean).join(" · ")}
          ${review?.checked ? ` · <b class="aug-chg-flag">human-checked</b>` : ""}${review?.override ? ` · <b class="aug-chg-flag">has audit edits</b>` : ""}</span></div>
        <span class="aug-chg-dirty" hidden><i class="fas fa-circle"></i> Unsaved changes</span>
      </header>
      ${laidOut ? "" : `<p class="aug-chg-warn"><i class="fas fa-triangle-exclamation"></i> This description isn't in the importer's layout. Saving writes the description, effect, rarity and unlock in the usual layout (secret blocks are kept).</p>`}
      <div class="aug-chg-body">
        <section class="aug-chg-edit">
          <label class="aug-chg-field"><span>Physical description <em>(shown in italics)</em></span>
            <textarea name="physical" rows="2" spellcheck="true">${esc(this.draft.physical)}</textarea></label>
          <div class="aug-chg-field aug-chg-effect">
            <div class="aug-chg-effect-head"><span>Effect</span>
              <div class="aug-chg-tools">
                <button type="button" data-md="bold" data-tooltip="Bold (**text**)"><i class="fas fa-bold"></i></button>
                <button type="button" data-md="italic" data-tooltip="Italic (*text*)"><i class="fas fa-italic"></i></button>
                <button type="button" data-md="list" data-tooltip="Bulleted list (- item)"><i class="fas fa-list-ul"></i></button>
                <button type="button" data-md="table" data-tooltip="Table (| a | b |)"><i class="fas fa-table"></i></button>
                <button type="button" class="aug-chg-suggest-btn" data-tooltip="Suggest formatting in the style of the official books"><i class="fas fa-wand-magic-sparkles"></i> Suggest formatting</button>
              </div></div>
            <textarea name="effect" spellcheck="true">${esc(this.draft.effect)}</textarea>
            <p class="aug-chg-hint">**bold**, *italic*, a line starting “- ” for a list, “| a | b |” lines for a table. A blank line starts a new paragraph.</p>
          </div>
          <label class="aug-chg-field"><span>Unlock</span>
            <textarea name="unlock" rows="2" spellcheck="true">${esc(this.draft.unlock)}</textarea></label>
        </section>
        <section class="aug-chg-side">
          <nav class="aug-chg-tabs">
            <button type="button" data-tab="auto"><i class="fas fa-gears"></i> Automation</button>
            <button type="button" data-tab="look"><i class="fas fa-eye"></i> Looks like</button>
            <button type="button" data-tab="suggest"><i class="fas fa-wand-magic-sparkles"></i> Suggestions</button>
            <button type="button" data-tab="history"><i class="fas fa-clock-rotate-left"></i> History</button>
          </nav>
          <div class="aug-chg-panel"></div>
        </section>
      </div>
      <footer class="aug-chg-foot">
        ${copies ? `<label class="aug-chg-copies"><input type="checkbox" name="copies" checked> Also change the ${copies} other cop${copies === 1 ? "y" : "ies"}</label>` : ""}
        <input type="text" name="note" placeholder="Note for the history (optional)">
        <button type="button" data-act="close"><i class="fas fa-xmark"></i> Close</button>
        <button type="button" data-act="save" class="aug-chg-save"><i class="fas fa-floppy-disk"></i> Save and rebuild</button>
      </footer>
    </div>`;
  }

  _replaceHTML(result, content) {
    content.innerHTML = result;
    this.root = content.querySelector(".aug-chg");
    const q = s => this.root.querySelector(s);
    this.fields = { physical: q('[name="physical"]'), effect: q('[name="effect"]'), unlock: q('[name="unlock"]') };
    let timer = null;
    for (const [k, el] of Object.entries(this.fields)) el.addEventListener("input", () => {
      this.draft[k] = el.value;
      if (k === "effect") this.suggestions = null;
      this.markDirty();
      clearTimeout(timer);
      timer = setTimeout(() => this.paintPanel(), 350);
    });
    this.root.querySelectorAll("[data-tab]").forEach(b => b.addEventListener("click", () => { this.tab = b.dataset.tab; this.paintPanel(); }));
    this.root.querySelectorAll("[data-md]").forEach(b => b.addEventListener("click", () => this.insertMarkdown(b.dataset.md)));
    q(".aug-chg-suggest-btn").addEventListener("click", () => { this.tab = "suggest"; this.findSuggestions(); });
    q('[data-act="close"]').addEventListener("click", () => this.close());
    q('[data-act="save"]').addEventListener("click", () => this.save());
    this.markDirty();
    this.paintPanel();
  }

  get dirty() {
    return effectKey(this.draft.effect) !== effectKey(this.saved.effect) || this.draft.effect.trim() !== this.saved.effect.trim()
      || this.draft.physical.trim() !== this.saved.physical.trim() || this.draft.unlock.trim() !== this.saved.unlock.trim();
  }
  markDirty() { const el = this.root?.querySelector(".aug-chg-dirty"); if (el) el.hidden = !this.dirty; }

  setField(k, value) {
    this.draft[k] = value;
    if (this.fields?.[k]) this.fields[k].value = value;
    this.markDirty();
  }

  insertMarkdown(kind) {
    const ta = this.fields.effect;
    const [a, b] = [ta.selectionStart, ta.selectionEnd];
    const sel = ta.value.slice(a, b);
    const snippets = {
      bold: [`**${sel || "bold text"}**`, 2],
      italic: [`*${sel || "spell name"}*`, 1],
      list: [`${a && ta.value[a - 1] !== "\n" ? "\n\n" : ""}- ${sel || "First item"}\n- Second item\n`, 0],
      table: [`${a && ta.value[a - 1] !== "\n" ? "\n\n" : ""}| d6 | Effect |\n| --- | --- |\n| 1–2 | ${sel || "First result"} |\n| 3–4 | Second result |\n| 5–6 | Third result |\n\n`, 0]
    };
    const [text] = snippets[kind];
    ta.setRangeText(text, a, b, "end");
    ta.focus();
    this.setField("effect", ta.value);
    this.suggestions = null;
    this.paintPanel();
  }

  /* ---------------------------------------------- panels */

  paintPanel() {
    if (!this.root) return;
    this.root.querySelectorAll("[data-tab]").forEach(b => b.classList.toggle("active", b.dataset.tab === this.tab));
    const panel = this.root.querySelector(".aug-chg-panel");
    panel.innerHTML = { auto: () => this.autoHTML(), look: () => this.lookHTML(), suggest: () => this.suggestHTML(), history: () => this.historyHTML() }[this.tab]();
    this.bindPanel(panel);
  }

  autoHTML() {
    const { result, check, error } = previewFor(this.item, this.draft.effect);
    const now = buildLines(result), was = buildLines(this.base);
    const lower = list => list.map(s => s.toLowerCase());
    const added = now.filter(s => !lower(was).includes(s.toLowerCase()));
    const removed = was.filter(s => !lower(now).includes(s.toLowerCase()));
    const [label, explain] = STATUS[check.status] ?? STATUS.text;
    const override = getReview(this.item)?.override;
    const changed = added.length || removed.length;
    return `<div class="aug-chg-auto st-${check.status}">
      <div class="aug-chg-status"><span class="aug-chg-pill">${esc(label)}</span><span>${esc(explain)}</span></div>
      ${error ? `<p class="aug-chg-warn">${esc(error.message)}</p>` : ""}
      ${override ? `<p class="aug-chg-note"><i class="fas fa-user-pen"></i> Your edits from the audit window are applied on top of this.</p>` : ""}
      <h3>${this.dirty ? "Compared with the saved text" : "Saved text"}</h3>
      ${!this.dirty ? `<p class="aug-chg-muted">Change the text and this shows what the module would build differently.</p>`
        : changed ? `<ul class="aug-chg-diff">${added.map(s => `<li class="add">${esc(s)}</li>`).join("")}${removed.map(s => `<li class="del">${esc(s)}</li>`).join("")}</ul>`
        : `<p class="aug-chg-same"><i class="fas fa-check"></i> Builds exactly the same as before.</p>`}
      <h3>Builds</h3>
      ${now.length ? `<ul class="aug-chg-list">${now.map(s => `<li>${esc(s)}</li>`).join("")}</ul>` : `<p class="aug-chg-muted">Nothing automated.</p>`}
      ${result.reminders?.length ? `<h3>Posted as reminders</h3><ul class="aug-chg-list rem">${result.reminders.map(r => `<li>${esc(r.text)}</li>`).join("")}</ul>` : ""}
      ${check.flags?.length ? `<h3>Worth a look</h3><ul class="aug-chg-list flags">${check.flags.map(f => `<li>${esc(f.message)}</li>`).join("")}</ul>` : ""}
    </div>`;
  }

  lookHTML() {
    const html = describeAugmentHTML({ ...this.draft, rarityLabel: RARITIES[getRarity(this.item)]?.label ?? "" });
    return `<div class="aug-chg-look">${html || `<p class="aug-chg-muted">Nothing written yet.</p>`}</div>`;
  }

  async findSuggestions() {
    this.suggestions = "loading";
    this.paintPanel();
    const spells = await spellNames();
    const text = this.draft.effect;
    const base = previewFor(this.item, text).result;
    this.suggestions = suggestFormatting(text, { style: this.style, spells }).map(s => {
      const after = previewFor(this.item, applySuggestions(text, [s])).result;
      return { ...s, safe: sameBuild(base, after), before: buildLines(base), after: buildLines(after) };
    });
    this.suggestionsFor = text;
    this.picked = new Set();
    this.paintPanel();
  }

  suggestHTML() {
    const head = `<div class="aug-chg-sug-head">
      <label>Style <select name="style">
        <option value="2024" ${this.style === "2024" ? "selected" : ""}>2024 books (capitalised rules terms)</option>
        <option value="2014" ${this.style === "2014" ? "selected" : ""}>2014 books (lower case)</option></select></label>
      <button type="button" data-sug="find"><i class="fas fa-rotate"></i> ${this.suggestions ? "Look again" : "Find suggestions"}</button></div>`;
    if (this.suggestions === "loading") return `${head}<p class="aug-chg-muted"><i class="fas fa-spinner fa-spin"></i> Reading the text…</p>`;
    if (!this.suggestions) return `${head}<p class="aug-chg-muted">Suggests wording and formatting in the style of the official books: full ability names,
      “20-foot Cone”, dice, capitalisation, italic spell names, tables for roll results and more. Nothing changes until you tick a suggestion and press Apply.
      Each one is checked against the automation, so you can see if it would change what the module builds.</p>`;
    if (!this.suggestions.length) return `${head}<p class="aug-chg-same"><i class="fas fa-check"></i> Nothing to suggest. This already reads like the books.</p>`;
    const text = this.suggestionsFor;
    let group = null;
    const rows = this.suggestions.map((s, i) => {
      const g = s.group !== group ? `<h3>${esc(group = s.group)}</h3>` : "";
      const examples = s.edits.slice(0, 2).map(e => {
        const x = editExcerpt(text, e);
        return `<div class="aug-chg-ex">${esc(x.before)}<del>${esc(x.removed)}</del><ins>${esc(x.added)}</ins>${esc(x.after)}</div>`;
      }).join("") + (s.edits.length > 2 ? `<div class="aug-chg-muted">and ${s.edits.length - 2} more</div>` : "");
      const low = l => l.map(x => x.toLowerCase());
      const adds = s.after.filter(x => !low(s.before).includes(x.toLowerCase()));
      const drops = s.before.filter(x => !low(s.after).includes(x.toLowerCase()));
      const effect = s.safe ? `<span class="aug-chg-safe"><i class="fas fa-check"></i> automation unchanged</span>`
        : `<span class="${drops.length ? "aug-chg-unsafe" : "aug-chg-adds"}"><i class="fas ${drops.length ? "fa-triangle-exclamation" : "fa-circle-plus"}"></i> ${drops.length ? "changes the automation" : "adds automation"}</span>
          <ul class="aug-chg-diff small">${adds.map(x => `<li class="add">${esc(x)}</li>`).join("")}${drops.map(x => `<li class="del">${esc(x)}</li>`).join("")}</ul>`;
      return `${g}<label class="aug-chg-sug${this.picked.has(i) ? " on" : ""}">
        <input type="checkbox" data-sug-i="${i}" ${this.picked.has(i) ? "checked" : ""}>
        <div><b>${esc(s.label)}</b>${s.count > 1 ? ` <small>×${s.count}</small>` : ""} ${effect}
          ${s.reason ? `<p>${esc(s.reason)}</p>` : ""}${examples}</div></label>`;
    }).join("");
    const n = this.picked.size;
    return `${head}<div class="aug-chg-sug-bar">
        <button type="button" data-sug="safe"><i class="fas fa-check-double"></i> Tick the safe ones</button>
        <button type="button" data-sug="none"><i class="far fa-square"></i> None</button>
        <button type="button" data-sug="apply" class="aug-chg-apply" ${n ? "" : "disabled"}><i class="fas fa-check"></i> Apply ${n || ""} ticked</button></div>
      <div class="aug-chg-sugs">${rows}</div>`;
  }

  historyHTML() {
    const h = this.item.flags?.[MODULE_ID]?.history ?? [];
    const list = h.length ? h : [{ ...this.saved, at: null, by: "", note: "Current text (no changes recorded yet)" }];
    const cur = this.saved;
    const isCurrent = v => effectKey(v.effect) === effectKey(cur.effect) && (v.physical ?? "") === cur.physical && (v.unlock ?? "") === cur.unlock;
    const firstCurrent = list.findIndex(isCurrent);
    return `<p class="aug-chg-muted">Every saved change is kept here (the last ${HISTORY_MAX}, plus the original). Load a version into the editor to see what it builds, then save it to go back to it.</p>
      <div class="aug-chg-hist">${list.map((v, i) => `<div class="aug-chg-ver${i === firstCurrent ? " current" : ""}">
        <div class="aug-chg-ver-head"><b>${esc(when(v.at))}</b>${v.by ? ` <span>by ${esc(v.by)}</span>` : ""}
          ${i === firstCurrent ? `<span class="aug-chg-cur">current</span>` : ""}<em>${esc(v.note ?? "")}</em>
          <span class="aug-chg-ver-btns">
            <button type="button" data-hist-cmp="${i}"><i class="fas fa-code-compare"></i> Compare</button>
            <button type="button" data-hist-load="${i}"><i class="fas fa-file-import"></i> Load</button></span></div>
        ${this.compare === i ? `<div class="aug-chg-cmp"><small>Differences from the text in the editor (<del>removed</del> / <ins>added</ins> by going back):</small>
<p>${diffHTML(this.draft.effect, v.effect ?? "")}</p>
          ${(v.physical ?? "") !== this.draft.physical ? `<p><small>Physical:</small> ${diffHTML(this.draft.physical, v.physical ?? "")}</p>` : ""}
          ${(v.unlock ?? "") !== this.draft.unlock ? `<p><small>Unlock:</small> ${diffHTML(this.draft.unlock, v.unlock ?? "")}</p>` : ""}</div>` : ""}
      </div>`).join("")}</div>`;
  }

  bindPanel(panel) {
    panel.querySelector('[name="style"]')?.addEventListener("change", ev => {
      this.style = ev.target.value;
      try { localStorage.setItem(STYLE_KEY, this.style); } catch (e) { /* ignore */ }
      this.findSuggestions();
    });
    panel.querySelectorAll("[data-sug]").forEach(b => b.addEventListener("click", () => {
      const act = b.dataset.sug;
      if (act === "find") return this.findSuggestions();
      if (act === "safe") this.picked = new Set(this.suggestions.map((s, i) => (s.safe ? i : -1)).filter(i => i >= 0));
      if (act === "none") this.picked = new Set();
      if (act === "apply") {
        const chosen = [...this.picked].map(i => this.suggestions[i]);
        this.setField("effect", applySuggestions(this.suggestionsFor, chosen));
        ui.notifications.info(`Applied ${chosen.length} suggestion${chosen.length === 1 ? "" : "s"}. Check the Automation tab, then save.`);
        return this.findSuggestions();
      }
      this.paintPanel();
    }));
    panel.querySelectorAll("[data-sug-i]").forEach(box => box.addEventListener("change", () => {
      const i = Number(box.dataset.sugI);
      if (box.checked) this.picked.add(i); else this.picked.delete(i);
      this.paintPanel();
    }));
    const list = () => this.item.flags?.[MODULE_ID]?.history?.length ? this.item.flags[MODULE_ID].history : [{ ...this.saved, at: null }];
    panel.querySelectorAll("[data-hist-cmp]").forEach(b => b.addEventListener("click", () => {
      const i = Number(b.dataset.histCmp);
      this.compare = this.compare === i ? null : i;
      this.paintPanel();
    }));
    panel.querySelectorAll("[data-hist-load]").forEach(b => b.addEventListener("click", () => {
      const v = list()[Number(b.dataset.histLoad)];
      if (!v) return;
      for (const k of ["physical", "effect", "unlock"]) this.setField(k, v[k] ?? "");
      this.loadedFrom = v.at ?? "original";
      this.suggestions = null;
      this.compare = null;
      this.tab = "auto";
      ui.notifications.info("Loaded that version into the editor. Check what it builds, then save to go back to it.");
      this.paintPanel();
    }));
  }

  /* ---------------------------------------------- saving */

  async save() {
    if (!this.dirty) return ui.notifications.info("Nothing has changed.");
    const draft = { physical: this.draft.physical.trim(), effect: this.draft.effect.trim(), unlock: this.draft.unlock.trim() };
    if (!draft.effect) return ui.notifications.warn("The effect can't be empty.");
    const withCopies = this.root.querySelector('[name="copies"]')?.checked ?? false;
    const items = withCopies ? augmentFamily(this.item) : [this.item];
    const editable = items.filter(i => i.isOwner);
    if (editable.length < items.length) ui.notifications.warn(`You can't change ${items.length - editable.length} of the copies (not yours); they were skipped.`);
    const guarded = editable.filter(isProtected);
    const choice = guarded.length ? await confirmProtected(guarded, { verb: "rebuild" }) : "all";
    if (choice === null) return;
    const note = this.root.querySelector('[name="note"]')?.value.trim()
      || (this.loadedFrom ? `Went back to the version from ${this.loadedFrom === "original" ? "before tracking began" : when(this.loadedFrom)}` : "Edited in Change augment");
    const btn = this.root.querySelector('[data-act="save"]');
    btn.disabled = true;
    let rebuilt = 0, kept = 0;
    try {
      for (const it of editable) {
        let desc = mergeDescription(it.system?.description?.value ?? "", describeAugmentHTML({ ...draft, rarityLabel: RARITIES[getRarity(it)]?.label ?? "" }));
        const holder = it.parent ? equippedBy(it) : null;
        if (holder) desc = addBanner(desc, holder.name);
        await it.update({
          "system.description.value": desc,
          [`flags.${MODULE_ID}.effect`]: draft.effect,
          [`flags.${MODULE_ID}.physical`]: draft.physical,
          [`flags.${MODULE_ID}.unlock`]: draft.unlock,
          [`flags.${MODULE_ID}.history`]: historyWith(it, draft, note)
        }, { augmentsEditor: true });
        if (it.system?.activities === undefined) continue;
        if (isProtected(it) && choice !== "all") { kept++; continue; }
        await applyAutomation(it, null, { quiet: true });
        rebuilt++;
      }
    } catch (err) {
      console.error(`${MODULE_ID} | Change augment`, err);
      ui.notifications.error(`Couldn't save ${this.item.name}: ${err.message}`);
      btn.disabled = false;
      return;
    }
    btn.disabled = false;
    this.saved = versionOf(this.item);
    this.draft = { ...this.saved };
    this.base = previewFor(this.item, this.saved.effect).result;
    this.loadedFrom = null;
    const noteEl = this.root.querySelector('[name="note"]');
    if (noteEl) noteEl.value = "";
    this.markDirty();
    this.paintPanel();
    ui.notifications.info(`${this.item.name}: saved${editable.length > 1 ? ` on ${editable.length} copies` : ""}, automation rebuilt${kept ? ` (${kept} hand-checked cop${kept === 1 ? "y" : "ies"} left as they were)` : ""}.`);
  }

  async close(options) {
    if (this.dirty && !options?.force) {
      const DialogV2 = foundry.applications?.api?.DialogV2;
      const ok = DialogV2 ? await DialogV2.confirm({ window: { title: "Unsaved changes" }, content: "<p>Close without saving your changes?</p>", rejectClose: false }) : true;
      if (!ok) return this;
    }
    return super.close(options);
  }
} : null;

export function openChangeAugment(item) {
  if (!item || !isAugment(item)) return;
  if (!ChangeAugment) return ui.notifications.warn("Change augment needs Foundry v13 or newer.");
  const open = foundry.applications.instances?.get(changeWindowId(item));
  (open ?? new ChangeAugment(item)).render({ force: true });
}

/* -------------------------------------------- */
/*  Edits made anywhere else                     */
/* -------------------------------------------- */

async function rebuildAfterSheetEdit(item) {
  if (item.system?.activities === undefined) return;
  if (isProtected(item)) {
    const choice = await confirmProtected([item], { verb: "rebuild" });
    if (choice !== "all") return ui.notifications.info(`${item.name}: your text is saved; its automation was left as it was.`);
  }
  const result = await applyAutomation(item, null, { quiet: true });
  const lines = buildLines(result);
  ui.notifications.info(`${item.name}: automation rebuilt from your edit. ${lines.length ? `Builds: ${lines.join("; ")}` : "Nothing in it could be automated."}`);
}

export function registerChangeAugment() {
  // A changed description: keep the stored effect text in step, record the old version, then rebuild.
  Hooks.on("preUpdateItem", (item, changes, options) => {
    if (options?.augmentsEditor || options?.[MODULE_ID] || !isAugment(item)) return;
    const html = foundry.utils.getProperty(changes, "system.description.value") ?? changes?.["system.description.value"];
    if (typeof html !== "string") return;
    const next = effectFromDescription(html);
    if (!next) {
      // The bold "Effect." label was removed: the module can't find the new effect text.
      if (effectFromDescription(item.system?.description?.value ?? "")) {
        ui.notifications.warn(`${item.name}: the bold "Effect." label is gone, so the module keeps using the old effect text. Put the label back, or use Change augment.`, { permanent: true });
      }
      return;
    }
    if (effectKey(next) === effectKey(getEffectText(item))) return;
    const F = item.flags?.[MODULE_ID] ?? {};
    foundry.utils.setProperty(changes, `flags.${MODULE_ID}.effect`, next);
    foundry.utils.setProperty(changes, `flags.${MODULE_ID}.history`,
      historyWith(item, { effect: next, physical: F.physical ?? "", unlock: F.unlock ?? "" }, "Edited on the item sheet"));
    options.augmentsTextEdited = true;
  });
  Hooks.on("updateItem", (item, changes, options, userId) => {
    if (options?.augmentsTextEdited && userId === game.user.id) rebuildAfterSheetEdit(item);
  });

  // Right-click an augment in the Items sidebar.
  const fromLi = li => {
    const el = li instanceof HTMLElement ? li : li?.[0] ?? li;
    const id = el?.dataset?.entryId ?? el?.dataset?.documentId;
    return id ? game.items.get(id) : null;
  };
  const entry = {
    name: "Change augment", label: "Change augment",
    icon: '<i class="fas fa-pen-to-square"></i>',
    condition: li => { const it = fromLi(li); return !!it && isAugment(it) && it.isOwner; },
    callback: li => openChangeAugment(fromLi(li))
  };
  for (const hook of ["getItemContextOptions", "getItemDirectoryEntryContext"]) {
    Hooks.on(hook, (app, options) => { if (Array.isArray(options) && !options.some(o => o.name === entry.name)) options.push(entry); });
  }
}
