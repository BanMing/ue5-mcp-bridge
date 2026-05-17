/**
 * Tool Router for UE5 MCP Bridge
 *
 * Classifies tools into three layers:
 * - Simple: pass through from Unreal unchanged (13 tools)
 * - Hidden: callable but never listed (9 tools — task queue + script eval +
 *   run_console_command)
 * - Mega: collapsed into unreal_ue router (17 domains, 25 underlying tools)
 *
 * Token budget: 47 raw Unreal tools / ~50K tokens -> 14 LLM-facing tools
 * (13 simple + 1 router) / ~14K tokens.
 *
 * All non-Simple, non-Hidden C++ tools registered in MCPToolRegistry.cpp
 * MUST appear in DOMAIN_TOOL_MAP (or in a sub-route) or they become orphaned
 * — invisible to list_tools AND unreachable through unreal_ue.
 */

// Simple tools: appear in list_tools with full schema
export const SIMPLE_TOOL_NAMES = new Set([
  "spawn_actor",
  "move_actor",
  "delete_actors",
  "set_property",
  "get_level_actors",
  "open_level",
  "asset_search",
  "asset_dependencies",
  "asset_referencers",
  "capture_viewport",
  "capture_pie_screenshot",
  "get_output_log",
  "blueprint_query",
]);

// Hidden tools: callable but never listed
export const HIDDEN_TOOL_NAMES = new Set([
  "task_submit",
  "task_status",
  "task_result",
  "task_list",
  "task_cancel",
  "execute_script",
  "cleanup_scripts",
  "get_script_history",
  "run_console_command",
]);

// Domain -> underlying Unreal tool name (default route; sub-routes below).
// Domains marked (single) have no sub-routing — the op set lives entirely
// inside the target tool's own dispatch.
export const DOMAIN_TOOL_MAP = {
  blueprint: "blueprint_modify",         // + blueprint_query sub-route
  anim: "anim_blueprint_modify",         // single
  character: "character",                // + character_data sub-route
  enhanced_input: "enhanced_input",      // single
  material: "material",                  // single
  asset: "asset",                        // + asset_manage sub-route
  umg: "umg_modify",                     // + umg_query/session/animation sub-routes

  // PR-A: PIE control + build/live-coding
  pie: "pie_session",                    // + pie_input sub-route
  build: "trigger_live_coding",          // + build_and_relaunch sub-route

  // PR-E: StateTree
  statetree: "statetree_modify",         // + statetree_query sub-route

  // PR-G: Niagara + GAS
  niagara: "niagara_modify",             // single
  gas: "gas_modify",                     // single

  // PR-F: log reader + web research (op-dispatched, exposed as single-tool domains)
  logs: "logs_read",                     // single
  web: "web_research",                   // single

  // Story-2: Material Graph / HLSL (own domains because set_target / compile op
  // names collide with each other AND with the base material domain — keeping
  // them as distinct domains avoids ambiguous routing).
  material_graph: "material_graph",      // single
  material_hlsl: "material_hlsl",        // single

  // DataTable (generic, any UStruct row type)
  datatable: "generic_datatable",        // single
};

// Blueprint operations that route to "blueprint_query" instead of "blueprint_modify"
export const BLUEPRINT_QUERY_OPS = new Set([
  "list",
  "inspect",
  "get_graph",
  "get_nodes",
  "get_variables",
  "get_functions",
  "get_node_pins",
  "search_nodes",
  "find_references",
]);

// Character operations that route to "character_data" instead of "character".
// Names must match the Operation strings dispatched in MCPTool_CharacterData.cpp.
const CHARACTER_DATA_OPS = new Set([
  "create_character_data",
  "query_character_data",
  "get_character_data",
  "update_character_data",
  "create_stats_table",
  "query_stats_table",
  "add_stats_row",
  "update_stats_row",
  "remove_stats_row",
  "apply_character_data",
]);

// UMG operations sub-routed away from the default "umg_modify" tool.
// FMCPTool_UMGModify (the default for the "umg" domain) only handles the
// 5 mutation ops below; everything else lives in sibling tools that the
// router has to dispatch to explicitly. Op names must match the strings
// dispatched in MCPTool_UMG{Query,Session,Animation}.cpp.
const UMG_QUERY_OPS = new Set([
  "get_widget_tree",
  "query_widget_properties",
  "get_widget_schema",
  "get_layout_data",
  "get_creatable_widget_types",
]);

const UMG_SESSION_OPS = new Set([
  "get_target",
  "set_target",
  "get_last_edited",
  "get_recently_edited",
]);

const UMG_ANIMATION_OPS = new Set([
  "get_all_animations",
  "create_animation",
  "delete_animation",
  "get_animation_keyframes",
  "get_widget_animation_data",
  "set_property_keys",
  "remove_property_track",
  "remove_keys",
  "append_widget_tracks",
  "set_animation_data",
  "sample_at_time",
  "append_time_slice",
]);

// PIE input ops (sub-route under "pie"). Default route for "pie" domain is
// pie_session (start/stop/pause/resume/get_state/wait_for). These op names
// must match the Action strings dispatched in MCPTool_PIEInput.cpp.
const PIE_INPUT_OPS = new Set([
  "key",
  "action",
  "axis",
  "move_to",
  "look_at",
  "inject_action",
]);

// Build/relaunch ops (sub-route under "build"). Default route for "build"
// domain is trigger_live_coding (the most common op). build_and_relaunch is
// destructive (kills the editor) so it lives behind an explicit op name.
const BUILD_RELAUNCH_OPS = new Set([
  "relaunch",
  "build_and_relaunch",
  "build_relaunch",
]);

// StateTree query op (sub-route under "statetree"). Default route is
// statetree_modify (add_state/add_task/add_transition/remove_state per
// MCPTool_StateTreeModify.cpp). Query is single-shot — any of these synonyms
// triggers the read tool.
const STATETREE_QUERY_OPS = new Set([
  "query",
  "inspect",
  "get_info",
  "read",
]);

// Asset operations that route to "asset_manage" instead of "asset".
// FMCPTool_Asset (slim tool) only exposes set_asset_property/save_asset/
// get_asset_info/list_assets. Everything else — CRUD, search, delete with
// referencer guard — lives in FMCPTool_AssetManage and must be reached
// through the JS router since the schema advertises a unified "asset" domain.
const ASSET_MANAGE_OPS = new Set([
  "search",
  "find",
  "list_folder",
  "open_in_editor",
  "save_all_dirty",
  "duplicate",
  "move",
  "delete",
]);

/**
 * Resolve a router call to the underlying Unreal tool name.
 * @param {string} domain - e.g. "blueprint", "anim", "character"
 * @param {string} operation - e.g. "add_variable", "create_state_machine"
 * @returns {string|null} Underlying tool name, or null if domain unknown
 */
export function resolveUnrealTool(domain, operation) {
  if (!domain) return null;
  if (domain === "character" && CHARACTER_DATA_OPS.has(operation)) {
    return "character_data";
  }
  if (domain === "blueprint" && BLUEPRINT_QUERY_OPS.has(operation)) {
    return "blueprint_query";
  }
  if (domain === "asset" && ASSET_MANAGE_OPS.has(operation)) {
    return "asset_manage";
  }
  if (domain === "umg") {
    if (UMG_QUERY_OPS.has(operation))     return "umg_query";
    if (UMG_SESSION_OPS.has(operation))   return "umg_session";
    if (UMG_ANIMATION_OPS.has(operation)) return "umg_animation";
    // Default falls through to DOMAIN_TOOL_MAP["umg"] = "umg_modify" below.
  }
  if (domain === "pie" && PIE_INPUT_OPS.has(operation)) {
    return "pie_input";
  }
  if (domain === "build" && BUILD_RELAUNCH_OPS.has(operation)) {
    return "build_and_relaunch";
  }
  if (domain === "statetree" && STATETREE_QUERY_OPS.has(operation)) {
    return "statetree_query";
  }
  return DOMAIN_TOOL_MAP[domain] ?? null;
}

/**
 * Classify a tool for list_tools filtering.
 * @param {string} toolName - raw Unreal tool name (no "unreal_" prefix)
 * @returns {"simple"|"hidden"|"mega"}
 */
export function classifyTool(toolName) {
  if (SIMPLE_TOOL_NAMES.has(toolName)) return "simple";
  if (HIDDEN_TOOL_NAMES.has(toolName)) return "hidden";
  return "mega";
}

// Reverse map: tool name → domain (built from DOMAIN_TOOL_MAP)
const TOOL_TO_DOMAIN = Object.fromEntries(
  Object.entries(DOMAIN_TOOL_MAP).map(([domain, tool]) => [tool, domain])
);
TOOL_TO_DOMAIN["character_data"] = "character";   // sub-route
TOOL_TO_DOMAIN["asset_manage"] = "asset";         // sub-route for CRUD ops
TOOL_TO_DOMAIN["umg_query"] = "umg";              // sub-route for read ops
TOOL_TO_DOMAIN["umg_session"] = "umg";            // sub-route for target/recents
TOOL_TO_DOMAIN["umg_animation"] = "umg";          // sub-route for animation ops
TOOL_TO_DOMAIN["pie_input"] = "pie";              // sub-route for input injection
TOOL_TO_DOMAIN["build_and_relaunch"] = "build";   // sub-route for destructive rebuild
TOOL_TO_DOMAIN["statetree_query"] = "statetree";  // sub-route for read ops
TOOL_TO_DOMAIN["blueprint_query"] = "blueprint";  // sub-route already exposed as SIMPLE

/**
 * Categorize a tool for the unreal_status health check.
 * Uses the router classification + domain map for accurate grouping.
 * @param {string} toolName - raw Unreal tool name (no "unreal_" prefix)
 * @returns {string} Category name for status display
 */
export function categorizeToolForStatus(toolName) {
  const cls = classifyTool(toolName);
  if (cls === "mega") return TOOL_TO_DOMAIN[toolName] || "utility";
  if (cls === "hidden") return toolName.startsWith("task_") ? "task_queue" : "scripting";
  // Simple tools
  if (toolName.startsWith("asset_")) return "asset";
  if (toolName === "blueprint_query") return "blueprint";
  if (toolName === "open_level") return "level";
  if (toolName.includes("actor") || toolName === "spawn_actor" ||
      toolName === "move_actor" || toolName === "delete_actors" ||
      toolName === "set_property") return "actor";
  return "utility"; // capture_viewport, capture_pie_screenshot, get_output_log
}

/**
 * Static MCP schema for the unreal_ue router tool.
 */
export const ROUTER_TOOL_SCHEMA = {
  name: "unreal_ue",
  description: [
    "Route a command to a domain-specific Unreal Editor tool.",
    "",
    'domain:"blueprint"',
    "  modify ops: create, add_variable, remove_variable, add_function,",
    "  remove_function, add_node, add_nodes, delete_node, connect_pins,",
    "  disconnect_pins, set_pin_value",
    "  query ops: list, inspect, get_graph, get_nodes, get_variables,",
    "  get_functions, get_node_pins, search_nodes, find_references",
    "  Modify requires blueprint_path. Query: list uses path_filter/type_filter/name_filter,",
    "  inspect/get_graph/get_nodes/get_variables/get_functions require blueprint_path.",
    "  get_node_pins requires blueprint_path + node_id.",
    "  search_nodes requires blueprint_path + query.",
    "  find_references requires blueprint_path + ref_name.",
    "  add_node uses node_type+node_params; positions are pos_x/pos_y scalars.",
    "  add_nodes per-node spec accepts type or node_type + params or node_params; connections accept",
    "  from_node/from_pin/to_node/to_pin OR source_node_id/source_pin/target_node_id/target_pin.",
    "  connect_pins/disconnect_pins/delete_node/add_node/set_pin_value optionally accept",
    "  graph_name + is_function_graph (default: event graph).",
    "  No explicit compile op — modify ops auto-compile.",
    "",
    'domain:"anim" (requires params.blueprint_path)',
    "  ops: get_info, get_state_machine, create_state_machine, add_state, remove_state,",
    "  set_entry_state, add_transition, remove_transition, set_transition_duration,",
    "  set_transition_priority, add_condition_node, delete_condition_node,",
    "  connect_condition_nodes, connect_to_result, connect_state_machine_to_output,",
    "  set_state_animation, find_animations, batch, get_transition_nodes,",
    "  inspect_node_pins, set_pin_default_value (or set_pin_value), add_comparison_chain,",
    "  validate_blueprint, get_state_machine_diagram, setup_transition_conditions,",
    "  add_variable, set_variable_default, remove_variable, compile, get_states, get_transitions, get_conduits",
    "  Variable ops use 'variable_name'/'variable_type' (NOT var_name/var_type).",
    "  state_machine accepts either the bound graph name or the node_id from get_info.",
    "  Position accepts BOTH position:{x,y} (canonical) and pos_x/pos_y scalars (matches blueprint domain).",
    "  delete_condition_node/inspect_node_pins/set_pin_default_value/connect_condition_nodes/",
    "  connect_to_result all need: state_machine + from_state + to_state + node_id.",
    "  set_state_animation needs: state_machine, state_name, animation_path; optional animation_type",
    "  (sequence|blendspace|blendspace1d|montage), parameter_bindings (object).",
    "  find_animations canonical filter is 'animation_filter' ('asset_type' deprecated to avoid bridge-wide alias collision).",
    "",
    'domain:"character" (key params: blueprint_path, character_name, asset_name, table_path)',
    "  ops: list_characters, get_character_info, get_movement_params, set_movement_params,",
    "  get_components, get_character_config, assign_anim_bp,",
    "  create_character_data, query_character_data, get_character_data, update_character_data,",
    "  create_stats_table, query_stats_table, add_stats_row, update_stats_row,",
    "  remove_stats_row, apply_character_data",
    "  get_character_config + assign_anim_bp need blueprint_path; assign_anim_bp also needs anim_blueprint_path.",
    "  Character data ops use asset_path; stats table ops use table_path (different asset types).",
    "  query_character_data optional filters: search_name (substring), search_tags (array).",
    "  list_characters returns 'total_found' (and 'total' as deprecated alias).",
    "",
    'domain:"enhanced_input" (key params: action_path/context_path for mutations, action_name/context_name for friendly lookup)',
    "  ops: create_input_action, create_mapping_context, add_mapping, remove_mapping,",
    "  add_trigger, add_modifier, query_context, query_action,",
    "  list_actions, list_contexts, get_action_info",
    "  Mutations + query_* canonical: action_path / context_path (full /Game/...).",
    "  query_action / query_context also accept action_name / context_name as alias.",
    "  get_action_info is the friendly-name variant of query_action.",
    "  create_input_action canonical 'action_name' (also accepts 'name'); create_mapping_context canonical 'context_name' (also accepts 'name').",
    "  list_actions / list_contexts: optional package_path (default /Game/), name_pattern, limit (1-1000, default 50).",
    "  create_input_action value_type accepts: Digital|Boolean|Bool, Axis1D|Float, Axis2D|Vector2D, Axis3D|Vector.",
    "",
    'domain:"material" (key params: material_path, actor_name, parent_material, asset_name)',
    "  ops: create_material_instance, set_material_parameters,",
    "  set_skeletal_mesh_material, set_actor_material, get_material_info",
    "  Canonical path key across the domain is 'material_path'.",
    "  set_material_parameters accepts 'material_instance_path' as deprecated alias.",
    "  get_material_info accepts 'asset_path' as deprecated alias.",
    "",
    'domain:"asset" (key params: asset_path / source_path+dest_path / folder_path)',
    "  property ops (FMCPTool_Asset): set_asset_property, save_asset,",
    "  get_asset_info, list_assets",
    "  CRUD ops (FMCPTool_AssetManage): search, find, list_folder,",
    "  open_in_editor, save_all_dirty, duplicate, move, delete",
    "  delete requires confirm_delete:true; blocked by referencers unless force:true.",
    "",
    'domain:"pie" (PR-A; controls Play-In-Editor session + input injection)',
    "  session ops (FMCPTool_PIESession, default route): start, stop, pause,",
    "    resume, get_state, wait_for",
    "  input ops (FMCPTool_PIEInput): key, action, axis, move_to, look_at,",
    "    inject_action",
    "  start params: mode (selected/PIE/Standalone), num_clients. wait_for params:",
    "    target_state (Playing/Paused/Stopped), timeout_seconds (default 10).",
    "  key params: key (e.g. 'W'), event (Pressed/Released/Repeat). move_to params:",
    "    target/location ({x,y,z}). All input ops act on the PIE pawn.",
    "",
    'domain:"build" (PR-A; C++ build / Live Coding control)',
    "  default op: trigger_live_coding (any op name not in BUILD_RELAUNCH_OPS).",
    "    Triggers a Live Coding compile; editor stays running. Win64 editor only.",
    "  relaunch ops (FMCPTool_BuildAndRelaunch): relaunch, build_and_relaunch,",
    "    build_relaunch — DESTRUCTIVE: spawns detached cmd that closes editor",
    "    → runs Build.bat → relaunches. Use only when reflection-changing C++",
    "    changes (USTRUCT layout / UCLASS hierarchy / new UPROPERTY) require",
    "    a full module reload that Live Coding cannot do safely.",
    "",
    'domain:"statetree" (PR-E; UStateTree asset read+modify)',
    "  default ops (FMCPTool_StateTreeModify): add_state, add_task,",
    "    add_transition, remove_state. All require asset_path.",
    "  query ops (FMCPTool_StateTreeQuery, sub-route): query, inspect, get_info,",
    "    read — single-shot read of states/transitions/tasks/evaluators/parameters.",
    "    Optional params: include (all|states|transitions|tasks|evaluators|",
    "    parameters), detailed (bool, default true).",
    "  Read-before-write convention applies — call query first, confirm state",
    "    names, then modify.",
    "",
    'domain:"niagara" (PR-G; Niagara system control)',
    "  ops (FMCPTool_NiagaraModify): list_systems, get_info, spawn_at_location,",
    "    set_parameter. spawn_at_location needs system_path + location {x,y,z}.",
    "    set_parameter needs system_path + parameter_name + value.",
    "",
    'domain:"gas" (PR-G; Gameplay Ability System asset authoring)',
    "  ops (FMCPTool_GASModify): list_abilities, list_effects, list_attribute_sets,",
    "    create_ability_blueprint, create_effect_blueprint,",
    "    create_attribute_set_blueprint, set_ability_tags, set_effect_modifier.",
    "  NOTE: For Paoge, follow gas-conventions.md naming (UPaogeAbility_<Name>,",
    "    UCLASS(Abstract) for data-style classes, BP children named GA_/GE_/GC_).",
    "",
    'domain:"logs" (PR-F; file-based UE log reader)',
    "  ops (FMCPTool_LogsRead): list, info, read, tail, head, filter, errors,",
    "    warnings, since. Reads .log files from <ProjectDir>/Saved/Logs/, not the",
    "    in-memory output ring (use simple-tool get_output_log for that).",
    "  filter takes pattern (substring). since takes timestamp (UE log format).",
    "  Useful for inspecting logs from prior PIE / cooked-build sessions.",
    "",
    'domain:"web" (PR-F; UE-process-internal web research)',
    "  ops (FMCPTool_WebResearch): search (DuckDuckGo), fetch_page (Jina Reader",
    "    markdown), geocode + reverse_geocode (Nominatim). Runs INSIDE the UE",
    "    process — no external HTTP client needed. Useful for documentation",
    "    lookups during long-running editor sessions.",
    "",
    'domain:"material_graph" (Story-2; Material expression graph authoring)',
    "  ops (FMCPTool_MaterialGraph): set_target, define_variable, add_node,",
    "    delete_node, connect_nodes, connect_pins, set_node_properties,",
    "    get_node_info, set_output_node, compile_asset.",
    "  set_target anchors a 'current material' so subsequent ops can omit",
    "    material_path. NOTE: this is a SEPARATE target from material_hlsl's.",
    "",
    'domain:"material_hlsl" (Story-2; Custom HLSL node authoring)',
    "  ops (FMCPTool_MaterialHLSL): set_target, get, set, compile.",
    "  Writes/reads the HLSL source string on a UMaterialExpressionCustom node.",
    "  set_target anchors the parent Material+Custom node; get/set act on its",
    "  Code property; compile rebuilds the material.",
    "",
    'domain:"datatable" (Generic; any UStruct row type)',
    "  ops (FMCPTool_GenericDataTable): create_table, query_table, add_row,",
    "    update_row, remove_row.",
    "  create_table needs table_path + row_struct_path (the UScriptStruct).",
    "  query_table returns rows as JSON objects keyed by RowName.",
    "",
    'domain:"umg" (key params: widget_blueprint_path; widget_name; widget_type; parent_name)',
    "  modify ops (FMCPTool_UMGModify, default route): create_widget,",
    "    set_widget_properties, delete_widget, reparent_widget, save_asset",
    "  query ops (FMCPTool_UMGQuery): get_widget_tree, query_widget_properties,",
    "    get_widget_schema, get_layout_data, get_creatable_widget_types",
    "  session ops (FMCPTool_UMGSession): set_target, get_target,",
    "    get_last_edited, get_recently_edited",
    "  animation ops (FMCPTool_UMGAnimation): get_all_animations, create_animation,",
    "    delete_animation, get_animation_keyframes, get_widget_animation_data,",
    "    set_property_keys, remove_property_track, remove_keys,",
    "    append_widget_tracks, set_animation_data, sample_at_time, append_time_slice",
    "  set_target lets later calls omit widget_blueprint_path (see umg_session.cpp).",
    "  set_widget_properties: pass CanvasPanelSlot layout as Slot.LayoutData.{Anchors,Offsets,Alignment};",
    "    Slot.Anchors alias is promoted verbatim, but Offsets/Alignment must live under LayoutData",
    "    (or use Array shorthand Slot.Position=[x,y], Slot.Size=[w,h], Slot.Alignment=[x,y]).",
    "  Non-ASCII text (CJK) is UTF-8 safe through this MCP path.",
    "",
    "Pass all domain-specific params inside the params object.",
  ].join("\n"),
  inputSchema: {
    type: "object",
    required: ["domain", "operation"],
    properties: {
      domain: {
        type: "string",
        description: "blueprint | anim | character | enhanced_input | material | asset | umg | pie | build | statetree | niagara | gas | logs | web | material_graph | material_hlsl | datatable",
      },
      operation: {
        type: "string",
        description: "The specific operation to perform within the domain",
      },
      params: {
        type: "object",
        description: "All domain-specific parameters as key-value pairs",
      },
    },
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
};
