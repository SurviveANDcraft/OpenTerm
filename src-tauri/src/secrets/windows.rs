//! Windows key storage. Credential Manager first: it's where Windows users and
//! their IT tools expect saved secrets, and it's DPAPI-encrypted to the user's
//! login. Some managed machines turn it off by policy, so a DPAPI-encrypted
//! file in app_data_dir backs it up: same encryption, no policy switch.

use std::fs;
use std::path::PathBuf;

use windows::core::{HSTRING, PWSTR};
use windows::Win32::Foundation::{LocalFree, ERROR_NOT_FOUND, HLOCAL};
use windows::Win32::Security::Credentials::{
    CredDeleteW, CredFree, CredReadW, CredWriteW, CREDENTIALW, CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC,
};
use windows::Win32::Security::Cryptography::{
    CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
};

use super::{Backend, Secret, Storage, Vault};

pub fn backends() -> &'static [&'static dyn Backend] {
    &[&CredentialManager, &DpapiFile]
}

fn not_found(e: &windows::core::Error) -> bool {
    e.code() == ERROR_NOT_FOUND.to_hresult()
}

// ------------------------------------------------------------ Credential Manager

/// A generic credential per key, named `<app identifier>/<key id>`, e.g.
/// `com.openterm.app/openrouter`. LOCAL_MACHINE persistence: kept across
/// logins on this PC, never roamed to other machines with the profile.
struct CredentialManager;

impl CredentialManager {
    fn target(vault: &Vault, secret: Secret) -> HSTRING {
        HSTRING::from(format!("{}/{}", vault.service(), secret.id()))
    }
}

impl Backend for CredentialManager {
    fn storage(&self) -> Storage {
        Storage::CredentialManager
    }

    fn get(&self, vault: &Vault, secret: Secret) -> Result<Option<String>, String> {
        let target = Self::target(vault, secret);
        let mut cred: *mut CREDENTIALW = std::ptr::null_mut();
        match unsafe { CredReadW(&target, CRED_TYPE_GENERIC, None, &mut cred) } {
            Ok(()) => {}
            Err(e) if not_found(&e) => return Ok(None),
            Err(e) => return Err(e.message()),
        }
        let value = unsafe {
            let c = &*cred;
            let bytes = std::slice::from_raw_parts(c.CredentialBlob, c.CredentialBlobSize as usize);
            let value = String::from_utf8(bytes.to_vec());
            CredFree(cred as *const _);
            value
        };
        value.map(Some).map_err(|_| "stored key isn't valid text".into())
    }

    fn set(&self, vault: &Vault, secret: Secret, value: &str) -> Result<(), String> {
        let mut target: Vec<u16> = format!("{}/{}", vault.service(), secret.id()).encode_utf16().chain([0]).collect();
        let mut comment: Vec<u16> = format!("OpenTerm: {}", secret.label()).encode_utf16().chain([0]).collect();
        let mut user: Vec<u16> = "OpenTerm".encode_utf16().chain([0]).collect();
        let mut blob = value.as_bytes().to_vec();
        let cred = CREDENTIALW {
            Type: CRED_TYPE_GENERIC,
            TargetName: PWSTR(target.as_mut_ptr()),
            Comment: PWSTR(comment.as_mut_ptr()),
            CredentialBlobSize: blob.len() as u32,
            CredentialBlob: blob.as_mut_ptr(),
            Persist: CRED_PERSIST_LOCAL_MACHINE,
            UserName: PWSTR(user.as_mut_ptr()),
            ..Default::default()
        };
        unsafe { CredWriteW(&cred, 0) }.map_err(|e| e.message())
    }

    fn delete(&self, vault: &Vault, secret: Secret) -> Result<(), String> {
        match unsafe { CredDeleteW(&Self::target(vault, secret), CRED_TYPE_GENERIC, None) } {
            Ok(()) => Ok(()),
            Err(e) if not_found(&e) => Ok(()),
            Err(e) => Err(e.message()),
        }
    }
}

// ------------------------------------------------------------ DPAPI file

/// `app_data_dir/keys/<key id>.dpapi`: the key encrypted with
/// CryptProtectData, which only this Windows user on this PC can undo. The
/// app identifier is mixed in as entropy, so another app running as the same
/// user can't decrypt the file by just calling CryptUnprotectData on it.
struct DpapiFile;

impl DpapiFile {
    fn path(vault: &Vault, secret: Secret) -> PathBuf {
        vault.dir().join("keys").join(format!("{}.dpapi", secret.id()))
    }

    fn entropy(vault: &Vault) -> Vec<u8> {
        format!("OpenTerm:{}", vault.service()).into_bytes()
    }
}

/// Copies a DPAPI output blob out and frees it.
unsafe fn take_blob(blob: CRYPT_INTEGER_BLOB) -> Vec<u8> {
    let out = unsafe { std::slice::from_raw_parts(blob.pbData, blob.cbData as usize).to_vec() };
    unsafe { LocalFree(Some(HLOCAL(blob.pbData as *mut _))) };
    out
}

impl Backend for DpapiFile {
    fn storage(&self) -> Storage {
        Storage::EncryptedFile
    }

    fn get(&self, vault: &Vault, secret: Secret) -> Result<Option<String>, String> {
        let mut data = match fs::read(Self::path(vault, secret)) {
            Ok(d) => d,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e.to_string()),
        };
        let mut entropy = Self::entropy(vault);
        let input = CRYPT_INTEGER_BLOB { cbData: data.len() as u32, pbData: data.as_mut_ptr() };
        let extra = CRYPT_INTEGER_BLOB { cbData: entropy.len() as u32, pbData: entropy.as_mut_ptr() };
        let mut out = CRYPT_INTEGER_BLOB::default();
        unsafe { CryptUnprotectData(&input, None, Some(&extra), None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut out) }
            .map_err(|e| e.message())?;
        let plain = unsafe { take_blob(out) };
        String::from_utf8(plain).map(Some).map_err(|_| "stored key isn't valid text".into())
    }

    fn set(&self, vault: &Vault, secret: Secret, value: &str) -> Result<(), String> {
        let mut plain = value.as_bytes().to_vec();
        let mut entropy = Self::entropy(vault);
        let input = CRYPT_INTEGER_BLOB { cbData: plain.len() as u32, pbData: plain.as_mut_ptr() };
        let extra = CRYPT_INTEGER_BLOB { cbData: entropy.len() as u32, pbData: entropy.as_mut_ptr() };
        let mut out = CRYPT_INTEGER_BLOB::default();
        unsafe {
            CryptProtectData(
                &input,
                &HSTRING::from(secret.label()),
                Some(&extra),
                None,
                None,
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut out,
            )
        }
        .map_err(|e| e.message())?;
        let sealed = unsafe { take_blob(out) };

        let path = Self::path(vault, secret);
        if let Some(dir) = path.parent() {
            fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let tmp = path.with_extension("dpapi.tmp");
        fs::write(&tmp, sealed).map_err(|e| e.to_string())?;
        fs::rename(&tmp, &path).map_err(|e| {
            let _ = fs::remove_file(&tmp);
            e.to_string()
        })
    }

    fn delete(&self, vault: &Vault, secret: Secret) -> Result<(), String> {
        match fs::remove_file(Self::path(vault, secret)) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A throwaway identity, so the tests never touch the app's real keys.
    fn test_vault(tag: &str) -> Vault {
        let dir = std::env::temp_dir().join(format!("td-vault-{tag}-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        Vault::for_test(format!("com.openterm.test.{tag}.{}", std::process::id()), dir)
    }

    #[test]
    fn each_backend_round_trips_and_deletes() {
        let vault = test_vault("backends");
        for b in backends() {
            assert_eq!(b.get(&vault, Secret::OpenRouter).unwrap(), None, "{:?}", b.storage());
            b.set(&vault, Secret::OpenRouter, "sk-or-v1-abc").unwrap();
            assert_eq!(b.get(&vault, Secret::OpenRouter).unwrap().as_deref(), Some("sk-or-v1-abc"));
            b.delete(&vault, Secret::OpenRouter).unwrap();
            b.delete(&vault, Secret::OpenRouter).unwrap();
            assert_eq!(b.get(&vault, Secret::OpenRouter).unwrap(), None);
        }
        let _ = fs::remove_dir_all(vault.dir());
    }

    #[test]
    fn the_encrypted_file_holds_no_plaintext() {
        let vault = test_vault("dpapi");
        DpapiFile.set(&vault, Secret::Gemini, "AIza-plain-marker").unwrap();
        let raw = fs::read(DpapiFile::path(&vault, Secret::Gemini)).unwrap();
        assert!(!raw.windows(17).any(|w| w == b"AIza-plain-marker"));
        DpapiFile.delete(&vault, Secret::Gemini).unwrap();
        let _ = fs::remove_dir_all(vault.dir());
    }

    #[test]
    fn absorb_moves_a_plaintext_key_into_the_keystore() {
        let _serial = super::super::TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let vault = test_vault("absorb");
        let mut state = serde_json::json!({
            "settings": { "openrouterApiKey": " sk-or-moved ", "geminiApiKey": "", "theme": "dark" }
        });
        assert!(super::super::absorb(&vault, &mut state));
        assert_eq!(state["settings"], serde_json::json!({ "theme": "dark" }));
        assert_eq!(vault.get(Secret::OpenRouter).as_deref(), Some("sk-or-moved"));
        assert_eq!(vault.status(Secret::OpenRouter).map(|i| i.storage), Some(Storage::CredentialManager));
        assert_eq!(vault.status(Secret::Gemini), None);

        // A plaintext key is the newest one the user typed: it replaces the stored one.
        let mut again = serde_json::json!({ "settings": { "openrouterApiKey": "sk-or-newer" } });
        super::super::absorb(&vault, &mut again);
        assert_eq!(vault.get(Secret::OpenRouter).as_deref(), Some("sk-or-newer"));

        vault.clear(Secret::OpenRouter).unwrap();
        assert_eq!(vault.get(Secret::OpenRouter), None);
        let _ = fs::remove_dir_all(vault.dir());
    }

    /// The whole upgrade from a version that kept keys in plain text, the way
    /// `load_state` runs it: keys end up in the keystore, every file on disk
    /// loses them, and backups keep their timestamps.
    #[test]
    fn upgrading_from_plaintext_leaves_no_key_on_disk() {
        let _serial = super::super::TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let vault = test_vault("upgrade");
        let dir = vault.dir().to_path_buf();
        let old = r#"{"sessions":[{"name":"Work"}],"settings":{"openrouterApiKey":"sk-or-upgrade","geminiApiKey":"AIza-upgrade","theme":"dark"}}"#;
        fs::create_dir_all(dir.join("backups")).unwrap();
        fs::create_dir_all(dir.join("dictation")).unwrap();
        fs::write(dir.join("state.json"), old).unwrap();
        for name in ["state-last-1.json", "state-last-2.json", "state-daily-2026-10-01.json", "state-pre-restore.json"] {
            fs::write(dir.join("backups").join(name), old).unwrap();
        }
        let stamp = std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_790_000_000);
        let ring = dir.join("backups").join("state-last-2.json");
        fs::OpenOptions::new().write(true).open(&ring).unwrap().set_modified(stamp).unwrap();
        fs::write(dir.join("dictation").join("config.json"), r#"{"settings":{},"apiKey":"sk-or-upgrade","theme":{}}"#).unwrap();

        let mut state: serde_json::Value = serde_json::from_str(old).unwrap();
        let found = super::super::absorb(&vault, &mut state);
        assert!(found);
        assert!(!super::super::has_unmigrated());
        super::super::rewrite_keeping_mtime(&dir.join("state.json"), &state, false).unwrap();
        assert!(super::super::needs_scrub(&vault, found));
        super::super::scrub_old_copies(&vault);

        assert_eq!(vault.get(Secret::OpenRouter).as_deref(), Some("sk-or-upgrade"));
        assert_eq!(vault.get(Secret::Gemini).as_deref(), Some("AIza-upgrade"));
        let mut files = vec![dir.join("state.json"), dir.join("dictation").join("config.json")];
        files.extend(fs::read_dir(dir.join("backups")).unwrap().map(|e| e.unwrap().path()));
        for f in &files {
            let text = fs::read_to_string(f).unwrap();
            assert!(!text.contains("sk-or-upgrade") && !text.contains("AIza-upgrade"), "{}", f.display());
        }
        assert!(fs::read_to_string(&ring).unwrap().contains("\"Work\""));
        assert_eq!(fs::metadata(&ring).unwrap().modified().unwrap(), stamp);
        assert!(!super::super::needs_scrub(&vault, false));

        for secret in Secret::ALL {
            vault.clear(secret).unwrap();
        }
        let _ = fs::remove_dir_all(&dir);
    }
}
