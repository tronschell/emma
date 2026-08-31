#pragma once

#include <string>

namespace emma_windows_path {

inline std::wstring extended_length(const std::wstring &value) {
    if (value.empty()) return {};
    std::wstring normalized = value;
    for (wchar_t &character : normalized) if (character == L'/') character = L'\\';
    if (normalized.rfind(L"\\\\?\\", 0) == 0) return normalized;
    if (normalized.rfind(L"\\\\.\\", 0) == 0) return {};
    const bool drive = normalized.size() >= 3
        && ((normalized[0] >= L'a' && normalized[0] <= L'z') || (normalized[0] >= L'A' && normalized[0] <= L'Z'))
        && normalized[1] == L':' && normalized[2] == L'\\';
    if (drive) return L"\\\\?\\" + normalized;
    if (normalized.size() >= 5 && normalized[0] == L'\\' && normalized[1] == L'\\') {
        const size_t separator = normalized.find(L'\\', 2);
        if (separator > 2 && separator + 1 < normalized.size()) return L"\\\\?\\UNC\\" + normalized.substr(2);
    }
    return {};
}

inline std::wstring without_extended_length(const std::wstring &value) {
    std::wstring normalized = value;
    for (wchar_t &character : normalized) if (character == L'/') character = L'\\';
    if (normalized.rfind(L"\\\\?\\UNC\\", 0) == 0) return L"\\\\" + normalized.substr(8);
    if (normalized.rfind(L"\\\\?\\", 0) == 0) return normalized.substr(4);
    return normalized;
}

}
