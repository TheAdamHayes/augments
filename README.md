# AH 5E Augments (FoundryVTT)

Adds an **Augments** tab (DNA icon) to every dnd5e character sheet.

## Install
In Foundry: Add-on Modules > Install Module, then paste the manifest URL:
`https://github.com/TheAdamHayes/augments/releases/latest/download/module.json`

## Making augments
- **Bulk:** Items sidebar > **Import augments** (GM). Paste rows from your table:
  Name, Rarity, Physical Description, Effect, Unlock Mechanism (tabs, pipes or wide spaces between columns).
  Each row becomes an Equipment (Trinket) with its rarity set, an icon picked for it, and uses, activities and effects built from the effect text.
- **By hand:** tick the **Augment** property on an Equipment, Loot, Consumable, Weapon, Tool or Container item.
- Each augment's sheet has a panel at the top of its Description tab to set its **rarity** (Simple, Average, Complex, Perfect, Special) and, for the GM, a **Build automation** button.

## Playing
- Sockets: first at level 2, then every 3 levels (2, 5, 8, 11, 14, 17, 20). Configurable in module settings.
- The list below the sockets shows every augment in a player character's inventory. Search by name or filter by rarity.
- Drag a row into a socket to install it. If another player is carrying it, it moves to you (a GM must be online).
- Remove: right-click a socket, or drag it back into the list.
- Locking: after a long rest the sheet unlocks; press **Lock in** when done. GMs can always edit and unlock.

## How augments work on a character
Augments are Features. While one isn't socketed, its abilities are stored away and its effects are off, so
it doesn't appear in action lists or HUDs (including Argon Combat HUD). Socketing it switches everything on,
so a bonus-action augment shows up with your bonus actions. Socketed augments also show in the Features tab.

Using an augment (or right-click > Post reminders to chat) posts a card with:
- **Reminders** for anything not automated, tagged by type (Movement, Forced movement, Allies...).
- **Stack counter** for augments like Redline Engine, with +, - and reset buttons. Speed and damage scale with stacks.
  The player is prompted at the end of their turn in combat.
- **Effects for others**: drag onto a token or character sheet, or target tokens and click the crosshair.

GMs: **Update all augments** (Items sidebar) converts existing augments to Features and rebuilds every
augment with the current rules, keeping sockets, spent uses and anything added by hand.

## Automation
The effect text is scanned for phrases such as "PB uses per short rest", "As a bonus action", "+2d6 damage",
"1d6 + PB temporary hit points", "on a failed Dexterity save", "walking speed increases by 5 feet", "+1 AC",
"20-foot climbing speed", "hover" and "become invisible". Always-on bonuses become a passive effect; "While..." or
"After..." bonuses become an effect the player toggles on in the item's Effects tab. Save DCs are 8 + PB + Constitution.

## Macro API
`Augments.openImporter()`, `Augments.automate(item)`, `Augments.assignIcons()`, `Augments.analyze("effect text")`,
`Augments.collectAugments()`, `Augments.setLocked(actor, false)`.
