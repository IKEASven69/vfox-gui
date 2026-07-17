// vfox data access — read the on-disk state of a vfox installation.
//
// vfox stores its state under `$VFOX_HOME` (default `~/.version-fox`):
//   cache/<sdk>/v-<version>/    — every installed SDK version
//   sdks/<sdk>                  — symlink to the *currently active* version,
//                                 e.g. sdks/nodejs -> cache/nodejs/v-24.16.0/...
//   plugin/<sdk>/               — installed plugins (SDK types vfox can manage)
//
// The active version is read from the sdks/ symlink (the source of truth that
// vfox itself uses), NOT from `.tool-versions` (which is a separate, partial
// legacy file). This is more stable than parsing vfox's ANSI-colored CLI
// output, which has no --json flag.

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

/// Where vfox keeps everything. Honors $VFOX_HOME, falls back to the
/// default `%USERPROFILE%\.version-fox` on Windows, `~/.version-fox` elsewhere.
pub fn vfox_home() -> PathBuf {
    if let Ok(custom) = std::env::var("VFOX_HOME") {
        return PathBuf::from(custom);
    }
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_default();
    Path::new(&home).join(".version-fox")
}

/// A single SDK the user can manage (e.g. nodejs, java, python).
#[derive(Debug, Serialize, Clone)]
pub struct Sdk {
    pub name: String,
    pub installed: Vec<Version>,
    pub current: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct Version {
    /// Raw version label as vfox stores it, e.g. "24.16.0" or "25.0.2-graal".
    pub version: String,
    /// Whether this is the currently active version.
    pub is_current: bool,
}

/// Read the whole vfox state: every SDK with a plugin installed, each with its
/// installed versions and the currently selected one (from the sdks/ symlink).
pub fn list_sdks() -> Vec<Sdk> {
    let home = vfox_home();
    let plugin_dir = home.join("plugin");
    let mut sdks: Vec<Sdk> = Vec::new();

    let plugins = match fs::read_dir(&plugin_dir) {
        Ok(entries) => entries.filter_map(|e| e.ok()).collect::<Vec<_>>(),
        Err(_) => return sdks, // vfox not set up yet — empty list is fine
    };

    for entry in plugins {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let name = match path.file_name().and_then(|n| n.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };

        // The active version is the one the sdks/<name> symlink points at.
        // If no version is selected, there is no symlink.
        let current = current_version(&home, &name);
        let installed = installed_versions(&home, &name, current.as_deref());
        sdks.push(Sdk {
            name,
            installed,
            current,
        });
    }

    sdks.sort_by(|a, b| a.name.cmp(&b.name));
    sdks
}

/// Resolve the currently active version for an SDK by following the
/// `sdks/<name>` symlink. The link target looks like
/// `.../cache/<sdk>/v-<version>/<sdk>-<version>`, so we extract the version
/// from the `v-<version>` path segment. Returns None if no version is active.
fn current_version(home: &Path, sdk: &str) -> Option<String> {
    let link = home.join("sdks").join(sdk);
    let target = fs::read_link(&link).ok()?;
    // Walk the target path segments looking for the `v-<version>` component.
    for comp in target.components() {
        if let Some(s) = comp.as_os_str().to_str() {
            if let Some(ver) = s.strip_prefix("v-") {
                return Some(ver.to_string());
            }
        }
    }
    None
}

/// List installed versions for one SDK, read from cache/<sdk>/v-* dirs.
/// `cur` flags the active one (already resolved from the symlink).
fn installed_versions(home: &Path, sdk: &str, cur: Option<&str>) -> Vec<Version> {
    let cache = home.join("cache").join(sdk);
    let mut versions: Vec<Version> = Vec::new();

    let entries = match fs::read_dir(&cache) {
        Ok(e) => e.filter_map(|x| x.ok()).collect::<Vec<_>>(),
        Err(_) => return versions,
    };

    for entry in entries {
        let dirname = match entry.file_name().to_str() {
            Some(s) => s.to_string(),
            None => continue,
        };
        // vfox names version dirs `v-<version>`. Skip anything else (e.g. a
        // stray `current` symlink/dir) so it isn't shown as a fake version.
        let version = match dirname.strip_prefix("v-") {
            Some(v) => v.to_string(),
            None => continue,
        };
        let is_current = cur.map(|c| c == version).unwrap_or(false);
        versions.push(Version { version, is_current });
    }

    versions.sort_by(|a, b| human_version_cmp(&a.version, &b.version));
    versions
}

/// Compare version strings as numeric/alpha chunk sequences so "24.16.0" sorts
/// above "3.13.12". Newest first (descending).
pub fn human_version_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    let av: Vec<&str> = a.split(|c: char| c == '.' || c == '-' || c == '+').collect();
    let bv: Vec<&str> = b.split(|c: char| c == '.' || c == '-' || c == '+').collect();
    for (ca, cb) in av.iter().zip(bv.iter()) {
        let ord = match (ca.parse::<u64>(), cb.parse::<u64>()) {
            (Ok(na), Ok(nb)) => nb.cmp(&na),
            _ => cb.cmp(ca),
        };
        if ord != std::cmp::Ordering::Equal {
            return ord;
        }
    }
    bv.len().cmp(&av.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn current_version_from_symlink_target() {
        // Simulate the path shape vfox produces and verify extraction logic.
        let path = Path::new("/c/Users/x/.version-fox/cache/java/v-25.0.2+10/java-25.0.2+10");
        let mut found = None;
        for comp in path.components() {
            if let Some(s) = comp.as_os_str().to_str() {
                if let Some(ver) = s.strip_prefix("v-") {
                    found = Some(ver.to_string());
                }
            }
        }
        assert_eq!(found, Some("25.0.2+10".to_string()));
    }

    #[test]
    fn version_sort_descending() {
        assert_eq!(human_version_cmp("24.16.0", "3.13.12"), std::cmp::Ordering::Less);
        assert_eq!(human_version_cmp("3.2.0", "3.13.12"), std::cmp::Ordering::Greater);
    }

    #[test]
    fn vfox_home_resolves() {
        let home = vfox_home();
        assert!(home.ends_with(".version-fox") || std::env::var("VFOX_HOME").is_ok());
    }

    #[test]
    fn installed_versions_skips_non_version_dirs() {
        // vfox's cache dir can contain a `current` entry alongside the real
        // `v-*` version dirs. Only `v-*` must show up as installed versions.
        let tmp = std::env::temp_dir().join("vfox_gui_test_skipdirs");
        let _ = fs::remove_dir_all(&tmp);
        let cache = tmp.join("cache").join("python");
        fs::create_dir_all(cache.join("current")).unwrap();
        fs::create_dir_all(cache.join("v-3.13.12")).unwrap();
        fs::create_dir_all(cache.join("v-3.14.2")).unwrap();

        let versions = installed_versions(&tmp, "python", Some("3.13.12"));
        let names: Vec<String> = versions.into_iter().map(|v| v.version).collect();
        assert_eq!(names, vec!["3.14.2", "3.13.12"], "must not include 'current'");
        let _ = fs::remove_dir_all(&tmp);
    }
}
