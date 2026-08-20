use gpui::{App, Global};
use std::fmt;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InstallError {
    AlreadyRegistered,
    #[cfg(not(target_os = "macos"))]
    Unsupported,
    #[cfg(target_os = "macos")]
    WrongThread,
    #[cfg(target_os = "macos")]
    Native {
        operation: &'static str,
        status: i32,
    },
}

impl fmt::Display for InstallError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::AlreadyRegistered => write!(f, "Command-Shift-Space is already registered"),
            #[cfg(not(target_os = "macos"))]
            Self::Unsupported => write!(f, "global hotkeys are only supported on macOS"),
            #[cfg(target_os = "macos")]
            Self::WrongThread => write!(f, "global hotkeys must be registered on the main thread"),
            #[cfg(target_os = "macos")]
            Self::Native { operation, status } => {
                write!(f, "{operation} failed with OSStatus {status}")
            }
        }
    }
}

impl std::error::Error for InstallError {}

#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct HotKeyId {
    signature: u32,
    id: u32,
}

const EMMA_HOT_KEY_ID: HotKeyId = HotKeyId {
    signature: u32::from_be_bytes(*b"Emma"),
    id: 1,
};

fn maps_to_activation(id: HotKeyId) -> bool {
    id == EMMA_HOT_KEY_ID
}

struct CommandShiftSpace {
    #[cfg(target_os = "macos")]
    _registration: macos::Registration,
}

impl Global for CommandShiftSpace {}

pub fn install_command_shift_space(cx: &mut App) -> Result<(), InstallError> {
    if cx.has_global::<CommandShiftSpace>() {
        return Err(InstallError::AlreadyRegistered);
    }

    #[cfg(target_os = "macos")]
    {
        let registration = macos::Registration::install(cx)?;
        cx.set_global(CommandShiftSpace {
            _registration: registration,
        });
        cx.on_app_quit(|cx| {
            cx.remove_global::<CommandShiftSpace>();
            std::future::ready(())
        })
        .detach();
        Ok(())
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = cx;
        Err(InstallError::Unsupported)
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use super::{EMMA_HOT_KEY_ID, HotKeyId, InstallError, maps_to_activation};
    use emma_ui::ToggleAgentSurface;
    use gpui::{App, AsyncApp};
    use std::{
        ffi::c_void,
        mem::{MaybeUninit, size_of},
        panic::{AssertUnwindSafe, catch_unwind},
        ptr,
    };

    type OSStatus = i32;
    type EventRef = *mut c_void;
    type EventTargetRef = *mut c_void;
    type EventHandlerCallRef = *mut c_void;
    type EventHandlerRef = *mut c_void;
    type EventHotKeyRef = *mut c_void;

    const NO_ERR: OSStatus = 0;
    const EVENT_NOT_HANDLED_ERR: OSStatus = -9874;
    const EVENT_HOT_KEY_EXISTS_ERR: OSStatus = -9878;
    const COMMAND_SHIFT: u32 = (1 << 8) | (1 << 9);
    const KEY_CODE_SPACE: u32 = 0x31;
    const EVENT_CLASS_KEYBOARD: u32 = u32::from_be_bytes(*b"keyb");
    const EVENT_HOT_KEY_PRESSED: u32 = 5;
    const EVENT_PARAM_DIRECT_OBJECT: u32 = u32::from_be_bytes(*b"----");
    const TYPE_EVENT_HOT_KEY_ID: u32 = u32::from_be_bytes(*b"hkid");

    #[repr(C)]
    struct EventTypeSpec {
        event_class: u32,
        event_kind: u32,
    }

    struct Callback {
        cx: AsyncApp,
    }

    impl Callback {
        fn schedule(&self) {
            self.cx
                .spawn(async move |cx| {
                    cx.update(|cx| cx.dispatch_action(&ToggleAgentSurface));
                })
                .detach();
        }
    }

    pub struct Registration {
        hot_key: EventHotKeyRef,
        handler: EventHandlerRef,
        callback: Option<Box<Callback>>,
    }

    impl Registration {
        pub fn install(cx: &App) -> Result<Self, InstallError> {
            if !cx.background_executor().is_main_thread() {
                return Err(InstallError::WrongThread);
            }

            // RegisterEventHotKey observes only this chord and requires neither
            // Accessibility nor Input Monitoring permission.
            let target = unsafe { GetApplicationEventTarget() };
            let mut hot_key = ptr::null_mut();
            native_result("RegisterEventHotKey", unsafe {
                RegisterEventHotKey(
                    KEY_CODE_SPACE,
                    COMMAND_SHIFT,
                    EMMA_HOT_KEY_ID,
                    target,
                    0,
                    &mut hot_key,
                )
            })?;

            let mut callback = Box::new(Callback { cx: cx.to_async() });
            let event = EventTypeSpec {
                event_class: EVENT_CLASS_KEYBOARD,
                event_kind: EVENT_HOT_KEY_PRESSED,
            };
            let mut handler = ptr::null_mut();
            let status = unsafe {
                InstallEventHandler(
                    target,
                    event_handler,
                    1,
                    &event,
                    callback.as_mut() as *mut Callback as *mut c_void,
                    &mut handler,
                )
            };
            if let Err(error) = native_result("InstallEventHandler", status) {
                let cleanup_status = unsafe { UnregisterEventHotKey(hot_key) };
                if cleanup_status != NO_ERR {
                    eprintln!(
                        "Emma: UnregisterEventHotKey rollback failed with OSStatus {cleanup_status}"
                    );
                }
                return Err(error);
            }

            Ok(Self {
                hot_key,
                handler,
                callback: Some(callback),
            })
        }
    }

    impl Drop for Registration {
        fn drop(&mut self) {
            let hot_key_status = unsafe { UnregisterEventHotKey(self.hot_key) };
            if hot_key_status != NO_ERR {
                eprintln!(
                    "Emma: UnregisterEventHotKey failed during teardown with OSStatus {hot_key_status}"
                );
            }

            let handler_status = unsafe { RemoveEventHandler(self.handler) };
            if handler_status != NO_ERR {
                eprintln!(
                    "Emma: RemoveEventHandler failed during teardown with OSStatus {handler_status}"
                );
                if let Some(callback) = self.callback.take() {
                    Box::leak(callback);
                }
            }
        }
    }

    fn native_result(operation: &'static str, status: OSStatus) -> Result<(), InstallError> {
        match status {
            NO_ERR => Ok(()),
            EVENT_HOT_KEY_EXISTS_ERR => Err(InstallError::AlreadyRegistered),
            status => Err(InstallError::Native { operation, status }),
        }
    }

    extern "C" fn event_handler(
        _handler: EventHandlerCallRef,
        event: EventRef,
        user_data: *mut c_void,
    ) -> OSStatus {
        let handled = catch_unwind(AssertUnwindSafe(|| {
            let Some(callback) = (unsafe { (user_data as *mut Callback).as_ref() }) else {
                return false;
            };
            let mut id = MaybeUninit::<HotKeyId>::uninit();
            let status = unsafe {
                GetEventParameter(
                    event,
                    EVENT_PARAM_DIRECT_OBJECT,
                    TYPE_EVENT_HOT_KEY_ID,
                    ptr::null_mut(),
                    size_of::<HotKeyId>(),
                    ptr::null_mut(),
                    id.as_mut_ptr().cast(),
                )
            };
            if status != NO_ERR {
                return false;
            }

            let id = unsafe { id.assume_init() };
            if !maps_to_activation(id) {
                return false;
            }

            callback.schedule();
            true
        }))
        .unwrap_or(false);

        if handled {
            NO_ERR
        } else {
            EVENT_NOT_HANDLED_ERR
        }
    }

    #[link(name = "Carbon", kind = "framework")]
    unsafe extern "C" {
        fn GetApplicationEventTarget() -> EventTargetRef;
        fn RegisterEventHotKey(
            key_code: u32,
            modifiers: u32,
            id: HotKeyId,
            target: EventTargetRef,
            options: u32,
            out_ref: *mut EventHotKeyRef,
        ) -> OSStatus;
        fn UnregisterEventHotKey(hot_key: EventHotKeyRef) -> OSStatus;
        fn InstallEventHandler(
            target: EventTargetRef,
            handler: extern "C" fn(EventHandlerCallRef, EventRef, *mut c_void) -> OSStatus,
            event_count: usize,
            events: *const EventTypeSpec,
            user_data: *mut c_void,
            out_ref: *mut EventHandlerRef,
        ) -> OSStatus;
        fn RemoveEventHandler(handler: EventHandlerRef) -> OSStatus;
        fn GetEventParameter(
            event: EventRef,
            name: u32,
            desired_type: u32,
            out_actual_type: *mut u32,
            buffer_size: usize,
            out_actual_size: *mut usize,
            out_data: *mut c_void,
        ) -> OSStatus;
    }
}

#[test]
fn only_emmas_hotkey_id_maps_to_activation() {
    assert!(maps_to_activation(EMMA_HOT_KEY_ID));
    assert!(!maps_to_activation(HotKeyId {
        id: EMMA_HOT_KEY_ID.id + 1,
        ..EMMA_HOT_KEY_ID
    }));
    assert!(!maps_to_activation(HotKeyId {
        signature: u32::from_be_bytes(*b"Else"),
        ..EMMA_HOT_KEY_ID
    }));
}
