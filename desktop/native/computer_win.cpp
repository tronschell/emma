#ifndef NOMINMAX
#define NOMINMAX
#endif
#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif
#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0A00
#endif

#include <windows.h>
#include <tlhelp32.h>
#include <uiautomation.h>
#include <shlobj.h>
#include <shellapi.h>
#include <oleauto.h>
#include <winnls.h>
#include "windows_path.hpp"
#include <fcntl.h>
#include <io.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <cwchar>
#include <climits>
#include <cstring>
#include <iomanip>
#include <iostream>
#include <limits>
#include <locale>
#include <map>
#include <optional>
#include <sstream>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

static constexpr size_t max_elements = 400;
static constexpr size_t max_state_bytes = 23000;
static constexpr size_t max_input_bytes = 65536;
static constexpr size_t max_text_characters = 4096;
static constexpr size_t max_identity_bytes = 16384;
static constexpr ULONGLONG snapshot_lifetime_ms = 60000;
static constexpr ULONGLONG operation_lifetime_ms = 5000;
static constexpr ULONGLONG launch_window_wait_ms = 12000;
static constexpr size_t max_app_name_characters = 128;
static constexpr size_t max_installed_apps = 4096;

static volatile LONG cancelled = 0;
static ULONGLONG operation_deadline = 0;

template <typename T>
class ComPtr {
public:
    ComPtr() = default;

    explicit ComPtr(T *value) : value_(value) {
        if (value_) value_->AddRef();
    }

    ComPtr(const ComPtr &other) : value_(other.value_) {
        if (value_) value_->AddRef();
    }

    ComPtr(ComPtr &&other) noexcept : value_(other.value_) {
        other.value_ = nullptr;
    }

    ComPtr &operator=(const ComPtr &other) {
        if (this != &other) {
            T *value = other.value_;
            if (value) value->AddRef();
            reset(value);
        }
        return *this;
    }

    ComPtr &operator=(ComPtr &&other) noexcept {
        if (this != &other) {
            reset();
            value_ = other.value_;
            other.value_ = nullptr;
        }
        return *this;
    }

    ~ComPtr() {
        reset();
    }

    T *get() const {
        return value_;
    }

    T **put() {
        reset();
        return &value_;
    }

    explicit operator bool() const {
        return value_ != nullptr;
    }

    T *operator->() const {
        return value_;
    }

    void reset(T *value = nullptr) {
        if (value_) value_->Release();
        value_ = value;
    }

private:
    T *value_ = nullptr;
};

struct Json {
    enum class Kind { Null, Boolean, Number, String, Object, Array };

    Kind kind = Kind::Null;
    bool boolean = false;
    double number = 0;
    std::string text;
    std::map<std::string, Json> object;
    std::vector<Json> array;

    static Json null() {
        return {};
    }

    static Json boolean_value(bool value) {
        Json result;
        result.kind = Kind::Boolean;
        result.boolean = value;
        return result;
    }

    static Json number_value(double value) {
        Json result;
        result.kind = Kind::Number;
        result.number = value;
        return result;
    }

    static Json string_value(std::string value) {
        Json result;
        result.kind = Kind::String;
        result.text = std::move(value);
        return result;
    }

    static Json object_value() {
        Json result;
        result.kind = Kind::Object;
        return result;
    }

    static Json array_value() {
        Json result;
        result.kind = Kind::Array;
        return result;
    }

    void set(std::string key, Json value) {
        kind = Kind::Object;
        object[std::move(key)] = std::move(value);
    }

    const Json *get(const std::string &key) const {
        auto found = object.find(key);
        return found == object.end() ? nullptr : &found->second;
    }
};

static bool operator==(const Json &left, const Json &right) {
    if (left.kind != right.kind) return false;
    switch (left.kind) {
    case Json::Kind::Null:
        return true;
    case Json::Kind::Boolean:
        return left.boolean == right.boolean;
    case Json::Kind::Number:
        return left.number == right.number;
    case Json::Kind::String:
        return left.text == right.text;
    case Json::Kind::Object:
        return left.object == right.object;
    case Json::Kind::Array:
        return left.array == right.array;
    }
    return false;
}

static bool operator!=(const Json &left, const Json &right) {
    return !(left == right);
}

static void append_codepoint(std::string *output, uint32_t value) {
    if (value <= 0x7f) {
        output->push_back(static_cast<char>(value));
    } else if (value <= 0x7ff) {
        output->push_back(static_cast<char>(0xc0 | (value >> 6)));
        output->push_back(static_cast<char>(0x80 | (value & 0x3f)));
    } else if (value <= 0xffff) {
        output->push_back(static_cast<char>(0xe0 | (value >> 12)));
        output->push_back(static_cast<char>(0x80 | ((value >> 6) & 0x3f)));
        output->push_back(static_cast<char>(0x80 | (value & 0x3f)));
    } else {
        output->push_back(static_cast<char>(0xf0 | (value >> 18)));
        output->push_back(static_cast<char>(0x80 | ((value >> 12) & 0x3f)));
        output->push_back(static_cast<char>(0x80 | ((value >> 6) & 0x3f)));
        output->push_back(static_cast<char>(0x80 | (value & 0x3f)));
    }
}

class JsonParser {
public:
    explicit JsonParser(const std::string &input) : input_(input) {}

    bool parse(Json *result) {
        if (!value(result, 0)) return false;
        whitespace();
        return index_ == input_.size();
    }

private:
    bool value(Json *result, size_t depth) {
        if (depth > 32) return false;
        whitespace();
        if (index_ >= input_.size()) return false;
        switch (input_[index_]) {
        case 'n':
            if (!consume("null")) return false;
            *result = Json::null();
            return true;
        case 't':
            if (!consume("true")) return false;
            *result = Json::boolean_value(true);
            return true;
        case 'f':
            if (!consume("false")) return false;
            *result = Json::boolean_value(false);
            return true;
        case '"': {
            std::string parsed;
            if (!string(&parsed)) return false;
            *result = Json::string_value(std::move(parsed));
            return true;
        }
        case '{':
            return object(result, depth + 1);
        case '[':
            return array(result, depth + 1);
        default:
            return number(result);
        }
    }

    bool consume(const char *literal) {
        size_t length = std::char_traits<char>::length(literal);
        if (input_.compare(index_, length, literal) != 0) return false;
        index_ += length;
        return true;
    }

    void whitespace() {
        while (index_ < input_.size() && (input_[index_] == ' ' || input_[index_] == '\t'
            || input_[index_] == '\r' || input_[index_] == '\n')) {
            index_ += 1;
        }
    }

    bool string(std::string *result) {
        if (index_ >= input_.size() || input_[index_] != '"') return false;
        index_ += 1;
        result->clear();
        while (index_ < input_.size()) {
            unsigned char byte = static_cast<unsigned char>(input_[index_++]);
            if (byte == '"') return true;
            if (byte < 0x20) return false;
            if (byte != '\\') {
                if (result->size() >= max_input_bytes) return false;
                result->push_back(static_cast<char>(byte));
                continue;
            }
            if (index_ >= input_.size()) return false;
            char escaped = input_[index_++];
            switch (escaped) {
            case '"': result->push_back('"'); break;
            case '\\': result->push_back('\\'); break;
            case '/': result->push_back('/'); break;
            case 'b': result->push_back('\b'); break;
            case 'f': result->push_back('\f'); break;
            case 'n': result->push_back('\n'); break;
            case 'r': result->push_back('\r'); break;
            case 't': result->push_back('\t'); break;
            case 'u': {
                uint32_t value = 0;
                if (!hex4(&value)) return false;
                if (value >= 0xd800 && value <= 0xdbff) {
                    if (index_ + 5 >= input_.size() || input_[index_] != '\\' || input_[index_ + 1] != 'u') return false;
                    index_ += 2;
                    uint32_t low = 0;
                    if (!hex4(&low) || low < 0xdc00 || low > 0xdfff) return false;
                    value = 0x10000 + ((value - 0xd800) << 10) + low - 0xdc00;
                } else if (value >= 0xdc00 && value <= 0xdfff) {
                    return false;
                }
                append_codepoint(result, value);
                break;
            }
            default:
                return false;
            }
            if (result->size() > max_input_bytes) return false;
        }
        return false;
    }

    bool hex4(uint32_t *result) {
        if (index_ + 4 > input_.size()) return false;
        uint32_t value = 0;
        for (size_t count = 0; count < 4; count += 1) {
            char byte = input_[index_++];
            uint32_t nibble = 0;
            if (byte >= '0' && byte <= '9') nibble = static_cast<uint32_t>(byte - '0');
            else if (byte >= 'a' && byte <= 'f') nibble = static_cast<uint32_t>(byte - 'a' + 10);
            else if (byte >= 'A' && byte <= 'F') nibble = static_cast<uint32_t>(byte - 'A' + 10);
            else return false;
            value = (value << 4) | nibble;
        }
        *result = value;
        return true;
    }

    bool object(Json *result, size_t depth) {
        if (input_[index_++] != '{') return false;
        *result = Json::object_value();
        whitespace();
        if (index_ < input_.size() && input_[index_] == '}') {
            index_ += 1;
            return true;
        }
        for (size_t count = 0; count < 64; count += 1) {
            whitespace();
            std::string key;
            if (!string(&key)) return false;
            whitespace();
            if (index_ >= input_.size() || input_[index_++] != ':') return false;
            Json member;
            if (!value(&member, depth)) return false;
            if (!result->object.emplace(std::move(key), std::move(member)).second) return false;
            whitespace();
            if (index_ >= input_.size()) return false;
            if (input_[index_] == '}') {
                index_ += 1;
                return true;
            }
            if (input_[index_++] != ',') return false;
        }
        return false;
    }

    bool array(Json *result, size_t depth) {
        if (input_[index_++] != '[') return false;
        *result = Json::array_value();
        whitespace();
        if (index_ < input_.size() && input_[index_] == ']') {
            index_ += 1;
            return true;
        }
        for (size_t count = 0; count < 512; count += 1) {
            Json member;
            if (!value(&member, depth)) return false;
            result->array.push_back(std::move(member));
            whitespace();
            if (index_ >= input_.size()) return false;
            if (input_[index_] == ']') {
                index_ += 1;
                return true;
            }
            if (input_[index_++] != ',') return false;
        }
        return false;
    }

    bool number(Json *result) {
        size_t start = index_;
        if (index_ < input_.size() && input_[index_] == '-') index_ += 1;
        if (index_ >= input_.size()) return false;
        if (input_[index_] == '0') {
            index_ += 1;
        } else {
            if (input_[index_] < '1' || input_[index_] > '9') return false;
            while (index_ < input_.size() && input_[index_] >= '0' && input_[index_] <= '9') index_ += 1;
        }
        if (index_ < input_.size() && input_[index_] == '.') {
            index_ += 1;
            size_t fraction = index_;
            while (index_ < input_.size() && input_[index_] >= '0' && input_[index_] <= '9') index_ += 1;
            if (fraction == index_) return false;
        }
        if (index_ < input_.size() && (input_[index_] == 'e' || input_[index_] == 'E')) {
            index_ += 1;
            if (index_ < input_.size() && (input_[index_] == '+' || input_[index_] == '-')) index_ += 1;
            size_t exponent = index_;
            while (index_ < input_.size() && input_[index_] >= '0' && input_[index_] <= '9') index_ += 1;
            if (exponent == index_) return false;
        }
        std::string encoded = input_.substr(start, index_ - start);
        char *end = nullptr;
        double parsed = std::strtod(encoded.c_str(), &end);
        if (!end || *end || !std::isfinite(parsed)) return false;
        *result = Json::number_value(parsed);
        return true;
    }

    const std::string &input_;
    size_t index_ = 0;
};

static void append_json_escaped(const std::string &value, std::string *output) {
    output->push_back('"');
    for (unsigned char byte : value) {
        switch (byte) {
        case '"': output->append("\\\""); break;
        case '\\': output->append("\\\\"); break;
        case '\b': output->append("\\b"); break;
        case '\f': output->append("\\f"); break;
        case '\n': output->append("\\n"); break;
        case '\r': output->append("\\r"); break;
        case '\t': output->append("\\t"); break;
        default:
            if (byte < 0x20) {
                std::ostringstream encoded;
                encoded << "\\u" << std::hex << std::setw(4) << std::setfill('0') << static_cast<unsigned>(byte);
                output->append(encoded.str());
            } else {
                output->push_back(static_cast<char>(byte));
            }
            break;
        }
    }
    output->push_back('"');
}

static void append_json(const Json &value, std::string *output, size_t depth = 0) {
    if (depth > 32) {
        output->append("null");
        return;
    }
    switch (value.kind) {
    case Json::Kind::Null:
        output->append("null");
        break;
    case Json::Kind::Boolean:
        output->append(value.boolean ? "true" : "false");
        break;
    case Json::Kind::Number: {
        std::ostringstream encoded;
        encoded.imbue(std::locale::classic());
        encoded << std::setprecision(17) << value.number;
        output->append(encoded.str());
        break;
    }
    case Json::Kind::String:
        append_json_escaped(value.text, output);
        break;
    case Json::Kind::Object: {
        output->push_back('{');
        bool first = true;
        for (const auto &member : value.object) {
            if (!first) output->push_back(',');
            first = false;
            append_json_escaped(member.first, output);
            output->push_back(':');
            append_json(member.second, output, depth + 1);
        }
        output->push_back('}');
        break;
    }
    case Json::Kind::Array:
        output->push_back('[');
        for (size_t index = 0; index < value.array.size(); index += 1) {
            if (index) output->push_back(',');
            append_json(value.array[index], output, depth + 1);
        }
        output->push_back(']');
        break;
    }
}

static std::string json_string(const std::string &value) {
    std::string output;
    append_json_escaped(value, &output);
    return output;
}

static bool utf8_to_wide(const std::string &value, std::wstring *output) {
    if (value.empty()) {
        output->clear();
        return true;
    }
    int length = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), nullptr, 0);
    if (length <= 0) return false;
    output->resize(static_cast<size_t>(length));
    return MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), output->data(), length) == length;
}

static bool wide_to_utf8(const std::wstring &value, std::string *output) {
    if (value.empty()) {
        output->clear();
        return true;
    }
    int length = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
    if (length <= 0) return false;
    output->resize(static_cast<size_t>(length));
    return WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), output->data(), length, nullptr, nullptr) == length;
}

static std::string utf8_prefix(const std::wstring &value, size_t maximum) {
    size_t length = std::min(value.size(), maximum);
    while (length) {
        if (length < value.size() && value[length - 1] >= 0xd800 && value[length - 1] <= 0xdbff) length -= 1;
        std::string result;
        if (wide_to_utf8(value.substr(0, length), &result) && result.size() <= maximum) return result;
        length -= 1;
    }
    return {};
}

static bool bounded_text(const std::string &value, size_t maximum, bool empty_allowed, std::wstring *wide = nullptr) {
    if (!empty_allowed && value.empty()) return false;
    std::wstring converted;
    if (!utf8_to_wide(value, &converted) || converted.size() > maximum || converted.find(L'\0') != std::wstring::npos) return false;
    if (wide) *wide = std::move(converted);
    return true;
}

static bool valid_id(const std::string &value) {
    if (value.empty() || value.size() > 255) return false;
    auto alphanumeric = [](unsigned char byte) {
        return (byte >= 'a' && byte <= 'z') || (byte >= 'A' && byte <= 'Z') || (byte >= '0' && byte <= '9');
    };
    if (!alphanumeric(static_cast<unsigned char>(value.front()))) return false;
    return std::all_of(value.begin(), value.end(), [alphanumeric](char byte) {
        unsigned char value = static_cast<unsigned char>(byte);
        return alphanumeric(value) || value == '_' || value == '.' || value == '-';
    });
}

static bool absolute_windows_path(const std::wstring &value) {
    if (value.size() >= 3 && ((value[0] >= L'a' && value[0] <= L'z') || (value[0] >= L'A' && value[0] <= L'Z'))
        && value[1] == L':' && (value[2] == L'\\' || value[2] == L'/')) return true;
    return value.size() >= 2 && value[0] == L'\\' && value[1] == L'\\';
}

static bool finite_integer(const Json *value, double minimum, double maximum, DWORD *result = nullptr) {
    if (!value || value->kind != Json::Kind::Number || !std::isfinite(value->number)
        || value->number < minimum || value->number > maximum || std::floor(value->number) != value->number) return false;
    if (result) *result = static_cast<DWORD>(value->number);
    return true;
}

static bool finite_positive(const Json *value) {
    return value && value->kind == Json::Kind::Number && std::isfinite(value->number) && value->number > 0;
}

static BOOL WINAPI console_handler(DWORD type) {
    switch (type) {
    case CTRL_C_EVENT:
    case CTRL_BREAK_EVENT:
    case CTRL_CLOSE_EVENT:
    case CTRL_LOGOFF_EVENT:
    case CTRL_SHUTDOWN_EVENT:
        InterlockedExchange(&cancelled, 1);
        return TRUE;
    default:
        return FALSE;
    }
}

static bool within_deadline() {
    return InterlockedCompareExchange(&cancelled, 0, 0) == 0 && operation_deadline != 0 && GetTickCount64() < operation_deadline;
}

struct IdentityData {
    std::string id;
    std::string name;
    std::string path;
    DWORD pid = 0;
    double launched_at = 0;
    std::wstring wide_path;
};

static std::wstring normalized_windows_path(const std::wstring &value) {
    if (!absolute_windows_path(value)) return {};
    const std::wstring extended = emma_windows_path::extended_length(value);
    if (extended.empty()) return {};
    std::array<wchar_t, 32768> full_path{};
    DWORD length = GetFullPathNameW(extended.c_str(), static_cast<DWORD>(full_path.size()), full_path.data(), nullptr);
    if (!length || length >= full_path.size()) return {};
    std::wstring normalized = emma_windows_path::without_extended_length(std::wstring(full_path.data(), length));
    for (wchar_t &character : normalized) if (character == L'/') character = L'\\';
    while (normalized.size() > 3 && normalized.back() == L'\\') normalized.pop_back();
    int lower_length = LCMapStringEx(LOCALE_NAME_INVARIANT, LCMAP_LOWERCASE, normalized.data(), static_cast<int>(normalized.size()), nullptr, 0, nullptr, nullptr, 0);
    if (lower_length <= 0) return {};
    std::wstring lower(static_cast<size_t>(lower_length), L'\0');
    if (LCMapStringEx(LOCALE_NAME_INVARIANT, LCMAP_LOWERCASE, normalized.data(), static_cast<int>(normalized.size()), lower.data(), lower_length, nullptr, nullptr, 0) != lower_length) return {};
    return lower;
}

static std::string identity_id(const std::wstring &normalized_path) {
    std::string encoded;
    if (normalized_path.empty() || !wide_to_utf8(normalized_path, &encoded)) return {};
    uint64_t hash = 14695981039346656037ULL;
    for (unsigned char byte : encoded) {
        hash ^= byte;
        hash *= 1099511628211ULL;
    }
    std::ostringstream result;
    result << "app-" << std::hex << std::setw(16) << std::setfill('0') << hash;
    return result.str();
}

static std::wstring executable_stem(const std::wstring &path) {
    size_t slash = path.find_last_of(L"\\/");
    std::wstring stem = path.substr(slash == std::wstring::npos ? 0 : slash + 1);
    size_t dot = stem.find_last_of(L'.');
    if (dot != std::wstring::npos && dot > 0) stem.resize(dot);
    return stem;
}

static std::optional<IdentityData> process_identity(DWORD pid) {
    if (pid == 0 || pid > static_cast<DWORD>(INT_MAX)) return std::nullopt;
    HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (!process) return std::nullopt;
    std::array<wchar_t, 32768> path_buffer{};
    DWORD path_length = static_cast<DWORD>(path_buffer.size());
    FILETIME created{}, exited{}, kernel{}, user{};
    BOOL path_ok = QueryFullProcessImageNameW(process, 0, path_buffer.data(), &path_length);
    BOOL birth_ok = GetProcessTimes(process, &created, &exited, &kernel, &user);
    CloseHandle(process);
    if (!path_ok || !path_length || !birth_ok) return std::nullopt;
    ULARGE_INTEGER ticks{};
    ticks.LowPart = created.dwLowDateTime;
    ticks.HighPart = created.dwHighDateTime;
    constexpr ULONGLONG unix_epoch = 116444736000000000ULL;
    if (ticks.QuadPart <= unix_epoch) return std::nullopt;
    double launched_at = static_cast<double>(ticks.QuadPart - unix_epoch) / 10000.0;
    std::wstring path = emma_windows_path::without_extended_length(std::wstring(path_buffer.data(), path_length));
    if (!absolute_windows_path(path)) return std::nullopt;
    std::wstring normalized_path = normalized_windows_path(path);
    std::wstring stem = executable_stem(path);
    std::string id;
    std::string name;
    std::string encoded_path;
    if ((id = identity_id(normalized_path)).empty() || !wide_to_utf8(stem, &name) || !wide_to_utf8(path, &encoded_path)
        || !valid_id(id) || name.empty() || name.size() > 256 || encoded_path.size() > 4096) return std::nullopt;
    return IdentityData{std::move(id), std::move(name), std::move(encoded_path), pid, launched_at, std::move(normalized_path)};
}

using ParentMap = std::unordered_map<DWORD, DWORD>;

static ParentMap process_parents() {
    ParentMap result;
    HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snapshot == INVALID_HANDLE_VALUE) return result;
    PROCESSENTRY32W entry{};
    entry.dwSize = sizeof(entry);
    if (Process32FirstW(snapshot, &entry)) {
        do {
            result.emplace(entry.th32ProcessID, entry.th32ParentProcessID);
            entry.dwSize = sizeof(entry);
        } while (Process32NextW(snapshot, &entry));
    }
    CloseHandle(snapshot);
    return result;
}

static const wchar_t *const emma_binary_names[] = {
    L"emma", L"emma-host", L"emma-cli", L"emma-pty", L"emma-computer", L"emma-option-tap", L"emma-transcribe",
};

static std::wstring containing_directory(const std::wstring &path) {
    size_t slash = path.find_last_of(L'\\');
    return slash == std::wstring::npos || slash < 2 ? std::wstring() : path.substr(0, slash);
}

static bool inside_directory(const std::wstring &normalized_path, const std::wstring &directory) {
    return !directory.empty() && normalized_path.size() > directory.size() + 1
        && normalized_path.compare(0, directory.size(), directory) == 0 && normalized_path[directory.size()] == L'\\';
}

static bool emma_binary_name(const std::wstring &path) {
    const std::wstring stem = executable_stem(path);
    for (const wchar_t *name : emma_binary_names) if (_wcsicmp(stem.c_str(), name) == 0) return true;
    return false;
}

struct EmmaFiles {
    DWORD blocked_pid = 0;
    std::wstring helper_directory;
    std::wstring app_directory;
};

static EmmaFiles emma_files(DWORD blocked_pid) {
    EmmaFiles result;
    result.blocked_pid = blocked_pid;
    if (auto helper = process_identity(GetCurrentProcessId())) result.helper_directory = containing_directory(helper->wide_path);
    if (auto app = process_identity(blocked_pid)) result.app_directory = containing_directory(app->wide_path);
    return result;
}

static bool emma_owned(const EmmaFiles &emma, DWORD pid, const std::wstring &normalized_path) {
    return pid == GetCurrentProcessId() || pid == emma.blocked_pid || emma_binary_name(normalized_path)
        || inside_directory(normalized_path, emma.helper_directory) || inside_directory(normalized_path, emma.app_directory);
}

struct WindowList {
    std::vector<std::pair<HWND, DWORD>> windows;
};

static bool excluded_window_class(HWND window) {
    std::array<wchar_t, 256> class_name{};
    int length = GetClassNameW(window, class_name.data(), static_cast<int>(class_name.size()));
    if (length <= 0) return false;
    std::wstring value(class_name.data(), length);
    return _wcsicmp(value.c_str(), L"#32768") == 0 || _wcsicmp(value.c_str(), L"#32769") == 0
        || _wcsicmp(value.c_str(), L"Shell_TrayWnd") == 0 || _wcsicmp(value.c_str(), L"WorkerW") == 0
        || _wcsicmp(value.c_str(), L"Progman") == 0;
}

static BOOL CALLBACK collect_window(HWND window, LPARAM parameter) {
    auto *list = reinterpret_cast<WindowList *>(parameter);
    if (list->windows.size() >= 512 || !IsWindowVisible(window) || GetWindow(window, GW_OWNER)
        || (GetWindowLongPtrW(window, GWL_EXSTYLE) & WS_EX_TOOLWINDOW) || excluded_window_class(window)) return TRUE;
    DWORD pid = 0;
    if (GetWindowThreadProcessId(window, &pid) && pid) list->windows.emplace_back(window, pid);
    return TRUE;
}

static WindowList windows_for_process(DWORD pid = 0) {
    WindowList list;
    EnumWindows(collect_window, reinterpret_cast<LPARAM>(&list));
    if (pid) {
        list.windows.erase(std::remove_if(list.windows.begin(), list.windows.end(), [pid](const auto &item) {
            return item.second != pid;
        }), list.windows.end());
    }
    return list;
}

static Json identity_json(const IdentityData &identity) {
    Json result = Json::object_value();
    result.set("id", Json::string_value(identity.id));
    result.set("name", Json::string_value(identity.name));
    result.set("pid", Json::number_value(static_cast<double>(identity.pid)));
    result.set("path", Json::string_value(identity.path));
    result.set("launchedAt", Json::number_value(identity.launched_at));
    return result;
}

struct LaunchTarget {
    std::wstring name;
    std::wstring target;
    bool packaged = false;
};

static bool resolvable_app_name(const std::wstring &name) {
    if (name.empty() || name.size() > max_app_name_characters) return false;
    for (wchar_t character : name) {
        if (character < 0x20 || character == 0x7f || character == L'\\' || character == L'/') return false;
    }
    return name.front() != L' ' && name.back() != L' ';
}

static bool same_app_name(const std::wstring &left, const std::wstring &right) {
    return CompareStringOrdinal(left.c_str(), static_cast<int>(left.size()), right.c_str(), static_cast<int>(right.size()), TRUE) == CSTR_EQUAL;
}

static bool app_name_prefix(const std::wstring &candidate, const std::wstring &name) {
    return candidate.size() > name.size() && same_app_name(candidate.substr(0, name.size()), name);
}

using NamedTargets = std::vector<std::pair<std::wstring, std::wstring>>;

static void collect_shortcuts(const std::wstring &directory, size_t depth, NamedTargets *shortcuts) {
    if (depth > 6 || shortcuts->size() >= max_installed_apps) return;
    WIN32_FIND_DATAW entry{};
    HANDLE find = FindFirstFileExW((directory + L"\\*").c_str(), FindExInfoBasic, &entry, FindExSearchNameMatch, nullptr, 0);
    if (find == INVALID_HANDLE_VALUE) return;
    std::vector<std::wstring> children;
    do {
        const std::wstring child(entry.cFileName);
        if (child == L"." || child == L"..") continue;
        if (entry.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) {
            if (children.size() < max_installed_apps) children.push_back(directory + L"\\" + child);
            continue;
        }
        if (child.size() < 5 || !same_app_name(child.substr(child.size() - 4), L".lnk")) continue;
        shortcuts->emplace_back(child.substr(0, child.size() - 4), directory + L"\\" + child);
    } while (shortcuts->size() < max_installed_apps && FindNextFileW(find, &entry));
    FindClose(find);
    for (const std::wstring &child : children) collect_shortcuts(child, depth + 1, shortcuts);
}

static NamedTargets start_menu_shortcuts() {
    NamedTargets shortcuts;
    for (const wchar_t *variable : {L"ProgramData", L"APPDATA"}) {
        std::array<wchar_t, MAX_PATH> value{};
        DWORD length = GetEnvironmentVariableW(variable, value.data(), static_cast<DWORD>(value.size()));
        if (!length || length >= value.size()) continue;
        collect_shortcuts(std::wstring(value.data(), length) + L"\\Microsoft\\Windows\\Start Menu\\Programs", 0, &shortcuts);
    }
    return shortcuts;
}

static std::wstring existing_executable(std::wstring path) {
    if (path.size() >= 2 && path.front() == L'"' && path.back() == L'"') path = path.substr(1, path.size() - 2);
    if (!absolute_windows_path(path) || path.size() < 5 || !same_app_name(path.substr(path.size() - 4), L".exe")) return {};
    DWORD attributes = GetFileAttributesW(path.c_str());
    return attributes == INVALID_FILE_ATTRIBUTES || (attributes & FILE_ATTRIBUTE_DIRECTORY) ? std::wstring() : path;
}

static std::wstring shortcut_executable(const std::wstring &shortcut) {
    ComPtr<IShellLinkW> link;
    if (FAILED(CoCreateInstance(CLSID_ShellLink, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(link.put()))) || !link) return {};
    ComPtr<IPersistFile> file;
    if (FAILED(link->QueryInterface(IID_PPV_ARGS(file.put()))) || !file) return {};
    if (FAILED(file->Load(shortcut.c_str(), STGM_READ))) return {};
    std::array<wchar_t, MAX_PATH> path{};
    if (FAILED(link->GetPath(path.data(), static_cast<int>(path.size()), nullptr, SLGP_UNCPRIORITY))) return {};
    return existing_executable(std::wstring(path.data()));
}

static std::wstring app_paths_executable(const std::wstring &name) {
    for (HKEY root : {HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE}) {
        for (const std::wstring &suffix : {std::wstring(), std::wstring(L".exe")}) {
            const std::wstring key = L"SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\" + name + suffix;
            std::array<wchar_t, 4096> value{};
            DWORD bytes = static_cast<DWORD>(value.size() * sizeof(wchar_t));
            if (RegGetValueW(root, key.c_str(), nullptr, RRF_RT_REG_SZ | RRF_RT_REG_EXPAND_SZ, nullptr, value.data(), &bytes) != ERROR_SUCCESS) continue;
            const std::wstring executable = existing_executable(std::wstring(value.data()));
            if (!executable.empty()) return executable;
        }
    }
    return {};
}

static NamedTargets installed_packaged_apps() {
    NamedTargets apps;
    ComPtr<IShellItem> folder;
    if (FAILED(SHCreateItemFromParsingName(L"shell:AppsFolder", nullptr, IID_PPV_ARGS(folder.put()))) || !folder) return apps;
    ComPtr<IEnumShellItems> items;
    if (FAILED(folder->BindToHandler(nullptr, BHID_EnumItems, IID_PPV_ARGS(items.put()))) || !items) return apps;
    ComPtr<IShellItem> item;
    while (apps.size() < max_installed_apps && items->Next(1, item.put(), nullptr) == S_OK && item) {
        LPWSTR display = nullptr;
        LPWSTR parsing = nullptr;
        if (SUCCEEDED(item->GetDisplayName(SIGDN_NORMALDISPLAY, &display)) && display
            && SUCCEEDED(item->GetDisplayName(SIGDN_DESKTOPABSOLUTEPARSING, &parsing)) && parsing) {
            apps.emplace_back(display, parsing);
        }
        if (display) CoTaskMemFree(display);
        if (parsing) CoTaskMemFree(parsing);
    }
    return apps;
}

static bool packaged_identifier(const std::wstring &parsing_name) {
    return parsing_name.find(L'!') != std::wstring::npos && parsing_name.find(L'\\') == std::wstring::npos;
}

static std::optional<LaunchTarget> resolve_app(const std::wstring &name) {
    if (!resolvable_app_name(name)) return std::nullopt;
    const NamedTargets shortcuts = start_menu_shortcuts();
    for (const auto &shortcut : shortcuts) {
        if (!same_app_name(shortcut.first, name)) continue;
        const std::wstring executable = shortcut_executable(shortcut.second);
        if (!executable.empty()) return LaunchTarget{shortcut.first, executable, false};
    }
    const std::wstring executable = app_paths_executable(name);
    if (!executable.empty()) return LaunchTarget{executable_stem(executable), executable, false};
    const NamedTargets packaged = installed_packaged_apps();
    for (const auto &app : packaged) {
        if (same_app_name(app.first, name) && packaged_identifier(app.second)) return LaunchTarget{app.first, app.second, true};
    }
    std::vector<LaunchTarget> near_matches;
    for (const auto &shortcut : shortcuts) {
        if (!app_name_prefix(shortcut.first, name)) continue;
        const std::wstring path = shortcut_executable(shortcut.second);
        if (!path.empty()) near_matches.push_back({shortcut.first, path, false});
    }
    for (const auto &app : packaged) {
        if (app_name_prefix(app.first, name) && packaged_identifier(app.second)) near_matches.push_back({app.first, app.second, true});
    }
    if (near_matches.size() == 1) return near_matches.front();
    return std::nullopt;
}

static bool launch_executable(const std::wstring &executable, DWORD *pid) {
    std::wstring command = L"\"" + executable + L"\"";
    const std::wstring directory = containing_directory(executable);
    for (DWORD flags : {static_cast<DWORD>(CREATE_BREAKAWAY_FROM_JOB | CREATE_NEW_PROCESS_GROUP), static_cast<DWORD>(CREATE_NEW_PROCESS_GROUP)}) {
        STARTUPINFOW startup{};
        startup.cb = sizeof(startup);
        PROCESS_INFORMATION information{};
        if (!CreateProcessW(executable.c_str(), command.data(), nullptr, nullptr, FALSE, flags, nullptr,
                            directory.empty() ? nullptr : directory.c_str(), &startup, &information)) continue;
        *pid = information.dwProcessId;
        CloseHandle(information.hThread);
        CloseHandle(information.hProcess);
        return true;
    }
    return false;
}

static const CLSID clsid_application_activation_manager = {
    0x45BA127D, 0x10A8, 0x46EA, {0x8A, 0xB7, 0x56, 0xEA, 0x90, 0x78, 0x94, 0x3C}
};

static bool launch_packaged_app(const std::wstring &identifier, DWORD *pid) {
    ComPtr<IApplicationActivationManager> manager;
    if (SUCCEEDED(CoCreateInstance(clsid_application_activation_manager, nullptr, CLSCTX_LOCAL_SERVER, IID_PPV_ARGS(manager.put()))) && manager) {
        DWORD activated = 0;
        if (SUCCEEDED(manager->ActivateApplication(identifier.c_str(), nullptr, AO_NONE, &activated)) && activated) {
            *pid = activated;
            return true;
        }
    }
    const std::wstring shell = L"shell:AppsFolder\\" + identifier;
    SHELLEXECUTEINFOW info{};
    info.cbSize = sizeof(info);
    info.fMask = SEE_MASK_NOASYNC | SEE_MASK_FLAG_NO_UI;
    info.lpFile = shell.c_str();
    info.nShow = SW_SHOWNORMAL;
    return ShellExecuteExW(&info) != FALSE;
}

static std::map<DWORD, IdentityData> windowed_processes(const std::map<DWORD, IdentityData> &excluded) {
    std::map<DWORD, IdentityData> processes;
    for (const auto &window : windows_for_process().windows) {
        DWORD pid = window.second;
        if (excluded.count(pid) || processes.count(pid)) continue;
        auto identity = process_identity(pid);
        if (identity) processes.emplace(pid, std::move(*identity));
    }
    return processes;
}

static std::optional<IdentityData> wait_for_launched_app(const std::map<DWORD, IdentityData> &before, DWORD launched, const std::wstring &normalized_executable) {
    const ULONGLONG deadline = GetTickCount64() + launch_window_wait_ms;
    while (InterlockedCompareExchange(&cancelled, 0, 0) == 0) {
        const std::map<DWORD, IdentityData> candidates = windowed_processes(before);
        auto exact = candidates.find(launched);
        if (exact != candidates.end()) return exact->second;
        for (const auto &candidate : candidates) {
            if (!normalized_executable.empty() && candidate.second.wide_path == normalized_executable) return candidate.second;
        }
        if (candidates.size() == 1) return candidates.begin()->second;
        if (GetTickCount64() >= deadline) return std::nullopt;
        Sleep(150);
    }
    return std::nullopt;
}

static bool parse_identity(const Json &value, DWORD blocked_pid, IdentityData *identity) {
    if (value.kind != Json::Kind::Object || value.object.size() != 5) return false;
    const Json *id = value.get("id");
    const Json *name = value.get("name");
    const Json *pid = value.get("pid");
    const Json *path = value.get("path");
    const Json *launched = value.get("launchedAt");
    if (!id || !name || !pid || !path || !launched || id->kind != Json::Kind::String || name->kind != Json::Kind::String
        || path->kind != Json::Kind::String || !valid_id(id->text) || !bounded_text(name->text, 256, false)
        || !bounded_text(path->text, 4096, false, &identity->wide_path) || !absolute_windows_path(identity->wide_path)
        || !finite_integer(pid, 1, INT_MAX, &identity->pid) || !finite_positive(launched)) return false;
    identity->wide_path = normalized_windows_path(identity->wide_path);
    if (identity->wide_path.empty() || identity_id(identity->wide_path) != id->text
        || emma_owned(emma_files(blocked_pid), identity->pid, identity->wide_path)) return false;
    identity->id = id->text;
    identity->name = name->text;
    identity->path = path->text;
    identity->launched_at = launched->number;
    return true;
}

static bool same_identity(const IdentityData &left, const IdentityData &right) {
    return left.pid == right.pid && left.id == right.id
        && _stricmp(left.name.c_str(), right.name.c_str()) == 0 && left.wide_path == right.wide_path
        && std::abs(left.launched_at - right.launched_at) <= 0.001;
}

static bool valid_bounds(double x, double y, double width, double height) {
    return std::isfinite(x) && std::isfinite(y) && std::isfinite(width) && std::isfinite(height)
        && std::abs(x) <= 100000 && std::abs(y) <= 100000 && width > 0 && width <= 16384
        && height > 0 && height <= 16384 && std::abs(x + width) <= 100000 && std::abs(y + height) <= 100000;
}

struct Bounds {
    double x = 0;
    double y = 0;
    double width = 0;
    double height = 0;
};

static std::optional<Bounds> clipped_bounds(Bounds control, Bounds window) {
    if (!valid_bounds(control.x, control.y, control.width, control.height)
        || !valid_bounds(window.x, window.y, window.width, window.height)) return std::nullopt;
    double left = std::max(control.x, window.x);
    double top = std::max(control.y, window.y);
    double right = std::min(control.x + control.width, window.x + window.width);
    double bottom = std::min(control.y + control.height, window.y + window.height);
    Bounds clipped{left, top, right - left, bottom - top};
    return valid_bounds(clipped.x, clipped.y, clipped.width, clipped.height) ? std::optional<Bounds>(clipped) : std::nullopt;
}

static Json failure(const std::string &message) {
    Json result = Json::object_value();
    result.set("ok", Json::boolean_value(false));
    result.set("error", Json::string_value(message));
    return result;
}

static Json success(const std::string &message) {
    Json result = Json::object_value();
    result.set("ok", Json::boolean_value(true));
    result.set("text", Json::string_value(message));
    return result;
}

static void write_result(const Json &result) {
    std::string encoded;
    append_json(result, &encoded);
    if (encoded.size() > 128 * 1024) encoded = "{\"ok\":false,\"error\":\"The app helper response exceeded its size limit\"}";
    std::cout.write(encoded.data(), static_cast<std::streamsize>(encoded.size()));
    std::cout.put('\n');
    std::cout.flush();
}

static void write_cursor(const Json &cursor) {
    Json event = Json::object_value();
    event.set("event", Json::string_value("cursor"));
    event.set("cursor", cursor);
    write_result(event);
}

static void write_cursor_invalidated() {
    Json event = Json::object_value();
    event.set("event", Json::string_value("cursor-invalidated"));
    write_result(event);
}

static std::string lowercase_ascii(std::string value) {
    for (char &byte : value) {
        if (byte >= 'A' && byte <= 'Z') byte = static_cast<char>(byte - 'A' + 'a');
    }
    return value;
}

static bool valid_snapshot(const std::string &value) {
    return !value.empty() && value.size() <= 64 && std::all_of(value.begin(), value.end(), [](unsigned char byte) {
        return (byte >= 'a' && byte <= 'z') || (byte >= 'A' && byte <= 'Z') || (byte >= '0' && byte <= '9') || byte == '-';
    });
}

static bool valid_key(const std::string &value, UINT *key) {
    static const std::map<std::string, UINT> keys{
        {"return", VK_RETURN}, {"enter", VK_RETURN}, {"tab", VK_TAB}, {"space", VK_SPACE},
        {"backspace", VK_BACK}, {"delete", VK_DELETE}, {"escape", VK_ESCAPE}, {"left", VK_LEFT},
        {"right", VK_RIGHT}, {"down", VK_DOWN}, {"up", VK_UP}, {"home", VK_HOME}, {"end", VK_END},
        {"pageup", VK_PRIOR}, {"pagedown", VK_NEXT}
    };
    auto found = keys.find(lowercase_ascii(value));
    if (found == keys.end()) return false;
    if (key) *key = found->second;
    return true;
}

static bool validate_action(const Json &value) {
    if (value.kind != Json::Kind::Object) return false;
    const Json *action = value.get("action");
    if (!action || action->kind != Json::Kind::String) return false;
    if (action->text == "get_app_state") return value.object.size() == 1;
    const Json *snapshot = value.get("snapshot");
    const Json *index = value.get("element_index");
    DWORD ignored = 0;
    if (!snapshot || snapshot->kind != Json::Kind::String || !valid_snapshot(snapshot->text)
        || !finite_integer(index, 0, static_cast<double>(max_elements - 1), &ignored)) return false;
    if (action->text == "click") return value.object.size() == 3;
    if (action->text == "set_value") {
        const Json *text = value.get("value");
        return value.object.size() == 4 && text && text->kind == Json::Kind::String && bounded_text(text->text, max_text_characters, true);
    }
    if (action->text == "type_text") {
        const Json *text = value.get("text");
        return value.object.size() == 4 && text && text->kind == Json::Kind::String && bounded_text(text->text, max_text_characters, false);
    }
    if (action->text == "key") {
        const Json *key = value.get("key");
        UINT ignored_key = 0;
        return value.object.size() == 4 && key && key->kind == Json::Kind::String && bounded_text(key->text, 32, false)
            && valid_key(key->text, &ignored_key);
    }
    if (action->text != "scroll") return false;
    const Json *direction = value.get("direction");
    const Json *amount = value.get("amount");
    return value.object.size() == 5 && direction && direction->kind == Json::Kind::String
        && (direction->text == "up" || direction->text == "down" || direction->text == "left" || direction->text == "right")
        && finite_integer(amount, 1, 10, &ignored);
}

static std::string role_name(CONTROLTYPEID type) {
    switch (type) {
    case UIA_ButtonControlTypeId: return "Button";
    case UIA_CheckBoxControlTypeId: return "CheckBox";
    case UIA_ComboBoxControlTypeId: return "ComboBox";
    case UIA_CustomControlTypeId: return "Custom";
    case UIA_DataGridControlTypeId: return "DataGrid";
    case UIA_DataItemControlTypeId: return "DataItem";
    case UIA_DocumentControlTypeId: return "Document";
    case UIA_EditControlTypeId: return "Edit";
    case UIA_GroupControlTypeId: return "Group";
    case UIA_HeaderControlTypeId: return "Header";
    case UIA_HeaderItemControlTypeId: return "HeaderItem";
    case UIA_HyperlinkControlTypeId: return "Hyperlink";
    case UIA_ImageControlTypeId: return "Image";
    case UIA_ListControlTypeId: return "List";
    case UIA_ListItemControlTypeId: return "ListItem";
    case UIA_MenuBarControlTypeId: return "MenuBar";
    case UIA_MenuControlTypeId: return "Menu";
    case UIA_MenuItemControlTypeId: return "MenuItem";
    case UIA_PaneControlTypeId: return "Pane";
    case UIA_ProgressBarControlTypeId: return "ProgressBar";
    case UIA_RadioButtonControlTypeId: return "RadioButton";
    case UIA_ScrollBarControlTypeId: return "ScrollBar";
    case UIA_SemanticZoomControlTypeId: return "SemanticZoom";
    case UIA_SeparatorControlTypeId: return "Separator";
    case UIA_SliderControlTypeId: return "Slider";
    case UIA_SpinnerControlTypeId: return "Spinner";
    case UIA_SplitButtonControlTypeId: return "SplitButton";
    case UIA_StatusBarControlTypeId: return "StatusBar";
    case UIA_TabControlTypeId: return "Tab";
    case UIA_TabItemControlTypeId: return "TabItem";
    case UIA_TableControlTypeId: return "Table";
    case UIA_TextControlTypeId: return "Text";
    case UIA_ThumbControlTypeId: return "Thumb";
    case UIA_TitleBarControlTypeId: return "TitleBar";
    case UIA_ToolBarControlTypeId: return "ToolBar";
    case UIA_ToolTipControlTypeId: return "ToolTip";
    case UIA_TreeControlTypeId: return "Tree";
    case UIA_TreeItemControlTypeId: return "TreeItem";
    case UIA_WindowControlTypeId: return "Window";
    default: return "Control";
    }
}

static std::wstring read_bstr(HRESULT result, BSTR value) {
    if (FAILED(result) || !value) {
        if (value) SysFreeString(value);
        return {};
    }
    UINT length = SysStringLen(value);
    std::wstring result_text = length <= max_input_bytes ? std::wstring(value, length) : std::wstring();
    SysFreeString(value);
    return result_text;
}

static std::wstring current_name(IUIAutomationElement *element) {
    BSTR value = nullptr;
    HRESULT result = element ? element->get_CurrentName(&value) : E_INVALIDARG;
    return read_bstr(result, value);
}

static std::wstring current_help(IUIAutomationElement *element) {
    BSTR value = nullptr;
    HRESULT result = element ? element->get_CurrentHelpText(&value) : E_INVALIDARG;
    return read_bstr(result, value);
}

static std::wstring current_automation_id(IUIAutomationElement *element) {
    BSTR value = nullptr;
    HRESULT result = element ? element->get_CurrentAutomationId(&value) : E_INVALIDARG;
    return read_bstr(result, value);
}

static std::wstring current_class_name(IUIAutomationElement *element) {
    BSTR value = nullptr;
    HRESULT result = element ? element->get_CurrentClassName(&value) : E_INVALIDARG;
    return read_bstr(result, value);
}

static bool current_process(IUIAutomationElement *element, DWORD *pid) {
    int value = 0;
    if (!element || FAILED(element->get_CurrentProcessId(&value)) || value <= 0) return false;
    *pid = static_cast<DWORD>(value);
    return true;
}

static bool current_control_type(IUIAutomationElement *element, CONTROLTYPEID *type) {
    return element && SUCCEEDED(element->get_CurrentControlType(type));
}

template <typename T>
static ComPtr<T> current_pattern(IUIAutomationElement *element, PATTERNID pattern_id) {
    ComPtr<IUnknown> unknown;
    ComPtr<T> pattern;
    if (!element || FAILED(element->GetCurrentPattern(pattern_id, unknown.put())) || !unknown
        || FAILED(unknown->QueryInterface(IID_PPV_ARGS(pattern.put())))) return {};
    return pattern;
}

static std::optional<std::wstring> current_value(IUIAutomationElement *element, IUIAutomationValuePattern *pattern = nullptr) {
    ComPtr<IUIAutomationValuePattern> owned;
    if (!pattern) {
        owned = current_pattern<IUIAutomationValuePattern>(element, UIA_ValuePatternId);
        pattern = owned.get();
    }
    if (!pattern) return std::nullopt;
    BSTR value = nullptr;
    HRESULT result = pattern->get_CurrentValue(&value);
    if (FAILED(result) || !value) {
        if (value) SysFreeString(value);
        return std::nullopt;
    }
    UINT length = SysStringLen(value);
    std::wstring result_text = length <= 65536 ? std::wstring(value, length) : std::wstring();
    SysFreeString(value);
    return length <= 65536 ? std::optional<std::wstring>(std::move(result_text)) : std::nullopt;
}

static Json element_identity(IUIAutomationElement *element) {
    CONTROLTYPEID type = 0;
    std::wstring name = current_name(element);
    std::wstring automation_id = current_automation_id(element);
    std::string role = current_control_type(element, &type) ? role_name(type) : "";
    std::string title = utf8_prefix(name, 960);
    std::string identifier = utf8_prefix(automation_id, 1024);
    std::string subrole = utf8_prefix(current_class_name(element), 1024);
    Json result = Json::object_value();
    result.set("role", Json::string_value(role));
    result.set("subrole", Json::string_value(subrole));
    result.set("title", Json::string_value(title));
    result.set("identifier", Json::string_value(identifier));
    return result;
}

static bool pressable(IUIAutomationElement *element) {
    return current_pattern<IUIAutomationInvokePattern>(element, UIA_InvokePatternId)
        || current_pattern<IUIAutomationTogglePattern>(element, UIA_TogglePatternId)
        || current_pattern<IUIAutomationSelectionItemPattern>(element, UIA_SelectionItemPatternId);
}

static bool excluded_element(IUIAutomationElement *element) {
    CONTROLTYPEID type = 0;
    BOOL password = FALSE;
    if (!element || !current_control_type(element, &type) || FAILED(element->get_CurrentIsPassword(&password))) return true;
    if (password || type == UIA_MenuBarControlTypeId || type == UIA_MenuControlTypeId || type == UIA_MenuItemControlTypeId
        || type == UIA_TitleBarControlTypeId) return true;
    std::wstring class_name = current_class_name(element);
    return _wcsicmp(class_name.c_str(), L"#32768") == 0 || _wcsicmp(class_name.c_str(), L"#32769") == 0
        || _wcsicmp(class_name.c_str(), L"Shell_TrayWnd") == 0 || _wcsicmp(class_name.c_str(), L"WorkerW") == 0
        || _wcsicmp(class_name.c_str(), L"Progman") == 0;
}

static bool element_bounds(IUIAutomationElement *element, Bounds *bounds) {
    RECT rectangle{};
    if (!element || FAILED(element->get_CurrentBoundingRectangle(&rectangle))) return false;
    bounds->x = rectangle.left;
    bounds->y = rectangle.top;
    bounds->width = static_cast<double>(rectangle.right) - rectangle.left;
    bounds->height = static_cast<double>(rectangle.bottom) - rectangle.top;
    return valid_bounds(bounds->x, bounds->y, bounds->width, bounds->height);
}

static bool insert_text(const std::wstring &value, size_t start, size_t length, const std::wstring &text, std::wstring *result) {
    if (start > value.size() || length > value.size() - start || value.size() - length + text.size() > 65536) return false;
    size_t end = start + length;
    if ((start && start < value.size() && value[start] >= 0xdc00 && value[start] <= 0xdfff)
        || (end && end < value.size() && value[end] >= 0xdc00 && value[end] <= 0xdfff)) return false;
    *result = value.substr(0, start) + text + value.substr(end);
    return true;
}

static HRESULT set_pattern_value(IUIAutomationValuePattern *pattern, const std::wstring &value) {
    if (!pattern || value.size() > std::numeric_limits<UINT>::max()) return E_INVALIDARG;
    BSTR encoded = SysAllocStringLen(value.data(), static_cast<UINT>(value.size()));
    if (!encoded && value.empty()) encoded = SysAllocString(L"");
    if (!encoded) return E_OUTOFMEMORY;
    HRESULT result = pattern->SetValue(encoded);
    SysFreeString(encoded);
    return result;
}

static bool selected_offsets(IUIAutomationElement *element, const std::wstring &value, size_t *start, size_t *length) {
    ComPtr<IUIAutomationTextPattern> text_pattern = current_pattern<IUIAutomationTextPattern>(element, UIA_TextPatternId);
    if (!text_pattern) return false;
    ComPtr<IUIAutomationTextRangeArray> selection;
    if (FAILED(text_pattern->GetSelection(selection.put())) || !selection) return false;
    int count = 0;
    bool valid = SUCCEEDED(selection->get_Length(&count)) && count == 1;
    ComPtr<IUIAutomationTextRange> range;
    if (valid) {
        valid = SUCCEEDED(selection->GetElement(0, range.put())) && range;
    }
    if (!valid || !range) return false;
    ComPtr<IUIAutomationTextRange> document;
    ComPtr<IUIAutomationTextRange> prefix;
    if (FAILED(text_pattern->get_DocumentRange(document.put())) || !document
        || FAILED(document->Clone(prefix.put())) || !prefix
        || FAILED(prefix->MoveEndpointByRange(TextPatternRangeEndpoint_End, range.get(), TextPatternRangeEndpoint_Start))) return false;
    BSTR prefix_text = nullptr;
    BSTR selected_text = nullptr;
    valid = SUCCEEDED(prefix->GetText(-1, &prefix_text)) && SUCCEEDED(range->GetText(-1, &selected_text));
    if (!valid || !prefix_text || !selected_text) {
        if (prefix_text) SysFreeString(prefix_text);
        if (selected_text) SysFreeString(selected_text);
        return false;
    }
    UINT prefix_length = SysStringLen(prefix_text);
    UINT selected_length = SysStringLen(selected_text);
    if (prefix_length > max_input_bytes || selected_length > max_input_bytes) {
        SysFreeString(prefix_text);
        SysFreeString(selected_text);
        return false;
    }
    std::wstring prefix_value(prefix_text, prefix_length);
    std::wstring selected_value(selected_text, selected_length);
    SysFreeString(prefix_text);
    SysFreeString(selected_text);
    if (prefix_value.size() > value.size() || selected_value.size() > value.size() - prefix_value.size()
        || value.compare(prefix_value.size(), selected_value.size(), selected_value) != 0) return false;
    *start = prefix_value.size();
    *length = selected_value.size();
    return true;
}

class AppSession {
public:
    AppSession(const IdentityData &identity, DWORD blocked_pid, IUIAutomation *automation)
        : identity_(identity), automation_(automation) {
        if (!automation_ || emma_owned(emma_files(blocked_pid), identity_.pid, identity_.wide_path)) return;
        WindowList windows = windows_for_process(identity_.pid);
        if (windows.windows.empty()) return;
        if (FAILED(automation_->get_ControlViewWalker(walker_.put())) || !walker_) return;
        for (const auto &window : windows.windows) {
            ComPtr<IUIAutomationElement> root;
            DWORD pid = 0;
            if (FAILED(automation_->ElementFromHandle(window.first, root.put())) || !root
                || !current_process(root.get(), &pid) || pid != identity_.pid) continue;
            windows_.push_back(window.first);
            roots_.push_back(std::move(root));
        }
        if (roots_.empty()) return;
        auto actual = process_identity(identity_.pid);
        if (!actual || !same_identity(identity_, *actual)) return;
        valid_ = true;
    }

    bool valid() const {
        return valid_;
    }

    Json handle(const Json &request) {
        cursor_announced_ = false;
        cursor_ = Json::null();
        cursor_element_.reset();
        Json result = perform(request);
        if (cursor_announced_ && cursor_.kind != Json::Kind::Null
            && (!valid_application() || cursor_for_element(cursor_element_.get()) != cursor_)) write_cursor_invalidated();
        cursor_announced_ = false;
        cursor_ = Json::null();
        cursor_element_.reset();
        return result;
    }

private:
    bool valid_application() const {
        if (InterlockedCompareExchange(&cancelled, 0, 0) != 0) return false;
        bool window_alive = false;
        for (HWND window : windows_) {
            DWORD pid = 0;
            if (IsWindow(window) && GetWindowThreadProcessId(window, &pid) && pid == identity_.pid) {
                window_alive = true;
                break;
            }
        }
        if (!window_alive) return false;
        auto actual = process_identity(identity_.pid);
        return actual && same_identity(identity_, *actual);
    }

    bool approved_window(HWND window) const {
        if (!window || !IsWindow(window)) return false;
        DWORD pid = 0;
        if (!GetWindowThreadProcessId(window, &pid) || pid != identity_.pid) return false;
        return std::find(windows_.begin(), windows_.end(), window) != windows_.end();
    }

    HWND window_for_element(IUIAutomationElement *element) const {
        if (!element || !automation_ || !walker_) return nullptr;
        ComPtr<IUIAutomationElement> current(element);
        for (size_t depth = 0; current && depth < 32; depth += 1) {
            for (size_t index = 0; index < roots_.size() && index < windows_.size(); index += 1) {
                BOOL same = FALSE;
                if (FAILED(automation_->CompareElements(current.get(), roots_[index].get(), &same))) return nullptr;
                if (same) return windows_[index];
            }
            ComPtr<IUIAutomationElement> parent;
            if (FAILED(walker_->GetParentElement(current.get(), parent.put())) || !parent) return nullptr;
            current = std::move(parent);
        }
        return nullptr;
    }

    bool allowed_element(IUIAutomationElement *element) const {
        if (!element || !automation_ || !walker_) return false;
        ComPtr<IUIAutomationElement> current(element);
        for (size_t depth = 0; current && depth < 32; depth += 1) {
            if (operation_deadline != 0 && !within_deadline()) return false;
            DWORD pid = 0;
            if (!current_process(current.get(), &pid) || pid != identity_.pid || excluded_element(current.get())) return false;
            for (const auto &root : roots_) {
                BOOL same = FALSE;
                if (FAILED(automation_->CompareElements(current.get(), root.get(), &same))) return false;
                if (same) return true;
            }
            ComPtr<IUIAutomationElement> parent;
            if (FAILED(walker_->GetParentElement(current.get(), parent.put())) || !parent) return false;
            current = std::move(parent);
        }
        return false;
    }

    Json perform(const Json &request) {
        operation_deadline = GetTickCount64() + operation_lifetime_ms;
        if (!validate_action(request)) return failure("Invalid app action or unsupported fields.");
        if (!valid_application()) return failure("The approved app has closed or changed. Open it and request approval again.");
        const Json *action = request.get("action");
        if (action->text == "get_app_state") return state();
        const Json *snapshot = request.get("snapshot");
        const Json *element_index = request.get("element_index");
        DWORD index = 0;
        finite_integer(element_index, 0, static_cast<double>(max_elements - 1), &index);
        bool valid_snapshot_value = snapshot_ == snapshot->text && valid_snapshot(snapshot_) && GetTickCount64() - snapshot_at_ <= snapshot_lifetime_ms
            && index < elements_.size();
        snapshot_.clear();
        if (!valid_snapshot_value) return failure("The app snapshot is stale or already used. Get app state again before acting.");
        IUIAutomationElement *element = elements_[index].get();
        if (!allowed_element(element) || element_identity(element) != identities_[index]) return failure("The selected control changed or is protected. Get app state again.");
        BOOL enabled = TRUE;
        if (FAILED(element->get_CurrentIsEnabled(&enabled)) || !enabled) return failure("The selected control is disabled.");
        if (action->text == "click") return click(element);
        if (action->text == "set_value") return set_value(element, request.get("value")->text);
        if (action->text == "type_text") return type_text(element, request.get("text")->text);
        if (action->text == "key") return key(element, request.get("key")->text);
        return scroll(element, request.get("direction")->text, static_cast<int>(request.get("amount")->number));
    }

    Json state() {
        snapshot_.clear();
        elements_.clear();
        identities_.clear();
        std::string text = "App: " + identity_.name + " (" + identity_.id + "). Background accessibility controls only.\n";
        truncated_ = false;
        for (const auto &root : roots_) {
            append_element(root.get(), 0, &text);
            if (truncated_) break;
        }
        if (!valid_application()) return failure("The approved app has closed or changed. Open it and request approval again.");
        if (InterlockedCompareExchange(&cancelled, 0, 0) != 0) return failure("App control was stopped.");
        if (elements_.size() <= 1) return failure("The app exposes no accessible controls. Open its window first. Emma will not activate it or use global input.");
        snapshot_ = make_snapshot();
        snapshot_at_ = GetTickCount64();
        if (!within_deadline() || elements_.size() >= max_elements || truncated_) text.append("State is truncated by the time, size, or element limit.\n");
        text.append("Snapshot: " + snapshot_ + ". Use this snapshot and an element_index for one action, then get_app_state again. Menus and secure controls are omitted.\n");
        Json result = Json::object_value();
        result.set("ok", Json::boolean_value(true));
        result.set("snapshot", Json::string_value(snapshot_));
        result.set("text", Json::string_value(text));
        return result;
    }

    void append_element(IUIAutomationElement *element, size_t depth, std::string *text) {
        if (!within_deadline() || depth > 18 || elements_.size() >= max_elements || truncated_ || !allowed_element(element)) {
            if (elements_.size() >= max_elements || !within_deadline()) truncated_ = true;
            return;
        }
        Json identity = element_identity(element);
        const Json *role = identity.get("role");
        if (!role || role->kind != Json::Kind::String || role->text.empty()) return;
        std::string line(depth > 10 ? 20 : depth * 2, ' ');
        line.append("[");
        line.append(std::to_string(elements_.size()));
        line.append("] ");
        line.append(role->text);
        const Json *title = identity.get("title");
        std::wstring help = current_help(element);
        std::wstring value;
        ComPtr<IUIAutomationValuePattern> value_pattern = current_pattern<IUIAutomationValuePattern>(element, UIA_ValuePatternId);
        if (value_pattern) {
            auto current = current_value(element, value_pattern.get());
            if (current) value = *current;
        }
        std::string encoded;
        if (title && title->kind == Json::Kind::String && !title->text.empty()) line.append(" title=" + json_string(title->text));
        encoded = utf8_prefix(help, 960);
        if (!encoded.empty() && (!title || encoded != title->text)) line.append(" description=" + json_string(encoded));
        encoded = utf8_prefix(value, 960);
        if (!encoded.empty()) line.append(" value=" + json_string(encoded));
        BOOL enabled = TRUE;
        BOOL focused = FALSE;
        if (SUCCEEDED(element->get_CurrentIsEnabled(&enabled)) && !enabled) line.append(" disabled");
        if (SUCCEEDED(element->get_CurrentHasKeyboardFocus(&focused)) && focused) line.append(" focused");
        if (pressable(element)) line.append(" clickable");
        BOOL read_only = TRUE;
        if (value_pattern && SUCCEEDED(value_pattern->get_CurrentIsReadOnly(&read_only)) && !read_only) line.append(" editable_value");
        line.push_back('\n');
        if (text->size() + line.size() > max_state_bytes) {
            truncated_ = true;
            return;
        }
        elements_.emplace_back(element);
        identities_.push_back(identity);
        text->append(line);
        ComPtr<IUIAutomationElement> child;
        if (FAILED(walker_->GetFirstChildElement(element, child.put())) || !child) return;
        while (child && within_deadline() && elements_.size() < max_elements && !truncated_) {
            append_element(child.get(), depth + 1, text);
            ComPtr<IUIAutomationElement> next;
            if (FAILED(walker_->GetNextSiblingElement(child.get(), next.put()))) break;
            child = std::move(next);
        }
        if (elements_.size() >= max_elements) truncated_ = true;
    }

    std::string make_snapshot() const {
        static std::atomic<uint64_t> sequence{0};
        std::ostringstream token;
        token << std::hex << GetTickCount64() << '-' << identity_.pid << '-' << sequence.fetch_add(1, std::memory_order_relaxed);
        return token.str();
    }

    Json cursor_for_element(IUIAutomationElement *element) const {
        if (!element || !within_deadline() || !allowed_element(element)) return Json::null();
        UIA_HWND native_handle = 0;
        HWND native = SUCCEEDED(element->get_CurrentNativeWindowHandle(&native_handle)) && native_handle
            ? reinterpret_cast<HWND>(native_handle) : window_for_element(element);
        HWND window = GetAncestor(native, GA_ROOT);
        if (!window || !IsWindowVisible(window) || IsIconic(window) || excluded_window_class(window)) return Json::null();
        DWORD pid = 0;
        if (GetWindowThreadProcessId(window, &pid) == 0 || pid != identity_.pid || !approved_window(window)) return Json::null();
        UINT_PTR window_id = reinterpret_cast<UINT_PTR>(window);
        if (!window_id || window_id > 0xffffffffu) return Json::null();
        RECT frame{};
        if (!GetWindowRect(window, &frame)) return Json::null();
        Bounds control{};
        Bounds window_bounds{static_cast<double>(frame.left), static_cast<double>(frame.top), static_cast<double>(frame.right) - frame.left, static_cast<double>(frame.bottom) - frame.top};
        if (!element_bounds(element, &control)) return Json::null();
        auto clipped = clipped_bounds(control, window_bounds);
        if (!clipped) return Json::null();
        HMONITOR monitor = MonitorFromWindow(window, MONITOR_DEFAULTTONEAREST);
        MONITORINFO monitor_info{};
        monitor_info.cbSize = sizeof(monitor_info);
        if (!monitor || !GetMonitorInfoW(monitor, &monitor_info)) return Json::null();
        Bounds display{static_cast<double>(monitor_info.rcMonitor.left), static_cast<double>(monitor_info.rcMonitor.top),
            static_cast<double>(monitor_info.rcMonitor.right) - monitor_info.rcMonitor.left,
            static_cast<double>(monitor_info.rcMonitor.bottom) - monitor_info.rcMonitor.top};
        clipped = clipped_bounds(*clipped, display);
        if (!clipped || !within_deadline()) return Json::null();
        double x = clipped->x + clipped->width / 2;
        double y = clipped->y + clipped->height / 2;
        if (!(x > clipped->x && x < clipped->x + clipped->width && y > clipped->y && y < clipped->y + clipped->height)) return Json::null();
        Json result = Json::object_value();
        result.set("windowId", Json::number_value(static_cast<double>(window_id)));
        Json bounds = Json::object_value();
        bounds.set("x", Json::number_value(window_bounds.x));
        bounds.set("y", Json::number_value(window_bounds.y));
        bounds.set("width", Json::number_value(window_bounds.width));
        bounds.set("height", Json::number_value(window_bounds.height));
        result.set("bounds", std::move(bounds));
        result.set("x", Json::number_value(x));
        result.set("y", Json::number_value(y));
        return result;
    }

    void announce_cursor(IUIAutomationElement *element) {
        cursor_ = cursor_for_element(element);
        cursor_element_ = ComPtr<IUIAutomationElement>(element);
        cursor_announced_ = true;
        write_cursor(cursor_);
    }

    Json mutation_result(HRESULT result, const std::string &unsupported) const {
        if (SUCCEEDED(result)) return success("The app accepted the action. Get app state again to verify its effect.");
        if (result == static_cast<HRESULT>(UIA_E_ELEMENTNOTAVAILABLE)) return failure("The control no longer exists. Get app state again.");
        return failure(unsupported);
    }

    Json click(IUIAutomationElement *element) {
        ComPtr<IUIAutomationInvokePattern> invoke = current_pattern<IUIAutomationInvokePattern>(element, UIA_InvokePatternId);
        ComPtr<IUIAutomationTogglePattern> toggle;
        ComPtr<IUIAutomationSelectionItemPattern> select;
        if (!invoke) toggle = current_pattern<IUIAutomationTogglePattern>(element, UIA_TogglePatternId);
        if (!invoke && !toggle) select = current_pattern<IUIAutomationSelectionItemPattern>(element, UIA_SelectionItemPatternId);
        if (!invoke && !toggle && !select) return failure("This control does not expose a background press action. No mouse fallback was used.");
        if (!valid_application() || !allowed_element(element) || !within_deadline()) return failure("The approved app or control changed. Get app state again.");
        announce_cursor(element);
        if (!valid_application() || !allowed_element(element) || !within_deadline()) return failure("The approved app or control changed. Get app state again.");
        HRESULT result = invoke ? invoke->Invoke() : toggle ? toggle->Toggle() : select->Select();
        return mutation_result(result, "This control does not support background activation. No foreground or global-input fallback was used.");
    }

    Json set_value(IUIAutomationElement *element, const std::string &encoded_value) {
        std::wstring value;
        if (!bounded_text(encoded_value, max_text_characters, true, &value)) return failure("The value is invalid.");
        ComPtr<IUIAutomationValuePattern> pattern = current_pattern<IUIAutomationValuePattern>(element, UIA_ValuePatternId);
        BOOL read_only = TRUE;
        if (!pattern || FAILED(pattern->get_CurrentIsReadOnly(&read_only)) || read_only) return failure("This control's value cannot be set through UI Automation. No keyboard fallback was used.");
        if (!valid_application() || !allowed_element(element) || !within_deadline()) return failure("The approved app or control changed. Get app state again.");
        announce_cursor(element);
        if (!valid_application() || !allowed_element(element) || !within_deadline()) return failure("The approved app or control changed. Get app state again.");
        HRESULT result = set_pattern_value(pattern.get(), value);
        if (FAILED(result)) return mutation_result(result, "This control does not support the requested background value change. No keyboard fallback was used.");
        auto actual = current_value(element, pattern.get());
        if (!actual || *actual != value) return failure("The app accepted a value change, but its resulting text could not be verified. Get app state; do not retry automatically.");
        return success("The control's text was changed and its value was verified. Get app state again before another action.");
    }

    Json type_text(IUIAutomationElement *element, const std::string &encoded_text) {
        CONTROLTYPEID type = 0;
        if (!current_control_type(element, &type) || (type != UIA_EditControlTypeId && type != UIA_ComboBoxControlTypeId)) return failure("Background text insertion is limited to plain edit controls and combo boxes. Use set_value when replacing the entire value is intended.");
        std::wstring text;
        if (!bounded_text(encoded_text, max_text_characters, false, &text)) return failure("The text is invalid.");
        ComPtr<IUIAutomationValuePattern> pattern = current_pattern<IUIAutomationValuePattern>(element, UIA_ValuePatternId);
        if (!pattern) return failure("This control does not expose a writable text value. Use set_value when supported.");
        BOOL read_only = TRUE;
        auto current = current_value(element, pattern.get());
        if (FAILED(pattern->get_CurrentIsReadOnly(&read_only)) || read_only || !current) return failure("This control does not expose a writable text value. Use set_value when supported.");
        size_t start = 0;
        size_t length = 0;
        std::wstring updated;
        if (!selected_offsets(element, *current, &start, &length) || !insert_text(*current, start, length, text, &updated)) return failure("The text selection is invalid or the resulting value would exceed 65,536 characters.");
        if (!valid_application() || !allowed_element(element) || !within_deadline()) return failure("The approved app or control changed. Get app state again.");
        announce_cursor(element);
        if (!valid_application() || !allowed_element(element) || !within_deadline()) return failure("The approved app or control changed. Get app state again.");
        HRESULT result = set_pattern_value(pattern.get(), updated);
        if (FAILED(result)) return mutation_result(result, "This control does not support background text insertion. No keyboard fallback was used.");
        auto actual = current_value(element, pattern.get());
        if (!actual || *actual != updated) return failure("The app accepted text insertion, but its resulting text could not be verified. Get app state; do not retry automatically.");
        return success("Text insertion was applied and its resulting value was verified. Get app state again before another action.");
    }

    Json key(IUIAutomationElement *element, const std::string &name) {
        UINT virtual_key = 0;
        if (!valid_key(name, &virtual_key)) return failure("The key is not supported. Use one named nonmodifier key; no global shortcut fallback was used.");
        BOOL focused = FALSE;
        if (FAILED(element->get_CurrentHasKeyboardFocus(&focused)) || !focused) return failure("Key input requires the app's already-focused control. Emma will not activate or focus the app.");
        UIA_HWND native_handle = 0;
        HWND target = SUCCEEDED(element->get_CurrentNativeWindowHandle(&native_handle)) && native_handle
            ? reinterpret_cast<HWND>(native_handle) : window_for_element(element);
        DWORD pid = 0;
        HWND window = target ? GetAncestor(target, GA_ROOT) : nullptr;
        if (!target || GetWindowThreadProcessId(target, &pid) == 0 || pid != identity_.pid || !approved_window(window)) return failure("The focused control has no safe app-owned window target. No global input was sent.");
        if (!valid_application() || !allowed_element(element) || !within_deadline()) return failure("The approved app or focused control changed. Get app state again.");
        announce_cursor(element);
        if (!valid_application() || !allowed_element(element) || !within_deadline()) return failure("The approved app or focused control changed. Get app state again.");
        UINT scan_code = MapVirtualKeyW(virtual_key, MAPVK_VK_TO_VSC);
        if (!scan_code) return failure("The key has no supported Windows scan code. No input was sent.");
        bool extended = virtual_key == VK_DELETE || virtual_key == VK_LEFT || virtual_key == VK_RIGHT || virtual_key == VK_UP
            || virtual_key == VK_DOWN || virtual_key == VK_HOME || virtual_key == VK_END || virtual_key == VK_PRIOR || virtual_key == VK_NEXT;
        LPARAM down = 1 | (static_cast<LPARAM>(scan_code) << 16) | (extended ? static_cast<LPARAM>(1) << 24 : 0);
        LPARAM up = down | (1LL << 30) | (1LL << 31);
        if (!PostMessageW(target, WM_KEYDOWN, virtual_key, down) || !PostMessageW(target, WM_KEYUP, virtual_key, up)) return failure("The key may already have been queued, but the approved app control did not accept the complete key event. Get app state before considering another action; no global input or activation fallback was used.");
        return success("The key was queued only to the approved app control. Delivery and handling are not confirmed; get app state before another action.");
    }

    Json scroll(IUIAutomationElement *element, const std::string &direction, int amount) {
        ComPtr<IUIAutomationElement> current(element);
        ComPtr<IUIAutomationScrollPattern> pattern;
        bool horizontal = direction == "left" || direction == "right";
        bool increasing = direction == "down" || direction == "right";
        for (size_t depth = 0; current && depth < 32 && within_deadline(); depth += 1) {
            ComPtr<IUIAutomationScrollPattern> candidate = current_pattern<IUIAutomationScrollPattern>(current.get(), UIA_ScrollPatternId);
            if (candidate) {
                BOOL can_horizontal = FALSE;
                BOOL can_vertical = FALSE;
                if (SUCCEEDED(candidate->get_CurrentHorizontallyScrollable(&can_horizontal))
                    && SUCCEEDED(candidate->get_CurrentVerticallyScrollable(&can_vertical))
                    && (horizontal ? can_horizontal : can_vertical)) {
                    pattern = std::move(candidate);
                    break;
                }
            }
            ComPtr<IUIAutomationElement> parent;
            if (FAILED(walker_->GetParentElement(current.get(), parent.put()))) break;
            current = std::move(parent);
        }
        if (!pattern || !allowed_element(current.get())) return failure("Choose an accessible scroll area. This control has no supported background scrollbar.");
        BOOL can_horizontal = FALSE;
        BOOL can_vertical = FALSE;
        if (FAILED(pattern->get_CurrentHorizontallyScrollable(&can_horizontal)) || FAILED(pattern->get_CurrentVerticallyScrollable(&can_vertical))
            || (horizontal ? !can_horizontal : !can_vertical)) return failure("The app does not expose a writable scrollbar. No mouse or global-input fallback was used.");
        if (!valid_application() || !allowed_element(element) || !within_deadline()) return failure("The approved app or scrollbar changed. Get app state again.");
        announce_cursor(element);
        if (!valid_application() || !allowed_element(current.get()) || !within_deadline()) return failure("The approved app or scrollbar changed. Get app state again.");
        double position = 0;
        HRESULT read = horizontal ? pattern->get_CurrentHorizontalScrollPercent(&position) : pattern->get_CurrentVerticalScrollPercent(&position);
        if (FAILED(read) || !std::isfinite(position) || position < 0) return failure("The app does not report a scroll position. No mouse or global-input fallback was used.");
        double next = std::clamp(position + (increasing ? 1 : -1) * amount * 10.0, 0.0, 100.0);
        HRESULT result = pattern->SetScrollPercent(horizontal ? next : UIA_ScrollPatternNoScroll, horizontal ? UIA_ScrollPatternNoScroll : next);
        return mutation_result(result, "This control does not support the requested background scroll. No mouse or global-input fallback was used.");
    }

    IdentityData identity_;
    ComPtr<IUIAutomation> automation_;
    ComPtr<IUIAutomationTreeWalker> walker_;
    std::vector<HWND> windows_;
    bool valid_ = false;
    std::vector<ComPtr<IUIAutomationElement>> roots_;
    std::vector<ComPtr<IUIAutomationElement>> elements_;
    std::vector<Json> identities_;
    std::string snapshot_;
    ULONGLONG snapshot_at_ = 0;
    bool truncated_ = false;
    bool cursor_announced_ = false;
    Json cursor_;
    ComPtr<IUIAutomationElement> cursor_element_;
};

static DWORD default_blocked_pid() {
    DWORD current = GetCurrentProcessId();
    ParentMap parents = process_parents();
    auto found = parents.find(current);
    return found == parents.end() || !found->second ? current : found->second;
}

static bool parse_pid(const wchar_t *value, DWORD *pid) {
    if (!value || !*value) return false;
    wchar_t *end = nullptr;
    unsigned long parsed = std::wcstoul(value, &end, 10);
    if (!end || *end || parsed == 0 || parsed > INT_MAX) return false;
    *pid = static_cast<DWORD>(parsed);
    return true;
}

static bool read_line(std::string *line, bool *too_large) {
    line->clear();
    *too_large = false;
    char byte = 0;
    while (std::cin.get(byte)) {
        if (byte == '\n') {
            if (!line->empty() && line->back() == '\r') line->pop_back();
            return true;
        }
        if (line->size() <= max_input_bytes) line->push_back(byte);
        else *too_large = true;
    }
    return !line->empty() || *too_large;
}

static bool self_test() {
    if (!valid_bounds(-100, 20, 200, 100) || valid_bounds(0, 0, 0, 100) || valid_bounds(0, 0, 16385, 100)
        || valid_bounds(NAN, 0, 100, 100)) return false;
    auto clipped = clipped_bounds(Bounds{-20, 80, 200, 40}, Bounds{0, 20, 100, 120});
    if (!clipped || clipped->x != 0 || clipped->y != 80 || clipped->width != 100 || clipped->height != 40) return false;
    std::wstring inserted;
    const std::wstring emoji{0xd83d, 0xde00};
    if (!insert_text(L"abcd", 1, 2, emoji, &inserted) || inserted != L"a" + emoji + L"d"
        || insert_text(L"a" + emoji + L"b", 2, 0, L"x", &inserted)) return false;
    if (valid_id("_bad") || !valid_id("com.example.Editor") || !valid_snapshot("snapshot-1") || valid_snapshot("../bad")) return false;
    Json parsed;
    if (!JsonParser(R"({"action":"click","snapshot":"snapshot","element_index":0})").parse(&parsed) || !validate_action(parsed)) return false;
    if (JsonParser(R"({"action":"click","snapshot":"snapshot","element_index":true})").parse(&parsed) && validate_action(parsed)) return false;
    if (!valid_key("Return", nullptr) || valid_key("cmd+tab", nullptr)) return false;
    std::wstring wide;
    if (!utf8_to_wide("hello \xf0\x9f\x98\x80", &wide) || wide.size() != 8 || utf8_to_wide("\x80", &wide)) return false;
    if (!absolute_windows_path(L"C:\\Windows\\notepad.exe") || !absolute_windows_path(L"\\\\server\\share\\app.exe")
        || absolute_windows_path(L"relative.exe")) return false;
    const std::wstring spaced_path = normalized_windows_path(L"C:\\Program Files\\Emma Suite\\Éxé.exe");
    const std::wstring equivalent_path = normalized_windows_path(L"c:/program files/Emma Suite/ÉXÉ.EXE");
    const std::wstring other_path = normalized_windows_path(L"C:\\Program Files\\Emma Suite\\Other.exe");
    const std::string spaced_id = identity_id(spaced_path);
    if (spaced_path.empty() || spaced_path != equivalent_path || spaced_id != identity_id(equivalent_path)
        || spaced_id == identity_id(other_path) || !valid_id(spaced_id)
        || !std::all_of(spaced_id.begin(), spaced_id.end(), [](unsigned char byte) { return byte < 128; })) return false;
    EmmaFiles emma;
    emma.blocked_pid = 42;
    emma.helper_directory = normalized_windows_path(L"C:\\Program Files\\Emma\\resources\\dist-native");
    emma.app_directory = normalized_windows_path(L"C:\\Program Files\\Emma");
    if (!emma_owned(emma, 7, normalized_windows_path(L"C:\\Program Files\\Emma\\Emma.exe"))
        || !emma_owned(emma, 7, normalized_windows_path(L"C:\\Program Files\\Emma\\resources\\dist-native\\emma-computer.exe"))
        || !emma_owned(emma, 42, normalized_windows_path(L"C:\\Windows\\System32\\notepad.exe"))
        || !emma_owned(emma, 7, normalized_windows_path(L"C:\\Users\\a\\AppData\\Local\\emma-cli.exe"))
        || emma_owned(emma, 7, normalized_windows_path(L"C:\\Windows\\System32\\notepad.exe"))
        || emma_owned(emma, 7, normalized_windows_path(L"C:\\Program Files\\Emmanuel\\Emmanuel.exe"))
        || emma_owned(emma, 7, normalized_windows_path(L"C:\\Program Files\\Google\\Chrome\\chrome.exe"))) return false;
    if (containing_directory(L"C:\\a\\b.exe") != L"C:\\a" || !containing_directory(L"b.exe").empty()) return false;
    if (!resolvable_app_name(L"Notepad") || resolvable_app_name(L"C:\\Windows\\notepad.exe")
        || resolvable_app_name(L"") || resolvable_app_name(std::wstring(129, L'a'))
        || !resolvable_app_name(L"Google Chrome")) return false;
    return true;
}

int wmain(int argc, wchar_t **argv) {
    _setmode(_fileno(stdin), _O_BINARY);
    _setmode(_fileno(stdout), _O_BINARY);
    SetConsoleCtrlHandler(console_handler, TRUE);
    const bool resolving = argc == 3 && std::wcscmp(argv[1], L"--resolve") == 0;
    const bool launching = argc == 3 && std::wcscmp(argv[1], L"--launch") == 0;
    HRESULT com_result = CoInitializeEx(nullptr, resolving || launching ? COINIT_APARTMENTTHREADED : COINIT_MULTITHREADED);
    bool uninitialize = SUCCEEDED(com_result);
    auto finish = [uninitialize]() {
        if (uninitialize) CoUninitialize();
    };
    if (argc == 2 && std::wcscmp(argv[1], L"--self-test") == 0) {
        bool passed = self_test();
        if (passed) write_result(success("App control self-test passed."));
        else write_result(failure("App control self-test failed."));
        finish();
        return passed ? 0 : 1;
    }
    if (resolving || launching) {
        const std::optional<LaunchTarget> target = resolve_app(std::wstring(argv[2]));
        std::string target_name;
        std::string target_value;
        if (!target || !wide_to_utf8(target->name, &target_name) || !wide_to_utf8(target->target, &target_value)) {
            write_result(failure("No installed app matches that name. Ask the user which app to open."));
            finish();
            return 1;
        }
        if (emma_binary_name(target->target) || same_app_name(target->name, L"Emma")) {
            write_result(failure("Emma cannot start itself."));
            finish();
            return 1;
        }
        Json described = Json::object_value();
        described.set("name", Json::string_value(target_name));
        described.set("target", Json::string_value(target_value));
        Json result = Json::object_value();
        result.set("ok", Json::boolean_value(true));
        if (resolving) {
            result.set("app", std::move(described));
            write_result(result);
            finish();
            return 0;
        }
        const std::map<DWORD, IdentityData> before = windowed_processes({});
        DWORD launched = 0;
        if (!(target->packaged ? launch_packaged_app(target->target, &launched) : launch_executable(target->target, &launched))) {
            write_result(failure("Windows refused to start that app. Ask the user to open it."));
            finish();
            return 1;
        }
        const std::optional<IdentityData> identity = wait_for_launched_app(before, launched, target->packaged ? std::wstring() : normalized_windows_path(target->target));
        if (!identity) {
            write_result(failure("That app was started but no window appeared. Ask the user to check it."));
            finish();
            return 1;
        }
        result.set("app", identity_json(*identity));
        result.set("target", std::move(described));
        write_result(result);
        finish();
        return 0;
    }
    DWORD blocked_pid = default_blocked_pid();
    bool list = argc == 2 && std::wcscmp(argv[1], L"--list") == 0;
    if (!list && argc == 4 && std::wcscmp(argv[1], L"--list") == 0 && std::wcscmp(argv[2], L"--blocked-pid") == 0) {
        list = parse_pid(argv[3], &blocked_pid);
        if (!list) {
            write_result(failure("Invalid blocked process identity."));
            finish();
            return 1;
        }
    }
    if (list) {
        const EmmaFiles emma = emma_files(blocked_pid);
        Json result = Json::object_value();
        result.set("ok", Json::boolean_value(true));
        Json apps = Json::array_value();
        std::map<DWORD, IdentityData> identities;
        for (const auto &window : windows_for_process().windows) {
            DWORD pid = window.second;
            if (identities.count(pid)) continue;
            auto identity = process_identity(pid);
            if (!identity || emma_owned(emma, pid, identity->wide_path)) continue;
            identities.emplace(pid, std::move(*identity));
            if (identities.size() >= 128) break;
        }
        std::vector<IdentityData> ordered;
        for (auto &entry : identities) ordered.push_back(std::move(entry.second));
        std::sort(ordered.begin(), ordered.end(), [](const auto &left, const auto &right) {
            return lowercase_ascii(left.name) < lowercase_ascii(right.name);
        });
        for (const auto &identity : ordered) apps.array.push_back(identity_json(identity));
        result.set("apps", std::move(apps));
        write_result(result);
        finish();
        return 0;
    }
    if (argc != 5 || std::wcscmp(argv[1], L"--app") != 0 || std::wcscmp(argv[3], L"--blocked-pid") != 0) {
        write_result(failure("Expected --list, --resolve, --launch, or --app with an approved identity and --blocked-pid."));
        finish();
        return 1;
    }
    if (!parse_pid(argv[4], &blocked_pid)) {
        write_result(failure("Invalid blocked process identity."));
        finish();
        return 1;
    }
    std::string identity_json_text;
    if (!wide_to_utf8(argv[2], &identity_json_text) || identity_json_text.size() > max_identity_bytes) {
        write_result(failure("The approved app identity is too large or is not valid UTF-8."));
        finish();
        return 1;
    }
    Json identity_value;
    IdentityData identity;
    if (!JsonParser(identity_json_text).parse(&identity_value) || !parse_identity(identity_value, blocked_pid, &identity)) {
        write_result(failure("The approved app identity is invalid."));
        finish();
        return 1;
    }
    ComPtr<IUIAutomation> automation;
    if (FAILED(CoCreateInstance(CLSID_CUIAutomation, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(automation.put()))) || !automation) {
        write_result(failure("Windows UI Automation is unavailable."));
        finish();
        return 1;
    }
    AppSession session(identity, blocked_pid, automation.get());
    if (!session.valid()) {
        write_result(failure("The approved app is no longer running with the same identity. Open it and request approval again."));
        finish();
        return 1;
    }
    std::string line;
    bool too_large = false;
    while (InterlockedCompareExchange(&cancelled, 0, 0) == 0 && read_line(&line, &too_large)) {
        if (too_large || line.size() > max_input_bytes) {
            write_result(failure("App action exceeds the input limit or contains an invalid byte."));
            continue;
        }
        Json request;
        if (!JsonParser(line).parse(&request)) request = Json::null();
        write_result(session.handle(request));
    }
    finish();
    return 0;
}
