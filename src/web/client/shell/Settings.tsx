import { useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
import type { WorkspaceLayout } from "../../shared/workspace";
import type { Preferences } from "../../shared/preferences";
import { ACCENTS, THEMES } from "../../shared/themes";
import type { AccentChoice, PaletteChoice } from "../../shared/themes";
import { ForceTuner } from "../graph/ForceTuner";
import { useFocusTrap } from "./FocusTrap";
import { keyHelp } from "./keys.model";

const CATEGORIES = ["General", "Appearance", "Interface", "Editor", "Files", "Backup"] as const;
function Row(props: { name: string; hint: string; children: ComponentChildren }) {
  return <label class="weave-setting-row"><span><strong>{props.name}</strong><small>{props.hint}</small></span>{props.children}</label>;
}

export function Settings(props: {
  compact: boolean; layout: WorkspaceLayout; info: { version: string; vaultRoot: string }; cwd: string; shortcut: string;
  onChange: (layout: WorkspaceLayout) => void; onRefresh: () => void; onClose: () => void;
}) {
  const [category, setCategory] = useState<typeof CATEGORIES[number]>("General");
  const trap = useFocusTrap();
  const p = props.layout.preferences;
  const update = (values: Partial<Preferences>): void => props.onChange({ ...props.layout, preferences: { ...p, ...values } });
  return <div class="weave-scrim weave-settings-scrim" onClick={props.onClose}>
    <div class="weave-settings" role="dialog" aria-modal="true" aria-label="Settings" tabIndex={-1}
      ref={trap.ref as { current: HTMLDivElement | null }} onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => void trap.onKeyDown(event as unknown as KeyboardEvent)}>
      <header><h2>Settings</h2><button type="button" aria-label="Close settings" onClick={props.onClose}>×</button></header>
      <nav aria-label="Settings categories">{props.compact ? <select class="weave-settings-category" aria-label="Settings category" value={category} onChange={(event) => setCategory(event.currentTarget.value as typeof category)}>{CATEGORIES.map((name) => <option key={name} value={name}>{name}</option>)}</select> : CATEGORIES.map((name) => <button type="button" key={name} aria-current={category === name ? "page" : undefined} onClick={() => setCategory(name)}>{name}</button>)}</nav>
      <section aria-label={`${category} settings`}><h3>{category}</h3>
        {category === "General" ? <>
          <p>Pi Weave {props.info.version}</p>
          <dl class="weave-settings-locations"><dt>Vault</dt><dd>{props.info.vaultRoot || "Loading…"}</dd><dt>Repository</dt><dd>{props.cwd}</dd></dl>
          <div class="weave-settings-actions"><button type="button" onClick={props.onRefresh}>Refresh workspace</button><a href="https://github.com/EranYonai/pi-weave#readme" target="_blank" rel="noreferrer">Documentation ↗</a></div>
          <details><summary tabIndex={0}>Keyboard shortcuts</summary>{keyHelp(props.shortcut.slice(0, -1)).map((group) => <div key={group.title}><h4>{group.title}</h4>{group.entries.map((entry) => <div class="weave-key-row" key={entry.combo}><kbd>{entry.combo}</kbd><span>{entry.what}</span></div>)}</div>)}</details>
        </> : null}
        {category === "Appearance" ? <>
          <Row name="Color scheme" hint="System follows your device and uses your chosen light and dark themes."><select aria-label="Color scheme" value={props.layout.theme === "system" ? "system" : THEMES[props.layout.theme].scheme} onChange={(event) => props.onChange({ ...props.layout, theme: event.currentTarget.value === "system" ? "system" : event.currentTarget.value === "light" ? p.lightTheme : p.darkTheme })}><option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option></select></Row>
          {(["light", "dark"] as const).map((scheme) => <Row key={scheme} name={`${scheme === "light" ? "Light" : "Dark"} theme`} hint={`Used in ${scheme} mode and by the ribbon theme button.`}><select aria-label={`${scheme === "light" ? "Light" : "Dark"} theme`} value={p[`${scheme}Theme`]} onChange={(event) => {
            const theme = event.currentTarget.value as PaletteChoice;
            props.onChange({ ...props.layout, preferences: { ...p, [`${scheme}Theme`]: theme }, theme: props.layout.theme !== "system" && THEMES[props.layout.theme].scheme === scheme ? theme : props.layout.theme });
          }}>{Object.entries(THEMES).filter(([, theme]) => theme.scheme === scheme).map(([id, theme]) => <option key={id} value={id}>{theme.name}</option>)}</select></Row>)}
          <Row name="Accent color" hint="Choose independently of the theme. Shades adapt to light and dark backgrounds."><select aria-label="Accent color" value={p.accent} onChange={(event) => update({ accent: event.currentTarget.value as AccentChoice })}><option value="theme">Theme default</option>{Object.entries(ACCENTS).map(([id, accent]) => <option value={id} key={id}>{accent.name}</option>)}</select></Row>
          <Row name="Note font size" hint="Applies to reading and editing notes."><span class="weave-setting-range"><input aria-label="Note font size" type="range" min={12} max={22} step={1} value={p.fontSize} onInput={(event) => update({ fontSize: Number(event.currentTarget.value) })} /><output>{p.fontSize}px</output></span></Row>
        </> : null}
        {category === "Interface" ? <>
          <Row name="Notes sidebar" hint="Show files and recent notes."><input type="checkbox" checked={props.layout.treeVisible} onChange={(event) => props.onChange({ ...props.layout, treeVisible: event.currentTarget.checked })} /></Row>
          <Row name="Context sidebar" hint="Show links, backlinks, and related items."><input type="checkbox" checked={props.layout.contextVisible} onChange={(event) => props.onChange({ ...props.layout, contextVisible: event.currentTarget.checked })} /></Row>
          <Row name="Color graph by group" hint="Give each containment group its own color."><input type="checkbox" checked={p.groupColors} onChange={(event) => update({ groupColors: event.currentTarget.checked })} /></Row>
          <h4>Graph layout</h4><p class="weave-settings-hint">Adjust the graph live. Your choices are saved for this workspace.</p>
          <ForceTuner forces={p.forces} onChange={(forces) => update({ forces })} />
        </> : null}
        {category === "Editor" ? <>
          <Row name="Spellcheck" hint="Use your browser or device’s spellchecker while editing."><input type="checkbox" checked={p.spellcheck} onChange={(event) => update({ spellcheck: event.currentTarget.checked })} /></Row>
          <Row name="Readable line length" hint="Keep note text in a comfortable reading column."><input type="checkbox" checked={p.readable} onChange={(event) => update({ readable: event.currentTarget.checked })} /></Row>
          <Row name="Open notes in editing mode" hint="Newly opened notes start in the editor. Existing drafts are preserved."><input type="checkbox" checked={p.defaultEdit} onChange={(event) => update({ defaultEdit: event.currentTarget.checked })} /></Row>
        </> : null}
        {category === "Files" ? <>
          <Row name="On startup" hint="Choose which tabs appear when you reopen this workspace."><select aria-label="On startup" value={p.startup} onChange={(event) => update({ startup: event.currentTarget.value as Preferences["startup"] })}><option value="restore">Restore open tabs</option><option value="empty">Start with an empty tab</option></select></Row>
          <Row name="Focus new tabs" hint="Switch to notes opened in a new tab, including from the graph."><input type="checkbox" checked={p.focusNewTabs} onChange={(event) => update({ focusNewTabs: event.currentTarget.checked })} /></Row>
          <h4>Deleting files</h4><p>Deleting a note or folder removes it from the vault after confirmation. Download a backup before deleting anything you may need again.</p>
        </> : null}
        {category === "Backup" ? <>
          <h4>Download your vault</h4><p>Save a ZIP containing the vault’s files and folders, including notes, metadata, and attachments. Linked files and folders are included as files.</p>
          <p>Save any unsaved edits first. The download contains files saved on disk. Backups are manual; store the ZIP somewhere safe.</p>
          <a class="weave-settings-download" href="/api/backup" download>Download vault ZIP</a>
        </> : null}
      </section>
    </div>
  </div>;
}
