use thiserror::Error;

#[derive(Debug, Error)]
pub enum KeyStoreError {
    #[error("key not found")]
    NotFound,
    #[error("access denied")]
    Denied,
    #[error("keystore error: {0}")]
    Other(String),
}

pub const SERVICE_NAME: &str = "guvercin";
pub const ENTRY_NAME: &str = "master-key";

pub async fn load_master_key(prompt: &str) -> Result<Vec<u8>, KeyStoreError> {
    platform::load_master_key(prompt).await
}

pub async fn store_master_key(prompt: &str, key: &[u8]) -> Result<(), KeyStoreError> {
    platform::store_master_key(prompt, key).await
}

#[cfg(target_os = "macos")]
mod platform {
    use super::{ENTRY_NAME, KeyStoreError, SERVICE_NAME};
    use core_foundation::base::{TCFType, CFType};
    use core_foundation::boolean::CFBoolean;
    use core_foundation::data::CFData;
    use core_foundation::dictionary::CFDictionary;
    use core_foundation::string::CFString;
    use core_foundation_sys::base::CFTypeRef;
    use security_framework_sys::base::{
        errSecDuplicateItem, errSecItemNotFound, errSecSuccess, errSecUserCanceled,
    };
    use security_framework_sys::keychain::{
        kSecAttrAccessControl, kSecAttrAccount, kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
        kSecAttrService, kSecClass, kSecClassGenericPassword, kSecMatchLimit, kSecMatchLimitOne,
        kSecReturnData, kSecUseOperationPrompt, kSecValueData, SecAccessControlCreateWithFlags,
        SecItemAdd, SecItemCopyMatching, SecItemUpdate, SecAccessControlRef,
        kSecAccessControlUserPresence,
    };

    fn cf_string_const(ptr: CFTypeRef) -> CFType {
        unsafe { CFType::wrap_under_get_rule(ptr) }
    }

    fn make_access_control() -> Result<SecAccessControlRef, KeyStoreError> {
        let mut error: CFTypeRef = std::ptr::null_mut();
        let access = unsafe {
            SecAccessControlCreateWithFlags(
                std::ptr::null(),
                kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
                kSecAccessControlUserPresence,
                &mut error as *mut _,
            )
        };
        if access.is_null() {
            return Err(KeyStoreError::Other(
                "failed to create keychain access control".to_string(),
            ));
        }
        Ok(access)
    }

    pub async fn load_master_key(prompt: &str) -> Result<Vec<u8>, KeyStoreError> {
        let service = CFString::new(SERVICE_NAME);
        let account = CFString::new(ENTRY_NAME);
        let prompt_cf = CFString::new(prompt);
        let return_true = CFBoolean::true_value();
        let key_class = cf_string_const(kSecClass);
        let class_generic = cf_string_const(kSecClassGenericPassword);
        let key_service = cf_string_const(kSecAttrService);
        let key_account = cf_string_const(kSecAttrAccount);
        let key_return = cf_string_const(kSecReturnData);
        let key_match = cf_string_const(kSecMatchLimit);
        let match_one = cf_string_const(kSecMatchLimitOne);
        let key_prompt = cf_string_const(kSecUseOperationPrompt);

        let query = CFDictionary::from_CFType_pairs(&[
            (&key_class, &class_generic),
            (&key_service, &service),
            (&key_account, &account),
            (&key_return, &return_true),
            (&key_match, &match_one),
            (&key_prompt, &prompt_cf),
        ]);

        let mut result: CFTypeRef = std::ptr::null_mut();
        let status = unsafe { SecItemCopyMatching(query.as_concrete_TypeRef(), &mut result) };
        if status == errSecItemNotFound {
            return Err(KeyStoreError::NotFound);
        }
        if status == errSecUserCanceled {
            return Err(KeyStoreError::Denied);
        }
        if status != errSecSuccess {
            return Err(KeyStoreError::Other(format!(
                "keychain access failed (status: {status})"
            )));
        }
        if result.is_null() {
            return Err(KeyStoreError::Other(
                "keychain access returned empty result".to_string(),
            ));
        }

        let data = unsafe { CFData::wrap_under_create_rule(result as _) };
        Ok(data.bytes().to_vec())
    }

    pub async fn store_master_key(_prompt: &str, key: &[u8]) -> Result<(), KeyStoreError> {
        let service = CFString::new(SERVICE_NAME);
        let account = CFString::new(ENTRY_NAME);
        let data = CFData::from_buffer(key);
        let access = make_access_control()?;

        let access_cf = unsafe { CFType::wrap_under_create_rule(access as _) };
        let key_class = cf_string_const(kSecClass);
        let class_generic = cf_string_const(kSecClassGenericPassword);
        let key_service = cf_string_const(kSecAttrService);
        let key_account = cf_string_const(kSecAttrAccount);
        let key_value = cf_string_const(kSecValueData);
        let key_access = cf_string_const(kSecAttrAccessControl);

        let add = CFDictionary::from_CFType_pairs(&[
            (&key_class, &class_generic),
            (&key_service, &service),
            (&key_account, &account),
            (&key_value, &data),
            (&key_access, &access_cf),
        ]);

        let status = unsafe { SecItemAdd(add.as_concrete_TypeRef(), std::ptr::null_mut()) };
        if status == errSecDuplicateItem {
            let query = CFDictionary::from_CFType_pairs(&[
                (&key_class, &class_generic),
                (&key_service, &service),
                (&key_account, &account),
            ]);
            let update = CFDictionary::from_CFType_pairs(&[
                (&key_value, &data),
                (&key_access, &access_cf),
            ]);
            let update_status =
                unsafe { SecItemUpdate(query.as_concrete_TypeRef(), update.as_concrete_TypeRef()) };
            if update_status != errSecSuccess {
                return Err(KeyStoreError::Other(format!(
                    "keychain update failed (status: {update_status})"
                )));
            }
            return Ok(());
        }
        if status != errSecSuccess {
            return Err(KeyStoreError::Other(format!(
                "keychain write failed (status: {status})"
            )));
        }
        Ok(())
    }
}

#[cfg(target_os = "windows")]
mod platform {
    use super::{ENTRY_NAME, KeyStoreError, SERVICE_NAME};
    use std::ffi::OsStr;
    use std::iter::once;
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{GetLastError, ERROR_NOT_FOUND, HLOCAL};
    use windows::Win32::Security::Credentials::{
        CredFree, CredReadW, CredWriteW, CREDENTIALW, CRED_PERSIST_LOCAL_MACHINE,
        CRED_TYPE_GENERIC,
    };
    use windows::Win32::Security::Cryptography::{
        CryptProtectData, CryptUnprotectData, CRYPTPROTECT_PROMPTSTRUCT,
        CRYPTPROTECT_PROMPT_ON_PROTECT, CRYPTPROTECT_PROMPT_ON_UNPROTECT, DATA_BLOB,
    };
    use windows::Win32::System::Memory::LocalFree;

    fn to_wide(value: &str) -> Vec<u16> {
        OsStr::new(value).encode_wide().chain(once(0)).collect()
    }

    fn protect(data: &[u8], prompt: &str) -> Result<Vec<u8>, KeyStoreError> {
        let mut input = DATA_BLOB {
            cbData: data.len() as u32,
            pbData: data.as_ptr() as *mut u8,
        };
        let mut output = DATA_BLOB::default();

        let prompt_wide = to_wide(prompt);
        let mut prompt_struct = CRYPTPROTECT_PROMPTSTRUCT {
            cbSize: std::mem::size_of::<CRYPTPROTECT_PROMPTSTRUCT>() as u32,
            dwPromptFlags: CRYPTPROTECT_PROMPT_ON_PROTECT,
            hwndApp: Default::default(),
            szPrompt: PCWSTR(prompt_wide.as_ptr()),
        };

        let ok = unsafe {
            CryptProtectData(
                &mut input,
                PCWSTR::null(),
                None,
                None,
                Some(&mut prompt_struct),
                0,
                &mut output,
            )
        }
        .as_bool();

        if !ok {
            return Err(KeyStoreError::Denied);
        }

        let data = unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize) }
            .to_vec();
        unsafe { LocalFree(HLOCAL(output.pbData as isize)) };
        Ok(data)
    }

    fn unprotect(data: &[u8], prompt: &str) -> Result<Vec<u8>, KeyStoreError> {
        let mut input = DATA_BLOB {
            cbData: data.len() as u32,
            pbData: data.as_ptr() as *mut u8,
        };
        let mut output = DATA_BLOB::default();

        let prompt_wide = to_wide(prompt);
        let mut prompt_struct = CRYPTPROTECT_PROMPTSTRUCT {
            cbSize: std::mem::size_of::<CRYPTPROTECT_PROMPTSTRUCT>() as u32,
            dwPromptFlags: CRYPTPROTECT_PROMPT_ON_UNPROTECT,
            hwndApp: Default::default(),
            szPrompt: PCWSTR(prompt_wide.as_ptr()),
        };

        let ok = unsafe {
            CryptUnprotectData(
                &mut input,
                std::ptr::null_mut(),
                None,
                None,
                Some(&mut prompt_struct),
                0,
                &mut output,
            )
        }
        .as_bool();

        if !ok {
            return Err(KeyStoreError::Denied);
        }

        let data = unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize) }
            .to_vec();
        unsafe { LocalFree(HLOCAL(output.pbData as isize)) };
        Ok(data)
    }

    pub async fn load_master_key(prompt: &str) -> Result<Vec<u8>, KeyStoreError> {
        let target = format!("{}:{}", SERVICE_NAME, ENTRY_NAME);
        let target_wide = to_wide(&target);
        let mut cred_ptr = std::ptr::null_mut();
        let ok = unsafe {
            CredReadW(
                PCWSTR(target_wide.as_ptr()),
                CRED_TYPE_GENERIC,
                0,
                &mut cred_ptr,
            )
        }
        .as_bool();
        if !ok {
            let err = unsafe { GetLastError() };
            if err == ERROR_NOT_FOUND {
                return Err(KeyStoreError::NotFound);
            }
            return Err(KeyStoreError::Other(format!(
                "CredReadW failed (error: {})",
                err.0
            )));
        }

        let cred = unsafe { &*cred_ptr };
        let blob = unsafe {
            std::slice::from_raw_parts(cred.CredentialBlob, cred.CredentialBlobSize as usize)
        };
        let decrypted = unprotect(blob, prompt)?;
        unsafe { CredFree(cred_ptr as _) };
        Ok(decrypted)
    }

    pub async fn store_master_key(prompt: &str, key: &[u8]) -> Result<(), KeyStoreError> {
        let target = format!("{}:{}", SERVICE_NAME, ENTRY_NAME);
        let target_wide = to_wide(&target);
        let encrypted = protect(key, prompt)?;

        let mut cred = CREDENTIALW {
            Flags: 0,
            Type: CRED_TYPE_GENERIC,
            TargetName: windows::core::PWSTR(target_wide.as_ptr() as _),
            Comment: windows::core::PWSTR::null(),
            LastWritten: Default::default(),
            CredentialBlobSize: encrypted.len() as u32,
            CredentialBlob: encrypted.as_ptr() as *mut u8,
            Persist: CRED_PERSIST_LOCAL_MACHINE,
            AttributeCount: 0,
            Attributes: std::ptr::null_mut(),
            TargetAlias: windows::core::PWSTR::null(),
            UserName: windows::core::PWSTR::null(),
        };

        let ok = unsafe { CredWriteW(&mut cred, 0) }.as_bool();
        if !ok {
            let err = unsafe { GetLastError() };
            return Err(KeyStoreError::Other(format!(
                "CredWriteW failed (error: {})",
                err.0
            )));
        }
        Ok(())
    }
}

#[cfg(target_os = "linux")]
mod platform {
    use super::{ENTRY_NAME, KeyStoreError, SERVICE_NAME};
    use secret_service::{EncryptionType, SecretService};

    pub async fn load_master_key(_prompt: &str) -> Result<Vec<u8>, KeyStoreError> {
        let ss = SecretService::connect(EncryptionType::Dh)
            .await
            .map_err(|e| KeyStoreError::Other(e.to_string()))?;
        let collection = ss
            .get_default_collection()
            .await
            .map_err(|e| KeyStoreError::Other(e.to_string()))?;
        collection
            .unlock()
            .await
            .map_err(|_| KeyStoreError::Denied)?;

        let mut attrs = std::collections::HashMap::new();
        attrs.insert("service", SERVICE_NAME);
        attrs.insert("account", ENTRY_NAME);
        let items = collection
            .search_items(attrs)
            .await
            .map_err(|e| KeyStoreError::Other(e.to_string()))?;
        if items.is_empty() {
            collection.lock().await.ok();
            return Err(KeyStoreError::NotFound);
        }

        let secret = items[0]
            .get_secret()
            .await
            .map_err(|e| KeyStoreError::Other(e.to_string()))?;
        collection.lock().await.ok();
        Ok(secret)
    }

    pub async fn store_master_key(_prompt: &str, key: &[u8]) -> Result<(), KeyStoreError> {
        let ss = SecretService::connect(EncryptionType::Dh)
            .await
            .map_err(|e| KeyStoreError::Other(e.to_string()))?;
        let collection = ss
            .get_default_collection()
            .await
            .map_err(|e| KeyStoreError::Other(e.to_string()))?;
        collection
            .unlock()
            .await
            .map_err(|_| KeyStoreError::Denied)?;

        let mut attrs = std::collections::HashMap::new();
        attrs.insert("service", SERVICE_NAME);
        attrs.insert("account", ENTRY_NAME);

        let label = "Guvercin Master Key";
        collection
            .create_item(label, attrs, key, true, "application/octet-stream")
            .await
            .map_err(|e| KeyStoreError::Other(e.to_string()))?;
        collection.lock().await.ok();
        Ok(())
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
mod platform {
    use super::KeyStoreError;

    pub async fn load_master_key(_prompt: &str) -> Result<Vec<u8>, KeyStoreError> {
        Err(KeyStoreError::Other(
            "unsupported platform for keyring prompt".to_string(),
        ))
    }

    pub async fn store_master_key(_prompt: &str, _key: &[u8]) -> Result<(), KeyStoreError> {
        Err(KeyStoreError::Other(
            "unsupported platform for keyring prompt".to_string(),
        ))
    }
}
