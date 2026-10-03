/** Tabbed workspace furniture; the graph keeps its existing palette and renderer. */
export const WORKSPACE_CSS = `
.weave-workbench{position:relative;display:flex;min-height:0;overflow:hidden;background:var(--weave-page)}
.weave-workbench button{font:inherit;color:inherit;cursor:pointer}
.weave-workbench button:focus-visible,.weave-workbench summary:focus-visible{outline:2px solid var(--weave-accent);outline-offset:-2px}
.weave-workbench button:disabled{opacity:.35;cursor:default}
.weave-ribbon{width:44px;flex:none;display:flex;align-items:center;flex-direction:column;gap:8px;padding:12px 0;background:var(--weave-panel);border-right:1px solid var(--weave-line)}
.weave-ribbon button{width:32px;height:32px;border:0;border-radius:var(--weave-radius);background:transparent;font-size:var(--weave-px-display);color:var(--weave-dim)}
.weave-ribbon button:hover,.weave-ribbon button[aria-pressed=true]{color:var(--weave-accent);background:var(--weave-new)}
.weave-ribbon-space{flex:1}
.weave-sidebar{flex:none;min-width:0;display:flex;flex-direction:column;background:var(--weave-panel);overflow:hidden}
.weave-sidebar-heading{display:flex;align-items:center;gap:8px;height:46px;flex:none;padding:0 12px;color:var(--weave-dim);font-size:var(--weave-px-row)}
.weave-sidebar-heading button{border:0;background:none;padding:7px 6px;border-radius:var(--weave-radius);color:var(--weave-dim)}
.weave-sidebar-heading button[aria-pressed=true]{color:var(--weave-fg);background:var(--weave-raise)}
.weave-sidebar-heading button:last-child{margin-left:auto}
.weave-sidebar .weave-tree-controls{padding:4px 12px 10px;gap:5px;flex-wrap:wrap;border:0}
.weave-sidebar .weave-filter{height:29px;flex-basis:100%;background:var(--weave-bg);border-radius:var(--weave-radius)}
.weave-sidebar .weave-row{min-height:32px;border-radius:var(--weave-radius);font-size:var(--weave-px-base)}
.weave-sidebar [role=tree]{padding:0 8px}
.weave-sidebar .weave-meta{font-size:var(--weave-px-caption);opacity:.65}
.weave-sidebar .weave-tree-count{border:0;padding:8px 14px}
.weave-vault-label{margin-top:auto;padding:14px 16px;border-top:1px solid var(--weave-line);display:flex;flex-direction:column;gap:4px;overflow:hidden}
.weave-vault-label span{font-size:var(--weave-px-caption);color:var(--weave-faint);text-transform:uppercase;letter-spacing:.08em}
.weave-vault-label strong{font-size:var(--weave-px-row);font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.weave-recents{display:flex;flex-direction:column;gap:3px;padding:6px 10px;overflow:auto}
.weave-recents button{display:flex;align-items:center;gap:8px;width:100%;text-align:left;background:none;border:0;padding:9px;border-radius:var(--weave-radius);overflow:hidden}
.weave-recents button:hover{background:var(--weave-new)}
.weave-recents button[aria-current=page]{background:var(--weave-raise);color:var(--weave-fg)}
.weave-recents .weave-recent-label{min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.weave-workspace-divider{flex:none;width:4px;background:var(--weave-panel);cursor:col-resize;touch-action:none;z-index:3}
.weave-workspace-divider:hover,.weave-workspace-divider:focus-visible{background:var(--weave-accent)}
.weave-workspace-divider[aria-orientation=horizontal]{width:auto;height:4px;cursor:row-resize}
.weave-panes{display:grid;flex:1;min-width:0;min-height:0;overflow:hidden}
.weave-pane{min-width:0;min-height:0;display:grid;grid-template-rows:42px 36px minmax(0,1fr);overflow:hidden;background:var(--weave-page)}
.weave-pane[hidden]{display:none}
.weave-pane-drop{position:relative}
.weave-pane-drop::after{content:attr(data-drop-label);position:absolute;inset:4px;z-index:20;display:grid;place-items:center;pointer-events:none;border:2px dashed var(--weave-accent);border-radius:var(--weave-radius);color:var(--weave-accent);background:var(--weave-new)}
.weave-tabs{display:flex;align-items:stretch;min-width:0;overflow-x:auto;background:var(--weave-panel);gap:3px;padding:5px 6px 0;border-bottom:1px solid var(--weave-line);scrollbar-width:thin}
.weave-tab{display:flex;align-items:center;min-width:90px;max-width:210px;border-radius:var(--weave-radius) var(--weave-radius) 0 0;color:var(--weave-dim);flex-shrink:0;border-bottom:2px solid transparent}
.weave-tab-active{background:var(--weave-page);color:var(--weave-fg)}
.weave-pane-active .weave-tab-active{border-bottom-color:var(--weave-accent)}
.weave-tab button{border:0;background:none}
.weave-tab [role=tab]{display:flex;align-items:center;gap:8px;text-align:left;padding:8px 9px;min-width:0;height:100%;font-size:var(--weave-px-row)}
.weave-tab [role=tab]>span:nth-child(2){white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.weave-tab [role=tab]>span:first-child{color:var(--weave-faint)}
.weave-tab .weave-tab-close{margin-right:4px;padding:2px 5px;font-size:var(--weave-px-subhead);color:var(--weave-faint)}
.weave-tab-close:hover{color:var(--weave-fg);background:var(--weave-raise)}
.weave-dirty{font-size:var(--weave-px-prov);color:var(--weave-accent)}
.weave-new-tab{border:0;background:none;padding:4px 10px;font-size:var(--weave-px-display)!important;color:var(--weave-dim)!important}
.weave-pane-toolbar{display:flex;align-items:center;gap:5px;padding:0 10px;border-bottom:1px solid var(--weave-line);color:var(--weave-dim);font-size:var(--weave-px-row)}
.weave-pane-toolbar>button{width:26px;height:26px;border:0;background:none;border-radius:var(--weave-radius)}
.weave-pane-toolbar>button:hover{background:var(--weave-new)}
.weave-breadcrumb{flex:1;text-align:center;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;padding:0 8px;font-size:var(--weave-px-ui)}
.weave-pane-menu{position:relative}
.weave-pane-menu>summary{list-style:none;cursor:pointer;padding:5px 10px;font-size:var(--weave-px-subhead)}
.weave-pane-menu>summary::-webkit-details-marker{display:none}
.weave-pane-menu>div{position:absolute;right:0;top:100%;z-index:12;width:185px;padding:5px;display:flex;flex-direction:column;background:var(--weave-panel);border:1px solid var(--weave-line-strong);border-radius:var(--weave-radius)}
.weave-pane-menu button{text-align:left;border:0;background:none;padding:9px 10px;font-size:var(--weave-px-row)}
.weave-pane-menu button:hover{background:var(--weave-new)}
.weave-pane-content{min-width:0;min-height:0;display:flex;overflow:hidden;position:relative}
.weave-document{display:flex;min-width:0;min-height:0;flex:1}
.weave-document .weave-note{width:100%;border-left:0}
.weave-document .weave-note-head{position:static;padding:28px max(24px,calc((100% - 760px)/2)) 18px;border:0}
.weave-document .weave-note-title{font-size:var(--weave-px-display);letter-spacing:-.03em;margin-bottom:12px}
.weave-document .weave-note-body{padding:10px max(24px,calc((100% - 760px)/2)) 64px;font-size:var(--weave-px-subhead);line-height:1.8}
.weave-document .weave-note-body h1{font-size:var(--weave-px-display);line-height:1.4;margin-bottom:18px}
.weave-document .weave-note-body h2{font-size:var(--weave-px-title);margin-top:28px}
.weave-document .weave-note-editor{padding:14px 28px;min-height:220px;flex:1}
.weave-document .weave-note-tags{margin-top:12px}
.weave-document .weave-note-edit,.weave-document .weave-note-save{padding:5px 10px;border-radius:var(--weave-radius)}
.weave-welcome{align-self:center;margin:auto;padding:35px;max-width:560px;color:var(--weave-dim);line-height:1.7}
.weave-welcome-mark{font-size:var(--weave-px-display);color:var(--weave-accent)}
.weave-welcome h1{font-size:var(--weave-px-display);line-height:1.4;letter-spacing:-.025em;color:var(--weave-fg);font-weight:550}
.weave-welcome p{font-size:var(--weave-px-base);margin:14px 0 24px}
.weave-welcome>div{display:flex;gap:12px;flex-wrap:wrap}
.weave-welcome button{border:1px solid var(--weave-line-strong);background:var(--weave-panel);padding:9px 13px;border-radius:var(--weave-radius);font-size:var(--weave-px-row)}
.weave-welcome button:hover{border-color:var(--weave-accent)}
.weave-welcome kbd{color:var(--weave-faint);padding-left:16px}
.weave-sidebar-context .weave-rail{flex:1;border:0;overflow:auto;padding:6px 12px}
.weave-sidebar-context .weave-ctx-link{padding-top:7px;padding-bottom:7px}
.weave-graph-host{position:absolute;z-index:2;display:flex;background:var(--weave-bg)}
.weave-graph-host>.weave-graph{width:100%;height:100%;flex:1}
.weave-graph-preview{pointer-events:none;position:absolute;z-index:2;right:8px;bottom:64px;width:min(280px,calc(100% - 16px));box-sizing:border-box;display:flex;flex-direction:column;gap:8px;padding:10px 34px 10px 10px;background:var(--weave-panel);border:1px solid var(--weave-line-strong);border-radius:var(--weave-radius);box-shadow:0 6px 22px #0003}
.weave-graph-preview-info{display:flex;align-items:center;gap:8px;min-width:0}
.weave-graph-preview-copy{display:flex;flex-direction:column;min-width:0;gap:2px}
.weave-graph-preview-kind{font-size:var(--weave-px-caption);color:var(--weave-faint);text-transform:capitalize}
.weave-graph-preview-title{font-size:var(--weave-px-row);font-weight:550;line-height:1.35;overflow:hidden;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow-wrap:anywhere}
.weave-graph-preview-close{pointer-events:auto;position:absolute;right:5px;top:5px;width:24px;height:24px;border:0;border-radius:var(--weave-radius);background:transparent;font-size:18px;color:var(--weave-dim)}
.weave-graph-preview-close:hover{background:var(--weave-new);color:var(--weave-fg)}
.weave-graph-preview>.weave-chip{pointer-events:auto;align-self:flex-start;max-width:100%;white-space:normal;text-align:left}
.weave-footer{display:flex;align-items:center;min-width:0;background:var(--weave-panel);border-top:1px solid var(--weave-line);font-size:var(--weave-px-ui);color:var(--weave-faint)}
.weave-footer>.weave-status{flex:1;min-width:0;border:0}
.weave-footer>span{padding:4px 10px;white-space:nowrap}
.weave-footer>button{font:inherit;color:var(--weave-fg);background:none;border:0;padding:7px 12px;cursor:pointer}
@media(max-width:1049px){
  .weave-sidebar-context{position:absolute;right:0;top:0;bottom:0;z-index:10;border-left:1px solid var(--weave-line-strong)}
  .weave-workbench> .weave-workspace-divider[aria-label="Resize context sidebar"]{display:none}
}
@media(max-width:849px){
  .weave-sidebar-notes{position:absolute;left:44px;top:0;bottom:0;z-index:10;border-right:1px solid var(--weave-line-strong);box-shadow:8px 0 24px #0002}
  .weave-workbench>.weave-workspace-divider{display:none}
  .weave-panes{grid-template-columns:minmax(0,1fr)!important;grid-template-rows:minmax(0,1fr)!important}
  .weave-document .weave-note-head{padding:20px}
  .weave-document .weave-note-body{padding:10px 20px 40px}
}
`;
