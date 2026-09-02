use std::{
    borrow::Cow,
    collections::{HashMap, VecDeque},
    fmt,
    path::PathBuf,
    sync::{Arc, Mutex},
};

use gpui::{
    App, AppContext, Context, Entity, FocusHandle, Focusable, IntoElement, ParentElement, Render,
    Styled, Window,
};
use gpui_component::v_flex;
use raw_window_handle::HasWindowHandle;
use serde_json::{Map, Value};
use wry::{
    NewWindowResponse, PageLoadEvent, WebViewBuilder,
    http::{Request, Response},
};

pub const HOME_URL: &str = "about:blank";
pub const MAX_TABS: usize = 12;
pub const MAX_NAVIGATION_URL_BYTES: usize = 8 * 1024;
pub const MAX_BRIDGE_MESSAGE_BYTES: usize = 64 * 1024;
pub const MAX_HTML_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_FRAME_MODULE_BYTES: usize = 512 * 1024;
pub const MAX_FRAME_SHOT_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_COMPONENT_REQUEST_BYTES: usize = 8 * 1024;
pub const MAX_COMPONENT_URL_BYTES: usize = 2 * 1024;
pub const MAX_COMPONENT_HEADERS: usize = 32;
pub const MAX_VISUAL_PICK_BYTES: usize = 8 * 1024;
pub const MAX_SQL_CHARS: usize = 8 * 1024;
pub const MAX_SQL_PARAMS: usize = 64;
pub const MAX_SQL_PARAMETER_BYTES: usize = 512 * 1024;
pub const MAX_EVENT_QUEUE: usize = 256;
pub const MAX_COMPONENT_VARIABLES: usize = 8;
pub const MAX_COMPONENT_VARIABLE_BYTES: usize = 64;
pub const MAX_EMMA_METHOD_BYTES: usize = 128;
pub const MAX_EMMA_CHANNEL_BYTES: usize = 128;
pub const MAX_COMPONENT_TITLE_BYTES: usize = 80;
pub const MAX_BROWSER_TITLE_CHARS: usize = 512;
pub const MAX_FAVICON_URL_BYTES: usize = 8 * 1024;
pub const COMPONENT_REVEAL_MS: u64 = 720;
pub const COMPONENT_REVEAL_CHARS: usize = 900;

const NATIVE_BROWSER_METADATA: &str = r###"(()=>{let queued=false,last="";const send=()=>{queued=false;const icon=document.querySelector('link[rel~="icon"]');const value={emma:"browser-metadata",title:String(document.title||"").slice(0,512),favicon:icon&&typeof icon.href==="string"?icon.href.slice(0,8192):null};const raw=JSON.stringify(value);if(raw===last)return;last=raw;if(globalThis.ipc&&typeof globalThis.ipc.postMessage==="function")globalThis.ipc.postMessage(raw)};const schedule=()=>{if(queued)return;queued=true;requestAnimationFrame(send)};addEventListener("DOMContentLoaded",schedule);addEventListener("load",schedule);new MutationObserver(schedule).observe(document.documentElement,{subtree:true,childList:true,attributes:true,attributeFilter:["href","rel"]});schedule()})()"###;

const COMPONENT_BRIDGE: &str = r###"<script>(()=>{const pending=new Map,subscriptions=new Map;let next=0;const send=value=>{if(!globalThis.ipc||typeof globalThis.ipc.postMessage!=="function")throw new Error("The component bridge is unavailable.");globalThis.ipc.postMessage(JSON.stringify(value))};const request=(capability,payload)=>new Promise((resolve,reject)=>{if(pending.size>=128){reject(new Error("The component bridge is busy."));return}const n=++next;pending.set(n,[resolve,reject]);try{send(Object.assign({capability,n},payload))}catch(error){pending.delete(n);reject(error)}});const componentFetch=(url,init={})=>request("componentFetch",{...(globalThis.__emmaComponentConfig?.id?{id:globalThis.__emmaComponentConfig.id}:{}),url,method:typeof init.method==="string"?init.method.toUpperCase():"GET",headers:init.headers&&typeof init.headers==="object"?init.headers:{},...(typeof init.body==="string"?{body:init.body}:{})});const emmaRequest=(method,params={})=>request("emmaRequest",{method,params:params&&typeof params==="object"&&!Array.isArray(params)?params:{}});const subscribe=(channel,listener)=>{if(typeof channel!=="string"||typeof listener!=="function")return()=>{};let set=subscriptions.get(channel);if(!set){if(subscriptions.size>=64)return()=>{};set=new Set;subscriptions.set(channel,set);try{send({capability:"emmaSubscribe",channel})}catch{subscriptions.delete(channel);return()=>{}}}set.add(listener);return()=>{set.delete(listener);if(!set.size)subscriptions.delete(channel)}};globalThis.__emmaReply=value=>{const pair=pending.get(value?.n);if(!pair)return;pending.delete(value.n);if(value.error){pair[1](new Error(String(value.error)));return}pair[0](Object.hasOwn(value,"value")?value.value:value.rows)};globalThis.__emmaEvent=value=>{const channel=typeof value?.channel==="string"?value.channel:typeof value?.event==="string"?value.event:typeof value?.emma==="string"?value.emma:"";const payload=Object.hasOwn(value||{},"value")?value.value:value;subscriptions.get(channel)?.forEach(listener=>{try{listener(payload)}catch{}})};globalThis.componentFetch=componentFetch;globalThis.emmaRequest=emmaRequest;globalThis.subscribe=subscribe;globalThis.emma={request:emmaRequest,componentFetch}})()</script>"###;

const COMPONENT_CONTRACT_BRIDGE: &str = r###"<script>(()=>{const legacy=globalThis.componentFetch;const exact=value=>{if(!value||typeof value!=="object"||Array.isArray(value))return Promise.reject(new Error("The component fetch request is invalid."));const id=typeof value.id==="string"?value.id:"";const configId=typeof globalThis.__emmaComponentConfig?.id==="string"?globalThis.__emmaComponentConfig.id:"";if(!id||!configId||id!==configId)return Promise.reject(new Error("The component fetch request is not for this component."));const request=value.request;if(!request||typeof request!=="object"||Array.isArray(request)||typeof request.url!=="string")return Promise.reject(new Error("The component fetch request is invalid."));const init={...request,id};delete init.url;return legacy(request.url,init)};const componentFetchRequest=(url,init={})=>exact({id:globalThis.__emmaComponentConfig?.id,request:Object.assign({},init,{url})});globalThis.componentFetch=exact;globalThis.componentFetchRequest=componentFetchRequest;if(globalThis.emma)globalThis.emma.componentFetch=exact})()</script>"###;

const COMPONENT_NESTED_BRIDGE: &str = r###"<script>(()=>{const pending=new Map;let next=1000000000;const previous=globalThis.__emmaReply;const exact=value=>{if(!value||typeof value!=="object"||Array.isArray(value))return Promise.reject(new Error("The component fetch request is invalid."));const id=typeof value.id==="string"?value.id:"";const configId=typeof globalThis.__emmaComponentConfig?.id==="string"?globalThis.__emmaComponentConfig.id:"";if(!id||!configId||id!==configId)return Promise.reject(new Error("The component fetch request is not for this component."));const request=value.request;if(!request||typeof request!=="object"||Array.isArray(request)||typeof request.url!=="string")return Promise.reject(new Error("The component fetch request is invalid."));if(pending.size>=128)return Promise.reject(new Error("The component bridge is busy."));return new Promise((resolve,reject)=>{const n=next++;pending.set(n,[resolve,reject]);try{if(!globalThis.ipc||typeof globalThis.ipc.postMessage!=="function")throw new Error("The component bridge is unavailable.");globalThis.ipc.postMessage(JSON.stringify({capability:"componentFetch",n,id,request}))}catch(error){pending.delete(n);reject(error)}})};globalThis.__emmaReply=value=>{const pair=pending.get(value?.n);if(pair){pending.delete(value.n);if(value.error)pair[1](new Error(String(value.error)));else pair[0](Object.hasOwn(value,"value")?value.value:value.rows);return}if(typeof previous==="function")previous(value)};globalThis.componentFetch=exact;globalThis.componentFetchRequest=(url,init={})=>exact({id:globalThis.__emmaComponentConfig?.id,request:Object.assign({},init,{url})});if(globalThis.emma)globalThis.emma.componentFetch=exact})()</script>"###;

pub const PIP_WIDTH: f32 = 384.;
pub const PIP_HEIGHT: f32 = 300.;
pub const PIP_MIN_WIDTH: f32 = 320.;
pub const PIP_MIN_HEIGHT: f32 = 260.;
pub const PIP_EDGE: f32 = 12.;
pub const PIP_STACK: f32 = 18.;
pub const PIP_DEEPEST: usize = 3;
pub const PIP_TOP: f32 = PIP_EDGE + PIP_STACK * PIP_DEEPEST as f32;
pub const PIP_RAIL: f32 = 36.;

fn component_host_html(
    id: Option<&str>,
    title: &str,
    variables: &[String],
    expanded: bool,
) -> Vec<u8> {
    let id = id.map_or(String::new(), |value| value.to_owned());
    let title = title
        .chars()
        .filter(|value| !value.is_control())
        .take(MAX_COMPONENT_TITLE_BYTES)
        .collect::<String>();
    let title = if title.is_empty() {
        "Component".to_owned()
    } else {
        title
    };
    let variables = serde_json::to_string(variables).unwrap_or_else(|_| "[]".to_owned());
    let id = script_json(&id);
    let title = script_json(&title);
    let mut html = String::from(
        "<!doctype html><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><style>html,body{margin:0;min-height:100%;background:transparent}body{font:13px -apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif;color:#e8e6df}#emma-component{position:relative;min-height:100%;box-sizing:border-box}#root{min-height:100%;padding:8px;box-sizing:border-box}.built-body{animation:built-in 720ms ease-out both}.built-reveal{position:absolute;inset:0;z-index:2;overflow:hidden;margin:0;color:#ff6a3d;font:11px/1.05 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;word-break:break-all;pointer-events:none;opacity:.8;-webkit-mask-image:linear-gradient(90deg,#0000 0 30%,#000 42% 58%,#0000 70%);mask-image:linear-gradient(90deg,#0000 0 30%,#000 42% 58%,#0000 70%);-webkit-mask-size:320% 100%;mask-size:320% 100%;-webkit-mask-repeat:no-repeat;mask-repeat:no-repeat;animation:built-wipe 720ms linear forwards}@keyframes built-wipe{from{-webkit-mask-position:0 0;mask-position:0 0}to{-webkit-mask-position:100% 0;mask-position:100% 0}}@keyframes built-in{from{opacity:0;clip-path:inset(0 100% 0 0)}to{opacity:1;clip-path:inset(0 0 0 0)}}@media(prefers-reduced-motion:reduce){.built-body{animation:none}.built-reveal{animation-duration:1ms}}</style><div id=\"emma-component\"><div id=\"root\" aria-busy=\"true\"><p role=\"status\">Loading…</p></div><script>globalThis.__emmaComponentConfig={id:",
    );
    html.push_str(&id);
    html.push_str(",title:");
    html.push_str(&title);
    html.push_str(",variables:");
    html.push_str(&variables);
    html.push_str(",expanded:");
    html.push_str(if expanded { "true" } else { "false" });
    html.push_str("};</script>");
    html.push_str(COMPONENT_BRIDGE);
    html.push_str(COMPONENT_CONTRACT_BRIDGE);
    html.push_str(COMPONENT_NESTED_BRIDGE);
    html.push_str("<script>");
    html.push_str(include_str!("../assets/browser/react-runtime.js"));
    html.push_str("</script><script type=\"module\">");
    html.push_str("const config=globalThis.__emmaComponentConfig;const container=document.getElementById(\"root\");const host=document.getElementById(\"emma-component\");const setError=(error)=>{container.replaceChildren();const message=document.createElement(\"p\");message.className=\"built-error\";message.setAttribute(\"role\",\"status\");message.textContent=(config.title||\"Component\")+\" stopped while it was drawing.\";container.append(message);document.getElementById(\"built-reveal\")?.remove()};const root=ReactDOM.createRoot(container,setError);let Component;let ready=false;let expanded=!!config.expanded;const reveal=()=>{if(document.getElementById(\"built-reveal\")||expanded)return;const glyphs=\"░▒▓█▚▞╱╲┃┇┊+*=~-_/\\\\<>[]{}();:.,0123456789ABCDEFGHJKLMNPQRSTUVWXYZ\";const overlay=document.createElement(\"pre\");overlay.id=\"built-reveal\";overlay.className=\"built-reveal\";let text=\"\";for(let at=0;at<900;at+=1)text+=glyphs[Math.floor(Math.random()*glyphs.length)];overlay.textContent=text;overlay.addEventListener(\"animationend\",()=>overlay.remove(),{once:true});host.append(overlay)};const shoot=()=>{if(!ready||expanded||!config.id)return;const rect=host.getBoundingClientRect();if(rect.width<8||rect.height<8)return;try{globalThis.ipc.postMessage(JSON.stringify({capability:\"componentShot\",id:config.id,x:rect.x,y:rect.y,width:rect.width,height:rect.height}))}catch{}};const render=()=>{if(!Component)return;container.setAttribute(\"aria-busy\",\"false\");reveal();root.render(React.createElement(Component,{expanded}))};globalThis.__emmaSetExpanded=(value)=>{expanded=!!value;render()};addEventListener(\"message\",event=>{if(event.data?.emma===\"component-expanded\")globalThis.__emmaSetExpanded(event.data.on===true)});try{const loaded=await import(\"./module.js\");if(typeof loaded.default!==\"function\")throw new Error(\"A component module has to export default(api) and return a component.\");const bridge=emma;globalThis.__emmaComponentBridge=bridge;const api=Object.freeze({h:React.createElement,Fragment:React.Fragment,useState:React.useState,useReducer:React.useReducer,useEffect:React.useEffect,useLayoutEffect:React.useLayoutEffect,useMemo:React.useMemo,useRef:React.useRef,useCallback:React.useCallback,useContext:React.useContext,useImperativeHandle:React.useImperativeHandle,fetch:(url,init)=>globalThis.componentFetchRequest(url,init),variables:Array.isArray(config.variables)?Object.freeze(config.variables.slice()):[],emma:Object.freeze(bridge)});Component=loaded.default(api);if(typeof Component!==\"function\")throw new Error(\"The default export has to return a component function.\");ready=true;render();if(!expanded)setTimeout(shoot,880)}catch(error){setError(error)}</script></div>");
    html = html.replace(
        "const setError=(error)=>",
        "let renderingError=false;const setError=(error)=>",
    );
    html = html.replace(
        "platform:typeof navigator===\"object\"&&typeof navigator.userAgent===\"string\"?navigator.userAgent:\"darwin\"",
        "platform:\"darwin\"",
    );
    html = html.replace(
        "message.textContent=(config.title||\"Component\")+\" stopped while it was drawing.\";",
        "message.textContent=renderingError?(config.title||\"Component\")+\" stopped while it was drawing.\":(config.title||\"Component\")+\" could not run · \"+(error instanceof Error?error.message:String(error));",
    );
    html = html.replace(
        "const root=ReactDOM.createRoot(container,setError);",
        "const root=ReactDOM.createRoot(container,{onCaughtError:error=>{renderingError=true;setError(error)},onUncaughtError:error=>{renderingError=true;setError(error)},onRecoverableError:error=>{renderingError=true;setError(error)}});",
    );
    html = html.replace(
        "const bridge=emma;globalThis.__emmaComponentBridge=bridge;const api=Object.freeze({",
        "const bridge=emma;const bridgeMethods=\"request setOverlayPreferences setOverlayBusy setKeybinds onShortcutRequest completeShortcutRequest openOverlay setOverlayHeight onOverlaySurface movePill expandPill dismissOverlay openWorkspace resyncWindow voiceStatus transcribe onOpenSettings sendQuickCommand onQuickCommand onNewQuickSession onNotchHover updateReady installUpdate onUpdateReady onDelta onStep onCompacted onContextExperiment onRoutedModel onContextBreakdown startScreenAnnotation onScreenContext captureScreenContext getScreenAnnotationFrame finishScreenAnnotation cancelScreenAnnotation screenAnnotationStatus clearScreenAnnotation revealPath previewPath listArtifacts readArtifact saveArtifact deleteArtifact revealArtifact artifactSql onArtifactsChanged listComponents readComponent deleteComponent enableComponent expandComponent componentFetch shootComponent onComponentsChanged readVisual exportVisual listPlans listTaskLists setGoal updateGoal clearGoal onPlansChanged onTaskListsChanged exportThreadStats listFolders pluginCatalog addMarketplace removeMarketplace refreshMarketplace installPlugin uninstallPlugin pluginDetail trustPluginHooks onFolderAttached setupStatus openPrivacySettings demoQuickAsk pickVaultFolder detectVaults setVault vaultStatus installObsidian keep keepScreen listNotes readNote listNoteFolders createNoteFolder renameNoteFolder moveNote openInObsidian onNotesChanged resetData pickFolder forgetFolder listFolderFiles gitStatus gitReady gitInit gitHistory gitCommit gitDiscard gitRun gitMessage mobileStatus mobilePair mobileCancelPair mobileUnpair onMobileStatus machineSample listEditors openInEditor setWorktree worktreeList worktreeAdd worktreeRemove setBranch readFolderFile attachFiles attachData readAttachment clearThreadContext discoverAgentImports importAgentSources searchImportedSkills selectImportedSkill importedSkillStatus clearImportedSkill listImportedMcpServers stopComputerRun onComputerRunProgress setProviders testProvider setVerifier setToolSettings setZoom setTagger setHarnessExperiments setImprovements forceArm listToolTargets capabilityUsage onToolsChanged setThreadContext runCommand listBackground readBackground stopBackground onBackground listCliRuns readCliRun stopCliRun installedClis signInCli cliModels setCliRunModel sendCliRun onCliRuns browserStatus browserOpen browserNav browserPlace browserClips browserClipUse browserNewTab browserSelectTab browserCloseTab onBrowser onBrowserShow openTerminal writeTerminal resizeTerminal closeTerminal listTerminals readTerminal onTerminalData onTerminals harnessReport restartHarness onHarnessLog openLink listMemories deleteMemory listAgents listSpans livePartial threadTraces steerAgent stopAgent answerPermission threadChanges revertChange onAgents onSpans onPermissionAsk onPermissionResolved setZeroRetention listCredentials openRouterBalance deepseekBalance saveCredential fetchUrl clipPage loadUiPlugins onChanged offChanged\".split(\" \"),bridgeMethods.forEach(method=>{if(method in bridge)return;Object.defineProperty(bridge,method,{configurable:true,enumerable:true,value:method.startsWith(\"on\")?listener=>globalThis.subscribe(method,listener):(...args)=>globalThis.emmaRequest(method,args.length>1?args:args[0]??{})})});globalThis.__emmaComponentBridge=bridge;const api=Object.freeze({",
    );
    html = html.replace("emma:Object.freeze(bridge)", "emma:bridge");
    html = html.replace(
        "container.setAttribute(\"aria-busy\",\"false\");reveal();",
        "container.setAttribute(\"aria-busy\",\"false\");container.classList.add(\"built-body\");reveal();",
    );
    html = html.replace(
        "}catch(error){setError(error)}</script></div>",
        "}catch(error){renderingError=false;setError(error)}</script></div>",
    );
    html.into_bytes()
}

fn script_json(value: &str) -> String {
    serde_json::to_string(value)
        .unwrap_or_else(|_| "\"\"".to_owned())
        .replace('<', "\\u003c")
        .replace('>', "\\u003e")
        .replace('&', "\\u0026")
}

pub const APP_BRIDGE: &str = r###"<script>(()=>{const w=new Map();let n=0;addEventListener("message",(e)=>{const a=w.get(e.data?.n);if(e.source!==parent||!a)return;w.delete(e.data.n);e.data.error?a[1](new Error(e.data.error)):a[0](e.data.rows)});window.emma={sql:(sql,...params)=>new Promise((ok,no)=>{w.set(++n,[ok,no]);parent.postMessage({emma:"sql",n,sql,params},"*")})}})()</script>"###;

const NATIVE_APP_BRIDGE: &str = r###"<script>(()=>{const w=new Map();let n=0;const send=(value)=>{if(!globalThis.ipc||typeof globalThis.ipc.postMessage!=="function")throw new Error("The artifact bridge is unavailable.");globalThis.ipc.postMessage(JSON.stringify(Object.assign({capability:"artifactSql"},value)))};globalThis.__emmaReply=(value)=>{const a=w.get(value?.n);if(!a)return;w.delete(value.n);if(value.error){a[1](new Error(String(value.error)));return}const result=Object.hasOwn(value,"value")?value.value:value.rows;a[0](result&&typeof result==="object"&&Array.isArray(result.rows)?result.rows:result)};window.emma={sql:(sql,...params)=>new Promise((ok,no)=>{const id=++n;w.set(id,[ok,no]);try{send({n:id,sql,params})}catch(error){w.delete(id);no(error)}})}})()</script>"###;

const VISUAL_SHELL: &str = r###":root{--bg:#0e0e10;--surface:#131316;--surface-2:#17171a;--border:#e8e6df26;--border-strong:#e8e6df47;--text:#e8e6df;--text-2:#e8e6dfad;--text-3:#e8e6df8c;--rose:#ed7a9b;--orange:#ff6a3d;--lime:#c3d64b;--teal:#3fd8c0;--blue:#6faee6;--violet:#ae78f0;--accent:#ff6a3d;--font:Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;--font-mono:ui-monospace,SFMono-Regular,Menlo,monospace;color-scheme:dark}*{box-sizing:border-box}html{background:var(--bg)}body{margin:0;padding:12px;background:var(--bg);color:var(--text);font-family:var(--font);font-size:13px;line-height:1.45}svg,canvas,img{max-width:100%;height:auto}table{border-collapse:collapse;width:100%;font-size:12px}th,td{border-bottom:1px solid var(--border);padding:4px 6px;text-align:left}th{color:var(--text-3);font-weight:500}h1,h2,h3,h4{margin:0 0 6px;font-size:13px;font-weight:600}p{margin:0 0 8px;color:var(--text-2)}small{color:var(--text-3);font-size:11px}a{color:var(--accent)}[data-emma-pick] *{cursor:crosshair}[data-emma-lit]{outline:2px solid var(--accent);outline-offset:1px;background:#ff6a3d2e!important}"###;

const NATIVE_VISUAL_MEASURE: &str = r###"<script>(()=>{const send=(value)=>{if(globalThis.ipc&&typeof globalThis.ipc.postMessage==="function")globalThis.ipc.postMessage(JSON.stringify(value))};let last=0;const tell=()=>{const height=Math.ceil(document.body.scrollHeight);if(height===last)return;last=height;send({capability:"visualHeight",emma:"visual-height",height})};new ResizeObserver(tell).observe(document.body);addEventListener("load",tell);tell();let lit=null,picking=false;const light=(element)=>{if(lit===element)return;lit&&lit.removeAttribute("data-emma-lit");lit=element;lit&&lit.setAttribute("data-emma-lit","")};const name=(element)=>element.tagName.toLowerCase()+(element.id?"#"+element.id:"")+[...element.classList].map((one)=>"."+one).join("");const path=(element)=>{const parts=[];for(let at=element;at&&at!==document.body&&parts.length<3;at=at.parentElement)parts.unshift(name(at));return parts.join(" > ")};globalThis.__emmaSetPicking=(value)=>{picking=value===true;document.documentElement.toggleAttribute("data-emma-pick",picking);if(!picking)light(null)};addEventListener("message",event=>{if(event.data?.emma==="visual-pick")globalThis.__emmaSetPicking(event.data.on===true)});addEventListener("pointerover",(event)=>{if(picking&&event.target instanceof Element)light(event.target)},true);addEventListener("pointerdown",(event)=>{if(picking)event.preventDefault()},true);addEventListener("click",(event)=>{if(!picking||!(event.target instanceof Element))return;event.preventDefault();event.stopPropagation();const element=event.target;light(null);send({capability:"visualPick",emma:"visual-picked",label:path(element),html:element.outerHTML.slice(0,8192)});light(element)},true)})()</script>"###;

pub fn app_page(content: &str) -> String {
    let trimmed = content.trim_start();
    let offset = content.len() - trimmed.len();
    if let Some(index) = trimmed.find('>')
        && trimmed[..index]
            .to_ascii_lowercase()
            .starts_with("<!doctype")
    {
        let split = offset + index + 1;
        format!("{}{APP_BRIDGE}{}", &content[..split], &content[split..])
    } else {
        format!("{APP_BRIDGE}{content}")
    }
}

fn native_app_page(content: &str) -> String {
    let trimmed = content.trim_start();
    let offset = content.len() - trimmed.len();
    if let Some(index) = trimmed.find('>')
        && trimmed[..index]
            .to_ascii_lowercase()
            .starts_with("<!doctype")
    {
        let split = offset + index + 1;
        return format!(
            "{}{NATIVE_APP_BRIDGE}{}",
            &content[..split],
            &content[split..]
        );
    }
    format!("{NATIVE_APP_BRIDGE}{content}")
}

pub fn visual_page(html: &str) -> Result<String, SecurityError> {
    validate_visual_html(html)?;
    Ok(format!(
        "<!doctype html><meta charset=\"utf-8\"><style>{VISUAL_SHELL}</style>\n{html}\n{NATIVE_VISUAL_MEASURE}"
    ))
}

fn native_visual_page(html: &str) -> String {
    format!(
        "<!doctype html><meta charset=\"utf-8\"><style>{VISUAL_SHELL}</style>\n{html}\n{NATIVE_VISUAL_MEASURE}"
    )
}

fn validate_visual_html(html: &str) -> Result<(), SecurityError> {
    if html.is_empty() || html.len() > 96 * 1024 {
        return Err(SecurityError::HtmlTooLarge);
    }
    validate_frame_html(SurfaceKind::Visual, html)
}

fn validate_component_variables(variables: &[String]) -> Result<(), SecurityError> {
    if variables.len() > MAX_COMPONENT_VARIABLES
        || variables.iter().any(|value| {
            value.is_empty()
                || value.len() > MAX_COMPONENT_VARIABLE_BYTES
                || !value.bytes().enumerate().all(|(index, byte)| {
                    byte == b'_'
                        || byte.is_ascii_alphabetic()
                        || (index > 0 && byte.is_ascii_digit())
                })
        })
    {
        return Err(SecurityError::MessageInvalid);
    }
    Ok(())
}

fn validate_frame_files(files: &[(String, Vec<u8>)]) -> Result<(), SecurityError> {
    let mut total = 0usize;
    for (name, body) in files {
        let path = format!("/{name}");
        if !valid_frame_file_path(&path)
            || body.is_empty()
            || body.len() > MAX_FRAME_MODULE_BYTES
            || total.saturating_add(body.len()) > MAX_HTML_BYTES
        {
            return Err(SecurityError::PathNotAllowed);
        }
        total = total.saturating_add(body.len());
    }
    Ok(())
}

fn valid_frame_file_path(path: &str) -> bool {
    path.len() <= 512
        && path.starts_with('/')
        && path != "/"
        && !path.contains("//")
        && !path.contains('\\')
        && !path.contains("..")
        && !path
            .bytes()
            .any(|byte| byte.is_ascii_control() || byte.is_ascii_whitespace())
        && path.split('/').skip(1).all(|part| !part.is_empty())
}

fn artifact_file_content_type(name: &str) -> &'static str {
    match name.rsplit_once('.').map(|(_, extension)| extension) {
        Some("js" | "mjs" | "cjs") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("json") => "application/json; charset=utf-8",
        Some("html") => "text/html; charset=utf-8",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("woff") => "font/woff",
        Some("woff2") => "font/woff2",
        Some("txt") => "text/plain; charset=utf-8",
        Some("md") => "text/markdown; charset=utf-8",
        Some("csv") => "text/csv; charset=utf-8",
        _ => "application/octet-stream",
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SurfaceKind {
    Browser,
    Artifact,
    Component,
    Visual,
}

impl SurfaceKind {
    pub const fn id(self) -> &'static str {
        match self {
            Self::Browser => "browser",
            Self::Artifact => "artifact",
            Self::Component => "component",
            Self::Visual => "visual",
        }
    }

    pub const fn scheme(self) -> &'static str {
        match self {
            Self::Browser => "https",
            Self::Artifact => "emma-artifact",
            Self::Component => "emma-component",
            Self::Visual => "emma-visual",
        }
    }

    pub const fn requires_webview(self, content: SurfaceContent) -> bool {
        match content {
            SurfaceContent::PlainText | SurfaceContent::Markdown | SurfaceContent::Code => false,
            SurfaceContent::Svg | SurfaceContent::Mermaid => {
                matches!(self, Self::Browser | Self::Artifact | Self::Visual)
            }
            SurfaceContent::Html | SurfaceContent::Interactive => true,
        }
    }

    pub const fn allows(self, capability: BridgeCapability) -> bool {
        matches!(
            (self, capability),
            (Self::Artifact, BridgeCapability::ArtifactSql)
                | (Self::Component, BridgeCapability::ComponentFetch)
                | (Self::Component, BridgeCapability::ComponentShot)
                | (Self::Component, BridgeCapability::EmmaRequest)
                | (Self::Component, BridgeCapability::EmmaSubscribe)
                | (Self::Visual, BridgeCapability::VisualPick)
                | (Self::Visual, BridgeCapability::VisualHeight)
        )
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SurfaceContent {
    PlainText,
    Markdown,
    Code,
    Html,
    Svg,
    Mermaid,
    Interactive,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FrameAssets {
    surface: SurfaceKind,
    document: Option<Vec<u8>>,
    module: Option<Vec<u8>>,
    shot: Option<Vec<u8>>,
    files: Vec<(String, Vec<u8>)>,
    origin_csp: Option<String>,
    component_id: Option<String>,
    component_title: String,
    component_variables: Vec<String>,
    component_expanded: bool,
}

impl FrameAssets {
    pub fn document(surface: SurfaceKind, html: &str) -> Result<Self, SecurityError> {
        if !matches!(surface, SurfaceKind::Artifact | SurfaceKind::Visual) {
            return Err(SecurityError::PathNotAllowed);
        }
        validate_frame_html(surface, html)?;
        Ok(Self {
            surface,
            document: Some(html.as_bytes().to_vec()),
            module: None,
            shot: None,
            files: Vec::new(),
            origin_csp: None,
            component_id: None,
            component_title: String::new(),
            component_variables: Vec::new(),
            component_expanded: false,
        })
    }

    pub fn component(module: &[u8], shot: Option<&[u8]>) -> Result<Self, SecurityError> {
        Self::component_with_config(None, "Component", &[], false, module, shot)
    }

    pub fn component_with_config(
        id: Option<&str>,
        title: &str,
        variables: &[String],
        expanded: bool,
        module: &[u8],
        shot: Option<&[u8]>,
    ) -> Result<Self, SecurityError> {
        if module.is_empty() || module.len() > MAX_FRAME_MODULE_BYTES {
            return Err(SecurityError::HtmlTooLarge);
        }
        if shot.is_some_and(|value| value.len() > MAX_FRAME_SHOT_BYTES) {
            return Err(SecurityError::HtmlTooLarge);
        }
        if let Some(id) = id
            && !valid_capability_id(id)
        {
            return Err(SecurityError::HostNotAllowed);
        }
        validate_component_variables(variables)?;
        let title = title
            .chars()
            .filter(|value| !value.is_control())
            .take(MAX_COMPONENT_TITLE_BYTES)
            .collect::<String>();
        let title = if title.is_empty() {
            "Component".to_owned()
        } else {
            title
        };
        let origin_csp = id.map(|id| {
            format!(
                "default-src 'none'; script-src 'self' 'unsafe-inline' emma-component://{id}; style-src 'self' 'unsafe-inline' emma-component://{id}; img-src 'self' data: emma-component://{id}; font-src 'self' data:; connect-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'"
            )
        });
        Ok(Self {
            surface: SurfaceKind::Component,
            document: Some(component_host_html(id, &title, variables, expanded)),
            module: Some(module.to_vec()),
            shot: shot.map(ToOwned::to_owned),
            files: Vec::new(),
            origin_csp,
            component_id: id.map(ToOwned::to_owned),
            component_title: title,
            component_variables: variables.to_vec(),
            component_expanded: expanded,
        })
    }

    pub fn artifact_app(html: &str) -> Result<Self, SecurityError> {
        Self::artifact_app_with_origin(None, html, &[])
    }

    pub fn artifact_app_with_origin(
        id: Option<&str>,
        html: &str,
        files: &[(String, Vec<u8>)],
    ) -> Result<Self, SecurityError> {
        validate_frame_html(SurfaceKind::Artifact, html)?;
        validate_frame_files(files)?;
        if let Some(id) = id
            && !valid_capability_id(id)
        {
            return Err(SecurityError::HostNotAllowed);
        }
        let origin_csp = id.map(|id| {
            format!(
                "default-src 'none'; script-src 'unsafe-inline' emma-artifact://{id}; style-src 'unsafe-inline' emma-artifact://{id}; img-src data: emma-artifact://{id}; font-src data:; connect-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'"
            )
        });
        Ok(Self {
            surface: SurfaceKind::Artifact,
            document: Some(native_app_page(html).into_bytes()),
            module: None,
            shot: None,
            files: files.to_vec(),
            origin_csp,
            component_id: None,
            component_title: String::new(),
            component_variables: Vec::new(),
            component_expanded: false,
        })
    }

    pub fn visual_page(html: &str) -> Result<Self, SecurityError> {
        validate_visual_html(html)?;
        Ok(Self {
            surface: SurfaceKind::Visual,
            document: Some(native_visual_page(html).into_bytes()),
            module: None,
            shot: None,
            files: Vec::new(),
            origin_csp: None,
            component_id: None,
            component_title: String::new(),
            component_variables: Vec::new(),
            component_expanded: false,
        })
    }

    pub fn with_files(mut self, files: &[(String, Vec<u8>)]) -> Result<Self, SecurityError> {
        validate_frame_files(files)?;
        self.files = files.to_vec();
        if self.surface == SurfaceKind::Artifact && self.origin_csp.is_none() {
            self.origin_csp = Some(
                "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'".to_owned(),
            );
        }
        Ok(self)
    }

    pub fn artifact_module(mut self, module: &[u8]) -> Result<Self, SecurityError> {
        if module.is_empty() || module.len() > MAX_FRAME_MODULE_BYTES {
            return Err(SecurityError::HtmlTooLarge);
        }
        self.module = Some(module.to_vec());
        Ok(self)
    }

    pub fn visual_module(mut self, module: &[u8]) -> Result<Self, SecurityError> {
        if self.surface != SurfaceKind::Visual {
            return Err(SecurityError::PathNotAllowed);
        }
        if module.is_empty() || module.len() > MAX_FRAME_MODULE_BYTES {
            return Err(SecurityError::HtmlTooLarge);
        }
        self.module = Some(module.to_vec());
        Ok(self)
    }

    pub fn surface(&self) -> SurfaceKind {
        self.surface
    }

    pub fn component_id(&self) -> Option<&str> {
        self.component_id.as_deref()
    }

    pub fn component_title(&self) -> &str {
        &self.component_title
    }

    pub fn component_variables(&self) -> &[String] {
        &self.component_variables
    }

    pub const fn component_expanded(&self) -> bool {
        self.component_expanded
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BridgeCapability {
    ArtifactSql,
    ComponentFetch,
    ComponentShot,
    EmmaRequest,
    EmmaSubscribe,
    VisualPick,
    VisualHeight,
    OpenExternal,
}

impl BridgeCapability {
    fn parse(value: &str) -> Option<Self> {
        match value {
            "artifactSql" | "artifact-sql" | "sql" => Some(Self::ArtifactSql),
            "componentFetch" | "component-fetch" => Some(Self::ComponentFetch),
            "componentShot" | "component-shot" => Some(Self::ComponentShot),
            "emmaRequest" | "emma-request" | "request" => Some(Self::EmmaRequest),
            "emmaSubscribe" | "emma-subscribe" | "subscribe" => Some(Self::EmmaSubscribe),
            "visualPick" | "visual-pick" | "visual-picked" => Some(Self::VisualPick),
            "visualHeight" | "visual-height" => Some(Self::VisualHeight),
            "openExternal" | "open-external" => Some(Self::OpenExternal),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct BridgeMessage {
    pub capability: BridgeCapability,
    pub request_id: Option<u64>,
    pub payload: Map<String, Value>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct BridgeReply {
    pub request_id: u64,
    pub value: Option<Value>,
    pub error: Option<String>,
}

impl BridgeReply {
    pub fn ok(request_id: u64, value: Value) -> Self {
        Self {
            request_id,
            value: Some(value),
            error: None,
        }
    }

    pub fn failed(request_id: u64, error: impl Into<String>) -> Self {
        Self {
            request_id,
            value: None,
            error: Some(error.into()),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SecurityError {
    EmptyUrl,
    UrlTooLong,
    InvalidUrl,
    SchemeNotAllowed,
    HostNotAllowed,
    PathNotAllowed,
    MessageTooLarge,
    MessageInvalid,
    CapabilityNotAllowed,
    SqlEmpty,
    SqlTooLong,
    SqlMultipleStatements,
    SqlParametersInvalid,
    HtmlTooLarge,
}

impl fmt::Display for SecurityError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::EmptyUrl => "URL is empty",
            Self::UrlTooLong => "URL is too long",
            Self::InvalidUrl => "URL is invalid",
            Self::SchemeNotAllowed => "URL scheme is not allowed",
            Self::HostNotAllowed => "URL host is not allowed",
            Self::PathNotAllowed => "URL path is not allowed",
            Self::MessageTooLarge => "bridge message is too large",
            Self::MessageInvalid => "bridge message is invalid",
            Self::CapabilityNotAllowed => "bridge capability is not allowed",
            Self::SqlEmpty => "SQL statement is empty",
            Self::SqlTooLong => "SQL statement is too long",
            Self::SqlMultipleStatements => "SQL must contain one statement",
            Self::SqlParametersInvalid => "SQL parameters are invalid",
            Self::HtmlTooLarge => "HTML is too large",
        })
    }
}

impl std::error::Error for SecurityError {}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum NavigationDecision {
    Allow,
    OpenExternal(String),
    Block(SecurityError),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PopupDecision {
    NewTab(String),
    OpenExternal(String),
    Block(SecurityError),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DownloadDecision {
    OpenExternal(String),
    Block(SecurityError),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ExternalLinkDecision {
    OpenExternal(String),
    Block(SecurityError),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NativeEventKind {
    NavigationStarted,
    NavigationFinished,
    TitleChanged,
    FaviconChanged,
    PopupRequested,
    DownloadRequested,
    IpcMessage,
    NavigationBlocked,
    HistoryChanged,
}

#[derive(Clone, Debug, PartialEq)]
pub enum BrowserEvent {
    Navigated {
        tab_id: String,
        url: String,
    },
    Loading {
        tab_id: String,
        loading: bool,
    },
    TitleChanged {
        tab_id: String,
        title: String,
    },
    FaviconChanged {
        tab_id: String,
        favicon: Option<String>,
    },
    HistoryChanged {
        tab_id: String,
        can_go_back: bool,
        can_go_forward: bool,
    },
    PopupRequested {
        tab_id: String,
        url: String,
    },
    DownloadRequested {
        tab_id: String,
        url: String,
    },
    IpcMessage {
        tab_id: String,
        uri: String,
        body: String,
    },
    NavigationBlocked {
        tab_id: String,
        url: String,
        error: SecurityError,
    },
    Closed {
        tab_id: String,
    },
}

impl BrowserEvent {
    pub const fn kind(&self) -> NativeEventKind {
        match self {
            Self::Navigated { .. } => NativeEventKind::NavigationFinished,
            Self::Loading { loading: true, .. } => NativeEventKind::NavigationStarted,
            Self::Loading { loading: false, .. } => NativeEventKind::NavigationFinished,
            Self::TitleChanged { .. } => NativeEventKind::TitleChanged,
            Self::FaviconChanged { .. } => NativeEventKind::FaviconChanged,
            Self::PopupRequested { .. } => NativeEventKind::PopupRequested,
            Self::DownloadRequested { .. } => NativeEventKind::DownloadRequested,
            Self::IpcMessage { .. } => NativeEventKind::IpcMessage,
            Self::NavigationBlocked { .. } => NativeEventKind::NavigationBlocked,
            Self::HistoryChanged { .. } => NativeEventKind::HistoryChanged,
            Self::Closed { .. } => NativeEventKind::NavigationFinished,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct BrowserTab {
    pub id: String,
    pub surface: SurfaceKind,
    pub url: String,
    pub title: String,
    pub favicon: Option<String>,
    pub loading: bool,
    pub can_go_back: bool,
    pub can_go_forward: bool,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct BrowserBounds {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

impl BrowserBounds {
    pub const fn new(x: i32, y: i32, width: u32, height: u32) -> Self {
        Self {
            x,
            y,
            width,
            height,
        }
    }

    pub const fn valid(self) -> bool {
        self.width > 0 && self.height > 0
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct BrowserStatus {
    pub running: bool,
    pub url: Option<String>,
    pub title: Option<String>,
    pub loading: bool,
    pub can_go_back: bool,
    pub can_go_forward: bool,
    pub active_tab: Option<String>,
    pub tabs: Vec<BrowserTab>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Navigation {
    Back,
    Forward,
    Reload,
    Close,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum BrowserCommand {
    Load { tab_id: String, url: String },
    Back { tab_id: String },
    Forward { tab_id: String },
    Reload { tab_id: String },
    Close { tab_id: String },
    CloseAll,
    Focus { tab_id: String },
    Noop,
}

#[derive(Clone, Debug, PartialEq)]
pub struct PipPlacement {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
    pub collapsed: bool,
    pub loose: bool,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PipViewport {
    pub width: f32,
    pub height: f32,
    pub floor: f32,
}

impl PipViewport {
    pub const fn new(width: f32, height: f32, floor: f32) -> Self {
        Self {
            width,
            height,
            floor,
        }
    }

    fn safe_floor(self) -> f32 {
        self.floor.max(PIP_TOP + PIP_MIN_HEIGHT).min(self.height)
    }
}

#[derive(Clone, Debug)]
pub struct BrowserController {
    tabs: Vec<BrowserTab>,
    active_tab: Option<String>,
    next_tab: u64,
    visible: bool,
    bounds: Option<BrowserBounds>,
    floating: bool,
    focused: bool,
    address_editing: bool,
    address_draft: String,
    last_error: Option<SecurityError>,
}

impl Default for BrowserController {
    fn default() -> Self {
        Self::new()
    }
}

impl BrowserController {
    pub fn new() -> Self {
        Self {
            tabs: Vec::new(),
            active_tab: None,
            next_tab: 0,
            visible: false,
            bounds: None,
            floating: false,
            focused: false,
            address_editing: false,
            address_draft: String::new(),
            last_error: None,
        }
    }

    pub fn tabs(&self) -> &[BrowserTab] {
        &self.tabs
    }

    pub fn tab(&self, tab_id: &str) -> Option<&BrowserTab> {
        self.tabs.iter().find(|tab| tab.id == tab_id)
    }

    pub fn active_tab(&self) -> Option<&BrowserTab> {
        self.active_tab
            .as_deref()
            .and_then(|id| self.tabs.iter().find(|tab| tab.id == id))
            .or_else(|| self.tabs.first())
    }

    pub fn active_tab_id(&self) -> Option<&str> {
        self.active_tab().map(|tab| tab.id.as_str())
    }

    pub const fn visible(&self) -> bool {
        self.visible
    }

    pub const fn focused(&self) -> bool {
        self.focused
    }

    pub const fn floating(&self) -> bool {
        self.floating
    }

    pub const fn bounds(&self) -> Option<BrowserBounds> {
        self.bounds
    }

    pub const fn address_editing(&self) -> bool {
        self.address_editing
    }

    pub fn address_draft(&self) -> &str {
        &self.address_draft
    }

    pub const fn last_error(&self) -> Option<SecurityError> {
        self.last_error
    }

    pub fn status(&self) -> BrowserStatus {
        let active = self.active_tab();
        BrowserStatus {
            running: !self.tabs.is_empty(),
            url: active.map(|tab| tab.url.clone()),
            title: active.and_then(|tab| (!tab.title.is_empty()).then(|| tab.title.clone())),
            loading: active.is_some_and(|tab| tab.loading),
            can_go_back: active.is_some_and(|tab| tab.can_go_back),
            can_go_forward: active.is_some_and(|tab| tab.can_go_forward),
            active_tab: self.active_tab().map(|tab| tab.id.clone()),
            tabs: self.tabs.clone(),
        }
    }

    pub fn open(&mut self, url: &str) -> Result<BrowserCommand, SecurityError> {
        self.open_surface(SurfaceKind::Browser, url)
    }

    pub fn open_surface(
        &mut self,
        surface: SurfaceKind,
        url: &str,
    ) -> Result<BrowserCommand, SecurityError> {
        let normalized = validate_navigation_url(surface, url)?;
        if self.tabs.is_empty() {
            return self.new_surface_tab(surface, Some(&normalized));
        }
        let id = self
            .active_tab_id()
            .ok_or(SecurityError::InvalidUrl)?
            .to_owned();
        if self.tab(&id).is_none_or(|tab| tab.surface != surface) {
            return Err(SecurityError::CapabilityNotAllowed);
        }
        let tab = self.tab_mut(&id).ok_or(SecurityError::InvalidUrl)?;
        tab.url = normalized.clone();
        tab.loading = true;
        self.visible = true;
        self.last_error = None;
        Ok(BrowserCommand::Load {
            tab_id: id,
            url: normalized,
        })
    }

    pub fn new_tab(&mut self, url: Option<&str>) -> Result<BrowserCommand, SecurityError> {
        self.new_surface_tab(SurfaceKind::Browser, url)
    }

    pub fn new_surface_tab(
        &mut self,
        surface: SurfaceKind,
        url: Option<&str>,
    ) -> Result<BrowserCommand, SecurityError> {
        if self.tabs.len() >= MAX_TABS {
            self.last_error = Some(SecurityError::MessageInvalid);
            return Err(SecurityError::MessageInvalid);
        }
        let normalized = match url {
            Some(value) => validate_navigation_url(surface, value)?,
            None if surface == SurfaceKind::Browser => HOME_URL.to_owned(),
            None => return Err(SecurityError::EmptyUrl),
        };
        self.next_tab = self.next_tab.saturating_add(1);
        let id = format!("t{}", self.next_tab);
        self.tabs.push(BrowserTab {
            id: id.clone(),
            surface,
            url: normalized.clone(),
            title: String::new(),
            favicon: None,
            loading: normalized != HOME_URL,
            can_go_back: false,
            can_go_forward: false,
        });
        self.active_tab = Some(id.clone());
        self.visible = true;
        self.focused = true;
        self.last_error = None;
        Ok(BrowserCommand::Load {
            tab_id: id,
            url: normalized,
        })
    }

    pub fn select_tab(&mut self, tab_id: &str) -> Result<BrowserCommand, SecurityError> {
        if !self.tabs.iter().any(|tab| tab.id == tab_id) {
            return Err(SecurityError::InvalidUrl);
        }
        self.active_tab = Some(tab_id.to_owned());
        self.last_error = None;
        Ok(BrowserCommand::Noop)
    }

    pub fn close_tab(&mut self, tab_id: &str) -> BrowserCommand {
        let Some(index) = self.tabs.iter().position(|tab| tab.id == tab_id) else {
            return BrowserCommand::Noop;
        };
        self.tabs.remove(index);
        let command = if self.tabs.is_empty() {
            self.active_tab = None;
            self.visible = false;
            self.focused = false;
            BrowserCommand::Close {
                tab_id: tab_id.to_owned(),
            }
        } else {
            if self.active_tab.as_deref() == Some(tab_id) {
                self.active_tab = Some(
                    self.tabs
                        .get(index.min(self.tabs.len().saturating_sub(1)))
                        .map_or_else(|| self.tabs[0].id.clone(), |tab| tab.id.clone()),
                );
            }
            BrowserCommand::Close {
                tab_id: tab_id.to_owned(),
            }
        };
        self.last_error = None;
        command
    }

    pub fn navigate(&mut self, navigation: Navigation) -> BrowserCommand {
        let Some(id) = self.active_tab_id().map(ToOwned::to_owned) else {
            return BrowserCommand::Noop;
        };
        let Some(tab) = self.tab_mut(&id) else {
            return BrowserCommand::Noop;
        };
        match navigation {
            Navigation::Back if tab.can_go_back => {
                tab.loading = true;
                BrowserCommand::Back { tab_id: id }
            }
            Navigation::Forward if tab.can_go_forward => {
                tab.loading = true;
                BrowserCommand::Forward { tab_id: id }
            }
            Navigation::Reload => {
                tab.loading = true;
                BrowserCommand::Reload { tab_id: id }
            }
            Navigation::Close => {
                self.tabs.clear();
                self.active_tab = None;
                self.visible = false;
                self.focused = false;
                BrowserCommand::CloseAll
            }
            _ => BrowserCommand::Noop,
        }
    }

    pub fn begin_address_edit(&mut self) {
        self.address_editing = true;
        self.address_draft = self
            .active_tab()
            .map_or_else(String::new, |tab| tab.url.clone());
    }

    pub fn set_address_draft(&mut self, value: impl Into<String>) {
        self.address_draft = value.into();
    }

    pub fn submit_address(&mut self, value: &str) -> Result<BrowserCommand, SecurityError> {
        let value = value.trim();
        let candidate = if value.contains("://") || value.starts_with("about:") {
            value.to_owned()
        } else {
            format!("https://{value}")
        };
        self.address_editing = false;
        self.open(&candidate)
    }

    pub fn cancel_address_edit(&mut self) {
        self.address_editing = false;
        self.address_draft = self
            .active_tab()
            .map_or_else(String::new, |tab| tab.url.clone());
    }

    pub fn place(&mut self, bounds: Option<BrowserBounds>) -> Result<(), SecurityError> {
        if let Some(bounds) = bounds {
            if !bounds.valid() {
                return Err(SecurityError::InvalidUrl);
            }
            self.bounds = Some(bounds);
            self.visible = true;
        } else {
            self.visible = false;
            self.focused = false;
        }
        Ok(())
    }

    pub fn show(&mut self) {
        self.visible = true;
    }

    pub fn hide(&mut self) {
        self.visible = false;
        self.focused = false;
    }

    pub fn focus(&mut self) -> BrowserCommand {
        self.focused = true;
        self.active_tab_id()
            .map_or(BrowserCommand::Noop, |tab_id| BrowserCommand::Focus {
                tab_id: tab_id.to_owned(),
            })
    }

    pub fn blur(&mut self) {
        self.focused = false;
    }

    pub fn set_floating(&mut self, floating: bool) {
        self.floating = floating;
    }

    pub fn apply_event(&mut self, event: BrowserEvent) {
        let tab_id = match &event {
            BrowserEvent::Navigated { tab_id, .. }
            | BrowserEvent::Loading { tab_id, .. }
            | BrowserEvent::TitleChanged { tab_id, .. }
            | BrowserEvent::FaviconChanged { tab_id, .. }
            | BrowserEvent::HistoryChanged { tab_id, .. }
            | BrowserEvent::PopupRequested { tab_id, .. }
            | BrowserEvent::DownloadRequested { tab_id, .. }
            | BrowserEvent::IpcMessage { tab_id, .. }
            | BrowserEvent::NavigationBlocked { tab_id, .. }
            | BrowserEvent::Closed { tab_id } => tab_id,
        };
        let Some(tab) = self.tab_mut(tab_id) else {
            return;
        };
        match event {
            BrowserEvent::Navigated { url, .. } => {
                let allowed = validate_navigation_url(tab.surface, &url).is_ok()
                    && (tab.surface == SurfaceKind::Browser
                        || validate_frame_bridge_uri(tab.surface, &tab.url, &url).is_ok());
                if allowed {
                    tab.url = url;
                    tab.loading = false;
                    tab.can_go_back = tab.surface == SurfaceKind::Browser && tab.url != HOME_URL;
                    tab.can_go_forward = false;
                } else {
                    self.last_error = Some(SecurityError::PathNotAllowed);
                }
            }
            BrowserEvent::Loading { loading, .. } => tab.loading = loading,
            BrowserEvent::TitleChanged { title, .. } => tab.title = title,
            BrowserEvent::FaviconChanged { favicon, .. } => tab.favicon = favicon,
            BrowserEvent::HistoryChanged {
                can_go_back,
                can_go_forward,
                ..
            } => {
                tab.can_go_back = can_go_back;
                tab.can_go_forward = can_go_forward;
            }
            BrowserEvent::NavigationBlocked { error, .. } => {
                tab.loading = false;
                self.last_error = Some(error);
            }
            BrowserEvent::IpcMessage { uri, body, .. } => {
                if parse_frame_bridge_message(tab.surface, &tab.url, &uri, &body).is_err() {
                    self.last_error = Some(SecurityError::CapabilityNotAllowed);
                }
            }
            BrowserEvent::PopupRequested { .. }
            | BrowserEvent::DownloadRequested { .. }
            | BrowserEvent::Closed { .. } => {}
        }
    }

    fn tab_mut(&mut self, id: &str) -> Option<&mut BrowserTab> {
        self.tabs.iter_mut().find(|tab| tab.id == id)
    }
}

pub struct BrowserSurface {
    focus_handle: FocusHandle,
    controller: BrowserController,
    events: Arc<Mutex<VecDeque<BrowserEvent>>>,
    recent_events: Vec<BrowserEvent>,
    webviews: HashMap<String, Entity<gpui_wry::WebView>>,
    loaded_urls: HashMap<String, String>,
    frame_assets: HashMap<String, Arc<FrameAssets>>,
}

impl BrowserSurface {
    pub fn new(cx: &mut Context<Self>) -> Self {
        Self {
            focus_handle: cx.focus_handle(),
            controller: BrowserController::new(),
            events: Arc::new(Mutex::new(VecDeque::new())),
            recent_events: Vec::new(),
            webviews: HashMap::new(),
            loaded_urls: HashMap::new(),
            frame_assets: HashMap::new(),
        }
    }

    pub fn controller(&self) -> &BrowserController {
        &self.controller
    }

    pub fn controller_mut(&mut self) -> &mut BrowserController {
        &mut self.controller
    }

    pub fn events(&self) -> Arc<Mutex<VecDeque<BrowserEvent>>> {
        self.events.clone()
    }

    pub fn take_events(&mut self) -> Vec<BrowserEvent> {
        std::mem::take(&mut self.recent_events)
    }

    pub fn reply_bridge(
        &mut self,
        tab_id: &str,
        reply: BridgeReply,
        cx: &mut Context<Self>,
    ) -> Result<(), BrowserError> {
        let script = bridge_reply_script(&reply);
        let webview = self.webviews.get(tab_id).ok_or(BrowserError::UnknownTab)?;
        let mut result = Ok(());
        webview.update(cx, |view, _| {
            if let Err(error) = view.raw().evaluate_script(&script) {
                result = Err(BrowserError::Native(error.to_string()));
            }
        });
        result
    }

    pub fn publish_bridge_event(
        &mut self,
        tab_id: &str,
        event: Value,
        cx: &mut Context<Self>,
    ) -> Result<(), BrowserError> {
        let body = serde_json::to_string(&event)
            .map_err(|error| BrowserError::Native(error.to_string()))?;
        let script = format!("globalThis.__emmaEvent({body});");
        let webview = self.webviews.get(tab_id).ok_or(BrowserError::UnknownTab)?;
        let mut result = Ok(());
        webview.update(cx, |view, _| {
            if let Err(error) = view.raw().evaluate_script(&script) {
                result = Err(BrowserError::Native(error.to_string()));
            }
        });
        result
    }

    pub fn set_component_expanded(
        &mut self,
        tab_id: &str,
        expanded: bool,
        cx: &mut Context<Self>,
    ) -> Result<(), BrowserError> {
        self.evaluate_frame(
            tab_id,
            &format!("globalThis.__emmaSetExpanded({expanded});"),
            cx,
        )
    }

    pub fn set_visual_picking(
        &mut self,
        tab_id: &str,
        picking: bool,
        cx: &mut Context<Self>,
    ) -> Result<(), BrowserError> {
        self.evaluate_frame(
            tab_id,
            &format!("globalThis.__emmaSetPicking({picking});"),
            cx,
        )
    }

    fn evaluate_frame(
        &mut self,
        tab_id: &str,
        script: &str,
        cx: &mut Context<Self>,
    ) -> Result<(), BrowserError> {
        let webview = self.webviews.get(tab_id).ok_or(BrowserError::UnknownTab)?;
        let mut result = Ok(());
        webview.update(cx, |view, _| {
            if let Err(error) = view.raw().evaluate_script(script) {
                result = Err(BrowserError::Native(error.to_string()));
            }
        });
        result
    }

    pub fn set_frame_assets(
        &mut self,
        tab_id: &str,
        assets: FrameAssets,
    ) -> Result<(), BrowserError> {
        let surface = self
            .controller
            .tab(tab_id)
            .ok_or(BrowserError::UnknownTab)?
            .surface;
        if surface == SurfaceKind::Browser || assets.surface() != surface {
            return Err(BrowserError::Security(SecurityError::CapabilityNotAllowed));
        }
        if surface == SurfaceKind::Component {
            let expected = frame_authority(
                surface,
                &self
                    .controller
                    .tab(tab_id)
                    .ok_or(BrowserError::UnknownTab)?
                    .url,
            )
            .map_err(BrowserError::Security)?;
            if assets.component_id() != Some(expected.as_str()) {
                return Err(BrowserError::Security(SecurityError::HostNotAllowed));
            }
        }
        self.frame_assets
            .insert(tab_id.to_owned(), Arc::new(assets));
        Ok(())
    }

    pub fn poll_events(&mut self) -> usize {
        let events = self
            .events
            .lock()
            .map_or_else(|_| VecDeque::new(), |mut queue| queue.drain(..).collect());
        let count = events.len();
        self.recent_events.extend(events.iter().cloned());
        if self.recent_events.len() > MAX_EVENT_QUEUE {
            let excess = self.recent_events.len() - MAX_EVENT_QUEUE;
            self.recent_events.drain(..excess);
        }
        for event in events {
            self.controller.apply_event(event);
        }
        count
    }

    pub fn mount_tab(
        &mut self,
        tab_id: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Result<(), BrowserError> {
        let surface = self
            .controller
            .tab(tab_id)
            .ok_or(BrowserError::UnknownTab)?
            .surface;
        self.mount_surface(surface, tab_id, window, cx)
    }

    pub fn mount_frame_tab(
        &mut self,
        surface: SurfaceKind,
        tab_id: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Result<(), BrowserError> {
        if surface == SurfaceKind::Browser {
            return Err(BrowserError::Security(SecurityError::CapabilityNotAllowed));
        }
        let tab_surface = self
            .controller
            .tab(tab_id)
            .ok_or(BrowserError::UnknownTab)?
            .surface;
        if tab_surface != surface {
            return Err(BrowserError::Security(SecurityError::CapabilityNotAllowed));
        }
        self.mount_surface(surface, tab_id, window, cx)
    }

    fn mount_surface(
        &mut self,
        surface: SurfaceKind,
        tab_id: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Result<(), BrowserError> {
        if self.webviews.contains_key(tab_id) {
            return Ok(());
        }
        let authorized_url = self
            .controller
            .tab(tab_id)
            .filter(|tab| tab.surface == surface)
            .map(|tab| tab.url.clone())
            .ok_or(BrowserError::UnknownTab)?;
        let initial_url = native_surface_url(surface, &authorized_url);
        let assets = if surface == SurfaceKind::Browser {
            None
        } else {
            Some(
                self.frame_assets
                    .get(tab_id)
                    .filter(|assets| assets.surface() == surface)
                    .cloned()
                    .ok_or(BrowserError::Security(SecurityError::PathNotAllowed))?,
            )
        };
        let queue = self.events.clone();
        let id = tab_id.to_owned();
        let mut builder = WebViewBuilder::new()
            .with_visible(false)
            .with_url(initial_url.clone())
            .with_navigation_handler({
                let queue = queue.clone();
                let id = id.clone();
                let expected_url = authorized_url.clone();
                move |url| match navigation_decision(surface, &url) {
                    NavigationDecision::Allow => {
                        if surface != SurfaceKind::Browser
                            && validate_frame_bridge_uri(surface, &expected_url, &url).is_err()
                        {
                            push_event(
                                &queue,
                                BrowserEvent::NavigationBlocked {
                                    tab_id: id.clone(),
                                    url,
                                    error: SecurityError::HostNotAllowed,
                                },
                            );
                            return false;
                        }
                        push_event(
                            &queue,
                            BrowserEvent::Navigated {
                                tab_id: id.clone(),
                                url,
                            },
                        );
                        true
                    }
                    NavigationDecision::OpenExternal(url) => {
                        push_event(
                            &queue,
                            BrowserEvent::NavigationBlocked {
                                tab_id: id.clone(),
                                url,
                                error: SecurityError::SchemeNotAllowed,
                            },
                        );
                        false
                    }
                    NavigationDecision::Block(error) => {
                        push_event(
                            &queue,
                            BrowserEvent::NavigationBlocked {
                                tab_id: id.clone(),
                                url,
                                error,
                            },
                        );
                        false
                    }
                }
            })
            .with_on_page_load_handler({
                let queue = queue.clone();
                let id = id.clone();
                move |event, url| {
                    push_event(
                        &queue,
                        BrowserEvent::Loading {
                            tab_id: id.clone(),
                            loading: matches!(event, PageLoadEvent::Started),
                        },
                    );
                    if matches!(event, PageLoadEvent::Finished) {
                        push_event(
                            &queue,
                            BrowserEvent::Navigated {
                                tab_id: id.clone(),
                                url,
                            },
                        );
                    }
                }
            })
            .with_document_title_changed_handler({
                let queue = queue.clone();
                let id = id.clone();
                move |title| {
                    push_event(
                        &queue,
                        BrowserEvent::TitleChanged {
                            tab_id: id.clone(),
                            title,
                        },
                    )
                }
            })
            .with_new_window_req_handler({
                let queue = queue.clone();
                let id = id.clone();
                move |url, _features| {
                    if surface == SurfaceKind::Browser
                        && let PopupDecision::NewTab(url) = popup_decision(&url)
                    {
                        push_event(
                            &queue,
                            BrowserEvent::PopupRequested {
                                tab_id: id.clone(),
                                url,
                            },
                        );
                    }
                    NewWindowResponse::Deny
                }
            })
            .with_download_started_handler({
                let queue = queue.clone();
                let id = id.clone();
                move |url, _path: &mut PathBuf| {
                    if surface == SurfaceKind::Browser
                        && let DownloadDecision::OpenExternal(url) = download_decision(&url)
                    {
                        push_event(
                            &queue,
                            BrowserEvent::DownloadRequested {
                                tab_id: id.clone(),
                                url,
                            },
                        );
                    }
                    false
                }
            });

        if surface == SurfaceKind::Browser {
            let queue = queue.clone();
            let id = id.clone();
            builder = builder
                .with_initialization_script(NATIVE_BROWSER_METADATA)
                .with_ipc_handler(move |request| {
                    if let Some((title, favicon)) = parse_browser_metadata(request.body()) {
                        push_event(
                            &queue,
                            BrowserEvent::TitleChanged {
                                tab_id: id.clone(),
                                title,
                            },
                        );
                        push_event(
                            &queue,
                            BrowserEvent::FaviconChanged {
                                tab_id: id.clone(),
                                favicon,
                            },
                        );
                    }
                });
        } else {
            let queue = queue.clone();
            let id = id.clone();
            let expected_url = authorized_url.clone();
            builder = builder
                .with_custom_protocol(surface.scheme().to_owned(), {
                    let expected_url = expected_url.clone();
                    let assets = assets
                        .clone()
                        .ok_or(BrowserError::Security(SecurityError::PathNotAllowed))?;
                    move |_webview_id, request| {
                        frame_asset_response(surface, &expected_url, request, &assets)
                    }
                })
                .with_ipc_handler(move |request| {
                    let uri = request.uri().to_string();
                    let body = request.body().clone();
                    if parse_frame_bridge_message(surface, &expected_url, &uri, &body).is_ok() {
                        push_event(
                            &queue,
                            BrowserEvent::IpcMessage {
                                tab_id: id.clone(),
                                uri,
                                body,
                            },
                        );
                    }
                });
        }

        #[cfg(any(target_os = "macos", target_os = "windows"))]
        {
            let handle = window
                .window_handle()
                .map_err(|error| BrowserError::Native(error.to_string()))?;
            let native = builder
                .build_as_child(&handle)
                .map_err(|error| BrowserError::Native(error.to_string()))?;
            let entity = cx.new(|cx| gpui_wry::WebView::new(native, window, cx));
            self.webviews.insert(tab_id.to_owned(), entity);
            self.loaded_urls.insert(tab_id.to_owned(), initial_url);
            Ok(())
        }

        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        {
            let _ = (builder, window, cx);
            Err(BrowserError::UnsupportedPlatform)
        }
    }

    pub fn unmount_tab(&mut self, tab_id: &str) {
        self.webviews.remove(tab_id);
        self.loaded_urls.remove(tab_id);
        self.frame_assets.remove(tab_id);
    }

    pub fn unmount_all(&mut self) {
        self.webviews.clear();
        self.loaded_urls.clear();
        self.frame_assets.clear();
    }

    pub fn sync_native(&mut self, cx: &mut Context<Self>) {
        let stale = self
            .webviews
            .keys()
            .filter(|tab_id| self.controller.tab(tab_id).is_none())
            .cloned()
            .collect::<Vec<_>>();
        for tab_id in stale {
            if let Some(webview) = self.webviews.remove(&tab_id) {
                webview.update(cx, |view, _| view.hide());
            }
            self.loaded_urls.remove(&tab_id);
            self.frame_assets.remove(&tab_id);
        }
        let active_id = self.controller.active_tab_id().map(ToOwned::to_owned);
        let visible = self.controller.visible();
        let bounds = self.controller.bounds().map(native_bounds);
        for tab in self.controller.tabs() {
            let Some(webview) = self.webviews.get(&tab.id) else {
                continue;
            };
            let active = active_id.as_deref() == Some(tab.id.as_str());
            let native_url = native_surface_url(tab.surface, &tab.url);
            webview.update(cx, |view, _| {
                if let Some(bounds) = bounds {
                    let _ = view.raw().set_bounds(bounds);
                }
                if visible && active {
                    view.show();
                } else {
                    view.hide();
                }
            });
            if self.loaded_urls.get(&tab.id).map(String::as_str) != Some(native_url.as_str()) {
                webview.update(cx, |view, _| view.load_url(&native_url));
                self.loaded_urls.insert(tab.id.clone(), native_url);
            }
        }
    }

    pub fn focus_native(&mut self, cx: &mut Context<Self>) {
        let Some(active_id) = self.controller.active_tab_id() else {
            return;
        };
        if let Some(webview) = self.webviews.get(active_id) {
            webview.update(cx, |view, _| {
                let _ = view.raw().focus();
            });
        }
    }

    pub fn close_tab_native(&mut self, tab_id: &str, cx: &mut Context<Self>) {
        if let Some(webview) = self.webviews.remove(tab_id) {
            webview.update(cx, |view, _| view.hide());
        }
        self.loaded_urls.remove(tab_id);
    }

    pub fn navigate_native(
        &mut self,
        tab_id: &str,
        navigation: Navigation,
        cx: &mut Context<Self>,
    ) -> Result<(), BrowserError> {
        let webview = self.webviews.get(tab_id).ok_or(BrowserError::UnknownTab)?;
        let mut result = Ok(());
        webview.update(cx, |view, _| {
            let operation = match navigation {
                Navigation::Back => view.raw().evaluate_script("history.back();"),
                Navigation::Forward => view.raw().evaluate_script("history.forward();"),
                Navigation::Reload => view.raw().reload(),
                Navigation::Close => Ok(()),
            };
            if let Err(error) = operation {
                result = Err(BrowserError::Native(error.to_string()));
            }
        });
        result
    }
}

impl Focusable for BrowserSurface {
    fn focus_handle(&self, _cx: &App) -> FocusHandle {
        self.focus_handle.clone()
    }
}

impl Render for BrowserSurface {
    fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
        self.poll_events();
        let active_id = self.controller.active_tab_id().map(ToOwned::to_owned);
        let Some(active_id) = active_id else {
            return v_flex().size_full().child("New tab");
        };
        if !self.controller.visible() {
            return v_flex().size_full();
        }
        if let Some(webview) = self.webviews.get(&active_id) {
            return v_flex().size_full().child(webview.clone());
        }
        v_flex()
            .size_full()
            .child("Browser unavailable on this platform")
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum BrowserError {
    UnknownTab,
    UnsupportedPlatform,
    Security(SecurityError),
    Native(String),
}

impl fmt::Display for BrowserError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnknownTab => formatter.write_str("browser tab is unknown"),
            Self::UnsupportedPlatform => {
                formatter.write_str("native webview is unavailable on this platform")
            }
            Self::Security(error) => error.fmt(formatter),
            Self::Native(error) => formatter.write_str(error),
        }
    }
}

impl std::error::Error for BrowserError {}

fn parse_browser_metadata(raw: &str) -> Option<(String, Option<String>)> {
    if raw.len() > MAX_BRIDGE_MESSAGE_BYTES {
        return None;
    }
    let object = serde_json::from_str::<Value>(raw)
        .ok()?
        .as_object()?
        .clone();
    if object.get("emma").and_then(Value::as_str) != Some("browser-metadata") {
        return None;
    }
    let title = object
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .chars()
        .filter(|character| !character.is_control())
        .take(MAX_BROWSER_TITLE_CHARS)
        .collect::<String>();
    let favicon = match object.get("favicon") {
        None | Some(Value::Null) => None,
        Some(Value::String(value)) if valid_favicon_url(value) => Some(value.clone()),
        Some(Value::String(_)) => None,
        Some(_) => return None,
    };
    Some((title, favicon))
}

fn valid_favicon_url(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_FAVICON_URL_BYTES
        && !value.bytes().any(|byte| byte.is_ascii_control())
        && (value.starts_with("https://")
            || value.starts_with("http://")
            || value.starts_with("data:image/"))
}

pub fn validate_navigation_url(surface: SurfaceKind, value: &str) -> Result<String, SecurityError> {
    let value = value.trim();
    if value.is_empty() {
        return Err(SecurityError::EmptyUrl);
    }
    if value.len() > MAX_NAVIGATION_URL_BYTES {
        return Err(SecurityError::UrlTooLong);
    }
    if value
        .bytes()
        .any(|byte| byte.is_ascii_control() || byte.is_ascii_whitespace())
    {
        return Err(SecurityError::InvalidUrl);
    }
    let Some((scheme, remainder)) = value.split_once(':') else {
        return Err(SecurityError::InvalidUrl);
    };
    let scheme = scheme.to_ascii_lowercase();
    match surface {
        SurfaceKind::Browser => {
            if value.eq_ignore_ascii_case(HOME_URL) {
                return Ok(HOME_URL.to_owned());
            }
            if !matches!(scheme.as_str(), "http" | "https") || !remainder.starts_with("//") {
                return Err(SecurityError::SchemeNotAllowed);
            }
            if remainder[2..]
                .split(['/', '?', '#'])
                .next()
                .is_none_or(str::is_empty)
            {
                return Err(SecurityError::HostNotAllowed);
            }
            Ok(value.to_owned())
        }
        SurfaceKind::Artifact => {
            validate_frame_parts(&scheme, remainder, "emma-artifact", |path| {
                path.is_empty()
                    || path == "/"
                    || path.starts_with("/?v=")
                    || path == "/module.js"
                    || path.starts_with("/module.js?")
                    || valid_frame_file_path(path)
            })
            .map(|_| value.to_owned())
        }
        SurfaceKind::Component => {
            validate_frame_parts(&scheme, remainder, "emma-component", |path| {
                path == "/"
                    || path.starts_with("/?")
                    || path == "/module.js"
                    || path == "/shot.png"
                    || path.starts_with("/module.js?")
                    || path.starts_with("/shot.png?")
            })
            .map(|_| value.to_owned())
        }
        SurfaceKind::Visual => validate_frame_parts(&scheme, remainder, "emma-visual", |path| {
            path.is_empty() || path == "/" || path.starts_with("/?")
        })
        .map(|_| value.to_owned()),
    }
}

pub fn normalize_navigation_url(value: &str) -> Result<String, SecurityError> {
    validate_navigation_url(SurfaceKind::Browser, value)
}

pub fn navigation_decision(surface: SurfaceKind, value: &str) -> NavigationDecision {
    match validate_navigation_url(surface, value) {
        Ok(_) => NavigationDecision::Allow,
        Err(error) => NavigationDecision::Block(error),
    }
}

pub fn popup_decision(value: &str) -> PopupDecision {
    match normalize_navigation_url(value) {
        Ok(url) if url != HOME_URL => PopupDecision::NewTab(url),
        Ok(_) => PopupDecision::Block(SecurityError::InvalidUrl),
        Err(error) => PopupDecision::Block(error),
    }
}

pub fn download_decision(value: &str) -> DownloadDecision {
    match normalize_navigation_url(value) {
        Ok(url) if url != HOME_URL => DownloadDecision::OpenExternal(url),
        Ok(_) => DownloadDecision::Block(SecurityError::InvalidUrl),
        Err(error) => DownloadDecision::Block(error),
    }
}

pub fn external_link_decision(value: &str) -> ExternalLinkDecision {
    match normalize_navigation_url(value) {
        Ok(url) if url != HOME_URL => ExternalLinkDecision::OpenExternal(url),
        Ok(_) => ExternalLinkDecision::Block(SecurityError::InvalidUrl),
        Err(error) => ExternalLinkDecision::Block(error),
    }
}

pub fn validate_frame_url(surface: SurfaceKind, value: &str) -> Result<String, SecurityError> {
    validate_navigation_url(surface, value)
}

pub fn component_frame_url(id: &str, version: Option<u64>) -> Result<String, SecurityError> {
    if !valid_capability_id(id) {
        return Err(SecurityError::HostNotAllowed);
    }
    let query = version.map_or_else(String::new, |value| format!("?v={value}"));
    let value = format!("{}://{id}/{query}", SurfaceKind::Component.scheme());
    validate_frame_url(SurfaceKind::Component, &value)
}

pub fn frame_csp(surface: SurfaceKind) -> &'static str {
    match surface {
        SurfaceKind::Artifact => {
            "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:"
        }
        SurfaceKind::Visual => {
            "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:"
        }
        SurfaceKind::Component => {
            "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; img-src self data:; font-src data:; connect-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'"
        }
        SurfaceKind::Browser => "",
    }
}

pub fn frame_initialization_script(surface: SurfaceKind) -> String {
    if surface == SurfaceKind::Browser {
        return String::new();
    }
    let csp = serde_json::to_string(frame_csp(surface)).unwrap_or_default();
    format!(
        "(()=>{{const c={csp};const install=()=>{{const root=document.head||document.documentElement;if(!root)return;let meta=document.querySelector('meta[data-emma-csp]');if(!meta){{meta=document.createElement('meta');meta.httpEquiv='Content-Security-Policy';meta.dataset.emmaCsp='';root.prepend(meta)}}meta.content=c}};install();if(document.documentElement)new MutationObserver(install).observe(document.documentElement,{{childList:true,subtree:true}})}})();"
    )
}

pub fn validate_frame_bridge_uri(
    surface: SurfaceKind,
    authorized_url: &str,
    request_uri: &str,
) -> Result<(), SecurityError> {
    if surface == SurfaceKind::Browser {
        return Err(SecurityError::CapabilityNotAllowed);
    }
    let authorized = frame_authority(surface, authorized_url)?;
    let requested = frame_authority(surface, request_uri)?;
    if authorized == requested {
        Ok(())
    } else {
        Err(SecurityError::HostNotAllowed)
    }
}

pub fn frame_asset_response(
    surface: SurfaceKind,
    authorized_url: &str,
    request: Request<Vec<u8>>,
    assets: &FrameAssets,
) -> Response<Cow<'static, [u8]>> {
    let uri = request.uri().to_string();
    let allowed = assets.surface() == surface
        && validate_frame_bridge_uri(surface, authorized_url, &uri).is_ok();
    if !allowed {
        return response(403, "text/plain; charset=utf-8", Vec::new(), surface);
    }
    let Some(path) = frame_path(&uri) else {
        return response(404, "text/plain; charset=utf-8", Vec::new(), surface);
    };
    let asset = match path.as_str() {
        "/" | "" => assets
            .document
            .as_ref()
            .map(|bytes| ("text/html; charset=utf-8", bytes.clone())),
        "/module.js" => assets
            .module
            .as_ref()
            .map(|bytes| ("text/javascript; charset=utf-8", bytes.clone())),
        "/shot.png" => assets
            .shot
            .as_ref()
            .map(|bytes| ("image/png", bytes.clone())),
        _ if surface == SurfaceKind::Artifact => assets
            .files
            .iter()
            .find(|(name, _)| format!("/{name}") == path)
            .map(|(name, bytes)| (artifact_file_content_type(name), bytes.clone())),
        _ => None,
    };
    let Some((content_type, body)) = asset else {
        return response(404, "text/plain; charset=utf-8", Vec::new(), surface);
    };
    response_with_csp(
        200,
        content_type,
        body,
        surface,
        assets
            .origin_csp
            .as_deref()
            .unwrap_or_else(|| frame_csp(surface)),
    )
}

pub fn validate_frame_html(surface: SurfaceKind, html: &str) -> Result<(), SecurityError> {
    if html.is_empty() || html.len() > MAX_HTML_BYTES {
        return Err(SecurityError::HtmlTooLarge);
    }
    if matches!(surface, SurfaceKind::Artifact | SurfaceKind::Visual)
        && html.to_ascii_lowercase().contains("<iframe")
    {
        return Err(SecurityError::PathNotAllowed);
    }
    Ok(())
}

pub fn parse_bridge_message(
    surface: SurfaceKind,
    raw: &str,
) -> Result<BridgeMessage, SecurityError> {
    if raw.len() > MAX_BRIDGE_MESSAGE_BYTES {
        return Err(SecurityError::MessageTooLarge);
    }
    let value: Value = serde_json::from_str(raw).map_err(|_| SecurityError::MessageInvalid)?;
    let Value::Object(mut payload) = value else {
        return Err(SecurityError::MessageInvalid);
    };
    let capability = payload
        .remove("capability")
        .or_else(|| payload.get("emma").cloned())
        .and_then(|value| value.as_str().and_then(BridgeCapability::parse))
        .ok_or(SecurityError::MessageInvalid)?;
    if !surface.allows(capability) {
        return Err(SecurityError::CapabilityNotAllowed);
    }
    let request_id = payload
        .remove("n")
        .map(|value| value.as_u64().ok_or(SecurityError::MessageInvalid))
        .transpose()?;
    match capability {
        BridgeCapability::ArtifactSql => {
            let sql = payload
                .get("sql")
                .and_then(Value::as_str)
                .ok_or(SecurityError::MessageInvalid)?;
            let params = payload
                .get("params")
                .and_then(Value::as_array)
                .map_or(&[][..], Vec::as_slice);
            validate_artifact_sql(sql, params)?;
        }
        BridgeCapability::ComponentFetch => validate_component_fetch(&payload)?,
        BridgeCapability::ComponentShot => validate_component_shot(&payload)?,
        BridgeCapability::EmmaRequest => validate_emma_request(&payload)?,
        BridgeCapability::EmmaSubscribe => validate_emma_subscribe(&payload)?,
        BridgeCapability::VisualPick => validate_visual_pick(&payload)?,
        BridgeCapability::VisualHeight => validate_visual_height(&payload)?,
        BridgeCapability::OpenExternal => return Err(SecurityError::CapabilityNotAllowed),
    }
    Ok(BridgeMessage {
        capability,
        request_id,
        payload,
    })
}

fn validate_component_fetch(payload: &Map<String, Value>) -> Result<(), SecurityError> {
    if payload.contains_key("request") {
        if payload
            .keys()
            .any(|key| !matches!(key.as_str(), "emma" | "id" | "request"))
        {
            return Err(SecurityError::MessageInvalid);
        }
        let id = payload
            .get("id")
            .and_then(Value::as_str)
            .filter(|value| valid_capability_id(value))
            .ok_or(SecurityError::MessageInvalid)?;
        let Value::Object(mut request) = payload
            .get("request")
            .cloned()
            .ok_or(SecurityError::MessageInvalid)?
        else {
            return Err(SecurityError::MessageInvalid);
        };
        if request.contains_key("id") {
            return Err(SecurityError::MessageInvalid);
        }
        request.insert("id".to_owned(), Value::String(id.to_owned()));
        return validate_component_fetch_flat(&request);
    }
    validate_component_fetch_flat(payload)
}

fn validate_component_fetch_flat(payload: &Map<String, Value>) -> Result<(), SecurityError> {
    if payload.keys().any(|key| {
        !matches!(
            key.as_str(),
            "emma" | "id" | "url" | "method" | "headers" | "body"
        )
    }) {
        return Err(SecurityError::MessageInvalid);
    }
    if let Some(id) = payload.get("id") {
        let id = id.as_str().ok_or(SecurityError::MessageInvalid)?;
        if !valid_capability_id(id) {
            return Err(SecurityError::MessageInvalid);
        }
    }
    let url = payload
        .get("url")
        .and_then(Value::as_str)
        .ok_or(SecurityError::MessageInvalid)?;
    if url.is_empty()
        || url.len() > MAX_COMPONENT_URL_BYTES
        || !url.starts_with("https://")
        || url.contains("{{")
        || url
            .bytes()
            .any(|byte| byte.is_ascii_control() || byte.is_ascii_whitespace())
    {
        return Err(SecurityError::MessageInvalid);
    }
    let authority = url[8..].split(['/', '?', '#']).next().unwrap_or_default();
    if authority.is_empty()
        || authority.contains('@')
        || authority.starts_with(':')
        || authority.ends_with(':')
        || !authority.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b':' | b'[' | b']')
        })
    {
        return Err(SecurityError::MessageInvalid);
    }
    let method = payload
        .get("method")
        .map_or(Ok("GET"), |value| {
            value.as_str().ok_or(SecurityError::MessageInvalid)
        })?
        .to_ascii_uppercase();
    if !matches!(method.as_str(), "GET" | "POST" | "PUT" | "PATCH" | "DELETE") {
        return Err(SecurityError::MessageInvalid);
    }
    if let Some(headers) = payload.get("headers") {
        let Value::Object(headers) = headers else {
            return Err(SecurityError::MessageInvalid);
        };
        let mut names = std::collections::HashSet::new();
        if headers.len() > MAX_COMPONENT_HEADERS
            || headers.iter().any(|(name, value)| {
                let lower = name.to_ascii_lowercase();
                name.is_empty()
                    || name.len() > 64
                    || !name
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
                    || matches!(
                        lower.as_str(),
                        "host"
                            | "connection"
                            | "content-length"
                            | "transfer-encoding"
                            | "accept-encoding"
                            | "proxy-authorization"
                            | "proxy-connection"
                            | "upgrade"
                            | "te"
                            | "trailer"
                    )
                    || !names.insert(lower)
                    || value.as_str().is_none_or(|value| {
                        value.len() > MAX_COMPONENT_REQUEST_BYTES
                            || value.bytes().any(|byte| byte.is_ascii_control())
                    })
            })
        {
            return Err(SecurityError::MessageInvalid);
        }
    }
    if let Some(body) = payload.get("body") {
        let body = body.as_str().ok_or(SecurityError::MessageInvalid)?;
        if body.len() > MAX_COMPONENT_REQUEST_BYTES || method == "GET" {
            return Err(SecurityError::MessageInvalid);
        }
    }
    if serde_json::to_vec(payload).map_or(true, |bytes| bytes.len() > MAX_COMPONENT_REQUEST_BYTES) {
        return Err(SecurityError::MessageInvalid);
    }
    Ok(())
}

fn validate_component_shot(payload: &Map<String, Value>) -> Result<(), SecurityError> {
    if payload
        .keys()
        .any(|key| !matches!(key.as_str(), "emma" | "id" | "x" | "y" | "width" | "height"))
    {
        return Err(SecurityError::MessageInvalid);
    }
    let id = payload
        .get("id")
        .and_then(Value::as_str)
        .ok_or(SecurityError::MessageInvalid)?;
    if !valid_capability_id(id) {
        return Err(SecurityError::MessageInvalid);
    }
    for key in ["x", "y", "width", "height"] {
        let value = payload
            .get(key)
            .and_then(Value::as_f64)
            .ok_or(SecurityError::MessageInvalid)?;
        if !value.is_finite() || !(0.0..=8192.0).contains(&value) {
            return Err(SecurityError::MessageInvalid);
        }
    }
    Ok(())
}

fn validate_emma_request(payload: &Map<String, Value>) -> Result<(), SecurityError> {
    if payload
        .keys()
        .any(|key| !matches!(key.as_str(), "emma" | "method" | "params"))
    {
        return Err(SecurityError::MessageInvalid);
    }
    let method = payload
        .get("method")
        .and_then(Value::as_str)
        .ok_or(SecurityError::MessageInvalid)?;
    if method.is_empty()
        || method.len() > MAX_EMMA_METHOD_BYTES
        || method
            .bytes()
            .any(|byte| byte.is_ascii_control() || byte.is_ascii_whitespace())
    {
        return Err(SecurityError::MessageInvalid);
    }
    if let Some(params) = payload.get("params")
        && (!params.is_object()
            || serde_json::to_vec(params)
                .map_or(true, |value| value.len() > MAX_COMPONENT_REQUEST_BYTES))
    {
        return Err(SecurityError::MessageInvalid);
    }
    Ok(())
}

fn validate_emma_subscribe(payload: &Map<String, Value>) -> Result<(), SecurityError> {
    if payload
        .keys()
        .any(|key| !matches!(key.as_str(), "emma" | "channel"))
    {
        return Err(SecurityError::MessageInvalid);
    }
    let channel = payload
        .get("channel")
        .and_then(Value::as_str)
        .ok_or(SecurityError::MessageInvalid)?;
    if channel.is_empty()
        || channel.len() > MAX_EMMA_CHANNEL_BYTES
        || channel
            .bytes()
            .any(|byte| byte.is_ascii_control() || byte.is_ascii_whitespace())
    {
        return Err(SecurityError::MessageInvalid);
    }
    Ok(())
}

fn validate_visual_pick(payload: &Map<String, Value>) -> Result<(), SecurityError> {
    if payload
        .keys()
        .any(|key| !matches!(key.as_str(), "emma" | "label" | "html" | "height" | "on"))
    {
        return Err(SecurityError::MessageInvalid);
    }
    if payload
        .get("label")
        .is_some_and(|value| value.as_str().is_none_or(|value| value.len() > 512))
        || payload.get("html").is_some_and(|value| {
            value
                .as_str()
                .is_none_or(|value| value.len() > MAX_VISUAL_PICK_BYTES)
        })
    {
        return Err(SecurityError::MessageInvalid);
    }
    if payload
        .get("height")
        .is_some_and(|value| value.as_u64().is_none_or(|value| value > 4096))
        || payload.get("on").is_some_and(|value| !value.is_boolean())
    {
        return Err(SecurityError::MessageInvalid);
    }
    Ok(())
}

fn validate_visual_height(payload: &Map<String, Value>) -> Result<(), SecurityError> {
    if payload
        .keys()
        .any(|key| !matches!(key.as_str(), "emma" | "height"))
    {
        return Err(SecurityError::MessageInvalid);
    }
    let height = payload
        .get("height")
        .and_then(Value::as_u64)
        .ok_or(SecurityError::MessageInvalid)?;
    if !(1..=4096).contains(&height) {
        return Err(SecurityError::MessageInvalid);
    }
    Ok(())
}

pub fn parse_frame_bridge_message(
    surface: SurfaceKind,
    authorized_url: &str,
    request_uri: &str,
    raw: &str,
) -> Result<BridgeMessage, SecurityError> {
    validate_frame_bridge_uri(surface, authorized_url, request_uri)?;
    let message = parse_bridge_message(surface, raw)?;
    if matches!(
        message.capability,
        BridgeCapability::ComponentFetch | BridgeCapability::ComponentShot
    ) {
        let expected = frame_authority(surface, authorized_url)?;
        if message
            .payload
            .get("id")
            .and_then(Value::as_str)
            .is_some_and(|id| id != expected)
        {
            return Err(SecurityError::HostNotAllowed);
        }
    }
    Ok(message)
}

pub fn bridge_reply_script(reply: &BridgeReply) -> String {
    let mut payload = Map::new();
    payload.insert("n".to_owned(), Value::from(reply.request_id));
    if let Some(error) = &reply.error {
        payload.insert("error".to_owned(), Value::String(error.clone()));
    } else if let Some(value) = &reply.value {
        payload.insert("value".to_owned(), value.clone());
    }
    let body = serde_json::to_string(&Value::Object(payload)).unwrap_or_else(|_| {
        format!(
            "{{\"n\":{},\"error\":\"bridge reply could not be encoded\"}}",
            reply.request_id
        )
    });
    format!("globalThis.__emmaReply({body});")
}

pub fn validate_artifact_sql(sql: &str, params: &[Value]) -> Result<(), SecurityError> {
    let trimmed = sql.trim();
    if trimmed.is_empty() {
        return Err(SecurityError::SqlEmpty);
    }
    if trimmed.len() > MAX_SQL_CHARS {
        return Err(SecurityError::SqlTooLong);
    }
    if params.len() > MAX_SQL_PARAMS
        || params.iter().any(|value| match value {
            Value::Null | Value::Bool(_) | Value::Number(_) => false,
            Value::String(value) => value.len() > MAX_SQL_PARAMETER_BYTES,
            Value::Array(_) | Value::Object(_) => true,
        })
    {
        return Err(SecurityError::SqlParametersInvalid);
    }
    if !one_sql_statement(trimmed) {
        return Err(SecurityError::SqlMultipleStatements);
    }
    Ok(())
}

pub fn default_pip_placement(viewport: PipViewport) -> PipPlacement {
    place_pip(
        viewport,
        PipPlacement {
            x: PIP_EDGE,
            y: PIP_TOP,
            width: PIP_WIDTH,
            height: PIP_HEIGHT,
            collapsed: false,
            loose: false,
        },
        &[],
        None,
    )
}

pub fn place_pip(
    viewport: PipViewport,
    placement: PipPlacement,
    others: &[PipPlacement],
    from: Option<(f32, f32)>,
) -> PipPlacement {
    let placement = constrain_pip(viewport, placement);
    let floor = viewport.safe_floor();
    let last_x = (viewport.width - PIP_RAIL - placement.width - PIP_EDGE).max(PIP_EDGE);
    let last_y = (floor - placement.height - PIP_EDGE).max(PIP_TOP);
    let reach = (viewport.width.hypot(floor)).max(1.);
    let mut best = (placement.x, placement.y);
    let mut lowest = f32::INFINITY;
    for share_x in [0., 1. / 3., 2. / 3., 1.] {
        for share_y in [0., 1. / 3., 2. / 3., 1.] {
            let x = (PIP_EDGE + (last_x - PIP_EDGE) * share_x).clamp(PIP_EDGE, last_x);
            let y = (PIP_TOP + (last_y - PIP_TOP) * share_y).clamp(PIP_TOP, last_y);
            let candidate = PipPlacement {
                x,
                y,
                ..placement.clone()
            };
            let crowd = others
                .iter()
                .map(|other| overlap(candidate.clone(), other.clone()))
                .sum::<f32>()
                / (placement.width * placement.height).max(1.);
            let travel =
                from.map_or(0., |(from_x, from_y)| x.hypot(y) - from_x.hypot(from_y)) / reach;
            let score = if crowd > 0. { 10. } else { 0. } + crowd * 2.4 + travel.max(0.) * 0.55;
            if score < lowest {
                lowest = score;
                best = (x, y);
            }
        }
    }
    PipPlacement {
        x: best.0,
        y: best.1,
        ..placement
    }
}

pub fn constrain_pip(viewport: PipViewport, mut placement: PipPlacement) -> PipPlacement {
    let floor = viewport.safe_floor();
    let max_width = (viewport.width - PIP_RAIL - PIP_EDGE * 2.).max(PIP_MIN_WIDTH);
    let max_height = (floor - PIP_TOP - PIP_EDGE).max(PIP_MIN_HEIGHT);
    placement.width = placement.width.clamp(PIP_MIN_WIDTH, max_width);
    placement.height = placement.height.clamp(PIP_MIN_HEIGHT, max_height);
    let max_x = (viewport.width - PIP_RAIL - placement.width - PIP_EDGE).max(PIP_EDGE);
    let max_y = (floor - placement.height - PIP_EDGE).max(PIP_TOP);
    placement.x = placement.x.clamp(PIP_EDGE, max_x);
    placement.y = placement.y.clamp(PIP_TOP, max_y);
    placement
}

pub fn stacked_pip(placement: &PipPlacement, depth: usize) -> PipPlacement {
    let depth = depth.min(PIP_DEEPEST) as f32;
    PipPlacement {
        x: placement.x + depth * PIP_STACK,
        y: placement.y - depth * PIP_STACK,
        ..placement.clone()
    }
}

fn push_event(queue: &Arc<Mutex<VecDeque<BrowserEvent>>>, event: BrowserEvent) {
    if let Ok(mut queue) = queue.lock() {
        if queue.len() >= MAX_EVENT_QUEUE {
            queue.pop_front();
        }
        queue.push_back(event);
    }
}

fn native_bounds(bounds: BrowserBounds) -> wry::Rect {
    wry::Rect {
        position: wry::dpi::LogicalPosition::new(bounds.x, bounds.y).into(),
        size: wry::dpi::LogicalSize::new(bounds.width, bounds.height).into(),
    }
}

fn native_surface_url(surface: SurfaceKind, value: &str) -> String {
    if surface == SurfaceKind::Component {
        component_root_url(value).unwrap_or_else(|| value.to_owned())
    } else if surface == SurfaceKind::Browser && value.is_empty() {
        HOME_URL.to_owned()
    } else {
        value.to_owned()
    }
}

fn component_root_url(value: &str) -> Option<String> {
    validate_frame_url(SurfaceKind::Component, value).ok()?;
    let (_, remainder) = value.split_once(":")?;
    let authority_and_path = remainder.strip_prefix("//")?;
    let (authority, path) = authority_and_path
        .split_once('/')
        .map_or((authority_and_path, ""), |(authority, path)| {
            (authority, path)
        });
    let query = path
        .split_once('?')
        .map_or(String::new(), |(_, query)| format!("?{query}"));
    Some(format!(
        "{}://{authority}/{query}",
        SurfaceKind::Component.scheme()
    ))
}

fn validate_frame_parts(
    scheme: &str,
    remainder: &str,
    expected_scheme: &str,
    path_allowed: impl FnOnce(&str) -> bool,
) -> Result<(), SecurityError> {
    if scheme != expected_scheme || !remainder.starts_with("//") {
        return Err(SecurityError::SchemeNotAllowed);
    }
    let authority_and_path = &remainder[2..];
    let (authority, path) = authority_and_path
        .split_once('/')
        .map_or((authority_and_path, ""), |(authority, path)| {
            (authority, path)
        });
    if !valid_capability_id(authority) {
        return Err(SecurityError::HostNotAllowed);
    }
    let path = format!("/{path}");
    if !path_allowed(&path) {
        return Err(SecurityError::PathNotAllowed);
    }
    Ok(())
}

fn frame_authority(surface: SurfaceKind, value: &str) -> Result<String, SecurityError> {
    validate_frame_url(surface, value)?;
    let Some((_, remainder)) = value.split_once(':') else {
        return Err(SecurityError::InvalidUrl);
    };
    let authority_and_path = remainder
        .strip_prefix("//")
        .ok_or(SecurityError::SchemeNotAllowed)?;
    let (authority, _) = authority_and_path
        .split_once('/')
        .map_or((authority_and_path, ""), |(authority, path)| {
            (authority, path)
        });
    Ok(authority.to_owned())
}

fn frame_path(value: &str) -> Option<String> {
    let (_, remainder) = value.split_once(':')?;
    let authority_and_path = remainder.strip_prefix("//")?;
    let path = authority_and_path
        .split_once('/')
        .map_or("", |(_, path)| path);
    Some(
        format!("/{path}")
            .split(['?', '#'])
            .next()
            .unwrap_or_default()
            .to_owned(),
    )
}

fn response(
    status: u16,
    content_type: &str,
    body: Vec<u8>,
    surface: SurfaceKind,
) -> Response<Cow<'static, [u8]>> {
    response_with_csp(status, content_type, body, surface, frame_csp(surface))
}

fn response_with_csp(
    status: u16,
    content_type: &str,
    body: Vec<u8>,
    _surface: SurfaceKind,
    csp: &str,
) -> Response<Cow<'static, [u8]>> {
    Response::builder()
        .status(status)
        .header("Content-Type", content_type)
        .header("Content-Security-Policy", csp)
        .header("X-Content-Type-Options", "nosniff")
        .header("Cache-Control", "no-store")
        .body(Cow::Owned(body))
        .unwrap_or_else(|_| Response::new(Cow::Owned(Vec::new())))
}

fn valid_capability_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 63
        && bytes[0].is_ascii_lowercase().then_some(()).is_some()
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-')
        && bytes
            .last()
            .is_some_and(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
}

fn one_sql_statement(sql: &str) -> bool {
    let bytes = sql.as_bytes();
    let mut quote = 0;
    let mut line_comment = false;
    let mut block_comment = false;
    let mut semicolon = None;
    let mut index = 0;
    while index < bytes.len() {
        let byte = bytes[index];
        let next = bytes.get(index + 1).copied();
        if line_comment {
            if byte == b'\n' {
                line_comment = false;
            }
            index += 1;
            continue;
        }
        if block_comment {
            if byte == b'*' && next == Some(b'/') {
                block_comment = false;
                index += 2;
            } else {
                index += 1;
            }
            continue;
        }
        if quote != 0 {
            if byte == quote {
                if next == Some(quote) {
                    index += 2;
                    continue;
                }
                quote = 0;
            }
            index += 1;
            continue;
        }
        match byte {
            b'\'' | b'"' | b'`' => quote = byte,
            b'[' => quote = b']',
            b'-' if next == Some(b'-') => {
                line_comment = true;
                index += 2;
                continue;
            }
            b'/' if next == Some(b'*') => {
                block_comment = true;
                index += 2;
                continue;
            }
            b';' => {
                if semicolon.is_some() {
                    return false;
                }
                semicolon = Some(index);
            }
            _ => {}
        }
        index += 1;
    }
    quote == 0
        && !block_comment
        && semicolon.is_none_or(|position| sql[position + 1..].trim().is_empty())
}

fn overlap(a: PipPlacement, b: PipPlacement) -> f32 {
    let width = (a.x + a.width).min(b.x + b.width) - a.x.max(b.x);
    let height = (a.y + a.height).min(b.y + b.height) - a.y.max(b.y);
    if width > 0. && height > 0. {
        width * height
    } else {
        0.
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn browser_navigation_policy_blocks_non_web_urls() {
        assert_eq!(
            normalize_navigation_url("https://example.com/a"),
            Ok("https://example.com/a".to_owned())
        );
        assert_eq!(normalize_navigation_url(HOME_URL), Ok(HOME_URL.to_owned()));
        assert_eq!(
            normalize_navigation_url("file:///tmp/x"),
            Err(SecurityError::SchemeNotAllowed)
        );
        assert_eq!(
            normalize_navigation_url("javascript:alert(1)"),
            Err(SecurityError::SchemeNotAllowed)
        );
        assert_eq!(
            normalize_navigation_url("data:text/html,x"),
            Err(SecurityError::SchemeNotAllowed)
        );
        assert_eq!(
            navigation_decision(SurfaceKind::Browser, "https://exa mple.com"),
            NavigationDecision::Block(SecurityError::InvalidUrl)
        );
    }

    #[test]
    fn frame_policy_requires_bounded_capability_paths() {
        assert!(validate_frame_url(SurfaceKind::Artifact, "emma-artifact://demo/?v=2").is_ok());
        assert!(
            validate_frame_url(
                SurfaceKind::Component,
                "emma-component://demo/module.js?v=4"
            )
            .is_ok()
        );
        assert!(validate_frame_url(SurfaceKind::Component, "emma-component://demo/").is_ok());
        assert!(validate_frame_url(SurfaceKind::Visual, "emma-visual://v1-demo/").is_ok());
        assert_eq!(
            validate_frame_url(SurfaceKind::Artifact, "emma-artifact://../module.js"),
            Err(SecurityError::HostNotAllowed)
        );
        assert_eq!(
            validate_frame_url(SurfaceKind::Component, "emma-component://demo/data.json"),
            Err(SecurityError::PathNotAllowed)
        );
    }

    #[test]
    fn bridge_capabilities_and_message_sizes_are_scoped() {
        let message = parse_bridge_message(
            SurfaceKind::Artifact,
            r#"{"emma":"sql","n":4,"sql":"select 1","params":[]}"#,
        )
        .unwrap();
        assert_eq!(message.capability, BridgeCapability::ArtifactSql);
        assert_eq!(message.request_id, Some(4));
        assert_eq!(
            parse_bridge_message(
                SurfaceKind::Visual,
                r#"{"emma":"sql","sql":"select 1","params":[]}"#
            ),
            Err(SecurityError::CapabilityNotAllowed)
        );
        assert_eq!(
            parse_bridge_message(
                SurfaceKind::Browser,
                r#"{"emma":"openExternal","url":"https://example.com"}"#
            ),
            Err(SecurityError::CapabilityNotAllowed)
        );
        assert_eq!(
            parse_bridge_message(
                SurfaceKind::Browser,
                &"x".repeat(MAX_BRIDGE_MESSAGE_BYTES + 1)
            ),
            Err(SecurityError::MessageTooLarge)
        );
        assert!(parse_bridge_message(
            SurfaceKind::Component,
                r#"{"emma":"componentFetch","url":"https://example.com","method":"post","headers":{},"body":""}"#
        )
        .is_ok());
        assert!(parse_bridge_message(
            SurfaceKind::Component,
            r#"{"capability":"componentFetch","n":5,"id":"demo","request":{"url":"https://example.com","method":"GET"}}"#,
        )
        .is_ok());
        assert_eq!(
            parse_bridge_message(
                SurfaceKind::Component,
                r#"{"emma":"componentFetch","url":"http://example.com"}"#
            ),
            Err(SecurityError::MessageInvalid)
        );
        assert_eq!(
            parse_bridge_message(
                SurfaceKind::Component,
                r#"{"emma":"componentFetch","url":"https://user:pass@example.com"}"#
            ),
            Err(SecurityError::MessageInvalid)
        );
    }

    #[test]
    fn frame_bridge_requires_the_authorized_custom_origin() {
        let authorized = "emma-artifact://demo/?v=2";
        assert!(
            validate_frame_bridge_uri(
                SurfaceKind::Artifact,
                authorized,
                "emma-artifact://demo/?v=2"
            )
            .is_ok()
        );
        assert!(
            validate_frame_bridge_uri(
                SurfaceKind::Artifact,
                authorized,
                "emma-artifact://demo/module.js"
            )
            .is_ok()
        );
        assert_eq!(
            validate_frame_bridge_uri(
                SurfaceKind::Artifact,
                authorized,
                "emma-artifact://other/?v=2"
            ),
            Err(SecurityError::HostNotAllowed)
        );
        assert_eq!(
            validate_frame_bridge_uri(SurfaceKind::Artifact, authorized, "https://example.com/"),
            Err(SecurityError::SchemeNotAllowed)
        );
    }

    #[test]
    fn frame_builder_installs_the_surface_csp() {
        let script = frame_initialization_script(SurfaceKind::Visual);
        assert!(script.contains(frame_csp(SurfaceKind::Visual)));
        assert!(frame_initialization_script(SurfaceKind::Browser).is_empty());
    }

    #[test]
    fn frame_protocol_returns_scoped_assets_and_headers() {
        let assets = FrameAssets::document(SurfaceKind::Artifact, "<main>ok</main>")
            .unwrap()
            .artifact_module(b"export const ok = true;")
            .unwrap();
        let document = frame_asset_response(
            SurfaceKind::Artifact,
            "emma-artifact://demo/?v=2",
            Request::builder()
                .uri("emma-artifact://demo/?v=2")
                .body(Vec::new())
                .unwrap(),
            &assets,
        );
        assert_eq!(document.status(), 200);
        assert_eq!(
            document.headers()["Content-Type"],
            "text/html; charset=utf-8"
        );
        assert_eq!(
            document.headers()["Content-Security-Policy"],
            frame_csp(SurfaceKind::Artifact)
        );
        assert_eq!(document.headers()["X-Content-Type-Options"], "nosniff");
        assert_eq!(document.body().as_ref(), b"<main>ok</main>");
        let module = frame_asset_response(
            SurfaceKind::Artifact,
            "emma-artifact://demo/?v=2",
            Request::builder()
                .uri("emma-artifact://demo/module.js")
                .body(Vec::new())
                .unwrap(),
            &assets,
        );
        assert_eq!(module.status(), 200);
        assert_eq!(
            module.headers()["Content-Type"],
            "text/javascript; charset=utf-8"
        );
        let blocked = frame_asset_response(
            SurfaceKind::Artifact,
            "emma-artifact://demo/?v=2",
            Request::builder()
                .uri("emma-artifact://other/?v=2")
                .body(Vec::new())
                .unwrap(),
            &assets,
        );
        assert_eq!(blocked.status(), 403);
    }

    #[test]
    fn component_protocol_serves_a_host_that_imports_the_module() {
        let assets = FrameAssets::component(b"export default () => null", None).unwrap();
        let root = frame_asset_response(
            SurfaceKind::Component,
            "emma-component://demo/module.js?v=4",
            Request::builder()
                .uri("emma-component://demo/?v=4")
                .body(Vec::new())
                .unwrap(),
            &assets,
        );
        assert_eq!(root.status(), 200);
        let html = String::from_utf8(root.body().to_vec()).unwrap();
        assert!(html.contains("import(\"./module.js\")"));
        assert!(html.contains("componentFetch"));
        assert!(!html.contains("visualPick"));
        let module = frame_asset_response(
            SurfaceKind::Component,
            "emma-component://demo/module.js?v=4",
            Request::builder()
                .uri("emma-component://demo/module.js?v=4")
                .body(Vec::new())
                .unwrap(),
            &assets,
        );
        assert_eq!(module.status(), 200);
        assert_eq!(module.body().as_ref(), b"export default () => null");
        assert_eq!(
            component_frame_url("demo", Some(4)).unwrap(),
            "emma-component://demo/?v=4"
        );
    }

    #[test]
    fn component_host_preserves_react_runtime_and_component_contract() {
        let variables = vec!["LINEAR_API_KEY".to_owned(), "lower_name".to_owned()];
        let assets = FrameAssets::component_with_config(
            Some("demo"),
            "A dashboard",
            &variables,
            true,
            b"export default (api) => ({})",
            None,
        )
        .unwrap();
        let response = frame_asset_response(
            SurfaceKind::Component,
            "emma-component://demo/?v=4",
            Request::builder()
                .uri("emma-component://demo/?v=4")
                .body(Vec::new())
                .unwrap(),
            &assets,
        );
        let html = String::from_utf8(response.body().to_vec()).unwrap();
        assert!(!html.contains("<script><script>"));
        assert!(
            response.headers()["Content-Security-Policy"]
                .to_str()
                .unwrap()
                .contains("emma-component://demo")
        );
        for marker in [
            "React.createElement",
            "ReactDOM.createRoot",
            "19.2.8",
            "componentFetchRequest",
            "request:Object.assign",
            "capability:\"componentFetch\"",
            "props.children",
            "createElementNS",
            "useEffect",
            "emmaRequest",
            "emmaSubscribe",
            "__emmaReply",
            "__emmaEvent",
            "component bridge",
            "componentShot",
            "expanded:true",
            "LINEAR_API_KEY",
            "lower_name",
            "could not run ·",
            "stopped while it was drawing.",
            "built-body",
        ] {
            assert!(html.contains(marker), "missing {marker}");
        }
    }

    #[test]
    fn app_and_visual_protocols_install_native_bridges() {
        let app = FrameAssets::artifact_app_with_origin(
            Some("demo"),
            "<!doctype html><main>app</main>",
            &[("main.js".to_owned(), b"document.body".to_vec())],
        )
        .unwrap();
        let document = frame_asset_response(
            SurfaceKind::Artifact,
            "emma-artifact://demo/",
            Request::builder()
                .uri("emma-artifact://demo/")
                .body(Vec::new())
                .unwrap(),
            &app,
        );
        let html = String::from_utf8(document.body().to_vec()).unwrap();
        assert!(html.contains("capability:\"artifactSql\""));
        assert!(html.contains("globalThis.__emmaReply"));
        assert!(
            document.headers()["Content-Security-Policy"]
                .to_str()
                .unwrap()
                .contains("emma-artifact://demo")
        );
        let file = frame_asset_response(
            SurfaceKind::Artifact,
            "emma-artifact://demo/",
            Request::builder()
                .uri("emma-artifact://demo/main.js")
                .body(Vec::new())
                .unwrap(),
            &app,
        );
        assert_eq!(file.status(), 200);
        assert_eq!(
            file.headers()["Content-Type"],
            "text/javascript; charset=utf-8"
        );
        let generic = FrameAssets::document(SurfaceKind::Artifact, "<main>app</main>")
            .unwrap()
            .with_files(&[("index.html".to_owned(), b"<p>ok</p>".to_vec())])
            .unwrap();
        assert!(
            frame_asset_response(
                SurfaceKind::Artifact,
                "emma-artifact://demo/",
                Request::builder()
                    .uri("emma-artifact://demo/index.html")
                    .body(Vec::new())
                    .unwrap(),
                &generic,
            )
            .headers()["Content-Security-Policy"]
                .to_str()
                .unwrap()
                .contains("script-src 'self'")
        );
        let visual = visual_page("<div id=\"chart\">ok</div>").unwrap();
        assert!(visual.contains("visualHeight"));
        assert!(visual.contains("visualPick"));
        assert!(visual.contains("visual-height"));
        assert!(visual.contains("visual-picked"));
        assert!(visual.contains("ResizeObserver"));
    }

    #[test]
    fn frame_bridge_replies_are_correlated_and_component_ids_are_scoped() {
        let script = bridge_reply_script(&BridgeReply::ok(9, json!({ "rows": [1] })));
        assert!(script.contains("\"n\":9"));
        assert!(script.contains("__emmaReply"));
        assert!(
            parse_frame_bridge_message(
                SurfaceKind::Component,
                "emma-component://demo/",
                "emma-component://demo/",
                r#"{"emma":"componentFetch","id":"other","url":"https://example.com"}"#,
            )
            .is_err()
        );
        assert!(
            parse_frame_bridge_message(
                SurfaceKind::Component,
                "emma-component://demo/",
                "emma-component://demo/",
                r#"{"capability":"componentFetch","n":6,"id":"other","request":{"url":"https://example.com"}}"#,
            )
            .is_err()
        );
        assert!(
            parse_bridge_message(
                SurfaceKind::Component,
                r#"{"capability":"emmaRequest","n":2,"method":"listComponents","params":{}}"#,
            )
            .is_ok()
        );
        assert!(
            parse_bridge_message(
                SurfaceKind::Visual,
                r#"{"capability":"visualHeight","height":120}"#,
            )
            .is_ok()
        );
    }

    #[test]
    fn sql_policy_accepts_one_statement_and_rejects_injection() {
        assert!(validate_artifact_sql("select ';' as value;", &[]).is_ok());
        assert!(validate_artifact_sql("select 1; select 2", &[]).is_err());
        assert!(validate_artifact_sql("select 1", &[json!({"not": "bindable"})]).is_err());
        assert!(validate_artifact_sql(&"x".repeat(MAX_SQL_CHARS + 1), &[]).is_err());
    }

    #[test]
    fn controller_preserves_tab_selection_and_address_escape() {
        let mut controller = BrowserController::new();
        assert_eq!(
            controller.new_tab(None),
            Ok(BrowserCommand::Load {
                tab_id: "t1".to_owned(),
                url: HOME_URL.to_owned()
            })
        );
        controller.begin_address_edit();
        controller.set_address_draft("https://example.com");
        controller.cancel_address_edit();
        assert!(!controller.address_editing());
        assert_eq!(controller.address_draft(), HOME_URL);
        let _ = controller.submit_address("example.com").unwrap();
        assert_eq!(
            controller.active_tab().map(|tab| tab.url.as_str()),
            Some("https://example.com")
        );
    }

    #[test]
    fn browser_metadata_is_bounded_and_rejects_untrusted_payloads() {
        assert_eq!(
            parse_browser_metadata(
                r#"{"emma":"browser-metadata","title":"Emma\nBrowser","favicon":"https://example.com/icon.png"}"#,
            ),
            Some((
                "EmmaBrowser".to_owned(),
                Some("https://example.com/icon.png".to_owned())
            ))
        );
        assert_eq!(
            parse_browser_metadata(
                r#"{"emma":"browser-metadata","title":"Emma","favicon":"javascript:alert(1)"}"#,
            ),
            Some(("Emma".to_owned(), None))
        );
        assert_eq!(
            parse_browser_metadata(r#"{"emma":"componentFetch","title":"Emma"}"#),
            None
        );
        assert_eq!(
            parse_browser_metadata(&format!(
                r#"{{"emma":"browser-metadata","title":"{}"}}"#,
                "x".repeat(MAX_BRIDGE_MESSAGE_BYTES)
            )),
            None
        );
        assert!(NATIVE_BROWSER_METADATA.contains("MutationObserver"));
        assert!(NATIVE_BROWSER_METADATA.contains("browser-metadata"));
    }

    #[test]
    fn controller_closes_last_tab_and_cleans_focus() {
        let mut controller = BrowserController::new();
        let _ = controller.new_tab(None);
        let command = controller.close_tab("t1");
        assert_eq!(
            command,
            BrowserCommand::Close {
                tab_id: "t1".to_owned()
            }
        );
        assert!(!controller.visible());
        assert!(!controller.focused());
        assert!(controller.tabs().is_empty());
    }

    #[test]
    fn pip_bounds_match_edge_top_rail_and_minimums() {
        let viewport = PipViewport::new(900., 700., 620.);
        let placement = constrain_pip(
            viewport,
            PipPlacement {
                x: -100.,
                y: -100.,
                width: 10.,
                height: 10.,
                collapsed: false,
                loose: false,
            },
        );
        assert_eq!((placement.x, placement.y), (PIP_EDGE, PIP_TOP));
        assert_eq!(
            (placement.width, placement.height),
            (PIP_MIN_WIDTH, PIP_MIN_HEIGHT)
        );
        let stacked = stacked_pip(&placement, PIP_DEEPEST + 1);
        assert_eq!(
            (stacked.x, stacked.y),
            (
                placement.x + PIP_STACK * PIP_DEEPEST as f32,
                placement.y - PIP_STACK * PIP_DEEPEST as f32
            )
        );
    }

    #[test]
    fn pip_placement_is_deterministic_and_inside_rail() {
        let viewport = PipViewport::new(900., 700., 620.);
        let first = default_pip_placement(viewport);
        let second = default_pip_placement(viewport);
        assert_eq!(first, second);
        assert!(first.x >= PIP_EDGE);
        assert!(first.y >= PIP_TOP);
        assert!(first.x + first.width <= viewport.width - PIP_RAIL - PIP_EDGE);
        assert!(first.y + first.height <= viewport.floor - PIP_EDGE);
    }

    #[test]
    fn native_text_does_not_require_a_webview() {
        assert!(!SurfaceKind::Artifact.requires_webview(SurfaceContent::Markdown));
        assert!(!SurfaceKind::Visual.requires_webview(SurfaceContent::PlainText));
        assert!(SurfaceKind::Artifact.requires_webview(SurfaceContent::Html));
        assert!(SurfaceKind::Browser.requires_webview(SurfaceContent::Interactive));
    }
}
