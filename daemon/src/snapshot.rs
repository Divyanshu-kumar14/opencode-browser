//! Snapshot pipeline (§2.4): three CDP round trips, no per-element calls.
//!
//! 1. Inject JS (`Runtime.evaluate`): tag interactive elements with
//!    `data-oc-uid="g{gen}-{n}"`, return bounds + tag + label-ish fields.
//! 2. `DOM.getDocument(depth:-1)`: walk attributes to build
//!    `backendNodeId → uid` (one call, no per-node queries).
//! 3. `Accessibility.getFullAXTree`: drop `ignored` nodes, join
//!    `backendDOMNodeId → uid`, attach role/name/state.
//!
//! A missed AX join never fails the snapshot: the role falls back to a tag
//! heuristic. Uids always come from the injected script, so `check_uid` can
//! only pass for uids the current generation actually produced.

use std::collections::{HashMap, HashSet};

use chromiumoxide::cdp::browser_protocol::accessibility::{AxNode, GetFullAxTreeParams};
use chromiumoxide::cdp::browser_protocol::dom::{GetDocumentParams, Node};
use serde::{Deserialize, Serialize};

use crate::error::RpcError;
use crate::tabs::Tab;

/// Default cap on rendered snapshot nodes (§2.3/§2.4).
pub const DEFAULT_MAX_NODES: usize = 300;
/// Hard cap so a hostile page cannot blow the 32 MiB frame budget.
pub const HARD_MAX_NODES: usize = 2000;

/// One interactive element, as reported by the injected script.
#[derive(Debug, Default, Clone, Deserialize)]
#[serde(default)]
struct RawNode {
    uid: String,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    tag: String,
    role_attr: String,
    #[serde(rename = "type")]
    input_type: String,
    label: String,
    value: String,
    checked: bool,
    disabled: bool,
    href: String,
    placeholder: String,
}

/// Role/name/state joined from the AX tree.
#[derive(Debug, Default, Clone)]
struct AxInfo {
    role: String,
    name: String,
    value: String,
    flags: Vec<String>,
}

/// One rendered snapshot line, also returned structurally.
#[derive(Debug, Clone, Serialize)]
pub struct SnapshotNode {
    pub uid: String,
    pub role: String,
    pub name: String,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct SnapshotOut {
    pub tab_id: String,
    pub url: String,
    pub generation: u64,
    pub text: String,
    pub nodes: Vec<SnapshotNode>,
    pub total: usize,
    pub truncated: bool,
}

/// Run the full 3-call pipeline under the caller's per-tab lock.
pub async fn run_snapshot(
    tab: &Tab,
    max_nodes: usize,
    include_ax: bool,
) -> Result<SnapshotOut, RpcError> {
    let generation = tab.generation();
    let raws = inject_uids(tab, generation).await?;

    let dom = tab
        .exec(GetDocumentParams::builder().depth(-1).pierce(true).build())
        .await?;
    let mut backend_to_uid: HashMap<i64, String> = HashMap::with_capacity(raws.len());
    walk_dom(&dom.root, &mut backend_to_uid);

    let mut ax_by_uid: HashMap<String, AxInfo> = HashMap::with_capacity(raws.len());
    if include_ax {
        let tree = tab.exec(GetFullAxTreeParams::builder().build()).await?;
        join_ax_tree(&tree.nodes, &backend_to_uid, &mut ax_by_uid);
    }

    let max = max_nodes.clamp(1, HARD_MAX_NODES);
    let total = raws.len();
    let truncated = total > max;

    let mut lines = Vec::with_capacity(total.min(max) + 2);
    lines.push(format!("url: {}  (gen g{generation})", tab.url()));
    let mut nodes = Vec::with_capacity(total.min(max));
    for raw in raws.iter().take(max) {
        let ax = ax_by_uid.get(&raw.uid);
        lines.push(render_node(raw, ax));
        nodes.push(SnapshotNode {
            uid: raw.uid.clone(),
            role: node_role(raw, ax).to_string(),
            name: node_name(raw, ax).to_string(),
            x: raw.x,
            y: raw.y,
            w: raw.w,
            h: raw.h,
        });
    }
    if truncated {
        lines.push(format!(
            "… {} more (max_nodes={max}, truncated)",
            total - max
        ));
    }

    // Register every injected uid (even past the render cap) so a click on a
    // truncated node resolves instead of misreporting UID_NOT_FOUND.
    tab.set_uids(raws.into_iter().map(|raw| raw.uid).collect());

    Ok(SnapshotOut {
        tab_id: tab.id.clone(),
        url: tab.url(),
        generation,
        text: lines.join("\n"),
        nodes,
        total,
        truncated,
    })
}

/// Step 1: tag candidates and read back their geometry + label fields.
async fn inject_uids(tab: &Tab, generation: u64) -> Result<Vec<RawNode>, RpcError> {
    // `generation` is a u64 rendered by the daemon: safe to interpolate.
    let js = format!(
        r#"(() => {{
  const gen = {generation};
  const SEL = 'a[href],button,input,select,textarea,summary,[role],[tabindex],[contenteditable]';
  const trunc = (s, m) => (s || '').trim().replace(/\s+/g, ' ').slice(0, m);
  const out = [];
  let n = 0;
  for (const el of document.querySelectorAll(SEL)) {{
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    if (el.tagName === 'INPUT' && (el.type || '').toLowerCase() === 'hidden') continue;
    n += 1;
    const uid = 'g' + gen + '-' + n;
    el.setAttribute('data-oc-uid', uid);
    const r = el.getBoundingClientRect();
    const label = el.getAttribute('aria-label')
      || trunc(el.innerText, 80)
      || el.value
      || el.getAttribute('placeholder')
      || el.title
      || el.getAttribute('alt')
      || el.getAttribute('name')
      || '';
    out.push({{
      uid,
      x: Math.round(r.x * 10) / 10, y: Math.round(r.y * 10) / 10,
      w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10,
      tag: el.tagName.toLowerCase(),
      role_attr: el.getAttribute('role') || '',
      type: (el.type || ''),
      label: trunc(label, 80),
      value: trunc(typeof el.value === 'string' ? el.value : '', 120),
      checked: !!el.checked,
      disabled: !!el.disabled,
      href: trunc(el.getAttribute('href'), 160),
      placeholder: trunc(el.getAttribute('placeholder'), 80),
    }});
  }}
  return out;
}})()"#
    );
    let value = tab.eval_json(&js).await.map_err(|err| {
        crate::error::RpcError::internal(format!("snapshot uid injection failed: {err}"))
    })?;
    serde_json::from_value::<Vec<RawNode>>(value).map_err(|err| {
        crate::error::RpcError::internal(format!(
            "snapshot uid injection returned unexpected JSON: {err}"
        ))
    })
}

/// Step 2: walk the DOM once, mapping `backendNodeId → data-oc-uid`.
fn walk_dom(node: &Node, map: &mut HashMap<i64, String>) {
    if let Some(attrs) = node.attributes.as_ref() {
        let mut i = 0;
        while i + 1 < attrs.len() {
            if attrs[i] == "data-oc-uid" {
                map.insert(node.backend_node_id.0, attrs[i + 1].clone());
                break;
            }
            i += 2;
        }
    }
    if let Some(children) = node.children.as_ref() {
        for child in children {
            walk_dom(child, map);
        }
    }
}

/// Step 3: join non-ignored AX nodes onto the uids from step 1.
fn join_ax_tree(
    ax_nodes: &[AxNode],
    backend_to_uid: &HashMap<i64, String>,
    out: &mut HashMap<String, AxInfo>,
) {
    for node in ax_nodes {
        if node.ignored {
            continue;
        }
        let Some(backend) = node.backend_dom_node_id.as_ref() else {
            continue;
        };
        let Some(uid) = backend_to_uid.get(&backend.0) else {
            continue;
        };
        let mut flags = Vec::new();
        if let Some(props) = node.properties.as_ref() {
            for prop in props {
                let name = format!("{:?}", prop.name).to_lowercase();
                let on = prop.value.value.as_ref() == Some(&serde_json::Value::Bool(true));
                if on
                    && matches!(
                        name.as_str(),
                        "disabled"
                            | "checked"
                            | "expanded"
                            | "selected"
                            | "focused"
                            | "pressed"
                            | "modal"
                            | "readonly"
                            | "required"
                            | "invalid"
                    )
                {
                    flags.push(name);
                }
            }
        }
        out.insert(
            uid.clone(),
            AxInfo {
                role: ax_string(&node.role),
                name: ax_string(&node.name),
                value: ax_string(&node.value).chars().take(120).collect(),
                flags,
            },
        );
    }
}

/// Accessible-name-ish string from an AX value: the JSON string when present.
fn ax_string(
    value: &Option<chromiumoxide::cdp::browser_protocol::accessibility::AxValue>,
) -> String {
    let Some(v) = value.as_ref() else {
        return String::new();
    };
    match v.value.as_ref() {
        Some(serde_json::Value::String(s)) => s.clone(),
        Some(other) => {
            let text = other.to_string();
            text.trim_matches('"').chars().take(160).collect()
        }
        None => String::new(),
    }
}

/// Heuristic role when the AX join missed (never fails the snapshot).
fn heuristic_role(raw: &RawNode) -> &str {
    if !raw.role_attr.is_empty() {
        return raw.role_attr.as_str();
    }
    match raw.tag.as_str() {
        "a" => "link",
        "button" => "button",
        "select" => "combobox",
        "textarea" => "textbox",
        "summary" => "button",
        "input" => match raw.input_type.to_lowercase().as_str() {
            "checkbox" => "checkbox",
            "radio" => "radio",
            "submit" | "button" | "reset" | "image" | "file" => "button",
            _ => "textbox",
        },
        _ => "generic",
    }
}

fn node_role<'a>(raw: &'a RawNode, ax: Option<&'a AxInfo>) -> &'a str {
    match ax {
        Some(info) if !info.role.is_empty() => info.role.as_str(),
        _ => heuristic_role(raw),
    }
}

fn node_name<'a>(raw: &'a RawNode, ax: Option<&'a AxInfo>) -> &'a str {
    match ax {
        Some(info) if !info.name.is_empty() => info.name.as_str(),
        _ => raw.label.as_str(),
    }
}

fn render_node(raw: &RawNode, ax: Option<&AxInfo>) -> String {
    let role = node_role(raw, ax);
    let name = node_name(raw, ax);
    let mut line = format!("[{}] {role} \"{name}\"", raw.uid);
    match role {
        "textbox" | "combobox" | "searchbox" => {
            let value = ax
                .map(|info| info.value.as_str())
                .filter(|value| !value.is_empty())
                .unwrap_or(raw.value.as_str());
            line.push_str(&format!(" value=\"{value}\""));
            if !raw.placeholder.is_empty() && value.is_empty() {
                line.push_str(&format!(" placeholder=\"{}\"", raw.placeholder));
            }
        }
        "link" if !raw.href.is_empty() => {
            line.push_str(&format!(" → {}", raw.href));
        }
        _ => {}
    }
    let mut flags: Vec<&str> = Vec::new();
    if raw.disabled {
        flags.push("disabled");
    }
    if raw.checked {
        flags.push("checked");
    }
    if let Some(info) = ax {
        for flag in &info.flags {
            if !flags.contains(&flag.as_str()) {
                flags.push(flag.as_str());
            }
        }
    }
    // De-duplicate while keeping first-seen order.
    let mut seen = HashSet::new();
    for flag in flags {
        if seen.insert(flag) {
            line.push_str(&format!(" [{flag}]"));
        }
    }
    line
}

#[cfg(test)]
mod tests {
    use super::*;

    fn raw(uid: &str, tag: &str) -> RawNode {
        RawNode {
            uid: uid.to_string(),
            tag: tag.to_string(),
            label: "Lbl".to_string(),
            ..Default::default()
        }
    }

    #[test]
    fn heuristic_roles_cover_common_tags() {
        assert_eq!(heuristic_role(&raw("g1-1", "a")), "link");
        assert_eq!(heuristic_role(&raw("g1-1", "button")), "button");
        assert_eq!(heuristic_role(&raw("g1-1", "select")), "combobox");
        assert_eq!(heuristic_role(&raw("g1-1", "textarea")), "textbox");
        let mut checkbox = raw("g1-1", "input");
        checkbox.input_type = "checkbox".to_string();
        assert_eq!(heuristic_role(&checkbox), "checkbox");
        let custom = RawNode {
            role_attr: "switch".to_string(),
            ..raw("g1-1", "div")
        };
        assert_eq!(heuristic_role(&custom), "switch");
    }

    #[test]
    fn render_falls_back_without_ax_and_marks_truncation() {
        let mut button = raw("g7-3", "button");
        button.label = "Sign in".to_string();
        assert_eq!(render_node(&button, None), "[g7-3] button \"Sign in\"");

        let mut email = raw("g7-1", "input");
        email.label = "Email".to_string();
        email.value = "a@b.c".to_string();
        assert_eq!(
            render_node(&email, None),
            "[g7-1] textbox \"Email\" value=\"a@b.c\""
        );

        let mut link = raw("g7-4", "a");
        link.label = "Forgot password".to_string();
        link.href = "/forgot".to_string();
        assert_eq!(
            render_node(&link, None),
            "[g7-4] link \"Forgot password\" → /forgot"
        );
    }

    #[test]
    fn ax_info_wins_over_heuristic_and_dedupes_flags() {
        let mut checkbox = raw("g7-2", "input");
        checkbox.input_type = "checkbox".to_string();
        checkbox.checked = true;
        let ax = AxInfo {
            role: "checkbox".to_string(),
            name: "Remember me".to_string(),
            value: String::new(),
            flags: vec!["checked".to_string(), "focused".to_string()],
        };
        assert_eq!(
            render_node(&checkbox, Some(&ax)),
            "[g7-2] checkbox \"Remember me\" [checked] [focused]"
        );
    }

    #[test]
    fn ax_string_prefers_json_strings() {
        use chromiumoxide::cdp::browser_protocol::accessibility::{AxValue, AxValueType};
        let value = AxValue {
            value: Some(serde_json::Value::String("Go".to_string())),
            ..AxValue::new(AxValueType::String)
        };
        assert_eq!(ax_string(&Some(value)), "Go");
        assert_eq!(ax_string(&None), "");
    }

    // --- B1 scale guard: 1k/10k fixtures exercising walk_dom + join_ax_tree
    // + the render glue on large inputs (deterministic asserts only).
    use chromiumoxide::cdp::browser_protocol::accessibility::{
        AxProperty, AxPropertyName, AxValue, AxValueType,
    };
    use chromiumoxide::cdp::browser_protocol::dom::BackendNodeId;

    fn ax_str(value: String) -> AxValue {
        AxValue {
            value: Some(serde_json::Value::String(value)),
            ..AxValue::new(AxValueType::String)
        }
    }

    fn ax_bool(on: bool) -> AxValue {
        AxValue {
            value: Some(serde_json::Value::Bool(on)),
            ..AxValue::new(AxValueType::Boolean)
        }
    }

    fn dom_subtree(start: usize, end: usize, depth: u32, next_container: &mut i64) -> Node {
        const WIDTH: usize = 32;
        const MAX_DEPTH: u32 = 4;
        let mut children = Vec::new();
        if depth >= MAX_DEPTH || end - start <= WIDTH {
            for i in start..end {
                children.push(Node {
                    backend_node_id: BackendNodeId(i as i64 + 1),
                    node_name: "input".to_string(),
                    attributes: Some(vec![
                        "class".to_string(),
                        "f".to_string(),
                        "data-oc-uid".to_string(),
                        format!("g7-{}", i + 1),
                        "type".to_string(),
                        "text".to_string(),
                    ]),
                    ..Default::default()
                });
            }
        } else {
            let chunk = (end - start).div_ceil(WIDTH);
            let mut cursor = start;
            while cursor < end {
                let stop = (cursor + chunk).min(end);
                children.push(dom_subtree(cursor, stop, depth + 1, next_container));
                cursor = stop;
            }
        }
        *next_container += 1;
        Node {
            backend_node_id: BackendNodeId(*next_container),
            node_name: "div".to_string(),
            attributes: Some(vec!["class".to_string(), "wrap".to_string()]),
            children: Some(children),
            ..Default::default()
        }
    }

    fn build_dom_fixture(interactive: usize) -> Node {
        let mut next_container = 2_000_000i64;
        dom_subtree(0, interactive, 0, &mut next_container)
    }

    fn build_ax_fixture(interactive: usize) -> Vec<AxNode> {
        let mut nodes = Vec::with_capacity(interactive * 2);
        for i in 0..interactive {
            nodes.push(AxNode {
                ignored: false,
                backend_dom_node_id: Some(BackendNodeId(i as i64 + 1)),
                role: Some(ax_str("button".to_string())),
                name: Some(ax_str(format!("Action {i}"))),
                value: Some(ax_str(String::new())),
                properties: Some(vec![
                    AxProperty::new(AxPropertyName::Disabled, ax_bool(false)),
                    AxProperty::new(AxPropertyName::Checked, ax_bool(i % 2 == 0)),
                    AxProperty::new(AxPropertyName::Focused, ax_bool(false)),
                ]),
                ..Default::default()
            });
            // Ignored filler exercises the join skip path at 1:1 ratio.
            nodes.push(AxNode {
                ignored: true,
                ..Default::default()
            });
        }
        nodes
    }

    fn build_raws_fixture(count: usize) -> Vec<RawNode> {
        const TAGS: [&str; 5] = ["input", "a", "button", "select", "textarea"];
        (0..count)
            .map(|i| RawNode {
                uid: format!("g7-{}", i + 1),
                x: 10.0,
                y: 20.0,
                w: 100.0,
                h: 24.0,
                tag: TAGS[i % TAGS.len()].to_string(),
                role_attr: String::new(),
                input_type: "text".to_string(),
                label: format!("Field number {i}"),
                value: String::new(),
                checked: false,
                disabled: false,
                href: if i % TAGS.len() == 1 {
                    "/go".to_string()
                } else {
                    String::new()
                },
                placeholder: "Type here".to_string(),
            })
            .collect()
    }

    /// Mirror of the run_snapshot CPU tail (B1 region) so the harness measures
    /// production glue exactly. B1 edits must update this function in lockstep.
    fn render_glue(
        raws: &[RawNode],
        ax_by_uid: &HashMap<String, AxInfo>,
        max: usize,
    ) -> (String, Vec<SnapshotNode>, usize, bool, Vec<String>) {
        let total = raws.len();
        let truncated = total > max;
        let mut lines = Vec::with_capacity(total.min(max) + 2);
        lines.push(format!("url: {}  (gen g{})", "http://example/", 7));
        let mut nodes = Vec::with_capacity(total.min(max));
        for raw in raws.iter().take(max) {
            let ax = ax_by_uid.get(&raw.uid);
            lines.push(render_node(raw, ax));
            nodes.push(SnapshotNode {
                uid: raw.uid.clone(),
                role: node_role(raw, ax).to_string(),
                name: node_name(raw, ax).to_string(),
                x: raw.x,
                y: raw.y,
                w: raw.w,
                h: raw.h,
            });
        }
        if truncated {
            lines.push(format!(
                "… {} more (max_nodes={max}, truncated)",
                total - max
            ));
        }
        let text = lines.join("\n");
        let uids: Vec<String> = raws.iter().map(|raw| raw.uid.clone()).collect();
        (text, nodes, total, truncated, uids)
    }

    #[test]
    fn scale_guard_large_fixtures() {
        for &count in &[1_000usize, 10_000usize] {
            let root = build_dom_fixture(count);
            let ax_nodes = build_ax_fixture(count);
            let raws = build_raws_fixture(count);

            // Full uid mapping through walk + join on the large fixture.
            let mut backend_to_uid: HashMap<i64, String> = HashMap::with_capacity(raws.len());
            walk_dom(&root, &mut backend_to_uid);
            assert_eq!(backend_to_uid.len(), count);
            let mut ax_by_uid: HashMap<String, AxInfo> = HashMap::with_capacity(raws.len());
            join_ax_tree(&ax_nodes, &backend_to_uid, &mut ax_by_uid);
            assert_eq!(ax_by_uid.len(), count);

            // Render cap, truncation text and uid shape.
            let (text, nodes, total, truncated, uids) =
                render_glue(&raws, &ax_by_uid, DEFAULT_MAX_NODES);
            assert_eq!(total, count);
            assert_eq!(truncated, count > DEFAULT_MAX_NODES);
            assert_eq!(nodes.len(), count.min(DEFAULT_MAX_NODES));
            assert_eq!(uids.len(), count);
            assert_eq!(nodes[0].uid, "g7-1");
            assert!(text.contains(&format!(
                "… {} more (max_nodes={}, truncated)",
                count - DEFAULT_MAX_NODES,
                DEFAULT_MAX_NODES
            )));
        }
    }
}
