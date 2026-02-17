use gray_matter::engine::YAML;
use gray_matter::Matter;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::time::UNIX_EPOCH;
use walkdir::WalkDir;

use crate::frontmatter::{with_frontmatter, update_frontmatter_content};

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct VaultEntry {
    pub path: String,
    pub filename: String,
    pub title: String,
    #[serde(rename = "isA")]
    pub is_a: Option<String>,
    pub aliases: Vec<String>,
    #[serde(rename = "belongsTo")]
    pub belongs_to: Vec<String>,
    #[serde(rename = "relatedTo")]
    pub related_to: Vec<String>,
    pub status: Option<String>,
    pub owner: Option<String>,
    pub cadence: Option<String>,
    #[serde(rename = "modifiedAt")]
    pub modified_at: Option<u64>,
    #[serde(rename = "createdAt")]
    pub created_at: Option<u64>,
    #[serde(rename = "fileSize")]
    pub file_size: u64,
    pub snippet: String,
    /// Generic relationship fields: any frontmatter key whose value contains wikilinks.
    /// Key is the original frontmatter field name (e.g. "Has", "Topics", "Events").
    pub relationships: HashMap<String, Vec<String>>,
}

/// Intermediate struct to capture YAML frontmatter fields.
#[derive(Debug, Deserialize, Default)]
struct Frontmatter {
    #[serde(rename = "Is A")]
    is_a: Option<StringOrList>,
    #[serde(default)]
    aliases: Option<StringOrList>,
    #[serde(rename = "Belongs to")]
    belongs_to: Option<StringOrList>,
    #[serde(rename = "Related to")]
    related_to: Option<StringOrList>,
    #[serde(rename = "Status")]
    status: Option<String>,
    #[serde(rename = "Owner")]
    owner: Option<String>,
    #[serde(rename = "Cadence")]
    cadence: Option<String>,
    #[serde(rename = "Created at")]
    created_at: Option<String>,
    #[serde(rename = "Created time")]
    created_time: Option<String>,
}

/// Handles YAML fields that can be either a single string or a list of strings.
#[derive(Debug, Deserialize, Clone)]
#[serde(untagged)]
enum StringOrList {
    Single(String),
    List(Vec<String>),
}

impl StringOrList {
    fn into_vec(self) -> Vec<String> {
        match self {
            StringOrList::Single(s) => vec![s],
            StringOrList::List(v) => v,
        }
    }
}

/// Extract the title from a markdown file's content.
/// Tries the first H1 heading (`# Title`), falls back to filename without extension.
fn extract_title(content: &str, filename: &str) -> String {
    for line in content.lines() {
        let trimmed = line.trim();
        if let Some(heading) = trimmed.strip_prefix("# ") {
            let title = heading.trim();
            if !title.is_empty() {
                return title.to_string();
            }
        }
    }
    // Fallback: filename without .md extension
    filename.strip_suffix(".md").unwrap_or(filename).to_string()
}

/// Extract a snippet: first ~160 chars of content after frontmatter/title, stripped of markdown.
fn extract_snippet(content: &str) -> String {
    // Remove frontmatter
    let without_fm = if content.starts_with("---") {
        if let Some(end) = content[3..].find("---") {
            content[3 + end + 3..].trim_start()
        } else {
            content
        }
    } else {
        content
    };

    // Skip the first H1 heading line
    let without_h1 = if let Some(rest) = without_h1_line(without_fm) {
        rest
    } else {
        without_fm
    };

    // Strip markdown formatting and collapse whitespace
    let clean: String = without_h1
        .lines()
        .filter(|line| {
            let t = line.trim();
            // Skip blank lines, headings, code fences, horizontal rules
            !t.is_empty() && !t.starts_with('#') && !t.starts_with("```") && !t.starts_with("---")
        })
        .collect::<Vec<&str>>()
        .join(" ");

    let stripped = strip_markdown_chars(&clean);
    if stripped.len() > 160 {
        format!("{}...", &stripped[..stripped.floor_char_boundary(160)])
    } else {
        stripped
    }
}

fn without_h1_line(s: &str) -> Option<&str> {
    for (i, line) in s.lines().enumerate() {
        if line.trim().starts_with("# ") {
            // Return everything after this line
            let offset: usize = s.lines().take(i + 1).map(|l| l.len() + 1).sum();
            return Some(&s[offset.min(s.len())..]);
        }
        // If we hit non-empty non-heading content first, there's no H1 to skip
        if !line.trim().is_empty() {
            return None;
        }
    }
    None
}

fn strip_markdown_chars(s: &str) -> String {
    let mut result = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(ch) = chars.next() {
        match ch {
            '[' => {
                // Collect until ']' — keep inner text
                let mut inner = String::new();
                for c in chars.by_ref() {
                    if c == ']' { break; }
                    inner.push(c);
                }
                // Skip (url) if it follows
                if chars.peek() == Some(&'(') {
                    chars.next();
                    for c in chars.by_ref() {
                        if c == ')' { break; }
                    }
                }
                result.push_str(&inner);
            }
            '*' | '_' | '`' | '~' => {} // strip these
            _ => result.push(ch),
        }
    }
    result
}

/// Parse frontmatter from raw YAML data extracted by gray_matter.
fn parse_frontmatter(data: &HashMap<String, serde_json::Value>) -> Frontmatter {
    // Convert HashMap to serde_json::Value for deserialization
    let value = serde_json::Value::Object(
        data.iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect(),
    );
    serde_json::from_value(value).unwrap_or_default()
}

/// Known non-relationship frontmatter keys to skip (case-insensitive comparison).
/// Only skip keys that can never contain wikilinks.
const SKIP_KEYS: &[&str] = &[
    "is a", "aliases", "status", "cadence", "created at", "created time",
];

/// Check if a string contains a wikilink pattern `[[...]]`.
fn contains_wikilink(s: &str) -> bool {
    s.contains("[[") && s.contains("]]")
}

/// Extract all wikilink-containing fields from raw YAML frontmatter.
/// Returns a HashMap where each key is the original frontmatter field name
/// and the value is a Vec of wikilink strings found in that field.
/// Handles both single string values and arrays of strings.
fn extract_relationships(data: &HashMap<String, serde_json::Value>) -> HashMap<String, Vec<String>> {
    let mut relationships = HashMap::new();

    for (key, value) in data {
        // Skip known non-relationship keys
        if SKIP_KEYS.iter().any(|k| k.eq_ignore_ascii_case(key)) {
            continue;
        }

        match value {
            serde_json::Value::String(s) => {
                if contains_wikilink(s) {
                    relationships.insert(key.clone(), vec![s.clone()]);
                }
            }
            serde_json::Value::Array(arr) => {
                let wikilinks: Vec<String> = arr
                    .iter()
                    .filter_map(|v| v.as_str())
                    .filter(|s| contains_wikilink(s))
                    .map(|s| s.to_string())
                    .collect();
                if !wikilinks.is_empty() {
                    relationships.insert(key.clone(), wikilinks);
                }
            }
            _ => {}
        }
    }

    relationships
}

/// Parse a single markdown file into a VaultEntry.
pub fn parse_md_file(path: &Path) -> Result<VaultEntry, String> {
    let content = fs::read_to_string(path).map_err(|e| format!("Failed to read {}: {}", path.display(), e))?;

    let filename = path
        .file_name()
        .map(|f| f.to_string_lossy().to_string())
        .unwrap_or_default();

    let matter = Matter::<YAML>::new();
    let parsed = matter.parse(&content);

    let (frontmatter, relationships): (Frontmatter, HashMap<String, Vec<String>>) = if let Some(data) = parsed.data {
        match data {
            gray_matter::Pod::Hash(map) => {
                // Convert Pod HashMap to serde_json HashMap
                let json_map: HashMap<String, serde_json::Value> = map
                    .into_iter()
                    .map(|(k, v)| (k, pod_to_json(v)))
                    .collect();
                let fm = parse_frontmatter(&json_map);
                let rels = extract_relationships(&json_map);
                (fm, rels)
            }
            _ => (Frontmatter::default(), HashMap::new()),
        }
    } else {
        (Frontmatter::default(), HashMap::new())
    };

    let title = extract_title(&parsed.content, &filename);
    let snippet = extract_snippet(&content);

    let metadata = fs::metadata(path).map_err(|e| format!("Failed to stat {}: {}", path.display(), e))?;
    let modified_at = metadata
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs());
    let file_size = metadata.len();

    // Extract is_a from frontmatter, or infer from parent folder name
    let is_a = frontmatter.is_a
        .map(|a| a.into_vec().into_iter().next())
        .flatten()
        .or_else(|| {
            path.parent()
                .and_then(|p| p.file_name())
                .map(|f| {
                    let folder = f.to_string_lossy().to_string();
                    // Map folder names to entity types
                    match folder.as_str() {
                        "person" => "Person".to_string(),
                        "project" => "Project".to_string(),
                        "procedure" => "Procedure".to_string(),
                        "responsibility" => "Responsibility".to_string(),
                        "event" => "Event".to_string(),
                        "topic" => "Topic".to_string(),
                        "experiment" => "Experiment".to_string(),
                        "note" => "Note".to_string(),
                        "quarter" => "Quarter".to_string(),
                        "measure" => "Measure".to_string(),
                        "target" => "Target".to_string(),
                        "journal" => "Journal".to_string(),
                        "month" => "Month".to_string(),
                        "essay" => "Essay".to_string(),
                        "evergreen" => "Evergreen".to_string(),
                        _ => capitalize_first(&folder),
                    }
                })
        });

    // Parse created_at from frontmatter (prefer "Created at" over "Created time")
    let created_at = frontmatter.created_at
        .as_ref()
        .and_then(|s| parse_iso_date(s))
        .or_else(|| frontmatter.created_time.as_ref().and_then(|s| parse_iso_date(s)));

    Ok(VaultEntry {
        path: path.to_string_lossy().to_string(),
        filename,
        title,
        is_a,
        aliases: frontmatter.aliases.map(|a| a.into_vec()).unwrap_or_default(),
        belongs_to: frontmatter.belongs_to.map(|b| b.into_vec()).unwrap_or_default(),
        related_to: frontmatter.related_to.map(|r| r.into_vec()).unwrap_or_default(),
        status: frontmatter.status,
        owner: frontmatter.owner,
        cadence: frontmatter.cadence,
        modified_at,
        created_at,
        file_size,
        snippet,
        relationships,
    })
}

fn capitalize_first(s: &str) -> String {
    let mut c = s.chars();
    match c.next() {
        None => String::new(),
        Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
    }
}

/// Parse an ISO 8601 date string to Unix timestamp (seconds since epoch).
/// Handles "2025-05-23T14:35:00.000Z" and "2025-05-23" formats.
fn parse_iso_date(date_str: &str) -> Option<u64> {
    use chrono::{NaiveDate, NaiveDateTime};

    let trimmed = date_str.trim().trim_matches('"');

    // Try full datetime with optional fractional seconds and Z suffix
    if let Ok(dt) = NaiveDateTime::parse_from_str(trimmed, "%Y-%m-%dT%H:%M:%S%.fZ") {
        return Some(dt.and_utc().timestamp() as u64);
    }
    if let Ok(dt) = NaiveDateTime::parse_from_str(trimmed, "%Y-%m-%dT%H:%M:%SZ") {
        return Some(dt.and_utc().timestamp() as u64);
    }
    if let Ok(dt) = NaiveDateTime::parse_from_str(trimmed, "%Y-%m-%dT%H:%M:%S") {
        return Some(dt.and_utc().timestamp() as u64);
    }

    // Try date-only
    if let Ok(d) = NaiveDate::parse_from_str(trimmed, "%Y-%m-%d") {
        return Some(d.and_hms_opt(0, 0, 0)?.and_utc().timestamp() as u64);
    }

    None
}

/// Convert gray_matter::Pod to serde_json::Value
fn pod_to_json(pod: gray_matter::Pod) -> serde_json::Value {
    match pod {
        gray_matter::Pod::String(s) => serde_json::Value::String(s),
        gray_matter::Pod::Integer(i) => serde_json::json!(i),
        gray_matter::Pod::Float(f) => serde_json::json!(f),
        gray_matter::Pod::Boolean(b) => serde_json::Value::Bool(b),
        gray_matter::Pod::Array(arr) => {
            serde_json::Value::Array(arr.into_iter().map(pod_to_json).collect())
        }
        gray_matter::Pod::Hash(map) => {
            let obj: serde_json::Map<String, serde_json::Value> = map
                .into_iter()
                .map(|(k, v)| (k, pod_to_json(v)))
                .collect();
            serde_json::Value::Object(obj)
        }
        gray_matter::Pod::Null => serde_json::Value::Null,
    }
}

/// Read the content of a single note file.
pub fn get_note_content(path: &str) -> Result<String, String> {
    let file_path = Path::new(path);
    if !file_path.exists() {
        return Err(format!("File does not exist: {}", path));
    }
    if !file_path.is_file() {
        return Err(format!("Path is not a file: {}", path));
    }
    fs::read_to_string(file_path)
        .map_err(|e| format!("Failed to read {}: {}", path, e))
}

/// Scan a directory recursively for .md files and return VaultEntry for each.
pub fn scan_vault(vault_path: &str) -> Result<Vec<VaultEntry>, String> {
    let path = Path::new(vault_path);
    if !path.exists() {
        return Err(format!("Vault path does not exist: {}", vault_path));
    }
    if !path.is_dir() {
        return Err(format!("Vault path is not a directory: {}", vault_path));
    }

    let mut entries = Vec::new();
    for entry in WalkDir::new(path)
        .follow_links(true)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        let entry_path = entry.path();
        if entry_path.is_file()
            && entry_path
                .extension()
                .map(|ext| ext == "md")
                .unwrap_or(false)
        {
            match parse_md_file(entry_path) {
                Ok(vault_entry) => entries.push(vault_entry),
                Err(e) => {
                    log::warn!("Skipping file: {}", e);
                }
            }
        }
    }

    // Sort by modified date descending (newest first)
    entries.sort_by(|a, b| b.modified_at.cmp(&a.modified_at));

    Ok(entries)
}

// --- Vault Cache ---

#[derive(Debug, Serialize, Deserialize)]
struct VaultCache {
    commit_hash: String,
    entries: Vec<VaultEntry>,
}

fn cache_path(vault_path: &str) -> std::path::PathBuf {
    Path::new(vault_path).join(".laputa-cache.json")
}

fn git_head_hash(vault_path: &str) -> Option<String> {
    let output = std::process::Command::new("git")
        .args(["rev-parse", "HEAD"])
        .current_dir(vault_path)
        .output()
        .ok()?;
    if output.status.success() {
        Some(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        None
    }
}

fn git_changed_files(vault_path: &str, from_hash: &str, to_hash: &str) -> Vec<String> {
    let mut files = Vec::new();

    // Files changed between commits
    if let Ok(output) = std::process::Command::new("git")
        .args(["diff", &format!("{}..{}", from_hash, to_hash), "--name-only"])
        .current_dir(vault_path)
        .output()
    {
        if output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout);
            for line in stdout.lines() {
                if !line.is_empty() && line.ends_with(".md") {
                    files.push(line.to_string());
                }
            }
        }
    }

    // Uncommitted changes (modified + untracked)
    if let Ok(output) = std::process::Command::new("git")
        .args(["status", "--porcelain"])
        .current_dir(vault_path)
        .output()
    {
        if output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout);
            for line in stdout.lines() {
                if line.len() >= 3 {
                    let path = line[3..].trim().to_string();
                    if path.ends_with(".md") && !files.contains(&path) {
                        files.push(path);
                    }
                }
            }
        }
    }

    files
}

fn git_uncommitted_new_files(vault_path: &str) -> Vec<String> {
    let mut files = Vec::new();
    if let Ok(output) = std::process::Command::new("git")
        .args(["status", "--porcelain"])
        .current_dir(vault_path)
        .output()
    {
        if output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout);
            for line in stdout.lines() {
                if line.len() >= 3 {
                    let status = &line[..2];
                    let path = line[3..].trim().to_string();
                    if path.ends_with(".md") && (status == "??" || status.starts_with('A')) {
                        files.push(path);
                    }
                }
            }
        }
    }
    files
}

fn load_cache(vault_path: &str) -> Option<VaultCache> {
    let path = cache_path(vault_path);
    let data = fs::read_to_string(&path).ok()?;
    serde_json::from_str(&data).ok()
}

fn write_cache(vault_path: &str, cache: &VaultCache) {
    let path = cache_path(vault_path);
    if let Ok(data) = serde_json::to_string(cache) {
        let _ = fs::write(path, data);
    }
}

/// Scan vault with incremental caching via git.
/// Falls back to full scan if cache is missing/corrupt or git is unavailable.
pub fn scan_vault_cached(vault_path: &str) -> Result<Vec<VaultEntry>, String> {
    let vault = Path::new(vault_path);
    if !vault.exists() || !vault.is_dir() {
        return Err(format!("Vault path does not exist or is not a directory: {}", vault_path));
    }

    let current_hash = match git_head_hash(vault_path) {
        Some(h) => h,
        None => {
            // No git — full scan, no cache
            return scan_vault(vault_path);
        }
    };

    if let Some(cache) = load_cache(vault_path) {
        if cache.commit_hash == current_hash {
            // Same commit — only check for uncommitted new files
            let new_files = git_uncommitted_new_files(vault_path);
            let mut entries = cache.entries;
            let existing_paths: std::collections::HashSet<String> = entries.iter()
                .map(|e| {
                    // Normalize to relative path for comparison
                    e.path.strip_prefix(&format!("{}/", vault_path))
                        .or_else(|| e.path.strip_prefix(vault_path))
                        .unwrap_or(&e.path)
                        .to_string()
                })
                .collect();

            for rel_path in new_files {
                if !existing_paths.contains(&rel_path) {
                    let abs_path = vault.join(&rel_path);
                    if abs_path.is_file() {
                        if let Ok(entry) = parse_md_file(&abs_path) {
                            entries.push(entry);
                        }
                    }
                }
            }

            entries.sort_by(|a, b| b.modified_at.cmp(&a.modified_at));
            // Update cache with any new entries
            write_cache(vault_path, &VaultCache {
                commit_hash: current_hash,
                entries: entries.clone(),
            });
            return Ok(entries);
        }

        // Different commit — incremental update
        let changed_files = git_changed_files(vault_path, &cache.commit_hash, &current_hash);
        let changed_set: std::collections::HashSet<String> = changed_files.iter().cloned().collect();

        // Keep entries that haven't changed
        let mut entries: Vec<VaultEntry> = cache.entries
            .into_iter()
            .filter(|e| {
                let rel = e.path.strip_prefix(&format!("{}/", vault_path))
                    .or_else(|| e.path.strip_prefix(vault_path))
                    .unwrap_or(&e.path)
                    .to_string();
                !changed_set.contains(&rel)
            })
            .collect();

        // Re-parse changed files (skip deleted ones)
        for rel_path in &changed_files {
            let abs_path = vault.join(rel_path);
            if abs_path.is_file() {
                if let Ok(entry) = parse_md_file(&abs_path) {
                    entries.push(entry);
                }
            }
        }

        entries.sort_by(|a, b| b.modified_at.cmp(&a.modified_at));
        write_cache(vault_path, &VaultCache {
            commit_hash: current_hash,
            entries: entries.clone(),
        });
        return Ok(entries);
    }

    // No cache — full scan and write cache
    let entries = scan_vault(vault_path)?;
    write_cache(vault_path, &VaultCache {
        commit_hash: current_hash,
        entries: entries.clone(),
    });
    Ok(entries)
}

// Re-export for external consumers
pub use crate::frontmatter::FrontmatterValue;

/// Update a single frontmatter property in a markdown file
pub fn update_frontmatter(path: &str, key: &str, value: FrontmatterValue) -> Result<String, String> {
    with_frontmatter(path, |content| update_frontmatter_content(content, key, Some(value.clone())))
}

/// Delete a frontmatter property from a markdown file
pub fn delete_frontmatter_property(path: &str, key: &str) -> Result<String, String> {
    with_frontmatter(path, |content| update_frontmatter_content(content, key, None))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::Write;
    use tempfile::TempDir;

    fn create_test_file(dir: &Path, name: &str, content: &str) {
        let file_path = dir.join(name);
        if let Some(parent) = file_path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        let mut file = fs::File::create(file_path).unwrap();
        file.write_all(content.as_bytes()).unwrap();
    }

    #[test]
    fn test_extract_title_from_h1() {
        let content = "---\nIs A: Note\n---\n# My Great Note\n\nSome content here.";
        assert_eq!(extract_title(content, "my-great-note.md"), "My Great Note");
    }

    #[test]
    fn test_extract_title_fallback_to_filename() {
        let content = "Just some content without a heading.";
        assert_eq!(extract_title(content, "fallback-title.md"), "fallback-title");
    }

    #[test]
    fn test_extract_title_empty_h1_falls_back() {
        let content = "# \n\nSome content.";
        assert_eq!(extract_title(content, "empty-h1.md"), "empty-h1");
    }

    #[test]
    fn test_parse_full_frontmatter() {
        let dir = TempDir::new().unwrap();
        let content = r#"---
Is A: Project
aliases:
  - Laputa
  - Castle in the Sky
Belongs to:
  - Studio Ghibli
Related to:
  - Miyazaki
Status: Active
Owner: Luca
Cadence: Weekly
---
# Laputa Project

This is a project note.
"#;
        create_test_file(dir.path(), "laputa.md", content);

        let entry = parse_md_file(&dir.path().join("laputa.md")).unwrap();
        assert_eq!(entry.title, "Laputa Project");
        assert_eq!(entry.is_a, Some("Project".to_string()));
        assert_eq!(entry.aliases, vec!["Laputa", "Castle in the Sky"]);
        assert_eq!(entry.belongs_to, vec!["Studio Ghibli"]);
        assert_eq!(entry.related_to, vec!["Miyazaki"]);
        assert_eq!(entry.status, Some("Active".to_string()));
        assert_eq!(entry.owner, Some("Luca".to_string()));
        assert_eq!(entry.cadence, Some("Weekly".to_string()));
        assert_eq!(entry.filename, "laputa.md");
    }

    #[test]
    fn test_parse_empty_frontmatter() {
        let dir = TempDir::new().unwrap();
        let content = "---\n---\n# Just a Title\n\nNo frontmatter fields.";
        create_test_file(dir.path(), "empty-fm.md", content);

        let entry = parse_md_file(&dir.path().join("empty-fm.md")).unwrap();
        assert_eq!(entry.title, "Just a Title");
        // is_a is inferred from parent folder name (temp dir), so just check it's not from frontmatter
        assert!(entry.aliases.is_empty());
        assert!(entry.belongs_to.is_empty());
        assert!(entry.related_to.is_empty());
        assert_eq!(entry.status, None);
    }

    #[test]
    fn test_parse_no_frontmatter() {
        let dir = TempDir::new().unwrap();
        let content = "# A Note Without Frontmatter\n\nJust markdown.";
        create_test_file(dir.path(), "no-fm.md", content);

        let entry = parse_md_file(&dir.path().join("no-fm.md")).unwrap();
        assert_eq!(entry.title, "A Note Without Frontmatter");
        // is_a is inferred from parent folder name (temp dir), not None
    }

    #[test]
    fn test_parse_single_string_aliases() {
        let dir = TempDir::new().unwrap();
        let content = "---\naliases: SingleAlias\n---\n# Test\n";
        create_test_file(dir.path(), "single-alias.md", content);

        let entry = parse_md_file(&dir.path().join("single-alias.md")).unwrap();
        assert_eq!(entry.aliases, vec!["SingleAlias"]);
    }

    #[test]
    fn test_scan_vault_recursive() {
        let dir = TempDir::new().unwrap();
        create_test_file(dir.path(), "root.md", "# Root Note\n");
        create_test_file(dir.path(), "sub/nested.md", "---\nIs A: Task\n---\n# Nested\n");
        create_test_file(dir.path(), "not-markdown.txt", "This should be ignored");

        let entries = scan_vault(dir.path().to_str().unwrap()).unwrap();
        assert_eq!(entries.len(), 2);

        let filenames: Vec<&str> = entries.iter().map(|e| e.filename.as_str()).collect();
        assert!(filenames.contains(&"root.md"));
        assert!(filenames.contains(&"nested.md"));
    }

    #[test]
    fn test_scan_vault_nonexistent_path() {
        let result = scan_vault("/nonexistent/path/that/does/not/exist");
        assert!(result.is_err());
    }

    #[test]
    fn test_parse_malformed_yaml() {
        let dir = TempDir::new().unwrap();
        // Malformed YAML — gray_matter should handle this gracefully
        let content = "---\nIs A: [unclosed bracket\n---\n# Malformed\n";
        create_test_file(dir.path(), "malformed.md", content);

        let entry = parse_md_file(&dir.path().join("malformed.md"));
        // Should still succeed — gray_matter may parse partially or skip
        assert!(entry.is_ok());
    }

    #[test]
    fn test_get_note_content() {
        let dir = TempDir::new().unwrap();
        let content = "---\nIs A: Note\n---\n# Test Note\n\nHello, world!";
        create_test_file(dir.path(), "test.md", content);

        let path = dir.path().join("test.md");
        let result = get_note_content(path.to_str().unwrap());
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), content);
    }

    #[test]
    fn test_get_note_content_nonexistent() {
        let result = get_note_content("/nonexistent/path/file.md");
        assert!(result.is_err());
    }

    #[test]
    fn test_extract_snippet_basic() {
        let content = "---\nIs A: Note\n---\n# My Note\n\nThis is the first paragraph of content.\n\n## Section Two\n\nMore content here.";
        let snippet = extract_snippet(content);
        assert!(snippet.starts_with("This is the first paragraph"));
        assert!(snippet.contains("More content here"));
    }

    #[test]
    fn test_extract_snippet_strips_markdown() {
        let content = "# Title\n\nSome **bold** and *italic* and `code` text.";
        let snippet = extract_snippet(content);
        assert_eq!(snippet, "Some bold and italic and code text.");
    }

    #[test]
    fn test_extract_snippet_strips_links() {
        let content = "# Title\n\nSee [this link](https://example.com) and [[wiki link]].";
        let snippet = extract_snippet(content);
        assert!(snippet.contains("this link"));
        assert!(!snippet.contains("https://example.com"));
    }

    #[test]
    fn test_extract_snippet_truncates() {
        let long_content = format!("# Title\n\n{}", "word ".repeat(100));
        let snippet = extract_snippet(&long_content);
        assert!(snippet.len() <= 165); // 160 + "..."
        assert!(snippet.ends_with("..."));
    }

    #[test]
    fn test_extract_snippet_no_content() {
        let content = "---\nIs A: Note\n---\n# Just a Title\n";
        let snippet = extract_snippet(content);
        assert_eq!(snippet, "");
    }

    #[test]
    fn test_parse_md_file_has_snippet() {
        let dir = TempDir::new().unwrap();
        let content = "---\nIs A: Note\n---\n# Test Note\n\nHello, world! This is a snippet.";
        create_test_file(dir.path(), "test.md", content);

        let entry = parse_md_file(&dir.path().join("test.md")).unwrap();
        assert_eq!(entry.snippet, "Hello, world! This is a snippet.");
    }

    #[test]
    fn test_scan_vault_cached_no_git() {
        // Without git, scan_vault_cached falls back to scan_vault
        let dir = TempDir::new().unwrap();
        create_test_file(dir.path(), "note.md", "# Note\n\nContent here.");

        let entries = scan_vault_cached(dir.path().to_str().unwrap()).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].title, "Note");
        assert_eq!(entries[0].snippet, "Content here.");
    }

    #[test]
    fn test_scan_vault_cached_with_git() {
        let dir = TempDir::new().unwrap();
        let vault = dir.path();

        // Init git repo
        std::process::Command::new("git").args(["init"]).current_dir(vault).output().unwrap();
        std::process::Command::new("git").args(["config", "user.email", "test@test.com"]).current_dir(vault).output().unwrap();
        std::process::Command::new("git").args(["config", "user.name", "Test"]).current_dir(vault).output().unwrap();

        create_test_file(vault, "note.md", "# Note\n\nFirst version.");
        std::process::Command::new("git").args(["add", "."]).current_dir(vault).output().unwrap();
        std::process::Command::new("git").args(["commit", "-m", "init"]).current_dir(vault).output().unwrap();

        // First call: full scan, writes cache
        let entries = scan_vault_cached(vault.to_str().unwrap()).unwrap();
        assert_eq!(entries.len(), 1);
        assert!(cache_path(vault.to_str().unwrap()).exists());

        // Second call: uses cache (same HEAD)
        let entries2 = scan_vault_cached(vault.to_str().unwrap()).unwrap();
        assert_eq!(entries2.len(), 1);
        assert_eq!(entries2[0].title, "Note");
    }

    #[test]
    fn test_parse_relationships_array() {
        let dir = TempDir::new().unwrap();
        let content = r#"---
Is A: Responsibility
Has:
  - "[[essay/foo|Foo Essay]]"
  - "[[essay/bar|Bar Essay]]"
Topics:
  - "[[topic/rust]]"
  - "[[topic/wasm]]"
Status: Active
---
# Publish Essays
"#;
        create_test_file(dir.path(), "publish-essays.md", content);

        let entry = parse_md_file(&dir.path().join("publish-essays.md")).unwrap();
        assert_eq!(entry.relationships.len(), 2);
        assert_eq!(
            entry.relationships.get("Has").unwrap(),
            &vec!["[[essay/foo|Foo Essay]]".to_string(), "[[essay/bar|Bar Essay]]".to_string()]
        );
        assert_eq!(
            entry.relationships.get("Topics").unwrap(),
            &vec!["[[topic/rust]]".to_string(), "[[topic/wasm]]".to_string()]
        );
    }

    #[test]
    fn test_parse_relationships_single_string() {
        let dir = TempDir::new().unwrap();
        let content = r#"---
Is A: Project
Owner: "[[person/luca-rossi|Luca Rossi]]"
Belongs to:
  - "[[responsibility/grow-newsletter]]"
---
# Some Project
"#;
        create_test_file(dir.path(), "some-project.md", content);

        let entry = parse_md_file(&dir.path().join("some-project.md")).unwrap();
        // Owner contains a wikilink, so it should appear in relationships
        assert_eq!(
            entry.relationships.get("Owner").unwrap(),
            &vec!["[[person/luca-rossi|Luca Rossi]]".to_string()]
        );
        // Belongs to is also a wikilink array, should appear in relationships
        assert_eq!(
            entry.relationships.get("Belongs to").unwrap(),
            &vec!["[[responsibility/grow-newsletter]]".to_string()]
        );
        // Still parsed in the dedicated field too
        assert_eq!(entry.belongs_to, vec!["[[responsibility/grow-newsletter]]"]);
    }

    #[test]
    fn test_parse_relationships_ignores_non_wikilinks() {
        let dir = TempDir::new().unwrap();
        let content = r#"---
Is A: Note
Status: Active
Tags:
  - productivity
  - writing
Custom Field: just a plain string
---
# A Note
"#;
        create_test_file(dir.path(), "plain-note.md", content);

        let entry = parse_md_file(&dir.path().join("plain-note.md")).unwrap();
        // Tags and Custom Field don't contain wikilinks, so relationships should be empty
        assert!(entry.relationships.is_empty());
    }

    // Frontmatter update/delete tests are in frontmatter.rs
}
