#define WIN32_LEAN_AND_MEAN
#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0601
#endif
#include <windows.h>

#include <array>
#include <atomic>
#include <chrono>
#include <cstdint>
#include <iostream>
#include <mutex>
#include <regex>
#include <string>
#include <thread>
#include <vector>

struct TapState {
    bool down = false;
    bool previousRelease = false;
    bool ignoreRelease = false;
    std::uint64_t previousReleaseAt = 0;
};

void reset_tap(TapState& state) {
    state = {};
}

bool handle_tap(TapState& state, bool down, std::uint64_t now) {
    if (down) {
        if (state.down) return false;
        state.down = true;
        if (state.previousRelease && now >= state.previousReleaseAt && now - state.previousReleaseAt <= 350) {
            state.previousRelease = false;
            state.ignoreRelease = true;
            return true;
        }
        return false;
    }
    if (!state.down) return false;
    state.down = false;
    if (state.ignoreRelease) {
        state.ignoreRelease = false;
        state.previousRelease = false;
    } else {
        state.previousRelease = true;
        state.previousReleaseAt = now;
    }
    return false;
}

bool handle_bare_tap(TapState& state, bool down, std::uint64_t now, bool bare) {
    if (!bare) {
        reset_tap(state);
        return false;
    }
    return handle_tap(state, down, now);
}

struct HoldBinding {
    UINT keyCode = 0;
    DWORD milliseconds = 0;
    std::string id;
};

std::vector<HoldBinding> parse_holds(const std::string& line) {
    static const std::regex item(R"emma(\{"id":"([^"]{1,31})","keyCode":([0-9]{1,3}),"ms":([0-9]{1,4})\})emma");
    std::vector<HoldBinding> result;
    for (std::sregex_iterator current(line.begin(), line.end(), item), end; current != end && result.size() < 8; ++current) {
        const auto& match = *current;
        const auto keyCode = static_cast<UINT>(std::stoul(match[2].str()));
        const auto milliseconds = static_cast<DWORD>(std::stoul(match[3].str()));
        if ((keyCode == VK_LMENU || keyCode == VK_RMENU || keyCode == VK_LCONTROL || keyCode == VK_RCONTROL ||
             keyCode == VK_LWIN || keyCode == VK_RWIN || keyCode == VK_LSHIFT || keyCode == VK_RSHIFT) &&
            milliseconds >= 100 && milliseconds <= 5000) {
            result.push_back({keyCode, milliseconds, match[1].str()});
        }
    }
    return result;
}

using KeyState = std::array<bool, 256>;

bool physical_key(UINT keyCode) {
    return keyCode >= VK_BACK && keyCode != VK_SHIFT && keyCode != VK_CONTROL && keyCode != VK_MENU;
}

bool no_other_key_down(const KeyState& state, UINT keyCode) {
    for (UINT current = VK_BACK; current < state.size(); ++current) {
        if (current != keyCode && physical_key(current) && state[current]) return false;
    }
    return true;
}

KeyState read_key_state() {
    KeyState state{};
    for (UINT keyCode = VK_BACK; keyCode < state.size(); ++keyCode) {
        if (physical_key(keyCode)) state[keyCode] = (GetAsyncKeyState(static_cast<int>(keyCode)) & 0x8000) != 0;
    }
    return state;
}

bool bare_key(UINT keyCode) {
    return no_other_key_down(read_key_state(), keyCode);
}

std::mutex holds_mutex;
std::vector<HoldBinding> holds;
std::mutex output_mutex;
std::atomic<std::uint64_t> generation = 0;
std::atomic<bool> running = true;
DWORD message_thread = 0;
TapState tap_state;

void output_line(const std::string& line) {
    std::lock_guard<std::mutex> lock(output_mutex);
    std::cout << line << std::endl;
}

void wait_for_hold(HoldBinding binding, std::uint64_t armed) {
    std::this_thread::sleep_for(std::chrono::milliseconds(binding.milliseconds));
    if (!running || generation.load() != armed || (GetAsyncKeyState(static_cast<int>(binding.keyCode)) & 0x8000) == 0 || !bare_key(binding.keyCode)) return;
    generation.fetch_add(1);
    output_line("hold " + binding.id);
}

bool modifier_key(UINT keyCode) {
    return keyCode == VK_LMENU || keyCode == VK_RMENU || keyCode == VK_LCONTROL || keyCode == VK_RCONTROL ||
        keyCode == VK_LWIN || keyCode == VK_RWIN || keyCode == VK_LSHIFT || keyCode == VK_RSHIFT;
}

LRESULT CALLBACK keyboard_hook(int code, WPARAM message, LPARAM data) {
    if (code < 0 || !running) return CallNextHookEx(nullptr, code, message, data);
    const auto* event = reinterpret_cast<const KBDLLHOOKSTRUCT*>(data);
    if ((event->flags & LLKHF_INJECTED) != 0) return CallNextHookEx(nullptr, code, message, data);
    const bool down = message == WM_KEYDOWN || message == WM_SYSKEYDOWN;
    const bool up = message == WM_KEYUP || message == WM_SYSKEYUP;
    if (!down && !up) return CallNextHookEx(nullptr, code, message, data);
    const auto keyCode = event->vkCode;
    const bool bare = bare_key(keyCode);
    if (keyCode == VK_LMENU) {
        if (!bare) reset_tap(tap_state);
        else if (handle_tap(tap_state, down, GetTickCount64())) output_line("toggle");
    } else {
        reset_tap(tap_state);
    }
    if (!modifier_key(keyCode)) {
        generation.fetch_add(1);
        return CallNextHookEx(nullptr, code, message, data);
    }
    if (up) {
        generation.fetch_add(1);
        return CallNextHookEx(nullptr, code, message, data);
    }
    if (!bare) {
        generation.fetch_add(1);
        return CallNextHookEx(nullptr, code, message, data);
    }
    HoldBinding binding;
    bool found = false;
    {
        std::lock_guard<std::mutex> lock(holds_mutex);
        for (const auto& item : holds) {
            if (item.keyCode == keyCode) {
                binding = item;
                found = true;
                break;
            }
        }
    }
    if (found) {
        const auto armed = generation.fetch_add(1) + 1;
        std::thread(wait_for_hold, binding, armed).detach();
    }
    return CallNextHookEx(nullptr, code, message, data);
}

void read_updates() {
    std::string line;
    while (running && std::getline(std::cin, line)) {
        auto next = parse_holds(line);
        {
            std::lock_guard<std::mutex> lock(holds_mutex);
            holds = std::move(next);
        }
        generation.fetch_add(1);
    }
    running = false;
    if (message_thread != 0) PostThreadMessageW(message_thread, WM_QUIT, 0, 0);
}

int self_test() {
    TapState state;
    if (handle_tap(state, false, 0) || handle_tap(state, true, 0) || handle_tap(state, true, 1) ||
        handle_tap(state, false, 10) || !handle_tap(state, true, 200) || handle_tap(state, false, 210) ||
        handle_tap(state, true, 300)) return 1;
    reset_tap(state);
    if (handle_tap(state, true, 0) || handle_tap(state, false, 10)) return 1;
    reset_tap(state);
    if (handle_tap(state, true, 200)) return 1;
    reset_tap(state);
    if (handle_tap(state, true, 0)) return 1;
    reset_tap(state);
    if (handle_tap(state, false, 10) || handle_tap(state, true, 200) || handle_tap(state, false, 210)) return 1;
    KeyState keys{};
    keys[VK_LMENU] = true;
    if (!no_other_key_down(keys, VK_LMENU)) return 1;
    keys[0x41] = true;
    if (no_other_key_down(keys, VK_LMENU)) return 1;
    keys[0x41] = false;
    keys[VK_LCONTROL] = true;
    if (no_other_key_down(keys, VK_LMENU)) return 1;
    keys[VK_LCONTROL] = false;
    keys[VK_LSHIFT] = true;
    if (no_other_key_down(keys, VK_LMENU)) return 1;
    reset_tap(state);
    if (handle_bare_tap(state, true, 0, true) || handle_bare_tap(state, false, 10, true) || handle_bare_tap(state, true, 100, false) || handle_bare_tap(state, false, 110, true) || handle_bare_tap(state, true, 200, true) || handle_bare_tap(state, false, 210, true) || !handle_bare_tap(state, true, 300, true)) return 1;
    const auto parsed = parse_holds(R"({"holds":[{"id":"voice","keyCode":164,"ms":500},{"id":"bad","keyCode":65,"ms":500}]})");
    if (parsed.size() != 1 || parsed[0].keyCode != VK_LMENU || parsed[0].milliseconds != 500 || parsed[0].id != "voice") return 1;
    return 0;
}

int main(int argc, char** argv) {
    if (argc == 2 && std::string(argv[1]) == "--self-test") return self_test();
    if (argc == 2 && std::string(argv[1]) == "--screens") {
        std::cout << "[]" << std::endl;
        return 0;
    }
    if (argc != 1) return 2;
    message_thread = GetCurrentThreadId();
    HHOOK hook = SetWindowsHookExW(WH_KEYBOARD_LL, keyboard_hook, GetModuleHandleW(nullptr), 0);
    if (!hook) {
        std::cerr << "Emma: unable to start the Windows keyboard listener." << std::endl;
        return 1;
    }
    std::thread(read_updates).detach();
    MSG message;
    while (running && GetMessageW(&message, nullptr, 0, 0) > 0) {
        TranslateMessage(&message);
        DispatchMessageW(&message);
    }
    running = false;
    UnhookWindowsHookEx(hook);
    return 0;
}
